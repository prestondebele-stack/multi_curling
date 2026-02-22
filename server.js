// ============================================================
// CURLING MULTIPLAYER SERVER
// Node.js WebSocket server for online multiplayer
// Serves both static game files and WebSocket connections
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const auth = require('./auth');
const webpush = require('web-push');
const CurlingPhysics = require('./physics');

const PORT = process.env.PORT || 3000;

// --------------------------------------------------------
// PUSH NOTIFICATION CONFIG
// --------------------------------------------------------
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_EMAIL || 'mailto:admin@example.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    console.log('Web push configured');
} else {
    console.log('No VAPID keys — push notifications disabled');
}

async function sendPushNotification(userId, title, body) {
    if (!db.isAvailable() || !process.env.VAPID_PUBLIC_KEY) return;
    try {
        const result = await db.query(
            'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
            [userId]
        );
        const payload = JSON.stringify({ title, body, url: '/' });
        for (const row of result.rows) {
            const subscription = {
                endpoint: row.endpoint,
                keys: { p256dh: row.p256dh, auth: row.auth }
            };
            try {
                await webpush.sendNotification(subscription, payload);
            } catch (err) {
                if (err.statusCode === 404 || err.statusCode === 410) {
                    await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [row.endpoint]);
                }
            }
        }
    } catch (e) {
        console.error('Push notification error:', e.message);
    }
}

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
    // Serve static files — strip query string FIRST, then check for root
    let filePath = req.url.split('?')[0];
    if (filePath === '/') filePath = '/index.html';
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
const onlineUsers = new Map();    // userId -> ws (for presence tracking)
const pendingInvites = new Map(); // inviteId -> { fromUserId, fromUsername, toUserId, toUsername, fromWs, createdAt }

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

function createRoom(hostWs, totalEnds) {
    const code = generateRoomCode();
    // Validate totalEnds to one of the allowed values
    const allowedEnds = [4, 6, 8, 10];
    const ends = allowedEnds.includes(totalEnds) ? totalEnds : 4;
    const room = {
        code,
        players: [hostWs, null], // index 0 = red (host), index 1 = yellow
        sessions: [null, null],  // cached session refs for resilient player info lookup
        totalEnds: ends,
        state: {
            currentTeam: 'red',
            phase: 'waiting',      // waiting | playing | throwing | finished
            settledStones: [],     // [{team, x, y}] — authoritative stone positions
            redThrown: 0,
            yellowThrown: 0,
            currentEnd: 1,
            totalEnds: ends,
            redScore: 0,
            yellowScore: 0,
            hammer: 'yellow',
            endScores: [],
            fgzProtectedStones: [],
            throwInProgress: false,
            lastThrowParams: null,
            lastPreThrowStones: null,
        },
        resultRecorded: false,   // prevent duplicate game result recording
        createdAt: Date.now(),
        disconnectTimers: [null, null],
        pendingMessages: [[], []], // queued messages per slot when opponent is offline
    };
    rooms.set(code, room);
    playerRooms.set(hostWs, code);
    return room;
}

function joinRoom(code, joinerWs) {
    const room = rooms.get(code.toUpperCase());
    if (!room) return { error: 'room_not_found' };

    // v115h: Check if joiner is the same user as an existing player
    // (e.g. creator clicking their own share link from a different tab/device)
    const joinerSession = playerSessions.get(joinerWs);
    if (joinerSession && joinerSession.userId) {
        for (let i = 0; i < 2; i++) {
            const existingSession = playerSessions.get(room.players[i]) || room.sessions[i];
            if (existingSession && existingSession.userId === joinerSession.userId) {
                // Same user — swap their connection to this slot (treat as reconnect)
                if (room.players[i] && room.players[i] !== joinerWs) {
                    playerRooms.delete(room.players[i]);
                }
                room.players[i] = joinerWs;
                playerRooms.set(joinerWs, code);
                return { room, sameUser: true, slot: i };
            }
        }
    }

    if (room.players[1] !== null) return { error: 'room_full' };

    room.players[1] = joinerWs;
    playerRooms.set(joinerWs, code);
    return { room };
}

