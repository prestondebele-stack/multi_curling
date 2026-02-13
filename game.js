// ============================================================
// CURLING GAME - Main game logic and rendering
// ============================================================

(function () {
    const canvas = document.getElementById('curling-canvas');
    const ctx = canvas.getContext('2d');

    // --------------------------------------------------------
    // SCALING & VIEWPORT
    // --------------------------------------------------------
    // We show from just before the far hog line to past the back line
    // This gives the best view of the house and incoming stones
    const VIEW = {
        // Meters of sheet visible vertically
        yMin: 28,       // show from ~28m (a bit before far hog)
        yMax: 41.5,     // past the back line
        xPadding: 0.5,  // extra meters on sides

        // Full sheet view for delivery
        yMinFull: -1,
        yMaxFull: 42,

        // Current view (interpolated during delivery)
        currentYMin: 28,
        currentYMax: 41.5,

        // Camera tracking
        followStone: false,
        targetYMin: 28,
        targetYMax: 41.5,
    };

    let scale = 1; // pixels per meter
    let offsetX = 0;
    let offsetY = 0;

    function isMobile() {
        return window.innerWidth <= 768;
    }

    function isLandscapeMobile() {
        return window.innerHeight <= 500 && window.innerWidth <= 900;
    }

    function resizeCanvas() {
        pebblePattern = null; // invalidate cached pattern on canvas resize

        if (isMobile() && !isLandscapeMobile()) {
            // Portrait mobile: canvas on top, UI below
            const uiPanel = document.getElementById('ui-overlay');
            canvas.width = window.innerWidth;
            // Let flexbox handle the height — measure after layout
            // Use a percentage of viewport minus estimated UI height
            const uiHeight = uiPanel.offsetHeight || (window.innerHeight * 0.4);
            canvas.height = window.innerHeight - uiHeight;
        } else if (isLandscapeMobile()) {
            // Landscape mobile: side panel at 260px
            canvas.width = window.innerWidth - 260;
            canvas.height = window.innerHeight;
        } else {
            // Desktop
            canvas.width = window.innerWidth - 300;
            canvas.height = window.innerHeight;
        }

        updateScale();
    }

    function updateScale() {
        const viewHeight = VIEW.currentYMax - VIEW.currentYMin;
        const viewWidth = CurlingPhysics.SHEET.width + VIEW.xPadding * 2;

        const scaleX = canvas.width / viewWidth;
        const scaleY = canvas.height / viewHeight;
        scale = Math.min(scaleX, scaleY);

        offsetX = (canvas.width - viewWidth * scale) / 2 + VIEW.xPadding * scale;
        offsetY = canvas.height; // y=0 at bottom, increases upward
    }

    // Convert real coordinates to canvas pixels
    function toCanvasX(realX) {
        return offsetX + (realX + CurlingPhysics.SHEET.width / 2) * scale;
    }

    function toCanvasY(realY) {
        return offsetY - (realY - VIEW.currentYMin) * scale;
    }

    function toCanvasLen(meters) {
        return meters * scale;
    }

    window.addEventListener('resize', () => {
        resizeCanvas();
    });

    // --------------------------------------------------------
    // GAME STATE
    // --------------------------------------------------------
    const P = CurlingPhysics.POSITIONS;
    const HOUSE = CurlingPhysics.HOUSE;
    const STONE_R = CurlingPhysics.STONE.radius;

    const TEAMS = {
        RED: 'red',
        YELLOW: 'yellow'
    };

    let gameState = {
        stones: [],
        currentTeam: TEAMS.RED,
        hammer: TEAMS.YELLOW, // team with last stone advantage
        redThrown: 0,
        yellowThrown: 0,
        currentEnd: 1,
        totalEnds: 6,
        redScore: 0,
        yellowScore: 0,
        endScores: [],
        phase: 'aiming',    // 'aiming', 'delivering', 'settling', 'scoring', 'gameover'
        sweepLevel: 'none',
        isSweeping: false,
        deliveredStone: null,
        simSpeed: 3.0,       // simulation speed multiplier for faster gameplay
        houseZoom: false,    // toggled by zoom button for close-up house view
        botMode: true,       // 1-player mode (bot plays Yellow)
        onlineMode: false,   // online multiplayer mode
        myTeam: null,        // 'red' or 'yellow' (assigned by server)
        roomCode: null,
        opponentConnected: true,
        opponentInfo: null, // { username, rank: { name, color, rating } }
    };

    // --------------------------------------------------------
    // GAME STATE BRIDGE (read-only access for bot)
    // --------------------------------------------------------
    window._curlingBridge = {
        get gameState() { return gameState; },
        TEAMS,
    };

    // --------------------------------------------------------
    // TAB NOTIFICATION (title flash + sound when it's your turn)
    // --------------------------------------------------------
    const TabNotify = (() => {
        const ORIG_TITLE = document.title;
        let flashTimer = null;
        let audioCtx = null;

        function getCtx() {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            return audioCtx;
        }

        // Unlock audio on first user gesture (iOS Safari requirement)
        document.addEventListener('click', function unlock() {
            const ctx = getCtx();
            if (ctx.state === 'suspended') ctx.resume();
            document.removeEventListener('click', unlock);
        }, { once: true });

        function playTone() {
            try {
                const ctx = getCtx();
                if (ctx.state === 'suspended') return;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                osc.frequency.setValueAtTime(523, ctx.currentTime);        // C5
                osc.frequency.setValueAtTime(659, ctx.currentTime + 0.15); // E5
                gain.gain.setValueAtTime(0, ctx.currentTime + 0.3);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.3);
            } catch (_) { /* ignore audio errors */ }
        }

        function startFlash() {
            if (flashTimer) return;
            let on = false;
            flashTimer = setInterval(() => {
                document.title = on ? ORIG_TITLE : '\u{1F534} Your Turn!';
                on = !on;
            }, 1000);
        }

        function stopFlash() {
            if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
            document.title = ORIG_TITLE;
        }

        document.addEventListener('visibilitychange', () => { if (!document.hidden) stopFlash(); });

        return {
            notify() { if (!document.hidden) return; playTone(); startFlash(); },
            stop() { stopFlash(); },
        };
    })();

    // --------------------------------------------------------
    // PUSH NOTIFICATION SETUP
    // --------------------------------------------------------
    const PushSetup = (() => {
        let vapidKey = null;

        function urlBase64ToUint8Array(base64String) {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
            const rawData = atob(base64);
            const outputArray = new Uint8Array(rawData.length);
            for (let i = 0; i < rawData.length; i++) {
                outputArray[i] = rawData.charCodeAt(i);
            }
            return outputArray;
        }

        async function subscribe() {
            if (!vapidKey) return;
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

            try {
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') return;

                const registration = await navigator.serviceWorker.ready;
                const existing = await registration.pushManager.getSubscription();
                if (existing) {
                    // Already subscribed — send to server in case it's new
                    CurlingNetwork.sendPushSubscribe(existing.toJSON());
                    return;
                }

                const subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(vapidKey),
                });
                CurlingNetwork.sendPushSubscribe(subscription.toJSON());
            } catch (err) {
                console.warn('Push subscription failed:', err);
            }
        }

        return {
            setup() {
                // Request VAPID key from server — subscription happens in onVapidKey callback
                CurlingNetwork.sendGetVapidKey();
            },
            onVapidKey(key) {
                vapidKey = key;
                subscribe();
            },
        };
    })();

    // --------------------------------------------------------
    // BOT HELPERS
    // --------------------------------------------------------
    function isBotTurn() {
        return gameState.botMode && gameState.currentTeam === TEAMS.YELLOW;
    }

    function disableControlsForBot() {
        document.getElementById('controls-panel').classList.add('bot-disabled');
    }

    function enableControlsForHuman() {
        document.getElementById('controls-panel').classList.remove('bot-disabled');
    }

    function triggerBotTurn() {
        if (!isBotTurn()) return;
        disableControlsForBot();
        document.getElementById('throw-btn').disabled = true;
        setTimeout(() => {
            if (gameState.phase === 'aiming' && isBotTurn()) {
                CurlingBot.takeTurn(window._curlingBridge);
            }
        }, 600);
    }

    // --------------------------------------------------------
    // ONLINE HELPERS
    // --------------------------------------------------------
    function isMyTurn() {
        return gameState.onlineMode && gameState.currentTeam === gameState.myTeam;
    }

    function isOnlineOpponentTurn() {
        return gameState.onlineMode && gameState.currentTeam !== gameState.myTeam;
    }

    // --------------------------------------------------------
    // STONE CREATION
    // --------------------------------------------------------
    function createStone(team, x, y, vx, vy, omega) {
        return {
            team,
            x,
            y,
            vx: vx || 0,
            vy: vy || 0,
            omega: omega || 0,
            angle: 0,
            active: true,
            moving: false,
            hasHitStone: false, // tracks if this stone has contacted another stone
        };
    }

    // --------------------------------------------------------
    // DELIVERY
    // --------------------------------------------------------
    // Trail for showing curl path
    let stoneTrail = [];

    // Hog-line violation indicator
    let hogLineViolation = null; // { x, y, timer }

    // Free Guard Zone (FGZ) violation indicator
    let fgzViolation = null; // { timer }

    // FGZ snapshots — saved positions of protected stones before each throw
    let fgzSnapshots = []; // [{ stone, x, y }]

    // --------------------------------------------------------
    // FREE GUARD ZONE (5-Rock Rule)
    // --------------------------------------------------------
    // The FGZ is the area between the far hog line and the front of the house
    // (12-foot ring), NOT including inside the house.
    // During the first 5 stones of each end, opponent stones in the FGZ
    // cannot be removed. If they are, the thrown stone is removed and
    // displaced stones are restored.

    function isInFreeGuardZone(stone) {
        if (!stone.active) return false;
        const distToTee = Math.sqrt(stone.x * stone.x + (stone.y - P.farTeeLine) ** 2);
        // In FGZ: past the far hog line, but NOT inside the house (12-foot ring)
        return stone.y >= P.farHogLine && distToTee > HOUSE.twelveFoot + STONE_R;
    }

    function getTotalStonesThrown() {
        return gameState.redThrown + gameState.yellowThrown;
    }

    function snapshotFGZStones() {
        // Only protect during first 5 stones of the end
        // Snapshot is taken BEFORE the current throw (throw count already incremented)
        // So we check if total thrown <= 5 (this is the 1st through 5th stone)
        const totalThrown = getTotalStonesThrown();
        if (totalThrown > 5) {
            fgzSnapshots = [];
            return;
        }

        // Snapshot all opponent's stones currently in the FGZ
        fgzSnapshots = [];
        for (const stone of gameState.stones) {
            if (stone === gameState.deliveredStone) continue; // skip the just-thrown stone
            if (stone.team === gameState.currentTeam) continue; // only protect opponent's stones
            if (isInFreeGuardZone(stone)) {
                fgzSnapshots.push({ stone, x: stone.x, y: stone.y });
            }
        }
    }

    function checkFGZViolation() {
        if (fgzSnapshots.length === 0) return;

        let violated = false;
        for (const snap of fgzSnapshots) {
            const stone = snap.stone;
            // Was the protected stone removed from play or knocked out of the FGZ?
            if (!stone.active || !isInFreeGuardZone(stone)) {
                // Restore the stone to its pre-throw position
                stone.active = true;
                stone.x = snap.x;
                stone.y = snap.y;
                stone.vx = 0;
                stone.vy = 0;
                stone.omega = 0;
                stone.moving = false;
                stone.fadeOut = undefined;
                violated = true;
            }
        }

        if (violated && gameState.deliveredStone) {
            // Remove the thrown stone from play
            deactivateStone(gameState.deliveredStone, true);
            fgzViolation = { timer: 2000 }; // show indicator for 2s
        }

        fgzSnapshots = [];
    }

    function deliverStoneWithParams(aimDeg, weightPct, spinDir, spinAmount) {
        const speed = CurlingPhysics.weightToSpeed(weightPct);
        const aimRad = aimDeg * Math.PI / 180;

        // Stone starts at hack, center line, moving toward far end
        const startX = 0;
        const startY = P.hack + 1.0; // just past the hack

        const vx = speed * Math.sin(aimRad);
        const vy = speed * Math.cos(aimRad);

        const omega = CurlingPhysics.rotationsToAngularVelocity(spinAmount, speed) * spinDir;

        const stone = createStone(gameState.currentTeam, startX, startY, vx, vy, omega);
        stone.moving = true;
        stoneTrail = [{ x: startX, y: startY }];
        gameState.stones.push(stone);
        gameState.deliveredStone = stone;

        // Update throw count
        if (gameState.currentTeam === TEAMS.RED) {
            gameState.redThrown++;
        } else {
            gameState.yellowThrown++;
        }

        gameState.phase = 'delivering';
        document.getElementById('throw-btn').disabled = true;
        document.getElementById('sweep-toggle-btn').style.display = 'block';
        document.getElementById('sweep-toggle-btn').textContent = 'SWEEP';
        document.getElementById('throw-btn').style.display = 'none';

        // Camera follows stone
        VIEW.followStone = true;

        // Snapshot FGZ-protected stones before this throw resolves
        snapshotFGZStones();
    }

    function deliverStone() {
        const aimDeg = parseFloat(document.getElementById('aim-slider').value);
        const weightPct = parseFloat(document.getElementById('weight-slider').value);
        const spinAmount = parseFloat(document.getElementById('spin-amount-slider').value);
        const spinDir = document.getElementById('spin-cw').classList.contains('active') ? 1 : -1;

        // If online mode, send to server
        if (gameState.onlineMode) {
            CurlingNetwork.sendThrow({ aim: aimDeg, weight: weightPct, spinDir, spinAmount });
        }

        deliverStoneWithParams(aimDeg, weightPct, spinDir, spinAmount);
    }

    // --------------------------------------------------------
    // SCORING
    // --------------------------------------------------------
    function calculateEndScore() {
        // Find the stone closest to the button
        const teeX = 0;
        const teeY = P.farTeeLine;

        const activeStones = gameState.stones.filter(s => s.active);

        if (activeStones.length === 0) return { team: null, points: 0 };

        // Sort all stones by distance to button
        const scored = activeStones.map(s => ({
            stone: s,
            dist: Math.sqrt((s.x - teeX) ** 2 + (s.y - teeY) ** 2),
        })).sort((a, b) => a.dist - b.dist);

        // Only stones within the 12-foot house score
        const inHouse = scored.filter(s => s.dist <= HOUSE.twelveFoot + STONE_R);

        if (inHouse.length === 0) return { team: null, points: 0 };

        const closestTeam = inHouse[0].stone.team;

        // Count consecutive stones of the closest team
        // that are closer than the nearest stone of the other team
        let points = 0;
        const otherTeamClosest = inHouse.find(s => s.stone.team !== closestTeam);
        const otherDist = otherTeamClosest ? otherTeamClosest.dist : Infinity;

        for (const s of inHouse) {
            if (s.stone.team === closestTeam && s.dist < otherDist) {
                points++;
            }
        }

        return { team: closestTeam, points };
    }

    function endEnd() {
        const result = calculateEndScore();

        gameState.endScores.push(result);

        if (result.team === TEAMS.RED) {
            gameState.redScore += result.points;
        } else if (result.team === TEAMS.YELLOW) {
            gameState.yellowScore += result.points;
        }

        document.getElementById('red-total').textContent = gameState.redScore;
        document.getElementById('yellow-total').textContent = gameState.yellowScore;

        if (gameState.currentEnd >= gameState.totalEnds) {
            gameState.phase = 'gameover';
            showGameOver();
            return;
        }

        // Start next end
        // Team that scored goes first in next end (disadvantage)
        // Team that didn't score gets hammer (last stone advantage)
        gameState.currentEnd++;
        document.getElementById('current-end').textContent = gameState.currentEnd;

        if (result.team && result.points > 0) {
            gameState.currentTeam = result.team; // scoring team goes first (disadvantage)
            // Hammer goes to the team that did NOT score
            gameState.hammer = result.team === TEAMS.RED ? TEAMS.YELLOW : TEAMS.RED;
        }
        // If blank end, same team keeps hammer (order stays)

        gameState.redThrown = 0;
        gameState.yellowThrown = 0;
        gameState.stones = [];
        gameState.phase = 'aiming';
        gameState.deliveredStone = null;

        updateUI();

        // Delay briefly so player sees the score, then enable controls
        setTimeout(() => {
            if (gameState.onlineMode) {
                if (isMyTurn()) {
                    enableControlsForHuman();
                    document.getElementById('throw-btn').disabled = false;
                    TabNotify.notify();
                } else {
                    disableControlsForBot();
                    document.getElementById('throw-btn').disabled = true;
                }
            } else if (isBotTurn()) {
                triggerBotTurn();
            } else {
                enableControlsForHuman();
                document.getElementById('throw-btn').disabled = false;
            }
        }, 500);
    }

    function showGameOver() {
        const screen = document.getElementById('game-over-screen');
        const winnerText = document.getElementById('winner-text');
        const finalScores = document.getElementById('final-scores');

        let winner;
        if (gameState.redScore > gameState.yellowScore) {
            if (gameState.onlineMode) {
                winner = gameState.myTeam === TEAMS.RED ? 'You Win!' : 'You Lose!';
            } else {
                winner = gameState.botMode ? 'You Win!' : 'Red Wins!';
            }
        } else if (gameState.yellowScore > gameState.redScore) {
            if (gameState.onlineMode) {
                winner = gameState.myTeam === TEAMS.YELLOW ? 'You Win!' : 'You Lose!';
            } else {
                winner = gameState.botMode ? 'Bot Wins!' : 'Yellow Wins!';
            }
        } else {
            winner = "It's a Tie!";
        }

        winnerText.textContent = winner;

        // Build score labels — show player names in online mode
        let redLabel = 'Red';
        let yellowLabel = 'Yellow';
        if (gameState.onlineMode) {
            const myName = localStorage.getItem('curling_username') || 'You';
            const oppName = gameState.opponentInfo ? gameState.opponentInfo.username : 'Guest';
            if (gameState.myTeam === TEAMS.RED) {
                redLabel = myName;
                yellowLabel = oppName;
            } else {
                redLabel = oppName;
                yellowLabel = myName;
            }
        }

        finalScores.innerHTML = `
            <div style="color:#e53935">${redLabel}: ${gameState.redScore}</div>
            <div style="color:#fdd835">${yellowLabel}: ${gameState.yellowScore}</div>
            <br>
            <div style="font-size:16px; color:#888">
                ${gameState.endScores.map((s, i) =>
            `End ${i + 1}: ${s.team ? (s.team === 'red' ? redLabel : yellowLabel) + ' +' + s.points : 'Blank'}`
        ).join('<br>')}
            </div>
        `;

        showMatchupOnGameOver();
        screen.style.display = 'flex';

        // Show rematch/leave buttons in online mode, hide new-game
        const newGameBtn = document.getElementById('new-game-btn');
        const rematchBtn = document.getElementById('rematch-btn');
        const leaveBtn = document.getElementById('leave-btn');
        if (gameState.onlineMode) {
            newGameBtn.style.display = 'none';
            rematchBtn.style.display = 'inline-block';
            rematchBtn.textContent = 'Rematch';
            rematchBtn.disabled = false;
            leaveBtn.style.display = 'inline-block';
            // Record game result for win/loss tracking
            CurlingNetwork.sendGameOver(gameState.redScore, gameState.yellowScore, gameState.currentEnd);
            // Reset rating update display (will be populated by rating_update message)
            const ratingInfo = document.getElementById('rating-update-info');
            if (ratingInfo) ratingInfo.style.display = 'none';
        } else {
            newGameBtn.style.display = 'inline-block';
            rematchBtn.style.display = 'none';
            leaveBtn.style.display = 'none';
        }
    }

    // --------------------------------------------------------
    // UI
    // --------------------------------------------------------
    function updateUI() {
        const teamLabel = document.getElementById('current-team-label');
        const stonesLabel = document.getElementById('stones-remaining');

        if (gameState.onlineMode) {
            teamLabel.textContent = isMyTurn() ? "Your Turn" : "Opponent's Turn";
        } else if (gameState.botMode) {
            teamLabel.textContent = gameState.currentTeam === TEAMS.RED ? "Your Turn" : "Bot's Turn";
        } else {
            teamLabel.textContent = gameState.currentTeam === TEAMS.RED ? "Red's Turn" : "Yellow's Turn";
        }
        teamLabel.style.color = gameState.currentTeam === TEAMS.RED ? '#e53935' : '#fdd835';

        // Trigger turn change pulse animation
        teamLabel.classList.remove('team-change-pulse');
        void teamLabel.offsetWidth; // force reflow to restart animation
        teamLabel.classList.add('team-change-pulse');

        const thrown = gameState.currentTeam === TEAMS.RED ? gameState.redThrown : gameState.yellowThrown;
        stonesLabel.textContent = `Stone ${thrown + 1} of 8`;

        document.getElementById('throw-btn').style.display = 'block';
        document.getElementById('sweep-toggle-btn').style.display = 'none';

        // Hammer indicator
        const redHammer = document.getElementById('red-hammer');
        const yellowHammer = document.getElementById('yellow-hammer');
        if (gameState.hammer === TEAMS.RED) {
            redHammer.style.display = 'inline';
            redHammer.textContent = '\u{1F528}';
            yellowHammer.style.display = 'none';
        } else {
            yellowHammer.style.display = 'inline';
            yellowHammer.textContent = '\u{1F528}';
            redHammer.style.display = 'none';
        }
    }

    function nextTurn() {
        // Switch teams (alternating throws)
        if (gameState.currentTeam === TEAMS.RED) {
            gameState.currentTeam = TEAMS.YELLOW;
        } else {
            gameState.currentTeam = TEAMS.RED;
        }

        // Check if all 16 stones have been thrown
        if (gameState.redThrown >= 8 && gameState.yellowThrown >= 8) {
            gameState.phase = 'scoring';
            setTimeout(() => endEnd(), 1500);
            return;
        }

        // If current team has thrown all 8, switch
        if (gameState.currentTeam === TEAMS.RED && gameState.redThrown >= 8) {
            gameState.currentTeam = TEAMS.YELLOW;
        } else if (gameState.currentTeam === TEAMS.YELLOW && gameState.yellowThrown >= 8) {
            gameState.currentTeam = TEAMS.RED;
        }

        gameState.phase = 'aiming';
        gameState.deliveredStone = null;
        updateUI();

        document.getElementById('aim-slider').value = 0;
        document.getElementById('aim-value').textContent = '0.0°';

        if (gameState.onlineMode) {
            // Server switches turns atomically when relaying the throw,
            // so no turn_complete message needed here.
            if (isMyTurn()) {
                enableControlsForHuman();
                document.getElementById('throw-btn').disabled = false;
                TabNotify.notify();
                // Send a game state snapshot so server can resync reconnecting players
                CurlingNetwork.sendGameStateSync({
                    currentTeam: gameState.currentTeam,
                    redScore: gameState.redScore,
                    yellowScore: gameState.yellowScore,
                    currentEnd: gameState.currentEnd,
                    redThrown: gameState.redThrown,
                    yellowThrown: gameState.yellowThrown,
                    hammer: gameState.hammer,
                    endScores: gameState.endScores,
                    stones: gameState.stones.filter(s => s.active).map(s => ({
                        team: s.team, x: s.x, y: s.y,
                    })),
                });
            } else {
                disableControlsForBot();
                document.getElementById('throw-btn').disabled = true;
            }
        } else if (isBotTurn()) {
            triggerBotTurn();
        } else {
            enableControlsForHuman();
            document.getElementById('throw-btn').disabled = false;
        }
    }

    // --------------------------------------------------------
    // RENDERING
    // --------------------------------------------------------

    // Ice texture colors
    const ICE_COLOR = '#e8eef5';
    const ICE_LIGHT = '#edf2f8';
    const LINE_COLOR = '#c0392b';
    const CENTER_LINE = '#444';

    function drawSheet() {
        // Background
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Ice surface
        const leftEdge = toCanvasX(-CurlingPhysics.SHEET.width / 2);
        const rightEdge = toCanvasX(CurlingPhysics.SHEET.width / 2);
        const topEdge = toCanvasY(VIEW.currentYMax);
        const bottomEdge = toCanvasY(VIEW.currentYMin);

        // Main ice with subtle gradient (cooler edges, warmer center)
        const iceGrad = ctx.createRadialGradient(
            toCanvasX(0), toCanvasY(P.farTeeLine), 0,
            toCanvasX(0), toCanvasY(P.farTeeLine), Math.max(rightEdge - leftEdge, bottomEdge - topEdge) * 0.7
        );
        iceGrad.addColorStop(0, '#eef3fa');  // slightly brighter center
        iceGrad.addColorStop(0.6, ICE_COLOR);
        iceGrad.addColorStop(1, '#dde3ec');  // cooler edges
        ctx.fillStyle = iceGrad;
        ctx.fillRect(leftEdge, topEdge, rightEdge - leftEdge, bottomEdge - topEdge);

        // Specular highlight — overhead arena light simulation
        const specGrad = ctx.createRadialGradient(
            toCanvasX(0), toCanvasY(P.farTeeLine), 0,
            toCanvasX(0), toCanvasY(P.farTeeLine), toCanvasLen(4)
        );
        specGrad.addColorStop(0, 'rgba(255, 255, 255, 0.06)');
        specGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = specGrad;
        ctx.fillRect(leftEdge, topEdge, rightEdge - leftEdge, bottomEdge - topEdge);

        // Pebble texture (subtle dots)
        drawPebbleTexture(leftEdge, topEdge, rightEdge - leftEdge, bottomEdge - topEdge);

        // Side boards (dark strips along left and right edges)
        const boardWidth = toCanvasLen(0.15);
        const boardGradL = ctx.createLinearGradient(leftEdge - boardWidth, 0, leftEdge, 0);
        boardGradL.addColorStop(0, '#2a2a3e');
        boardGradL.addColorStop(0.7, '#3a3a50');
        boardGradL.addColorStop(1, '#555');
        ctx.fillStyle = boardGradL;
        ctx.fillRect(leftEdge - boardWidth, topEdge, boardWidth, bottomEdge - topEdge);

        const boardGradR = ctx.createLinearGradient(rightEdge, 0, rightEdge + boardWidth, 0);
        boardGradR.addColorStop(0, '#555');
        boardGradR.addColorStop(0.3, '#3a3a50');
        boardGradR.addColorStop(1, '#2a2a3e');
        ctx.fillStyle = boardGradR;
        ctx.fillRect(rightEdge, topEdge, boardWidth, bottomEdge - topEdge);

        // Board top edge highlights
        ctx.strokeStyle = '#777';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(leftEdge - boardWidth, topEdge);
        ctx.lineTo(leftEdge - boardWidth, bottomEdge);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(rightEdge + boardWidth, topEdge);
        ctx.lineTo(rightEdge + boardWidth, bottomEdge);
        ctx.stroke();

        // Sheet boundary
        ctx.strokeStyle = '#bbb';
        ctx.lineWidth = 2;
        ctx.strokeRect(leftEdge, topEdge, rightEdge - leftEdge, bottomEdge - topEdge);

        // Ice logos (between the hog lines)
        drawIceLogos();

        // Center line
        ctx.strokeStyle = CENTER_LINE;
        ctx.lineWidth = 1;
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        ctx.moveTo(toCanvasX(0), topEdge);
        ctx.lineTo(toCanvasX(0), bottomEdge);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw house
        drawHouse();

        // Hog lines
        drawLine(P.farHogLine, '#c0392b', 3, 'Hog Line');
        drawLine(P.nearHogLine, '#c0392b', 3);

        // Tee line
        drawLine(P.farTeeLine, '#c0392b', 2);

        // Back line
        drawLine(P.farBackLine, '#c0392b', 2);

        // Hack
        drawHack();
    }

    // Pre-generate pebble texture as offscreen canvas
    let pebblePattern = null;
    function getPebblePattern() {
        if (pebblePattern) return pebblePattern;
        const patSize = 128;
        const offscreen = document.createElement('canvas');
        offscreen.width = patSize;
        offscreen.height = patSize;
        const octx = offscreen.getContext('2d');
        octx.fillStyle = 'rgba(180, 195, 215, 0.12)';
        for (let i = 0; i < 400; i++) {
            const px = (i * 37 + i * i * 13) % patSize;
            const py = (i * 53 + i * i * 7) % patSize;
            octx.beginPath();
            octx.arc(px, py, 0.8, 0, Math.PI * 2);
            octx.fill();
        }
        pebblePattern = ctx.createPattern(offscreen, 'repeat');
        return pebblePattern;
    }

    function drawPebbleTexture(x, y, w, h) {
        const pat = getPebblePattern();
        if (!pat) return;
        ctx.save();
        ctx.fillStyle = pat;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
    }

    // --------------------------------------------------------
    // ICE LOGO (Capital Curling Club)
    // Drawn between the far hog line and the house
    // --------------------------------------------------------
    const logoImg = new Image();
    logoImg.src = 'ccc-final-png_orig.png';
    let logoLoaded = false;
    logoImg.onload = () => { logoLoaded = true; };

    function drawIceLogos() {
        if (!logoLoaded) return;

        ctx.save();
        ctx.globalAlpha = 0.45; // painted-on-ice look

        // Place the logo centered between the far hog line and the front of the house
        const logoTopY = P.farHogLine + 0.3;
        const logoBottomY = P.farTeeLine - HOUSE.twelveFoot - 0.3;
        const logoMidY = (logoTopY + logoBottomY) / 2;
        const logoHeight = logoBottomY - logoTopY;

        // Maintain aspect ratio of the logo image
        const aspect = logoImg.width / logoImg.height;
        const drawH = toCanvasLen(logoHeight);
        const drawW = drawH * aspect;

        // Clamp width to sheet width minus margins
        const maxW = toCanvasLen(CurlingPhysics.SHEET.width * 0.85);
        const finalW = Math.min(drawW, maxW);
        const finalH = finalW / aspect;

        const cx = toCanvasX(0);
        const cy = toCanvasY(logoMidY);

        ctx.drawImage(logoImg, cx - finalW / 2, cy - finalH / 2, finalW, finalH);

        ctx.globalAlpha = 1.0;
        ctx.restore();
    }


    function drawHouse() {
        const cx = toCanvasX(0);
        const cy = toCanvasY(P.farTeeLine);

        // Spotlight glow behind the house (arena overhead lights)
        const spotGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, toCanvasLen(HOUSE.twelveFoot * 1.5));
        spotGrad.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
        spotGrad.addColorStop(0.6, 'rgba(255, 255, 255, 0.025)');
        spotGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = spotGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, toCanvasLen(HOUSE.twelveFoot * 1.5), 0, Math.PI * 2);
        ctx.fill();

        // Draw from outermost to innermost (painter's algorithm)
        // 12-foot ring - BLUE
        ctx.fillStyle = '#2a6cb6';
        ctx.beginPath();
        ctx.arc(cx, cy, toCanvasLen(HOUSE.twelveFoot), 0, Math.PI * 2);
        ctx.fill();

        // 8-foot ring - WHITE
        ctx.fillStyle = '#eef1f5';
        ctx.beginPath();
        ctx.arc(cx, cy, toCanvasLen(HOUSE.eightFoot), 0, Math.PI * 2);
        ctx.fill();

        // 4-foot ring - RED
        ctx.fillStyle = '#cc3333';
        ctx.beginPath();
        ctx.arc(cx, cy, toCanvasLen(HOUSE.fourFoot), 0, Math.PI * 2);
        ctx.fill();

        // Button area - WHITE
        ctx.fillStyle = '#eef1f5';
        ctx.beginPath();
        ctx.arc(cx, cy, toCanvasLen(HOUSE.button * 2.5), 0, Math.PI * 2);
        ctx.fill();

        // Ring outlines
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        for (const r of [HOUSE.twelveFoot, HOUSE.eightFoot, HOUSE.fourFoot]) {
            ctx.beginPath();
            ctx.arc(cx, cy, toCanvasLen(r), 0, Math.PI * 2);
            ctx.stroke();
        }

        // Tee line through house
        const halfW = CurlingPhysics.SHEET.width / 2;
        ctx.strokeStyle = LINE_COLOR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(toCanvasX(-halfW), cy);
        ctx.lineTo(toCanvasX(halfW), cy);
        ctx.stroke();

        // Center line through house
        ctx.strokeStyle = LINE_COLOR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, toCanvasY(P.farTeeLine - HOUSE.twelveFoot - 0.5));
        ctx.lineTo(cx, toCanvasY(P.farTeeLine + HOUSE.twelveFoot + 0.5));
        ctx.stroke();
    }

    function drawLine(yPos, color, width, label) {
        const halfW = CurlingPhysics.SHEET.width / 2;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(toCanvasX(-halfW), toCanvasY(yPos));
        ctx.lineTo(toCanvasX(halfW), toCanvasY(yPos));
        ctx.stroke();

        if (label) {
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.font = '11px sans-serif';
            ctx.fillText(label, toCanvasX(halfW) + 5, toCanvasY(yPos) + 4);
        }
    }

    function drawHack() {
        const hackY = toCanvasY(P.hack);
        const cx = toCanvasX(0);
        const hackW = toCanvasLen(0.15);
        const hackH = toCanvasLen(0.3);

        ctx.fillStyle = '#333';
        // Left hack
        ctx.fillRect(cx - toCanvasLen(0.12) - hackW, hackY - hackH / 2, hackW, hackH);
        // Right hack
        ctx.fillRect(cx + toCanvasLen(0.12), hackY - hackH / 2, hackW, hackH);
    }

    function drawStone(stone) {
        // Support fade-out: draw while fading, skip when fully gone
        if (!stone.active && !(stone.fadeOut > 0)) return;

        const cx = toCanvasX(stone.x);
        const cy = toCanvasY(stone.y);
        const r = toCanvasLen(STONE_R);

        // Don't draw if off screen
        if (cy < -r * 2 || cy > canvas.height + r * 2) return;
        if (cx < -r * 2 || cx > canvas.width + r * 2) return;

        ctx.save();

        // Fade-out effect
        if (stone.fadeOut > 0) {
            ctx.globalAlpha = stone.fadeOut;
        }

        // Settle micro-bounce
        let settleScale = 1.0;
        if (stone.settleTime > 0) {
            // Bounce from 1.06 down to 1.0 over 150ms
            const t = stone.settleTime / 150;
            settleScale = 1.0 + 0.06 * t * Math.cos(t * Math.PI);
        }

        ctx.translate(cx, cy);
        if (settleScale !== 1.0) ctx.scale(settleScale, settleScale);
        ctx.rotate(-stone.angle); // negative because canvas y is inverted

        // Stone body shadow (scaled with stone size)
        const shadowOff = Math.max(2, r * 0.12);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
        ctx.beginPath();
        ctx.arc(shadowOff, shadowOff, r + 1, 0, Math.PI * 2);
        ctx.fill();

        // Stone body
        const bodyColor = stone.team === TEAMS.RED ? '#e53935' : '#fdd835';
        const bodyDark = stone.team === TEAMS.RED ? '#b71c1c' : '#f9a825';
        const bodyLight = stone.team === TEAMS.RED ? '#ef5350' : '#ffee58';

        // Gradient for 3D effect
        const grad = ctx.createRadialGradient(-r * 0.2, -r * 0.2, r * 0.1, 0, 0, r);
        grad.addColorStop(0, bodyLight);
        grad.addColorStop(0.6, bodyColor);
        grad.addColorStop(1, bodyDark);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();

        // Running band (darker ring)
        ctx.strokeStyle = bodyDark;
        ctx.lineWidth = Math.max(1, toCanvasLen(0.008));
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
        ctx.stroke();

        // Handle - curved goose-neck shape so rotation is clearly visible
        const handleLen = r * 0.75;
        const handleW = Math.max(2, r * 0.16);

        // Handle bar
        ctx.strokeStyle = '#555';
        ctx.lineWidth = handleW;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-handleLen * 0.5, 0);
        ctx.lineTo(handleLen * 0.5, 0);
        ctx.stroke();

        // Handle highlight
        ctx.strokeStyle = '#888';
        ctx.lineWidth = handleW * 0.4;
        ctx.beginPath();
        ctx.moveTo(-handleLen * 0.4, 0);
        ctx.lineTo(handleLen * 0.4, 0);
        ctx.stroke();

        // Grip dot on one side to show rotation clearly
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(handleLen * 0.4, 0, handleW * 0.5, 0, Math.PI * 2);
        ctx.fill();

        // Direction indicator line (like the stripe on a curling stone handle)
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = Math.max(1, r * 0.04);
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.3);
        ctx.lineTo(0, -r * 0.6);
        ctx.stroke();

        // Stone edge highlight
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, r - 1, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();

        // Spin indicator (small arrow when moving)
        if (stone.moving && Math.abs(stone.omega) > 0.1) {
            const arrowR = r + 5;
            const arrowAngle = stone.omega > 0 ? Math.PI * 0.25 : -Math.PI * 0.25;
            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, arrowR, arrowAngle - 0.8, arrowAngle + 0.8);
            ctx.stroke();

            // Arrow head
            const endAngle = arrowAngle + (stone.omega > 0 ? 0.8 : -0.8);
            const ax = cx + arrowR * Math.cos(endAngle);
            const ay = cy + arrowR * Math.sin(endAngle);
            const dir = stone.omega > 0 ? 1 : -1;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(ax + dir * 5, ay - 5);
            ctx.moveTo(ax, ay);
            ctx.lineTo(ax + dir * 5, ay + 5);
            ctx.stroke();
        }
    }

    function drawTrail() {
        if (stoneTrail.length < 2) return;
        if (!gameState.deliveredStone) return;

        ctx.strokeStyle = gameState.deliveredStone.team === TEAMS.RED
            ? 'rgba(229, 57, 53, 0.3)'
            : 'rgba(253, 216, 53, 0.3)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(toCanvasX(stoneTrail[0].x), toCanvasY(stoneTrail[0].y));
        for (let i = 1; i < stoneTrail.length; i++) {
            ctx.lineTo(toCanvasX(stoneTrail[i].x), toCanvasY(stoneTrail[i].y));
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }



    function drawSweepEffect() {
        if (!gameState.isSweeping || !gameState.deliveredStone || !gameState.deliveredStone.moving) return;

        const stone = gameState.deliveredStone;
        const cx = toCanvasX(stone.x);
        const cy = toCanvasY(stone.y);
        const r = toCanvasLen(STONE_R);

        // Draw sweep marks in front of stone
        const speed = Math.sqrt(stone.vx ** 2 + stone.vy ** 2);
        if (speed < 0.01) return;

        const dirX = stone.vx / speed;
        const dirY = stone.vy / speed;

        ctx.strokeStyle = 'rgba(100, 180, 255, 0.4)';
        ctx.lineWidth = 2;

        for (let i = 0; i < 5; i++) {
            const dist = r + 5 + i * 8;
            const frontX = cx + dirX * dist * (scale > 10 ? 1 : scale / 10);
            const frontY = cy - dirY * dist * (scale > 10 ? 1 : scale / 10);

            ctx.beginPath();
            ctx.moveTo(frontX - 8, frontY - 4);
            ctx.lineTo(frontX + 8, frontY + 4);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(frontX + 8, frontY - 4);
            ctx.lineTo(frontX - 8, frontY + 4);
            ctx.stroke();
        }
    }

    function drawAimLine() {
        if (gameState.phase !== 'aiming') return;

        const aimDeg = parseFloat(document.getElementById('aim-slider').value);
        const aimRad = aimDeg * Math.PI / 180;

        const startX = 0;
        const startY = P.hack + 1.0;

        // Draw a dark dashed line showing the aim direction
        const lineLen = 45; // meters — extends past the house
        const endX = startX + lineLen * Math.sin(aimRad);
        const endY = startY + lineLen * Math.cos(aimRad);

        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(toCanvasX(startX), toCanvasY(startY));
        ctx.lineTo(toCanvasX(endX), toCanvasY(endY));
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw the stone at delivery position (preview)
        const previewStone = {
            team: gameState.currentTeam,
            x: startX,
            y: startY,
            angle: 0,
            active: true,
            moving: false,
            omega: 0,
        };
        drawStone(previewStone);
    }

    function drawScoreOverlay() {
        // Show which stones are scoring near the house
        if (gameState.phase === 'scoring' || gameState.phase === 'aiming' || gameState.phase === 'waitingNextTurn') {
            const teeX = 0;
            const teeY = P.farTeeLine;
            const activeStones = gameState.stones.filter(s => s.active);

            // Sort by distance
            const scored = activeStones.map(s => ({
                stone: s,
                dist: Math.sqrt((s.x - teeX) ** 2 + (s.y - teeY) ** 2),
            })).sort((a, b) => a.dist - b.dist);

            const inHouse = scored.filter(s => s.dist <= HOUSE.twelveFoot + STONE_R);

            if (inHouse.length > 0) {
                const closestTeam = inHouse[0].stone.team;
                const otherTeamClosest = inHouse.find(s => s.stone.team !== closestTeam);
                const otherDist = otherTeamClosest ? otherTeamClosest.dist : Infinity;

                // Highlight scoring stones
                for (const s of inHouse) {
                    if (s.stone.team === closestTeam && s.dist < otherDist) {
                        const cx = toCanvasX(s.stone.x);
                        const cy = toCanvasY(s.stone.y);
                        const r = toCanvasLen(STONE_R) + 4;

                        ctx.strokeStyle = s.stone.team === TEAMS.RED
                            ? 'rgba(229, 57, 53, 0.7)'
                            : 'rgba(253, 216, 53, 0.7)';
                        ctx.lineWidth = 3;
                        ctx.setLineDash([4, 3]);
                        ctx.beginPath();
                        ctx.arc(cx, cy, r, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.setLineDash([]);
                    }
                }

                // Score indicator text
                const pts = inHouse.filter(s => s.stone.team === closestTeam && s.dist < otherDist).length;
                if (pts > 0 && !gameState.deliveredStone?.moving) {
                    const teamName = closestTeam === TEAMS.RED ? 'Red' : 'Yellow';
                    ctx.fillStyle = 'rgba(0,0,0,0.6)';
                    ctx.fillRect(10, 10, 160, 30);
                    ctx.fillStyle = closestTeam === TEAMS.RED ? '#e53935' : '#fdd835';
                    ctx.font = 'bold 16px sans-serif';
                    ctx.fillText(`${teamName} scoring ${pts}`, 18, 30);
                }
            }
        }
    }

    // --------------------------------------------------------
    // CAMERA
    // --------------------------------------------------------
    // House zoom view: tight view centered on the house
    const HOUSE_ZOOM = {
        yMin: 35.5,  // just inside the 12-foot ring bottom
        yMax: 41.5,  // past the back line
    };

    function updateCamera() {
        if (gameState.deliveredStone && gameState.deliveredStone.moving) {
            // Auto-exit zoom when delivering
            gameState.houseZoom = false;
            document.getElementById('zoom-btn').classList.remove('zoomed');

            const stoneY = gameState.deliveredStone.y;
            // Smoothly follow the stone
            const viewSpan = 13.5;
            VIEW.targetYMin = stoneY - viewSpan * 0.3;
            VIEW.targetYMax = stoneY + viewSpan * 0.7;

            // Clamp to not go below hack or above end
            VIEW.targetYMin = Math.max(-1, VIEW.targetYMin);
            VIEW.targetYMax = Math.min(42, VIEW.targetYMax);
        } else if (gameState.houseZoom) {
            // Zoomed house view
            VIEW.targetYMin = HOUSE_ZOOM.yMin;
            VIEW.targetYMax = HOUSE_ZOOM.yMax;
        } else {
            // Default: show the house area
            VIEW.targetYMin = 28;
            VIEW.targetYMax = 41.5;
        }

        // Smooth interpolation � faster for zoom transitions
        const lerp = gameState.houseZoom ? 0.10 : 0.06;
        VIEW.currentYMin += (VIEW.targetYMin - VIEW.currentYMin) * lerp;
        VIEW.currentYMax += (VIEW.targetYMax - VIEW.currentYMax) * lerp;

        updateScale();
    }

    // --------------------------------------------------------
    // MAIN LOOP
    // --------------------------------------------------------
    const PHYSICS_DT = 1 / 240; // 240 Hz physics (high precision for fast stones)

    let lastTime = 0;
    let physicsAccumulator = 0;

    // Fast-forward physics to settle all moving stones (used after tab becomes visible)
    function fastForwardPhysics() {
        const MAX_ITERATIONS = 5000; // safety limit
        let iterations = 0;
        while (iterations < MAX_ITERATIONS) {
            let anyMoving = false;
            for (const stone of gameState.stones) {
                if (stone.active && stone.moving) {
                    anyMoving = true;
                    break;
                }
            }
            if (!anyMoving) break;

            CurlingPhysics.stepAll(gameState.stones, PHYSICS_DT, gameState.sweepLevel, gameState.isSweeping);
            checkOutOfBounds();
            iterations++;
        }
    }

    // When tab becomes visible again in online mode, fast-forward any in-flight stones
    // so the game catches up (requestAnimationFrame is throttled/paused in background tabs)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && gameState.onlineMode) {
            if (gameState.phase === 'delivering' || gameState.phase === 'settling') {
                fastForwardPhysics();
                // Check FGZ violation and advance turn
                checkFGZViolation();
                gameState.phase = 'waitingNextTurn';
                gameState.isSweeping = false;
                document.getElementById('sweep-toggle-btn').style.display = 'none';
                setTimeout(() => {
                    if (gameState.phase === 'waitingNextTurn') {
                        nextTurn();
                    }
                }, 300);
            }
        }
    });

    function gameLoop(timestamp) {
        // Skip updates when tab is hidden (saves battery, prevents drift)
        if (document.hidden) {
            lastTime = 0;
            requestAnimationFrame(gameLoop);
            return;
        }

        if (!lastTime) lastTime = timestamp;
        let frameTime = (timestamp - lastTime) / 1000;
        lastTime = timestamp;

        // Clamp frame time to avoid spiral of death
        if (frameTime > 0.1) frameTime = 0.1;

        // Physics update
        if (gameState.phase === 'delivering') {
            // Bot sweep decision (runs each frame for bot's stones)
            if (gameState.botMode && gameState.deliveredStone &&
                gameState.deliveredStone.moving && gameState.deliveredStone.team === TEAMS.YELLOW) {
                const botSweep = CurlingBot.decideSweep(window._curlingBridge);
                if (botSweep !== 'none') {
                    gameState.isSweeping = true;
                    gameState.sweepLevel = botSweep;
                    setSweepLevel(botSweep);
                } else {
                    gameState.isSweeping = false;
                }
            }

            physicsAccumulator += frameTime * gameState.simSpeed;

            while (physicsAccumulator >= PHYSICS_DT) {
                const sweep = gameState.isSweeping ? gameState.sweepLevel : 'none';
                const anyMoving = CurlingPhysics.simulate(gameState.stones, PHYSICS_DT, sweep);

                // Record trail for the delivered stone
                if (gameState.deliveredStone && gameState.deliveredStone.moving) {
                    const ds = gameState.deliveredStone;
                    const last = stoneTrail[stoneTrail.length - 1];
                    const dx = ds.x - last.x;
                    const dy = ds.y - last.y;
                    if (dx * dx + dy * dy > 0.04) { // record every ~0.2m
                        stoneTrail.push({ x: ds.x, y: ds.y });
                    }
                }

                // Check for stones out of bounds
                checkOutOfBounds();

                physicsAccumulator -= PHYSICS_DT;

                if (!anyMoving) {
                    physicsAccumulator = 0;
                    if (gameState.phase === 'delivering' || gameState.phase === 'settling') {
                        // Check FGZ violation before advancing turn
                        checkFGZViolation();

                        gameState.phase = 'waitingNextTurn';
                        gameState.isSweeping = false;
                        document.getElementById('sweep-toggle-btn').style.display = 'none';
                        setTimeout(() => {
                            if (gameState.phase === 'waitingNextTurn') {
                                nextTurn();
                            }
                        }, 800);
                    }
                    break;
                }
            }

            // Once the delivered stone passes the far hog line, stop sweeping ability
            // (sweeping is only allowed between hog lines in real curling)
            if (gameState.deliveredStone && !gameState.deliveredStone.moving) {
                gameState.isSweeping = false;
            }
        }

        // Camera
        updateCamera();

        // Tick stone animations (settle bounce + fade-out)
        const frameDeltaMs = frameTime * 1000;
        for (const stone of gameState.stones) {
            if (stone.settleTime > 0) {
                stone.settleTime = Math.max(0, stone.settleTime - frameDeltaMs);
            }
            if (stone.fadeOut !== undefined && stone.fadeOut > 0 && !stone.active) {
                stone.fadeOut -= frameDeltaMs / 300; // fade over 300ms
                if (stone.fadeOut <= 0) stone.fadeOut = 0;
            }
        }

        // Tick hog-line violation indicator
        if (hogLineViolation) {
            hogLineViolation.timer -= frameDeltaMs;
            if (hogLineViolation.timer <= 0) hogLineViolation = null;
        }

        // Tick FGZ violation indicator
        if (fgzViolation) {
            fgzViolation.timer -= frameDeltaMs;
            if (fgzViolation.timer <= 0) fgzViolation = null;
        }



        // Render
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawSheet();
        drawAimLine();

        // Draw trail
        drawTrail();

        // Draw all stones
        for (const stone of gameState.stones) {
            drawStone(stone);
        }

        drawSweepEffect();
        drawScoreOverlay();
        drawHogLineViolation();
        drawFGZViolation();
        drawVignette();
        drawStagedStones();

        requestAnimationFrame(gameLoop);
    }

    // Hog-line violation text on the ice
    function drawHogLineViolation() {
        if (!hogLineViolation) return;
        const alpha = Math.min(1, hogLineViolation.timer / 300); // fade out in last 300ms
        const cx = toCanvasX(hogLineViolation.x);
        const cy = toCanvasY(hogLineViolation.y);

        ctx.save();
        ctx.globalAlpha = alpha;

        // Background pill
        ctx.fillStyle = 'rgba(200, 30, 30, 0.85)';
        const textW = 180;
        const textH = 36;
        ctx.beginPath();
        ctx.moveTo(cx - textW / 2 + 8, cy - textH / 2);
        ctx.lineTo(cx + textW / 2 - 8, cy - textH / 2);
        ctx.arcTo(cx + textW / 2, cy - textH / 2, cx + textW / 2, cy, 8);
        ctx.arcTo(cx + textW / 2, cy + textH / 2, cx - textW / 2, cy + textH / 2, 8);
        ctx.arcTo(cx - textW / 2, cy + textH / 2, cx - textW / 2, cy, 8);
        ctx.arcTo(cx - textW / 2, cy - textH / 2, cx + textW / 2, cy - textH / 2, 8);
        ctx.closePath();
        ctx.fill();

        // Text
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('HOG LINE', cx, cy + 1);

        ctx.restore();
    }

    // FGZ violation indicator — centered on screen
    function drawFGZViolation() {
        if (!fgzViolation) return;
        const alpha = Math.min(1, fgzViolation.timer / 400);

        ctx.save();
        ctx.globalAlpha = alpha;

        const cx = canvas.width / 2;
        const cy = canvas.height * 0.3;

        // Background pill
        ctx.fillStyle = 'rgba(200, 130, 0, 0.9)';
        const textW = 260;
        const textH = 44;
        ctx.beginPath();
        ctx.moveTo(cx - textW / 2 + 10, cy - textH / 2);
        ctx.lineTo(cx + textW / 2 - 10, cy - textH / 2);
        ctx.arcTo(cx + textW / 2, cy - textH / 2, cx + textW / 2, cy, 10);
        ctx.arcTo(cx + textW / 2, cy + textH / 2, cx - textW / 2, cy + textH / 2, 10);
        ctx.arcTo(cx - textW / 2, cy + textH / 2, cx - textW / 2, cy, 10);
        ctx.arcTo(cx - textW / 2, cy - textH / 2, cx + textW / 2, cy - textH / 2, 10);
        ctx.closePath();
        ctx.fill();

        // Text
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('FREE GUARD ZONE', cx, cy + 1);

        ctx.restore();
    }
