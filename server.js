// ============================================================
// CURLING MULTIPLAYER SERVER
// Node.js WebSocket server for online multiplayer
// Serves both static game files and WebSocket connections
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const db = require('./db');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;

// --------------------------------------------------------
// MIME types for static file serving
// --------------------------------------------------------
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
};

// --------------------------------------------------------
// HTTP server — serves static files + WebSocket upgrade
// --------------------------------------------------------
const PUBLIC_DIR = __dirname; // game files are in same directory

const httpServer = http.createServer((req, res) => {
    // Serve static files
    let filePath = req.url === '/' ? '/index.html' : req.url;
    // Remove query strings
    filePath = filePath.split('?')[0];
    const fullPath = path.join(PUBLIC_DIR, filePath);

    // Security: prevent directory traversal
    if (!fullPath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not Found');
            } else {
                res.writeHead(500);
                res.end('Server Error');
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

const wss = new WebSocket.Server({ server: httpServer });

// --------------------------------------------------------
// ROOM MANAGEMENT
// --------------------------------------------------------
const rooms = new Map();          // code -> Room
const playerRooms = new Map();    // ws -> roomCode
const playerSessions = new Map(); // ws -> { userId, username }
const matchmakingQueue = [];      // [ws, ...]

// Characters for room codes (excluding ambiguous: 0/O, 1/I/L)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
    let code;
    do {
        code = '';
        for (let i = 0; i < 4; i++) {
            code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        }
    } while (rooms.has(code));
    return code;
}

function createRoom(hostWs) {
    const code = generateRoomCode();
    const room = {
        code,
        players: [hostWs, null], // index 0 = red (host), index 1 = yellow
        state: {
            currentTeam: 'red',
            phase: 'waiting', // waiting | playing | finished
        },
        gameSnapshot: null,      // stored game state for reconnection resync
        resultRecorded: false,   // prevent duplicate game result recording
        createdAt: Date.now(),
        disconnectTimers: [null, null],
    };
    rooms.set(code, room);
    playerRooms.set(hostWs, code);
    return room;
}

function joinRoom(code, joinerWs) {
    const room = rooms.get(code.toUpperCase());
    if (!room) return { error: 'room_not_found' };
    if (room.players[1] !== null) return { error: 'room_full' };

    room.players[1] = joinerWs;
    playerRooms.set(joinerWs, code);
    return { room };
}

function startGame(room) {
    room.state.phase = 'playing';
    room.state.currentTeam = 'red';
    room.gameSnapshot = null;
    room.resultRecorded = false;

    send(room.players[0], {
        type: 'game_start',
        yourTeam: 'red',
    });
    send(room.players[1], {
        type: 'game_start',
        yourTeam: 'yellow',
    });
}

function getPlayerIndex(room, ws) {
    if (room.players[0] === ws) return 0;
    if (room.players[1] === ws) return 1;
    return -1;
}

function getPlayerTeam(room, ws) {
    const idx = getPlayerIndex(room, ws);
    return idx === 0 ? 'red' : idx === 1 ? 'yellow' : null;
}

function getOpponent(room, ws) {
    const idx = getPlayerIndex(room, ws);
    if (idx === -1) return null;
    return room.players[1 - idx];
}

function removeFromQueue(ws) {
    const idx = matchmakingQueue.indexOf(ws);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);
}

function cleanupPlayer(ws) {
    removeFromQueue(ws);
    playerSessions.delete(ws);

    const code = playerRooms.get(ws);
    if (!code) return;

    const room = rooms.get(code);
    if (!room) {
        playerRooms.delete(ws);
        return;
    }

    const playerIdx = getPlayerIndex(room, ws);
    if (playerIdx === -1) {
        playerRooms.delete(ws);
        return;
    }

    // Notify opponent of disconnect
    const opponent = getOpponent(room, ws);
    if (opponent && opponent.readyState === WebSocket.OPEN) {
        send(opponent, { type: 'opponent_disconnected' });
    }

    // Start disconnect timer - keep room for 5 minutes
    room.players[playerIdx] = null;
    room.disconnectTimers[playerIdx] = setTimeout(() => {
        // Player didn't reconnect - destroy room
        if (opponent && opponent.readyState === WebSocket.OPEN) {
            send(opponent, { type: 'opponent_left' });
            playerRooms.delete(opponent);
        }
        rooms.delete(code);
    }, 300000); // 5 minutes

    playerRooms.delete(ws);
}

function destroyRoom(code) {
    const room = rooms.get(code);
    if (!room) return;

    for (let i = 0; i < 2; i++) {
        if (room.disconnectTimers[i]) clearTimeout(room.disconnectTimers[i]);
        if (room.players[i]) playerRooms.delete(room.players[i]);
    }
    rooms.delete(code);
}

// --------------------------------------------------------
// MESSAGE HANDLING
// --------------------------------------------------------
function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

async function handleMessage(ws, message) {
    let data;
    try {
        data = JSON.parse(message);
    } catch {
        return;
    }

    switch (data.type) {
        case 'ping':
            send(ws, { type: 'pong' });
            break;

        // ---- AUTH ----
        case 'register': {
            const result = await auth.register(data.username, data.password, data.country, data.securityQuestion, data.securityAnswer);
            if (result.error) {
                send(ws, { type: 'auth_error', error: result.error });
            } else {
                playerSessions.set(ws, { userId: result.userId, username: result.username });
                const profile = await auth.getProfile(result.userId);
                const rank = profile ? profile.rank : auth.getRank(1200);
                send(ws, { type: 'auth_success', token: result.token, username: result.username, rank });
            }
            break;
        }

        case 'login': {
            const result = await auth.login(data.username, data.password);
            if (result.error) {
                send(ws, { type: 'auth_error', error: result.error });
            } else {
                playerSessions.set(ws, { userId: result.userId, username: result.username });
                const profile = await auth.getProfile(result.userId);
                const rank = profile ? profile.rank : auth.getRank(1200);
                send(ws, { type: 'auth_success', token: result.token, username: result.username, rank });
            }
            break;
        }

        case 'token_login': {
            const session = auth.getSession(data.token);
            if (!session) {
                send(ws, { type: 'auth_error', error: 'Session expired' });
            } else {
                playerSessions.set(ws, session);
                const profile = await auth.getProfile(session.userId);
                const rank = profile ? profile.rank : auth.getRank(1200);
                send(ws, { type: 'auth_success', token: data.token, username: session.username, rank });
            }
            break;
        }

        case 'get_profile': {
            const session = playerSessions.get(ws);
            if (!session) {
                send(ws, { type: 'profile_data', profile: null });
                break;
            }
            const profile = await auth.getProfile(session.userId);
            send(ws, { type: 'profile_data', profile });
            break;
        }

        case 'get_security_question': {
            const result = await auth.getSecurityQuestion(data.username);
            if (result.error) {
                send(ws, { type: 'auth_error', error: result.error });
            } else {
                send(ws, { type: 'security_question', question: result.question });
            }
            break;
        }

        case 'reset_password': {
            const result = await auth.resetPassword(data.username, data.answer, data.newPassword);
            if (result.error) {
                send(ws, { type: 'auth_error', error: result.error });
            } else {
                send(ws, { type: 'password_reset_success' });
            }
            break;
        }

        // ---- LOBBY ----
        case 'create_room': {
            const room = createRoom(ws);
            send(ws, { type: 'room_created', code: room.code });
            break;
        }

        case 'join_room': {
            const code = (data.code || '').toUpperCase();
            const result = joinRoom(code, ws);
            if (result.error) {
                send(ws, { type: result.error, code });
            } else {
                send(ws, { type: 'room_joined', code });
                startGame(result.room);
            }
            break;
        }

        case 'join_queue': {
            removeFromQueue(ws);
            matchmakingQueue.push(ws);
            send(ws, { type: 'queue_waiting' });

            // Try to match
            while (matchmakingQueue.length >= 2) {
                const p1 = matchmakingQueue.shift();
                const p2 = matchmakingQueue.shift();

                // Verify both still connected
                if (p1.readyState !== WebSocket.OPEN) {
                    if (p2.readyState === WebSocket.OPEN) matchmakingQueue.unshift(p2);
                    continue;
                }
                if (p2.readyState !== WebSocket.OPEN) {
                    matchmakingQueue.unshift(p1);
                    continue;
                }

                // Randomly assign teams
                const [red, yellow] = Math.random() < 0.5 ? [p1, p2] : [p2, p1];
                const room = createRoom(red);
                room.players[1] = yellow;
                playerRooms.set(yellow, room.code);
                startGame(room);
            }
            break;
        }

        case 'leave_queue': {
            removeFromQueue(ws);
            break;
        }

        // ---- GAMEPLAY ----
        case 'throw': {
            const code = playerRooms.get(ws);
            if (!code) return;
            const room = rooms.get(code);
            if (!room) return;

            const team = getPlayerTeam(room, ws);
            if (team !== room.state.currentTeam) return; // not your turn

            // Switch turns immediately when relaying the throw
            // (prevents race condition with separate turn_complete message)
            room.state.currentTeam = room.state.currentTeam === 'red' ? 'yellow' : 'red';

            const opponent = getOpponent(room, ws);
            send(opponent, {
                type: 'opponent_throw',
                aim: data.aim,
                weight: data.weight,
                spinDir: data.spinDir,
                spinAmount: data.spinAmount,
            });
            break;
        }

        case 'sweep_change': {
            const code = playerRooms.get(ws);
            if (!code) return;
            const room = rooms.get(code);
            if (!room) return;

            // Allow sweep from either player (current thrower's turn already switched)
            const opponent = getOpponent(room, ws);
            send(opponent, { type: 'opponent_sweep_change', level: data.level });
            break;
        }

        case 'sweep_start': {
            const code = playerRooms.get(ws);
            if (!code) return;
            const room = rooms.get(code);
            if (!room) return;

            const opponent = getOpponent(room, ws);
            send(opponent, { type: 'opponent_sweep_start' });
            break;
        }

        case 'sweep_stop': {
            const code = playerRooms.get(ws);
            if (!code) return;
            const room = rooms.get(code);
            if (!room) return;

            const opponent = getOpponent(room, ws);
            send(opponent, { type: 'opponent_sweep_stop' });
            break;
        }

        case 'turn_complete': {
            // Turn switching now happens atomically when the throw is relayed.
            // This message is kept for backward compatibility but is a no-op.
            break;
        }

        // ---- GAME STATE SYNC (for reconnection) ----
        case 'game_state_sync': {
            const code = playerRooms.get(ws);
            if (!code) return;
            const room = rooms.get(code);
            if (!room) return;
            // Store the latest game state snapshot
            room.gameSnapshot = data.snapshot;
            break;
        }

        // ---- GAME OVER (record result) ----
        case 'game_over': {
            const code = playerRooms.get(ws);
            if (!code) return;
            const room = rooms.get(code);
            if (!room) return;

            // Only record once per game
            if (room.resultRecorded) break;
            room.resultRecorded = true;

            const redSession = room.players[0] ? playerSessions.get(room.players[0]) : null;
            const yellowSession = room.players[1] ? playerSessions.get(room.players[1]) : null;

            // Only record if both players are logged in
            if (redSession && yellowSession) {
                const ratingResult = await auth.recordGameResult(
                    redSession.userId,
                    yellowSession.userId,
                    data.redScore,
                    data.yellowScore,
                    data.endCount
                );

                // Send updated rating/rank to both players
                if (ratingResult) {
                    if (room.players[0] && room.players[0].readyState === WebSocket.OPEN) {
                        send(room.players[0], { type: 'rating_update', rank: ratingResult.red.rank });
                    }
                    if (room.players[1] && room.players[1].readyState === WebSocket.OPEN) {
                        send(room.players[1], { type: 'rating_update', rank: ratingResult.yellow.rank });
                    }
                }
            }
            break;
        }

        // ---- REMATCH ----
        case 'rematch': {
            const code = playerRooms.get(ws);
            if (!code) return;
            const room = rooms.get(code);
            if (!room) return;

            const opponent = getOpponent(room, ws);
            if (!room._rematchRequested) {
                room._rematchRequested = ws;
                send(opponent, { type: 'rematch_requested' });
            } else if (room._rematchRequested !== ws) {
                // Both players want rematch - restart
                room._rematchRequested = null;
                room.state.currentTeam = 'red';
                room.state.phase = 'playing';
                room.gameSnapshot = null;
                room.resultRecorded = false;
                send(room.players[0], { type: 'rematch_accepted', yourTeam: 'red' });
                send(room.players[1], { type: 'rematch_accepted', yourTeam: 'yellow' });
            }
            break;
        }

        case 'leave': {
            const code = playerRooms.get(ws);
            if (!code) return;
            const room = rooms.get(code);
            if (!room) return;

            const opponent = getOpponent(room, ws);
            if (opponent && opponent.readyState === WebSocket.OPEN) {
                send(opponent, { type: 'opponent_left' });
                playerRooms.delete(opponent);
            }
            playerRooms.delete(ws);
            destroyRoom(code);
            break;
        }

        case 'reconnect': {
            const code = (data.code || '').toUpperCase();
            const room = rooms.get(code);
            if (!room) {
                send(ws, { type: 'reconnect_failed' });
                return;
            }

            // Find the empty slot
            const emptySlot = room.players[0] === null ? 0 : room.players[1] === null ? 1 : -1;
            if (emptySlot === -1) {
                send(ws, { type: 'reconnect_failed' });
                return;
            }

            // Cancel disconnect timer
            if (room.disconnectTimers[emptySlot]) {
                clearTimeout(room.disconnectTimers[emptySlot]);
                room.disconnectTimers[emptySlot] = null;
            }

            room.players[emptySlot] = ws;
            playerRooms.set(ws, code);

            const team = emptySlot === 0 ? 'red' : 'yellow';
            send(ws, {
                type: 'reconnected',
                yourTeam: team,
                gameSnapshot: room.gameSnapshot || null,
            });

            const opponent = getOpponent(room, ws);
            if (opponent) {
                send(opponent, { type: 'opponent_reconnected' });
            }
            break;
        }
    }
}

// --------------------------------------------------------
// CONNECTION HANDLING
// --------------------------------------------------------
wss.on('connection', (ws) => {
    ws.isAlive = true;

    ws.on('message', (message) => {
        ws.isAlive = true;
        handleMessage(ws, message.toString());
    });

    ws.on('close', () => {
        cleanupPlayer(ws);
    });

    ws.on('error', () => {
        cleanupPlayer(ws);
    });
});

// --------------------------------------------------------
// HEARTBEAT - detect dead connections (60s tolerance for backgrounded tabs)
// --------------------------------------------------------
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            cleanupPlayer(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
    });
}, 60000); // 60 seconds — tolerant of backgrounded mobile tabs

// --------------------------------------------------------
// STALE ROOM CLEANUP
// --------------------------------------------------------
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        // Remove rooms older than 10 minutes with no second player
        if (room.players[1] === null && room.state.phase === 'waiting' && now - room.createdAt > 10 * 60 * 1000) {
            if (room.players[0] && room.players[0].readyState === WebSocket.OPEN) {
                send(room.players[0], { type: 'room_expired' });
            }
            destroyRoom(code);
        }
    }
}, 60000);

wss.on('close', () => {
    clearInterval(heartbeatInterval);
    clearInterval(cleanupInterval);
});

// --------------------------------------------------------
// START
// --------------------------------------------------------
db.init();
db.initSchema().then(() => {
    httpServer.listen(PORT, () => {
        console.log(`Curling server running on port ${PORT}`);
        if (db.isAvailable()) {
            console.log('Database connected — accounts enabled');
        } else {
            console.log('No database — guest mode only');
        }
    });
}).catch(() => {
    // Start even if DB fails
    httpServer.listen(PORT, () => {
        console.log(`Curling server running on port ${PORT} (no database)`);
    });
});