async function startGame(room) {
    initFullGameState(room);
    room.state.totalEnds = room.totalEnds; // copy from room-level setting
    room.resultRecorded = false;

    // Cache sessions in the room for resilient lookup
    // (guards against race conditions where ws references change)
    room.sessions[0] = playerSessions.get(room.players[0]) || room.sessions[0];
    room.sessions[1] = playerSessions.get(room.players[1]) || room.sessions[1];

    // Fetch player info for opponent display
    let redInfo = await getPlayerInfo(room.players[0]);
    let yellowInfo = await getPlayerInfo(room.players[1]);

    // If either info is null, the session may not be registered yet
    // (async race with token_login). Wait a moment and retry once.
    if (!redInfo || !yellowInfo) {
        console.log('[startGame] Missing player info — red:', !!redInfo, 'yellow:', !!yellowInfo, '— retrying in 500ms');
        await new Promise(r => setTimeout(r, 500));
        // Re-cache sessions after the delay
        room.sessions[0] = playerSessions.get(room.players[0]) || room.sessions[0];
        room.sessions[1] = playerSessions.get(room.players[1]) || room.sessions[1];
        if (!redInfo) redInfo = await getPlayerInfo(room.players[0]);
        if (!yellowInfo) yellowInfo = await getPlayerInfo(room.players[1]);
        if (!redInfo || !yellowInfo) {
            console.log('[startGame] STILL missing after retry — red:', !!redInfo, 'yellow:', !!yellowInfo);
        }
    }

    send(room.players[0], {
        type: 'game_start',
        yourTeam: 'red',
        opponent: yellowInfo,
        totalEnds: room.totalEnds || 6,
        roomCode: room.code,
    });
    send(room.players[1], {
        type: 'game_start',
        yourTeam: 'yellow',
        opponent: redInfo,
        totalEnds: room.totalEnds || 6,
        roomCode: room.code,
    });

    // Broadcast in_game presence to friends
    const redSess = playerSessions.get(room.players[0]);
    const yellowSess = playerSessions.get(room.players[1]);
    if (redSess?.userId) broadcastPresenceToFriends(redSess.userId, 'in_game');
    if (yellowSess?.userId) broadcastPresenceToFriends(yellowSess.userId, 'in_game');
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

async function getPlayerInfo(ws) {
    let session = playerSessions.get(ws);

    // If no session on this ws, try to find it via the room's stored sessions
    // (handles race conditions where ws reference changes during reconnect)
    if (!session || !session.userId) {
        const code = playerRooms.get(ws);
        const room = code ? rooms.get(code) : null;
        if (room && room.sessions) {
            const idx = getPlayerIndex(room, ws);
            if (idx !== -1 && room.sessions[idx]) {
                session = room.sessions[idx];
                console.log('[getPlayerInfo] Recovered session from room.sessions for slot', idx, session.username);
            }
        }
    }

    if (!session || !session.userId) {
        console.log('[getPlayerInfo] No session for ws — playerSessions has', playerSessions.size, 'entries');
        return null;
    }
    try {
        const profile = await auth.getProfile(session.userId);
        return {
            username: session.username,
            rank: profile ? profile.rank : auth.getRank(1200),
            country: profile ? (profile.country || '') : '',
        };
    } catch (e) {
        console.error('getPlayerInfo error:', e.message);
        return { username: session.username, rank: auth.getRank(1200), country: '' };
    }
}

// --------------------------------------------------------
// SERVER-AUTHORITATIVE PHYSICS ENGINE (v112)
// All online game physics run on the server. Clients send
// throw params, server simulates, returns final positions.
// --------------------------------------------------------
const PHYSICS_DT = 1 / 240;
const S_POSITIONS = CurlingPhysics.POSITIONS;
const S_STONE_R = CurlingPhysics.STONE.radius;
const S_HALF_W = CurlingPhysics.SHEET.width / 2;
const S_HOUSE = CurlingPhysics.HOUSE;

// Initialize room game state for a new end or game start
function initRoomGameState(room) {
    room.state.settledStones = [];
    room.state.redThrown = 0;
    room.state.yellowThrown = 0;
    room.state.fgzProtectedStones = [];
    room.state.throwInProgress = false;
    room.state.lastThrowParams = null;
    room.state.lastPreThrowStones = null;
}

// Initialize full game state when room is created / game starts
function initFullGameState(room) {
    room.state.currentTeam = 'red';
    room.state.phase = 'playing';
    room.state.currentEnd = 1;
    room.state.redScore = 0;
    room.state.yellowScore = 0;
    room.state.hammer = 'yellow';
    room.state.endScores = [];
    initRoomGameState(room);
}

// Check if a stone is in the Free Guard Zone
function serverIsInFGZ(stone) {
    if (!stone.active) return false;
    const distToTee = Math.sqrt(stone.x * stone.x + (stone.y - S_POSITIONS.farTeeLine) ** 2);
    return stone.y >= S_POSITIONS.farHogLine && distToTee > S_HOUSE.twelveFoot + S_STONE_R;
}

// Snapshot FGZ-protected stones before a throw (5-rock rule)
function serverSnapshotFGZ(room, throwingTeam) {
    const totalThrown = room.state.redThrown + room.state.yellowThrown;
    if (totalThrown > 5) {
        room.state.fgzProtectedStones = [];
        return;
    }
    room.state.fgzProtectedStones = [];
    for (const stone of room.state.settledStones) {
        if (stone.team === throwingTeam) continue; // only protect opponent's stones
        if (serverIsInFGZ(stone)) {
            room.state.fgzProtectedStones.push({ team: stone.team, x: stone.x, y: stone.y });
        }
    }
}

// Check FGZ violations after a throw settles — returns true if violation occurred
function serverCheckFGZViolation(room, settledStones, deliveredStoneIdx) {
    if (room.state.fgzProtectedStones.length === 0) return false;

    let violated = false;
    for (const snap of room.state.fgzProtectedStones) {
        // Check if this protected stone was knocked out of play
        const stillActive = settledStones.find(s =>
            s.active && s.team === snap.team &&
            Math.abs(s.x - snap.x) < 3.0 && Math.abs(s.y - snap.y) < 3.0
        );
        // Also check exact match in case stone didn't move
        const exactMatch = settledStones.find(s =>
            s.active && s.team === snap.team &&
            Math.abs(s.x - snap.x) < 0.001 && Math.abs(s.y - snap.y) < 0.001
        );

        if (!stillActive && !exactMatch) {
            // Stone was removed from play — restore it
            settledStones.push({
                team: snap.team, x: snap.x, y: snap.y,
                vx: 0, vy: 0, omega: 0, angle: 0,
                active: true, moving: false
            });
            violated = true;
        }
    }

    if (violated && deliveredStoneIdx >= 0 && deliveredStoneIdx < settledStones.length) {
        // Remove the thrown stone
        settledStones[deliveredStoneIdx].active = false;
    }

    room.state.fgzProtectedStones = [];
    return violated;
}

// Calculate end score — which team scores and how many points
function serverCalculateEndScore(settledStones) {
    const teeX = 0;
    const teeY = S_POSITIONS.farTeeLine;

    const activeStones = settledStones.filter(s => s.active);
    if (activeStones.length === 0) return { team: null, points: 0 };

    const scored = activeStones.map(s => ({
        team: s.team,
        x: s.x, y: s.y,
        dist: Math.sqrt((s.x - teeX) ** 2 + (s.y - teeY) ** 2),
    })).sort((a, b) => a.dist - b.dist);

    // Only stones within the 12-foot house score
    const inHouse = scored.filter(s => s.dist <= S_HOUSE.twelveFoot + S_STONE_R);
    if (inHouse.length === 0) return { team: null, points: 0 };

    const closestTeam = inHouse[0].team;
    const otherTeamClosest = inHouse.find(s => s.team !== closestTeam);
    const otherDist = otherTeamClosest ? otherTeamClosest.dist : Infinity;

    let points = 0;
    for (const s of inHouse) {
        if (s.team === closestTeam && s.dist < otherDist) {
            points++;
        }
    }

    return { team: closestTeam, points };
}

// Run server-side physics for a throw. Real-time tick loop for live sweeping.
function runServerPhysics(room, throwParams, callback) {
    const { aim, weight, spinDir, spinAmount, sweepLevel } = throwParams;
    const throwingTeam = room.state.currentTeam;

    // Build stone array from current settled stones
    const stones = room.state.settledStones.map(s => ({
        team: s.team, x: s.x, y: s.y,
        vx: 0, vy: 0, omega: 0, angle: 0,
        active: true, moving: false,
        hasHitStone: false, settleTime: 0, fadeOut: undefined,
        _isDelivered: false, _hogViolation: false
    }));

    // Create the new thrown stone
    const speed = CurlingPhysics.weightToSpeed(weight);
    const aimRad = aim * Math.PI / 180;
    const startX = 0;
    const startY = S_POSITIONS.hack + 1.0;
    const vx = speed * Math.sin(aimRad);
    const vy = speed * Math.cos(aimRad);
    const omega = CurlingPhysics.rotationsToAngularVelocity(spinAmount, speed) * spinDir;

    const deliveredIdx = stones.length;
    stones.push({
        team: throwingTeam, x: startX, y: startY,
        vx, vy, omega, angle: 0,
        active: true, moving: true,
        hasHitStone: false, settleTime: 0, fadeOut: undefined,
        _isDelivered: true, _hogViolation: false
    });

    room.state.liveSweepLevel = sweepLevel || 'none';
    room.state.liveStones = stones;

    const sweep = sweepLevel || 'none';
    let stepCount = 0;
    let syncAccumulator = 0;
    const STEPS_PER_TICK = 12; // v114: 3x speed (12 steps per 16ms = 720Hz effective)

    function checkOOB() {
        for (const stone of stones) {
            if (!stone.active) continue;
            if (stone.y > S_POSITIONS.farBackLine + S_STONE_R && stone.vy > 0) {
                stone.moving = false; stone.active = false; stone.fadeOut = 1.0;
            }
            if (stone.y < S_POSITIONS.hack - 2) {
                stone.moving = false; stone.active = false; stone.fadeOut = 1.0;
            }
            if (Math.abs(stone.x) > S_HALF_W - S_STONE_R) {
                stone.moving = false; stone.active = false; stone.fadeOut = 1.0;
            }
            // Hog line violation for delivered stone
            if (stone._isDelivered && !stone.moving && (stone.y - S_STONE_R) < S_POSITIONS.farHogLine) {
                if (!stone.hasHitStone) {
                    stone.moving = false; stone.active = false; stone.fadeOut = 1.0;
                    stone._hogViolation = true;
                }
            }
        }
    }

    const physicsInterval = setInterval(() => {
        let anyMoving = false;
        const currentSweep = room.state.liveSweepLevel || 'none';

        for (let i = 0; i < STEPS_PER_TICK; i++) {
            anyMoving = CurlingPhysics.simulate(stones, PHYSICS_DT, currentSweep);
            stepCount++;
            checkOOB();
            if (!anyMoving) break;
        }

        if (!anyMoving) {
            // Physics settled
            clearInterval(physicsInterval);
            delete room.state.physicsInterval;

            const delivered = stones[deliveredIdx];
            const hogViolation = delivered ? delivered._hogViolation : false;
            const fgzViolation = serverCheckFGZViolation(room, stones, deliveredIdx);

            const finalStones = stones
                .filter(s => s.active)
                .map(s => ({ team: s.team, x: s.x, y: s.y, active: true }));

            delete room.state.liveSweepLevel;
            delete room.state.liveStones;

            callback({
                stones: finalStones,
                hogViolation,
                fgzViolation,
                deliveredStoneActive: delivered ? delivered.active : false,
                stepCount
            });
            return;
        }

        // Broadcast sync occasionally (e.g. every 6 ticks = 100ms)
        syncAccumulator++;
        if (syncAccumulator >= 6) {
            syncAccumulator = 0;
            const syncData = {
                type: 'sync_positions',
                stones: stones.map(s => ({
                    team: s.team,
                    active: s.active,
                    x: s.x,
                    y: s.y,
                    angle: s.angle,
                    moving: s.moving
                }))
            };
            if (room.players[0] && room.players[0].readyState === WebSocket.OPEN) {
                send(room.players[0], syncData);
            }
            if (room.players[1] && room.players[1].readyState === WebSocket.OPEN) {
                send(room.players[1], syncData);
            }
        }
    }, 16);

    room.state.physicsInterval = physicsInterval;
}

// Process end-of-end: score, check for game over, advance
function serverEndOfEnd(room) {
    const result = serverCalculateEndScore(room.state.settledStones);
    room.state.endScores.push(result);

    if (result.team === 'red') {
        room.state.redScore += result.points;
    } else if (result.team === 'yellow') {
        room.state.yellowScore += result.points;
    }

    // Check for game over or extra end
    if (room.state.currentEnd >= room.state.totalEnds) {
        if (room.state.redScore === room.state.yellowScore) {
            // Tied — extra end
            room.state.totalEnds++;
        } else {
            // Game over
            room.state.phase = 'finished';
            return { gameOver: true, result, extraEnd: false };
        }
    }

    // Start next end
    room.state.currentEnd++;

    if (result.team && result.points > 0) {
        // Scoring team goes first (disadvantage); non-scoring team gets hammer
        room.state.currentTeam = result.team;
        room.state.hammer = result.team === 'red' ? 'yellow' : 'red';
    }
    // If blank end (no score), same team keeps hammer, order stays

    // Reset for new end
    room.state.settledStones = [];
    room.state.redThrown = 0;
    room.state.yellowThrown = 0;
    room.state.fgzProtectedStones = [];
    room.state.throwInProgress = false;
    room.state.lastThrowParams = null;
    room.state.lastPreThrowStones = null;

    return { gameOver: false, result, extraEnd: room.state.currentEnd > room.totalEnds };
}

// --------------------------------------------------------
// FRIENDS & PRESENCE HELPERS
// --------------------------------------------------------
function getUserStatus(userId) {
    const ws = onlineUsers.get(userId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return 'offline';
    if (playerRooms.has(ws)) return 'in_game';
    return 'online';
}

async function broadcastPresenceToFriends(userId, status) {
    if (!db.isAvailable()) return;
    try {
        const result = await db.query(
            `SELECT CASE WHEN user_id = $1 THEN friend_id ELSE user_id END AS friend_id
             FROM friendships
             WHERE (user_id = $1 OR friend_id = $1) AND status = 'accepted'`,
            [userId]
        );
        const session = [...playerSessions.entries()].find(([, s]) => s.userId === userId);
        const username = session ? session[1].username : '';
        for (const row of result.rows) {
            const friendWs = onlineUsers.get(row.friend_id);
            if (friendWs && friendWs.readyState === WebSocket.OPEN) {
                send(friendWs, { type: 'friend_presence', userId, username, status });
            }
        }
    } catch (e) {
        console.error('Presence broadcast error:', e.message);
    }
}

function cleanupInvitesForUser(userId) {
    for (const [inviteId, invite] of pendingInvites) {
        if (invite.fromUserId === userId) {
            pendingInvites.delete(inviteId);
            const toWs = onlineUsers.get(invite.toUserId);
            if (toWs) send(toWs, { type: 'game_invite_cancelled', inviteId });
        }
        if (invite.toUserId === userId) {
            pendingInvites.delete(inviteId);
            const fromWs = onlineUsers.get(invite.fromUserId);
            if (fromWs) send(fromWs, { type: 'game_invite_denied', inviteId, byUsername: invite.toUsername });
        }
    }
}

function removeFromQueue(ws) {
    const idx = matchmakingQueue.indexOf(ws);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);
}

function cleanupPlayer(ws) {
    removeFromQueue(ws);

    const session = playerSessions.get(ws);
    const code = playerRooms.get(ws);

    // If the player is NOT in a room, clean up fully (offline presence, etc.)
    if (!code) {
        if (session && session.userId) {
            onlineUsers.delete(session.userId);
            cleanupInvitesForUser(session.userId);
            broadcastPresenceToFriends(session.userId, 'offline');
        }
        playerSessions.delete(ws);
        return;
    }

    const room = rooms.get(code);
    if (!room) {
        if (session && session.userId) {
            onlineUsers.delete(session.userId);
            cleanupInvitesForUser(session.userId);
            broadcastPresenceToFriends(session.userId, 'offline');
        }
        playerSessions.delete(ws);
        playerRooms.delete(ws);
        return;
    }

    const playerIdx = getPlayerIndex(room, ws);
    if (playerIdx === -1) {
        if (session && session.userId) {
            onlineUsers.delete(session.userId);
            broadcastPresenceToFriends(session.userId, 'offline');
        }
        playerSessions.delete(ws);
        playerRooms.delete(ws);
        return;
    }

    // Player IS in a room — DON'T delete their session or presence yet.
    // Keep room.sessions[idx] cached so reconnect can restore it.
    // Only delete the ws->session mapping (ws is dead), but preserve the session data.
    room.sessions[playerIdx] = session || room.sessions[playerIdx];
    playerSessions.delete(ws);
    // DON'T delete from onlineUsers yet — wait for grace period to expire.
    // This prevents the brief "offline" flash to friends during reconnect.

    // DON'T notify the opponent immediately — give the player a 45-second
    // grace period to reconnect (common when sending a text on mobile).
    // If they reconnect within the grace window, the opponent never sees anything.
    const opponent = getOpponent(room, ws);

    room.players[playerIdx] = null;
    playerRooms.delete(ws);

    // v115b: If the disconnected player was the sweeper (throwing team) during a throw,
    // reset sweep to 'none' so physics continues without sweep influence
    if (room.state.throwInProgress) {
        const disconnectedTeam = playerIdx === 0 ? 'red' : 'yellow';
        if (disconnectedTeam === room.state.currentTeam) {
            room.state.liveSweepLevel = 'none';
        }
    }

    // Grace timer: after 45s, THEN tell opponent about the disconnect
    room.disconnectTimers[playerIdx] = setTimeout(() => {
        // Check if the player has already reconnected during grace period
        if (room.players[playerIdx] !== null) return; // They're back!

        if (opponent && opponent.readyState === WebSocket.OPEN) {
            send(opponent, { type: 'opponent_disconnected' });
        }

        // NOW broadcast offline to friends (grace period expired without reconnect)
        if (session && session.userId) {
            broadcastPresenceToFriends(session.userId, 'offline');
        }

        // Now start the 5-minute hard timer for room destruction
        room.disconnectTimers[playerIdx] = setTimeout(() => {
            // Check again — they may have reconnected after the notification
            if (room.players[playerIdx] !== null) return;

            // Clean up fully — player gave up
            if (session && session.userId) {
                onlineUsers.delete(session.userId);
                cleanupInvitesForUser(session.userId);
            }

            if (opponent && opponent.readyState === WebSocket.OPEN) {
                send(opponent, { type: 'opponent_left' });
                playerRooms.delete(opponent);
            }
            rooms.delete(code);
        }, 300000); // 5 minutes after grace period
    }, 45000); // 45 second grace period
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
        case 'ping': {
            // v112: Include full authoritative state so client can sync after tab switch
            const pingCode = playerRooms.get(ws);
            const pingRoom = pingCode ? rooms.get(pingCode) : null;
            if (pingRoom) {
                send(ws, {
                    type: 'pong',
                    currentTeam: pingRoom.state.currentTeam,
                    throwInProgress: pingRoom.state.throwInProgress,
                });
            } else {
                send(ws, { type: 'pong' });
            }
            break;
        }

        // ---- AUTH ----
        case 'register': {
            const result = await auth.register(data.username, data.password, data.country, data.securityQuestion, data.securityAnswer, data.firstName, data.lastName);
            if (result.error) {
                send(ws, { type: 'auth_error', error: result.error });
            } else {
                playerSessions.set(ws, { userId: result.userId, username: result.username });
                onlineUsers.set(result.userId, ws);
                broadcastPresenceToFriends(result.userId, 'online');
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
                onlineUsers.set(result.userId, ws);
                broadcastPresenceToFriends(result.userId, 'online');
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
                onlineUsers.set(session.userId, ws);
                // Update room's cached session if this player is in a room
                const roomCode = playerRooms.get(ws);
                if (roomCode) {
                    const room = rooms.get(roomCode);
                    if (room) {
                        const idx = getPlayerIndex(room, ws);
                        if (idx !== -1) room.sessions[idx] = session;
                    }
                }
                broadcastPresenceToFriends(session.userId, 'online');
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

        // ---- PUSH NOTIFICATIONS ----
        case 'get_vapid_key': {
            send(ws, { type: 'vapid_key', key: process.env.VAPID_PUBLIC_KEY || null });
            break;
        }

        case 'push_subscribe': {
            const session = playerSessions.get(ws);
            if (!session || !db.isAvailable() || !data.subscription) break;
            const { endpoint, keys } = data.subscription;
            try {
                await db.query(
                    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
                    [session.userId, endpoint, keys.p256dh, keys.auth]
                );
            } catch (e) {
                console.error('Push subscribe error:', e.message);
            }
            break;
        }

        case 'push_unsubscribe': {
            const session = playerSessions.get(ws);
            if (!session || !db.isAvailable()) break;
            try {
                await db.query(
                    'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
                    [session.userId, data.endpoint]
                );
            } catch (e) {
                console.error('Push unsubscribe error:', e.message);
            }
            break;
        }

        // ---- USER SEARCH ----
        case 'search_users': {
            const session = playerSessions.get(ws);
            if (!session || !db.isAvailable()) { send(ws, { type: 'search_results', results: [] }); break; }
            const query = (data.query || '').trim();
            if (!query || query.length < 1) { send(ws, { type: 'search_results', results: [] }); break; }
            try {
                const results = await auth.searchUsers(query, session.userId);
                send(ws, { type: 'search_results', results });
            } catch (e) {
                console.error('Search users error:', e.message);
                send(ws, { type: 'search_results', results: [] });
            }
            break;
        }

        // ---- FRIENDS ----
        case 'send_friend_request': {
            const session = playerSessions.get(ws);
            if (!session || !db.isAvailable()) { send(ws, { type: 'friend_request_error', error: 'Must be logged in' }); break; }
            const targetName = (data.username || '').trim().toLowerCase();
            if (!targetName) { send(ws, { type: 'friend_request_error', error: 'Username required' }); break; }
            if (targetName === session.username) { send(ws, { type: 'friend_request_error', error: 'Cannot add yourself' }); break; }
            try {
                const userResult = await db.query('SELECT id, username FROM users WHERE username = $1', [targetName]);
                if (userResult.rows.length === 0) { send(ws, { type: 'friend_request_error', error: 'User not found' }); break; }
                const target = userResult.rows[0];
                // Check existing friendship
                const existing = await db.query(
                    'SELECT * FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
                    [session.userId, target.id]
                );
                if (existing.rows.length > 0) {
                    const row = existing.rows[0];
                    if (row.status === 'accepted') { send(ws, { type: 'friend_request_error', error: 'Already friends' }); break; }
                    // Check if this is a mutual request (they sent to us)
                    if (row.user_id === target.id && row.friend_id === session.userId && row.status === 'pending') {
                        // Auto-accept
                        await db.query('UPDATE friendships SET status = $1 WHERE id = $2', ['accepted', row.id]);
                        send(ws, { type: 'friend_request_accepted', userId: target.id, username: target.username });
                        const targetWs = onlineUsers.get(target.id);
                        if (targetWs) send(targetWs, { type: 'friend_request_accepted', userId: session.userId, username: session.username });
                        break;
                    }
                    send(ws, { type: 'friend_request_error', error: 'Request already pending' }); break;
                }
                await db.query('INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, $3)', [session.userId, target.id, 'pending']);
                send(ws, { type: 'friend_request_sent', username: target.username });
                const targetWs = onlineUsers.get(target.id);
                if (targetWs) send(targetWs, { type: 'friend_request_received', fromUserId: session.userId, fromUsername: session.username });
            } catch (e) {
                console.error('Friend request error:', e.message);
                send(ws, { type: 'friend_request_error', error: 'Failed to send request' });
            }
            break;
        }

        case 'accept_friend_request': {
            const session = playerSessions.get(ws);
            if (!session || !db.isAvailable()) break;
            try {
                const result = await db.query(
                    'UPDATE friendships SET status = $1 WHERE user_id = $2 AND friend_id = $3 AND status = $4 RETURNING user_id',
                    ['accepted', data.fromUserId, session.userId, 'pending']
                );
                if (result.rows.length === 0) break;
                // Get the requester's username
                const reqResult = await db.query('SELECT username FROM users WHERE id = $1', [data.fromUserId]);
                const fromUsername = reqResult.rows[0]?.username || '';
                send(ws, { type: 'friend_request_accepted', userId: data.fromUserId, username: fromUsername });
                const fromWs = onlineUsers.get(data.fromUserId);
                if (fromWs) send(fromWs, { type: 'friend_request_accepted', userId: session.userId, username: session.username });
            } catch (e) {
                console.error('Accept friend request error:', e.message);
            }
            break;
        }

        case 'deny_friend_request': {
            const session = playerSessions.get(ws);
            if (!session || !db.isAvailable()) break;
            try {
                await db.query(
                    'DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2 AND status = $3',
                    [data.fromUserId, session.userId, 'pending']
                );
                send(ws, { type: 'friend_request_denied', userId: data.fromUserId });
            } catch (e) {
                console.error('Deny friend request error:', e.message);
            }
            break;
        }

        case 'remove_friend': {
            const session = playerSessions.get(ws);
            if (!session || !db.isAvailable()) break;
            try {
                await db.query(
                    'DELETE FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
                    [session.userId, data.friendId]
                );
                send(ws, { type: 'friend_removed', userId: data.friendId });
                const friendWs = onlineUsers.get(data.friendId);
                if (friendWs) send(friendWs, { type: 'friend_removed', userId: session.userId });
                // Clean up any pending invites between them
                for (const [inviteId, invite] of pendingInvites) {
                    if ((invite.fromUserId === session.userId && invite.toUserId === data.friendId) ||
                        (invite.fromUserId === data.friendId && invite.toUserId === session.userId)) {
                        pendingInvites.delete(inviteId);
                    }
                }
            } catch (e) {
                console.error('Remove friend error:', e.message);
            }
            break;
        }

        case 'get_friends_list': {
            const session = playerSessions.get(ws);
            if (!session || !db.isAvailable()) { send(ws, { type: 'friends_list', friends: [] }); break; }
            try {
                const result = await db.query(
                    `SELECT u.id, u.username, u.rating
                     FROM friendships f
                     JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
                     WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
                     ORDER BY u.username`,
                    [session.userId]
                );
                const friends = result.rows.map(row => ({
                    userId: row.id,
                    username: row.username,
                    rank: auth.getRank(row.rating),
                    status: getUserStatus(row.id),
                }));
                send(ws, { type: 'friends_list', friends });
            } catch (e) {
                console.error('Get friends list error:', e.message);
                send(ws, { type: 'friends_list', friends: [] });
            }
            break;
        }

        case 'get_pending_requests': {
            const session = playerSessions.get(ws);
            if (!session || !db.isAvailable()) { send(ws, { type: 'pending_requests', incoming: [], outgoing: [] }); break; }
            try {
                const incoming = await db.query(
                    `SELECT u.id, u.username, u.rating FROM friendships f
                     JOIN users u ON u.id = f.user_id
                     WHERE f.friend_id = $1 AND f.status = 'pending'
                     ORDER BY f.created_at DESC`,
                    [session.userId]
                );
                const outgoing = await db.query(
                    `SELECT u.id, u.username FROM friendships f
                     JOIN users u ON u.id = f.friend_id
                     WHERE f.user_id = $1 AND f.status = 'pending'
                     ORDER BY f.created_at DESC`,
                    [session.userId]
                );
                send(ws, {
                    type: 'pending_requests',
                    incoming: incoming.rows.map(r => ({ id: r.id, username: r.username, rank: auth.getRank(r.rating) })),
                    outgoing: outgoing.rows.map(r => ({ id: r.id, username: r.username })),
                });
            } catch (e) {
                console.error('Get pending requests error:', e.message);
                send(ws, { type: 'pending_requests', incoming: [], outgoing: [] });
            }
            break;
        }

        // ---- GAME INVITES ----
        case 'send_game_invite': {
            const session = playerSessions.get(ws);
            if (!session) { send(ws, { type: 'game_invite_error', error: 'Must be logged in' }); break; }
            if (playerRooms.has(ws)) { send(ws, { type: 'game_invite_error', error: 'You are already in a game' }); break; }
            const toUserId = data.toUserId;
            const toWs = onlineUsers.get(toUserId);
            if (!toWs || toWs.readyState !== WebSocket.OPEN) { send(ws, { type: 'game_invite_error', error: 'Player is offline' }); break; }
            if (playerRooms.has(toWs)) { send(ws, { type: 'game_invite_error', error: 'Player is in a game' }); break; }
            // Check for duplicate invite
            let isDuplicate = false;
            for (const [, inv] of pendingInvites) {
                if (inv.fromUserId === session.userId && inv.toUserId === toUserId) {
                    send(ws, { type: 'game_invite_error', error: 'Invite already sent' });
                    isDuplicate = true;
                    break;
                }
            }
            if (isDuplicate) break;
            // Check for mutual invite (they already invited us) — auto-start game
            let mutualHandled = false;
            for (const [existingId, inv] of pendingInvites) {
                if (inv.fromUserId === toUserId && inv.toUserId === session.userId) {
                    // Mutual invite — start game immediately
                    pendingInvites.delete(existingId);
                    // Clean up other invites for both players
                    cleanupInvitesForUser(session.userId);
                    cleanupInvitesForUser(toUserId);
                    const [red, yellow] = Math.random() < 0.5 ? [ws, toWs] : [toWs, ws];
                    const room = createRoom(red);
                    room.players[1] = yellow;
                    playerRooms.set(yellow, room.code);
                    await startGame(room);
                    mutualHandled = true;
                    break;
                }
            }
            if (mutualHandled) break;
            // Get target username
            try {
                const targetResult = await db.query('SELECT username FROM users WHERE id = $1', [toUserId]);
                const toUsername = targetResult.rows[0]?.username || '';
                const inviteId = uuidv4();
                pendingInvites.set(inviteId, {
                    fromUserId: session.userId, fromUsername: session.username,
                    toUserId, toUsername, fromWs: ws, createdAt: Date.now()
                });
                send(ws, { type: 'game_invite_sent', inviteId, toUsername });
                // Get sender's rank for the invite display
                const profile = await auth.getProfile(session.userId);
                const fromRank = profile ? profile.rank : auth.getRank(1200);
                send(toWs, { type: 'game_invite_received', inviteId, fromUserId: session.userId, fromUsername: session.username, fromRank });
            } catch (e) {
                console.error('Send game invite error:', e.message);
                send(ws, { type: 'game_invite_error', error: 'Failed to send invite' });
            }
            break;
        }

        case 'accept_game_invite': {
            const session = playerSessions.get(ws);
            if (!session) break;
            const invite = pendingInvites.get(data.inviteId);
            if (!invite) { send(ws, { type: 'game_invite_error', error: 'Invite no longer valid' }); break; }
            if (invite.toUserId !== session.userId) break;
            const fromWs = onlineUsers.get(invite.fromUserId);
            if (!fromWs || fromWs.readyState !== WebSocket.OPEN) {
                pendingInvites.delete(data.inviteId);
                send(ws, { type: 'game_invite_error', error: 'Player went offline' });
                break;
            }
            if (playerRooms.has(fromWs)) {
                pendingInvites.delete(data.inviteId);
                send(ws, { type: 'game_invite_error', error: 'Player is now in a game' });
                break;
            }
            if (playerRooms.has(ws)) {
                send(ws, { type: 'game_invite_error', error: 'You are already in a game' });
                break;
            }
            // Clean up all invites for both players
            pendingInvites.delete(data.inviteId);
            cleanupInvitesForUser(session.userId);
            cleanupInvitesForUser(invite.fromUserId);
            // Create game — randomly assign teams
            const [red, yellow] = Math.random() < 0.5 ? [fromWs, ws] : [ws, fromWs];
            const room = createRoom(red);
            room.players[1] = yellow;
            playerRooms.set(yellow, room.code);
            await startGame(room);
            break;
        }

        case 'deny_game_invite': {
            const session = playerSessions.get(ws);
            if (!session) break;
            const invite = pendingInvites.get(data.inviteId);
            if (!invite) break;
            pendingInvites.delete(data.inviteId);
            const fromWs = onlineUsers.get(invite.fromUserId);
            if (fromWs) send(fromWs, { type: 'game_invite_denied', inviteId: data.inviteId, byUsername: session.username });
            break;
        }

        case 'cancel_game_invite': {
            const session = playerSessions.get(ws);
            if (!session) break;
            const invite = pendingInvites.get(data.inviteId);
            if (!invite || invite.fromUserId !== session.userId) break;
            pendingInvites.delete(data.inviteId);
            const toWs = onlineUsers.get(invite.toUserId);
            if (toWs) send(toWs, { type: 'game_invite_cancelled', inviteId: data.inviteId });
            break;
        }

        // ---- LOBBY ----
        case 'create_room': {
            const room = createRoom(ws, data.totalEnds);
            send(ws, { type: 'room_created', code: room.code });
            break;
        }

        case 'join_room': {
            const code = (data.code || '').toUpperCase();
            const result = joinRoom(code, ws);
            if (result.error) {
                send(ws, { type: result.error, code });
            } else if (result.sameUser) {
                // v115h: Same user rejoining (clicked their own invite link)
                // Treat as a reconnect — send them current game state
                const room = result.room;
                const team = result.slot === 0 ? 'red' : 'yellow';
                console.log('[JOIN] Same user rejoining room ' + code + ' as ' + team);
                send(ws, { type: 'reconnected', yourTeam: team, serverState: {
                    currentTeam: room.state.currentTeam,
                    redThrown: room.state.redThrown,
                    yellowThrown: room.state.yellowThrown,
                    redScore: room.state.redScore,
                    yellowScore: room.state.yellowScore,
                    currentEnd: room.state.currentEnd,
                    totalEnds: room.state.totalEnds,
                    hammer: room.state.hammer,
                    endScores: room.state.endScores,
                    stones: room.state.settledStones,
                    phase: room.state.phase,
                    throwInProgress: room.state.throwInProgress,
                }});
            } else {
                send(ws, { type: 'room_joined', code });
                await startGame(result.room);
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

                // Verify both have sessions (logged in)
                const s1 = playerSessions.get(p1);
                const s2 = playerSessions.get(p2);
                if (!s1 || !s1.userId) {
                    send(p1, { type: 'auth_error', error: 'Session expired' });
                    matchmakingQueue.unshift(p2);
                    continue;
                }
                if (!s2 || !s2.userId) {
                    send(p2, { type: 'auth_error', error: 'Session expired' });
                    matchmakingQueue.unshift(p1);
                    continue;
                }

                // Randomly assign teams
                const [red, yellow] = Math.random() < 0.5 ? [p1, p2] : [p2, p1];
                const room = createRoom(red);
                room.players[1] = yellow;
                playerRooms.set(yellow, room.code);
                await startGame(room);
            }
            break;
        }

        case 'leave_queue': {
            removeFromQueue(ws);
            break;
        }

        // ---- GAMEPLAY ----
        // ============================================================
        // v112: SERVER-AUTHORITATIVE THROW HANDLER
        // Server receives throw params, runs physics, sends results
        // to BOTH players. No more client-side physics for online.
        // ============================================================
        case 'throw': {
            const code = playerRooms.get(ws);
            if (!code) {
                console.log('[THROW REJECTED] ws not in any room');
                send(ws, { type: 'throw_rejected', reason: 'not_in_room' });
                return;
            }
            const room = rooms.get(code);
            if (!room) {
                send(ws, { type: 'throw_rejected', reason: 'room_gone' });
                return;
            }

            const team = getPlayerTeam(room, ws);
            if (team !== room.state.currentTeam) {
                console.log(`[THROW REJECTED] ${team} tried to throw but currentTeam is ${room.state.currentTeam} (room ${code})`);
                send(ws, { type: 'throw_rejected', reason: 'not_your_turn', serverCurrentTeam: room.state.currentTeam });
                return;
            }

            // Reject if a throw is already in progress
            if (room.state.throwInProgress) {
                console.log(`[THROW REJECTED] throw already in progress (room ${code})`);
                send(ws, { type: 'throw_rejected', reason: 'throw_in_progress' });
                return;
            }

            const throwParams = {
                aim: data.aim,
                weight: data.weight,
                spinDir: data.spinDir,
                spinAmount: data.spinAmount,
                sweepLevel: data.sweepLevel || 'none',
            };

            // Save pre-throw stone snapshot for replay
            const preThrowStones = room.state.settledStones.map(s => ({ team: s.team, x: s.x, y: s.y }));
            room.state.lastPreThrowStones = preThrowStones;
            room.state.lastThrowParams = throwParams;

            // Increment throw count (server tracks this now)
            if (team === 'red') {
                room.state.redThrown++;
            } else {
                room.state.yellowThrown++;
            }

            // Snapshot FGZ-protected stones BEFORE physics runs
            serverSnapshotFGZ(room, team);

            // Mark throw in progress
            room.state.throwInProgress = true;
            room.state.phase = 'throwing';

            console.log(`[THROW OK] ${team} throwing: aim=${data.aim} weight=${data.weight} sweep=${throwParams.sweepLevel} redThrown=${room.state.redThrown} yellowThrown=${room.state.yellowThrown} (room ${code})`);

            // Acknowledge the throw
            send(ws, { type: 'throw_ack' });

            // Notify opponent that a throw is in progress
            const opponent = getOpponent(room, ws);
            if (opponent && opponent.readyState === WebSocket.OPEN) {
                send(opponent, {
                    type: 'opponent_throw_started',
                    throwParams,
                });
            }

            // v112a: Safety timeout — if physics takes >30s, force-complete
            const physicsTimeout = setTimeout(() => {
                if (room.state.throwInProgress) {
                    console.error(`[THROW TIMEOUT] Physics took >30s — forcing completion (room ${code})`);
                    if (room.state.physicsInterval) clearInterval(room.state.physicsInterval);
                    room.state.throwInProgress = false;
                    room.state.phase = 'playing';
                    room.state.currentTeam = room.state.currentTeam === 'red' ? 'yellow' : 'red';
                    const fallback = {
                        type: 'throw_result',
                        stones: room.state.settledStones, currentTeam: room.state.currentTeam,
                        redThrown: room.state.redThrown, yellowThrown: room.state.yellowThrown,
                        redScore: room.state.redScore, yellowScore: room.state.yellowScore,
                        currentEnd: room.state.currentEnd, totalEnds: room.state.totalEnds,
                        hammer: room.state.hammer, endScores: room.state.endScores,
                        throwParams, preThrowStones, hogViolation: false, fgzViolation: false,
                        throwerTeam: team, endComplete: false, gameOver: false,
                    };
                    if (ws.readyState === WebSocket.OPEN) send(ws, fallback);
                    const to = getOpponent(room, ws);
                    if (to && to.readyState === WebSocket.OPEN) send(to, fallback);
                }
            }, 30000);

            // Run physics on the server
            runServerPhysics(room, throwParams, (result) => {
                try {
                    clearTimeout(physicsTimeout);

                    // Physics settled — update authoritative state
                    room.state.settledStones = result.stones;
                    room.state.throwInProgress = false;
                    room.state.phase = 'playing';

                    // Check if end is complete (all 16 stones thrown)
                    let endResult = null;
                    let gameOver = false;
                    if (room.state.redThrown >= 8 && room.state.yellowThrown >= 8) {
                        endResult = serverEndOfEnd(room);
                        gameOver = endResult.gameOver;
                    } else {
                        // Toggle turn (ONCE — server is sole authority)
                        room.state.currentTeam = room.state.currentTeam === 'red' ? 'yellow' : 'red';
                        // If current team has thrown all 8, switch again
                        if (room.state.currentTeam === 'red' && room.state.redThrown >= 8) {
                            room.state.currentTeam = 'yellow';
                        } else if (room.state.currentTeam === 'yellow' && room.state.yellowThrown >= 8) {
                            room.state.currentTeam = 'red';
                        }
                    }

                    console.log(`[THROW SETTLED] ${team} -> stones=${result.stones.length} hog=${result.hogViolation} fgz=${result.fgzViolation} steps=${result.stepCount} currentTeam=${room.state.currentTeam} (room ${code})`);

                    // Build the throw_result message for BOTH players
                    const throwResultMsg = {
                        type: 'throw_result',
                        stones: room.state.settledStones,
                        currentTeam: room.state.currentTeam,
                        redThrown: room.state.redThrown,
                        yellowThrown: room.state.yellowThrown,
                        redScore: room.state.redScore,
                        yellowScore: room.state.yellowScore,
                        currentEnd: room.state.currentEnd,
                        totalEnds: room.state.totalEnds,
                        hammer: room.state.hammer,
                        endScores: room.state.endScores,
                        throwParams,
                        preThrowStones,
                        hogViolation: result.hogViolation,
                        fgzViolation: result.fgzViolation,
                        throwerTeam: team,
                        endComplete: !!endResult,
                        gameOver,
                    };

                    // Send to both players
                    if (ws.readyState === WebSocket.OPEN) {
                        send(ws, throwResultMsg);
                    }
                    const opp = getOpponent(room, ws);
                    if (opp && opp.readyState === WebSocket.OPEN) {
                        send(opp, throwResultMsg);
                    }

                    // Record game result if game over
                    if (gameOver) {
                        room.state.phase = 'finished';
                        // Auto-record game result on server
                        if (!room.resultRecorded) {
                            room.resultRecorded = true;
                            const redSession = (room.players[0] ? playerSessions.get(room.players[0]) : null) || room.sessions[0];
                            const yellowSession = (room.players[1] ? playerSessions.get(room.players[1]) : null) || room.sessions[1];
                            if (redSession && yellowSession) {
                                auth.recordGameResult(
                                    redSession.userId,
                                    yellowSession.userId,
                                    room.state.redScore,
                                    room.state.yellowScore,
                                    room.state.currentEnd
                                ).then(ratingResult => {
                                    if (ratingResult) {
                                        if (room.players[0] && room.players[0].readyState === WebSocket.OPEN) {
                                            send(room.players[0], { type: 'rating_update', rank: ratingResult.red.rank });
                                        }
                                        if (room.players[1] && room.players[1].readyState === WebSocket.OPEN) {
                                            send(room.players[1], { type: 'rating_update', rank: ratingResult.yellow.rank });
                                        }
                                    }
                                }).catch(err => console.error('Game result recording error:', err));
                            }
                        }
                    }

                    // Send push notification to next player (if not game over)
                    if (!gameOver && process.env.VAPID_PUBLIC_KEY) {
                        const nextIdx = room.state.currentTeam === 'red' ? 0 : 1;
                        const nextWs = room.players[nextIdx];
                        const nextSession = nextWs ? playerSessions.get(nextWs) : null;
                        if (nextSession?.userId) {
                            if (endResult) {
                                sendPushNotification(nextSession.userId, 'New end starting!',
                                    `End ${room.state.currentEnd} is starting. You throw first!`);
                            } else {
                                sendPushNotification(nextSession.userId, "It's your turn!",
                                    'Your opponent has thrown. Time to deliver your stone!');
                            }
                        }
                    }
                } catch (err) {
                    // v112a: Error recovery — ensure game doesn't get stuck
                    console.error(`[THROW ERROR] Physics callback error (room ${code}):`, err);
                    clearTimeout(physicsTimeout);
                    room.state.throwInProgress = false;
                    room.state.phase = 'playing';
                    room.state.currentTeam = room.state.currentTeam === 'red' ? 'yellow' : 'red';
                    const fallback = {
                        type: 'throw_result',
                        stones: room.state.settledStones, currentTeam: room.state.currentTeam,
                        redThrown: room.state.redThrown, yellowThrown: room.state.yellowThrown,
                        redScore: room.state.redScore, yellowScore: room.state.yellowScore,
                        currentEnd: room.state.currentEnd, totalEnds: room.state.totalEnds,
                        hammer: room.state.hammer, endScores: room.state.endScores,
                        throwParams, preThrowStones, hogViolation: false, fgzViolation: false,
                        throwerTeam: team, endComplete: false, gameOver: false,
                    };
                    if (ws.readyState === WebSocket.OPEN) send(ws, fallback);
                    const opp2 = getOpponent(room, ws);
                    if (opp2 && opp2.readyState === WebSocket.OPEN) send(opp2, fallback);
                }
            });
            break;
        }

        case 'sweep_change': {
            const code = playerRooms.get(ws);
            if (!code) break;
            const room = rooms.get(code);
            if (!room || !room.state.throwInProgress) break;

            const team = getPlayerTeam(room, ws);
            // v115b: Only the THROWING team can sweep their own stone
            if (team === room.state.currentTeam) {
                room.state.liveSweepLevel = data.level; // 'none', 'light', 'hard'
                // Broadcast to opponent so they see sweep feedback
                const opp = getOpponent(room, ws);
                if (opp && opp.readyState === WebSocket.OPEN) {
                    send(opp, { type: 'opponent_sweep_change', level: data.level });
                }
            }
            break;
        }

        // Keep stone_positions and old sweep actions as no-ops to avoid errors 
        // if old clients send them
        case 'sweep_start':
        case 'sweep_stop':
        case 'stone_positions': {
            break;
        }

        case 'chat_message': {
            const allowedMessages = ['Good shot!', 'Nice!', 'Good game!', 'Good luck!', 'Thanks!'];
            if (!allowedMessages.includes(data.text)) break;
            const code = playerRooms.get(ws);
            if (!code) break;
            const room = rooms.get(code);
            if (!room) break;
            const opponent = getOpponent(room, ws);
            const session = playerSessions.get(ws);
            send(opponent, { type: 'chat_message', text: data.text, from: session ? session.username : 'Opponent' });
            break;
        }

        case 'turn_complete': {
            // Turn switching now happens atomically when the throw is relayed.
            // This message is kept for backward compatibility but is a no-op.
            break;
        }

        // v112: game_state_sync, end_transition, throw_settled — REMOVED
        // Server is now authoritative for all game state. These messages
        // are no longer needed. Kept as no-ops for backward compatibility.
        case 'game_state_sync':
        case 'end_transition':
        case 'throw_settled': {
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

            const redSession = (room.players[0] ? playerSessions.get(room.players[0]) : null) || room.sessions[0];
            const yellowSession = (room.players[1] ? playerSessions.get(room.players[1]) : null) || room.sessions[1];

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
                // Both players want rematch - restart with fresh game state
                room._rematchRequested = null;
                initFullGameState(room);
                room.state.totalEnds = room.totalEnds;
                room.resultRecorded = false;
                // Re-cache sessions
                room.sessions[0] = playerSessions.get(room.players[0]) || room.sessions[0];
                room.sessions[1] = playerSessions.get(room.players[1]) || room.sessions[1];
                const redInfo = await getPlayerInfo(room.players[0]);
                const yellowInfo = await getPlayerInfo(room.players[1]);
                send(room.players[0], { type: 'rematch_accepted', yourTeam: 'red', opponent: yellowInfo, totalEnds: room.totalEnds || 4 });
                send(room.players[1], { type: 'rematch_accepted', yourTeam: 'yellow', opponent: redInfo, totalEnds: room.totalEnds || 4 });
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
                // Broadcast opponent back to 'online' since they left the game
                const oppSession = playerSessions.get(opponent);
                if (oppSession?.userId) broadcastPresenceToFriends(oppSession.userId, 'online');
            }
            playerRooms.delete(ws);
            destroyRoom(code);
            // Broadcast self back to 'online'
            const mySession = playerSessions.get(ws);
            if (mySession?.userId) broadcastPresenceToFriends(mySession.userId, 'online');
            break;
        }

        // ============================================================
        // v112: SIMPLIFIED RECONNECT — server owns all state
        // ============================================================
        case 'reconnect': {
            const code = (data.code || '').toUpperCase();
            const room = rooms.get(code);
            if (!room) {
                send(ws, { type: 'reconnect_failed' });
                return;
            }

            // Client sends a team hint (from sessionStorage) so we can place them
            // back in their ORIGINAL slot and avoid swapping team colors.
            const teamHint = data.team;
            const hintSlot = teamHint === 'red' ? 0 : teamHint === 'yellow' ? 1 : -1;

            let emptySlot = -1;
            if (hintSlot !== -1 && room.players[hintSlot] === null) {
                emptySlot = hintSlot;
            } else if (hintSlot !== -1 && room.players[hintSlot] &&
                room.players[hintSlot] !== ws &&
                room.players[hintSlot].readyState !== WebSocket.OPEN) {
                playerRooms.delete(room.players[hintSlot]);
                playerSessions.delete(room.players[hintSlot]);
                room.players[hintSlot] = null;
                emptySlot = hintSlot;
            } else if (hintSlot !== -1 && room.players[hintSlot] === ws) {
                emptySlot = hintSlot;
            } else {
                emptySlot = room.players[0] === null ? 0 : room.players[1] === null ? 1 : -1;
            }

            if (emptySlot === -1) {
                for (let i = 0; i < 2; i++) {
                    const existingWs = room.players[i];
                    if (existingWs && existingWs !== ws && existingWs.readyState !== WebSocket.OPEN) {
                        playerRooms.delete(existingWs);
                        playerSessions.delete(existingWs);
                        room.players[i] = null;
                        emptySlot = i;
                        break;
                    }
                    if (existingWs && existingWs === ws) {
                        emptySlot = i;
                        break;
                    }
                }
            }

            if (emptySlot === -1) {
                send(ws, { type: 'reconnect_failed' });
                return;
            }

            if (room.players[emptySlot] !== ws || playerRooms.get(ws) !== code) {
                room.players[emptySlot] = ws;
                playerRooms.set(ws, code);
            }

            if (room.disconnectTimers[emptySlot]) {
                clearTimeout(room.disconnectTimers[emptySlot]);
                room.disconnectTimers[emptySlot] = null;
            }

            if (room.sessions[emptySlot] && !playerSessions.get(ws)) {
                playerSessions.set(ws, room.sessions[emptySlot]);
                onlineUsers.set(room.sessions[emptySlot].userId, ws);
            }

            const team = emptySlot === 0 ? 'red' : 'yellow';
            const opponentWs = getOpponent(room, ws);
            const opponentInfo = opponentWs ? await getPlayerInfo(opponentWs) : null;

            // v112: Server owns ALL game state — send it directly.
            // No more snapshot patching or currentTeam overrides needed.
            console.log(`[RECONNECT] Sending reconnected to slot ${emptySlot} (${team}): currentTeam=${room.state.currentTeam} stones=${room.state.settledStones.length} throwInProgress=${room.state.throwInProgress} (room ${code})`);

            send(ws, {
                type: 'reconnected',
                yourTeam: team,
                // v112: Send full authoritative state from server
                gameState: {
                    currentTeam: room.state.currentTeam,
                    settledStones: room.state.settledStones,
                    redThrown: room.state.redThrown,
                    yellowThrown: room.state.yellowThrown,
                    currentEnd: room.state.currentEnd,
                    totalEnds: room.state.totalEnds,
                    redScore: room.state.redScore,
                    yellowScore: room.state.yellowScore,
                    hammer: room.state.hammer,
                    endScores: room.state.endScores,
                    throwInProgress: room.state.throwInProgress,
                    lastThrowParams: room.state.lastThrowParams,
                    lastPreThrowStones: room.state.lastPreThrowStones,
                },
                opponent: opponentInfo,
            });

            // Clear any queued messages (server state is complete)
            room.pendingMessages[emptySlot] = [];

            // Notify opponent
            if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
                await new Promise(r => setTimeout(r, 300));
                room.sessions[emptySlot] = playerSessions.get(ws) || room.sessions[emptySlot];
                const myInfo = await getPlayerInfo(ws);
                send(opponentWs, { type: 'opponent_reconnected', opponent: myInfo });
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

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (message) => {
        ws.isAlive = true;
        handleMessage(ws, message.toString()).catch(err => {
            console.error('[MESSAGE ERROR]', err.message);
        });
    });

    ws.on('close', () => {
        cleanupPlayer(ws);
    });

    ws.on('error', () => {
        cleanupPlayer(ws);
    });
});

// --------------------------------------------------------
// HEARTBEAT - detect dead connections
// Uses missedPings counter: connections survive 3 missed pings (up to 6 min)
// to tolerate mobile tab-switching (sending a text, checking another app).
// Mobile browsers throttle/suspend WebSocket-level pong responses when
// backgrounded, so we must be VERY generous here. False positives
// (killing a live connection) are far worse than false negatives
// (keeping a dead connection around a few extra minutes).
// --------------------------------------------------------
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            ws._missedPings = (ws._missedPings || 0) + 1;
            if (ws._missedPings >= 3) {
                console.log('[HEARTBEAT] Terminating dead connection (missed 3 pings)');
                cleanupPlayer(ws);
                return ws.terminate();
            }
        } else {
            ws._missedPings = 0;
        }
        ws.isAlive = false;
        // Send WebSocket-level ping (client auto-replies with pong)
        try { ws.ping(); } catch (_) { }
    });
}, 120000); // 120 seconds per cycle — 3 missed = 6 min tolerance

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
    // Clean up stale game invites (older than 10 minutes)
    for (const [inviteId, invite] of pendingInvites) {
        if (now - invite.createdAt > 10 * 60 * 1000) {
            pendingInvites.delete(inviteId);
            const fromWs = onlineUsers.get(invite.fromUserId);
            if (fromWs) send(fromWs, { type: 'game_invite_denied', inviteId, byUsername: 'timeout' });
            const toWs = onlineUsers.get(invite.toUserId);
            if (toWs) send(toWs, { type: 'game_invite_cancelled', inviteId });
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