// Stone staging display — shows each team's 8 stones on the ice
// Red stones: top-left corner, Yellow stones: top-right corner
// 2 columns × 4 rows, ordered by throw number
// Stones appear on the grid only when out of play; in-play spots are empty
function drawStagedStones() {
    const halfW = CurlingPhysics.SHEET.width / 2;
    const stoneSize = STONE_R * 0.7; // slightly smaller than real stones

    // World-space layout: place stones just past the far back line
    const startY = P.farBackLine + STONE_R * 2.5;
    const gapX = STONE_R * 2.8;
    const gapY = STONE_R * 2.8;

    // Gather thrown stones per team in throw order
    const redStones = gameState.stones.filter(s => s.team === TEAMS.RED);
    const yellowStones = gameState.stones.filter(s => s.team === TEAMS.YELLOW);

    for (let teamIdx = 0; teamIdx < 2; teamIdx++) {
        const isRed = teamIdx === 0;
        const teamStones = isRed ? redStones : yellowStones;
        const thrown = isRed ? gameState.redThrown : gameState.yellowThrown;
        const baseColor = isRed ? '#e53935' : '#fdd835';
        const darkColor = isRed ? '#b71c1c' : '#f9a825';
        const lightColor = isRed ? '#ef5350' : '#ffee58';

        // World x anchor: red on left side, yellow on right side
        const anchorX = isRed
            ? -halfW + STONE_R * 2.5
            : halfW - STONE_R * 2.5 - gapX;

        for (let i = 0; i < 8; i++) {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const worldX = anchorX + col * gapX;
            const worldY = startY + row * gapY;

            // Convert to canvas coordinates
            const cx = toCanvasX(worldX);
            const cy = toCanvasY(worldY);
            const r = toCanvasLen(stoneSize);

            const hasBeenThrown = i < thrown;
            const stoneObj = teamStones[i];
            const isActive = stoneObj ? stoneObj.active : false;

            // Skip if not thrown yet or still in play — leave spot empty
            if (!hasBeenThrown || isActive) continue;

            // Stone is out of play — draw it on the grid
            ctx.save();
            ctx.globalAlpha = 0.85;

            // Shadow
            ctx.fillStyle = 'rgba(0,0,0,0.15)';
            ctx.beginPath();
            ctx.arc(cx + 1, cy + 1, r, 0, Math.PI * 2);
            ctx.fill();

            // Body gradient
            const grad = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, r * 0.1, cx, cy, r);
            grad.addColorStop(0, lightColor);
            grad.addColorStop(0.6, baseColor);
            grad.addColorStop(1, darkColor);
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();

            // Edge highlight
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.lineWidth = Math.max(0.5, r * 0.06);
            ctx.beginPath();
            ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2);
            ctx.stroke();

            ctx.restore();
        }
    }
}
    function drawVignette() {
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const r = Math.max(canvas.width, canvas.height) * 0.7;
        const grad = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r);
        grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    function deactivateStone(stone, fade) {
        stone.moving = false;
        if (fade) {
            // Start fade-out instead of instant removal
            stone.active = false;
            stone.fadeOut = 1.0; // will tick down in game loop
        } else {
            stone.active = false;
        }
    }

    function checkOutOfBounds() {
        const halfW = CurlingPhysics.SHEET.width / 2;

        for (const stone of gameState.stones) {
            if (!stone.active) continue;

            // Past back line and moving away from play
            if (stone.y > P.farBackLine + STONE_R && stone.vy > 0) {
                deactivateStone(stone, true);
            }

            // Behind near back line (bounced way back)
            if (stone.y < P.hack - 2) {
                deactivateStone(stone, true);
            }

            // Side wall — stone touching the boards is out of play (instant removal)
            if (Math.abs(stone.x) > halfW - STONE_R) {
                deactivateStone(stone, true);
            }

            // Didn't completely cross the far hog line
            // Rule: stone must COMPLETELY cross (leading edge past the line)
            // Exception: if the delivered stone hit another stone first, it stays in play
            if (stone === gameState.deliveredStone && !stone.moving && (stone.y - STONE_R) < P.farHogLine) {
                if (!stone.hasHitStone) {
                    hogLineViolation = { x: stone.x, y: stone.y, timer: 1500 };
                    deactivateStone(stone, true);
                }
            }
        }
    }

    // --------------------------------------------------------
    // EVENT HANDLERS
    // --------------------------------------------------------
    document.getElementById('throw-btn').addEventListener('click', () => {
        if (gameState.phase === 'aiming') {
            if (isOnlineOpponentTurn()) return;
            deliverStone();
        }
    });

    document.getElementById('zoom-btn').addEventListener('click', () => {
        if (gameState.phase === 'aiming' || gameState.phase === 'waitingNextTurn') {
            gameState.houseZoom = !gameState.houseZoom;
            document.getElementById('zoom-btn').classList.toggle('zoomed', gameState.houseZoom);
        }
    });

    document.getElementById('aim-slider').addEventListener('input', (e) => {
        document.getElementById('aim-value').textContent = parseFloat(e.target.value).toFixed(1) + '°';
    });

    document.getElementById('weight-slider').addEventListener('input', (e) => {
        const pct = parseFloat(e.target.value);
        document.getElementById('weight-value').textContent = CurlingPhysics.weightLabel(pct);
    });

    document.getElementById('spin-amount-slider').addEventListener('input', (e) => {
        document.getElementById('spin-amount-value').textContent = parseFloat(e.target.value).toFixed(1);
    });

    document.getElementById('spin-cw').addEventListener('click', () => {
        document.getElementById('spin-cw').classList.add('active');
        document.getElementById('spin-ccw').classList.remove('active');
        document.getElementById('spin-value').textContent = 'In-turn';
    });

    document.getElementById('spin-ccw').addEventListener('click', () => {
        document.getElementById('spin-ccw').classList.add('active');
        document.getElementById('spin-cw').classList.remove('active');
        document.getElementById('spin-value').textContent = 'Out-turn';
    });

    // Sweep buttons
    document.getElementById('sweep-none').addEventListener('click', () => {
        setSweepLevel('none');
    });
    document.getElementById('sweep-light').addEventListener('click', () => {
        setSweepLevel('light');
    });
    document.getElementById('sweep-hard').addEventListener('click', () => {
        setSweepLevel('hard');
    });

    function setSweepLevel(level) {
        gameState.sweepLevel = level;
        document.querySelectorAll('.sweep-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('sweep-' + level).classList.add('active');
        if (gameState.onlineMode && isMyTurn()) {
            CurlingNetwork.sendSweepChange(level);
        }
    }

    // Keyboard controls
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            e.preventDefault();
            startSweeping();
        }

        if (e.code === 'Enter' && gameState.phase === 'aiming') {
            if (isOnlineOpponentTurn()) return;
            deliverStone();
        }

        // Arrow keys for fine aim adjustment
        if (e.code === 'ArrowLeft') {
            const slider = document.getElementById('aim-slider');
            slider.value = Math.max(-5, parseFloat(slider.value) - 0.1);
            slider.dispatchEvent(new Event('input'));
        }
        if (e.code === 'ArrowRight') {
            const slider = document.getElementById('aim-slider');
            slider.value = Math.min(5, parseFloat(slider.value) + 0.1);
            slider.dispatchEvent(new Event('input'));
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            stopSweeping();
        }
    });

    function startSweeping() {
        if (gameState.phase === 'delivering' && gameState.deliveredStone?.moving) {
            if (isOnlineOpponentTurn()) return; // only sweep your own stone
            gameState.isSweeping = true;
            if (gameState.sweepLevel === 'none') {
                gameState.sweepLevel = 'hard';
                setSweepLevel('hard');
            }
            document.getElementById('sweep-toggle-btn').classList.add('sweeping');
            document.getElementById('sweep-toggle-btn').textContent = 'SWEEPING!';
            if (gameState.onlineMode) CurlingNetwork.sendSweepStart();
        }
    }

    function stopSweeping() {
        const wasSweeping = gameState.isSweeping;
        gameState.isSweeping = false;
        document.getElementById('sweep-toggle-btn').classList.remove('sweeping');
        document.getElementById('sweep-toggle-btn').textContent = 'SWEEP';
        if (gameState.onlineMode && wasSweeping) CurlingNetwork.sendSweepStop();
    }

    // Touch events for sweep button (touch-and-hold to sweep)
    const sweepBtn = document.getElementById('sweep-toggle-btn');
    sweepBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startSweeping();
    }, { passive: false });
    sweepBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        stopSweeping();
    }, { passive: false });
    sweepBtn.addEventListener('touchcancel', (e) => {
        stopSweeping();
    });
    // Also support mouse hold on sweep button (for desktop testing)
    sweepBtn.addEventListener('mousedown', (e) => {
        startSweeping();
    });
    sweepBtn.addEventListener('mouseup', (e) => {
        stopSweeping();
    });
    sweepBtn.addEventListener('mouseleave', (e) => {
        stopSweeping();
    });

    // Prevent iOS bounce / pull-to-refresh on the canvas
    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
    }, { passive: false });

    // Handle orientation changes
    window.addEventListener('orientationchange', () => {
        setTimeout(resizeCanvas, 150);
    });

    // New game button
    document.getElementById('new-game-btn').addEventListener('click', () => {
        document.getElementById('game-over-screen').style.display = 'none';
        resetGame();
    });

    function resetGame() {
        const preserveBotMode = gameState.botMode;
        const preserveOnlineMode = gameState.onlineMode;
        const preserveMyTeam = gameState.myTeam;
        const preserveRoomCode = gameState.roomCode;
        gameState = {
            stones: [],
            currentTeam: TEAMS.RED,
            hammer: TEAMS.YELLOW,
            redThrown: 0,
            yellowThrown: 0,
            currentEnd: 1,
            totalEnds: 6,
            redScore: 0,
            yellowScore: 0,
            endScores: [],
            phase: 'aiming',
            sweepLevel: 'none',
            isSweeping: false,
            deliveredStone: null,
            simSpeed: 3.0,
            houseZoom: false,
            botMode: preserveBotMode,
            onlineMode: preserveOnlineMode,
            myTeam: preserveMyTeam,
            roomCode: preserveRoomCode,
            opponentConnected: true,
        };

        fgzSnapshots = [];
        fgzViolation = null;
        hogLineViolation = null;

        document.getElementById('zoom-btn').classList.remove('zoomed');
        document.getElementById('red-total').textContent = '0';
        document.getElementById('yellow-total').textContent = '0';
        document.getElementById('current-end').textContent = '1';
        document.getElementById('throw-btn').disabled = false;
        enableControlsForHuman();

        updateUI();
    }

    // --------------------------------------------------------
    // SETTINGS TOGGLE
    // --------------------------------------------------------
    const settingsToggle = document.getElementById('settings-toggle');
    const settingsDropdown = document.getElementById('settings-dropdown');

    settingsToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = settingsDropdown.classList.toggle('open');
        settingsToggle.classList.toggle('active', isOpen);
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!settingsDropdown.contains(e.target) && e.target !== settingsToggle) {
            settingsDropdown.classList.remove('open');
            settingsToggle.classList.remove('active');
        }
    });

    // --------------------------------------------------------
    // MODE & DIFFICULTY BUTTONS
    // --------------------------------------------------------
    function clearOnlineMode() {
        if (gameState.onlineMode) {
            CurlingNetwork.sendLeave();
            CurlingNetwork.disconnect();
        }
        gameState.onlineMode = false;
        gameState.myTeam = null;
        gameState.roomCode = null;
        gameState.opponentInfo = null;
        document.getElementById('online-team-badge').style.display = 'none';
        // Clear player names from scoreboard
        document.getElementById('red-player-name').textContent = '';
        document.getElementById('yellow-player-name').textContent = '';
    }

    document.getElementById('mode-1p').addEventListener('click', () => {
        clearOnlineMode();
        gameState.botMode = true;
        document.getElementById('mode-1p').classList.add('active');
        document.getElementById('mode-2p').classList.remove('active');
        document.getElementById('mode-online').classList.remove('active');
        document.getElementById('difficulty-selector').classList.remove('hidden');
        // If it's now the bot's turn, trigger it
        if (isBotTurn() && gameState.phase === 'aiming') {
            triggerBotTurn();
        }
        settingsDropdown.classList.remove('open');
        settingsToggle.classList.remove('active');
    });

    document.getElementById('mode-2p').addEventListener('click', () => {
        clearOnlineMode();
        gameState.botMode = false;
        document.getElementById('mode-2p').classList.add('active');
        document.getElementById('mode-1p').classList.remove('active');
        document.getElementById('mode-online').classList.remove('active');
        document.getElementById('difficulty-selector').classList.add('hidden');
        enableControlsForHuman();
        if (gameState.phase === 'aiming') {
            document.getElementById('throw-btn').disabled = false;
        }
        settingsDropdown.classList.remove('open');
        settingsToggle.classList.remove('active');
    });

    document.querySelectorAll('.diff-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const level = btn.id.replace('diff-', '');
            CurlingBot.setDifficulty(level);
            settingsDropdown.classList.remove('open');
            settingsToggle.classList.remove('active');
        });
    });

    // --------------------------------------------------------
    // ONLINE MULTIPLAYER
    // --------------------------------------------------------
    const SERVER_URL = (() => {
        const loc = window.location;
        const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        // When served by our Node server, use the same host:port
        // When opened as file://, fall back to localhost:3000
        if (loc.protocol === 'file:') {
            return 'ws://localhost:3000';
        }
        return `${wsProtocol}//${loc.host}`;
    })();

    function updateRankBadge(rank) {
        const badge = document.getElementById('user-rank-badge');
        if (badge && rank) {
            badge.textContent = rank.name;
            badge.style.background = rank.color;
            badge.style.display = 'inline-block';
            // Show rating number next to badge
            const ratingEl = document.getElementById('user-rating');
            if (ratingEl) {
                ratingEl.textContent = rank.rating + ' ELO';
            }
        }
    }

    function showLobbyPanel(panelId) {
        const panels = ['lobby-menu', 'lobby-create-panel', 'lobby-join-panel', 'lobby-queue-panel', 'lobby-starting-panel', 'auth-panel', 'lobby-friends-panel'];
        panels.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = id === panelId ? 'flex' : 'none';
        });
    }

    function showLobbyScreen() {
        document.getElementById('lobby-screen').style.display = 'flex';
        showLobbyPanel('lobby-menu');
    }

    function hideLobbyScreen() {
        document.getElementById('lobby-screen').style.display = 'none';
    }

    let disconnectCountdown = null;

    function showDisconnectOverlay() {
        document.getElementById('disconnect-overlay').style.display = 'flex';
        const sub = document.querySelector('.disconnect-sub');
        let remaining = 300; // 5 minutes in seconds

        function formatTime(seconds) {
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return `${m}:${s.toString().padStart(2, '0')}`;
        }

        sub.textContent = `Waiting for reconnection... (${formatTime(remaining)})`;

        if (disconnectCountdown) clearInterval(disconnectCountdown);
        disconnectCountdown = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(disconnectCountdown);
                disconnectCountdown = null;
                sub.textContent = 'Opponent did not reconnect.';
            } else {
                sub.textContent = `Waiting for reconnection... (${formatTime(remaining)})`;
            }
        }, 1000);
    }

    function hideDisconnectOverlay() {
        if (disconnectCountdown) {
            clearInterval(disconnectCountdown);
            disconnectCountdown = null;
        }
        document.getElementById('disconnect-overlay').style.display = 'none';
    }

    function showOnlineTeamBadge() {
        const badge = document.getElementById('online-team-badge');
        badge.className = gameState.myTeam === TEAMS.RED ? 'team-red' : 'team-yellow';
        badge.textContent = 'You are ' + (gameState.myTeam === TEAMS.RED ? 'Red' : 'Yellow');
        badge.style.display = 'block';
    }

    function updateScoreboardNames() {
        const myName = localStorage.getItem('curling_username') || null;
        const oppInfo = gameState.opponentInfo;
        const myTeam = gameState.myTeam;

        const redNameEl = document.getElementById('red-player-name');
        const yellowNameEl = document.getElementById('yellow-player-name');

        if (!gameState.onlineMode) {
            // Clear names for local play
            redNameEl.textContent = '';
            yellowNameEl.textContent = '';
            return;
        }

        if (myTeam === TEAMS.RED) {
            redNameEl.textContent = myName ? myName + ' (you)' : 'You';
            yellowNameEl.textContent = oppInfo ? oppInfo.username : 'Guest';
        } else {
            yellowNameEl.textContent = myName ? myName + ' (you)' : 'You';
            redNameEl.textContent = oppInfo ? oppInfo.username : 'Guest';
        }
    }

    function showOpponentStartInfo(opponent) {
        const nameLabel = document.getElementById('opponent-name-label');
        const rankBadge = document.getElementById('opponent-rank-badge');
        const bar = document.getElementById('opponent-info-bar');

        if (!opponent) {
            nameLabel.textContent = 'Guest';
            rankBadge.style.display = 'none';
            bar.style.display = 'flex';
            return;
        }

        nameLabel.textContent = opponent.username;
        if (opponent.rank) {
            rankBadge.textContent = opponent.rank.name;
            rankBadge.style.background = opponent.rank.color;
            rankBadge.style.display = 'inline-block';
        } else {
            rankBadge.style.display = 'none';
        }
        bar.style.display = 'flex';
    }

    function showMatchupOnGameOver() {
        const info = document.getElementById('matchup-info');
        if (!gameState.onlineMode) {
            info.style.display = 'none';
            return;
        }

        const myName = localStorage.getItem('curling_username') || 'You';
        const oppInfo = gameState.opponentInfo;
        const oppName = oppInfo ? oppInfo.username : 'Guest';

        let html = `<span style="color:#fff">${myName}</span> <span>vs</span> <span style="color:#fff">${oppName}</span>`;
        if (oppInfo && oppInfo.rank) {
            html += ` <span class="rank-badge" style="background:${oppInfo.rank.color}">${oppInfo.rank.name}</span>`;
        }
        info.innerHTML = html;
        info.style.display = 'flex';
    }

    // --------------------------------------------------------
    // FRIENDS SYSTEM
    // --------------------------------------------------------
    let friendsList = [];
    let pendingRequests = { incoming: [], outgoing: [] };

    function renderFriendsList(friends) {
        friendsList = friends;
        const container = document.getElementById('friends-list');
        const emptyMsg = document.getElementById('friends-list-empty');

        if (friends.length === 0) {
            container.innerHTML = '';
            emptyMsg.style.display = 'block';
            return;
        }
        emptyMsg.style.display = 'none';

        const statusOrder = { online: 0, in_game: 1, offline: 2 };
        friends.sort((a, b) => (statusOrder[a.status] || 2) - (statusOrder[b.status] || 2));

        container.innerHTML = friends.map(f => {
            const statusLabel = f.status === 'in_game' ? 'In Game' : f.status === 'online' ? 'Online' : 'Offline';
            const canInvite = f.status === 'online';
            const rankHtml = f.rank ? `<span class="rank-badge friend-rank" style="background:${f.rank.color}">${f.rank.name}</span>` : '';
            return `<div class="friend-item" data-user-id="${f.userId}">
                <div class="friend-status-dot ${f.status}"></div>
                <span class="friend-name">${f.username}</span>
                ${rankHtml}
                <span class="friend-status-text">${statusLabel}</span>
                <button class="friend-invite-btn" data-user-id="${f.userId}" ${canInvite ? '' : 'disabled'}>${canInvite ? 'Invite' : statusLabel}</button>
                <button class="friend-remove-btn" data-user-id="${f.userId}" title="Remove friend">\u2715</button>
            </div>`;
        }).join('');

        container.querySelectorAll('.friend-invite-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const userId = parseInt(btn.dataset.userId);
                CurlingNetwork.sendGameInvite(userId);
                btn.textContent = 'Sent';
                btn.disabled = true;
            });
        });

        container.querySelectorAll('.friend-remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const userId = parseInt(btn.dataset.userId);
                CurlingNetwork.removeFriend(userId);
            });
        });
    }

    function renderPendingRequests(incoming, outgoing) {
        pendingRequests = { incoming, outgoing };
        const section = document.getElementById('friend-requests-section');
        const container = document.getElementById('friend-requests-list');

        if (incoming.length === 0 && outgoing.length === 0) {
            section.style.display = 'none';
            updateFriendsBadge(0);
            return;
        }
        section.style.display = 'block';

        let html = '';
        incoming.forEach(req => {
            html += `<div class="friend-request-item">
                <span class="request-name">${req.username}</span>
                <button class="request-accept-btn" data-user-id="${req.id}">Accept</button>
                <button class="request-deny-btn" data-user-id="${req.id}">Deny</button>
            </div>`;
        });
        outgoing.forEach(req => {
            html += `<div class="friend-request-item">
                <span class="request-name">${req.username}</span>
                <span style="color:#888;font-size:11px;">Pending</span>
            </div>`;
        });
        container.innerHTML = html;

        container.querySelectorAll('.request-accept-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                CurlingNetwork.acceptFriendRequest(parseInt(btn.dataset.userId));
            });
        });
        container.querySelectorAll('.request-deny-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                CurlingNetwork.denyFriendRequest(parseInt(btn.dataset.userId));
            });
        });

        updateFriendsBadge(incoming.length);
    }

    function updateFriendsBadge(count) {
        const btn = document.getElementById('lobby-friends');
        let badge = btn.querySelector('.friend-notification-badge');
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'friend-notification-badge';
                btn.appendChild(badge);
            }
            badge.textContent = count;
        } else if (badge) {
            badge.remove();
        }
    }

    function showGameInvite(inviteId, fromUsername, fromRank) {
        const overlay = document.getElementById('game-invite-overlay');
        let text = fromUsername + ' wants to play!';
        if (fromRank) {
            text = `<span class="rank-badge" style="background:${fromRank.color}">${fromRank.name}</span> ${fromUsername} wants to play!`;
        }
        document.getElementById('invite-from-text').innerHTML = text;
        document.getElementById('invite-accept-btn').dataset.inviteId = inviteId;
        document.getElementById('invite-deny-btn').dataset.inviteId = inviteId;
        overlay.style.display = 'block';
    }

    function hideGameInvite() {
        document.getElementById('game-invite-overlay').style.display = 'none';
    }

    function animateOpponentSliders(aim, weight, spinDir, spinAmount, callback) {
        if (spinDir >= 0) {
            document.getElementById('spin-cw').classList.add('active');
            document.getElementById('spin-ccw').classList.remove('active');
            document.getElementById('spin-value').textContent = 'In-turn';
        } else {
            document.getElementById('spin-ccw').classList.add('active');
            document.getElementById('spin-cw').classList.remove('active');
            document.getElementById('spin-value').textContent = 'Out-turn';
        }

        const aimSlider = document.getElementById('aim-slider');
        const weightSlider = document.getElementById('weight-slider');
        const spinAmountSlider = document.getElementById('spin-amount-slider');

        const duration = 400;
        const startTime = performance.now();
        const startAim = parseFloat(aimSlider.value);
        const startWeight = parseFloat(weightSlider.value);
        const startSpin = parseFloat(spinAmountSlider.value);

        function tick(now) {
            const t = Math.min(1, (now - startTime) / duration);
            const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

            aimSlider.value = startAim + (aim - startAim) * ease;
            weightSlider.value = startWeight + (weight - startWeight) * ease;
            spinAmountSlider.value = startSpin + (spinAmount - startSpin) * ease;

            document.getElementById('aim-value').textContent = parseFloat(aimSlider.value).toFixed(1) + '\u00B0';
            document.getElementById('weight-value').textContent = CurlingPhysics.weightLabel(parseFloat(weightSlider.value));
            document.getElementById('spin-amount-value').textContent = parseFloat(spinAmountSlider.value).toFixed(1);

            if (t < 1) {
                requestAnimationFrame(tick);
            } else {
                if (callback) callback();
            }
        }
        requestAnimationFrame(tick);
    }

    function setupOnlineHandlers() {
        CurlingNetwork.onGameStart(({ yourTeam, opponent }) => {
            gameState.myTeam = yourTeam;
            gameState.onlineMode = true;
            gameState.botMode = false;
            gameState.roomCode = CurlingNetwork.getRoomCode();
            gameState.opponentInfo = opponent;

            // Brief "starting" panel
            showLobbyPanel('lobby-starting-panel');
            showOpponentStartInfo(opponent);
            const teamLabel = document.getElementById('your-team-label');
            teamLabel.textContent = yourTeam === 'red' ? 'Red' : 'Yellow';
            teamLabel.style.color = yourTeam === 'red' ? '#e53935' : '#fdd835';

            setTimeout(() => {
                hideLobbyScreen();
                resetGame();
                showOnlineTeamBadge();
                updateScoreboardNames();
                updateUI();
                if (isMyTurn()) {
                    enableControlsForHuman();
                    document.getElementById('throw-btn').disabled = false;
                    TabNotify.notify();
                } else {
                    disableControlsForBot();
                    document.getElementById('throw-btn').disabled = true;
                }
            }, 1500);
        });

        CurlingNetwork.onOpponentThrow(({ aim, weight, spinDir, spinAmount }) => {
            animateOpponentSliders(aim, weight, spinDir, spinAmount, () => {
                deliverStoneWithParams(aim, weight, spinDir, spinAmount);
            });
        });

        CurlingNetwork.onOpponentSweepChange(({ level }) => {
            gameState.sweepLevel = level;
            document.querySelectorAll('.sweep-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('sweep-' + level).classList.add('active');
        });

        CurlingNetwork.onOpponentSweepStart(() => {
            gameState.isSweeping = true;
            if (gameState.sweepLevel === 'none') {
                gameState.sweepLevel = 'hard';
                document.querySelectorAll('.sweep-btn').forEach(b => b.classList.remove('active'));
                document.getElementById('sweep-hard').classList.add('active');
            }
            document.getElementById('sweep-toggle-btn').classList.add('sweeping');
            document.getElementById('sweep-toggle-btn').textContent = 'SWEEPING!';
        });

        CurlingNetwork.onOpponentSweepStop(() => {
            gameState.isSweeping = false;
            document.getElementById('sweep-toggle-btn').classList.remove('sweeping');
            document.getElementById('sweep-toggle-btn').textContent = 'SWEEP';
        });

        CurlingNetwork.onOpponentDisconnected(() => {
            gameState.opponentConnected = false;
            showDisconnectOverlay();
        });

        CurlingNetwork.onOpponentReconnected(({ opponent }) => {
            gameState.opponentConnected = true;
            if (opponent) {
                gameState.opponentInfo = opponent;
                updateScoreboardNames();
            }
            hideDisconnectOverlay();
        });

        CurlingNetwork.onOpponentLeft(() => {
            gameState.opponentConnected = false;
            hideDisconnectOverlay();
            clearOnlineMode();
            resetGame();
        });

        CurlingNetwork.onRematchRequested(() => {
            // Auto-accept for simplicity: show a brief notification then start
            const rematchBtn = document.getElementById('rematch-btn');
            rematchBtn.textContent = 'Opponent wants rematch!';
        });

        CurlingNetwork.onRematchAccepted(({ yourTeam, opponent }) => {
            gameState.myTeam = yourTeam;
            gameState.opponentInfo = opponent;
            document.getElementById('game-over-screen').style.display = 'none';
            resetGame();
            showOnlineTeamBadge();
            updateScoreboardNames();
            updateUI();
            if (isMyTurn()) {
                enableControlsForHuman();
                document.getElementById('throw-btn').disabled = false;
                TabNotify.notify();
            } else {
                disableControlsForBot();
                document.getElementById('throw-btn').disabled = true;
            }
        });

        CurlingNetwork.onRoomCreated(({ code }) => {
            document.getElementById('room-code-display').textContent = code;
            showLobbyPanel('lobby-create-panel');
        });

        CurlingNetwork.onRoomJoined(() => {
            // Game will start via onGameStart
        });

        CurlingNetwork.onRoomError(({ error }) => {
            const joinError = document.getElementById('join-error');
            joinError.textContent = error;
            joinError.style.display = 'block';
        });

        CurlingNetwork.onQueueWaiting(() => {
            showLobbyPanel('lobby-queue-panel');
        });

        CurlingNetwork.onRoomExpired(() => {
            showLobbyPanel('lobby-menu');
        });

        CurlingNetwork.onReconnected(({ yourTeam, gameSnapshot, opponent }) => {
            gameState.myTeam = yourTeam;
            gameState.onlineMode = true;
            gameState.opponentConnected = true;
            gameState.opponentInfo = opponent;
            hideDisconnectOverlay();
            showOnlineTeamBadge();
            updateScoreboardNames();

            if (gameSnapshot) {
                // Resync from server snapshot
                gameState.redScore = gameSnapshot.redScore || 0;
                gameState.yellowScore = gameSnapshot.yellowScore || 0;
                gameState.currentEnd = gameSnapshot.currentEnd || 1;
                gameState.redThrown = gameSnapshot.redThrown || 0;
                gameState.yellowThrown = gameSnapshot.yellowThrown || 0;
                gameState.hammer = gameSnapshot.hammer || TEAMS.YELLOW;
                gameState.endScores = gameSnapshot.endScores || [];
                gameState.currentTeam = gameSnapshot.currentTeam || TEAMS.RED;
                gameState.phase = 'aiming';

                // Rebuild stones from snapshot positions
                if (gameSnapshot.stones && gameSnapshot.stones.length > 0) {
                    gameState.stones = gameSnapshot.stones.map(s => {
                        const stone = CurlingPhysics.createStone(s.team, s.x, s.y, 0, 0, 0);
                        stone.active = true;
                        stone.moving = false;
                        return stone;
                    });
                }

                // Update UI
                document.getElementById('red-total').textContent = gameState.redScore;
                document.getElementById('yellow-total').textContent = gameState.yellowScore;
                document.getElementById('current-end').textContent = gameState.currentEnd;
                updateUI();
            }

            if (isMyTurn()) {
                enableControlsForHuman();
                document.getElementById('throw-btn').disabled = false;
                TabNotify.notify();
            } else {
                disableControlsForBot();
                document.getElementById('throw-btn').disabled = true;
            }
        });

        CurlingNetwork.onDisconnect(() => {
            // Network disconnected - reconnection is handled by network.js
        });

        CurlingNetwork.onReconnectFailed(() => {
            clearOnlineMode();
            resetGame();
            hideLobbyScreen();
            hideDisconnectOverlay();
        });

        // ---- FRIENDS & INVITE HANDLERS ----
        CurlingNetwork.onFriendsList(({ friends }) => {
            friendsList = friends || [];
            renderFriendsList(friendsList);
        });

        CurlingNetwork.onPendingRequests(({ incoming, outgoing }) => {
            pendingRequests = { incoming: incoming || [], outgoing: outgoing || [] };
            renderPendingRequests(pendingRequests.incoming, pendingRequests.outgoing);
        });

        CurlingNetwork.onFriendRequestSent(() => {
            const successEl = document.getElementById('friend-add-success');
            successEl.textContent = 'Friend request sent!';
            successEl.style.display = 'block';
            document.getElementById('friend-add-error').style.display = 'none';
            document.getElementById('friend-username-input').value = '';
            setTimeout(() => { successEl.style.display = 'none'; }, 3000);
            CurlingNetwork.getPendingRequests();
        });

        CurlingNetwork.onFriendRequestReceived(({ fromUsername }) => {
            // Refresh pending requests to update badge and list
            CurlingNetwork.getPendingRequests();
        });

        CurlingNetwork.onFriendRequestAccepted(({ friendId, friendUsername }) => {
            // Refresh both lists
            CurlingNetwork.getFriendsList();
            CurlingNetwork.getPendingRequests();
        });

        CurlingNetwork.onFriendRequestDenied(() => {
            CurlingNetwork.getPendingRequests();
        });

        CurlingNetwork.onFriendRequestError(({ error }) => {
            const errEl = document.getElementById('friend-add-error');
            errEl.textContent = error;
            errEl.style.display = 'block';
            document.getElementById('friend-add-success').style.display = 'none';
            setTimeout(() => { errEl.style.display = 'none'; }, 4000);
        });

        CurlingNetwork.onFriendRemoved(({ friendId }) => {
            friendsList = friendsList.filter(f => f.userId !== friendId);
            renderFriendsList(friendsList);
        });

        CurlingNetwork.onFriendPresence(({ friendId, status }) => {
            const friend = friendsList.find(f => f.userId === friendId);
            if (friend) {
                friend.status = status;
                renderFriendsList(friendsList);
            }
        });

        CurlingNetwork.onGameInviteSent(() => {
            // Invite sent successfully — could show "Invite sent" feedback
        });

        CurlingNetwork.onGameInviteReceived(({ inviteId, fromUsername, fromRank }) => {
            showGameInvite(inviteId, fromUsername, fromRank);
        });

        CurlingNetwork.onGameInviteError(({ error }) => {
            const errEl = document.getElementById('friend-add-error');
            errEl.textContent = error;
            errEl.style.display = 'block';
            setTimeout(() => { errEl.style.display = 'none'; }, 4000);
        });

        CurlingNetwork.onGameInviteDenied(({ toUsername }) => {
            // Opponent denied invite — could notify
        });

        CurlingNetwork.onGameInviteCancelled(() => {
            hideGameInvite();
        });

        // ---- AUTH HANDLERS ----
        CurlingNetwork.onAuthSuccess(({ token, username, rank }) => {
            localStorage.setItem('curling_token', token);
            localStorage.setItem('curling_username', username);
            document.getElementById('auth-panel').style.display = 'none';
            document.getElementById('user-info-bar').style.display = 'flex';
            document.getElementById('logged-in-as').textContent = username;
            // Show rank badge
            if (rank) {
                updateRankBadge(rank);
            }
            showLobbyPanel('lobby-menu');
            CurlingNetwork.sendGetProfile();
            // Set up push notifications for logged-in users
            PushSetup.setup();
            // Show friends button for logged-in users
            document.getElementById('lobby-friends').style.display = '';
        });

        CurlingNetwork.onVapidKey(({ key }) => {
            PushSetup.onVapidKey(key);
        });

        CurlingNetwork.onAuthError(({ error }) => {
            const errEl = document.getElementById('auth-error');
            errEl.textContent = error;
            errEl.style.display = 'block';
        });

        CurlingNetwork.onProfileData(({ profile }) => {
            if (profile) {
                document.getElementById('user-record').textContent =
                    `${profile.wins}W / ${profile.losses}L / ${profile.draws}D`;
                if (profile.rank) {
                    updateRankBadge(profile.rank);
                }
            }
        });

        CurlingNetwork.onRatingUpdate(({ rank }) => {
            if (rank) {
                updateRankBadge(rank);
                // Show rating change on game over screen
                const ratingInfo = document.getElementById('rating-update-info');
                if (ratingInfo) {
                    ratingInfo.innerHTML = `<span class="rank-badge" style="background:${rank.color}">${rank.name}</span> <span style="color:#aaa">${rank.rating} ELO</span>`;
                    ratingInfo.style.display = 'block';
                }
                // Refresh profile to update W/L
                CurlingNetwork.sendGetProfile();
            }
        });

        CurlingNetwork.onSecurityQuestion(({ question }) => {
            document.getElementById('auth-error').style.display = 'none';
            document.getElementById('recovery-step-1').style.display = 'none';
            document.getElementById('recovery-step-2').style.display = 'flex';
            document.getElementById('recovery-question-text').textContent = question;
            document.getElementById('recovery-answer').value = '';
            document.getElementById('recovery-new-password').value = '';
        });

        CurlingNetwork.onPasswordResetSuccess(() => {
            document.getElementById('auth-error').style.display = 'none';
            document.getElementById('recovery-step-1').style.display = 'none';
            document.getElementById('recovery-step-2').style.display = 'none';
            document.getElementById('recovery-success').style.display = 'block';
        });
    }

    // Online mode button
    document.getElementById('mode-online').addEventListener('click', () => {
        document.getElementById('mode-online').classList.add('active');
        document.getElementById('mode-1p').classList.remove('active');
        document.getElementById('mode-2p').classList.remove('active');
        document.getElementById('difficulty-selector').classList.add('hidden');
        settingsDropdown.classList.remove('open');
        settingsToggle.classList.remove('active');

        // Connect and show lobby
        CurlingNetwork.connect(SERVER_URL).then(() => {
            showLobbyScreen();

            // Check for saved auth token
            const savedToken = localStorage.getItem('curling_token');
            const savedUsername = localStorage.getItem('curling_username');
            if (savedToken) {
                CurlingNetwork.sendTokenLogin(savedToken);
                // Show user info bar optimistically
                if (savedUsername) {
                    document.getElementById('auth-panel').style.display = 'none';
                    document.getElementById('user-info-bar').style.display = 'flex';
                    document.getElementById('logged-in-as').textContent = savedUsername;
                    showLobbyPanel('lobby-menu');
                }
            } else {
                // Show auth panel
                document.getElementById('auth-panel').style.display = 'flex';
                document.getElementById('user-info-bar').style.display = 'none';
                document.getElementById('lobby-menu').style.display = 'none';
            }
        }).catch(() => {
            document.getElementById('mode-online').classList.remove('active');
            document.getElementById('mode-1p').classList.add('active');
            document.getElementById('difficulty-selector').classList.remove('hidden');
            alert('Could not connect to server. Make sure the server is running.');
        });
    });

    // Lobby button handlers
    document.getElementById('lobby-create').addEventListener('click', () => {
        CurlingNetwork.createRoom();
    });

    document.getElementById('lobby-join').addEventListener('click', () => {
        showLobbyPanel('lobby-join-panel');
        document.getElementById('join-error').style.display = 'none';
        document.getElementById('room-code-input').value = '';
        document.getElementById('room-code-input').focus();
    });

    document.getElementById('lobby-join-submit').addEventListener('click', () => {
        const code = document.getElementById('room-code-input').value.trim();
        if (code.length !== 4) {
            document.getElementById('join-error').textContent = 'Code must be 4 characters';
            document.getElementById('join-error').style.display = 'block';
            return;
        }
        document.getElementById('join-error').style.display = 'none';
        CurlingNetwork.joinRoom(code);
    });

    document.getElementById('room-code-input').addEventListener('keydown', (e) => {
        if (e.code === 'Enter') {
            document.getElementById('lobby-join-submit').click();
        }
    });

    document.getElementById('lobby-queue').addEventListener('click', () => {
        CurlingNetwork.joinQueue();
    });

    document.getElementById('lobby-back').addEventListener('click', () => {
        CurlingNetwork.disconnect();
        hideLobbyScreen();
        document.getElementById('mode-online').classList.remove('active');
        document.getElementById('mode-1p').classList.add('active');
        document.getElementById('difficulty-selector').classList.remove('hidden');
        document.getElementById('user-info-bar').style.display = 'none';
        document.getElementById('auth-panel').style.display = 'none';
    });

    document.getElementById('lobby-cancel-create').addEventListener('click', () => {
        CurlingNetwork.sendLeave();
        showLobbyPanel('lobby-menu');
    });

    document.getElementById('lobby-cancel-join').addEventListener('click', () => {
        showLobbyPanel('lobby-menu');
    });

    document.getElementById('lobby-cancel-queue').addEventListener('click', () => {
        CurlingNetwork.leaveQueue();
        showLobbyPanel('lobby-menu');
    });

    document.getElementById('disconnect-leave').addEventListener('click', () => {
        hideDisconnectOverlay();
        clearOnlineMode();
        resetGame();
    });

    // Rematch / Leave buttons on game over screen
    document.getElementById('rematch-btn').addEventListener('click', () => {
        CurlingNetwork.sendRematch();
        document.getElementById('rematch-btn').textContent = 'Waiting...';
        document.getElementById('rematch-btn').disabled = true;
    });

    document.getElementById('leave-btn').addEventListener('click', () => {
        document.getElementById('game-over-screen').style.display = 'none';
        clearOnlineMode();
        resetGame();
    });

    // --------------------------------------------------------
    // FRIENDS & INVITE BUTTON HANDLERS
    // --------------------------------------------------------
    document.getElementById('lobby-friends').addEventListener('click', () => {
        showLobbyPanel('lobby-friends-panel');
        CurlingNetwork.getFriendsList();
        CurlingNetwork.getPendingRequests();
    });

    document.getElementById('lobby-friends-back').addEventListener('click', () => {
        showLobbyPanel('lobby-menu');
    });

    document.getElementById('friend-add-btn').addEventListener('click', () => {
        const username = document.getElementById('friend-username-input').value.trim();
        if (!username) return;
        document.getElementById('friend-add-error').style.display = 'none';
        document.getElementById('friend-add-success').style.display = 'none';
        CurlingNetwork.sendFriendRequest(username);
    });

    document.getElementById('friend-username-input').addEventListener('keydown', (e) => {
        if (e.code === 'Enter') document.getElementById('friend-add-btn').click();
    });

    document.getElementById('invite-accept-btn').addEventListener('click', () => {
        const inviteId = document.getElementById('invite-accept-btn').dataset.inviteId;
        if (inviteId) {
            CurlingNetwork.acceptGameInvite(inviteId);
        }
        hideGameInvite();
    });

    document.getElementById('invite-deny-btn').addEventListener('click', () => {
        const inviteId = document.getElementById('invite-deny-btn').dataset.inviteId;
        if (inviteId) {
            CurlingNetwork.denyGameInvite(inviteId);
        }
        hideGameInvite();
    });

    // --------------------------------------------------------
    // AUTH BUTTON HANDLERS
    // --------------------------------------------------------
    document.getElementById('auth-login-tab').addEventListener('click', () => {
        document.getElementById('auth-login-tab').classList.add('active');
        document.getElementById('auth-register-tab').classList.remove('active');
        document.getElementById('auth-login-form').style.display = 'flex';
        document.getElementById('auth-register-form').style.display = 'none';
        document.getElementById('auth-error').style.display = 'none';
    });

    document.getElementById('auth-register-tab').addEventListener('click', () => {
        document.getElementById('auth-register-tab').classList.add('active');
        document.getElementById('auth-login-tab').classList.remove('active');
        document.getElementById('auth-register-form').style.display = 'flex';
        document.getElementById('auth-login-form').style.display = 'none';
        document.getElementById('auth-error').style.display = 'none';
    });

    document.getElementById('auth-login-btn').addEventListener('click', () => {
        const username = document.getElementById('auth-username').value.trim();
        const password = document.getElementById('auth-password').value;
        if (!username || !password) {
            document.getElementById('auth-error').textContent = 'Enter username and password';
            document.getElementById('auth-error').style.display = 'block';
            return;
        }
        document.getElementById('auth-error').style.display = 'none';
        CurlingNetwork.sendLogin(username, password);
    });

    document.getElementById('auth-password').addEventListener('keydown', (e) => {
        if (e.code === 'Enter') document.getElementById('auth-login-btn').click();
    });

    document.getElementById('auth-register-btn').addEventListener('click', () => {
        const username = document.getElementById('reg-username').value.trim();
        const password = document.getElementById('reg-password').value;
        const country = document.getElementById('reg-country').value;
        const securityQuestion = document.getElementById('reg-security-question').value;
        const securityAnswer = document.getElementById('reg-security-answer').value.trim();
        if (!username || !password) {
            document.getElementById('auth-error').textContent = 'Enter username and password';
            document.getElementById('auth-error').style.display = 'block';
            return;
        }
        if (!securityQuestion || !securityAnswer) {
            document.getElementById('auth-error').textContent = 'Security question and answer required';
            document.getElementById('auth-error').style.display = 'block';
            return;
        }
        document.getElementById('auth-error').style.display = 'none';
        CurlingNetwork.sendRegister(username, password, country, securityQuestion, securityAnswer);
    });

    document.getElementById('reg-security-answer').addEventListener('keydown', (e) => {
        if (e.code === 'Enter') document.getElementById('auth-register-btn').click();
    });

    document.getElementById('auth-skip').addEventListener('click', () => {
        document.getElementById('auth-panel').style.display = 'none';
        document.getElementById('lobby-friends').style.display = 'none';
        showLobbyPanel('lobby-menu');
    });

    // ---- PASSWORD RECOVERY ----
    let recoveryUsername = '';

    document.getElementById('forgot-password-link').addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('auth-login-form').style.display = 'none';
        document.getElementById('auth-register-form').style.display = 'none';
        document.getElementById('auth-tabs').style.display = 'none';
        document.getElementById('auth-recovery-form').style.display = 'flex';
        document.getElementById('recovery-step-1').style.display = 'flex';
        document.getElementById('recovery-step-2').style.display = 'none';
        document.getElementById('recovery-success').style.display = 'none';
        document.getElementById('auth-error').style.display = 'none';
        document.getElementById('recovery-username').value = '';
        document.getElementById('recovery-answer').value = '';
        document.getElementById('recovery-new-password').value = '';
    });

    document.getElementById('recovery-back-link').addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('auth-recovery-form').style.display = 'none';
        document.getElementById('auth-tabs').style.display = 'flex';
        document.getElementById('auth-login-form').style.display = 'flex';
        document.getElementById('auth-login-tab').classList.add('active');
        document.getElementById('auth-register-tab').classList.remove('active');
        document.getElementById('auth-error').style.display = 'none';
    });

    document.getElementById('recovery-next-btn').addEventListener('click', () => {
        recoveryUsername = document.getElementById('recovery-username').value.trim();
        if (!recoveryUsername) {
            document.getElementById('auth-error').textContent = 'Enter your username';
            document.getElementById('auth-error').style.display = 'block';
            return;
        }
        document.getElementById('auth-error').style.display = 'none';
        CurlingNetwork.sendGetSecurityQuestion(recoveryUsername);
    });

    document.getElementById('recovery-username').addEventListener('keydown', (e) => {
        if (e.code === 'Enter') document.getElementById('recovery-next-btn').click();
    });

    document.getElementById('recovery-reset-btn').addEventListener('click', () => {
        const answer = document.getElementById('recovery-answer').value.trim();
        const newPassword = document.getElementById('recovery-new-password').value;
        if (!answer) {
            document.getElementById('auth-error').textContent = 'Enter your answer';
            document.getElementById('auth-error').style.display = 'block';
            return;
        }
        if (!newPassword || newPassword.length < 4) {
            document.getElementById('auth-error').textContent = 'New password must be at least 4 characters';
            document.getElementById('auth-error').style.display = 'block';
            return;
        }
        document.getElementById('auth-error').style.display = 'none';
        CurlingNetwork.sendResetPassword(recoveryUsername, answer, newPassword);
    });

    document.getElementById('recovery-new-password').addEventListener('keydown', (e) => {
        if (e.code === 'Enter') document.getElementById('recovery-reset-btn').click();
    });

    document.getElementById('auth-logout').addEventListener('click', () => {
        localStorage.removeItem('curling_token');
        localStorage.removeItem('curling_username');
        document.getElementById('user-info-bar').style.display = 'none';
        document.getElementById('auth-panel').style.display = 'flex';
        document.getElementById('lobby-menu').style.display = 'none';
        document.getElementById('user-record').textContent = '';
        document.getElementById('user-rank-badge').style.display = 'none';
        document.getElementById('user-rating').textContent = '';
        document.getElementById('lobby-friends').style.display = 'none';
        friendsList = [];
        pendingRequests = { incoming: [], outgoing: [] };
    });

    // Register online handlers immediately
    setupOnlineHandlers();

    // --------------------------------------------------------
    // WELCOME SCREEN
    // --------------------------------------------------------
    function dismissWelcome() {
        const ws = document.getElementById('welcome-screen');
        if (ws) {
            ws.style.opacity = '0';
            ws.style.transition = 'opacity 0.25s';
            setTimeout(() => ws.remove(), 250);
        }
    }

    document.getElementById('welcome-1p').addEventListener('click', () => {
        dismissWelcome();
        document.getElementById('mode-1p').click();
    });

    document.getElementById('welcome-2p').addEventListener('click', () => {
        dismissWelcome();
        document.getElementById('mode-2p').click();
    });

    document.getElementById('welcome-online').addEventListener('click', () => {
        dismissWelcome();
        document.getElementById('mode-online').click();
    });

    // --------------------------------------------------------
    // INIT
    // --------------------------------------------------------
    resizeCanvas();
    updateUI();
    // Deferred resize to catch mobile layout after UI panel is measured
    requestAnimationFrame(() => {
        resizeCanvas();
        requestAnimationFrame(gameLoop);
    });

})();
