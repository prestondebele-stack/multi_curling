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
    const ends = allowedEnds.includes(totalEnds) ? totalEnds : 6;
    const room = {
        code,
        players: [hostWs, null], // index 0 = red (host), index 1 = yellow
        totalEnds: ends,
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

async function startGame(room) {
    room.state.phase = 'playing';
    room.state.currentTeam = 'red';
    room.gameSnapshot = null;
    room.resultRecorded = false;

    // Fetch player info for opponent display
    const redInfo = await getPlayerInfo(room.players[0]);
    const yellowInfo = await getPlayerInfo(room.players[1]);

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
    const session = playerSessions.get(ws);
    if (!session || !session.userId) {
        console.log('[getPlayerInfo] No session for ws — playerSessions has', playerSessions.size, 'entries');
        return null;
    }
    try {
        const profile = await auth.getProfile(session.userId);
        return {
            username: session.username,
            rank: profile ? profile.rank : auth.getRank(1200),
        };
    } catch (e) {
        console.error('getPlayerInfo error:', e.message);
        return { username: session.username, rank: auth.getRank(1200) };
    }
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

    // Track presence before removing session
    const session = playerSessions.get(ws);
    if (session && session.userId) {
        onlineUsers.delete(session.userId);
        cleanupInvitesForUser(session.userId);
        broadcastPresenceToFriends(session.userId, 'offline');
    }
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

    // DON'T notify the opponent immediately — give the player a 45-second
    // grace period to reconnect (common when sending a text on mobile).
    // If they reconnect within the grace window, the opponent never sees anything.
    const opponent = getOpponent(room, ws);

    room.players[playerIdx] = null;
    playerRooms.delete(ws);

    // Grace timer: after 45s, THEN tell opponent about the disconnect
    room.disconnectTimers[playerIdx] = setTimeout(() => {
        // Check if the player has already reconnected during grace period
        if (room.players[playerIdx] !== null) return; // They're back!

        if (opponent && opponent.readyState === WebSocket.OPEN) {
            send(opponent, { type: 'opponent_disconnected' });
        }

        // Now start the 5-minute hard timer for room destruction
        room.disconnectTimers[playerIdx] = setTimeout(() => {
            // Check again — they may have reconnected after the notification
            if (room.players[playerIdx] !== null) return;

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
        case 'ping':
            send(ws, { type: 'pong' });
            break;

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
        case 'throw': {
            const code = playerRooms.get(ws);
            if (!code) return;
            const room = rooms.get(code);
            if (!room) return;

            const team = getPlayerTeam(room, ws);
            if (team !== room.state.currentTeam) {
                console.log(`[THROW REJECTED] ${team} tried to throw but currentTeam is ${room.state.currentTeam} (room ${code})`);
                return; // not your turn
            }

            const prevTeam = room.state.currentTeam;
            // Switch turns immediately when relaying the throw
            // (prevents race condition with separate turn_complete message)
            room.state.currentTeam = room.state.currentTeam === 'red' ? 'yellow' : 'red';
            console.log(`[THROW OK] ${team} threw, turn switched ${prevTeam} -> ${room.state.currentTeam} (room ${code})`);

            const opponent = getOpponent(room, ws);
            if (opponent && opponent.readyState === WebSocket.OPEN) {
                send(opponent, {
                    type: 'opponent_throw',
                    aim: data.aim,
                    weight: data.weight,
                    spinDir: data.spinDir,
                    spinAmount: data.spinAmount,
                });
            } else {
                console.log(`[THROW WARN] opponent not connected for relay (room ${code})`);
            }

            // Send push notification to the player whose turn it now is
            const nextIdx = room.state.currentTeam === 'red' ? 0 : 1;
            const nextWs = room.players[nextIdx];
            const nextSession = nextWs ? playerSessions.get(nextWs) : null;
            if (nextSession?.userId && process.env.VAPID_PUBLIC_KEY) {
                sendPushNotification(nextSession.userId, "It's your turn!", 'Your opponent has thrown. Time to deliver your stone!');
            }
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
                const redInfo = await getPlayerInfo(room.players[0]);
                const yellowInfo = await getPlayerInfo(room.players[1]);
                send(room.players[0], { type: 'rematch_accepted', yourTeam: 'red', opponent: yellowInfo, totalEnds: room.totalEnds || 6 });
                send(room.players[1], { type: 'rematch_accepted', yourTeam: 'yellow', opponent: redInfo, totalEnds: room.totalEnds || 6 });
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

        case 'reconnect': {
            const code = (data.code || '').toUpperCase();
            const room = rooms.get(code);
            if (!room) {
                send(ws, { type: 'reconnect_failed' });
                return;
            }

            // Find the empty slot — first check for null, then check for dead sockets.
            // Race condition: client reconnects with a new WebSocket before the server
            // has detected that the old socket is dead (server heartbeat runs every 120s).
            // The old socket may report readyState !== OPEN even though the server hasn't
            // processed its close event yet.
            let emptySlot = room.players[0] === null ? 0 : room.players[1] === null ? 1 : -1;

            if (emptySlot === -1) {
                // Both slots occupied — check if either has a dead/stale socket
                // that the server hasn't cleaned up yet
                for (let i = 0; i < 2; i++) {
                    const existingWs = room.players[i];
                    if (existingWs && existingWs !== ws && existingWs.readyState !== WebSocket.OPEN) {
                        // This socket is dead — clean it up and take its slot
                        console.log(`[RECONNECT] Replacing dead socket in slot ${i} (readyState=${existingWs.readyState})`);
                        playerRooms.delete(existingWs);
                        playerSessions.delete(existingWs);
                        room.players[i] = null;
                        emptySlot = i;
                        break;
                    }
                    // Also check if this is the SAME player reconnecting (same ws object
                    // shouldn't happen, but check by session identity)
                    if (existingWs && existingWs === ws) {
                        // Already in the room with this socket — just resync
                        emptySlot = i;
                        break;
                    }
                }
            }

            if (emptySlot === -1) {
                // Both sockets genuinely alive — can't join
                send(ws, { type: 'reconnect_failed' });
                return;
            }

            // Cancel disconnect timer (grace period or hard timer)
            if (room.disconnectTimers[emptySlot]) {
                clearTimeout(room.disconnectTimers[emptySlot]);
                room.disconnectTimers[emptySlot] = null;
            }

            room.players[emptySlot] = ws;
            playerRooms.set(ws, code);

            // Note: session for this ws may not be set yet (token_login comes right after)
            // We send opponent info that IS available, and the token_login will restore our session
            const team = emptySlot === 0 ? 'red' : 'yellow';
            const opponentWs = getOpponent(room, ws);
            const opponentInfo = opponentWs ? await getPlayerInfo(opponentWs) : null;
            send(ws, {
                type: 'reconnected',
                yourTeam: team,
                gameSnapshot: room.gameSnapshot || null,
                opponent: opponentInfo,
            });

            // Notify opponent and send updated info about reconnected player
            if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
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
        try { ws.ping(); } catch (_) {}
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
