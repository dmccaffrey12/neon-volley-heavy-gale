/**
 * NEON VOLLEY: HEAVY GALE — 2-Player Synthwave Beach Ball PWA
 * Zero-dependency 60 FPS Arcade Aerodynamics + 2D Magnus + Spin-Wall Engine
 */
(() => {
  'use strict';

  // ============================================================================
  // 1. LOGICAL COURT DIMENSIONS & HEAVY GALE PRESET CONSTANTS
  // ============================================================================
  const WORLD_W = 844;
  const WORLD_H = 390;
  const GROUND_Y = 338;
  const CEIL_Y = 44; // Just below the top HUD pill bar
  const NET_X = WORLD_W * 0.5;
  const NET_HEIGHT = 96;
  const NET_TOP_Y = GROUND_Y - NET_HEIGHT;
  const NET_CAP_RADIUS = 8;

  const STORAGE_KEY = 'neon_volley_heavy_gale_physics_v1';

  const DEFAULT_PHYSICS = Object.freeze({
    gravity: 340,        // g = 340 px/s^2
    kDrag: 0.0036,       // Quadratic air drag k_drag = 0.0036
    kMagnus: 0.0060,     // 2D Magnus lift/dive coefficient k_magnus = 0.0060
    eWall: 0.78,         // Neon wall restitution e_wall = 0.78
    eNet: 0.72,          // Rounded net restitution e_net = 0.72
    gustScale: 1.00,     // Multiplier for dynamic wind & Heavy Gale gusts
    gameSpeed: 1.00      // Global simulation speed multiplier
  });

  let physics = loadPhysicsSettings();

  function loadPhysicsSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_PHYSICS };
      const parsed = JSON.parse(raw);
      return {
        gravity: clampNum(parsed.gravity, 160, 600, DEFAULT_PHYSICS.gravity),
        kDrag: clampNum(parsed.kDrag, 0, 0.009, DEFAULT_PHYSICS.kDrag),
        kMagnus: clampNum(parsed.kMagnus, 0, 0.014, DEFAULT_PHYSICS.kMagnus),
        eWall: DEFAULT_PHYSICS.eWall,
        eNet: DEFAULT_PHYSICS.eNet,
        gustScale: clampNum(parsed.gustScale, 0, 2.0, DEFAULT_PHYSICS.gustScale),
        gameSpeed: clampNum(parsed.gameSpeed, 0.5, 1.6, DEFAULT_PHYSICS.gameSpeed)
      };
    } catch (_) {
      return { ...DEFAULT_PHYSICS };
    }
  }

  function savePhysicsSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(physics));
    } catch (_) {}
  }

  function clampNum(val, min, max, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // ============================================================================
  // 2. WEB AUDIO API SYNTHESIZER (Muted by default: [🔇 SOUND: OFF])
  // ============================================================================
  class SynthAudioEngine {
    constructor() {
      this.enabled = false;
      this.ctx = null;
      this.windGain = null;
      this.windFilter = null;
      this.chargeOsc = null;
      this.chargeGain = null;
    }

    initContext() {
      if (this.ctx) return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();

      // Continuous filtered white-noise generator for wind gusts
      const bufferSize = this.ctx.sampleRate * 2;
      const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }

      const whiteNoise = this.ctx.createBufferSource();
      whiteNoise.buffer = noiseBuffer;
      whiteNoise.loop = true;

      this.windFilter = this.ctx.createBiquadFilter();
      this.windFilter.type = 'bandpass';
      this.windFilter.frequency.value = 320;
      this.windFilter.Q.value = 2.8;

      this.windGain = this.ctx.createGain();
      this.windGain.gain.value = 0.0;

      whiteNoise.connect(this.windFilter);
      this.windFilter.connect(this.windGain);
      this.windGain.connect(this.ctx.destination);
      whiteNoise.start(0);
    }

    toggle() {
      this.enabled = !this.enabled;
      if (this.enabled) {
        this.initContext();
        if (this.ctx && this.ctx.state === 'suspended') {
          this.ctx.resume();
        }
        this.playWallChime(520);
      } else if (this.windGain && this.ctx) {
        this.windGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      }
      return this.enabled;
    }

    updateWindSound(windSpeedAbs, isGustActive, isWarning) {
      if (!this.enabled || !this.ctx || !this.windGain || !this.windFilter) return;
      const now = this.ctx.currentTime;
      const norm = Math.min(1, windSpeedAbs / 110);
      const targetGain = isGustActive ? 0.08 * norm : isWarning ? 0.035 : 0.012 * norm;
      const targetFreq = 220 + norm * 680 + (isWarning ? 240 : 0);
      this.windGain.gain.setTargetAtTime(targetGain, now, 0.08);
      this.windFilter.frequency.setTargetAtTime(targetFreq, now, 0.08);
    }

    playStrikeBass(sweetSpot, shotType) {
      if (!this.enabled || !this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = sweetSpot ? 'sawtooth' : 'triangle';

      const baseFreq = shotType === 'DRIVE' ? 135 : shotType === 'CUT' ? 190 : 160;
      osc.frequency.setValueAtTime(baseFreq * (sweetSpot ? 1.25 : 1.0), now);
      osc.frequency.exponentialRampToValueAtTime(42, now + (sweetSpot ? 0.22 : 0.15));

      gain.gain.setValueAtTime(sweetSpot ? 0.26 : 0.16, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + (sweetSpot ? 0.24 : 0.16));

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);

      if (sweetSpot) {
        this.playWallChime(880);
      }
    }

    playWallChime(freq = 640) {
      if (!this.enabled || !this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.45, now + 0.11);

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.14);
    }

    playChargeTick(chargeRatio) {
      if (!this.enabled || !this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(280 + chargeRatio * 520, now);
      gain.gain.setValueAtTime(0.025, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.04);
    }

    playScoreFanfare(winnerSide) {
      if (!this.enabled || !this.ctx) return;
      const notes = winnerSide === 1 ? [330, 440, 554.37, 659.25] : [293.66, 369.99, 440, 587.33];
      notes.forEach((f, idx) => {
        const now = this.ctx.currentTime + idx * 0.065;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, now);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.19);
      });
    }
  }

  const audio = new SynthAudioEngine();

  // ============================================================================
  // 3. DYNAMIC WIND & HEAVY GALE GUST CONTROLLER
  // ============================================================================
  const windState = {
    time: 0,
    currentWx: 14,
    phase: 'BREEZE',        // 'BREEZE' | 'WARNING' | 'GUST'
    timer: 5.5,             // Countdown until next phase transition
    gustTargetWx: 92,       // Target Heavy Gale wx (+/- 85 to 100 px/s)
    streaks: [],
    ribbonNodes: []
  };

  // Initialize atmospheric wind streaks
  for (let i = 0; i < 26; i++) {
    windState.streaks.push({
      x: Math.random() * WORLD_W,
      y: CEIL_Y + 12 + Math.random() * (GROUND_Y - CEIL_Y - 30),
      len: 28 + Math.random() * 55,
      speedMult: 0.7 + Math.random() * 0.65,
      alpha: 0.15 + Math.random() * 0.35
    });
  }

  // Initialize multi-segment cloth ribbon on the net post (8 segments)
  for (let i = 0; i < 9; i++) {
    windState.ribbonNodes.push({
      x: NET_X + i * 5,
      y: NET_TOP_Y + 6 + i * 2,
      vy: 0
    });
  }

  function triggerImmediateGust() {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const mag = 85 + Math.random() * 15; // 85 to 100 px/s
    windState.gustTargetWx = sign * mag;
    windState.phase = 'WARNING';
    windState.timer = 1.0; // 1-second visual wind-streak warning before 4s gust
  }

  function updateWindSystem(dt) {
    windState.time += dt;
    windState.timer -= dt;

    if (windState.phase === 'BREEZE') {
      if (windState.timer <= 0) {
        const sign = Math.random() < 0.5 ? -1 : 1;
        const mag = 85 + Math.random() * 15; // 85..100 px/s
        windState.gustTargetWx = sign * mag;
        windState.phase = 'WARNING';
        windState.timer = 1.0; // 1-second visual warning
      }
    } else if (windState.phase === 'WARNING') {
      if (windState.timer <= 0) {
        windState.phase = 'GUST';
        windState.timer = 4.0; // 4-second Heavy Gale Gust
      }
    } else if (windState.phase === 'GUST') {
      if (windState.timer <= 0) {
        windState.phase = 'BREEZE';
        windState.timer = 8.0 + Math.random() * 4.0; // Every 8-12 seconds
      }
    }

    // Baseline breeze oscillates gently (+/- 30 px/s)
    const baseline = (23 * Math.sin(windState.time * 0.65) + 7 * Math.cos(windState.time * 1.45));
    const targetRaw = windState.phase === 'GUST' ? windState.gustTargetWx : baseline;
    const targetScaled = targetRaw * physics.gustScale;

    // Smoothly approach target wind speed
    const blend = Math.min(1, dt * (windState.phase === 'GUST' ? 6.5 : 3.2));
    windState.currentWx += (targetScaled - windState.currentWx) * blend;

    // Update wind streaks
    const visualVx = windState.phase === 'WARNING'
      ? windState.gustTargetWx * physics.gustScale * 0.9
      : windState.currentWx;

    for (const s of windState.streaks) {
      s.x += visualVx * s.speedMult * dt * 1.8;
      if (s.x > WORLD_W + 60) s.x = -60;
      if (s.x < -60) s.x = WORLD_W + 60;
    }

    // Update multi-segment cloth ribbon on the net post
    const nodes = windState.ribbonNodes;
    nodes[0].x = NET_X;
    nodes[0].y = NET_TOP_Y + 6;
    const segLen = 5.5;
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const cur = nodes[i];
      const flutter = Math.sin(windState.time * 14 - i * 0.9) * (1.2 + Math.abs(windState.currentWx) * 0.04);
      const targetX = prev.x + Math.sign(windState.currentWx || 1) * Math.min(segLen, Math.abs(windState.currentWx) * 0.09 + 1.2);
      const targetY = prev.y + Math.max(0.8, segLen - Math.abs(windState.currentWx) * 0.045) + flutter * 0.35;

      cur.x += (targetX - cur.x) * Math.min(1, dt * 18);
      cur.y += (targetY - cur.y) * Math.min(1, dt * 18);

      // Constraint distance to segment length
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      const d = Math.hypot(dx, dy) || 1;
      cur.x = prev.x + (dx / d) * segLen;
      cur.y = prev.y + (dy / d) * segLen;
    }

    audio.updateWindSound(
      Math.abs(windState.currentWx),
      windState.phase === 'GUST',
      windState.phase === 'WARNING'
    );
  }

  // ============================================================================
  // 4. GAME ENTITIES: BALL, PLAYERS, SHOCKWAVES & WALL FLASHES
  // ============================================================================
  const wallFlash = {
    left: 0,
    right: 0,
    top: 0,
    net: 0
  };

  const shockwaves = [];
  const particles = [];

  const ball = {
    x: WORLD_W * 0.28,
    y: 140,
    vx: 210,
    vy: -165,
    r: 13,
    omega: 0.55,          // Angular velocity in [-1.5, 1.5]
    phaseAngle: 0,        // Visual rotation angle
    trailColor: '#ff5500', // Orange topspin default
    shotLabel: 'TOPSPIN DRIVE',
    trail: [],            // 25-point spin ribbon
    hitStopFrames: 0,
    lastHitBy: 1
  };

  function createPlayer(id, sideSign, xStart, primaryColor) {
    return {
      id,
      sideSign,             // -1 for Left (P1), +1 for Right (P2)
      x: xStart,
      y: GROUND_Y,
      vx: 0,
      r: 20,
      maxSpeed: 275,
      charging: false,
      chargeTime: 0,        // 0..0.40s -> chargeRatio 0..1
      chargeRatio: 0,
      aimX: 0,
      aimY: 0,
      strikeCooldown: 0,
      color: primaryColor,
      humanActiveTimer: 0,  // Tracks recent manual input so idle sides auto-spar smoothly
      lastShotType: 'LOB'
    };
  }

  const player1 = createPlayer(1, -1, WORLD_W * 0.23, '#00f3ff');
  const player2 = createPlayer(2, +1, WORLD_W * 0.77, '#ff00aa');

  const matchState = {
    scoreP1: 0,
    scoreP2: 0,
    rallyCount: 0,
    pointPauseTimer: 0,
    bannerText: 'HEAVY GALE RALLY LIVE',
    bannerColor: '#00f3ff',
    bannerTimer: 2.2,
    servingSide: 1,
    predictedLandingX: WORLD_W * 0.72,
    predictedPoints: [],
    predictedFrames: 0
  };

  // ============================================================================
  // 5. CORE AERODYNAMIC + 2D MAGNUS + SPIN-WALL PHYSICS SOLVER
  // ============================================================================
  /**
   * Advances a ball state (live or simulated clone) by one Semi-Implicit Euler step.
   * Identical equations are used for both the live ball and the 90-120 step lookahead predictor.
   */
  function stepBallPhysics(b, dt, windWx, phys, isSimulation = false) {
    // 1. Spin decay per frame (normalized to 60 FPS frame rate)
    const frameScale = dt * 60;
    b.omega *= Math.pow(0.994, frameScale);
    b.omega = Math.max(-1.5, Math.min(1.5, b.omega));

    // 2. Relative air velocity v_rel = (vx - wx, vy)
    const vRelX = b.vx - windWx;
    const vRelY = b.vy;
    const vRel = Math.hypot(vRelX, vRelY);

    // 3. Per-Frame Acceleration (Quadratic Air Drag + 2D Magnus Lift/Dive)
    // Topspin moving right (vRelX > 0, omega > 0) -> +ay (sharp downward dive)
    // Backspin moving right (vRelX > 0, omega < 0) -> -ay (upward lift / hang)
    // Topspin moving left (vRelX < 0, omega < 0)  -> +ay (sharp downward dive)
    // Backspin moving left (vRelX < 0, omega > 0) -> -ay (upward lift / hang)
    const spinTerm = b.omega * 120;
    const ax = -phys.kDrag * vRel * vRelX - phys.kMagnus * spinTerm * vRelY;
    const ay = phys.gravity - phys.kDrag * vRel * vRelY + phys.kMagnus * spinTerm * vRelX;

    // 4. Semi-Implicit Euler Integration
    b.vx += ax * dt;
    b.vy += ay * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (!isSimulation) {
      b.phaseAngle += b.omega * frameScale * 0.22;
    }

    // 5. Glowing Arcade Wall Rebounds (Left, Right, Ceiling) + Spin-Wall Kick
    // Left Wall (wallSign = -1 so P2 topspin omega < 0 kicks downward +y)
    if (b.x - b.r < 6) {
      b.x = 6 + b.r;
      b.vx = Math.abs(b.vx) * phys.eWall;
      const wallSign = -1;
      b.vy += wallSign * b.omega * 140;
      if (!isSimulation) {
        wallFlash.left = 1.0;
        audio.playWallChime(540);
        spawnWallSparks(6, b.y, '#00f3ff', 10);
      }
    }
    // Right Wall (wallSign = +1 so P1 topspin omega > 0 kicks downward +y)
    else if (b.x + b.r > WORLD_W - 6) {
      b.x = WORLD_W - 6 - b.r;
      b.vx = -Math.abs(b.vx) * phys.eWall;
      const wallSign = +1;
      b.vy += wallSign * b.omega * 140;
      if (!isSimulation) {
        wallFlash.right = 1.0;
        audio.playWallChime(580);
        spawnWallSparks(WORLD_W - 6, b.y, '#ff00aa', 10);
      }
    }

    // Top Ceiling Rebound
    if (b.y - b.r < CEIL_Y) {
      b.y = CEIL_Y + b.r;
      b.vy = Math.abs(b.vy) * phys.eWall;
      if (!isSimulation) {
        wallFlash.top = 1.0;
        audio.playWallChime(740);
        spawnWallSparks(b.x, CEIL_Y, '#ffe600', 8);
      }
    }

    // 6. Center Rounded Net Capsule Collision
    resolveNetCapsuleCollision(b, phys, isSimulation);
  }

  function resolveNetCapsuleCollision(b, phys, isSimulation) {
    // Check collision with rounded top tape cap at (NET_X, NET_TOP_Y)
    if (b.y <= NET_TOP_Y + NET_CAP_RADIUS) {
      const dx = b.x - NET_X;
      const dy = b.y - NET_TOP_Y;
      const dist = Math.hypot(dx, dy);
      const minDist = b.r + NET_CAP_RADIUS;
      if (dist < minDist && dist > 0.0001) {
        const nx = dx / dist;
        const ny = dy / dist;
        // Separate ball from rounded tape cap
        b.x = NET_X + nx * minDist;
        b.y = NET_TOP_Y + ny * minDist;

        // Relative normal velocity
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= (1 + phys.eNet) * vn * nx;
          b.vy -= (1 + phys.eNet) * vn * ny;
          // Subtle spin-induced roll over the top tape
          b.vx += b.omega * 38;
        }
        if (!isSimulation) {
          wallFlash.net = 1.0;
          audio.playWallChime(460);
          spawnWallSparks(NET_X, NET_TOP_Y, '#ffffff', 8);
        }
      }
    } else if (b.y + b.r > NET_TOP_Y && b.y - b.r < GROUND_Y) {
      // Vertical net pillar collision below top cap
      const halfThick = 5;
      if (Math.abs(b.x - NET_X) < b.r + halfThick) {
        const dir = b.x < NET_X ? -1 : 1;
        b.x = NET_X + dir * (b.r + halfThick);
        b.vx = dir * Math.abs(b.vx) * phys.eNet;
        if (!isSimulation) {
          wallFlash.net = 1.0;
          audio.playWallChime(390);
          spawnWallSparks(NET_X, b.y, '#00f3ff', 8);
        }
      }
    }
  }

  // ============================================================================
  // 6. FORWARD-SIMULATION LOOKAHEAD (90-120 STEP TRUE LANDING PREDICTOR)
  // ============================================================================
  function computeForwardTrajectoryPrediction() {
    const simBall = {
      x: ball.x,
      y: ball.y,
      vx: ball.vx,
      vy: ball.vy,
      r: ball.r,
      omega: ball.omega
    };

    const simDt = 0.016;
    const maxSteps = 120; // Up to 120 steps (with 90+ step arc visualization)
    const points = [];
    let landed = false;
    let step = 0;

    for (step = 0; step < maxSteps; step++) {
      const prevX = simBall.x;
      const prevY = simBall.y;

      stepBallPhysics(simBall, simDt, windState.currentWx, physics, true);

      // Record every 2nd step for the 90-step visual lookahead trajectory curve
      if (step < 90 && step % 2 === 0) {
        points.push({ x: simBall.x, y: simBall.y });
      }

      if (simBall.y + simBall.r >= GROUND_Y) {
        const denom = (simBall.y - prevY) || 1;
        const frac = clampNum((GROUND_Y - simBall.r - prevY) / denom, 0, 1, 1);
        simBall.x = prevX + (simBall.x - prevX) * frac;
        simBall.y = GROUND_Y - simBall.r;
        landed = true;
        break;
      }
    }

    matchState.predictedLandingX = clampNum(simBall.x, 24, WORLD_W - 24, simBall.x);
    matchState.predictedPoints = points;
    matchState.predictedFrames = landed ? step : maxSteps;
  }

  // ============================================================================
  // 7. MULTI-MODAL INPUT CONTROLLER (1-PAD SPLIT, TOUCH AUTO-RUN, 2-PAD/KEYS)
  // ============================================================================
  let inputMode = '1PAD'; // '1PAD' | 'TOUCH' | '2PAD'
  const keysDown = new Set();
  const activeTouches = new Map(); // touch.identifier -> { side, startX, startY, curX, curY }

  window.addEventListener('keydown', (e) => {
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.code)) {
      e.preventDefault();
    }
    keysDown.add(e.code);
  });

  window.addEventListener('keyup', (e) => {
    keysDown.delete(e.code);
  });

  const canvas = document.getElementById('gameCanvas');

  function clientToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / (rect.width || 1)) * WORLD_W;
    const y = ((clientY - rect.top) / (rect.height || 1)) * WORLD_H;
    return { x, y };
  }

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const pt = clientToWorld(t.clientX, t.clientY);
      const side = pt.x < NET_X ? 1 : 2;
      activeTouches.set(t.identifier, {
        side,
        startX: pt.x,
        startY: pt.y,
        curX: pt.x,
        curY: pt.y
      });
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const entry = activeTouches.get(t.identifier);
      if (entry) {
        const pt = clientToWorld(t.clientX, t.clientY);
        entry.curX = pt.x;
        entry.curY = pt.y;
      }
    }
  }, { passive: false });

  function handleTouchEnd(e) {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      activeTouches.delete(t.identifier);
    }
  }

  canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });

  // Pointer fallback on desktop when testing TOUCH AUTO-RUN mode with mouse drag
  let mouseTouchSim = null;
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const pt = clientToWorld(e.clientX, e.clientY);
    const side = pt.x < NET_X ? 1 : 2;
    mouseTouchSim = { side, startX: pt.x, startY: pt.y, curX: pt.x, curY: pt.y };
    activeTouches.set('mouse', mouseTouchSim);
  });

  window.addEventListener('mousemove', (e) => {
    if (!mouseTouchSim) return;
    const pt = clientToWorld(e.clientX, e.clientY);
    mouseTouchSim.curX = pt.x;
    mouseTouchSim.curY = pt.y;
  });

  window.addEventListener('mouseup', () => {
    if (mouseTouchSim) {
      activeTouches.delete('mouse');
      mouseTouchSim = null;
    }
  });

  function applyDeadzone(val, dz = 0.16) {
    return Math.abs(val) < dz ? 0 : val;
  }

  function pollPlayerInputs(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad0 = pads[0] || null;
    const pad1 = pads[1] || null;

    // Default commands for P1 and P2
    const cmd1 = { moveX: 0, chargeHeld: false, aimX: 0, aimY: 0, isHuman: false };
    const cmd2 = { moveX: 0, chargeHeld: false, aimX: 0, aimY: 0, isHuman: false };

    // ------------------------------------------------------------------------
    // A. KEYBOARD INPUTS (Always available across modes for instant testing)
    // ------------------------------------------------------------------------
    const k1Left = keysDown.has('KeyA') ? -1 : 0;
    const k1Right = keysDown.has('KeyD') ? 1 : 0;
    const k1Up = keysDown.has('KeyW') ? -1 : 0;
    const k1Down = keysDown.has('KeyS') ? 1 : 0;
    const k1Charge = keysDown.has('Space');

    if (k1Left || k1Right || k1Up || k1Down || k1Charge) {
      cmd1.moveX = k1Left + k1Right;
      cmd1.chargeHeld = k1Charge;
      cmd1.aimX = k1Left + k1Right;
      cmd1.aimY = k1Up + k1Down;
      cmd1.isHuman = true;
    }

    const k2Left = keysDown.has('ArrowLeft') ? -1 : 0;
    const k2Right = keysDown.has('ArrowRight') ? 1 : 0;
    const k2Up = keysDown.has('ArrowUp') ? -1 : 0;
    const k2Down = keysDown.has('ArrowDown') ? 1 : 0;
    const k2Charge = keysDown.has('Enter') || keysDown.has('NumpadEnter');

    if (k2Left || k2Right || k2Up || k2Down || k2Charge) {
      cmd2.moveX = k2Left + k2Right;
      cmd2.chargeHeld = k2Charge;
      cmd2.aimX = k2Left + k2Right;
      cmd2.aimY = k2Up + k2Down;
      cmd2.isHuman = true;
    }

    // ------------------------------------------------------------------------
    // B. MODE 1: 1-PAD SPLIT (Stadia Single-Controller Mode on gamepads[0])
    // ------------------------------------------------------------------------
    if (inputMode === '1PAD' && pad0) {
      // Player 1 (Left Side): Left Stick X (axes[0]) or D-Pad Left/Right (buttons[14]/[15])
      const dpadLeft = pad0.buttons[14]?.pressed ? -1 : 0;
      const dpadRight = pad0.buttons[15]?.pressed ? 1 : 0;
      const dpadUp = pad0.buttons[12]?.pressed ? -1 : 0;
      const dpadDown = pad0.buttons[13]?.pressed ? 1 : 0;
      const lx = applyDeadzone(pad0.axes[0] || 0) || (dpadLeft + dpadRight);
      const ly = applyDeadzone(pad0.axes[1] || 0) || (dpadUp + dpadDown);
      const p1Charge = Boolean(pad0.buttons[4]?.pressed || pad0.buttons[6]?.pressed); // L1 or L2

      if (lx !== 0 || ly !== 0 || p1Charge) {
        cmd1.moveX = lx;
        cmd1.chargeHeld = p1Charge;
        cmd1.aimX = lx;
        cmd1.aimY = ly;
        cmd1.isHuman = true;
      }

      // Player 2 (Right Side): Right Stick X (axes[2]) moves; R1(5), R2(7), or A(0) charges
      const rx = applyDeadzone(pad0.axes[2] || 0);
      const ry = applyDeadzone(pad0.axes[3] || 0);
      const p2Charge = Boolean(
        pad0.buttons[5]?.pressed ||
        pad0.buttons[7]?.pressed ||
        pad0.buttons[0]?.pressed
      );

      if (rx !== 0 || ry !== 0 || p2Charge) {
        cmd2.moveX = rx;
        cmd2.chargeHeld = p2Charge;
        cmd2.aimX = rx;
        cmd2.aimY = ry;
        cmd2.isHuman = true;
      }
    }

    // ------------------------------------------------------------------------
    // C. MODE 3: 2-PAD / KEYBOARD
    // ------------------------------------------------------------------------
    if (inputMode === '2PAD') {
      if (pad0) {
        const lx = applyDeadzone(pad0.axes[0] || 0) || ((pad0.buttons[14]?.pressed ? -1 : 0) + (pad0.buttons[15]?.pressed ? 1 : 0));
        const ly = applyDeadzone(pad0.axes[1] || 0);
        const charge0 = Boolean(pad0.buttons[0]?.pressed || pad0.buttons[4]?.pressed || pad0.buttons[5]?.pressed || pad0.buttons[6]?.pressed || pad0.buttons[7]?.pressed);
        if (lx !== 0 || ly !== 0 || charge0) {
          cmd1.moveX = lx;
          cmd1.chargeHeld = charge0;
          cmd1.aimX = lx;
          cmd1.aimY = ly;
          cmd1.isHuman = true;
        }
      }
      if (pad1) {
        const lx = applyDeadzone(pad1.axes[0] || 0) || ((pad1.buttons[14]?.pressed ? -1 : 0) + (pad1.buttons[15]?.pressed ? 1 : 0));
        const ly = applyDeadzone(pad1.axes[1] || 0);
        const charge1 = Boolean(pad1.buttons[0]?.pressed || pad1.buttons[4]?.pressed || pad1.buttons[5]?.pressed || pad1.buttons[6]?.pressed || pad1.buttons[7]?.pressed);
        if (lx !== 0 || ly !== 0 || charge1) {
          cmd2.moveX = lx;
          cmd2.chargeHeld = charge1;
          cmd2.aimX = lx;
          cmd2.aimY = ly;
          cmd2.isHuman = true;
        }
      }
    }

    // ------------------------------------------------------------------------
    // D. TOUCH PARTITIONING (Active in TOUCH AUTO-RUN or when touching screen)
    // ------------------------------------------------------------------------
    for (const touch of activeTouches.values()) {
      const dx = (touch.curX - touch.startX) / 36;
      const dy = (touch.curY - touch.startY) / 36;
      if (touch.side === 1) {
        cmd1.chargeHeld = true;
        cmd1.aimX = clampNum(dx, -1, 1, 0);
        cmd1.aimY = clampNum(dy, -1, 1, 0);
        cmd1.isHuman = true;
      } else {
        cmd2.chargeHeld = true;
        cmd2.aimX = clampNum(dx, -1, 1, 0);
        cmd2.aimY = clampNum(dy, -1, 1, 0);
        cmd2.isHuman = true;
      }
    }

    // Track recent manual control per player; if a side has no human input,
    // use smart Auto-Run + Auto-Strike so solo players or spectators get nonstop rallies
    updatePlayerControl(player1, cmd1, dt);
    updatePlayerControl(player2, cmd2, dt);
  }

  function computeAutoRunMoveX(player) {
    const isOnMySide = player.id === 1
      ? matchState.predictedLandingX < NET_X
      : matchState.predictedLandingX >= NET_X;

    const homeX = player.id === 1 ? WORLD_W * 0.23 : WORLD_W * 0.77;
    // Stand slightly behind predicted landing spot to strike cleanly forward
    const offset = player.id === 1 ? -10 : 10;
    const targetX = isOnMySide ? (matchState.predictedLandingX + offset) : homeX;
    const diff = targetX - player.x;
    if (Math.abs(diff) < 4) return 0;
    return clampNum(diff / 34, -1, 1, 0);
  }

  // ============================================================================
  // 8. "STRAFE, CHARGE, & SHAPE" STRIKE SYSTEM + HEADWIND GUARDRAIL
  // ============================================================================
  function updatePlayerControl(player, cmd, dt) {
    if (player.strikeCooldown > 0) {
      player.strikeCooldown = Math.max(0, player.strikeCooldown - dt);
    }

    if (cmd.isHuman) {
      player.humanActiveTimer = 6.0; // Stay in manual control for 6s after last input
    } else if (player.humanActiveTimer > 0) {
      player.humanActiveTimer = Math.max(0, player.humanActiveTimer - dt);
    }

    const useAutoRunFootwork = (inputMode === 'TOUCH') || (player.humanActiveTimer <= 0);
    let moveX = useAutoRunFootwork ? computeAutoRunMoveX(player) : cmd.moveX;
    let chargeHeld = cmd.chargeHeld;
    let aimX = cmd.aimX;
    let aimY = cmd.aimY;

    // Smart Auto-Sparring when a side has no active human controller/touch
    const distToBall = Math.hypot(ball.x - player.x, (ball.y - (player.y - 18)));
    const ballOnMySide = player.id === 1 ? ball.x < NET_X + 15 : ball.x >= NET_X - 15;

    if (!cmd.isHuman && player.humanActiveTimer <= 0) {
      // Begin charging as ball approaches within strike window
      if (ballOnMySide && distToBall < 155 && ball.vy > -120 && player.strikeCooldown <= 0) {
        chargeHeld = true;
        // Release inside the Sweet Spot (0.72..0.92) or right when ball enters inner strike halo
        if ((player.chargeRatio >= 0.76 && distToBall <= 82) || distToBall <= 52) {
          chargeHeld = false;
          // Choose shot shape dynamically based on court position & wind
          const roll = (matchState.rallyCount + player.id) % 3;
          const forwardDir = player.id === 1 ? 1 : -1;
          if (roll === 0) {
            aimX = forwardDir * 0.9; // Topspin Drive
            aimY = 0;
          } else if (roll === 1) {
            aimX = -forwardDir * 0.85; // Backspin Cut
            aimY = 0.6;
          } else {
            aimX = 0;
            aimY = -0.85; // Sky Lob
          }
        }
      }
    }

    // 1. Magnetized Strike Strafe:
    // While holding charge, player continues moving at 65% strafe speed
    // and subtly magnetizes toward the ball if it enters the 85px strike halo.
    const speedFactor = player.charging ? 0.65 : 1.0;
    player.vx = moveX * player.maxSpeed * speedFactor;

    if (player.charging && distToBall <= 85 && ballOnMySide) {
      const magPullX = clampNum((ball.x - player.x) * 3.4, -135, 135, 0);
      player.vx += magPullX * 0.55;
    }

    player.x += player.vx * dt;

    // Clamp player within their court boundaries
    const minX = player.id === 1 ? 24 : NET_X + 26;
    const maxX = player.id === 1 ? NET_X - 26 : WORLD_W - 24;
    player.x = clampNum(player.x, minX, maxX, player.x);

    // 2. Charge & Sweet Spot Ring (0.0 -> 1.0 over 0.40s)
    if (chargeHeld && player.strikeCooldown <= 0) {
      player.charging = true;
      const prevRatio = player.chargeRatio;
      player.chargeTime += dt;
      player.chargeRatio = Math.min(1.0, player.chargeTime / 0.40);
      player.aimX = aimX;
      player.aimY = aimY;

      if (Math.floor(player.chargeRatio * 5) > Math.floor(prevRatio * 5)) {
        audio.playChargeTick(player.chargeRatio);
      }

      // Auto-trigger strike if player holds charge and ball gets deep inside core contact radius
      if (distToBall <= 40 && ballOnMySide && player.chargeRatio >= 0.25) {
        attemptPlayerStrike(player, player.aimX, player.aimY);
      }
    } else if (player.charging && !chargeHeld) {
      // Released charge input -> execute directional spin-shaped strike if ball is within 85px halo
      const releaseAimX = Math.abs(aimX) > 0.05 || Math.abs(aimY) > 0.05 ? aimX : player.aimX;
      const releaseAimY = Math.abs(aimX) > 0.05 || Math.abs(aimY) > 0.05 ? aimY : player.aimY;
      attemptPlayerStrike(player, releaseAimX, releaseAimY);
      player.charging = false;
      player.chargeTime = 0;
      player.chargeRatio = 0;
    } else {
      // Passive defensive bump if ball hits player body without charging
      if (distToBall <= player.r + ball.r + 4 && player.strikeCooldown <= 0) {
        attemptPlayerStrike(player, 0, -0.8);
      }
    }
  }

  function attemptPlayerStrike(player, aimX, aimY) {
    const strikeCenterY = player.y - 18;
    const dist = Math.hypot(ball.x - player.x, ball.y - strikeCenterY);

    // Generous 85px magnetized strike halo
    if (dist > 85 || player.strikeCooldown > 0) {
      player.charging = false;
      player.chargeTime = 0;
      player.chargeRatio = 0;
      return;
    }

    const forwardSign = player.id === 1 ? 1 : -1; // +1 for P1 (shoots right), -1 for P2 (shoots left)
    const forwardTilt = aimX * forwardSign;       // > 0 means tilting toward net, < 0 means tilting back

    // ------------------------------------------------------------------------
    // Directional Spin Shaping (at button/touch release)
    // ------------------------------------------------------------------------
    let launchDeg = 66;
    let omegaMag = -0.42; // Light backspin for Sky Lob
    let trailColor = '#ff00aa';
    let shotType = 'LOB';
    let shotLabel = 'SKY LOB (66°)';

    if (forwardTilt > 0.28) {
      // Forward Tilt -> Topspin Drive (28 deg launch, high forward omega, orange neon trail #ff5500)
      launchDeg = 28;
      omegaMag = +1.22; // Positive forward spin
      trailColor = '#ff5500';
      shotType = 'DRIVE';
      shotLabel = 'TOPSPIN DRIVE (28°)';
    } else if (forwardTilt < -0.25 || aimY > 0.35) {
      // Back/Down Tilt -> Backspin Cut (44 deg launch, high reverse omega, cyan neon trail #00f3ff)
      launchDeg = 44;
      omegaMag = -1.18; // High reverse backspin
      trailColor = '#00f3ff';
      shotType = 'CUT';
      shotLabel = 'BACKSPIN CUT (44°)';
    } else {
      // Upward Tilt / Neutral -> Sky Lob (66 deg launch, light backspin, magenta-white trail #ff00aa)
      launchDeg = 66;
      omegaMag = -0.45;
      trailColor = '#ff00aa';
      shotType = 'LOB';
      shotLabel = 'SKY LOB (66°)';
    }

    // Sweet Spot check (0.70 - 0.95)
    const isSweetSpot = player.chargeRatio >= 0.70 && player.chargeRatio <= 0.95;
    const sweetMultiplier = isSweetSpot ? 1.25 : (0.94 + player.chargeRatio * 0.16);

    // ------------------------------------------------------------------------
    // Smart Headwind & Distance Guardrail:
    // v_launch = v_base + 0.35 * |x_player - x_net| + 0.85 * max(0, headwindAgainstShot)
    // ------------------------------------------------------------------------
    const vBase = shotType === 'DRIVE' ? 370 : shotType === 'CUT' ? 335 : 355;
    const distFromNet = Math.abs(player.x - NET_X);
    // Headwind opposing the horizontal shot direction (forwardSign)
    const headwindAgainstShot = Math.max(0, -windState.currentWx * forwardSign);
    const vLaunchGuardrail = vBase + 0.35 * distFromNet + 0.85 * headwindAgainstShot;
    const finalSpeed = vLaunchGuardrail * sweetMultiplier;

    const rad = (launchDeg * Math.PI) / 180;
    ball.vx = forwardSign * Math.cos(rad) * finalSpeed;
    ball.vy = -Math.sin(rad) * finalSpeed;

    // Sign-aligned angular velocity omega in [-1.5, 1.5]
    // For P1 (forwardSign = +1): topspin has omega > 0, backspin has omega < 0
    // For P2 (forwardSign = -1): topspin has omega < 0, backspin has omega > 0
    ball.omega = clampNum(
      forwardSign * omegaMag * (isSweetSpot ? 1.25 : 1.0),
      -1.5,
      1.5,
      forwardSign * omegaMag
    );

    ball.trailColor = trailColor;
    ball.shotLabel = isSweetSpot ? `⚡ SWEET ${shotLabel}` : shotLabel;
    ball.lastHitBy = player.id;

    // Gently lift ball above contact point to prevent immediate double-collision
    ball.x = clampNum(ball.x, 20, WORLD_W - 20, ball.x);
    ball.y = Math.min(ball.y, GROUND_Y - 34);

    player.strikeCooldown = 0.26;
    player.charging = false;
    player.chargeTime = 0;
    player.chargeRatio = 0;
    player.lastShotType = shotType;

    matchState.rallyCount += 1;

    // Sweet Spot triggers 2-frame hit-stop pause + expanding neon shockwave ring
    if (isSweetSpot) {
      ball.hitStopFrames = 2;
      shockwaves.push({
        x: ball.x,
        y: ball.y,
        r: 14,
        maxR: 95,
        alpha: 1.0,
        color: trailColor
      });
      matchState.bannerText = `P${player.id} SWEET SPOT! ${shotLabel}`;
      matchState.bannerColor = trailColor;
      matchState.bannerTimer = 1.3;
    } else {
      shockwaves.push({
        x: ball.x,
        y: ball.y,
        r: 10,
        maxR: 52,
        alpha: 0.75,
        color: trailColor
      });
    }

    spawnWallSparks(ball.x, ball.y, trailColor, isSweetSpot ? 16 : 9);
    audio.playStrikeBass(isSweetSpot, shotType);
  }

  // ============================================================================
  // 9. SCORING, SERVE RESET & PARTICLE EFFECTS
  // ============================================================================
  function spawnWallSparks(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 45 + Math.random() * 165;
      particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: 0.25 + Math.random() * 0.25,
        maxLife: 0.5,
        color
      });
    }
  }

  function handleSandTouchdown() {
    // Ball touched sand floor (GROUND_Y)
    const landedLeft = ball.x < NET_X;
    const winner = landedLeft ? 2 : 1;

    if (winner === 1) {
      matchState.scoreP1 += 1;
      document.getElementById('scoreP1').textContent = String(matchState.scoreP1);
    } else {
      matchState.scoreP2 += 1;
      document.getElementById('scoreP2').textContent = String(matchState.scoreP2);
    }

    matchState.servingSide = winner;
    matchState.pointPauseTimer = 1.05;
    matchState.bannerText = `POINT PLAYER ${winner}! (${matchState.rallyCount} HIT RALLY)`;
    matchState.bannerColor = winner === 1 ? '#00f3ff' : '#ff00aa';
    matchState.bannerTimer = 1.6;

    shockwaves.push({
      x: ball.x,
      y: GROUND_Y,
      r: 10,
      maxR: 85,
      alpha: 1.0,
      color: winner === 1 ? '#00f3ff' : '#ff00aa'
    });
    spawnWallSparks(ball.x, GROUND_Y, '#ffe600', 18);
    audio.playScoreFanfare(winner);
  }

  function launchNextServe(serverSide) {
    matchState.rallyCount = 0;
    player1.x = WORLD_W * 0.23;
    player2.x = WORLD_W * 0.77;
    player1.charging = false;
    player2.charging = false;
    player1.chargeRatio = 0;
    player2.chargeRatio = 0;

    const dir = serverSide === 1 ? 1 : -1;
    ball.x = serverSide === 1 ? WORLD_W * 0.26 : WORLD_W * 0.74;
    ball.y = 148;

    // Apply Smart Headwind Guardrail to the serve toss so it always clears the net cleanly
    const distFromNet = Math.abs(ball.x - NET_X);
    const headwind = Math.max(0, -windState.currentWx * dir);
    const serveSpeed = 325 + 0.30 * distFromNet + 0.80 * headwind;
    const serveAngle = (52 * Math.PI) / 180;

    ball.vx = dir * Math.cos(serveAngle) * serveSpeed;
    ball.vy = -Math.sin(serveAngle) * serveSpeed;
    ball.omega = dir * 0.52;
    ball.trailColor = serverSide === 1 ? '#00f3ff' : '#ff00aa';
    ball.shotLabel = `P${serverSide} SYNTH SERVE`;
    ball.trail.length = 0;
  }

  // ============================================================================
  // 10. MAIN 60 FPS SIMULATION UPDATE LOOP
  // ============================================================================
  function updateSimulation(rawDt) {
    // Clamp dt <= 0.033s as specified
    const clampedDt = Math.min(0.033, Math.max(0.001, rawDt));
    const dt = clampedDt * physics.gameSpeed;

    updateWindSystem(dt);
    updateHudWindMeter();

    // Decay wall glow flashes & banners
    wallFlash.left = Math.max(0, wallFlash.left - dt * 3.4);
    wallFlash.right = Math.max(0, wallFlash.right - dt * 3.4);
    wallFlash.top = Math.max(0, wallFlash.top - dt * 3.4);
    wallFlash.net = Math.max(0, wallFlash.net - dt * 3.4);

    if (matchState.bannerTimer > 0) {
      matchState.bannerTimer = Math.max(0, matchState.bannerTimer - dt);
    }

    // Update shockwaves & spark particles
    for (let i = shockwaves.length - 1; i >= 0; i--) {
      const sw = shockwaves[i];
      sw.r += (sw.maxR - sw.r) * Math.min(1, dt * 11);
      sw.alpha -= dt * 2.4;
      if (sw.alpha <= 0) shockwaves.splice(i, 1);
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 240 * dt;
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }

    // Between-point pause before next serve
    if (matchState.pointPauseTimer > 0) {
      matchState.pointPauseTimer -= dt;
      if (matchState.pointPauseTimer <= 0) {
        launchNextServe(matchState.servingSide);
      }
      computeForwardTrajectoryPrediction();
      return;
    }

    // 2-Frame Sweet Spot Hit-Stop Pause
    if (ball.hitStopFrames > 0) {
      ball.hitStopFrames -= 1;
      computeForwardTrajectoryPrediction();
      return;
    }

    // Step live ball aerodynamics, 2D Magnus lift/dive, and spin-wall rebounds
    stepBallPhysics(ball, dt, windState.currentWx, physics, false);

    // Record 25-point color-coded ball spin ribbon
    ball.trail.unshift({
      x: ball.x,
      y: ball.y,
      color: ball.trailColor,
      omega: ball.omega
    });
    if (ball.trail.length > 25) {
      ball.trail.length = 25;
    }

    // Run 90-120 step forward-simulation landing predictor every frame
    computeForwardTrajectoryPrediction();

    // Update players (Multi-modal input + Magnetized Strike Strafe + Charge/Shape)
    pollPlayerInputs(dt);

    // Check sand touchdown (Zero out-of-bounds: only sand floor ends the rally)
    if (ball.y + ball.r >= GROUND_Y) {
      ball.y = GROUND_Y - ball.r;
      handleSandTouchdown();
    }
  }

  // ============================================================================
  // 11. TWILIGHT SYNTHWAVE PROCEDURAL RENDERER
  // ============================================================================
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function renderScene() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.save();
    ctx.scale(w / WORLD_W, h / WORLD_H);

    // 1. Deep Violet Twilight Sky (#090414 -> #1c0836)
    const skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    skyGrad.addColorStop(0, '#090414');
    skyGrad.addColorStop(0.58, '#16072c');
    skyGrad.addColorStop(1, '#2b0948');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);

    // 2. Segmented Outrun Sunset Disc
    drawOutrunSun();

    // 3. Distant Synthwave Wireframe Mountains
    drawSynthMountains();

    // 4. Perspective Neon Sand Grid
    drawPerspectiveSandGrid();

    // 5. Atmospheric Wind Streaks & Gust Warning Overlay
    drawWindStreaks();

    // 6. Glowing Arcade Rebound Walls (Left, Right, Top Ceiling)
    drawNeonReboundWalls();

    // 7. Forward-Simulation Trajectory Curve & Pulsing Target Reticle on Sand
    drawLandingPredictorAndReticle();

    // 8. Center Rounded Net Capsule & Waving Multi-Segment Wind Ribbon
    drawNetAndRibbon();

    // 9. Players, Magnetized Strike Halo & Circular Charge / Sweet Spot Rings
    drawPlayer(player1);
    drawPlayer(player2);

    // 10. 25-Point Color-Coded Spin Ribbon & Rotating Synth Beach Ball
    drawBallAndSpinRibbon();

    // 11. Expanding Sweet-Spot Shockwaves, Sparks & Dynamic Callout Banner
    drawEffectsAndBanner();

    ctx.restore();
  }

  function drawOutrunSun() {
    const sunX = NET_X;
    const sunY = GROUND_Y - 78;
    const sunR = 76;

    ctx.save();
    // Outer glow
    const glow = ctx.createRadialGradient(sunX, sunY, sunR * 0.2, sunX, sunY, sunR * 1.55);
    glow.addColorStop(0, 'rgba(255, 85, 0, 0.42)');
    glow.addColorStop(0.5, 'rgba(255, 0, 170, 0.20)');
    glow.addColorStop(1, 'rgba(9, 4, 20, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR * 1.55, 0, Math.PI * 2);
    ctx.fill();

    // Clip circle with horizontal synthwave scanline cutouts
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    ctx.clip();

    const sunGrad = ctx.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
    sunGrad.addColorStop(0, '#ffe600');
    sunGrad.addColorStop(0.45, '#ff5500');
    sunGrad.addColorStop(1, '#ff00aa');
    ctx.fillStyle = sunGrad;
    ctx.fillRect(sunX - sunR, sunY - sunR, sunR * 2, sunR * 2);

    // Segmented horizontal slices in lower half of the sun
    ctx.fillStyle = '#1b0733';
    for (let i = 0; i < 7; i++) {
      const sliceY = sunY - 4 + i * 11;
      const sliceH = 1.6 + i * 0.85;
      ctx.fillRect(sunX - sunR, sliceY, sunR * 2, sliceH);
    }
    ctx.restore();
  }

  function drawSynthMountains() {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    const peaks = [
      [0, 312], [75, 282], [140, 304], [220, 268], [305, 308],
      [370, 292], [422, 315], [485, 290], [560, 264], [645, 302],
      [725, 274], [795, 298], [844, 310]
    ];
    for (const [px, py] of peaks) {
      ctx.lineTo(px, py);
    }
    ctx.lineTo(WORLD_W, GROUND_Y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(11, 4, 24, 0.88)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 0, 170, 0.45)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }

  function drawPerspectiveSandGrid() {
    // Dark synth floor base
    const floorGrad = ctx.createLinearGradient(0, GROUND_Y, 0, WORLD_H);
    floorGrad.addColorStop(0, '#14052b');
    floorGrad.addColorStop(1, '#06020d');
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, GROUND_Y, WORLD_W, WORLD_H - GROUND_Y);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, GROUND_Y, WORLD_W, WORLD_H - GROUND_Y);
    ctx.clip();

    // Perspective rays converging toward horizon center
    ctx.strokeStyle = 'rgba(255, 0, 170, 0.36)';
    ctx.lineWidth = 1;
    const horizonX = NET_X;
    for (let i = -12; i <= 12; i++) {
      const topX = horizonX + i * 38;
      const botX = horizonX + i * 95;
      ctx.beginPath();
      ctx.moveTo(topX, GROUND_Y);
      ctx.lineTo(botX, WORLD_H);
      ctx.stroke();
    }

    // Horizontal perspective depth lines
    const rows = [0, 6, 14, 24, 36, 50];
    for (const dy of rows) {
      const y = GROUND_Y + dy;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD_W, y);
      ctx.stroke();
    }
    ctx.restore();

    // Glowing sand baseline
    ctx.save();
    ctx.strokeStyle = '#00f3ff';
    ctx.lineWidth = 2.2;
    ctx.shadowColor = '#00f3ff';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(6, GROUND_Y);
    ctx.lineTo(WORLD_W - 6, GROUND_Y);
    ctx.stroke();
    ctx.restore();
  }

  function drawWindStreaks() {
    const isWarn = windState.phase === 'WARNING';
    const isGust = windState.phase === 'GUST';
    const dir = Math.sign(
      (isWarn ? windState.gustTargetWx : windState.currentWx) || 1
    );

    ctx.save();
    for (const s of windState.streaks) {
      ctx.strokeStyle = isGust
        ? `rgba(255, 85, 0, ${s.alpha + 0.25})`
        : isWarn
        ? `rgba(255, 230, 0, ${s.alpha + 0.2})`
        : `rgba(0, 243, 255, ${s.alpha * 0.7})`;
      ctx.lineWidth = isGust ? 2.0 : 1.2;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + dir * s.len, s.y);
      ctx.stroke();
    }

    // 1-second Heavy Gale Warning Banner
    if (isWarn) {
      const pulse = 0.55 + 0.45 * Math.sin(windState.time * 24);
      const arrow = windState.gustTargetWx > 0 ? '>>>' : '<<<';
      ctx.font = 'bold 12px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(255, 230, 0, ${pulse})`;
      ctx.shadowColor = '#ffe600';
      ctx.shadowBlur = 10;
      ctx.fillText(
        `${arrow} HEAVY GALE WARNING (${Math.round(windState.gustTargetWx * physics.gustScale)} px/s) ${arrow}`,
        NET_X,
        CEIL_Y + 18
      );
    }
    ctx.restore();
  }

  function drawNeonReboundWalls() {
    // Left Wall (Cyan neon + flash on ball impact)
    ctx.save();
    const leftGlow = 8 + wallFlash.left * 22;
    ctx.strokeStyle = wallFlash.left > 0.1 ? '#ffffff' : '#00f3ff';
    ctx.lineWidth = 3 + wallFlash.left * 4;
    ctx.shadowColor = '#00f3ff';
    ctx.shadowBlur = leftGlow;
    ctx.beginPath();
    ctx.moveTo(5, CEIL_Y);
    ctx.lineTo(5, GROUND_Y);
    ctx.stroke();

    // Right Wall (Magenta neon + flash on ball impact)
    const rightGlow = 8 + wallFlash.right * 22;
    ctx.strokeStyle = wallFlash.right > 0.1 ? '#ffffff' : '#ff00aa';
    ctx.lineWidth = 3 + wallFlash.right * 4;
    ctx.shadowColor = '#ff00aa';
    ctx.shadowBlur = rightGlow;
    ctx.beginPath();
    ctx.moveTo(WORLD_W - 5, CEIL_Y);
    ctx.lineTo(WORLD_W - 5, GROUND_Y);
    ctx.stroke();

    // Top Ceiling Rebound Wall
    const topGlow = 6 + wallFlash.top * 20;
    ctx.strokeStyle = wallFlash.top > 0.1 ? '#ffe600' : 'rgba(0, 243, 255, 0.55)';
    ctx.lineWidth = 2.2 + wallFlash.top * 3.5;
    ctx.shadowColor = '#00f3ff';
    ctx.shadowBlur = topGlow;
    ctx.beginPath();
    ctx.moveTo(5, CEIL_Y);
    ctx.lineTo(WORLD_W - 5, CEIL_Y);
    ctx.stroke();
    ctx.restore();
  }

  function drawLandingPredictorAndReticle() {
    const pts = matchState.predictedPoints;
    if (pts && pts.length > 1) {
      ctx.save();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const ratio = 1 - i / pts.length;
        ctx.fillStyle = `rgba(0, 243, 255, ${ratio * 0.42})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Pulsing Neon Target Reticle on the sand at predictedLandingX
    const tx = matchState.predictedLandingX;
    const pulse = 1 + 0.22 * Math.sin(windState.time * 12);
    const reticleColor = tx < NET_X ? '#00f3ff' : '#ff00aa';

    ctx.save();
    ctx.translate(tx, GROUND_Y);
    ctx.strokeStyle = reticleColor;
    ctx.lineWidth = 2;
    ctx.shadowColor = reticleColor;
    ctx.shadowBlur = 12;

    // Outer pulsing ellipse on the sand plane
    ctx.beginPath();
    ctx.ellipse(0, 0, 18 * pulse, 5.5 * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Inner bullseye ring
    ctx.beginPath();
    ctx.ellipse(0, 0, 7, 2.5, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Vertical laser beacon spike
    const beaconGrad = ctx.createLinearGradient(0, -34, 0, 0);
    beaconGrad.addColorStop(0, 'rgba(255,255,255,0)');
    beaconGrad.addColorStop(1, reticleColor);
    ctx.strokeStyle = beaconGrad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -32);
    ctx.lineTo(0, 0);
    ctx.stroke();

    ctx.restore();
  }

  function drawNetAndRibbon() {
    ctx.save();
    // Waving Multi-Segment Cloth Ribbon on the Net Post (shows wind speed & direction)
    const nodes = windState.ribbonNodes;
    if (nodes.length > 1) {
      ctx.beginPath();
      ctx.moveTo(nodes[0].x, nodes[0].y);
      for (let i = 1; i < nodes.length; i++) {
        ctx.lineTo(nodes[i].x, nodes[i].y);
      }
      ctx.strokeStyle = windState.phase === 'GUST' ? '#ff5500' : '#ffe600';
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 10;
      ctx.stroke();
    }

    // Net Pillar
    const netGlow = 10 + wallFlash.net * 20;
    const netGrad = ctx.createLinearGradient(0, NET_TOP_Y, 0, GROUND_Y);
    netGrad.addColorStop(0, '#ffffff');
    netGrad.addColorStop(0.3, '#00f3ff');
    netGrad.addColorStop(1, '#ff00aa');

    ctx.fillStyle = netGrad;
    ctx.shadowColor = '#00f3ff';
    ctx.shadowBlur = netGlow;
    ctx.fillRect(NET_X - 4, NET_TOP_Y, 8, NET_HEIGHT);

    // Rounded Net Top Tape Capsule
    ctx.beginPath();
    ctx.arc(NET_X, NET_TOP_Y, NET_CAP_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 14;
    ctx.fill();
    ctx.restore();
  }

  function drawPlayer(p) {
    ctx.save();
    const centerY = p.y - 16;

    // Subtle 85px Strike Halo indicator when charging
    if (p.charging) {
      ctx.beginPath();
      ctx.arc(p.x, centerY, 85, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);

      // Circular Neon Charge Ring (0.0 -> 1.0 over 0.40s) + Sweet Spot Zone (0.70 - 0.95)
      const ringR = 30;
      const startAng = -Math.PI * 0.5;
      // Sweet spot arc highlight (0.70 to 0.95)
      ctx.beginPath();
      ctx.arc(
        p.x,
        centerY,
        ringR,
        startAng + 0.70 * Math.PI * 2,
        startAng + 0.95 * Math.PI * 2
      );
      ctx.strokeStyle = 'rgba(255, 230, 0, 0.45)';
      ctx.lineWidth = 6;
      ctx.stroke();

      // Active charge progress arc
      const isSweet = p.chargeRatio >= 0.70 && p.chargeRatio <= 0.95;
      const ringColor = isSweet ? '#ffe600' : p.color;
      ctx.beginPath();
      ctx.arc(
        p.x,
        centerY,
        ringR,
        startAng,
        startAng + p.chargeRatio * Math.PI * 2
      );
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 3.5;
      ctx.shadowColor = ringColor;
      ctx.shadowBlur = isSweet ? 14 : 8;
      ctx.stroke();
    }

    // Player Synthwave Capsule Pod Avatar
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#110626';
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 2.6;

    ctx.beginPath();
    ctx.arc(p.x, p.y - 14, p.r, Math.PI, 0, false);
    ctx.lineTo(p.x + p.r, p.y);
    ctx.lineTo(p.x - p.r, p.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Visor sunglass stripe
    const visorDir = p.id === 1 ? 5 : -5;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(p.x + visorDir - 7, p.y - 22, 14, 4);

    // Player label
    ctx.font = 'bold 10px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = p.color;
    ctx.fillText(`P${p.id}`, p.x, p.y - 38);

    ctx.restore();
  }

  function drawBallAndSpinRibbon() {
    // 1. 25-Point Color-Coded Ball Spin Ribbon
    const trail = ball.trail;
    if (trail.length > 1) {
      ctx.save();
      for (let i = 0; i < trail.length - 1; i++) {
        const cur = trail[i];
        const nxt = trail[i + 1];
        const ratio = 1 - i / trail.length;
        ctx.strokeStyle = cur.color;
        ctx.globalAlpha = ratio * 0.72;
        ctx.lineWidth = Math.max(1.5, ball.r * 1.35 * ratio);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cur.x, cur.y);
        ctx.lineTo(nxt.x, nxt.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 2. Glowing Synthwave Beach Ball with Rotating Seams (visualizes omega spin)
    ctx.save();
    ctx.translate(ball.x, ball.y);
    ctx.rotate(ball.phaseAngle);

    ctx.shadowColor = ball.trailColor;
    ctx.shadowBlur = 16;

    const ballGrad = ctx.createRadialGradient(-3, -3, 2, 0, 0, ball.r);
    ballGrad.addColorStop(0, '#ffffff');
    ballGrad.addColorStop(0.55, ball.trailColor);
    ballGrad.addColorStop(1, '#16052b');

    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(0, 0, ball.r, 0, Math.PI * 2);
    ctx.fill();

    // Seam stripes to show spin rotation clearly
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-ball.r + 2, 0);
    ctx.lineTo(ball.r - 2, 0);
    ctx.moveTo(0, -ball.r + 2);
    ctx.lineTo(0, ball.r - 2);
    ctx.stroke();

    ctx.restore();
  }

  function drawEffectsAndBanner() {
    ctx.save();
    // Expanding Sweet Spot Shockwaves
    for (const sw of shockwaves) {
      ctx.strokeStyle = sw.color;
      ctx.globalAlpha = Math.max(0, sw.alpha);
      ctx.lineWidth = 2.8;
      ctx.shadowColor = sw.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Neon Wall & Strike Sparks
    for (const p of particles) {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Shot Shape & Spin Telemetry Readout + Event Banner
    ctx.save();
    ctx.font = 'bold 11px Consolas, monospace';
    ctx.textAlign = 'center';
    const spinRpm = (ball.omega >= 0 ? '+' : '') + ball.omega.toFixed(2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.fillText(
      `${ball.shotLabel} • SPIN ω: ${spinRpm} • LAND X: ${Math.round(matchState.predictedLandingX)}`,
      NET_X,
      CEIL_Y + 34
    );

    if (matchState.bannerTimer > 0) {
      ctx.font = '900 16px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = matchState.bannerColor;
      ctx.shadowColor = matchState.bannerColor;
      ctx.shadowBlur = 12;
      ctx.fillText(matchState.bannerText, NET_X, CEIL_Y + 56);
    }
    ctx.restore();
  }

  // ============================================================================
  // 12. HUD OVERLAY & LIVE PHYSICS LAB DRAWER WIRING
  // ============================================================================
  const windMeterPill = document.getElementById('windMeterPill');
  const windLabel = document.getElementById('windLabel');
  const windValueText = document.getElementById('windValueText');
  const windBarFill = document.getElementById('windBarFill');
  const controlsHint = document.getElementById('controlsHint');

  function updateHudWindMeter() {
    const wx = Math.round(windState.currentWx);
    const signStr = wx >= 0 ? `+${wx}` : `${wx}`;
    windValueText.textContent = `${signStr} px/s`;

    windMeterPill.classList.remove('gust-warning', 'gust-active');
    if (windState.phase === 'WARNING') {
      windMeterPill.classList.add('gust-warning');
      windLabel.textContent = '⚠ GUST IN 1s';
      windLabel.style.color = '#ffe600';
    } else if (windState.phase === 'GUST') {
      windMeterPill.classList.add('gust-active');
      windLabel.textContent = '🌪 HEAVY GALE';
      windLabel.style.color = '#ff5500';
    } else {
      windLabel.textContent = 'BREEZE';
      windLabel.style.color = '#00f3ff';
    }

    const pct = Math.min(50, (Math.abs(windState.currentWx) / 110) * 50);
    if (windState.currentWx >= 0) {
      windBarFill.style.left = '50%';
      windBarFill.style.width = `${pct}%`;
    } else {
      windBarFill.style.left = `${50 - pct}%`;
      windBarFill.style.width = `${pct}%`;
    }
  }

  // Mode Selector Buttons
  const modeButtons = document.querySelectorAll('.mode-btn');
  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      modeButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      inputMode = btn.getAttribute('data-mode') || '1PAD';

      if (inputMode === '1PAD') {
        controlsHint.textContent =
          '1-PAD SPLIT (Stadia): P1 L-Stick + L1/L2 | P2 R-Stick + R1/R2/A • Keyboard: WASD+Space / Arrows+Enter';
      } else if (inputMode === 'TOUCH') {
        controlsHint.textContent =
          'TOUCH AUTO-RUN: Players auto-track landing X • Touch & hold your court half to Charge, drag to shape spin, lift to Strike';
      } else {
        controlsHint.textContent =
          '2-PAD / KEYBOARD: P1 Gamepad[0] or WASD + Space | P2 Gamepad[1] or Arrow Keys + Enter';
      }
    });
  });

  // Audio Toggle Button
  const audioToggleBtn = document.getElementById('audioToggleBtn');
  audioToggleBtn.addEventListener('click', () => {
    const isOn = audio.toggle();
    audioToggleBtn.textContent = isOn ? '[🔊 SOUND: ON]' : '[🔇 SOUND: OFF]';
    audioToggleBtn.classList.toggle('active-toggle', isOn);
  });

  // Physics Lab Drawer Toggle & Sliders
  const physicsLabBtn = document.getElementById('physicsLabBtn');
  const physicsDrawer = document.getElementById('physicsDrawer');
  const closeDrawerBtn = document.getElementById('closeDrawerBtn');

  function setDrawerOpen(open) {
    physicsDrawer.classList.toggle('open', open);
    physicsLabBtn.classList.toggle('active-toggle', open);
    physicsLabBtn.setAttribute('aria-expanded', String(open));
  }

  physicsLabBtn.addEventListener('click', () => {
    setDrawerOpen(!physicsDrawer.classList.contains('open'));
  });
  closeDrawerBtn.addEventListener('click', () => setDrawerOpen(false));

  const sliderGravity = document.getElementById('sliderGravity');
  const sliderDrag = document.getElementById('sliderDrag');
  const sliderMagnus = document.getElementById('sliderMagnus');
  const sliderGust = document.getElementById('sliderGust');
  const sliderSpeed = document.getElementById('sliderSpeed');

  const valGravity = document.getElementById('valGravity');
  const valDrag = document.getElementById('valDrag');
  const valMagnus = document.getElementById('valMagnus');
  const valGust = document.getElementById('valGust');
  const valSpeed = document.getElementById('valSpeed');

  function syncSlidersFromPhysics() {
    sliderGravity.value = String(physics.gravity);
    sliderDrag.value = String(physics.kDrag);
    sliderMagnus.value = String(physics.kMagnus);
    sliderGust.value = String(physics.gustScale);
    sliderSpeed.value = String(physics.gameSpeed);

    valGravity.textContent = `${Math.round(physics.gravity)} px/s²`;
    valDrag.textContent = physics.kDrag.toFixed(4);
    valMagnus.textContent = physics.kMagnus.toFixed(4);
    valGust.textContent = `${physics.gustScale.toFixed(2)}x`;
    valSpeed.textContent = `${physics.gameSpeed.toFixed(2)}x`;
  }

  function onSliderInput() {
    physics.gravity = Number(sliderGravity.value);
    physics.kDrag = Number(sliderDrag.value);
    physics.kMagnus = Number(sliderMagnus.value);
    physics.gustScale = Number(sliderGust.value);
    physics.gameSpeed = Number(sliderSpeed.value);
    syncSlidersFromPhysics();
    savePhysicsSettings();
  }

  [sliderGravity, sliderDrag, sliderMagnus, sliderGust, sliderSpeed].forEach((el) => {
    el.addEventListener('input', onSliderInput);
  });

  document.getElementById('resetPhysicsBtn').addEventListener('click', () => {
    physics = { ...DEFAULT_PHYSICS };
    syncSlidersFromPhysics();
    savePhysicsSettings();
    matchState.bannerText = 'RESET TO HEAVY GALE PRESET';
    matchState.bannerColor = '#00f3ff';
    matchState.bannerTimer = 1.4;
  });

  document.getElementById('forceGustBtn').addEventListener('click', () => {
    triggerImmediateGust();
  });

  syncSlidersFromPhysics();

  // ============================================================================
  // 13. BOOTSTRAP 60 FPS ANIMATION LOOP
  // ============================================================================
  let lastTime = performance.now();
  launchNextServe(1);

  function frameLoop(now) {
    const rawDt = (now - lastTime) / 1000;
    lastTime = now;
    updateSimulation(rawDt);
    renderScene();
    requestAnimationFrame(frameLoop);
  }

  requestAnimationFrame(frameLoop);
})();
