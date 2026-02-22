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
        totalEnds: 4,
        redScore: 0,
        yellowScore: 0,
        endScores: [],
        phase: 'aiming',    // 'aiming', 'delivering', 'settling', 'scoring', 'gameover', 'waitingNextTurn'
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
        lastOpponentShot: null,         // { aim, weight, spinDir, spinAmount }
        lastOpponentShotStones: null,   // snapshot of stone positions before the shot
        isReplaying: false,             // true during replay animation
        _nextTurnScheduled: false,      // guard: prevents double nextTurn() calls
        _awaitingConnectionVerify: false, // true while waiting for pong after tab refocus
        _opponentThrowPending: false,   // true while waiting for opponent's throw to settle
        _myThrowInFlight: false,        // v115b: true while my own throw is in flight (for sweep)
        // Legacy fields kept for local/bot mode
        _preThrowSnapshot: null,
        _throwSweepLevel: 'none',
        _sweepTimeline: [],
        _simStepCount: 0,
        _workerActive: false,           // v105: only used for local/bot mode now
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

        let _pendingDing = false; // true if we tried to ding but audio was suspended

        function playTone() {
            try {
                const ctx = getCtx();
                if (ctx.state === 'suspended') {
                    _pendingDing = true;
                    ctx.resume(); // will play when tab returns and context resumes
                    return;
                }
                _pendingDing = false;
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

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                stopFlash();
                // Play the ding we couldn't play while tab was hidden
                if (_pendingDing) playTone();
            }
        });

        return {
            notify() {
                playTone(); // always try to ding
                if (document.hidden) startFlash(); // title flash only when hidden
            },
            stop() { stopFlash(); _pendingDing = false; },
        };
    })();

    // --------------------------------------------------------
    // ON-SCREEN DEBUG LOG (for mobile debugging)
    // Triple-tap on beta version text to activate.
    // --------------------------------------------------------
    const DebugPanel = (() => {
        const MAX_LINES = 500;
        let _enabled = false;
        const _lines = [];

        // Triple-tap gesture on beta version text to toggle
        let _tapCount = 0;
        let _tapTimer = null;
        const betaEl = document.getElementById('beta-version');
        if (betaEl) {
            betaEl.addEventListener('click', () => {
                _tapCount++;
                if (_tapTimer) clearTimeout(_tapTimer);
                _tapTimer = setTimeout(() => { _tapCount = 0; }, 600);
                if (_tapCount >= 3) {
                    _tapCount = 0;
                    toggle();
                }
            });
        }

        function toggle() {
            _enabled = !_enabled;
            document.getElementById('debug-toggle').style.display = _enabled ? 'block' : 'none';
            if (!_enabled) {
                document.getElementById('debug-panel').style.display = 'none';
            }
        }

        // Hook console.log/warn/error to capture entries
        const origLog = console.log;
        const origWarn = console.warn;
        const origError = console.error;

        function addLine(level, args) {
            const ts = new Date().toTimeString().split(' ')[0]; // HH:MM:SS
            const text = Array.from(args).map(a => {
                if (typeof a === 'object') {
                    try { return JSON.stringify(a); } catch { return String(a); }
                }
                return String(a);
            }).join(' ');

            _lines.push({ ts, level, text });
            if (_lines.length > MAX_LINES) _lines.shift();

            if (_enabled && document.getElementById('debug-panel').style.display !== 'none') {
                appendToDOM({ ts, level, text });
            }
        }

        function appendToDOM(entry) {
            const logEl = document.getElementById('debug-log');
            if (!logEl) return;
            const div = document.createElement('div');
            div.className = entry.level === 'error' ? 'debug-error' : entry.level === 'warn' ? 'debug-warn' : '';
            div.textContent = '[' + entry.ts + '] ' + entry.text;
            logEl.appendChild(div);
            logEl.scrollTop = logEl.scrollHeight;
            // Trim DOM nodes
            while (logEl.children.length > MAX_LINES) logEl.removeChild(logEl.firstChild);
        }

        console.log = function () { origLog.apply(console, arguments); addLine('log', arguments); };
        console.warn = function () { origWarn.apply(console, arguments); addLine('warn', arguments); };
        console.error = function () { origError.apply(console, arguments); addLine('error', arguments); };

        // v111: Direct log entry (bypasses console to avoid double-capture)
        function log(msg) {
            addLine('info', [msg]);
        }

        // v111: Copy full log buffer to clipboard with diagnostic header
        function copyLogs() {
            const header = '=== Capital Curling Club Debug Log ===\n'
                + 'Exported: ' + new Date().toISOString() + '\n'
                + 'Version: ' + (document.getElementById('beta-version')?.textContent || '?') + '\n'
                + 'UA: ' + navigator.userAgent + '\n'
                + 'Lines: ' + _lines.length + '/' + MAX_LINES + '\n'
                + '======================================\n\n';
            const text = header + _lines.map(e =>
                '[' + e.ts + '] ' + (e.level === 'error' ? 'ERROR ' : e.level === 'warn' ? 'WARN ' : '') + e.text
            ).join('\n');

            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text).then(() => true).catch(() => _fallbackCopy(text));
            }
            return Promise.resolve(_fallbackCopy(text));
        }

        function _fallbackCopy(text) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (e) { return false; }
            document.body.removeChild(ta);
            return true;
        }

        // Wire up toggle button and close button
        document.getElementById('debug-toggle')?.addEventListener('click', () => {
            const panel = document.getElementById('debug-panel');
            if (panel.style.display === 'none') {
                panel.style.display = 'flex';
                // Render buffered lines
                const logEl = document.getElementById('debug-log');
                logEl.innerHTML = '';
                _lines.forEach(entry => appendToDOM(entry));
            } else {
                panel.style.display = 'none';
            }
        });

        document.getElementById('debug-close')?.addEventListener('click', () => {
            document.getElementById('debug-panel').style.display = 'none';
        });

        // v111: Copy logs button
        document.getElementById('debug-copy')?.addEventListener('click', () => {
            copyLogs().then(ok => {
                const btn = document.getElementById('debug-copy');
                if (btn) {
                    const orig = btn.textContent;
                    btn.textContent = ok ? 'Copied!' : 'Failed';
                    setTimeout(() => { btn.textContent = orig; }, 1500);
                }
            });
        });

        return { toggle, isEnabled: () => _enabled, log, copyLogs };
    })();

    // --------------------------------------------------------
    // GLOBAL ERROR HANDLERS (v111 — feed into DebugPanel buffer)
    // --------------------------------------------------------
    window.onerror = function (message, source, lineno, colno, error) {
        const file = (source || '').split('/').pop();
        console.error('[UNCAUGHT] ' + message + ' @ ' + file + ':' + lineno + ':' + colno);
        if (error && error.stack) {
            console.error('[STACK] ' + error.stack.substring(0, 400));
        }
        return false;
    };

    window.addEventListener('unhandledrejection', function (event) {
        const reason = event.reason;
        const msg = reason instanceof Error
            ? reason.message + (reason.stack ? ' | ' + reason.stack.substring(0, 400) : '')
            : String(reason);
        console.error('[UNHANDLED_PROMISE] ' + msg);
    });

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

    // Set up throw controls based on whose turn it is.
    // Called after reconnect, visibility change, authoritative state, etc.
    // v101: Removed CONNECTING... gating — the Welcome Back popup is the gate now.
    function setupTurnControls() {
        const throwBtn = document.getElementById('throw-btn');
        if (isMyTurn()) {
            enableControlsForHuman();
            throwBtn.style.display = '';
            throwBtn.disabled = false;
            throwBtn.textContent = 'THROW';
            throwBtn.classList.remove('connecting');
            TabNotify.notify();

            if (gameState.lastOpponentShot) {
                showReplayButton();
            }
        } else {
            disableControlsForBot();
            throwBtn.disabled = true;
            throwBtn.textContent = 'THROW';
            throwBtn.classList.remove('connecting');
        }
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
    let extraEndNotice = null; // { timer }

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
            // FGZ rule: a protected guard stone can be HIT and moved — that's
            // legal and the stone stays wherever it ends up (even into the house).
            // The violation ONLY occurs if the guard is knocked completely OUT
            // OF PLAY (deactivated / out of bounds). Moving it is fine.
            if (!stone.active) {
                // Stone was removed from play — restore it to pre-throw position
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

        // v112: Online throws no longer use Worker — server runs physics.
        // Worker is only used for local/bot mode replay.
    }

    function deliverStone() {
        const aimDeg = parseFloat(document.getElementById('aim-slider').value);
        const weightPct = parseFloat(document.getElementById('weight-slider').value);
        const spinAmount = parseFloat(document.getElementById('spin-amount-slider').value);
        const spinDir = document.getElementById('spin-cw').classList.contains('active') ? 1 : -1;

        console.log('[DELIVER] Throwing! currentTeam=' + gameState.currentTeam + ' myTeam=' + gameState.myTeam + ' redThrown=' + gameState.redThrown + ' yellowThrown=' + gameState.yellowThrown);

        // v107: Cancel any pending auto-replay — player wants to throw, not watch replay
        if (gameState._autoReplayTimeout) {
            clearTimeout(gameState._autoReplayTimeout);
            gameState._autoReplayTimeout = null;
        }
        // v107: Cancel any in-progress replay (restores real stone state first)
        if (gameState.isReplaying && gameState._replayRestore) {
            console.log('[DELIVER] Cancelling in-progress replay before throw');
            gameState._replayRestore();
        }

        // Hide replay button when throwing
        hideReplayButton();

        // v113: Online mode — send throw to server, server runs physics
        // Sweep is controlled by the NON-throwing player, not the thrower
        if (gameState.onlineMode) {
            const sent = CurlingNetwork.sendThrow({
                aim: aimDeg,
                weight: weightPct,
                spinDir,
                spinAmount,
                sweepLevel: 'none',
            });
            if (!sent) {
                console.error('[DELIVER] sendThrow failed — WS dead');
                const throwBtn = document.getElementById('throw-btn');
                throwBtn.disabled = true;
                throwBtn.textContent = 'RECONNECTING...';
                throwBtn.classList.add('connecting');
                gameState._awaitingConnectionVerify = true;
                return;
            }

            // v113d: Create local stone immediately for visual feedback.
            // sync_positions from server will update position every ~100ms.
            const stoneSpeed = CurlingPhysics.weightToSpeed(weightPct);
            const aimRad = aimDeg * Math.PI / 180;
            const startX = 0;
            const startY = P.hack + 1.0;
            const vx = stoneSpeed * Math.sin(aimRad);
            const vy = stoneSpeed * Math.cos(aimRad);
            const omega = CurlingPhysics.rotationsToAngularVelocity(spinAmount, stoneSpeed) * spinDir;

            const stone = createStone(gameState.currentTeam, startX, startY, vx, vy, omega);
            stone.moving = true;
            gameState.stones.push(stone);
            gameState.deliveredStone = stone;
            stoneTrail = [{ x: startX, y: startY }];

            gameState.phase = 'delivering';
            gameState._myThrowInFlight = true; // v115b: thrower can sweep their own stone
            VIEW.followStone = true;
            document.getElementById('throw-btn').disabled = true;
            document.getElementById('throw-btn').style.display = 'none';
            // v115b: Show sweep button for the thrower
            const sweepBtn = document.getElementById('sweep-toggle-btn');
            sweepBtn.style.display = 'block';
            sweepBtn.textContent = 'HOLD TO SWEEP';
            sweepBtn.classList.remove('sweeping', 'opponent-sweeping');
            gameState.isSweeping = false;
            gameState.sweepLevel = 'none';
            updateUI();
            return; // Server will send sync_positions + throw_result
        }

        // Local/bot mode — run physics on client (unchanged)
        // Reset sweep tracking for local throw
        gameState._throwSweepLevel = 'none';
        gameState._sweepTimeline = [];
        gameState._simStepCount = 0;
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
        // v112: In online mode, scoring is handled by the server. endEnd() only runs for local/bot.
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
            if (gameState.redScore === gameState.yellowScore) {
                gameState.totalEnds++;
                extraEndNotice = { timer: 2500 };
            } else {
                gameState.phase = 'gameover';
                showGameOver();
                return;
            }
        }

        gameState.currentEnd++;
        document.getElementById('current-end').textContent = gameState.currentEnd;

        if (result.team && result.points > 0) {
            gameState.currentTeam = result.team;
            gameState.hammer = result.team === TEAMS.RED ? TEAMS.YELLOW : TEAMS.RED;
        }

        stopPhysicsWorker();
        gameState.redThrown = 0;
        gameState.yellowThrown = 0;
        gameState.stones = [];
        gameState.phase = 'aiming';
        gameState.deliveredStone = null;
        gameState._nextTurnScheduled = false;
        gameState._awaitingConnectionVerify = false;
        gameState._opponentThrowPending = false;
        gameState._myThrowInFlight = false;

        updateUI();

        setTimeout(() => {
            if (isBotTurn()) {
                triggerBotTurn();
            } else {
                enableControlsForHuman();
                document.getElementById('throw-btn').disabled = false;
            }
        }, 500);
    }

    // v115: End summary popup — shown when an end completes in online (or local/bot) mode
    function showEndSummary(endNumber, scoringTeam, points, hammerTeam) {
        const overlay = document.getElementById('end-summary-overlay');
        const title = document.getElementById('end-summary-title');
        const result = document.getElementById('end-summary-result');
        const hammer = document.getElementById('end-summary-hammer');

        title.textContent = 'End ' + endNumber + ' Complete';

        if (!scoringTeam || points === 0) {
            // Blank end — no score
            result.textContent = 'Blank End \u2014 No Score';
            result.style.color = '#888';
        } else {
            // A team scored
            let teamName;
            if (gameState.onlineMode) {
                teamName = (scoringTeam === gameState.myTeam) ? 'You scored' : 'Opponent scored';
            } else if (gameState.botMode) {
                teamName = (scoringTeam === TEAMS.RED) ? 'You scored' : 'Bot scored';
            } else {
                teamName = scoringTeam.charAt(0).toUpperCase() + scoringTeam.slice(1) + ' scored';
            }
            result.textContent = teamName + ' ' + points + (points === 1 ? ' point' : ' points') + '!';
            result.style.color = (scoringTeam === TEAMS.RED) ? '#e53935' : '#fdd835';
        }

        // Hammer info for next end
        let hammerName;
        if (gameState.onlineMode) {
            hammerName = (hammerTeam === gameState.myTeam) ? 'You have' : 'Opponent has';
        } else if (gameState.botMode) {
            hammerName = (hammerTeam === TEAMS.RED) ? 'You have' : 'Bot has';
        } else {
            hammerName = hammerTeam.charAt(0).toUpperCase() + hammerTeam.slice(1) + ' has';
        }
        hammer.textContent = hammerName + ' the hammer \u{1F528}';

        overlay.style.display = 'flex';
    }

    // Continue button dismisses the end summary and sets up next turn
    document.getElementById('end-summary-continue').addEventListener('click', () => {
        document.getElementById('end-summary-overlay').style.display = 'none';
        gameState.phase = 'aiming';
        updateUI();
        setupTurnControls();

        // For local/bot mode, trigger bot turn if applicable
        if (!gameState.onlineMode && isBotTurn()) {
            triggerBotTurn();
        } else if (!gameState.onlineMode) {
            enableControlsForHuman();
            document.getElementById('throw-btn').disabled = false;
        }
    });

    // v116: Quick guide popup — shown once after first online login
    function showQuickGuide() {
        document.getElementById('quick-guide-overlay').style.display = 'flex';
    }

    document.getElementById('quick-guide-dismiss').addEventListener('click', () => {
        document.getElementById('quick-guide-overlay').style.display = 'none';
    });

    function showGameOver() {
        // Game is over — clear the active session so page refresh doesn't try to rejoin
        CurlingNetwork.clearActiveSession();

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

        // v111: Show copy debug logs button in online mode
        const copyLogsBtn = document.getElementById('gameover-copy-logs');
        if (copyLogsBtn) {
            copyLogsBtn.style.display = gameState.onlineMode ? 'inline-block' : 'none';
            copyLogsBtn.textContent = '\u{1F4CB} Copy Debug Logs';
        }
    }

    // --------------------------------------------------------
    // END-OF-END SAFETY NET
    // --------------------------------------------------------
    // Detects if the game is stuck with all 16 stones thrown but not in scoring.
    // This catches edge cases from reconnects, cached code, or timing issues.
    function checkEndOfEndStuck() {
        if (gameState.redThrown >= 8 && gameState.yellowThrown >= 8 &&
            gameState.phase !== 'scoring' && gameState.phase !== 'gameover' &&
            gameState.phase !== 'delivering' && gameState.phase !== 'settling') {
            console.log('[SAFETY] End-of-end stuck detected! phase=' + gameState.phase +
                ' redThrown=' + gameState.redThrown + ' yellowThrown=' + gameState.yellowThrown +
                ' — forcing scoring');
            gameState.phase = 'scoring';
            gameState.deliveredStone = null;
            VIEW.followStone = false;
            setTimeout(() => endEnd(), 1500);
            return true;
        }
        return false;
    }

    // Periodic safety: auto-detect stuck end-of-end in the game loop.
    // Only triggers when the game is in a PASSIVE phase (aiming/waitingNextTurn)
    // with all 16 stones thrown — never during active delivery or settling.
    // v112: Safety: if _opponentThrowPending or _myThrowInFlight stays true for too long
    // (e.g. throw_result was lost), recover after 10 seconds via ping.
    let _throwPendingTimer = 0;
    function checkOpponentThrowPendingTimeout(dt) {
        if ((gameState._opponentThrowPending || gameState._myThrowInFlight) && !document.hidden) {
            _throwPendingTimer += dt;
            if (_throwPendingTimer > 10.0) {
                _throwPendingTimer = 0;
                console.log('[SAFETY] throw pending stuck for 10s — forcing recovery');
                gameState._opponentThrowPending = false;
                gameState._myThrowInFlight = false;
                gameState.phase = 'aiming';
                updateUI();
                // Send a ping to get the server's authoritative currentTeam
                // The pong will trigger onConnectionVerified which syncs state
                gameState._awaitingConnectionVerify = true;
                CurlingNetwork.sendPing();
                setupTurnControls();
            }
        } else {
            _throwPendingTimer = 0;
        }
    }

    let _endOfEndStuckTimer = 0;
    function checkEndOfEndStuckPeriodic(dt) {
        if (gameState.redThrown >= 8 && gameState.yellowThrown >= 8 &&
            gameState.phase !== 'scoring' && gameState.phase !== 'gameover' &&
            gameState.phase !== 'delivering' && gameState.phase !== 'settling') {
            _endOfEndStuckTimer += dt;
            if (_endOfEndStuckTimer > 5.0) {
                _endOfEndStuckTimer = 0;
                checkEndOfEndStuck();
            }
        } else {
            _endOfEndStuckTimer = 0;
        }
    }

    // v112: checkNobodysTurnStuck removed — server owns turns, no more stuck state

    // --------------------------------------------------------
    // PERIODIC STATE SNAPSHOT (v111 — for debug log export)
    // --------------------------------------------------------
    let _lastSnapshotSec = 0;
    function logStateSnapshot(timestampMs) {
        if (!gameState.onlineMode) return;
        const sec = timestampMs / 1000;
        if (sec - _lastSnapshotSec < 8) return;
        _lastSnapshotSec = sec;

        const active = gameState.stones.filter(s => s.active).length;
        DebugPanel.log(
            '[STATE] p=' + gameState.phase
            + ' turn=' + gameState.currentTeam
            + ' me=' + gameState.myTeam
            + ' end=' + gameState.currentEnd + '/' + gameState.totalEnds
            + ' thr=R' + gameState.redThrown + '/Y' + gameState.yellowThrown
            + ' sc=' + gameState.redScore + '-' + gameState.yellowScore
            + ' st=' + active
            + ' wkr=' + gameState._workerActive
            + ' opp=' + gameState._opponentThrowPending
            + ' vfy=' + gameState._awaitingConnectionVerify
            + ' hid=' + document.hidden
            + ' ws=' + CurlingNetwork.isConnected()
        );
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
        stonesLabel.textContent = `Stone ${Math.min(thrown + 1, 8)} of 8`;

        // v115b: Only show throw/sweep buttons based on current state
        if (gameState._myThrowInFlight) {
            // Thrower's stone is in flight — show sweep, hide throw
            document.getElementById('throw-btn').style.display = 'none';
            document.getElementById('sweep-toggle-btn').style.display = 'block';
        } else if (gameState._opponentThrowPending) {
            // Watching opponent's throw — hide both (opponent sweeps their own)
            document.getElementById('throw-btn').style.display = 'none';
            document.getElementById('sweep-toggle-btn').style.display = 'none';
        } else {
            // Default: aiming phase — show throw, hide sweep
            document.getElementById('throw-btn').style.display = 'block';
            document.getElementById('sweep-toggle-btn').style.display = 'none';
        }

        // Update scores and end number (v115: was missing — only local endEnd() updated these)
        document.getElementById('red-total').textContent = gameState.redScore;
        document.getElementById('yellow-total').textContent = gameState.yellowScore;
        document.getElementById('current-end').textContent = gameState.currentEnd;

        // Update total ends display
        document.getElementById('total-ends-display').textContent = '/ ' + gameState.totalEnds;

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

    // v112: applyAuthoritativeState removed — server sends throw_result directly

    function scheduleNextTurn(delayMs) {
        if (gameState._nextTurnScheduled) {
            console.log('[SCHEDULE] nextTurn already scheduled — skipping duplicate');
            return;
        }
        gameState._nextTurnScheduled = true;
        setTimeout(() => {
            gameState._nextTurnScheduled = false;
            if (gameState.phase === 'waitingNextTurn') {
                nextTurn();
            } else {
                console.log('[SCHEDULE] nextTurn fired but phase changed to ' + gameState.phase + ' — skipping');
            }
        }, delayMs);
    }

    function nextTurn() {
        // Clear the scheduling guard
        gameState._nextTurnScheduled = false;

        // v112: In online mode, server handles turn switching — nextTurn is only for local/bot
        // (online mode uses throw_result from server to advance turns)

        // Toggle teams
        const prevTeam = gameState.currentTeam;
        gameState.currentTeam = (gameState.currentTeam === TEAMS.RED) ? TEAMS.YELLOW : TEAMS.RED;
        console.log('[NEXT-TURN] Switched ' + prevTeam + ' -> ' + gameState.currentTeam + ' myTeam=' + gameState.myTeam + ' isMyTurn=' + isMyTurn() + ' redThrown=' + gameState.redThrown + ' yellowThrown=' + gameState.yellowThrown);

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

        if (isBotTurn()) {
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
    // ICE LOGO (Olympic Rings)
    // Drawn between the far hog line and the house
    // --------------------------------------------------------
    function drawIceLogos() {
        ctx.save();
        ctx.globalAlpha = 0.45; // painted-on-ice look

        // Place the rings centered between the far hog line and the front of the house
        const logoTopY = P.farHogLine + 0.3;
        const logoBottomY = P.farTeeLine - HOUSE.twelveFoot - 0.3;
        const logoMidY = (logoTopY + logoBottomY) / 2;
        const logoHeight = logoBottomY - logoTopY;

        // Ring dimensions — constrain to fit within the ice sheet width
        const sheetWidthPx = toCanvasLen(CurlingPhysics.SHEET.width * 0.80);
        const totalH = toCanvasLen(logoHeight);
        // Olympic rings total width ≈ 6.44 * ringRadius (with gaps)
        // Solve: 6.44 * r = sheetWidthPx → r = sheetWidthPx / 6.44
        const radiusFromWidth = sheetWidthPx / 6.44;
        // Also limit by available height (rings span ~2.9 * radius vertically)
        const radiusFromHeight = totalH / 2.9;
        const ringRadius = Math.min(radiusFromWidth, radiusFromHeight);
        const strokeW = ringRadius * 0.18;
        const gap = ringRadius * 0.22; // horizontal gap between ring centers in same row

        const centerX = toCanvasX(0);
        const centerY = toCanvasY(logoMidY);

        // Top row y, bottom row y
        const topY = centerY - ringRadius * 0.45;
        const botY = centerY + ringRadius * 0.45;

        // Horizontal spacing: rings overlap slightly
        const dx = ringRadius * 2 + gap;

        // Ring centers: top row (blue, black, red), bottom row (yellow, green)
        const rings = [
            { x: centerX - dx, y: topY, color: '#0081C8' },  // blue
            { x: centerX, y: topY, color: '#222222' },  // black (slightly lighter for ice visibility)
            { x: centerX + dx, y: topY, color: '#EE334E' },  // red
            { x: centerX - dx / 2, y: botY, color: '#FCB131' },  // yellow
            { x: centerX + dx / 2, y: botY, color: '#00A651' },  // green
        ];

        ctx.lineWidth = strokeW;
        ctx.lineCap = 'round';

        // Draw all rings as simple overlapping circles (no interlocking needed at this scale)
        // Draw bottom row first, then top row on top
        // Bottom row
        for (let i = 3; i <= 4; i++) {
            ctx.beginPath();
            ctx.arc(rings[i].x, rings[i].y, ringRadius, 0, Math.PI * 2);
            ctx.strokeStyle = rings[i].color;
            ctx.stroke();
        }
        // Top row
        for (let i = 0; i <= 2; i++) {
            ctx.beginPath();
            ctx.arc(rings[i].x, rings[i].y, ringRadius, 0, Math.PI * 2);
            ctx.strokeStyle = rings[i].color;
            ctx.stroke();
        }

        // Draw interlocking weave: bottom rings pass IN FRONT of top rings on the right side
        // For each bottom-top pair, redraw a small arc of the bottom ring over the top ring
        const pairs = [
            { bot: 3, top: 0 }, // yellow over blue (right intersection)
            { bot: 3, top: 1 }, // yellow over black (left intersection)
            { bot: 4, top: 1 }, // green over black (right intersection)
            { bot: 4, top: 2 }, // green over red (left intersection)
        ];

        for (let p = 0; p < pairs.length; p++) {
            const b = rings[pairs[p].bot];
            const t = rings[pairs[p].top];
            // Find the angle from bottom ring center to top ring center
            const angle = Math.atan2(t.y - b.y, t.x - b.x);
            // The "in front" arc is on the side closer to the top ring
            // We draw a small arc segment of the bottom ring that overlaps
            const arcSpan = 0.45; // radians of arc to redraw
            // For even index pairs (right side), bottom goes in front
            // For odd index pairs (left side), top goes in front
            if (p % 2 === 0) {
                // Bottom ring in front on right side of intersection
                ctx.beginPath();
                ctx.arc(b.x, b.y, ringRadius, angle - arcSpan, angle + arcSpan);
                ctx.strokeStyle = b.color;
                ctx.stroke();
            } else {
                // Top ring in front on left side of intersection
                const angle2 = Math.atan2(b.y - t.y, b.x - t.x);
                ctx.beginPath();
                ctx.arc(t.x, t.y, ringRadius, angle2 - arcSpan, angle2 + arcSpan);
                ctx.strokeStyle = t.color;
                ctx.stroke();
            }
        }

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
        ctx.rotate(stone.angle);

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

    // Cache for trajectory preview (easy mode only)
    let _trajCache = { aim: null, weight: null, spin: null, amount: null, points: null };

    function drawAimLine() {
        if (gameState.phase !== 'aiming') return;

        const aimDeg = parseFloat(document.getElementById('aim-slider').value);
        const aimRad = aimDeg * Math.PI / 180;
        const startX = 0;
        const startY = P.hack + 1.0;

        const showTrajectory = gameState.botMode && CurlingBot.getDifficulty() === 'easy';

        if (showTrajectory) {
            // Curved trajectory preview for easy mode
            const weightPct = parseFloat(document.getElementById('weight-slider').value);
            const spinDir = document.getElementById('spin-cw').classList.contains('active') ? 1 : -1;
            const spinAmount = parseFloat(document.getElementById('spin-amount-slider').value);

            if (_trajCache.aim !== aimDeg || _trajCache.weight !== weightPct ||
                _trajCache.spin !== spinDir || _trajCache.amount !== spinAmount) {
                _trajCache.aim = aimDeg;
                _trajCache.weight = weightPct;
                _trajCache.spin = spinDir;
                _trajCache.amount = spinAmount;
                _trajCache.points = CurlingPhysics.simulateTrajectory(aimDeg, weightPct, spinDir, spinAmount);
            }

            const pts = _trajCache.points;
            if (pts && pts.length > 1) {
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([8, 6]);
                ctx.beginPath();
                ctx.moveTo(toCanvasX(pts[0].x), toCanvasY(pts[0].y));
                for (let i = 1; i < pts.length; i++) {
                    ctx.lineTo(toCanvasX(pts[i].x), toCanvasY(pts[i].y));
                }
                ctx.stroke();
                ctx.setLineDash([]);
            }
        } else {
            // Straight dashed aim line
            const lineLen = 45;
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
        }

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

            // v105: Fixed — was calling non-existent CurlingPhysics.stepAll()
            const sweep = gameState.isSweeping ? gameState.sweepLevel : 'none';
            CurlingPhysics.simulate(gameState.stones, PHYSICS_DT, sweep);
            checkOutOfBounds();
            iterations++;
        }
    }

    // --------------------------------------------------------
    // WEB WORKER PHYSICS (v105)
    // Runs curling physics in a background thread so stones
    // keep moving even when the browser tab is hidden.
    // Only used for human online throws. Bot mode, replay,
    // and trajectory preview stay on the main thread.
    // --------------------------------------------------------
    let physicsWorker = null;

    function initPhysicsWorker() {
        if (physicsWorker) return;
        try {
            physicsWorker = new Worker('physics-worker.js');
            physicsWorker.onmessage = onPhysicsWorkerMessage;
            physicsWorker.onerror = (err) => {
                console.warn('[WORKER] Failed to load — falling back to main thread physics', err);
                physicsWorker = null;
                gameState._workerActive = false;
            };
        } catch (e) {
            console.warn('[WORKER] Not supported — falling back to main thread physics', e);
            physicsWorker = null;
        }
    }

    function onPhysicsWorkerMessage(e) {
        const msg = e.data;
        if (msg.type === 'positions') {
            applyWorkerPositions(msg);
        } else if (msg.type === 'settled') {
            applyWorkerSettled(msg);
        }
    }

    // Update stone positions from Worker for rendering (called ~60fps when visible)
    function applyWorkerPositions(msg) {
        if (!gameState._workerActive) return;
        for (let i = 0; i < msg.stones.length && i < gameState.stones.length; i++) {
            const src = msg.stones[i];
            const dst = gameState.stones[i];
            dst.x = src.x;
            dst.y = src.y;
            dst.vx = src.vx;
            dst.vy = src.vy;
            dst.angle = src.angle;
            dst.active = src.active;
            dst.moving = src.moving;
            dst.hasHitStone = src.hasHitStone;
            if (src.settleTime) dst.settleTime = src.settleTime;
            if (src.fadeOut !== undefined) dst.fadeOut = src.fadeOut;
        }
        gameState._simStepCount = msg.simStepCount;
    }

    // Worker reports all stones settled — advance the turn.
    // CRITICAL: This handler fires even when the tab is hidden,
    // because Worker postMessage callbacks are NOT throttled.
    function applyWorkerSettled(msg) {
        if (!gameState._workerActive) return;
        gameState._workerActive = false;
        console.log('[WORKER] Stones settled — simSteps=' + msg.simStepCount);

        // Apply final stone positions
        for (let i = 0; i < msg.stones.length && i < gameState.stones.length; i++) {
            const src = msg.stones[i];
            const dst = gameState.stones[i];
            dst.x = src.x;
            dst.y = src.y;
            dst.vx = 0;
            dst.vy = 0;
            dst.active = src.active;
            dst.moving = false;
            dst.hasHitStone = src.hasHitStone;
            if (src.fadeOut !== undefined) dst.fadeOut = src.fadeOut;
        }
        gameState._simStepCount = msg.simStepCount;

        // Check FGZ violation with final settled state
        checkFGZViolation();

        // Advance turn — sends throw_settled to server immediately
        gameState.phase = 'waitingNextTurn';
        gameState.isSweeping = false;
        document.getElementById('sweep-toggle-btn').style.display = 'none';
        VIEW.followStone = false;

        // Hide welcome-back popup if it's showing (throw finished in background)
        const popup = document.getElementById('welcome-back-overlay');
        if (popup && popup.style.display !== 'none') {
            popup.style.display = 'none';
        }

        nextTurn(); // toggles team + sends throw_settled
    }

    function stopPhysicsWorker() {
        if (physicsWorker && gameState._workerActive) {
            physicsWorker.postMessage({ type: 'stop' });
        }
        gameState._workerActive = false;
    }

    // --------------------------------------------------------
    // REPLAY LAST SHOT
    // --------------------------------------------------------
    function showReplayButton() {
        const btn = document.getElementById('replay-btn');
        if (btn) btn.style.display = '';
    }

    function hideReplayButton() {
        const btn = document.getElementById('replay-btn');
        if (btn) btn.style.display = 'none';
    }

    function skipReplay() {
        if (!gameState.isReplaying || !gameState._replayRestore) return;
        console.log('[REPLAY] Skipping replay');
        gameState._replayRestore();
        document.getElementById('skip-replay-btn').style.display = 'none';
    }

    // v112a: replayLastShot accepts optional speed and team override
    // speed: simSpeed value (3.0 = normal 1x, 9.0 = 3x fast)
    // throwerTeam: which team threw (defaults to opponent)
    function replayLastShot(speed, throwerTeam) {
        if (!gameState.lastOpponentShot || !gameState.lastOpponentShotStones || gameState.isReplaying) return;

        const shot = gameState.lastOpponentShot;
        const savedStones = gameState.lastOpponentShotStones;

        // Save current real stone positions and game phase
        const realStones = gameState.stones;
        const realPhase = gameState.phase;
        const realDeliveredStone = gameState.deliveredStone;
        const realSimSpeed = gameState.simSpeed;

        // Restore the board to the snapshot before the shot
        gameState.stones = savedStones.map(s => ({
            ...s, vx: 0, vy: 0, omega: 0, angle: 0, moving: false,
        }));

        // Deliver the shot on the snapshot board
        gameState.isReplaying = true;
        gameState.simSpeed = speed || 9.0; // default 3x for opponent replays
        hideReplayButton();
        document.getElementById('skip-replay-btn').style.display = '';

        // Determine the team that threw
        const replayTeam = throwerTeam || (gameState.myTeam === 'red' ? 'yellow' : 'red');
        const prevTeam = gameState.currentTeam;
        gameState.currentTeam = replayTeam;

        // Create the stone with correct physics
        const stoneSpeed = CurlingPhysics.weightToSpeed(shot.weight);
        const aimRad = shot.aim * Math.PI / 180;
        const startX = 0;
        const startY = P.hack + 1.0;
        const vx = stoneSpeed * Math.sin(aimRad);
        const vy = stoneSpeed * Math.cos(aimRad);
        const omega = CurlingPhysics.rotationsToAngularVelocity(shot.spinAmount, stoneSpeed) * shot.spinDir;

        const stone = createStone(replayTeam, startX, startY, vx, vy, omega);
        stone.moving = true;
        gameState.stones.push(stone);
        gameState.deliveredStone = stone;
        stoneTrail = [{ x: startX, y: startY }];
        gameState.phase = 'delivering';
        VIEW.followStone = true;

        // Apply sweep during replay for accurate physics.
        // v112: Online throws use a fixed sweep level (no timeline). Local uses timeline.
        gameState._simStepCount = 0;  // reset step counter for replay
        if (shot.sweepTimeline && shot.sweepTimeline.length > 0) {
            // Local/bot mode: real-time sweep timeline
            gameState.isSweeping = false;
            gameState._replaySweepTimeline = shot.sweepTimeline;
            document.getElementById('sweep-toggle-btn').style.display = 'block';
            document.getElementById('sweep-toggle-btn').textContent = 'SWEEP';
        } else if (shot.sweepLevel && shot.sweepLevel !== 'none') {
            // v112 online mode: constant sweep level for entire throw
            gameState.isSweeping = true;
            gameState.sweepLevel = shot.sweepLevel;
            gameState._replaySweepTimeline = null;
            document.getElementById('sweep-toggle-btn').style.display = 'block';
            document.getElementById('sweep-toggle-btn').textContent = 'SWEEPING (' + shot.sweepLevel + ')';
            document.getElementById('sweep-toggle-btn').classList.add('sweeping');
        } else {
            gameState.isSweeping = false;
            gameState._replaySweepTimeline = null;
        }

        // Wait for replay to finish via the gameLoop — it will detect
        // no more moving stones and transition to waitingNextTurn.
        // We intercept that with a check: if isReplaying, restore real state.
        gameState._replayRestore = () => {
            gameState.stones = realStones;
            gameState.phase = realPhase;
            gameState.deliveredStone = realDeliveredStone;
            gameState.currentTeam = prevTeam;
            gameState.isReplaying = false;
            gameState.simSpeed = realSimSpeed; // restore normal speed
            gameState._replayRestore = null;
            gameState._replaySweepTimeline = null;
            gameState.isSweeping = false;
            VIEW.followStone = false;
            // Reset sweep UI
            document.getElementById('sweep-toggle-btn').classList.remove('sweeping');
            document.getElementById('sweep-toggle-btn').textContent = 'SWEEP';
            document.getElementById('skip-replay-btn').style.display = 'none';
            updateUI();
        };
    }

    // v101: Welcome Back popup — replaces the complex multi-branch visibility handler.
    // When player returns from tab-away, show popup. Network layer handles ping/reconnect
    // automatically. When user taps the popup, do a clean sync in one atomic sequence.
    function showWelcomeBack() {
        document.getElementById('welcome-back-overlay').style.display = 'flex';
        console.log('[WELCOME_BACK] Popup shown — phase=' + gameState.phase);
    }

    function dismissWelcomeBack() {
        document.getElementById('welcome-back-overlay').style.display = 'none';
        console.log('[WELCOME_BACK] Popup dismissed — phase=' + gameState.phase
            + ' currentTeam=' + gameState.currentTeam
            + ' workerActive=' + gameState._workerActive);

        // Cancel any in-progress replay first (restores real stone state)
        if (gameState.isReplaying && gameState._replayRestore) {
            console.log('[WELCOME_BACK] Cancelling in-progress replay');
            gameState._replayRestore();
        }

        // v112: For online mode, server runs physics — just wait for throw_result.
        // For local/bot mode: safety net if throw is still in-flight.
        if (gameState.onlineMode) {
            // v114c: ALWAYS ping — don't skip based on phase.
            // If throw_result hasn't arrived yet, the pong response will include
            // throwInProgress=true and onConnectionVerified will handle it.
            // If throw_result already arrived, pong gives us correct currentTeam.
            gameState._awaitingConnectionVerify = true;
            CurlingNetwork.sendPing();
        } else if ((gameState.phase === 'delivering' || gameState.phase === 'settling')
            && !gameState.isReplaying) {
            console.log('[WELCOME_BACK] Local throw still in-flight — fast-forwarding');
            if (physicsWorker && gameState._workerActive) {
                physicsWorker.postMessage({ type: 'stop' });
                gameState._workerActive = false;
            }
            fastForwardPhysics();
            checkFGZViolation();
            gameState.phase = 'waitingNextTurn';
            gameState.isSweeping = false;
            document.getElementById('sweep-toggle-btn').style.display = 'none';
            nextTurn();
        } else if (gameState.phase === 'waitingNextTurn') {
            // Stone stopped but nextTurn never fired (setTimeout was frozen)
            console.log('[WELCOME_BACK] Stuck in waitingNextTurn — firing nextTurn now');
            nextTurn();
        }

        // v114c: Don't clear here for online mode — let onConnectionVerified
        // clear it after pong arrives with correct state.
        if (!gameState.onlineMode) {
            gameState._awaitingConnectionVerify = false;
        }

        // Re-sync UI
        updateUI();
        setupTurnControls();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && gameState.onlineMode) {
            // v112: Online mode — server runs physics. Nothing to fast-forward.
            // When tab returns, welcome-back popup + ping will handle sync.
            console.log('[VISIBILITY] Screen off in online mode — server handles physics');
        } else if (document.hidden && !gameState.onlineMode) {
            // Local/bot mode: fast-forward physics synchronously before browser suspends.
            if ((gameState.phase === 'delivering' || gameState.phase === 'settling')
                && !gameState.isReplaying) {
                console.log('[VISIBILITY] Screen off during local throw — fast-forwarding + nextTurn');
                if (physicsWorker && gameState._workerActive) {
                    physicsWorker.postMessage({ type: 'stop' });
                    gameState._workerActive = false;
                }
                fastForwardPhysics();
                checkFGZViolation();
                gameState.phase = 'waitingNextTurn';
                gameState.isSweeping = false;
                document.getElementById('sweep-toggle-btn').style.display = 'none';
                VIEW.followStone = false;
                nextTurn();
            } else if (gameState.phase === 'waitingNextTurn') {
                console.log('[VISIBILITY] Screen off during waitingNextTurn — firing nextTurn now');
                nextTurn();
            }
        }
        // v101: Screen coming back — show welcome back popup
        if (!document.hidden && gameState.onlineMode) {
            showWelcomeBack();
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

            // v105: Web Worker path — Worker runs physics in background thread.
            // Main thread just updates the trail from Worker-provided positions.
            if (gameState._workerActive) {
                // Trail recording from Worker-updated positions
                if (gameState.deliveredStone && gameState.deliveredStone.moving) {
                    const ds = gameState.deliveredStone;
                    const last = stoneTrail[stoneTrail.length - 1];
                    if (last) {
                        const dx = ds.x - last.x;
                        const dy = ds.y - last.y;
                        if (dx * dx + dy * dy > 0.04) {
                            stoneTrail.push({ x: ds.x, y: ds.y });
                        }
                    }
                }

                // Stop sweeping ability once delivered stone stops
                if (gameState.deliveredStone && !gameState.deliveredStone.moving) {
                    gameState.isSweeping = false;
                }

            // v114: Online mode — client-side prediction for smooth 60fps rendering.
            // Server's sync_positions corrects drift, throw_result is the final authority.
            } else if (gameState.onlineMode) {
                physicsAccumulator += frameTime * gameState.simSpeed; // 3x speed to match server rate

                while (physicsAccumulator >= PHYSICS_DT) {
                    const sweep = gameState.isSweeping ? gameState.sweepLevel : 'none';
                    const anyMoving = CurlingPhysics.simulate(gameState.stones, PHYSICS_DT, sweep);

                    // Record trail for the delivered stone
                    if (gameState.deliveredStone && gameState.deliveredStone.moving) {
                        const ds = gameState.deliveredStone;
                        const last = stoneTrail[stoneTrail.length - 1];
                        if (last) {
                            const dx = ds.x - last.x;
                            const dy = ds.y - last.y;
                            if (dx * dx + dy * dy > 0.04) {
                                stoneTrail.push({ x: ds.x, y: ds.y });
                            }
                        }
                    }

                    physicsAccumulator -= PHYSICS_DT;
                    if (!anyMoving) {
                        physicsAccumulator = 0;
                        break; // Don't scheduleNextTurn — server handles via throw_result
                    }
                }

                // Main-thread physics path — bot mode, replay, or Worker failed to load
            } else {
                // v88: Only local physics (my throw, bot mode, or replay). No remote delivery branch.
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
                    // During replay, consult the sweep timeline to apply correct sweep at this step
                    if (gameState.isReplaying && gameState._replaySweepTimeline) {
                        const timeline = gameState._replaySweepTimeline;
                        const wasSweeping = gameState.isSweeping;
                        // Find the latest event at or before this step
                        for (let i = timeline.length - 1; i >= 0; i--) {
                            if (timeline[i].step <= gameState._simStepCount) {
                                gameState.isSweeping = timeline[i].sweeping;
                                if (timeline[i].sweeping) {
                                    gameState.sweepLevel = timeline[i].level;
                                }
                                break;
                            }
                        }
                        // Update sweep button visual during replay
                        if (gameState.isSweeping !== wasSweeping) {
                            const sweepBtn = document.getElementById('sweep-toggle-btn');
                            if (gameState.isSweeping) {
                                sweepBtn.classList.add('sweeping');
                                sweepBtn.textContent = 'SWEEPING!';
                            } else {
                                sweepBtn.classList.remove('sweeping');
                                sweepBtn.textContent = 'SWEEP';
                            }
                        }
                    }

                    const sweep = gameState.isSweeping ? gameState.sweepLevel : 'none';
                    const anyMoving = CurlingPhysics.simulate(gameState.stones, PHYSICS_DT, sweep);

                    // Increment sim step counter (indexes sweep timeline for recording & replay)
                    gameState._simStepCount++;

                    // Record trail for the delivered stone
                    if (gameState.deliveredStone && gameState.deliveredStone.moving) {
                        const ds = gameState.deliveredStone;
                        const last = stoneTrail[stoneTrail.length - 1];
                        const dx = ds.x - last.x;
                        const dy = ds.y - last.y;
                        if (dx * dx + dy * dy > 0.04) {
                            stoneTrail.push({ x: ds.x, y: ds.y });
                        }
                    }

                    // Check for stones out of bounds
                    checkOutOfBounds();

                    physicsAccumulator -= PHYSICS_DT;

                    if (!anyMoving) {
                        physicsAccumulator = 0;
                        if (gameState.phase === 'delivering' || gameState.phase === 'settling') {
                            // If replaying, restore the real game state instead of advancing
                            if (gameState.isReplaying && gameState._replayRestore) {
                                setTimeout(() => {
                                    if (gameState._replayRestore) gameState._replayRestore();
                                }, 200);
                                break;
                            }

                            // Check FGZ violation before advancing turn
                            checkFGZViolation();

                            gameState.phase = 'waitingNextTurn';
                            gameState.isSweeping = false;
                            document.getElementById('sweep-toggle-btn').style.display = 'none';

                            scheduleNextTurn(400);
                        }
                        break;
                    }
                }

                // Once the delivered stone passes the far hog line, stop sweeping ability
                if (gameState.deliveredStone && !gameState.deliveredStone.moving) {
                    gameState.isSweeping = false;
                }
            } // end main-thread physics path
        }

        // Camera
        updateCamera();

        // Safety: periodic checks for stuck states
        if (gameState.onlineMode) {
            checkEndOfEndStuckPeriodic(frameTime);
            checkOpponentThrowPendingTimeout(frameTime);
            logStateSnapshot(timestamp); // v111
        }

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
        // Tick extra end notice
        if (extraEndNotice) {
            extraEndNotice.timer -= frameDeltaMs;
            if (extraEndNotice.timer <= 0) extraEndNotice = null;
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
        drawExtraEndNotice();
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

    // Extra end notice — centered on screen
    function drawExtraEndNotice() {
        if (!extraEndNotice) return;
        const alpha = Math.min(1, extraEndNotice.timer / 400);

        ctx.save();
        ctx.globalAlpha = alpha;

        const cx = canvas.width / 2;
        const cy = canvas.height * 0.25;

        // Background pill
        ctx.fillStyle = 'rgba(30, 100, 200, 0.9)';
        const textW = 220;
        const textH = 50;
        ctx.beginPath();
        ctx.moveTo(cx - textW / 2 + 12, cy - textH / 2);
        ctx.lineTo(cx + textW / 2 - 12, cy - textH / 2);
        ctx.arcTo(cx + textW / 2, cy - textH / 2, cx + textW / 2, cy, 12);
        ctx.arcTo(cx + textW / 2, cy + textH / 2, cx - textW / 2, cy + textH / 2, 12);
        ctx.arcTo(cx - textW / 2, cy + textH / 2, cx - textW / 2, cy, 12);
        ctx.arcTo(cx - textW / 2, cy - textH / 2, cx + textW / 2, cy - textH / 2, 12);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('EXTRA END!', cx, cy + 1);

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
        console.log('[THROW-BTN] Clicked! phase=' + gameState.phase + ' currentTeam=' + gameState.currentTeam + ' myTeam=' + gameState.myTeam + ' isOnlineOpponentTurn=' + isOnlineOpponentTurn() + ' awaitingVerify=' + gameState._awaitingConnectionVerify + ' redThrown=' + gameState.redThrown + ' yellowThrown=' + gameState.yellowThrown);
        // Safety: if all 16 stones thrown, force scoring instead of allowing throw
        if (checkEndOfEndStuck()) return;
        if (gameState.phase === 'aiming') {
            if (isOnlineOpponentTurn()) return;

            // v93: Defense-in-depth — block throw if connection not verified or WS dead
            if (gameState.onlineMode && (gameState._awaitingConnectionVerify || !CurlingNetwork.isConnected())) {
                console.log('[THROW-BTN] Blocked — connection not verified or WS dead');
                const throwBtn = document.getElementById('throw-btn');
                throwBtn.disabled = true;
                throwBtn.textContent = 'RECONNECTING...';
                throwBtn.classList.add('connecting');
                return;
            }

            deliverStone();
        }
    });

    document.getElementById('zoom-btn').addEventListener('click', () => {
        if (gameState.phase === 'aiming' || gameState.phase === 'waitingNextTurn') {
            gameState.houseZoom = !gameState.houseZoom;
            document.getElementById('zoom-btn').classList.toggle('zoomed', gameState.houseZoom);
        }
    });

    // Sync button — force re-sync game state from server
    document.getElementById('sync-btn').addEventListener('click', () => {
        if (!gameState.onlineMode) return;
        console.log('[SYNC] Manual sync triggered');
        const btn = document.getElementById('sync-btn');
        btn.classList.add('syncing');
        setTimeout(() => btn.classList.remove('syncing'), 800);

        // Clear any stuck pending state
        gameState._opponentThrowPending = false;
        gameState._myThrowInFlight = false;

        // v112: Send a ping to get authoritative state from server
        if (CurlingNetwork.isConnected()) {
            gameState._awaitingConnectionVerify = true;
            CurlingNetwork.sendPing();
            updateUI();
            setupTurnControls();
        } else {
            // WS is dead — the network layer will handle reconnect
            console.log('[SYNC] WS not connected — waiting for reconnect');
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

        // v115b: Online mode — send live sweep change to server (thrower sweeping)
        if (gameState.onlineMode && gameState._myThrowInFlight && !gameState.isReplaying) {
            CurlingNetwork.sendSweepChange(level);
        }

        // Track sweep level during local/bot throw for replay
        if (gameState.phase === 'delivering' && gameState.isSweeping && !gameState.onlineMode) {
            gameState._throwSweepLevel = level;
            if (!gameState.isReplaying) {
                gameState._sweepTimeline.push({ step: gameState._simStepCount, sweeping: true, level: level });
            }
        }
        document.querySelectorAll('.sweep-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('sweep-' + level).classList.add('active');
        // v105: Notify Worker of sweep level change (local/bot mode only)
        if (physicsWorker && gameState._workerActive && !gameState.onlineMode) {
            physicsWorker.postMessage({ type: 'sweep', sweepLevel: level });
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
        // v115b: Online mode — the THROWING player sweeps their own stone
        if (gameState.onlineMode) {
            // Must have my own throw in flight
            if (!gameState._myThrowInFlight) return;
            // Need a stone in motion
            if (!gameState.deliveredStone?.moving) return;
            if (gameState.isReplaying) return;

            gameState.isSweeping = true;
            gameState.sweepLevel = 'hard';
            CurlingNetwork.sendSweepChange('hard');

            document.getElementById('sweep-toggle-btn').classList.add('sweeping');
            document.getElementById('sweep-toggle-btn').textContent = 'SWEEPING!';
            return;
        }

        // Local/bot mode — original behavior
        if (gameState.phase === 'delivering' && gameState.deliveredStone?.moving) {
            gameState.isSweeping = true;
            if (gameState.sweepLevel === 'none') {
                gameState.sweepLevel = 'hard';
                setSweepLevel('hard');
            }
            // Track sweep for local/bot replay
            gameState._throwSweepLevel = gameState.sweepLevel;
            if (!gameState.isReplaying) {
                gameState._sweepTimeline.push({ step: gameState._simStepCount, sweeping: true, level: gameState.sweepLevel });
            }
            document.getElementById('sweep-toggle-btn').classList.add('sweeping');
            document.getElementById('sweep-toggle-btn').textContent = 'SWEEPING!';

            // Notify Worker of sweep change (local/bot only)
            if (physicsWorker && gameState._workerActive) {
                physicsWorker.postMessage({ type: 'sweep', sweepLevel: gameState.sweepLevel });
            }
        }
    }

    function stopSweeping() {
        const wasSweeping = gameState.isSweeping;
        gameState.isSweeping = false;
        gameState.sweepLevel = 'none';

        // v113: Notify server of sweep stop (non-thrower releasing sweep)
        if (gameState.onlineMode && wasSweeping && !gameState.isReplaying) {
            CurlingNetwork.sendSweepChange('none');
        }

        // Record sweep OFF event in timeline (local/bot only)
        if (wasSweeping && gameState.phase === 'delivering' && !gameState.isReplaying && !gameState.onlineMode) {
            gameState._sweepTimeline.push({ step: gameState._simStepCount, sweeping: false, level: 'none' });
        }
        const sweepBtnEl = document.getElementById('sweep-toggle-btn');
        sweepBtnEl.classList.remove('sweeping');
        // v115b: Show "HOLD TO SWEEP" if my throw is in flight
        sweepBtnEl.textContent = gameState.onlineMode && gameState._myThrowInFlight ? 'HOLD TO SWEEP' : 'SWEEP';
        // Notify Worker of sweep stop (local/bot only)
        if (physicsWorker && gameState._workerActive && !gameState.onlineMode) {
            physicsWorker.postMessage({ type: 'sweep', sweepLevel: 'none' });
        }
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
        console.log('[RESET_GAME] resetGame called, onlineMode:', gameState.onlineMode, 'phase:', gameState.phase);
        console.trace('[RESET_GAME] stack trace');
        // v105: Stop Worker if running
        stopPhysicsWorker();
        const preserveBotMode = gameState.botMode;
        const preserveOnlineMode = gameState.onlineMode;
        const preserveMyTeam = gameState.myTeam;
        const preserveRoomCode = gameState.roomCode;
        const preserveTotalEnds = gameState.totalEnds;
        gameState = {
            stones: [],
            currentTeam: TEAMS.RED,
            hammer: TEAMS.YELLOW,
            redThrown: 0,
            yellowThrown: 0,
            currentEnd: 1,
            totalEnds: preserveTotalEnds,
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
            lastOpponentShot: null,
            lastOpponentShotStones: null,
            isReplaying: false,
            _nextTurnScheduled: false,
            _awaitingConnectionVerify: false,
            _opponentThrowPending: false,
            _myThrowInFlight: false,
            _preThrowSnapshot: null,
            _throwSweepLevel: 'none',
            _sweepTimeline: [],
            _simStepCount: 0,
            _replaySweepTimeline: null,
            _workerActive: false, // v105
        };

        fgzSnapshots = [];
        fgzViolation = null;
        extraEndNotice = null;
        hogLineViolation = null;
        hideReplayButton();
        document.getElementById('skip-replay-btn').style.display = 'none';

        document.getElementById('zoom-btn').classList.remove('zoomed');
        document.getElementById('red-total').textContent = '0';
        document.getElementById('yellow-total').textContent = '0';
        document.getElementById('current-end').textContent = '1';
        document.getElementById('throw-btn').disabled = false;
        enableControlsForHuman();

        updateUI();

        // Show tutorial for first-time players
        if (gameState.currentEnd === 1) {
            checkTutorial();
        }
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
    function clearOnlineMode(reason) {
        console.log('[CLEAR_ONLINE] reason=' + (reason || 'unknown'));
        if (gameState.onlineMode) {
            // Don't send 'leave' if we're clearing because opponent left or reconnect failed
            // — the room is already gone / being destroyed server-side.
            if (reason !== 'opponent-left' && reason !== 'reconnect-failed') {
                CurlingNetwork.sendLeave();
            }
            CurlingNetwork.disconnect();
        }
        // Always clear the session so page refresh doesn't try to rejoin a dead room
        CurlingNetwork.clearActiveSession();
        gameState.onlineMode = false;
        gameState.myTeam = null;
        gameState.roomCode = null;
        gameState.opponentInfo = null;
        gameState._opponentThrowPending = false;
        gameState._myThrowInFlight = false;
        gameState._preThrowSnapshot = null;
        gameState.isSweeping = false;
        gameState.sweepLevel = 'none';
        document.getElementById('online-team-badge').style.display = 'none';
        document.getElementById('chat-btn').style.display = 'none';
        document.getElementById('chat-popup').style.display = 'none';
        document.getElementById('sync-btn').style.display = 'none';
        document.getElementById('sweep-toggle-btn').style.display = 'none';
        document.getElementById('sweep-toggle-btn').classList.remove('sweeping', 'opponent-sweeping');
        hideReplayButton();
        // Clear player names from scoreboard
        document.getElementById('red-player-name').textContent = '';
        document.getElementById('yellow-player-name').textContent = '';
    }

    document.getElementById('mode-1p').addEventListener('click', () => {
        clearOnlineMode('mode-1p-button');
        gameState.botMode = true;
        document.getElementById('mode-1p').classList.add('active');
        document.getElementById('mode-2p').classList.remove('active');
        document.getElementById('mode-online').classList.remove('active');
        document.getElementById('difficulty-selector').classList.remove('hidden');
        document.getElementById('ends-selector-local').classList.remove('hidden');
        // If it's now the bot's turn, trigger it
        if (isBotTurn() && gameState.phase === 'aiming') {
            triggerBotTurn();
        }
        settingsDropdown.classList.remove('open');
        settingsToggle.classList.remove('active');
    });

    document.getElementById('mode-2p').addEventListener('click', () => {
        clearOnlineMode('mode-2p-button');
        gameState.botMode = false;
        document.getElementById('mode-2p').classList.add('active');
        document.getElementById('mode-1p').classList.remove('active');
        document.getElementById('mode-online').classList.remove('active');
        document.getElementById('difficulty-selector').classList.add('hidden');
        document.getElementById('ends-selector-local').classList.remove('hidden');
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

    // Ends selector for local/bot games
    document.querySelectorAll('.ends-local-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ends-local-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            gameState.totalEnds = parseInt(btn.dataset.ends);
            resetGame();
            updateUI();
            settingsDropdown.classList.remove('open');
            settingsToggle.classList.remove('active');
        });
    });

    // --------------------------------------------------------
    // ONLINE MULTIPLAYER
    // --------------------------------------------------------
    const SERVER_URL = (() => {
        const loc = window.location;

        // Localhost development
        if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1' || loc.protocol === 'file:') {
            return 'ws://localhost:3000';
        }

        // Production: derive WebSocket URL from current page host (Railway serves everything)
        const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        return wsProtocol + '//' + loc.host;
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
        const panels = ['lobby-menu', 'lobby-ends-panel', 'lobby-create-panel', 'lobby-join-panel', 'lobby-queue-panel', 'lobby-starting-panel', 'auth-panel', 'lobby-friends-panel', 'lobby-leaderboard-panel'];
        panels.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = id === panelId ? 'flex' : 'none';
        });
        // Always sync friends/leaderboard button visibility when showing lobby menu
        if (panelId === 'lobby-menu') {
            const isLoggedIn = !!localStorage.getItem('curling_token');
            document.getElementById('lobby-friends').style.display = isLoggedIn ? 'block' : 'none';
            document.getElementById('lobby-leaderboard').style.display = isLoggedIn ? 'block' : 'none';
        }
    }

    function showLobbyScreen() {
        document.getElementById('lobby-screen').style.display = 'flex';
        showLobbyPanel('lobby-menu');
        // v116: Show quick guide once on first visit to online lobby
        if (!localStorage.getItem('curling_guide_shown')) {
            localStorage.setItem('curling_guide_shown', '1');
            showQuickGuide();
        }
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

    // Convert 2-letter ISO country code to Unicode flag emoji
    function countryToFlag(code) {
        if (!code || code.length !== 2) return '';
        const c = code.toUpperCase();
        // Scotland uses non-standard "SC" — map to the Scotland flag emoji
        if (c === 'SC') return '\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74\uDB40\uDC7F';
        // Standard: convert each letter to regional indicator symbol
        return String.fromCodePoint(
            0x1F1E6 + c.charCodeAt(0) - 65,
            0x1F1E6 + c.charCodeAt(1) - 65
        );
    }

    function updateScoreboardNames() {
        const myName = localStorage.getItem('curling_username') || null;
        const myCountry = localStorage.getItem('curling_country') || '';
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

        const myFlag = countryToFlag(myCountry);
        const oppFlag = countryToFlag(oppInfo ? oppInfo.country : '');
        const myLabel = myFlag + (myName ? ' ' + myName + ' (you)' : ' You');
        const oppLabel = oppFlag + (oppInfo ? ' ' + oppInfo.username : ' Guest');

        if (myTeam === TEAMS.RED) {
            redNameEl.textContent = myLabel;
            yellowNameEl.textContent = oppLabel;
        } else {
            yellowNameEl.textContent = myLabel;
            redNameEl.textContent = oppLabel;
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

        const flag = countryToFlag(opponent.country || '');
        nameLabel.textContent = flag + (flag ? ' ' : '') + opponent.username;
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
        const myCountry = localStorage.getItem('curling_country') || '';
        const oppInfo = gameState.opponentInfo;
        const oppName = oppInfo ? oppInfo.username : 'Guest';
        const myFlag = countryToFlag(myCountry);
        const oppFlag = countryToFlag(oppInfo ? oppInfo.country : '');

        let html = `<span style="color:#fff">${myFlag} ${myName}</span> <span>vs</span> <span style="color:#fff">${oppFlag} ${oppName}</span>`;
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

    // v117: Leaderboard rendering
    function renderLeaderboard(players) {
        const container = document.getElementById('leaderboard-list');

        if (players.length === 0) {
            container.innerHTML = '<p style="color:#888;font-size:13px;text-align:center;">No players found</p>';
            return;
        }

        container.innerHTML = players.map((p, i) => {
            const pos = i + 1;
            const posClass = pos <= 3 ? `podium-${pos}` : '';
            const selfClass = p.isSelf ? 'leaderboard-self' : '';
            const country = p.country ? countryToFlag(p.country) + ' ' : '';
            const record = `${p.wins}W ${p.losses}L`;
            const badgeTextColor = (p.rank.color === '#ffd54f' || p.rank.color === '#e0e0e0') ? '#333' : '#fff';

            let actionHtml = '';
            if (p.isSelf) {
                actionHtml = '<span class="lb-you">You</span>';
            } else if (p.friendStatus === 'accepted') {
                actionHtml = '<button class="lobby-btn lb-action-btn" disabled>Friends</button>';
            } else if (p.friendStatus === 'pending') {
                actionHtml = '<button class="lobby-btn lb-action-btn" disabled>Pending</button>';
            } else {
                actionHtml = `<button class="lobby-btn lb-action-btn lb-add-btn" data-username="${p.username}">Add</button>`;
            }

            return `<div class="leaderboard-row ${selfClass} ${posClass}">
                <span class="lb-pos">${pos}</span>
                <span class="lb-name">${country}${p.username}</span>
                <span class="rank-badge" style="background:${p.rank.color};color:${badgeTextColor}">${p.rank.name}</span>
                <span class="lb-rating">${p.rating}</span>
                <span class="lb-record">${record}</span>
                ${actionHtml}
            </div>`;
        }).join('');

        // Wire up Add Friend buttons
        container.querySelectorAll('.lb-add-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                CurlingNetwork.sendFriendRequest(btn.dataset.username);
                btn.textContent = 'Sent';
                btn.disabled = true;
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

    // ---- QUICK CHAT ----
    function showChatToast(text, from) {
        const container = document.getElementById('chat-toast-container');
        const toast = document.createElement('div');
        toast.className = 'chat-toast';
        toast.innerHTML = '<span class="chat-from">' + from + ':</span>' + text;
        container.appendChild(toast);
        setTimeout(() => { toast.remove(); }, 3000);
    }

    // Chat button toggle
    const chatBtn = document.getElementById('chat-btn');
    const chatPopup = document.getElementById('chat-popup');
    chatBtn.addEventListener('click', () => {
        chatPopup.style.display = chatPopup.style.display === 'none' ? 'flex' : 'none';
    });

    // Replay last shot button
    document.getElementById('replay-btn').addEventListener('click', () => {
        replayLastShot();
    });

    document.getElementById('skip-replay-btn').addEventListener('click', () => {
        skipReplay();
    });

    // Preset message buttons
    document.querySelectorAll('.chat-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            const text = btn.textContent;
            CurlingNetwork.sendChatMessage(text);
            const username = localStorage.getItem('curling_username') || 'You';
            showChatToast(text, username);
            chatPopup.style.display = 'none';
        });
    });

    // ---- TUTORIAL ----
    const tutorialSteps = [
        { text: 'Adjust the Aim slider to angle your shot left or right.', target: 'aim-slider' },
        { text: 'Set Weight to control power \u2014 from a soft Guard to a hard Takeout.', target: 'weight-slider' },
        { text: 'Choose spin direction \u2014 the stone curls that way on the ice.', target: 'spin-direction' },
        { text: 'Tap THROW to deliver your stone!', target: 'throw-btn' },
        { text: 'Hold SWEEP during delivery to straighten and extend the shot.', target: 'sweep-toggle-btn' },
    ];
    let tutorialStep = 0;

    function checkTutorial() {
        if (localStorage.getItem('curling_tutorial_done')) return;
        tutorialStep = 0;
        showTutorialStep(0);
    }

    function showTutorialStep(n) {
        const overlay = document.getElementById('tutorial-overlay');
        const text = document.getElementById('tutorial-text');
        const counter = document.getElementById('tutorial-step-counter');
        const nextBtn = document.getElementById('tutorial-next');

        // Remove previous highlight
        document.querySelectorAll('.tutorial-highlight').forEach(el => el.classList.remove('tutorial-highlight'));

        if (n >= tutorialSteps.length) {
            overlay.style.display = 'none';
            localStorage.setItem('curling_tutorial_done', '1');
            return;
        }

        const step = tutorialSteps[n];
        overlay.style.display = 'flex';
        text.textContent = step.text;
        counter.textContent = (n + 1) + ' / ' + tutorialSteps.length;
        nextBtn.textContent = n === tutorialSteps.length - 1 ? 'Got it!' : 'Next';

        const target = document.getElementById(step.target);
        if (target) target.classList.add('tutorial-highlight');
    }

    document.getElementById('tutorial-next').addEventListener('click', () => {
        tutorialStep++;
        showTutorialStep(tutorialStep);
    });

    document.getElementById('tutorial-skip').addEventListener('click', () => {
        document.getElementById('tutorial-overlay').style.display = 'none';
        document.querySelectorAll('.tutorial-highlight').forEach(el => el.classList.remove('tutorial-highlight'));
        localStorage.setItem('curling_tutorial_done', '1');
    });

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
        CurlingNetwork.onGameStart(({ yourTeam, opponent, totalEnds }) => {
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
                if (totalEnds) gameState.totalEnds = totalEnds;
                showOnlineTeamBadge();
                updateScoreboardNames();
                updateUI();
                document.getElementById('chat-btn').style.display = '';
                document.getElementById('sync-btn').style.display = '';
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

        // ============================================================
        // v112: SERVER-AUTHORITATIVE CALLBACKS
        // Server runs physics and sends throw_result to BOTH players.
        // ============================================================

        // Opponent started a throw — server is simulating physics
        CurlingNetwork.onOpponentThrowStarted((data) => {
            console.log('[OPP-THROW-STARTED] Server is simulating opponent throw');

            // Safety net: clear stuck disconnect overlay
            if (!gameState.opponentConnected) {
                gameState.opponentConnected = true;
                hideDisconnectOverlay();
            }

            // Cancel any in-progress replay
            if (gameState.isReplaying && gameState._replayRestore) {
                gameState._replayRestore();
            }
            hideReplayButton();

            gameState._opponentThrowPending = true;

            // Disable throw controls — opponent is throwing
            document.getElementById('throw-btn').disabled = true;
            document.getElementById('throw-btn').style.display = 'none';

            // v114: Create local prediction stone for smooth rendering
            if (data.throwParams) {
                const tp = data.throwParams;
                const stoneSpeed = CurlingPhysics.weightToSpeed(tp.weight);
                const aimRad = tp.aim * Math.PI / 180;
                const startX = 0;
                const startY = P.hack + 1.0;
                const vx = stoneSpeed * Math.sin(aimRad);
                const vy = stoneSpeed * Math.cos(aimRad);
                const omega = CurlingPhysics.rotationsToAngularVelocity(tp.spinAmount, stoneSpeed) * tp.spinDir;

                const throwingTeam = gameState.currentTeam;
                const stone = createStone(throwingTeam, startX, startY, vx, vy, omega);
                stone.moving = true;
                gameState.stones.push(stone);
                gameState.deliveredStone = stone;
                stoneTrail = [{ x: startX, y: startY }];
                VIEW.followStone = true;
            }

            gameState.phase = 'delivering'; // Enable physics prediction in gameLoop

            // v115b: Non-thrower does NOT sweep — hide sweep button, just watch
            gameState.sweepLevel = 'none';
            gameState.isSweeping = false;
            document.getElementById('sweep-toggle-btn').style.display = 'none';

            updateUI();

            // Animate sliders for visual feedback (non-blocking)
            if (!document.hidden && data.throwParams) {
                const tp = data.throwParams;
                animateOpponentSliders(tp.aim, tp.weight, tp.spinDir, tp.spinAmount, () => { });
            }
        });

        // v114: sync_positions — server correction for client-side prediction.
        // Corrects position drift every ~100ms. Does NOT change phase (keeps 'delivering'
        // so client physics prediction continues running in gameLoop).
        CurlingNetwork.onSyncPositions((data) => {
            if (gameState.phase !== 'delivering' && gameState.phase !== 'settling' && !gameState._opponentThrowPending) return;

            if (data.stones && data.stones.length > 0) {
                for (let i = 0; i < data.stones.length; i++) {
                    const serverStone = data.stones[i];
                    let localStone = gameState.stones[i];

                    if (!localStone) {
                        localStone = createStone(serverStone.team, serverStone.x, serverStone.y, 0, 0, 0);
                        gameState.stones[i] = localStone;
                    }

                    // Correct position from server (overrides local prediction drift)
                    localStone.x = serverStone.x;
                    localStone.y = serverStone.y;
                    localStone.angle = serverStone.angle;
                    localStone.active = serverStone.active;
                    localStone.moving = serverStone.moving;
                }

                // Ensure delivered stone and camera are tracking
                const delivered = gameState.stones[gameState.stones.length - 1];
                if (delivered && delivered.moving) {
                    gameState.deliveredStone = delivered;
                    VIEW.followStone = true;
                }
            }
        });

        // v112: opponent_sweep_change — show visual sweep feedback for opponent
        CurlingNetwork.onOpponentSweepChange((data) => {
            const btn = document.getElementById('sweep-toggle-btn');
            if (data.level === 'hard') {
                btn.classList.add('sweeping', 'opponent-sweeping');
                btn.innerText = "OPPONENT SWEEPING";
                btn.style.display = 'block';
            } else if (data.level === 'light') {
                btn.classList.add('sweeping', 'opponent-sweeping');
                btn.innerText = "OPPONENT (LIGHT)";
                btn.style.display = 'block';
            } else {
                btn.classList.remove('sweeping', 'opponent-sweeping');
                btn.innerText = "SWEEP";
                btn.style.display = 'none';
            }
        });

        // v112: throw_result — server finished physics, final state for BOTH players
        CurlingNetwork.onThrowResult((data) => {
            try {
                console.log('[THROW_RESULT] stones=' + (data.stones ? data.stones.length : 0) +
                    ' currentTeam=' + data.currentTeam + ' endComplete=' + data.endComplete +
                    ' gameOver=' + data.gameOver + ' hog=' + data.hogViolation + ' fgz=' + data.fgzViolation);

                // Connection is alive — reset all throw-in-progress state
                gameState._awaitingConnectionVerify = false;
                gameState._opponentThrowPending = false;
                gameState._myThrowInFlight = false; // v115b
                physicsAccumulator = 0; // v114: Stop client-side prediction

                // Apply stone positions from server (authoritative)
                if (data.stones && data.stones.length >= 0) {
                    gameState.stones = data.stones.map(s => {
                        const stone = createStone(s.team, s.x, s.y, 0, 0, 0);
                        stone.active = true;
                        stone.moving = false;
                        return stone;
                    });
                }

                // Apply all game state from server (server is authoritative)
                gameState.currentTeam = data.currentTeam;
                gameState.redThrown = data.redThrown;
                gameState.yellowThrown = data.yellowThrown;
                gameState.redScore = data.redScore;
                gameState.yellowScore = data.yellowScore;
                gameState.currentEnd = data.currentEnd;
                gameState.totalEnds = data.totalEnds;
                gameState.hammer = data.hammer;
                gameState.endScores = data.endScores || gameState.endScores;

                // Store throw data for replay
                if (data.throwParams) {
                    gameState.lastOpponentShot = { ...data.throwParams };
                    gameState.lastOpponentShot.sweepLevel = data.throwParams.sweepLevel || 'none';
                }
                if (data.preThrowStones) {
                    gameState.lastOpponentShotStones = data.preThrowStones.map(s => ({
                        team: s.team, x: s.x, y: s.y, vx: 0, vy: 0, omega: 0, active: true, moving: false,
                    }));
                }

                // Clean up delivery state
                gameState.deliveredStone = null;
                gameState.isSweeping = false;
                gameState.sweepLevel = 'none';
                document.getElementById('sweep-toggle-btn').style.display = 'none';
                document.getElementById('sweep-toggle-btn').classList.remove('sweeping', 'opponent-sweeping');
                VIEW.followStone = false;

                // Hide welcome-back popup if showing
                const popup = document.getElementById('welcome-back-overlay');
                if (popup && popup.style.display !== 'none') {
                    popup.style.display = 'none';
                }

                updateUI();

                // Game over?
                if (data.gameOver) {
                    gameState.phase = 'gameover';
                    showGameOver();
                    return;
                }

                // End complete (but game continues)?
                if (data.endComplete) {
                    // v115: Get the scoring result from the last endScores entry
                    const lastEndResult = (data.endScores && data.endScores.length > 0)
                        ? data.endScores[data.endScores.length - 1]
                        : { team: null, points: 0 };
                    const completedEnd = data.currentEnd - 1; // server already incremented

                    // Reset local state for new end
                    gameState.stones = [];
                    gameState.deliveredStone = null;
                    gameState.lastOpponentShot = null;
                    gameState.lastOpponentShotStones = null;
                    updateUI();

                    // Show end summary popup — Continue button sets up next turn
                    showEndSummary(completedEnd, lastEndResult.team, lastEndResult.points, data.hammer);
                    return;
                }

                // Normal turn transition — set up for next throw
                gameState.phase = 'aiming';
                document.getElementById('aim-slider').value = 0;
                document.getElementById('aim-value').textContent = '0.0°';
                updateUI();
                setupTurnControls();

                // v114: Both players see throws live now — no auto-replay needed.
                // Just show the replay button if they want to watch it again.
                if (data.throwParams && gameState.lastOpponentShotStones) {
                    showReplayButton();
                }
            } catch (err) {
                console.error('[THROW_RESULT] ERROR:', err);
                // Emergency recovery
                gameState.phase = 'aiming';
                gameState.deliveredStone = null;
                gameState._opponentThrowPending = false;
                gameState._myThrowInFlight = false;
                if (data.currentTeam) gameState.currentTeam = data.currentTeam;
                updateUI();
                setupTurnControls();
            }
        });

        // Connection verified alive after tab refocus (pong received)
        CurlingNetwork.onConnectionVerified(({ currentTeam, throwInProgress } = {}) => {
            gameState._awaitingConnectionVerify = false;
            console.log('[CONN_VERIFIED] pong received — phase=' + gameState.phase
                + ' localTeam=' + gameState.currentTeam
                + ' serverTeam=' + currentTeam
                + ' throwInProgress=' + throwInProgress);

            // Safety net: clear stuck disconnect overlay
            if (!gameState.opponentConnected) {
                gameState.opponentConnected = true;
                hideDisconnectOverlay();
            }

            // If welcome-back popup is showing, it handles everything on dismiss
            const popupVisible = document.getElementById('welcome-back-overlay').style.display !== 'none';
            if (popupVisible) {
                return;
            }

            // v112: Sync currentTeam with server's authoritative value
            if (currentTeam && currentTeam !== gameState.currentTeam && !throwInProgress) {
                gameState.currentTeam = currentTeam;
                updateUI();
            }

            setupTurnControls();
        });

        // If the server rejects our throw (not our turn, not in room, etc.),
        // go back to aiming. v112: Server handles throw counts, no revert needed.
        CurlingNetwork.onThrowRejected(({ reason, serverCurrentTeam }) => {
            console.log('[THROW_REJECTED] reason=' + reason + ' serverCurrentTeam=' + serverCurrentTeam
                + ' myTeam=' + gameState.myTeam + ' localCurrentTeam=' + gameState.currentTeam
                + ' phase=' + gameState.phase);

            DebugPanel.log('[THROW_REJECTED] ' + reason + ' server=' + serverCurrentTeam + ' local=' + gameState.currentTeam);

            // v112: No local stone was created for online throws, just reset phase
            gameState.phase = 'aiming';
            gameState.deliveredStone = null;
            VIEW.followStone = false;

            // Sync currentTeam with server's authoritative value
            if (serverCurrentTeam) {
                gameState.currentTeam = serverCurrentTeam;
            }

            updateUI();
            setupTurnControls();
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
            console.log('[GAME] onOpponentLeft received');
            gameState.opponentConnected = false;
            hideDisconnectOverlay();
            clearOnlineMode('opponent-left');
            resetGame();
        });

        CurlingNetwork.onRematchRequested(() => {
            // Auto-accept for simplicity: show a brief notification then start
            const rematchBtn = document.getElementById('rematch-btn');
            rematchBtn.textContent = 'Opponent wants rematch!';
        });

        CurlingNetwork.onRematchAccepted(({ yourTeam, opponent, totalEnds }) => {
            gameState.myTeam = yourTeam;
            gameState.opponentInfo = opponent;
            document.getElementById('game-over-screen').style.display = 'none';
            resetGame();
            if (totalEnds) gameState.totalEnds = totalEnds;
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

        CurlingNetwork.onRoomError(({ error, code }) => {
            const joinError = document.getElementById('join-error');
            // Friendlier messages for share link users
            if (error === 'Room not found') {
                joinError.textContent = 'This game room no longer exists. Ask your friend for a new link.';
            } else if (error === 'Room is full') {
                joinError.textContent = 'This game already has two players.';
            } else {
                joinError.textContent = error;
            }
            joinError.style.display = 'block';
            // Make sure the join panel is visible so they see the error
            showLobbyPanel('lobby-join-panel');
        });

        CurlingNetwork.onQueueWaiting(() => {
            showLobbyPanel('lobby-queue-panel');
        });

        CurlingNetwork.onRoomExpired(() => {
            showLobbyPanel('lobby-menu');
        });

        // v101: Simplified onReconnected — popup handles mid-throw recovery now.
        // Just apply the server snapshot and sync controls.
        // ============================================================
        // v112: SIMPLIFIED RECONNECT — server owns all state
        // ============================================================
        CurlingNetwork.onReconnected(({ yourTeam, gameState: serverState, opponent }) => {
            console.log('[GAME] onReconnected v112: myTeam=' + yourTeam + ' serverState=' + !!serverState);
            gameState._awaitingConnectionVerify = false;
            gameState.myTeam = yourTeam;
            gameState.onlineMode = true;
            gameState.opponentConnected = true;
            gameState.opponentInfo = opponent;
            gameState._opponentThrowPending = false;
            gameState._myThrowInFlight = false;
            hideDisconnectOverlay();
            dismissWelcome();
            showOnlineTeamBadge();
            updateScoreboardNames();
            document.getElementById('sync-btn').style.display = '';

            _endOfEndStuckTimer = 0;

            // Cancel any pending replay
            if (gameState.isReplaying && gameState._replayRestore) {
                gameState._replayRestore();
            }

            // Hide welcome-back popup
            const popup = document.getElementById('welcome-back-overlay');
            if (popup && popup.style.display !== 'none') {
                popup.style.display = 'none';
            }

            // v112: Apply full authoritative state from server
            if (serverState) {
                // Apply stone positions
                if (serverState.settledStones) {
                    gameState.stones = serverState.settledStones.map(s => {
                        const stone = createStone(s.team, s.x, s.y, 0, 0, 0);
                        stone.active = true;
                        stone.moving = false;
                        return stone;
                    });
                }

                gameState.currentTeam = serverState.currentTeam || TEAMS.RED;
                gameState.redThrown = serverState.redThrown || 0;
                gameState.yellowThrown = serverState.yellowThrown || 0;
                gameState.currentEnd = serverState.currentEnd || 1;
                gameState.totalEnds = serverState.totalEnds || 4;
                gameState.redScore = serverState.redScore || 0;
                gameState.yellowScore = serverState.yellowScore || 0;
                gameState.hammer = serverState.hammer || TEAMS.YELLOW;
                gameState.endScores = serverState.endScores || [];

                document.getElementById('red-total').textContent = gameState.redScore;
                document.getElementById('yellow-total').textContent = gameState.yellowScore;
                document.getElementById('current-end').textContent = gameState.currentEnd;

                // Store last throw params for replay if provided
                if (serverState.lastThrowParams) {
                    gameState.lastOpponentShot = { ...serverState.lastThrowParams };
                }
                if (serverState.lastPreThrowStones) {
                    gameState.lastOpponentShotStones = serverState.lastPreThrowStones.map(s => ({
                        team: s.team, x: s.x, y: s.y, vx: 0, vy: 0, omega: 0, active: true, moving: false,
                    }));
                }

                // If server has a throw in progress, show waiting state
                if (serverState.throwInProgress) {
                    console.log('[GAME] onReconnected — throw in progress on server, waiting for result');
                    gameState.phase = 'delivering';
                    document.getElementById('throw-btn').disabled = true;
                    document.getElementById('throw-btn').style.display = 'none';

                    // v115b: If I'm the throwing player, show sweep controls
                    if (serverState.currentTeam === yourTeam) {
                        gameState._myThrowInFlight = true;
                        gameState.sweepLevel = 'none';
                        gameState.isSweeping = false;
                        const sweepBtn = document.getElementById('sweep-toggle-btn');
                        sweepBtn.style.display = 'block';
                        sweepBtn.textContent = 'HOLD TO SWEEP';
                        sweepBtn.classList.remove('sweeping', 'opponent-sweeping');
                    } else {
                        // Non-thrower: just mark opponent throw pending, no sweep button
                        gameState._opponentThrowPending = true;
                    }

                    updateUI();
                    return; // throw_result will arrive when server physics completes
                }
            }

            // Clean up
            gameState.deliveredStone = null;
            gameState._nextTurnScheduled = false;
            VIEW.followStone = false;

            // Handle game-over
            if (serverState && serverState.phase === 'finished') {
                gameState.phase = 'gameover';
                showGameOver();
                return;
            }

            // Normal case: aiming phase
            gameState.phase = 'aiming';
            updateUI();
            setupTurnControls();

            // Offer replay of last shot if available
            if (serverState && serverState.lastThrowParams) {
                showReplayButton();
            }
        });

        CurlingNetwork.onDisconnect(() => {
            // Network disconnected — immediately disable throw so stale input can't fire
            console.log('[GAME] onDisconnect — disabling throw button');
            document.getElementById('throw-btn').disabled = true;
        });

        CurlingNetwork.onReconnectFailed(() => {
            console.log('[GAME] onReconnectFailed received');
            clearOnlineMode('reconnect-failed');
            resetGame();
            hideLobbyScreen();
            hideDisconnectOverlay();
            // Restore welcome screen if it was hidden during auto-rejoin attempt
            const welcomeEl = document.getElementById('welcome-screen');
            if (welcomeEl) {
                welcomeEl.style.display = '';
                welcomeEl.style.opacity = '1';
            }
        });

        // ---- LEADERBOARD HANDLER ----
        CurlingNetwork.onLeaderboard(({ players }) => {
            renderLeaderboard(players);
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

        CurlingNetwork.onFriendPresence(({ userId, status }) => {
            const friend = friendsList.find(f => f.userId === userId);
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

        // ---- CHAT ----
        CurlingNetwork.onChatMessage((text, from) => {
            showChatToast(text, from);
        });

        // ---- AUTH HANDLERS ----
        CurlingNetwork.onAuthSuccess(({ token, username, rank }) => {
            localStorage.setItem('curling_token', token);
            localStorage.setItem('curling_username', username);
            document.getElementById('user-info-bar').style.display = 'flex';
            document.getElementById('logged-in-as').textContent = username;
            // Show rank badge
            if (rank) {
                updateRankBadge(rank);
            }
            // Only show lobby UI if we're NOT in an active game.
            // During reconnect, token_login triggers auth_success — we must
            // NOT overwrite the game screen with the lobby menu.
            if (!gameState.onlineMode || gameState.phase === 'gameover') {
                document.getElementById('auth-panel').style.display = 'none';
                // If there's a pending join code (from share link), auto-join now
                if (_pendingJoinCode) {
                    executePendingJoin();
                } else {
                    showLobbyPanel('lobby-menu');
                }
            }
            CurlingNetwork.sendGetProfile();
            // Set up push notifications for logged-in users
            PushSetup.setup();
            // Show friends and leaderboard buttons for logged-in users
            document.getElementById('lobby-friends').style.display = 'block';
            document.getElementById('lobby-leaderboard').style.display = 'block';
        });

        CurlingNetwork.onVapidKey(({ key }) => {
            PushSetup.onVapidKey(key);
        });

        CurlingNetwork.onAuthError(({ error }) => {
            // If auto-login token expired, clear it
            localStorage.removeItem('curling_token');
            localStorage.removeItem('curling_username');
            localStorage.removeItem('curling_country');
            document.getElementById('user-info-bar').style.display = 'none';
            // Only show login form if NOT in an active game.
            // During reconnect, token_login may fail (server restarted) but
            // the game reconnect itself already succeeded — don't nuke the game.
            if (!gameState.onlineMode || gameState.phase === 'gameover') {
                document.getElementById('auth-panel').style.display = 'flex';
                document.getElementById('lobby-menu').style.display = 'none';
                const errEl = document.getElementById('auth-error');
                errEl.textContent = error === 'Session expired' ? 'Session expired — please log in again.' : error;
                errEl.style.display = 'block';
                // Show invite banner if there's a pending join (token expired for share link user)
                if (_pendingJoinCode) {
                    document.getElementById('join-invite-banner').style.display = 'block';
                }
            }
        });

        CurlingNetwork.onProfileData(({ profile }) => {
            if (profile) {
                document.getElementById('user-record').textContent =
                    `${profile.wins}W / ${profile.losses}L / ${profile.draws}D`;
                if (profile.rank) {
                    updateRankBadge(profile.rank);
                }
                if (profile.country) {
                    localStorage.setItem('curling_country', profile.country);
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
        document.getElementById('ends-selector-local').classList.add('hidden');
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
        }).catch((err) => {
            console.error('[CONNECT] Failed to connect to server:', err);
            document.getElementById('mode-online').classList.remove('active');
            document.getElementById('mode-1p').classList.add('active');
            document.getElementById('difficulty-selector').classList.remove('hidden');
            alert('Could not connect to server. Please check your internet connection and try again.');
        });
    });

    // Lobby button handlers
    document.getElementById('lobby-create').addEventListener('click', () => {
        showLobbyPanel('lobby-ends-panel');
    });

    // Ends selector buttons
    document.querySelectorAll('.ends-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ends-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    document.getElementById('lobby-create-confirm').addEventListener('click', () => {
        const activeBtn = document.querySelector('.ends-btn.active');
        const totalEnds = activeBtn ? parseInt(activeBtn.dataset.ends) : 4;
        CurlingNetwork.createRoom(totalEnds);
    });

    document.getElementById('lobby-cancel-ends').addEventListener('click', () => {
        showLobbyPanel('lobby-menu');
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

    // Share invite link button
    document.getElementById('share-invite-btn').addEventListener('click', () => {
        const roomCode = document.getElementById('room-code-display').textContent.trim();
        if (!roomCode || roomCode === '----') return;
        const shareUrl = window.location.origin + window.location.pathname + '?join=' + roomCode;
        const shareText = 'Join my curling game! ' + shareUrl;
        const copiedMsg = document.getElementById('share-copied-msg');

        if (navigator.share) {
            // Include URL in 'text' for maximum SMS/messaging compatibility.
            // Some apps ignore the 'url' field entirely and only send 'text'.
            navigator.share({
                text: 'Join my curling game! ' + shareUrl,
            }).catch(() => {
                // User cancelled share — no action needed
            });
        } else {
            // Desktop fallback: copy to clipboard
            navigator.clipboard.writeText(shareUrl).then(() => {
                copiedMsg.style.display = 'block';
                setTimeout(() => { copiedMsg.style.display = 'none'; }, 2500);
            }).catch(() => {
                // Fallback for older browsers without clipboard API
                const ta = document.createElement('textarea');
                ta.value = shareUrl;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                copiedMsg.style.display = 'block';
                setTimeout(() => { copiedMsg.style.display = 'none'; }, 2500);
            });
        }
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
        clearOnlineMode('disconnect-leave-button');
        resetGame();
    });

    // v101: Welcome Back popup — tap to dismiss and sync
    document.getElementById('welcome-back-overlay').addEventListener('click', () => {
        dismissWelcomeBack();
    });

    // Rematch / Leave buttons on game over screen
    document.getElementById('rematch-btn').addEventListener('click', () => {
        CurlingNetwork.sendRematch();
        document.getElementById('rematch-btn').textContent = 'Waiting...';
        document.getElementById('rematch-btn').disabled = true;
    });

    document.getElementById('leave-btn').addEventListener('click', () => {
        document.getElementById('game-over-screen').style.display = 'none';
        clearOnlineMode('leave-button');
        resetGame();
    });

    // v111: Copy debug logs from game-over screen
    document.getElementById('gameover-copy-logs')?.addEventListener('click', () => {
        DebugPanel.copyLogs().then(ok => {
            const btn = document.getElementById('gameover-copy-logs');
            if (btn) {
                btn.textContent = ok ? 'Logs Copied!' : 'Copy Failed';
                setTimeout(() => { btn.textContent = '\u{1F4CB} Copy Debug Logs'; }, 2000);
            }
        });
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

    // v117: Leaderboard button handlers
    document.getElementById('lobby-leaderboard').addEventListener('click', () => {
        showLobbyPanel('lobby-leaderboard-panel');
        CurlingNetwork.sendGetLeaderboard();
    });

    document.getElementById('lobby-leaderboard-back').addEventListener('click', () => {
        showLobbyPanel('lobby-menu');
    });

    document.getElementById('friend-search-btn').addEventListener('click', () => {
        const query = document.getElementById('friend-username-input').value.trim();
        if (!query) return;
        document.getElementById('friend-add-error').style.display = 'none';
        document.getElementById('friend-add-success').style.display = 'none';
        CurlingNetwork.sendSearchUsers(query);
    });

    document.getElementById('friend-username-input').addEventListener('keydown', (e) => {
        if (e.code === 'Enter') document.getElementById('friend-search-btn').click();
    });

    CurlingNetwork.onSearchResults(({ results }) => {
        const container = document.getElementById('friend-search-results');
        container.innerHTML = '';
        if (results.length === 0) {
            container.style.display = 'block';
            container.innerHTML = '<p class="search-no-results">No users found</p>';
            return;
        }
        container.style.display = 'block';
        results.forEach(user => {
            const item = document.createElement('div');
            item.className = 'friend-search-item';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'search-result-name';
            nameSpan.textContent = user.username;
            item.appendChild(nameSpan);
            if (user.rank) {
                const badge = document.createElement('span');
                badge.className = 'rank-badge';
                badge.textContent = user.rank.name;
                badge.style.background = user.rank.color;
                badge.style.color = user.rank.color === '#ffd54f' || user.rank.color === '#e0e0e0' ? '#333' : '#fff';
                item.appendChild(badge);
            }
            const addBtn = document.createElement('button');
            addBtn.className = 'lobby-btn search-add-btn';
            addBtn.textContent = 'Add';
            addBtn.addEventListener('click', () => {
                document.getElementById('friend-add-error').style.display = 'none';
                document.getElementById('friend-add-success').style.display = 'none';
                CurlingNetwork.sendFriendRequest(user.username);
                container.style.display = 'none';
                container.innerHTML = '';
                document.getElementById('friend-username-input').value = '';
            });
            item.appendChild(addBtn);
            container.appendChild(item);
        });
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
        const firstName = document.getElementById('reg-first-name').value.trim();
        const lastName = document.getElementById('reg-last-name').value.trim();
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
        CurlingNetwork.sendRegister(username, password, country, securityQuestion, securityAnswer, firstName, lastName);
    });

    document.getElementById('reg-security-answer').addEventListener('keydown', (e) => {
        if (e.code === 'Enter') document.getElementById('auth-register-btn').click();
    });

    document.getElementById('auth-skip').addEventListener('click', () => {
        document.getElementById('auth-panel').style.display = 'none';
        document.getElementById('lobby-friends').style.display = 'none';
        document.getElementById('lobby-leaderboard').style.display = 'none';
        // If there's a pending join code (from share link), auto-join now
        if (_pendingJoinCode) {
            executePendingJoin();
        } else {
            showLobbyPanel('lobby-menu');
        }
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
        localStorage.removeItem('curling_country');
        document.getElementById('user-info-bar').style.display = 'none';
        document.getElementById('auth-panel').style.display = 'flex';
        document.getElementById('lobby-menu').style.display = 'none';
        document.getElementById('user-record').textContent = '';
        document.getElementById('user-rank-badge').style.display = 'none';
        document.getElementById('user-rating').textContent = '';
        document.getElementById('lobby-friends').style.display = 'none';
        document.getElementById('lobby-leaderboard').style.display = 'none';
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
    // URL AUTO-JOIN (?join=XXXX)
    // --------------------------------------------------------
    // When a friend opens a share link, we store the join code and give them
    // a chance to login/register/play as guest. Once they auth (or skip),
    // we auto-join the room. If they already have a saved token, it joins
    // immediately after token login succeeds.
    let _pendingJoinCode = null;

    function executePendingJoin() {
        if (!_pendingJoinCode) return;
        const code = _pendingJoinCode.toUpperCase();
        _pendingJoinCode = null;

        // v115h: If we're already in this room (creator clicking their own link),
        // reconnect instead of trying to join as a second player
        const activeSession = CurlingNetwork.getActiveSession();
        if (activeSession && activeSession.roomCode && activeSession.roomCode.toUpperCase() === code) {
            console.log('[INVITE] Already in room ' + code + ' — reconnecting instead of joining');
            document.getElementById('join-invite-banner').style.display = 'none';
            CurlingNetwork.sendReconnect(activeSession.roomCode, activeSession.myTeam);
            return;
        }

        // Hide the invite banner now that we're joining
        document.getElementById('join-invite-banner').style.display = 'none';
        document.getElementById('join-error').style.display = 'none';
        CurlingNetwork.joinRoom(code);
        // Show a brief "joining..." state so they know something is happening
        showLobbyPanel('lobby-join-panel');
        document.getElementById('room-code-input').value = code;
    }

    (function checkAutoJoin() {
        const params = new URLSearchParams(window.location.search);
        const joinCode = params.get('join');
        if (!joinCode || joinCode.length !== 4) return;

        // Clean the URL so refresh doesn't re-join
        history.replaceState({}, '', window.location.pathname);

        // Store the code — it will be used after auth or guest skip
        _pendingJoinCode = joinCode.toUpperCase();

        // Dismiss welcome screen if present
        dismissWelcome();

        // Switch UI to online mode
        document.getElementById('mode-online').classList.add('active');
        document.getElementById('mode-1p').classList.remove('active');
        document.getElementById('mode-2p').classList.remove('active');
        document.getElementById('difficulty-selector').classList.add('hidden');
        document.getElementById('ends-selector-local').classList.add('hidden');

        // Connect to server
        CurlingNetwork.connect(SERVER_URL).then(() => {
            showLobbyScreen();

            // Check if user is already logged in (saved token)
            const savedToken = localStorage.getItem('curling_token');
            const savedUsername = localStorage.getItem('curling_username');
            if (savedToken) {
                // Already logged in — send token login, auto-join will happen
                // in onAuthSuccess when it detects _pendingJoinCode
                CurlingNetwork.sendTokenLogin(savedToken);
                if (savedUsername) {
                    document.getElementById('auth-panel').style.display = 'none';
                    document.getElementById('user-info-bar').style.display = 'flex';
                    document.getElementById('logged-in-as').textContent = savedUsername;
                }
                // Show a waiting state while token login processes
                showLobbyPanel('lobby-join-panel');
                document.getElementById('room-code-input').value = joinCode.toUpperCase();
                document.getElementById('join-error').style.display = 'none';
            } else {
                // Not logged in — show auth panel so they can login/register/play as guest
                document.getElementById('auth-panel').style.display = 'flex';
                document.getElementById('user-info-bar').style.display = 'none';
                document.getElementById('lobby-menu').style.display = 'none';
                document.getElementById('auth-error').style.display = 'none';
                // Show the invite banner so they know why they're here
                document.getElementById('join-invite-banner').style.display = 'block';
            }
        }).catch(() => {
            _pendingJoinCode = null;
            alert('Could not connect to server. Please try again.');
        });
    })();

    // --------------------------------------------------------
    // AUTO-REJOIN ACTIVE GAME (page refresh / back swipe recovery)
    // --------------------------------------------------------
    (function checkActiveGameSession() {
        // v115h: Skip if invite link auto-join is pending (URL already cleaned by checkAutoJoin)
        if (_pendingJoinCode) return;

        const session = CurlingNetwork.getActiveSession();
        if (!session || !session.roomCode) return;

        console.log('[REJOIN] Found active session: room=' + session.roomCode + ' team=' + session.myTeam);

        // DON'T dismiss the welcome screen yet — wait until reconnect succeeds.
        // If reconnect fails, the player will see the normal welcome screen.
        // Just hide it temporarily so the game canvas is visible during reconnect.
        const welcomeEl = document.getElementById('welcome-screen');
        if (welcomeEl) welcomeEl.style.display = 'none';

        // Switch UI to online mode and set gameState EARLY so the reconnect
        // handler and isMyTurn() work correctly before onReconnected fires
        document.getElementById('mode-online').classList.add('active');
        document.getElementById('mode-1p').classList.remove('active');
        document.getElementById('mode-2p').classList.remove('active');
        document.getElementById('difficulty-selector').classList.add('hidden');
        document.getElementById('ends-selector-local').classList.add('hidden');
        gameState.onlineMode = true;
        gameState.botMode = false;
        if (session.myTeam) gameState.myTeam = session.myTeam;

        // Connect and send reconnect
        CurlingNetwork.connect(SERVER_URL).then(() => {
            // Re-authenticate with saved token
            const savedToken = localStorage.getItem('curling_token');
            if (savedToken) {
                CurlingNetwork.sendTokenLogin(savedToken);
            }
            // The reconnect message is sent by network.js attemptReconnect automatically,
            // but since this is a fresh page load (not a WS reconnect), we need to send it manually.
            CurlingNetwork.sendReconnect(session.roomCode, session.myTeam);
        }).catch(() => {
            console.log('[REJOIN] Connection failed — clearing session');
            CurlingNetwork.clearActiveSession();
            gameState.onlineMode = false;
            // Show welcome screen back since reconnect failed
            if (welcomeEl) { welcomeEl.style.display = ''; }
        });
    })();

    // --------------------------------------------------------
    // INIT
    // --------------------------------------------------------

    // Auto-set beta version from service worker cache name (single source of truth: sw.js)
    if ('caches' in window) {
        caches.keys().then(names => {
            const curlingCache = names.find(n => n.startsWith('curling-v'));
            if (curlingCache) {
                const ver = curlingCache.replace('curling-', '');
                const el = document.getElementById('beta-version');
                if (el) el.textContent = ver;
            }
        }).catch(() => { });
    }

    resizeCanvas();
    updateUI();
    // Deferred resize to catch mobile layout after UI panel is measured
    requestAnimationFrame(() => {
        resizeCanvas();
        requestAnimationFrame(gameLoop);
    });

})();
