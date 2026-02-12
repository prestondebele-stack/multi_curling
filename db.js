// ============================================================
// DATABASE - PostgreSQL connection and schema management
// ============================================================

const { Pool } = require('pg');

let pool = null;
let dbAvailable = false;

function init() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.log('No DATABASE_URL set — running without database (no accounts)');
        return;
    }

    pool = new Pool({
        connectionString,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    pool.on('error', (err) => {
        console.error('Database pool error:', err.message);
    });
}

async function initSchema() {
    if (!pool) return;

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(20) UNIQUE NOT NULL,
                password_hash VARCHAR(72) NOT NULL,
                country VARCHAR(2) DEFAULT '',
                wins INTEGER DEFAULT 0,
                losses INTEGER DEFAULT 0,
                draws INTEGER DEFAULT 0,
                rating INTEGER DEFAULT 1200,
                created_at TIMESTAMP DEFAULT NOW(),
                last_seen TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS friendships (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                friend_id INTEGER REFERENCES users(id),
                status VARCHAR(10) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user_id, friend_id)
            );

            CREATE TABLE IF NOT EXISTS game_history (
                id SERIAL PRIMARY KEY,
                red_user_id INTEGER REFERENCES users(id),
                yellow_user_id INTEGER REFERENCES users(id),
                red_score INTEGER,
                yellow_score INTEGER,
                winner_id INTEGER REFERENCES users(id),
                end_count INTEGER,
                played_at TIMESTAMP DEFAULT NOW()
            );
        `);
        // Add security question columns (safe migration for existing DBs)
        await pool.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS security_question VARCHAR(100) DEFAULT '';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS security_answer_hash VARCHAR(72) DEFAULT '';
        `);

        // Push notification subscriptions
        await pool.query(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                endpoint TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(endpoint)
            );
        `);

        dbAvailable = true;
        console.log('Database schema initialized');
    } catch (err) {
        console.error('Database schema initialization failed:', err.message);
    }
}

function query(text, params) {
    if (!pool) return Promise.reject(new Error('No database'));
    return pool.query(text, params);
}

function isAvailable() {
    return dbAvailable;
}

module.exports = { init, initSchema, query, isAvailable };
