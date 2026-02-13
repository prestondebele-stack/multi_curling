// ============================================================
// REALISTIC CURLING PHYSICS ENGINE
// Based on published research from Nature Scientific Reports,
// World Curling Federation specifications, and peer-reviewed
// curling dynamics papers.
// ============================================================

const CurlingPhysics = (() => {
    // --------------------------------------------------------
    // REAL DIMENSIONS (all in meters)
    // World Curling Federation official specifications
    // --------------------------------------------------------
    const SHEET = {
        length: 45.72,          // 150 ft total sheet length
        width: 4.75,            // 15 ft 7 in maximum width
        teeToTee: 34.75,        // 114 ft between tee lines
        hogToHog: 24.94,        // ~72 ft timing distance
        teeToHog: 6.40,         // 21 ft tee line to near hog
        teeToBack: 1.83,        // 6 ft tee line to back line
        hackToTee: 3.66,        // 12 ft hack to tee line
    };

    // House ring radii (meters)
    const HOUSE = {
        button: 0.0635,         // 2.5 in radius (5 in diameter)
        fourFoot: 0.610,        // 2 ft radius (4 ft diameter)
        eightFoot: 1.220,       // 4 ft radius (8 ft diameter)
        twelveFoot: 1.830,      // 6 ft radius (12 ft diameter)
    };

    // Stone specifications
    const STONE = {
        mass: 19.1,             // kg (typical ~42 lb)
        radius: 0.1455,         // ~291 mm diameter / 2
        height: 0.130,          // ~130 mm
        runningBandRadius: 0.065, // ~130 mm diameter / 2
        runningBandWidth: 0.006,  // ~6 mm
        // Moment of inertia: approximated as hollow cylinder at running band
        // I = m * r_rb^2  (simplified ring of mass at running band radius)
        // More accurate: I ≈ 0.5 * m * (r_outer^2 + r_rb^2) for annular shape
        get momentOfInertia() {
            return 0.5 * this.mass * (this.radius * this.radius + this.runningBandRadius * this.runningBandRadius);
        }
    };

    // Friction model parameters
    // Based on velocity-dependent friction from published measurements
    const FRICTION = {
        muStatic: 0.016,         // static/low-speed friction
        muKinetic: 0.008,        // high-speed kinetic friction
        velocityTransition: 0.3, // m/s - transition velocity between regimes
        // Velocity-dependent friction: mu(v) = muKinetic + (muStatic - muKinetic) * exp(-v/vt)
        // This models the three friction regimes: wet, mixed, dry
        getMu(speed) {
            if (speed < 0.001) return this.muStatic;
            return this.muKinetic + (this.muStatic - this.muKinetic) *
                Math.exp(-speed / this.velocityTransition);
        }
    };

    // Curl model parameters
    // Based on asymmetric friction theory and scratch-guide mechanism
    const CURL = {
        // Maximum lateral curl over full travel: ~1.0-1.5 m
        // This is modeled as a lateral force proportional to angular velocity
        // and inversely related to linear speed (curl increases as stone slows)
        //
        // The curl force arises from differential friction between the
        // fast side and slow side of the running band on pebbled ice.
        //
        // F_curl = curlCoefficient * angularVelocity * frictionForce / speed
        //
        // Direction: IN the direction of rotation (the key curling anomaly)
        // - Clockwise spin -> curls right
        // - Counter-clockwise spin -> curls left
        // Tuned to produce ~1.0-1.5m lateral displacement over full draw-weight travel.
        // A stone aimed at the edge of the house should curl to the tee line or just past,
        // never all the way across the house (~3.6m).
        curlCoefficient: 0.38,

        // Curl is stronger at lower speeds (stone curls more near the house)
        // and with fewer rotations (less spin = more curl per revolution)
        getForce(angularVelocity, linearSpeed, frictionForce) {
            if (linearSpeed < 0.01) return 0;

            const absOmega = Math.abs(angularVelocity);

            // Speed factor: curl increases as stone slows, but caps at low speed
            // to prevent a sharp hook in the last couple feet.
            // At high speeds (peel/takeout), v² makes curl negligible.
            // At low speeds, clamped so it doesn't spike near stopping.
            const rawFactor = 1.0 / (0.15 + linearSpeed * linearSpeed);
            const speedFactor = Math.min(rawFactor, 1.5);

            // Spin efficiency: ~2.5-4 rotations is optimal
            // Less spin = less curl, more spin = diminishing returns
            let spinEfficiency;
            if (absOmega < 2.5) {
                spinEfficiency = absOmega / 2.5; // linear ramp up
            } else if (absOmega < 5.0) {
                spinEfficiency = 1.0; // plateau (sweet spot)
            } else {
                spinEfficiency = 5.0 / absOmega; // diminishing
            }

            return this.curlCoefficient * spinEfficiency * frictionForce * speedFactor;
        }
    };

    // Collision parameters
    const COLLISION = {
        restitution: 0.80,      // coefficient of restitution for granite-on-granite
        // Minimum separation distance to prevent overlap (slightly > 2*radius)
        get minSep() { return STONE.radius * 2.0; }
    };

    // Sweeping parameters
    const SWEEPING = {
        // Sweeping reduces friction by creating a water film
        // Light sweep: ~15% friction reduction
        // Hard sweep: ~30% friction reduction
        frictionReduction: {
            none: 1.0,
            light: 0.85,
            hard: 0.70
        },
        // Sweeping also reduces curl
        curlReduction: {
            none: 1.0,
            light: 0.75,
            hard: 0.50
        }
    };

    // Delivery speed mapping (weight slider 0-100 -> m/s)
    // Guard: ~2.0 m/s, Draw: ~2.7 m/s, Takeout: ~3.5 m/s, Peel: ~3.8 m/s
    function weightToSpeed(weightPercent) {
        const minSpeed = 2.0;  // guard weight (must reach past hog line)
        const maxSpeed = 3.8;  // hard peel
        // Non-linear: more precision at draw weight range
        const t = weightPercent / 100;
        return minSpeed + (maxSpeed - minSpeed) * (t * t * 0.3 + t * 0.7);
    }

    function weightLabel(weightPercent) {
        if (weightPercent < 15) return 'Guard';
        if (weightPercent < 35) return 'Draw';
        if (weightPercent < 55) return 'Hack';
        if (weightPercent < 75) return 'Takeout';
        return 'Peel';
    }

    // Convert desired total rotations over travel distance to angular velocity
    // totalRotations: full revolutions from hog to house (~28m)
    // linearSpeed: delivery speed in m/s
    function rotationsToAngularVelocity(totalRotations, linearSpeed) {
        // Distance from delivery hog line to far tee: ~28m
        const travelDistance = 28;
        const travelTime = travelDistance / linearSpeed;
        // omega = 2*pi*rotations / time
        return (2 * Math.PI * totalRotations) / travelTime;
    }

    // --------------------------------------------------------
    // PHYSICS SIMULATION STEP
    // --------------------------------------------------------
    function simulate(stones, dt, sweepLevel) {
        const g = 9.81;
        const sweepKey = sweepLevel || 'none';
        const frictionMult = SWEEPING.frictionReduction[sweepKey];
        const curlMult = SWEEPING.curlReduction[sweepKey];

        let anyMoving = false;

        for (const stone of stones) {
            if (!stone.active) continue;

            const speed = Math.sqrt(stone.vx * stone.vx + stone.vy * stone.vy);

            if (speed < 0.005) {
                // Trigger settle animation if stone was previously moving
                if (stone.moving && !stone.settleTime) {
                    stone.settleTime = 150; // ms for settle bounce
                }
                stone.vx = 0;
                stone.vy = 0;
                stone.omega = 0;
                stone.moving = false;
                continue;
            }

            stone.moving = true;
            anyMoving = true;

            // Velocity-dependent friction coefficient
            const mu = FRICTION.getMu(speed) * frictionMult;

            // Friction deceleration (opposing motion)
            const frictionForce = mu * STONE.mass * g;
            const frictionDecel = mu * g;

            if (speed > 0.005) {
                const fx = -(stone.vx / speed) * frictionDecel;
                const fy = -(stone.vy / speed) * frictionDecel;

                // Curl force (perpendicular to motion, in direction of spin)
                let curlFx = 0, curlFy = 0;
                if (Math.abs(stone.omega) > 0.05) {
                    const curlMagnitude = CURL.getForce(stone.omega, speed, frictionForce) * curlMult;
                    // Perpendicular to velocity, direction matches spin sign
                    // For stone moving in +y direction (toward house):
                    //   positive omega (CW viewed from top) -> curl in +x (right)
                    //   negative omega (CCW) -> curl in -x (left)
                    // Right perpendicular of (vx, vy) is (vy, -vx)
                    const perpX = stone.vy / speed;
                    const perpY = -stone.vx / speed;
                    const sign = stone.omega > 0 ? 1 : -1;
                    curlFx = sign * perpX * curlMagnitude / STONE.mass;
                    curlFy = sign * perpY * curlMagnitude / STONE.mass;
                }

                // Apply friction (deceleration along direction of motion)
                const oldVx = stone.vx;
                const oldVy = stone.vy;
                stone.vx += fx * dt;
                stone.vy += fy * dt;

                // Check if friction reversed the velocity direction (overshooting to zero)
                if (stone.vx * oldVx + stone.vy * oldVy < 0) {
                    stone.vx = 0;
                    stone.vy = 0;
                }

                // Apply curl force separately (lateral, doesn't fight friction)
                stone.vx += curlFx * dt;
                stone.vy += curlFy * dt;
            }

            // Angular deceleration (spin friction)
            // The running band is extremely narrow (5-8mm) on pebbled ice,
            // so spin friction torque is very small. In real curling, a stone
            // maintains most of its rotation throughout its entire travel.
            // A stone with 2.5 rotations over ~15 seconds barely loses spin.
            // We model this as a very gentle exponential decay.
            if (Math.abs(stone.omega) > 0.01) {
                // Spin decays slowly - approximately 20% loss over full travel
                // This matches observations that stones maintain rotation
                const spinDecayRate = 0.015; // per second decay fraction
                const omegaDecel = Math.abs(stone.omega) * spinDecayRate * dt;
                if (Math.abs(stone.omega) <= omegaDecel) {
                    stone.omega = 0;
                } else {
                    stone.omega -= Math.sign(stone.omega) * omegaDecel;
                }
            }

            // Update position
            stone.x += stone.vx * dt;
            stone.y += stone.vy * dt;

            // Update rotation angle (for visual)
            stone.angle += stone.omega * dt;
        }

        // Stone-to-stone collisions
        for (let i = 0; i < stones.length; i++) {
            if (!stones[i].active) continue;
            for (let j = i + 1; j < stones.length; j++) {
                if (!stones[j].active) continue;
                resolveCollision(stones[i], stones[j]);
            }
        }

        // Boundary checks
        for (const stone of stones) {
            if (!stone.active) continue;
            checkBounds(stone);
        }

        return anyMoving;
    }

    function resolveCollision(a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = COLLISION.minSep;

        if (dist >= minDist || dist < 0.001) return;

        // Normal vector (from a to b)
        const nx = dx / dist;
        const ny = dy / dist;

        // Relative velocity along normal
        const dvx = a.vx - b.vx;
        const dvy = a.vy - b.vy;
        const dvn = dvx * nx + dvy * ny;

        // Only resolve if stones are approaching
        if (dvn <= 0) return;

        // Impulse magnitude (equal mass)
        const e = COLLISION.restitution;
        const j = (1 + e) * dvn / 2; // equal mass simplification

        // Apply impulse
        a.vx -= j * nx;
        a.vy -= j * ny;
        b.vx += j * nx;
        b.vy += j * ny;

        // Transfer some angular momentum on oblique hits
        // Tangent component of relative velocity
        const dvt = dvx * (-ny) + dvy * nx;
        const spinTransfer = 0.15; // fraction of tangential impulse transferred to spin
        a.omega += spinTransfer * dvt / STONE.radius;
        b.omega -= spinTransfer * dvt / STONE.radius;

        // Separate stones to prevent overlap
        const overlap = minDist - dist;
        const sep = overlap / 2 + 0.001;
        a.x -= nx * sep;
        a.y -= ny * sep;
        b.x += nx * sep;
        b.y += ny * sep;

        // Mark both as moving
        a.moving = true;
        b.moving = true;

        // Track that these stones have been involved in a collision
        // (used for hog-line exception: stones that hit another stone stay in play)
        a.hasHitStone = true;
        b.hasHitStone = true;
    }

    // Playing area bounds check
    // Stones out of bounds (past back line or off sides) are removed
    function checkBounds(stone) {
        // These will be set by the game based on coordinate system
        // The game translates real meters to canvas pixels
        // Bounds are checked in real coordinates
    }

    // --------------------------------------------------------
    // COORDINATE SYSTEM
    // --------------------------------------------------------
    // The game uses a coordinate system where:
    //   x = 0 is the center line of the sheet
    //   y = 0 is the delivery hack position
    //   y increases toward the far end
    //
    // Key y positions (from hack = 0):
    //   Delivery hog line: hackToTee + teeToHog - hogToHog...
    //   Let's define based on far-end house:
    //
    //   Far end tee line: y_tee = hackToTee + teeToTee = 3.66 + 34.75 = 38.41
    //   Far end hog line: y_hog = y_tee - teeToHog = 38.41 - 6.40 = 32.01
    //   Far end back line: y_back = y_tee + teeToBack = 38.41 + 1.83 = 40.24
    //   Near hog line: y_nearHog = y_hog - hogToHog = 32.01 - 24.94 = 7.07

    const POSITIONS = {
        hack: 0,
        nearHogLine: 7.07,
        farHogLine: 32.01,
        farTeeLine: 38.41,
        farBackLine: 40.24,
        sheetEnd: 45.72,
        halfWidth: SHEET.width / 2,
    };

    // --------------------------------------------------------
    // TRAJECTORY PREDICTION (for aim preview)
    // Simplified single-stone physics — no collisions, no sweeping
    // --------------------------------------------------------
    function simulateTrajectory(aimDeg, weightPct, spinDir, spinAmount) {
        const speed = weightToSpeed(weightPct);
        const aimRad = aimDeg * Math.PI / 180;
        const omega = rotationsToAngularVelocity(spinAmount, speed) * spinDir;
        const dt = 0.016; // coarser timestep for preview (60 Hz)
        const maxSteps = 600;
        const g = 9.81;

        let x = 0, y = POSITIONS.hack + 1.0;
        let vx = speed * Math.sin(aimRad);
        let vy = speed * Math.cos(aimRad);
        let w = omega;

        const points = [{ x, y }];

        for (let i = 0; i < maxSteps; i++) {
            const spd = Math.sqrt(vx * vx + vy * vy);
            if (spd < 0.01) break;

            // Friction
            const mu = FRICTION.getMu(spd);
            const frictionForce = mu * STONE.mass * g;
            const frictionAccel = frictionForce / STONE.mass;
            const ax = -(vx / spd) * frictionAccel;
            const ay = -(vy / spd) * frictionAccel;

            // Curl
            let curlAx = 0, curlAy = 0;
            if (Math.abs(w) > 0.05) {
                const curlForce = CURL.getForce(w, spd, frictionForce);
                const perpX = vy / spd;
                const perpY = -vx / spd;
                const sign = w > 0 ? 1 : -1;
                curlAx = sign * perpX * curlForce / STONE.mass;
                curlAy = sign * perpY * curlForce / STONE.mass;
            }

            vx += (ax + curlAx) * dt;
            vy += (ay + curlAy) * dt;
            x += vx * dt;
            y += vy * dt;

            // Spin decay
            if (Math.abs(w) > 0.01) {
                w -= Math.sign(w) * Math.abs(w) * 0.015 * dt;
            }

            // Record every 5th point
            if (i % 5 === 0) {
                points.push({ x, y });
            }

            // Stop if past back line
            if (y > POSITIONS.farBackLine + 2) break;
        }

        return points;
    }

    return {
        SHEET,
        HOUSE,
        STONE,
        FRICTION,
        CURL,
        COLLISION,
        SWEEPING,
        POSITIONS,
        simulate,
        resolveCollision,
        weightToSpeed,
        weightLabel,
        rotationsToAngularVelocity,
        simulateTrajectory,
    };
})();
