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
        totalEnds: 10,
        redScore: 0,
        yellowScore: 0,
        endScores: [],
        phase: 'aiming',    // 'aiming', 'delivering', 'settling', 'scoring', 'gameover'
        sweepLevel: 'none',
        isSweeping: false,
        deliveredStone: null,
        simSpeed: 3.0,       // simulation speed multiplier for faster gameplay
    };

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
        };
    }

    // --------------------------------------------------------
    // DELIVERY
    // --------------------------------------------------------
    // Trail for showing curl path
    let stoneTrail = [];

    // Hog-line violation indicator
    let hogLineViolation = null; // { x, y, timer }

    function deliverStone() {
        const aimDeg = parseFloat(document.getElementById('aim-slider').value);
        const weightPct = parseFloat(document.getElementById('weight-slider').value);
        const spinAmount = parseFloat(document.getElementById('spin-amount-slider').value);
        const spinDir = document.getElementById('spin-cw').classList.contains('active') ? 1 : -1;

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

        // Delay briefly so player sees the score
        setTimeout(() => {
            document.getElementById('throw-btn').disabled = false;
        }, 500);
    }

    function showGameOver() {
        const screen = document.getElementById('game-over-screen');
        const winnerText = document.getElementById('winner-text');
        const finalScores = document.getElementById('final-scores');

        let winner;
        if (gameState.redScore > gameState.yellowScore) {
            winner = 'Red Wins!';
        } else if (gameState.yellowScore > gameState.redScore) {
            winner = 'Yellow Wins!';
        } else {
            winner = "It's a Tie!";
        }

        winnerText.textContent = winner;
        finalScores.innerHTML = `
            <div style="color:#e53935">Red: ${gameState.redScore}</div>
            <div style="color:#fdd835">Yellow: ${gameState.yellowScore}</div>
            <br>
            <div style="font-size:16px; color:#888">
                ${gameState.endScores.map((s, i) =>
            `End ${i + 1}: ${s.team ? (s.team === 'red' ? 'Red' : 'Yellow') + ' +' + s.points : 'Blank'}`
        ).join('<br>')}
            </div>
        `;

        screen.style.display = 'flex';
    }

    // --------------------------------------------------------
    // UI
    // --------------------------------------------------------
    function updateUI() {
        const teamLabel = document.getElementById('current-team-label');
        const stonesLabel = document.getElementById('stones-remaining');

        teamLabel.textContent = gameState.currentTeam === TEAMS.RED ? "Red's Turn" : "Yellow's Turn";
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

        document.getElementById('throw-btn').disabled = false;
        document.getElementById('aim-slider').value = 0;
        document.getElementById('aim-value').textContent = '0.0°';
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
    // SILLY ICE LOGOS
    // Drawn on the ice surface — visible in default house view
    // and during delivery camera zoom-out
    // --------------------------------------------------------
    function drawIceLogos() {
        ctx.save();
        ctx.globalAlpha = 0.35; // painted-on-ice look

        // === LOGOS VISIBLE IN DEFAULT HOUSE VIEW (y ≈ 28–41.5) ===
        // The house (rings) is centered at y=38.41, so we place logos
        // in the open ice between hog line (y=32) and the house edge,
        // and on the sides outside the 12-foot ring (radius 1.83m)

        // ---------- Rubber Duck (left of house, visible in default view) ----------
        drawRubberDuck(toCanvasX(-1.8), toCanvasY(29.5), toCanvasLen(1.5));

        // ---------- Pizza Slice (right of house, visible in default view) ----------
        drawPizzaSlice(toCanvasX(1.8), toCanvasY(30.0), toCanvasLen(1.4));

        // ---------- Maple Leaf (center, just below hog line) ----------
        drawMapleLeaf(toCanvasX(0), toCanvasY(30.0), toCanvasLen(1.6));

        // ---------- Snowflake (left side, below back line) ----------
        drawSnowflake(toCanvasX(-1.8), toCanvasY(40.5), toCanvasLen(1.0));

        // ---------- Donut (right side, below back line) ----------
        drawDonut(toCanvasX(1.8), toCanvasY(40.5), toCanvasLen(1.0));

        // === LOGOS VISIBLE DURING DELIVERY (full sheet y ≈ -1 to 42) ===

        // ---------- Smiley Face (center, mid-sheet) ----------
        drawSmileyFace(toCanvasX(0), toCanvasY(20), toCanvasLen(2.0));

        // ---------- Moose (right, between hog lines) ----------
        drawMoose(toCanvasX(1.3), toCanvasY(15), toCanvasLen(2.2));

        // ---------- Rocket (left side, near delivery end) ----------
        drawRocket(toCanvasX(-1.4), toCanvasY(5), toCanvasLen(2.0));

        ctx.globalAlpha = 1.0;
        ctx.restore();
    }

    function drawRubberDuck(cx, cy, size) {
        const s = size / 2;
        ctx.save();
        ctx.translate(cx, cy);

        // Body (big yellow oval)
        ctx.fillStyle = '#fdd835';
        ctx.beginPath();
        ctx.ellipse(0, s * 0.1, s * 0.7, s * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();

        // Head (smaller circle, upper left)
        ctx.fillStyle = '#fdd835';
        ctx.beginPath();
        ctx.arc(-s * 0.3, -s * 0.35, s * 0.35, 0, Math.PI * 2);
        ctx.fill();

        // Beak
        ctx.fillStyle = '#ff8f00';
        ctx.beginPath();
        ctx.moveTo(-s * 0.65, -s * 0.4);
        ctx.lineTo(-s * 0.85, -s * 0.3);
        ctx.lineTo(-s * 0.6, -s * 0.25);
        ctx.closePath();
        ctx.fill();

        // Eye
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(-s * 0.38, -s * 0.42, s * 0.06, 0, Math.PI * 2);
        ctx.fill();

        // Wing
        ctx.fillStyle = '#f9c800';
        ctx.beginPath();
        ctx.ellipse(s * 0.15, s * 0.0, s * 0.3, s * 0.2, -0.3, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    function drawPizzaSlice(cx, cy, size) {
        const s = size / 2;
        ctx.save();
        ctx.translate(cx, cy);

        // Slice shape (triangle with rounded crust)
        ctx.fillStyle = '#e8a435';
        ctx.beginPath();
        ctx.moveTo(0, s * 0.7);
        ctx.lineTo(-s * 0.55, -s * 0.5);
        ctx.quadraticCurveTo(0, -s * 0.7, s * 0.55, -s * 0.5);
        ctx.closePath();
        ctx.fill();

        // Crust
        ctx.strokeStyle = '#c07820';
        ctx.lineWidth = toCanvasLen(0.08);
        ctx.beginPath();
        ctx.moveTo(-s * 0.55, -s * 0.5);
        ctx.quadraticCurveTo(0, -s * 0.7, s * 0.55, -s * 0.5);
        ctx.stroke();

        // Pepperoni
        ctx.fillStyle = '#c0392b';
        const pepperoni = [
            [0, -s * 0.2, s * 0.1],
            [-s * 0.18, s * 0.15, s * 0.08],
            [s * 0.15, s * 0.05, s * 0.09],
            [-s * 0.05, -s * 0.4, s * 0.07],
            [s * 0.1, -s * 0.3, s * 0.07],
        ];
        for (const [px, py, pr] of pepperoni) {
            ctx.beginPath();
            ctx.arc(px, py, pr, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    function drawSmileyFace(cx, cy, size) {
        const s = size / 2;
        ctx.save();
        ctx.translate(cx, cy);

        // Face
        ctx.fillStyle = '#fdd835';
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.8, 0, Math.PI * 2);
        ctx.fill();

        // Eyes
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(-s * 0.28, -s * 0.2, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(s * 0.28, -s * 0.2, s * 0.1, 0, Math.PI * 2);
        ctx.fill();

        // Smile
        ctx.strokeStyle = '#333';
        ctx.lineWidth = toCanvasLen(0.06);
        ctx.beginPath();
        ctx.arc(0, s * 0.05, s * 0.4, 0.2, Math.PI - 0.2);
        ctx.stroke();

        // Rosy cheeks
        ctx.fillStyle = 'rgba(255, 100, 100, 0.4)';
        ctx.beginPath();
        ctx.arc(-s * 0.45, s * 0.1, s * 0.12, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(s * 0.45, s * 0.1, s * 0.12, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    function drawMapleLeaf(cx, cy, size) {
        const s = size / 2;
        ctx.save();
        ctx.translate(cx, cy);

        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        // Simplified maple leaf shape
        ctx.moveTo(0, -s * 0.8);
        ctx.lineTo(s * 0.12, -s * 0.45);
        ctx.lineTo(s * 0.55, -s * 0.55);
        ctx.lineTo(s * 0.35, -s * 0.25);
        ctx.lineTo(s * 0.75, -s * 0.15);
        ctx.lineTo(s * 0.4, s * 0.05);
        ctx.lineTo(s * 0.5, s * 0.45);
        ctx.lineTo(s * 0.15, s * 0.3);
        ctx.lineTo(0, s * 0.7);
        ctx.lineTo(-s * 0.15, s * 0.3);
        ctx.lineTo(-s * 0.5, s * 0.45);
        ctx.lineTo(-s * 0.4, s * 0.05);
        ctx.lineTo(-s * 0.75, -s * 0.15);
        ctx.lineTo(-s * 0.35, -s * 0.25);
        ctx.lineTo(-s * 0.55, -s * 0.55);
        ctx.lineTo(-s * 0.12, -s * 0.45);
        ctx.closePath();
        ctx.fill();

        // Stem
        ctx.strokeStyle = '#8b3a2a';
        ctx.lineWidth = toCanvasLen(0.05);
        ctx.beginPath();
        ctx.moveTo(0, s * 0.45);
        ctx.lineTo(0, s * 0.85);
        ctx.stroke();

        ctx.restore();
    }

    function drawMoose(cx, cy, size) {
        const s = size / 2;
        ctx.save();
        ctx.translate(cx, cy);

        // Body
        ctx.fillStyle = '#6d4c2a';
        ctx.beginPath();
        ctx.ellipse(0, s * 0.1, s * 0.55, s * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();

        // Head
        ctx.fillStyle = '#7a5630';
        ctx.beginPath();
        ctx.ellipse(-s * 0.5, -s * 0.25, s * 0.22, s * 0.18, -0.2, 0, Math.PI * 2);
        ctx.fill();

        // Snout
        ctx.fillStyle = '#8a6540';
        ctx.beginPath();
        ctx.ellipse(-s * 0.72, -s * 0.2, s * 0.12, s * 0.09, 0, 0, Math.PI * 2);
        ctx.fill();

        // Antlers
        ctx.strokeStyle = '#5a3e20';
        ctx.lineWidth = toCanvasLen(0.05);
        ctx.lineCap = 'round';
        // Left antler
        ctx.beginPath();
        ctx.moveTo(-s * 0.4, -s * 0.4);
        ctx.lineTo(-s * 0.3, -s * 0.7);
        ctx.lineTo(-s * 0.15, -s * 0.6);
        ctx.moveTo(-s * 0.3, -s * 0.7);
        ctx.lineTo(-s * 0.45, -s * 0.75);
        ctx.stroke();
        // Right antler
        ctx.beginPath();
        ctx.moveTo(-s * 0.55, -s * 0.42);
        ctx.lineTo(-s * 0.65, -s * 0.7);
        ctx.lineTo(-s * 0.8, -s * 0.6);
        ctx.moveTo(-s * 0.65, -s * 0.7);
        ctx.lineTo(-s * 0.55, -s * 0.78);
        ctx.stroke();
        ctx.lineCap = 'butt';

        // Eye
        ctx.fillStyle = '#222';
        ctx.beginPath();
        ctx.arc(-s * 0.45, -s * 0.3, s * 0.04, 0, Math.PI * 2);
        ctx.fill();

        // Legs
        ctx.strokeStyle = '#5a3e20';
        ctx.lineWidth = toCanvasLen(0.06);
        const legs = [
            [-s * 0.3, s * 0.35, -s * 0.32, s * 0.7],
            [-s * 0.1, s * 0.35, -s * 0.08, s * 0.7],
            [s * 0.15, s * 0.35, s * 0.17, s * 0.7],
            [s * 0.35, s * 0.35, s * 0.37, s * 0.7],
        ];
        for (const [x1, y1, x2, y2] of legs) {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }

        // Tail (small stub)
        ctx.fillStyle = '#5a3e20';
        ctx.beginPath();
        ctx.ellipse(s * 0.55, s * 0.0, s * 0.08, s * 0.05, 0.3, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    function drawDonut(cx, cy, size) {
        const s = size / 2;
        ctx.save();
        ctx.translate(cx, cy);

        // Donut body
        ctx.fillStyle = '#d4903c';
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.7, 0, Math.PI * 2);
        ctx.fill();

        // Frosting (pink icing on top half)
        ctx.fillStyle = '#e84393';
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.72, Math.PI, Math.PI * 2);
        // Drippy edge
        ctx.quadraticCurveTo(s * 0.72, s * 0.15, s * 0.55, s * 0.2);
        ctx.quadraticCurveTo(s * 0.4, s * 0.35, s * 0.2, s * 0.15);
        ctx.quadraticCurveTo(0, s * 0.3, -s * 0.2, s * 0.18);
        ctx.quadraticCurveTo(-s * 0.4, s * 0.35, -s * 0.55, s * 0.15);
        ctx.quadraticCurveTo(-s * 0.72, s * 0.1, -s * 0.72, 0);
        ctx.closePath();
        ctx.fill();

        // Donut hole
        ctx.fillStyle = ICE_COLOR;
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.25, 0, Math.PI * 2);
        ctx.fill();

        // Sprinkles
        const sprinkleColors = ['#fdd835', '#4caf50', '#2196f3', '#ff5722', '#9c27b0'];
        for (let i = 0; i < 12; i++) {
            const angle = (i / 12) * Math.PI * 2;
            const r = s * (0.4 + (i % 3) * 0.08);
            const sx = Math.cos(angle) * r;
            const sy = Math.sin(angle) * r;
            const sAngle = angle + 0.5;
            ctx.fillStyle = sprinkleColors[i % sprinkleColors.length];
            ctx.save();
            ctx.translate(sx, sy);
            ctx.rotate(sAngle);
            ctx.fillRect(-s * 0.04, -s * 0.015, s * 0.08, s * 0.03);
            ctx.restore();
        }

        ctx.restore();
    }

    function drawSnowflake(cx, cy, size) {
        const s = size / 2;
        ctx.save();
        ctx.translate(cx, cy);

        ctx.strokeStyle = '#64b5f6';
        ctx.lineWidth = toCanvasLen(0.04);
        ctx.lineCap = 'round';

        // 6 main arms
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
            ctx.save();
            ctx.rotate(angle);

            // Main arm
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, -s * 0.75);
            ctx.stroke();

            // Side branches
            ctx.beginPath();
            ctx.moveTo(0, -s * 0.35);
            ctx.lineTo(s * 0.2, -s * 0.55);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, -s * 0.35);
            ctx.lineTo(-s * 0.2, -s * 0.55);
            ctx.stroke();

            // Small branches near tip
            ctx.beginPath();
            ctx.moveTo(0, -s * 0.55);
            ctx.lineTo(s * 0.12, -s * 0.68);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, -s * 0.55);
            ctx.lineTo(-s * 0.12, -s * 0.68);
            ctx.stroke();

            ctx.restore();
        }

        // Center dot
        ctx.fillStyle = '#90caf9';
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.06, 0, Math.PI * 2);
        ctx.fill();

        ctx.lineCap = 'butt';
        ctx.restore();
    }

    function drawRocket(cx, cy, size) {
        const s = size / 2;
        ctx.save();
        ctx.translate(cx, cy);

        // Flame
        ctx.fillStyle = '#ff6f00';
        ctx.beginPath();
        ctx.moveTo(-s * 0.15, s * 0.5);
        ctx.quadraticCurveTo(-s * 0.2, s * 0.85, 0, s * 0.9);
        ctx.quadraticCurveTo(s * 0.2, s * 0.85, s * 0.15, s * 0.5);
        ctx.closePath();
        ctx.fill();

        // Inner flame
        ctx.fillStyle = '#fdd835';
        ctx.beginPath();
        ctx.moveTo(-s * 0.08, s * 0.5);
        ctx.quadraticCurveTo(-s * 0.1, s * 0.72, 0, s * 0.75);
        ctx.quadraticCurveTo(s * 0.1, s * 0.72, s * 0.08, s * 0.5);
        ctx.closePath();
        ctx.fill();

        // Rocket body
        ctx.fillStyle = '#eceff1';
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.8);
        ctx.quadraticCurveTo(s * 0.25, -s * 0.5, s * 0.22, s * 0.0);
        ctx.lineTo(s * 0.22, s * 0.5);
        ctx.lineTo(-s * 0.22, s * 0.5);
        ctx.lineTo(-s * 0.22, s * 0.0);
        ctx.quadraticCurveTo(-s * 0.25, -s * 0.5, 0, -s * 0.8);
        ctx.closePath();
        ctx.fill();

        // Nose cone
        ctx.fillStyle = '#e53935';
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.8);
        ctx.quadraticCurveTo(s * 0.15, -s * 0.55, s * 0.18, -s * 0.35);
        ctx.lineTo(-s * 0.18, -s * 0.35);
        ctx.quadraticCurveTo(-s * 0.15, -s * 0.55, 0, -s * 0.8);
        ctx.closePath();
        ctx.fill();

        // Window
        ctx.fillStyle = '#42a5f5';
        ctx.beginPath();
        ctx.arc(0, -s * 0.1, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#90a4ae';
        ctx.lineWidth = toCanvasLen(0.02);
        ctx.stroke();

        // Window shine
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.beginPath();
        ctx.arc(-s * 0.03, -s * 0.13, s * 0.03, 0, Math.PI * 2);
        ctx.fill();

        // Fins
        ctx.fillStyle = '#e53935';
        // Left fin
        ctx.beginPath();
        ctx.moveTo(-s * 0.22, s * 0.25);
        ctx.lineTo(-s * 0.42, s * 0.55);
        ctx.lineTo(-s * 0.22, s * 0.5);
        ctx.closePath();
        ctx.fill();
        // Right fin
        ctx.beginPath();
        ctx.moveTo(s * 0.22, s * 0.25);
        ctx.lineTo(s * 0.42, s * 0.55);
        ctx.lineTo(s * 0.22, s * 0.5);
        ctx.closePath();
        ctx.fill();

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

        // Crosshair at the tee line intersection
        // Find where the aim line crosses y = P.farTeeLine
        const tToTee = (P.farTeeLine - startY) / Math.cos(aimRad);
        const crossX = startX + tToTee * Math.sin(aimRad);
        const crossY = P.farTeeLine;
        const cx = toCanvasX(crossX);
        const cy = toCanvasY(crossY);
        const crossSize = toCanvasLen(0.25);

        // Crosshair lines (+)
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(cx - crossSize, cy);
        ctx.lineTo(cx + crossSize, cy);
        ctx.moveTo(cx, cy - crossSize);
        ctx.lineTo(cx, cy + crossSize);
        ctx.stroke();

        // Crosshair circle
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, crossSize * 1.5, 0, Math.PI * 2);
        ctx.stroke();

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
    function updateCamera() {
        if (gameState.deliveredStone && gameState.deliveredStone.moving) {
            const stoneY = gameState.deliveredStone.y;
            // Smoothly follow the stone
            const viewSpan = 13.5;
            VIEW.targetYMin = stoneY - viewSpan * 0.3;
            VIEW.targetYMax = stoneY + viewSpan * 0.7;

            // Clamp to not go below hack or above end
            VIEW.targetYMin = Math.max(-1, VIEW.targetYMin);
            VIEW.targetYMax = Math.min(42, VIEW.targetYMax);
        } else {
            // Default: show the house area
            VIEW.targetYMin = 28;
            VIEW.targetYMax = 41.5;
        }

        // Smooth interpolation
        const lerp = 0.06;
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

    function gameLoop(timestamp) {
        if (!lastTime) lastTime = timestamp;
        let frameTime = (timestamp - lastTime) / 1000;
        lastTime = timestamp;

        // Clamp frame time to avoid spiral of death
        if (frameTime > 0.1) frameTime = 0.1;

        // Physics update
        if (gameState.phase === 'delivering') {
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

        // Auto-stop sweeping when stone passes the far hog line
        if (gameState.isSweeping && gameState.deliveredStone) {
            if (gameState.deliveredStone.y > P.farHogLine) {
                stopSweeping();
            }
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
        drawVignette();

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

    // Vignette overlay — darkens edges for cinematic focus
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

            // Side-wall bounce (reflect off boards instead of vanishing)
            if (stone.x > halfW - STONE_R) {
                stone.x = halfW - STONE_R;
                stone.vx = -Math.abs(stone.vx) * 0.5; // bounce with energy loss
                stone.omega *= 0.7; // lose some spin on wall hit
            } else if (stone.x < -halfW + STONE_R) {
                stone.x = -halfW + STONE_R;
                stone.vx = Math.abs(stone.vx) * 0.5;
                stone.omega *= 0.7;
            }

            // Way off the sides (safety — shouldn't happen with bounce)
            if (Math.abs(stone.x) > halfW + STONE_R * 2) {
                deactivateStone(stone, true);
            }

            // Didn't reach the far hog line (only for delivered stone after it has stopped)
            if (stone === gameState.deliveredStone && !stone.moving && stone.y < P.farHogLine) {
                hogLineViolation = { x: stone.x, y: stone.y, timer: 1500 }; // show text for 1.5s
                deactivateStone(stone, true);
            }
        }
    }

    // --------------------------------------------------------
    // EVENT HANDLERS
    // --------------------------------------------------------
    document.getElementById('throw-btn').addEventListener('click', () => {
        if (gameState.phase === 'aiming') {
            deliverStone();
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
    }

    // Keyboard controls
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            e.preventDefault();
            startSweeping();
        }

        if (e.code === 'Enter' && gameState.phase === 'aiming') {
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
            // Sweeping only allowed between the hog lines (real curling rule)
            const stoneY = gameState.deliveredStone.y;
            if (stoneY < P.nearHogLine || stoneY > P.farHogLine) return;

            gameState.isSweeping = true;
            if (gameState.sweepLevel === 'none') {
                gameState.sweepLevel = 'hard';
                setSweepLevel('hard');
            }
            document.getElementById('sweep-toggle-btn').classList.add('sweeping');
            document.getElementById('sweep-toggle-btn').textContent = 'SWEEPING!';
        }
    }

    function stopSweeping() {
        gameState.isSweeping = false;
        document.getElementById('sweep-toggle-btn').classList.remove('sweeping');
        document.getElementById('sweep-toggle-btn').textContent = 'SWEEP';
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
        gameState = {
            stones: [],
            currentTeam: TEAMS.RED,
            hammer: TEAMS.YELLOW,
            redThrown: 0,
            yellowThrown: 0,
            currentEnd: 1,
            totalEnds: 10,
            redScore: 0,
            yellowScore: 0,
            endScores: [],
            phase: 'aiming',
            sweepLevel: 'none',
            isSweeping: false,
            deliveredStone: null,
            simSpeed: 3.0,
        };

        document.getElementById('red-total').textContent = '0';
        document.getElementById('yellow-total').textContent = '0';
        document.getElementById('current-end').textContent = '1';
        document.getElementById('throw-btn').disabled = false;

        updateUI();
    }

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
