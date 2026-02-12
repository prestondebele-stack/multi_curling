// ============================================================
// AUTH - User registration, login, sessions, game recording
// ============================================================

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// In-memory session store: token -> { userId, username }
const sessions = new Map();

async function register(username, password, country) {
    if (!db.isAvailable()) return { error: 'Accounts not available' };

    if (!username || username.length < 3 || username.length > 20) {
        return { error: 'Username must be 3-20 characters' };
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return { error: 'Username: letters, numbers, underscore only' };
    }
    if (!password || password.length < 4) {
        return { error: 'Password must be at least 4 characters' };
    }

    const hash = await bcrypt.hash(password, 10);

    try {
        const result = await db.query(
            'INSERT INTO users (username, password_hash, country) VALUES ($1, $2, $3) RETURNING id, username',
            [username.toLowerCase(), hash, country || '']
        );

        const user = result.rows[0];
        const token = uuidv4();
        sessions.set(token, { userId: user.id, username: user.username });

        return { token, username: user.username, userId: user.id };
    } catch (e) {
        if (e.code === '23505') { // unique violation
            return { error: 'Username already taken' };
        }
        console.error('Registration error:', e.message);
        return { error: 'Registration failed' };
    }
}

async function login(username, password) {
    if (!db.isAvailable()) return { error: 'Accounts not available' };

    if (!username || !password) {
        return { error: 'Username and password required' };
    }

    try {
        const result = await db.query(
            'SELECT id, username, password_hash FROM users WHERE username = $1',
            [username.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return { error: 'User not found' };
        }

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);

        if (!valid) {
            return { error: 'Invalid password' };
        }

        // Update last_seen
        await db.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);

        const token = uuidv4();
        sessions.set(token, { userId: user.id, username: user.username });

        return { token, username: user.username, userId: user.id };
    } catch (e) {
        console.error('Login error:', e.message);
        return { error: 'Login failed' };
    }
}

function getSession(token) {
    return sessions.get(token) || null;
}

function removeSession(token) {
    sessions.delete(token);
}

async function getProfile(userId) {
    if (!db.isAvailable()) return null;

    try {
        const result = await db.query(
            'SELECT username, country, wins, losses, draws, rating, created_at FROM users WHERE id = $1',
            [userId]
        );
        return result.rows[0] || null;
    } catch (e) {
        console.error('Profile fetch error:', e.message);
        return null;
    }
}

async function recordGameResult(redUserId, yellowUserId, redScore, yellowScore, endCount) {
    if (!db.isAvailable()) return;

    try {
        let winnerId = null;
        if (redScore > yellowScore) winnerId = redUserId;
        else if (yellowScore > redScore) winnerId = yellowUserId;

        // Record game history
        await db.query(
            `INSERT INTO game_history (red_user_id, yellow_user_id, red_score, yellow_score, winner_id, end_count)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [redUserId, yellowUserId, redScore, yellowScore, winnerId, endCount]
        );

        // Update win/loss/draw counts
        if (winnerId === redUserId) {
            await db.query('UPDATE users SET wins = wins + 1 WHERE id = $1', [redUserId]);
            await db.query('UPDATE users SET losses = losses + 1 WHERE id = $1', [yellowUserId]);
        } else if (winnerId === yellowUserId) {
            await db.query('UPDATE users SET wins = wins + 1 WHERE id = $1', [yellowUserId]);
            await db.query('UPDATE users SET losses = losses + 1 WHERE id = $1', [redUserId]);
        } else {
            await db.query('UPDATE users SET draws = draws + 1 WHERE id = $1', [redUserId]);
            await db.query('UPDATE users SET draws = draws + 1 WHERE id = $1', [yellowUserId]);
        }
    } catch (e) {
        console.error('Record game result error:', e.message);
    }
}

module.exports = { register, login, getSession, removeSession, getProfile, recordGameResult };
