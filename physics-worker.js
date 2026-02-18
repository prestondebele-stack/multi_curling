// ============================================================
// PHYSICS WEB WORKER — runs curling physics in a background thread
// so stones keep moving even when the browser tab is hidden.
// v105: Created as part of Web Worker physics architecture.
// ============================================================
importScripts('physics.js');

const PHYSICS_DT = 1 / 240; // 240 Hz — same as game.js
const P = CurlingPhysics.POSITIONS;
const STONE_R = CurlingPhysics.STONE.radius;
const HALF_W = CurlingPhysics.SHEET.width / 2;

let stones = [];
let sweepLevel = 'none';
let simStepCount = 0;
let intervalId = null;
let deliveredStoneIndex = -1;

// Out-of-bounds check — mirrors game.js checkOutOfBounds() logic exactly.
// Deactivates stones that leave the playing area.
function checkOutOfBounds() {
    for (const stone of stones) {
        if (!stone.active) continue;

        // Past back line and moving away
        if (stone.y > P.farBackLine + STONE_R && stone.vy > 0) {
            stone.moving = false;
            stone.active = false;
            stone.fadeOut = 1.0;
        }

        // Bounced way behind the hack
        if (stone.y < P.hack - 2) {
            stone.moving = false;
            stone.active = false;
            stone.fadeOut = 1.0;
        }

        // Off the side boards
        if (Math.abs(stone.x) > HALF_W - STONE_R) {
            stone.moving = false;
            stone.active = false;
            stone.fadeOut = 1.0;
        }

        // Hog line violation: delivered stone didn't completely cross the far hog line
        // Exception: if the stone hit another stone first, it stays in play
        if (stone._isDelivered && !stone.moving && (stone.y - STONE_R) < P.farHogLine) {
            if (!stone.hasHitStone) {
                stone.moving = false;
                stone.active = false;
                stone.fadeOut = 1.0;
                stone._hogViolation = true;
            }
        }
    }
}

// Run multiple physics steps per tick to maintain 240Hz at ~60fps interval rate.
// At simSpeed 3.0: need 3.0 / (1/240) * (1/60) = 12 steps per 16ms tick.
function physicsTick() {
    const STEPS_PER_TICK = 12; // 240Hz * simSpeed 3.0 / 60fps

    for (let i = 0; i < STEPS_PER_TICK; i++) {
        const sweep = sweepLevel || 'none';
        const anyMoving = CurlingPhysics.simulate(stones, PHYSICS_DT, sweep);
        simStepCount++;
        checkOutOfBounds();

        if (!anyMoving) {
            // All stones stopped — post final state to main thread
            clearInterval(intervalId);
            intervalId = null;

            const delivered = deliveredStoneIndex >= 0 ? stones[deliveredStoneIndex] : null;
            postMessage({
                type: 'settled',
                stones: stones.map(s => ({
                    team: s.team, x: s.x, y: s.y,
                    active: s.active, moving: s.moving,
                    hasHitStone: s.hasHitStone || false,
                    fadeOut: s.fadeOut
                })),
                deliveredStone: delivered ? {
                    active: delivered.active,
                    hasHitStone: delivered.hasHitStone || false,
                    x: delivered.x, y: delivered.y,
                    hogViolation: delivered._hogViolation || false
                } : null,
                simStepCount: simStepCount
            });
            return;
        }
    }

    // Post position update for rendering (~60fps when tab is visible)
    postMessage({
        type: 'positions',
        stones: stones.map(s => ({
            team: s.team, x: s.x, y: s.y,
            vx: s.vx, vy: s.vy,
            angle: s.angle, active: s.active, moving: s.moving,
            hasHitStone: s.hasHitStone || false,
            settleTime: s.settleTime, fadeOut: s.fadeOut
        })),
        deliveredIndex: deliveredStoneIndex,
        simStepCount: simStepCount
    });
}

onmessage = function(e) {
    const msg = e.data;

    switch (msg.type) {
        case 'start':
            // Stop any existing run
            if (intervalId) clearInterval(intervalId);

            // Deep copy stone data from main thread
            stones = msg.stones.map(s => ({
                team: s.team,
                x: s.x, y: s.y,
                vx: s.vx || 0, vy: s.vy || 0,
                omega: s.omega || 0,
                angle: s.angle || 0,
                active: s.active !== false,
                moving: s.moving || false,
                hasHitStone: s.hasHitStone || false,
                settleTime: s.settleTime || 0,
                fadeOut: s.fadeOut,
                _isDelivered: false,
                _hogViolation: false
            }));

            deliveredStoneIndex = msg.deliveredStoneIndex;
            if (deliveredStoneIndex >= 0 && deliveredStoneIndex < stones.length) {
                stones[deliveredStoneIndex]._isDelivered = true;
            }

            sweepLevel = msg.sweepLevel || 'none';
            simStepCount = msg.simStepCount || 0;

            // Run physics at ~60Hz tick rate
            intervalId = setInterval(physicsTick, 16);
            break;

        case 'sweep':
            sweepLevel = msg.sweepLevel || 'none';
            break;

        case 'stop':
            if (intervalId) clearInterval(intervalId);
            intervalId = null;
            break;
    }
};
