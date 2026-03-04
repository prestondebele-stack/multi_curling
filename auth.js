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

async function register(username, password, country, securityQuestion, securityAnswer, firstName, lastName) {
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
    if (!securityQuestion || !securityAnswer || securityAnswer.trim().length === 0) {
        return { error: 'Security question and answer required' };
    }

    const hash = await bcrypt.hash(password, 10);
    const answerHash = await bcrypt.hash(securityAnswer.trim().toLowerCase(), 10);

    try {
        const result = await db.query(
            'INSERT INTO users (username, password_hash, country, security_question, security_answer_hash, first_name, last_name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, username',
            [username.toLowerCase(), hash, country || '', securityQuestion, answerHash, (firstName || '').trim().substring(0, 30), (lastName || '').trim().substring(0, 30)]
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
        if (user.password_hash === '') {
            return { error: 'This account uses Google Sign-In' };
        }
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

async function googleLogin(googleId) {
    if (!db.isAvailable()) return { error: 'Accounts not available' };
    try {
        const result = await db.query(
            'SELECT id, username FROM users WHERE google_id = $1',
            [googleId]
        );
        if (result.rows.length === 0) {
            return { needsUsername: true };
        }
        const user = result.rows[0];
        await db.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);
        const token = uuidv4();
        sessions.set(token, { userId: user.id, username: user.username });
        return { token, username: user.username, userId: user.id };
    } catch (e) {
        console.error('Google login error:', e.message);
        return { error: 'Google login failed' };
    }
}

async function googleRegister(googleId, username, country, firstName, lastName) {
    if (!db.isAvailable()) return { error: 'Accounts not available' };
    if (!username || username.length < 3 || username.length > 20) {
        return { error: 'Username must be 3-20 characters' };
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return { error: 'Username: letters, numbers, underscore only' };
    }
    try {
        const result = await db.query(
            'INSERT INTO users (username, password_hash, country, security_question, security_answer_hash, first_name, last_name, google_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, username',
            [username.toLowerCase(), '', country || '', '', '', (firstName || '').trim().substring(0, 30), (lastName || '').trim().substring(0, 30), googleId]
        );
        const user = result.rows[0];
        const token = uuidv4();
        sessions.set(token, { userId: user.id, username: user.username });
        return { token, username: user.username, userId: user.id };
    } catch (e) {
        if (e.code === '23505') {
            if (e.constraint && e.constraint.includes('google_id')) {
                return { error: 'This Google account is already registered' };
            }
            return { error: 'Username already taken' };
        }
        console.error('Google registration error:', e.message);
        return { error: 'Registration failed' };
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

async function getSecurityQuestion(username) {
    if (!db.isAvailable()) return { error: 'Accounts not available' };
    if (!username) return { error: 'Username required' };

    try {
        const result = await db.query(
            'SELECT security_question FROM users WHERE username = $1',
            [username.toLowerCase()]
        );
        if (result.rows.length === 0) {
            return { error: 'User not found' };
        }
        const question = result.rows[0].security_question;
        if (!question) {
            return { error: 'No security question set for this account' };
        }
        return { question };
    } catch (e) {
        console.error('Get security question error:', e.message);
        return { error: 'Recovery failed' };
    }
}

async function resetPassword(username, securityAnswer, newPassword) {
    if (!db.isAvailable()) return { error: 'Accounts not available' };
    if (!username || !securityAnswer || !newPassword) {
        return { error: 'All fields are required' };
    }
    if (newPassword.length < 4) {
        return { error: 'Password must be at least 4 characters' };
    }

    try {
        const result = await db.query(
            'SELECT id, security_answer_hash FROM users WHERE username = $1',
            [username.toLowerCase()]
        );
        if (result.rows.length === 0) {
            return { error: 'User not found' };
        }

        const user = result.rows[0];
        if (!user.security_answer_hash) {
            return { error: 'No security question set for this account' };
        }

        const valid = await bcrypt.compare(securityAnswer.trim().toLowerCase(), user.security_answer_hash);
        if (!valid) {
            return { error: 'Incorrect answer' };
        }

        const newHash = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

        return { success: true };
    } catch (e) {
        console.error('Reset password error:', e.message);
        return { error: 'Password reset failed' };
    }
}

async function searchUsers(query, excludeUserId) {
    if (!db.isAvailable()) return [];
    if (!query || query.trim().length === 0) return [];

    const searchTerm = query.trim().substring(0, 30);
    try {
        const result = await db.query(
            `SELECT id, username, rating FROM users
             WHERE (username ILIKE '%' || $1 || '%' OR first_name ILIKE '%' || $1 || '%' OR last_name ILIKE '%' || $1 || '%')
             AND id != $2
             ORDER BY username
             LIMIT 10`,
            [searchTerm, excludeUserId]
        );
        return result.rows.map(row => ({
            id: row.id,
            username: row.username,
            rank: getRank(row.rating),
        }));
    } catch (e) {
        console.error('Search users error:', e.message);
        return [];
    }
}

async function getLeaderboard(userId) {
    if (!db.isAvailable()) return [];
    try {
        const result = await db.query(
            `SELECT u.id, u.username, u.country, u.wins, u.losses, u.draws, u.rating,
                    f.status AS friend_status
             FROM users u
             LEFT JOIN friendships f
                ON (f.user_id = $1 AND f.friend_id = u.id)
                OR (f.friend_id = $1 AND f.user_id = u.id)
             ORDER BY u.rating DESC
             LIMIT 50`,
            [userId]
        );
        return result.rows.map(row => ({
            id: row.id,
            username: row.username,
            country: row.country,
            wins: row.wins,
            losses: row.losses,
            draws: row.draws,
            rating: row.rating,
            rank: getRank(row.rating),
            isSelf: row.id === userId,
            friendStatus: row.friend_status || null,
        }));
    } catch (e) {
        console.error('Leaderboard error:', e.message);
        return [];
    }
}

async function getGameHistory(userId, limit = 20) {
    if (!db.isAvailable()) return [];
    try {
        const result = await db.query(
            `SELECT g.id, g.red_user_id, g.yellow_user_id, g.red_score, g.yellow_score,
                    g.winner_id, g.end_count, g.played_at,
                    ru.username AS red_username, yu.username AS yellow_username,
                    ru.rating AS red_rating, yu.rating AS yellow_rating
             FROM game_history g
             JOIN users ru ON ru.id = g.red_user_id
             JOIN users yu ON yu.id = g.yellow_user_id
             WHERE g.red_user_id = $1 OR g.yellow_user_id = $1
             ORDER BY g.played_at DESC
             LIMIT $2`,
            [userId, limit]
        );
        return result.rows.map(row => {
            const wasRed = row.red_user_id === userId;
            const myScore = wasRed ? row.red_score : row.yellow_score;
            const oppScore = wasRed ? row.yellow_score : row.red_score;
            const oppUsername = wasRed ? row.yellow_username : row.red_username;
            const oppRating = wasRed ? row.yellow_rating : row.red_rating;
            let outcome = 'draw';
            if (row.winner_id === userId) outcome = 'win';
            else if (row.winner_id !== null) outcome = 'loss';
            return {
                oppUsername,
                oppRank: getRank(oppRating),
                myScore,
                oppScore,
                result: outcome,
                ends: row.end_count,
                playedAt: row.played_at,
            };
        });
    } catch (e) {
        console.error('Game history error:', e.message);
        return [];
    }
}

async function submitShot(userId, throwParams, preThrowStones, finalStones, throwerTeam) {
    if (!db.isAvailable()) return { error: 'Not available' };
    try {
        const countResult = await db.query(
            "SELECT COUNT(*) AS cnt FROM shot_submissions WHERE user_id = $1 AND week_start = DATE_TRUNC('week', NOW())::DATE",
            [userId]
        );
        if (parseInt(countResult.rows[0].cnt) >= 3) {
            return { error: 'Max 3 shots per week' };
        }
        const result = await db.query(
            "INSERT INTO shot_submissions (user_id, throw_params, pre_throw_stones, final_stones, thrower_team, week_start) VALUES ($1, $2, $3, $4, $5, DATE_TRUNC('week', NOW())::DATE) RETURNING id",
            [userId, JSON.stringify(throwParams), JSON.stringify(preThrowStones), JSON.stringify(finalStones), throwerTeam]
        );
        return { success: true, shotId: result.rows[0].id };
    } catch (e) {
        console.error('Submit shot error:', e.message);
        return { error: 'Submission failed' };
    }
}

async function getBestShots(userId) {
    if (!db.isAvailable()) return [];
    try {
        const result = await db.query(
            `SELECT s.id, s.throw_params, s.pre_throw_stones, s.final_stones, s.thrower_team,
                    s.vote_count, s.submitted_at, s.user_id,
                    u.username, u.rating,
                    EXISTS(SELECT 1 FROM shot_votes v WHERE v.shot_id = s.id AND v.user_id = $1) AS has_voted
             FROM shot_submissions s
             JOIN users u ON u.id = s.user_id
             WHERE s.week_start = DATE_TRUNC('week', NOW())::DATE
             ORDER BY s.vote_count DESC, s.submitted_at ASC
             LIMIT 50`,
            [userId]
        );
        return result.rows.map(row => ({
            id: row.id,
            username: row.username,
            rank: getRank(row.rating),
            throwParams: row.throw_params,
            preThrowStones: row.pre_throw_stones,
            finalStones: row.final_stones,
            throwerTeam: row.thrower_team,
            voteCount: row.vote_count,
            hasVoted: row.has_voted,
            isSelf: row.user_id === userId,
            submittedAt: row.submitted_at,
        }));
    } catch (e) {
        console.error('Best shots error:', e.message);
        return [];
    }
}

async function voteShot(userId, shotId) {
    if (!db.isAvailable()) return { error: 'Not available' };
    try {
        const shotResult = await db.query('SELECT user_id FROM shot_submissions WHERE id = $1', [shotId]);
        if (shotResult.rows.length === 0) return { error: 'Shot not found' };
        if (shotResult.rows[0].user_id === userId) return { error: "Can't vote on your own shot" };
        await db.query('INSERT INTO shot_votes (user_id, shot_id) VALUES ($1, $2)', [userId, shotId]);
        const updated = await db.query(
            'UPDATE shot_submissions SET vote_count = vote_count + 1 WHERE id = $1 RETURNING vote_count',
            [shotId]
        );
        return { success: true, newVoteCount: updated.rows[0].vote_count };
    } catch (e) {
        if (e.code === '23505') return { error: 'Already voted' };
        console.error('Vote shot error:', e.message);
        return { error: 'Vote failed' };
    }
}

// ============================================================
// v123: ASYNC MULTIPLAYER — persistent game state
// ============================================================

async function persistGameState(gameCode, state, redUserId, yellowUserId) {
    if (!db.isAvailable()) return;
    try {
        await db.query(`
            INSERT INTO async_games (game_code, red_user_id, yellow_user_id,
                current_team, phase, settled_stones, red_thrown, yellow_thrown,
                current_end, total_ends, red_score, yellow_score, hammer,
                end_scores, fgz_protected_stones, last_throw_params, last_pre_throw_stones,
                updated_at, last_move_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, NOW(), NOW())
            ON CONFLICT (game_code) DO UPDATE SET
                current_team = $4, phase = $5, settled_stones = $6,
                red_thrown = $7, yellow_thrown = $8, current_end = $9,
                total_ends = $10, red_score = $11, yellow_score = $12,
                hammer = $13, end_scores = $14, fgz_protected_stones = $15,
                last_throw_params = $16, last_pre_throw_stones = $17,
                updated_at = NOW(), last_move_at = NOW()
        `, [
            gameCode, redUserId, yellowUserId,
            state.currentTeam,
            state.phase === 'finished' ? 'finished' : 'playing',
            JSON.stringify(state.settledStones || []),
            state.redThrown || 0,
            state.yellowThrown || 0,
            state.currentEnd || 1,
            state.totalEnds || 4,
            state.redScore || 0,
            state.yellowScore || 0,
            state.hammer || 'yellow',
            JSON.stringify(state.endScores || []),
            JSON.stringify(state.fgzProtectedStones || []),
            state.lastThrowParams ? JSON.stringify(state.lastThrowParams) : null,
            state.lastPreThrowStones ? JSON.stringify(state.lastPreThrowStones) : null,
        ]);
    } catch (e) {
        console.error('Persist game state error:', e.message);
    }
}

async function loadGameState(gameCode) {
    if (!db.isAvailable()) return null;
    try {
        const result = await db.query(
            'SELECT * FROM async_games WHERE game_code = $1',
            [gameCode]
        );
        return result.rows.length > 0 ? result.rows[0] : null;
    } catch (e) {
        console.error('Load game state error:', e.message);
        return null;
    }
}

async function getMyGames(userId) {
    if (!db.isAvailable()) return [];
    try {
        // v127b: Also return games where this user has been invited
        const result = await db.query(`
            SELECT g.*,
                ru.username AS red_username, ru.rating AS red_rating,
                yu.username AS yellow_username, yu.rating AS yellow_rating
            FROM async_games g
            LEFT JOIN users ru ON ru.id = g.red_user_id
            LEFT JOIN users yu ON yu.id = g.yellow_user_id
            WHERE ((g.red_user_id = $1 OR g.yellow_user_id = $1)
              AND g.phase != 'finished')
              OR (g.invited_user_id = $1 AND g.phase = 'waiting')
            ORDER BY g.last_move_at DESC
        `, [userId]);

        return result.rows.map(row => {
            // v127b: Check if this is a pending invite (user is invited but hasn't joined)
            const isPendingInvite = row.invited_user_id === userId
                && row.red_user_id !== userId
                && (row.yellow_user_id === null || row.yellow_user_id !== userId);
            const isRed = row.red_user_id === userId;
            const myTeam = isPendingInvite ? null : (isRed ? 'red' : 'yellow');
            const oppUsername = isPendingInvite ? row.red_username : (isRed ? row.yellow_username : row.red_username);
            const oppRating = isPendingInvite ? row.red_rating : (isRed ? row.yellow_rating : row.red_rating);
            const isMyTurn = !isPendingInvite && row.current_team === myTeam && row.phase === 'playing';
            return {
                gameCode: row.game_code,
                myTeam,
                opponentName: oppUsername || null,
                opponentRank: oppRating ? getRank(oppRating) : null,
                isMyTurn,
                isWaiting: row.phase === 'waiting' && !isPendingInvite,
                isPendingInvite, // v127b
                invitedUsername: row.invited_username || null,
                redScore: row.red_score,
                yellowScore: row.yellow_score,
                currentEnd: row.current_end,
                totalEnds: row.total_ends,
                lastMoveAt: row.last_move_at,
            };
        });
    } catch (e) {
        console.error('Get my games error:', e.message);
        return [];
    }
}

async function createAsyncGame(gameCode, userId, totalEnds) {
    if (!db.isAvailable()) return { error: 'Not available' };
    try {
        await db.query(`
            INSERT INTO async_games (game_code, red_user_id, total_ends, phase)
            VALUES ($1, $2, $3, 'waiting')
        `, [gameCode, userId, totalEnds]);
        return { success: true, gameCode };
    } catch (e) {
        if (e.code === '23505') return { error: 'Game code already exists' };
        console.error('Create async game error:', e.message);
        return { error: 'Failed to create game' };
    }
}

async function joinAsyncGame(gameCode, userId) {
    if (!db.isAvailable()) return { error: 'Not available' };
    try {
        const result = await db.query(
            `UPDATE async_games SET yellow_user_id = $1, phase = 'playing', invited_username = NULL, invited_user_id = NULL, updated_at = NOW()
             WHERE game_code = $2 AND phase = 'waiting' AND yellow_user_id IS NULL AND red_user_id != $1
             RETURNING *`,
            [userId, gameCode]
        );
        if (result.rows.length === 0) {
            // Check why it failed
            const existing = await db.query('SELECT * FROM async_games WHERE game_code = $1', [gameCode]);
            if (existing.rows.length === 0) return { error: 'Game not found' };
            if (existing.rows[0].phase !== 'waiting') return { error: 'Game already started' };
            if (existing.rows[0].red_user_id === userId) return { error: "Can't join your own game" };
            return { error: 'Game is full' };
        }
        return { success: true, game: result.rows[0] };
    } catch (e) {
        console.error('Join async game error:', e.message);
        return { error: 'Failed to join game' };
    }
}

async function forfeitGame(gameCode, forfeitingUserId) {
    if (!db.isAvailable()) return { error: 'Not available' };
    try {
        const gameResult = await db.query(
            'SELECT * FROM async_games WHERE game_code = $1 AND phase != $2',
            [gameCode, 'finished']
        );
        if (gameResult.rows.length === 0) return { error: 'Game not found' };
        const game = gameResult.rows[0];

        // Determine winner (the one who didn't forfeit)
        const winnerId = game.red_user_id === forfeitingUserId ? game.yellow_user_id : game.red_user_id;
        const opponentId = winnerId;

        // Mark game as finished
        await db.query(
            "UPDATE async_games SET phase = 'finished', updated_at = NOW() WHERE game_code = $1",
            [gameCode]
        );

        // Record in game history (if both players exist)
        if (game.red_user_id && game.yellow_user_id) {
            // Give winner 1 point if score is 0-0
            const redScore = game.red_user_id === forfeitingUserId ? 0 : Math.max(game.red_score, 1);
            const yellowScore = game.yellow_user_id === forfeitingUserId ? 0 : Math.max(game.yellow_score, 1);
            await recordGameResult(game.red_user_id, game.yellow_user_id, redScore, yellowScore, game.current_end);
        }

        return { success: true, opponentId };
    } catch (e) {
        console.error('Forfeit game error:', e.message);
        return { error: 'Forfeit failed' };
    }
}

// v125b: Cancel a waiting game — no result, no rating impact, just delete it
async function cancelGame(gameCode, userId) {
    if (!db.isAvailable()) return { error: 'Not available' };
    try {
        const result = await db.query(
            "DELETE FROM async_games WHERE game_code = $1 AND phase = 'waiting' AND red_user_id = $2 RETURNING *",
            [gameCode, userId]
        );
        if (result.rows.length === 0) return { error: 'Game not found or already started' };
        return { success: true };
    } catch (e) {
        console.error('Cancel game error:', e.message);
        return { error: 'Cancel failed' };
    }
}

module.exports = { register, login, googleLogin, googleRegister, getSession, removeSession, getProfile, recordGameResult, getRank, getSecurityQuestion, resetPassword, searchUsers, getLeaderboard, getGameHistory, submitShot, getBestShots, voteShot, persistGameState, loadGameState, getMyGames, createAsyncGame, joinAsyncGame, forfeitGame, cancelGame };
