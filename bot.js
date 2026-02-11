// ============================================================
// CURLING AI BOT — Realistic curling strategy engine
// Plays as Yellow team with hammer/no-hammer decision trees
// ============================================================

const CurlingBot = (() => {
    // --------------------------------------------------------
    // CONFIGURATION
    // --------------------------------------------------------
    const DIFFICULTY = {
        easy: { aimError: 0.8, weightError: 10, perfectRate: 0.40, label: 'Easy' },
        medium: { aimError: 0.4, weightError: 5, perfectRate: 0.60, label: 'Medium' },
        hard: { aimError: 0.2, weightError: 3, perfectRate: 0.75, label: 'Hard' },
    };

    let difficulty = 'medium';
    let isThinking = false;

    // Shot type weight ranges (slider 0-100)
    const WEIGHT = {
        guard: { min: 5, max: 12 },
        draw: { min: 28, max: 42 },
        control: { min: 43, max: 55 },
        takeout: { min: 60, max: 75 },
        peel: { min: 80, max: 100 },
    };

    // --------------------------------------------------------
    // UTILITY
    // --------------------------------------------------------
    function rand(min, max) {
        return min + Math.random() * (max - min);
    }

    function gaussRandom() {
        // Box-Muller transform for normally distributed random
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }

    function distTo(x1, y1, x2, y2) {
        return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
    }

    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    // --------------------------------------------------------
    // BOARD EVALUATION
    // --------------------------------------------------------
    function evaluateBoard(bridge) {
        const gs = bridge.gameState;
        const P = CurlingPhysics.POSITIONS;
        const H = CurlingPhysics.HOUSE;
        const SR = CurlingPhysics.STONE.radius;

        const teeX = 0;
        const teeY = P.farTeeLine;
        const activeStones = gs.stones.filter(s => s.active);

        // Categorize stones
        const botStones = activeStones.filter(s => s.team === 'yellow');
        const oppStones = activeStones.filter(s => s.team === 'red');

        // Stones in house (within 12-foot)
        const botInHouse = botStones.filter(s => distTo(s.x, s.y, teeX, teeY) <= H.twelveFoot + SR);
        const oppInHouse = oppStones.filter(s => distTo(s.x, s.y, teeX, teeY) <= H.twelveFoot + SR);

        // All sorted by distance to tee
        const allSorted = activeStones.map(s => ({
            stone: s,
            dist: distTo(s.x, s.y, teeX, teeY),
            team: s.team,
        })).sort((a, b) => a.dist - b.dist);

        const inHouseSorted = allSorted.filter(s => s.dist <= H.twelveFoot + SR);

        // Shot stone (closest to button)
        let shotStone = null;
        let shotTeam = null;
        if (inHouseSorted.length > 0) {
            shotStone = inHouseSorted[0];
            shotTeam = shotStone.team;
        }

        // How many points each team is currently scoring
        let botScoring = 0;
        let oppScoring = 0;
        if (shotTeam) {
            const otherDist = inHouseSorted.find(s => s.team !== shotTeam);
            const otherD = otherDist ? otherDist.dist : Infinity;
            for (const s of inHouseSorted) {
                if (s.team === shotTeam && s.dist < otherD) {
                    if (shotTeam === 'yellow') botScoring++;
                    else oppScoring++;
                }
            }
        }

        // Guards (in play area between hog and house, not in 12-foot)
        const isGuard = (s) => {
            const d = distTo(s.x, s.y, teeX, teeY);
            return s.y >= P.farHogLine && d > H.twelveFoot + SR;
        };

        const botGuards = botStones.filter(isGuard);
        const oppGuards = oppStones.filter(isGuard);

        // Center guards (within ~0.5m of center line)
        const centerGuards = activeStones.filter(s =>
            isGuard(s) && Math.abs(s.x) < 0.5
        );

        // Is center line blocked? (any stone between hog and house on center)
        const centerBlocked = centerGuards.length > 0;

        // FGZ status
        const totalThrown = gs.redThrown + gs.yellowThrown;
        const fgzActive = totalThrown < 5;

        // Bot's stone number this end (1-8)
        const botStoneNum = gs.yellowThrown + 1;

        // Score differential (positive = bot ahead)
        const scoreDiff = gs.yellowScore - gs.redScore;

        // Has hammer?
        const hasHammer = gs.hammer === 'yellow';

        return {
            activeStones,
            botStones,
            oppStones,
            botInHouse,
            oppInHouse,
            inHouseSorted,
            shotStone,
            shotTeam,
            botScoring,
            oppScoring,
            botGuards,
            oppGuards,
            centerGuards,
            centerBlocked,
            fgzActive,
            botStoneNum,
            scoreDiff,
            hasHammer,
            teeX,
            teeY,
            totalThrown,
        };
    }

    // --------------------------------------------------------
    // SHOT SELECTION
    // --------------------------------------------------------
    function selectShot(board) {
        if (board.hasHammer) {
            return selectShotWithHammer(board);
        } else {
            return selectShotWithoutHammer(board);
        }
    }

    // --- WITHOUT HAMMER (defensive — protect position, build guards) ---
    function selectShotWithoutHammer(board) {
        const n = board.botStoneNum;
        const P = CurlingPhysics.POSITIONS;
        const H = CurlingPhysics.HOUSE;

        // Score modifier: if behind, play more aggressively
        const aggressive = board.scoreDiff < -2;

        // EARLY STONES (1-2): Center guards
        if (n <= 2) {
            // Place center guards in front of the house
            if (!board.centerBlocked || board.centerGuards.length < 2) {
                return makeCenterGuard(board, n);
            }
            // If center already guarded, draw behind guards
            return makeDrawBehindGuard(board);
        }

        // MID STONES (3-4): Come-arounds behind guards, or replace removed guards
        if (n <= 4) {
            if (board.centerGuards.filter(s => s.team === 'yellow').length === 0 && !board.fgzActive) {
                // Our guards were removed and FGZ is off — replace them
                return makeCenterGuard(board, n);
            }
            // If opponent has shot stone, try to draw around guard
            if (board.shotTeam === 'red') {
                return makeDrawBehindGuard(board);
            }
            // We have shot — add another stone to the house
            return makeDrawToHouse(board);
        }

        // LATE STONES (5-6): Takeout if opponent has shot, guard own shot
        if (n <= 6) {
            if (board.oppScoring > 0) {
                return makeTakeout(board);
            }
            if (board.botScoring > 0 && aggressive) {
                return makeGuardOwnStone(board);
            }
            return makeDrawToHouse(board);
        }

        // FINAL STONES (7-8): Protect or last-ditch takeout
        if (board.oppScoring >= 2) {
            return makeTakeout(board);
        }
        if (board.oppScoring > 0) {
            return makeTakeout(board); // opponent scoring 1, still worth hitting
        }
        if (board.botScoring > 0) {
            return makeDrawToHouse(board); // add insurance stone
        }
        return makeDrawToHouse(board); // nothing to hit — draw for a point
    }

    // --- WITH HAMMER (offensive — keep center open, draw for multiple) ---
    function selectShotWithHammer(board) {
        const n = board.botStoneNum;
        const P = CurlingPhysics.POSITIONS;

        // If well ahead, play to blank the end (keep hammer)
        const playBlank = board.scoreDiff >= 3 && n >= 6;

        // EARLY STONES (1-2): Corner guards to keep center open
        if (n <= 2) {
            if (board.centerGuards.filter(s => s.team === 'red').length > 0 && !board.fgzActive) {
                // Opponent put up center guard — peel it
                return makePeel(board);
            }
            return makeCornerGuard(board);
        }

        // MID STONES (3-4): Peel opponent center guards, draw behind own guards
        if (n <= 4) {
            if (board.centerGuards.filter(s => s.team === 'red').length > 0 && !board.fgzActive) {
                return makePeel(board);
            }
            if (board.oppScoring > 0) {
                return makeTakeout(board);
            }
            return makeDrawToHouse(board);
        }

        // LATE STONES (5-6): Hit-and-stay, position scoring stones
        if (n <= 6) {
            if (board.oppScoring > 0) {
                return makeTakeout(board);
            }
            return makeDrawToHouse(board);
        }

        // FINAL STONES (7-8): Draw for 2+ or blank end
        if (playBlank) {
            return makeBlank(board);
        }
        if (board.oppScoring > board.botScoring) {
            return makeTakeout(board);
        }
        // Draw to score — aim for button area
        return makeDrawToButton(board);
    }

    // --------------------------------------------------------
    // SHOT CONSTRUCTORS
    // --------------------------------------------------------
    // Each returns { targetX, targetY, weight, spin, spinAmount, description }

    function makeCenterGuard(board) {
        // Place a guard on the center line between hog and house
        const P = CurlingPhysics.POSITIONS;
        const guardY = P.farHogLine + rand(1.5, 3.5);
        const guardX = rand(-0.3, 0.3); // near center
        return {
            targetX: guardX,
            targetY: guardY,
            weight: rand(WEIGHT.guard.min, WEIGHT.guard.max),
            spin: Math.random() > 0.5 ? 1 : -1,
            spinAmount: rand(2.0, 3.5),
            description: 'Center Guard',
        };
    }

    function makeCornerGuard(board) {
        // Place a guard off to one side (corner guard)
        const side = Math.random() > 0.5 ? 1 : -1;
        const P = CurlingPhysics.POSITIONS;
        const guardY = P.farHogLine + rand(2.0, 4.0);
        const guardX = side * rand(0.8, 1.5);
        return {
            targetX: guardX,
            targetY: guardY,
            weight: rand(WEIGHT.guard.min, WEIGHT.guard.max),
            spin: -side, // curl toward center
            spinAmount: rand(2.5, 3.5),
            description: 'Corner Guard',
        };
    }

    function makeDrawBehindGuard(board) {
        // Draw behind a friendly guard into the house
        const P = CurlingPhysics.POSITIONS;
        const H = CurlingPhysics.HOUSE;

        // Find a friendly guard to hide behind
        const myGuards = board.botGuards;
        if (myGuards.length > 0) {
            const guard = myGuards[Math.floor(Math.random() * myGuards.length)];
            // Target: behind the guard, inside the 8-foot
            const targetX = guard.x + rand(-0.2, 0.2);
            const targetY = P.farTeeLine + rand(-0.5, 0.5);
            return {
                targetX,
                targetY,
                weight: rand(WEIGHT.draw.min, WEIGHT.draw.max),
                spin: targetX > 0 ? -1 : 1, // curl around guard
                spinAmount: rand(2.5, 4.0),
                description: 'Come-Around',
            };
        }

        // No guard — just draw to house
        return makeDrawToHouse(board);
    }

    function makeDrawToHouse(board) {
        // Draw to a good scoring position in the house
        const P = CurlingPhysics.POSITIONS;
        const H = CurlingPhysics.HOUSE;

        // Aim for 4-foot or 8-foot area, slightly off center
        const side = Math.random() > 0.5 ? 1 : -1;
        const targetX = side * rand(0.1, 0.8);
        const targetY = P.farTeeLine + rand(-0.6, 0.6);

        return {
            targetX,
            targetY,
            weight: rand(WEIGHT.draw.min, WEIGHT.draw.max),
            spin: -side,
            spinAmount: rand(2.5, 3.5),
            description: 'Draw',
        };
    }

    function makeDrawToButton(board) {
        // Precise draw aimed at the button for scoring
        const P = CurlingPhysics.POSITIONS;
        return {
            targetX: rand(-0.15, 0.15),
            targetY: P.farTeeLine + rand(-0.15, 0.15),
            weight: rand(WEIGHT.draw.min, WEIGHT.draw.max),
            spin: Math.random() > 0.5 ? 1 : -1,
            spinAmount: rand(2.5, 3.5),
            description: 'Draw to Button',
        };
    }

    function makeGuardOwnStone(board) {
        // Place a guard in front of our best scoring stone
        const P = CurlingPhysics.POSITIONS;
        const scoring = board.inHouseSorted.filter(s => s.team === 'yellow');
        if (scoring.length > 0) {
            const best = scoring[0].stone;
            const guardY = best.y - rand(2.0, 4.0);
            return {
                targetX: best.x + rand(-0.2, 0.2),
                targetY: Math.max(P.farHogLine + 0.5, guardY),
                weight: rand(WEIGHT.guard.min, WEIGHT.guard.max),
                spin: best.x > 0 ? -1 : 1,
                spinAmount: rand(2.5, 3.5),
                description: 'Guard Shot Stone',
            };
        }
        return makeCenterGuard(board);
    }

    function makeTakeout(board) {
        // Hit the opponent's best stone (closest to button)
        const P = CurlingPhysics.POSITIONS;
        const oppInHouse = board.inHouseSorted.filter(s => s.team === 'red');
        if (oppInHouse.length > 0) {
            const target = oppInHouse[0].stone;
            return {
                targetX: target.x,
                targetY: target.y,
                weight: rand(WEIGHT.takeout.min, WEIGHT.takeout.max),
                spin: target.x > 0 ? -1 : 1,
                spinAmount: rand(2.0, 3.0),
                description: 'Takeout',
            };
        }

        // No opponent stone in house — only hit guards if they're protecting house stones
        if (board.oppGuards.length > 0 && board.oppInHouse.length > 0) {
            const guard = board.oppGuards[0];
            return {
                targetX: guard.x,
                targetY: guard.y,
                weight: rand(WEIGHT.takeout.min, WEIGHT.takeout.max),
                spin: guard.x > 0 ? -1 : 1,
                spinAmount: rand(2.0, 3.0),
                description: 'Takeout Guard',
            };
        }

        // Nothing to hit — draw instead
        return makeDrawToHouse(board);
    }

    function makePeel(board) {
        // Hit and remove opponent's center guard with lots of weight
        const centerOppGuards = board.centerGuards.filter(s => s.team === 'red');
        if (centerOppGuards.length > 0) {
            const target = centerOppGuards[0];
            return {
                targetX: target.x,
                targetY: target.y,
                weight: rand(WEIGHT.peel.min, WEIGHT.peel.max),
                spin: target.x > 0 ? -1 : 1,
                spinAmount: rand(2.0, 2.5),
                description: 'Peel',
            };
        }
        // Nothing to peel — draw instead
        return makeDrawToHouse(board);
    }

    function makeBlank(board) {
        // Throw through the house to blank the end (keep hammer)
        const P = CurlingPhysics.POSITIONS;
        // If opponent has stones in house, takeout first
        const oppInHouse = board.inHouseSorted.filter(s => s.team === 'red');
        if (oppInHouse.length > 0) {
            return makeTakeout(board);
        }
        // Otherwise throw heavy through the house
        return {
            targetX: rand(-0.2, 0.2),
            targetY: P.farTeeLine,
            weight: rand(WEIGHT.peel.min, WEIGHT.peel.max),
            spin: Math.random() > 0.5 ? 1 : -1,
            spinAmount: rand(2.0, 2.5),
            description: 'Throw-Through (Blank)',
        };
    }

    // --------------------------------------------------------
    // AIM CALCULATION
    // --------------------------------------------------------
    // Convert a target position to an aim angle and weight setting
    function calculateAim(shot) {
        const P = CurlingPhysics.POSITIONS;
        const startX = 0;
        const startY = P.hack + 1.0;

        const dx = shot.targetX - startX;
        const dy = shot.targetY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Base aim angle (straight line to target)
        let aimDeg = Math.atan2(dx, dy) * (180 / Math.PI);

        // For draw shots (low weight), offset aim to account for curl
        // The stone will curl into the target, so we aim to the opposite side
        if (shot.weight < WEIGHT.control.min) {
            // Estimate curl amount based on weight and spin
            const speed = CurlingPhysics.weightToSpeed(shot.weight);
            // Empirical: at draw weight with 3 rotations, curl is roughly 0.8-1.2m
            // Heavier = less curl, lighter = more curl
            const curlEstimate = 0.5 * (3.0 / speed) * (shot.spinAmount / 3.0);
            const curlOffsetDeg = Math.atan2(curlEstimate, dist) * (180 / Math.PI);

            // Curl direction: spin=1 (CW) curls right (+x), spin=-1 (CCW) curls left (-x)
            // So aim to the OPPOSITE side of where curl will go
            aimDeg -= shot.spin * curlOffsetDeg;
        }

        // Clamp aim to slider range
        aimDeg = clamp(aimDeg, -5, 5);

        return aimDeg;
    }

    // --------------------------------------------------------
    // ERROR / IMPERFECTION
    // --------------------------------------------------------
    function applyError(aimDeg, weightPct, spinAmount) {
        const d = DIFFICULTY[difficulty];

        // Chance of a perfect shot
        if (Math.random() < d.perfectRate) {
            // Small micro-error even on "perfect" shots
            return {
                aim: aimDeg + gaussRandom() * d.aimError * 0.15,
                weight: weightPct + gaussRandom() * d.weightError * 0.15,
                spinAmount: spinAmount,
            };
        }

        // Normal error
        return {
            aim: aimDeg + gaussRandom() * d.aimError,
            weight: weightPct + gaussRandom() * d.weightError,
            spinAmount: spinAmount + gaussRandom() * 0.3,
        };
    }

    // --------------------------------------------------------
    // SLIDER ANIMATION
    // --------------------------------------------------------
    function animateSliders(aim, weight, spin, spinAmount, callback) {
        const aimSlider = document.getElementById('aim-slider');
        const weightSlider = document.getElementById('weight-slider');
        const spinAmountSlider = document.getElementById('spin-amount-slider');

        const startAim = parseFloat(aimSlider.value);
        const startWeight = parseFloat(weightSlider.value);
        const startSpin = parseFloat(spinAmountSlider.value);

        const targetAim = clamp(aim, -5, 5);
        const targetWeight = clamp(weight, 0, 100);
        const targetSpin = clamp(spinAmount, 2, 5);

        // Set spin direction immediately
        if (spin >= 0) {
            document.getElementById('spin-cw').classList.add('active');
            document.getElementById('spin-ccw').classList.remove('active');
            document.getElementById('spin-value').textContent = 'In-turn';
        } else {
            document.getElementById('spin-ccw').classList.add('active');
            document.getElementById('spin-cw').classList.remove('active');
            document.getElementById('spin-value').textContent = 'Out-turn';
        }

        const duration = 600;
        const startTime = performance.now();

        function tick(now) {
            const t = Math.min(1, (now - startTime) / duration);
            // Ease in-out
            const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

            const curAim = startAim + (targetAim - startAim) * ease;
            const curWeight = startWeight + (targetWeight - startWeight) * ease;
            const curSpin = startSpin + (targetSpin - startSpin) * ease;

            aimSlider.value = curAim;
            weightSlider.value = curWeight;
            spinAmountSlider.value = curSpin;

            // Update display labels
            document.getElementById('aim-value').textContent = curAim.toFixed(1) + '°';
            document.getElementById('weight-value').textContent = CurlingPhysics.weightLabel(curWeight);
            document.getElementById('spin-amount-value').textContent = curSpin.toFixed(1);

            if (t < 1) {
                requestAnimationFrame(tick);
            } else {
                // Ensure final values are exact
                aimSlider.value = targetAim;
                weightSlider.value = targetWeight;
                spinAmountSlider.value = targetSpin;
                document.getElementById('aim-value').textContent = targetAim.toFixed(1) + '°';
                document.getElementById('weight-value').textContent = CurlingPhysics.weightLabel(targetWeight);
                document.getElementById('spin-amount-value').textContent = targetSpin.toFixed(1);

                if (callback) callback();
            }
        }

        requestAnimationFrame(tick);
    }

    // --------------------------------------------------------
    // BOT SWEEP LOGIC
    // --------------------------------------------------------
    function decideSweep(bridge) {
        const gs = bridge.gameState;
        const stone = gs.deliveredStone;
        if (!stone || !stone.moving || stone.team !== 'yellow') return 'none';

        const P = CurlingPhysics.POSITIONS;
        const H = CurlingPhysics.HOUSE;
        const teeY = P.farTeeLine;
        const speed = Math.sqrt(stone.vx ** 2 + stone.vy ** 2);

        // Only sweep our own stones when they're past the near hog line
        if (stone.y < P.nearHogLine) return 'none';

        // Calculate where stone roughly will end up
        // Simple estimation: distance remaining at current speed with friction
        const estStopDist = speed * speed / (2 * 0.008 * 9.81); // v²/(2μg)
        const estStopY = stone.y + estStopDist * (stone.vy / Math.max(speed, 0.01));

        // Sweep strategy depends on shot type
        if (speed > 2.5) {
            // Takeout/peel — sweep to keep it straight and fast
            if (Math.abs(stone.x) > 1.2) {
                return 'hard'; // going wide, sweep to straighten
            }
            return 'light';
        }

        // Draw weight — sweep if it looks like it'll be short
        if (estStopY < teeY - H.twelveFoot) {
            return 'hard'; // going to be short of the house
        }
        if (estStopY < teeY - H.fourFoot) {
            return 'light'; // might be a little short
        }

        // If it's going to be through the house, don't sweep
        if (estStopY > P.farBackLine) {
            return 'none';
        }

        return 'none';
    }

    // --------------------------------------------------------
    // MAIN: TAKE TURN
    // --------------------------------------------------------
    function takeTurn(bridge) {
        if (isThinking) return;
        isThinking = true;

        // Show thinking indicator
        const thinkingEl = document.getElementById('bot-thinking');
        if (thinkingEl) thinkingEl.style.display = 'flex';

        // Evaluate the board
        const board = evaluateBoard(bridge);

        // Select a shot
        const shot = selectShot(board);

        // Calculate aim
        const aimDeg = calculateAim(shot);

        // Apply difficulty-based error
        const final = applyError(aimDeg, shot.weight, shot.spinAmount);

        // Clamp values
        final.aim = clamp(final.aim, -5, 5);
        final.weight = clamp(final.weight, 0, 100);
        final.spinAmount = clamp(final.spinAmount, 2, 5);

        console.log(`[Bot] ${shot.description}: aim=${final.aim.toFixed(2)}° weight=${final.weight.toFixed(0)}% spin=${shot.spin > 0 ? 'CW' : 'CCW'} rot=${final.spinAmount.toFixed(1)}`);

        // Animate sliders then throw
        setTimeout(() => {
            animateSliders(final.aim, final.weight, shot.spin, final.spinAmount, () => {
                // Brief pause then throw
                setTimeout(() => {
                    isThinking = false;
                    if (thinkingEl) thinkingEl.style.display = 'none';

                    // Trigger the throw
                    document.getElementById('throw-btn').disabled = false;
                    document.getElementById('throw-btn').click();
                }, 300);
            });
        }, 400); // initial thinking delay
    }

    // --------------------------------------------------------
    // PUBLIC API
    // --------------------------------------------------------
    return {
        takeTurn,
        decideSweep,
        setDifficulty(d) {
            if (DIFFICULTY[d]) difficulty = d;
        },
        getDifficulty() { return difficulty; },
        isThinking() { return isThinking; },
        DIFFICULTY,
    };
})();
