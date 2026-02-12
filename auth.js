// ============================================================
// AUTH - User registration, login, sessions, game recording
// ============================================================

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// In-memory session store: token -> { userId, username }
const sessions = new Map();

// ---- RANKING SYSTEM ----
// Curling-themed Elo tiers
const RANK_TIERS = [
    { name: 'Novice',         minRating: 0,    color: '#9e9e9e' },  // grey
    { name: 'Lead',           minRating: 900,  color: '#8d6e63' },  // brown
    { name: 'Second',         minRating: 1100, color: '#66bb6a' },  // green
    { name: 'Third',          minRating: 1300, color: '#42a5f5' },  // blue
    { name: 'Skip',           minRating: 1500, color: '#ab47bc' },  // purple
    { name: 'Club Champion',  minRating: 1700, color: '#ffa726' },  // orange
    { name: 'Provincial',     minRating: 1900, color: '#ef5350' },  // red
    { name: 'National',       minRating: 2100, color: '#e0e0e0' },  // silver
    { name: 'World Class',    minRating: 2300, color: '#ffd54f' },  // gold
];

function getRank(rating) {
    let tier = RANK_TIERS[0];
    for (const t of RANK_TIERS) {
        if (rating >= t.minRating) tier = t;
    }
    return { name: tier.name, color: tier.color, rating };
}

// Elo calculation: K=32
function calculateElo(winnerRating, loserRating) {
    const K = 32;
    const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    const expectedLoser = 1 - expectedWinner;
    const newWinner = Math.round(winnerRating + K * (1 - expectedWinner));
    const newLoser = Math.max(0, Math.round(loserRating + K * (0 - expectedLoser)));
    return { newWinner, newLoser };
}

function calculateDrawElo(rating1, rating2) {
    const K = 32;
    const expected1 = 1 / (1 + Math.pow(10, (rating2 - rating1) / 400));
    const expected2 = 1 - expected1;
    const new1 = Math.max(0, Math.round(rating1 + K * (0.5 - expected1)));
    const new2 = Math.max(0, Math.round(rating2 + K * (0.5 - expected2)));
    return { new1, new2 };
}

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
        if (!result.rows[0]) return null;
        const profile = result.rows[0];
        profile.rank = getRank(profile.rating);
        return profile;
    } catch (e) {
        console.error('Profile fetch error:', e.message);
        return null;
    }
}

async function recordGameResult(redUserId, yellowUserId, redScore, yellowScore, endCount) {
    if (!db.isAvailable()) return null;

    try {
        // Fetch current ratings for both players
        const redResult = await db.query('SELECT rating FROM users WHERE id = $1', [redUserId]);
        const yellowResult = await db.query('SELECT rating FROM users WHERE id = $1', [yellowUserId]);
        const redRating = redResult.rows[0]?.rating || 1200;
        const yellowRating = yellowResult.rows[0]?.rating || 1200;

        let winnerId = null;
        let newRedRating, newYellowRating;

        if (redScore > yellowScore) {
            winnerId = redUserId;
            const elo = calculateElo(redRating, yellowRating);
            newRedRating = elo.newWinner;
            newYellowRating = elo.newLoser;
        } else if (yellowScore > redScore) {
            winnerId = yellowUserId;
            const elo = calculateElo(yellowRating, redRating);
            newYellowRating = elo.newWinner;
            newRedRating = elo.newLoser;
        } else {
            const elo = calculateDrawElo(redRating, yellowRating);
            newRedRating = elo.new1;
            newYellowRating = elo.new2;
        }

        // Record game history
        await db.query(
            `INSERT INTO game_history (red_user_id, yellow_user_id, red_score, yellow_score, winner_id, end_count)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [redUserId, yellowUserId, redScore, yellowScore, winnerId, endCount]
        );

        // Update win/loss/draw counts AND rating
        if (winnerId === redUserId) {
            await db.query('UPDATE users SET wins = wins + 1, rating = $2 WHERE id = $1', [redUserId, newRedRating]);
            await db.query('UPDATE users SET losses = losses + 1, rating = $2 WHERE id = $1', [yellowUserId, newYellowRating]);
        } else if (winnerId === yellowUserId) {
            await db.query('UPDATE users SET wins = wins + 1, rating = $2 WHERE id = $1', [yellowUserId, newYellowRating]);
            await db.query('UPDATE users SET losses = losses + 1, rating = $2 WHERE id = $1', [redUserId, newRedRating]);
        } else {
            await db.query('UPDATE users SET draws = draws + 1, rating = $2 WHERE id = $1', [redUserId, newRedRating]);
            await db.query('UPDATE users SET draws = draws + 1, rating = $2 WHERE id = $1', [yellowUserId, newYellowRating]);
        }

        // Return updated ratings for both players
        return {
            red: { rating: newRedRating, rank: getRank(newRedRating) },
            yellow: { rating: newYellowRating, rank: getRank(newYellowRating) },
        };
    } catch (e) {
        console.error('Record game result error:', e.message);
        return null;
    }
}

module.exports = { register, login, getSession, removeSession, getProfile, recordGameResult, getRank };
