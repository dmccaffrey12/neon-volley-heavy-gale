/**
 * SUMMER HEAT 3D — 3-Touch Arcade Volleyball Rally Engine & 3-Style Solo AI FSM
 *
 * Strictly acyclic dependency: imports ONLY ./contracts.js and ./physics3d.js.
 * ZERO DOM, ZERO window/document/localStorage, ZERO Three.js.
 * Owns:
 *   - 120Hz fixed-timestep accumulator (rawDt clamped <= 0.05s, scaled by gameSpeed)
 *   - 2-frame Heat Spike hit-stop & cameraPunch impulse
 *   - True Summer Heat 3-touch loop (1v1 & 2v2 with cooperating AI partner):
 *       Touch 1: Bump/Dig or SandDive -> setter zone + Heat Meter charge
 *       Touch 2: Set -> net loft + shrinking 3D Timing Ring + Heat Meter full
 *       Touch 3: Heat Spike / Standard Spike / Backspin Pokey-Cut / Sky Lob vs NetBlock / Stuff-Block
 *   - 3-Style Solo AI Opponent FSM (WIND_LOBBER, NET_BLOCKER, SPIN_SLICER)
 *   - TOUCH mode auto-footwork
 */

import {
  MAX_PREDICT_STEPS,
  COURT,
  BALL_SPEC,
  PHYSICS_DEFAULTS,
  AI_STYLES,
  MATCH_FORMATS,
  ANIM_STATES,
  WIND_PHASES,
  TRAIL_MODES,
  SHOT_TYPES,
  EVENTS,
  clamp,
  createVec3,
  computeSpinOmega,
  createBallState,
  createWindState,
  createPlayerState,
  sanitizePhysicsConfig,
} from './contracts.js';

import {
  FIXED_DT,
  updateWind3D,
  triggerGaleSurge,
  stepBall3D,
  predictLandingPoint3D,
} from './physics3d.js';

const VALID_FORMATS = new Set(Object.values(MATCH_FORMATS));
const VALID_AI_STYLES = new Set(Object.values(AI_STYLES));

const MAX_RAW_DT = 0.05;
const MAX_SUBSTEPS = 12;

const PLAYER_MAX_SPEED = 7.4;
const PLAYER_ACCEL = 42.0;
const PLAYER_GROUND_DRAG = 14.0;
const PLAYER_GRAVITY = 19.5;
const PLAYER_JUMP_VY = 6.9;
const BLOCK_JUMP_VY = 6.2;

const DIVE_DURATION = 0.42;
const BLOCK_DURATION = 0.55;
const BUMP_ANIM_DURATION = 0.36;
const SET_ANIM_DURATION = 0.38;
const SPIKE_ANIM_DURATION = 0.42;
const POINT_PAUSE_DURATION = 1.05;

const NET_CLEAR_X_MARGIN = 0.55;
const WALL_PLAYER_MARGIN = 0.65;
const BLOCK_MAX_Y = 3.32;
const BLOCK_MIN_Y = 2.0;
const BLOCK_HALF_Z = 0.90;
const BLOCK_HALF_X = 0.85;

function finiteOr(val, fallback) {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

function cloneVec3(v) {
  if (!v || typeof v !== 'object') {
    return createVec3(0, 0, 0);
  }
  return createVec3(finiteOr(v.x, 0), finiteOr(v.y, 0), finiteOr(v.z, 0));
}

function cloneEvent(ev) {
  const copy = { ...ev };
  if (ev.pos && typeof ev.pos === 'object') {
    copy.pos = cloneVec3(ev.pos);
  }
  if (ev.windVec3 && typeof ev.windVec3 === 'object') {
    copy.windVec3 = cloneVec3(ev.windVec3);
  }
  if (ev.gustTargetVec3 && typeof ev.gustTargetVec3 === 'object') {
    copy.gustTargetVec3 = cloneVec3(ev.gustTargetVec3);
  }
  return copy;
}

function computeFacingYaw(dx, dz, fallbackYaw) {
  const len = Math.hypot(dx, dz);
  if (len < 1e-8) {
    return fallbackYaw;
  }
  return Math.atan2(dx, dz);
}

function normalizePlayerCmd(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      moveX: 0,
      moveZ: 0,
      aimX: 0,
      aimZ: 0,
      primaryHeld: false,
      primaryJustPressed: false,
      primaryJustReleased: false,
      secondaryHeld: false,
      secondaryJustPressed: false,
      secondaryJustReleased: false,
      isHuman: false,
      autoFootwork: false,
    };
  }
  return {
    moveX: clamp(raw.moveX, -1, 1, 0),
    moveZ: clamp(raw.moveZ, -1, 1, 0),
    aimX: clamp(raw.aimX, -1, 1, 0),
    aimZ: clamp(raw.aimZ, -1, 1, 0),
    primaryHeld: Boolean(raw.primaryHeld),
    primaryJustPressed: Boolean(raw.primaryJustPressed),
    primaryJustReleased: Boolean(raw.primaryJustReleased),
    secondaryHeld: Boolean(raw.secondaryHeld),
    secondaryJustPressed: Boolean(raw.secondaryJustPressed),
    secondaryJustReleased: Boolean(raw.secondaryJustReleased),
    isHuman: Boolean(raw.isHuman),
    autoFootwork: Boolean(raw.autoFootwork),
  };
}

function stripCmdEdges(cmd) {
  return {
    ...cmd,
    primaryJustPressed: false,
    primaryJustReleased: false,
    secondaryJustPressed: false,
    secondaryJustReleased: false,
  };
}

function createEmptyTimingRing() {
  return {
    active: false,
    pos: createVec3(0, 3.1, 0),
    team: 1,
    progress: 0,
    radius: 1.25,
    sweetSpotMin: 0.65,
    sweetSpotMax: 0.95,
    inSweetSpot: false,
    elapsed: 0,
    duration: 0.95,
  };
}

function createFallbackPrediction(ball) {
  return {
    x: clamp(ball.pos.x, -COURT.ARENA_HALF_X, COURT.ARENA_HALF_X, 0),
    z: clamp(ball.pos.z, -COURT.ARENA_HALF_Z, COURT.ARENA_HALF_Z, 0),
    hangTime: 0,
    landedWithinSteps: false,
    steps: 0,
    trajectory: [],
  };
}

function sanitizePrediction(raw, ball) {
  if (!raw || typeof raw !== 'object') {
    return createFallbackPrediction(ball);
  }
  return {
    x: clamp(raw.x, -COURT.ARENA_HALF_X, COURT.ARENA_HALF_X, ball.pos.x),
    z: clamp(raw.z, -COURT.ARENA_HALF_Z, COURT.ARENA_HALF_Z, ball.pos.z),
    hangTime: clamp(raw.hangTime, 0, 20, 0),
    landedWithinSteps: Boolean(raw.landedWithinSteps),
    steps: Number.isFinite(raw.steps) && raw.steps >= 0 ? Math.floor(raw.steps) : 0,
    trajectory: Array.isArray(raw.trajectory) ? raw.trajectory : [],
  };
}

/**
 * Create a deterministic 3D arcade beach volleyball rally engine.
 *
 * @param {object} [options={}]
 * @param {object} [options.physics] Optional physics provider DI override
 * @param {string} [options.format] MATCH_FORMATS.ONE_V_ONE | MATCH_FORMATS.TWO_V_TWO
 * @param {string} [options.aiStyle] AI_STYLES.WIND_LOBBER | NET_BLOCKER | SPIN_SLICER
 * @param {number} [options.winScore] Points to win a set (default 11)
 * @param {number} [options.servingTeam] Initial serving team (1 or 2; default 2 so P1 receives first)
 * @param {Function} [options.rng] Deterministic PRNG returning [0, 1)
 */
export function createRallyEngine(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};

  const physics = {
    FIXED_DT:
      opts.physics &&
      typeof opts.physics.FIXED_DT === 'number' &&
      Number.isFinite(opts.physics.FIXED_DT) &&
      opts.physics.FIXED_DT > 0
        ? opts.physics.FIXED_DT
        : FIXED_DT,
    updateWind3D: opts.physics?.updateWind3D ?? updateWind3D,
    triggerGaleSurge: opts.physics?.triggerGaleSurge ?? triggerGaleSurge,
    stepBall3D: opts.physics?.stepBall3D ?? stepBall3D,
    predictLandingPoint3D: opts.physics?.predictLandingPoint3D ?? predictLandingPoint3D,
  };

  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const winScore = Math.floor(clamp(opts.winScore, 1, 99, 11));
  const initialServingTeam = opts.servingTeam === 1 ? 1 : 2;

  let format = VALID_FORMATS.has(opts.format) ? opts.format : MATCH_FORMATS.ONE_V_ONE;
  let aiStyle = VALID_AI_STYLES.has(opts.aiStyle) ? opts.aiStyle : AI_STYLES.WIND_LOBBER;
  let paused = false;

  let accumulator = 0;
  let hitStopFrames = 0;
  let cameraPunch = 0;
  let globalContactCooldown = 0;
  let pointPauseTimer = 0;
  let p2HumanTimer = 0;
  let chargeTickAccum = 0;
  let lastPhysicsConfig = sanitizePhysicsConfig(PHYSICS_DEFAULTS);
  let lastCourtSide = initialServingTeam === 1 ? -1 : 1;

  const wind = createWindState();
  const ball = createBallState();
  let prediction = createFallbackPrediction(ball);
  const timingRing = createEmptyTimingRing();

  const scoreboard = {
    scoreP1: 0,
    scoreP2: 0,
    setsP1: 0,
    setsP2: 0,
    servingTeam: initialServingTeam,
    activeTeam: initialServingTeam === 1 ? 2 : 1,
    touchCount: 0,
    rallyCount: 0,
    team1Heat: 0,
    team2Heat: 0,
    format,
    aiStyle,
    phase: 'RALLY',
    winner: null,
    lastPointWinner: null,
    bannerText: '',
    bannerTimer: 0,
    paused: false,
  };

  let players = [];
  let frameEvents = [];
  let pendingExternalEvents = [];
  let isStepping = false;

  const pendingEdges = {
    p1: {
      primaryJustPressed: false,
      primaryJustReleased: false,
      secondaryJustPressed: false,
      secondaryJustReleased: false,
    },
    p2: {
      primaryJustPressed: false,
      primaryJustReleased: false,
      secondaryJustPressed: false,
      secondaryJustReleased: false,
    },
  };

  function clearPendingEdges() {
    pendingEdges.p1.primaryJustPressed = false;
    pendingEdges.p1.primaryJustReleased = false;
    pendingEdges.p1.secondaryJustPressed = false;
    pendingEdges.p1.secondaryJustReleased = false;
    pendingEdges.p2.primaryJustPressed = false;
    pendingEdges.p2.primaryJustReleased = false;
    pendingEdges.p2.secondaryJustPressed = false;
    pendingEdges.p2.secondaryJustReleased = false;
  }

  function emitEvent(type, payload = {}) {
    const ev = { type, ...payload };
    if (isStepping) {
      frameEvents.push(ev);
    } else {
      pendingExternalEvents.push(ev);
    }
  }

  function createRoster(targetFormat) {
    const list = [];
    if (targetFormat === MATCH_FORMATS.TWO_V_TWO) {
      list.push(
        createPlayerState({
          id: 'p1',
          team: 1,
          role: 'PRIMARY',
          isHuman: true,
          pos: { x: -5.0, y: 0, z: 1.5 },
          facingYaw: Math.PI / 2,
          heatMeter: scoreboard.team1Heat,
        }),
        createPlayerState({
          id: 'p1_partner',
          team: 1,
          role: 'PARTNER',
          isHuman: false,
          pos: { x: -2.2, y: 0, z: -1.4 },
          facingYaw: Math.PI / 2,
          heatMeter: scoreboard.team1Heat,
        }),
        createPlayerState({
          id: 'p2',
          team: 2,
          role: 'PRIMARY',
          isHuman: p2HumanTimer > 0,
          pos: { x: 5.0, y: 0, z: -1.5 },
          facingYaw: -Math.PI / 2,
          heatMeter: scoreboard.team2Heat,
        }),
        createPlayerState({
          id: 'p2_partner',
          team: 2,
          role: 'PARTNER',
          isHuman: false,
          pos: { x: 2.2, y: 0, z: 1.4 },
          facingYaw: -Math.PI / 2,
          heatMeter: scoreboard.team2Heat,
        }),
      );
    } else {
      list.push(
        createPlayerState({
          id: 'p1',
          team: 1,
          role: 'PRIMARY',
          isHuman: true,
          pos: { x: -4.2, y: 0, z: 0 },
          facingYaw: Math.PI / 2,
          heatMeter: scoreboard.team1Heat,
        }),
        createPlayerState({
          id: 'p2',
          team: 2,
          role: 'PRIMARY',
          isHuman: p2HumanTimer > 0,
          pos: { x: 4.2, y: 0, z: 0 },
          facingYaw: -Math.PI / 2,
          heatMeter: scoreboard.team2Heat,
        }),
      );
    }

    // Internal animation & AI reaction fields (stripped cleanly in getSnapshot)
    for (let i = 0; i < list.length; i++) {
      list[i]._actionAnim = null;
      list[i]._actionTimer = 0;
      list[i]._actionDuration = 0.36;
      list[i]._lastTouched = false;
      list[i]._aiReactTimer = 0;
      list[i]._aiTargetX = list[i].pos.x;
      list[i]._aiTargetZ = list[i].pos.z;
      list[i]._aiDiveCooldown = 0;
      list[i]._aiSeenRallyCount = -1;
    }
    return list;
  }

  function resetPlayerPositions() {
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const sideSign = p.team === 1 ? -1 : 1;
      if (format === MATCH_FORMATS.TWO_V_TWO) {
        if (p.role === 'PRIMARY') {
          p.pos.x = sideSign * 5.0;
          p.pos.z = p.team === 1 ? 1.5 : -1.5;
        } else {
          p.pos.x = sideSign * 2.2;
          p.pos.z = p.team === 1 ? -1.4 : 1.4;
        }
      } else {
        p.pos.x = sideSign * 4.2;
        p.pos.z = 0;
      }
      p.pos.y = 0;
      p.vel.x = 0;
      p.vel.y = 0;
      p.vel.z = 0;
      p.facingYaw = p.team === 1 ? Math.PI / 2 : -Math.PI / 2;
      p.animState = ANIM_STATES.IDLE;
      p.animTime = 0;
      p.animProgress = 0;
      p.chargeRatio = 0;
      p.isAirborne = false;
      p.diveTimer = 0;
      p.blockTimer = 0;
      p.strikeCooldown = 0;
      p.targetBallPos = null;
      p._actionAnim = null;
      p._actionTimer = 0;
      p._lastTouched = false;
      p._aiReactTimer = 0;
      p._aiTargetX = p.pos.x;
      p._aiTargetZ = p.pos.z;
      p._aiDiveCooldown = 0;
      p._aiSeenRallyCount = -1;
    }
  }

  function getTeamHeat(team) {
    return team === 1 ? scoreboard.team1Heat : scoreboard.team2Heat;
  }

  function setTeamHeat(team, val) {
    const clamped = clamp(val, 0, 1, 0);
    if (team === 1) {
      scoreboard.team1Heat = clamped;
    } else {
      scoreboard.team2Heat = clamped;
    }
    for (let i = 0; i < players.length; i++) {
      if (players[i].team === team) {
        players[i].heatMeter = clamped;
      }
    }
  }

  function addTeamHeat(team, delta) {
    setTeamHeat(team, getTeamHeat(team) + delta);
  }

  function resetTimingRing() {
    timingRing.active = false;
    timingRing.progress = 0;
    timingRing.radius = 1.25;
    timingRing.inSweetSpot = false;
    timingRing.elapsed = 0;
  }

  function refreshPrediction(cfg) {
    try {
      const rawPred = physics.predictLandingPoint3D(ball, wind, cfg, MAX_PREDICT_STEPS);
      prediction = sanitizePrediction(rawPred, ball);
    } catch {
      prediction = createFallbackPrediction(ball);
    }
  }

  function launchServe(servingTeam, cfg = lastPhysicsConfig) {
    resetPlayerPositions();
    resetTimingRing();

    const serverSideSign = servingTeam === 1 ? -1 : 1;
    const forwardSign = -serverSideSign;
    const g = cfg.gravity;

    const startX = serverSideSign * 5.4;
    const startY = 2.2;
    const startZ = 0;

    // First serve of match goes cleanly to receiver's starting spot; later serves vary Z
    const isOpeningServe = scoreboard.scoreP1 === 0 && scoreboard.scoreP2 === 0;
    const receiverTeam = servingTeam === 1 ? 2 : 1;
    const receiverPrimary = players.find((p) => p.team === receiverTeam && p.role === 'PRIMARY');
    const baseTargetX = forwardSign * (format === MATCH_FORMATS.TWO_V_TWO ? 4.8 : 4.2);
    const baseTargetZ = isOpeningServe
      ? receiverPrimary
        ? receiverPrimary.pos.z
        : 0
      : clamp((rng() - 0.5) * 3.2, -2.4, 2.4, 0);

    const flightTime = 1.48;
    const targetY = 1.15;
    const headwind = Math.max(0, -wind.windVec3.x * forwardSign);

    const rawVx = (baseTargetX - startX) / flightTime;
    const dragBoost = 1 + 0.25 * cfg.kDrag * Math.abs(rawVx) * flightTime;
    const baseVxMag = Math.abs(rawVx * dragBoost);
    let vxMag = baseVxMag;
    if (headwind > 0) {
      const effT = clamp(flightTime * Math.sqrt(PHYSICS_DEFAULTS.gravity / g), 0.95, 1.55, flightTime);
      const airDist = Math.abs(baseTargetX - startX) + headwind * effT;
      const vRelNeeded =
        cfg.kDrag > 1e-5
          ? (Math.exp(Math.min(2.4, cfg.kDrag * airDist)) - 1) / (cfg.kDrag * effT)
          : airDist / effT;
      vxMag = clamp(Math.max(baseVxMag + 0.45 * headwind, vRelNeeded - headwind), 2.0, 42.0, baseVxMag);
    }
    const vx = forwardSign * vxMag;
    const vz = ((baseTargetZ - startZ) / flightTime) * dragBoost - 0.15 * wind.windVec3.z;
    let vy = (targetY - startY + 0.5 * g * flightTime * flightTime) / flightTime;

    // Guarantee clean net clearance even under strong headwind and high quadratic drag
    const tNet = Math.abs(startX) / Math.max(2.0, Math.abs(vx));
    const yAtNet = startY + vy * tNet - 0.5 * g * tNet * tNet;
    const minNetY = COURT.NET_HEIGHT + 1.05;
    if (yAtNet < minNetY) {
      vy += (minNetY - yAtNet) / Math.max(0.1, tNet);
    }
    if (headwind > 0) {
      vy *= 1 + 0.25 * cfg.kDrag * headwind * (1 + vxMag / 20);
    }

    ball.pos.x = startX;
    ball.pos.y = startY;
    ball.pos.z = startZ;
    ball.vel.x = vx;
    ball.vel.y = vy;
    ball.vel.z = vz;
    ball.omega = computeSpinOmega(vx, vz, 3.5, 0);
    ball.radius = BALL_SPEC.RADIUS;
    ball.trailMode = TRAIL_MODES.NEUTRAL;
    ball.shotType = SHOT_TYPES.SERVE;
    ball.lastHitTeam = servingTeam;
    ball.spinAngle.x = 0;
    ball.spinAngle.y = 0;
    ball.spinAngle.z = 0;
    ball.active = true;

    scoreboard.servingTeam = servingTeam;
    scoreboard.activeTeam = receiverTeam;
    scoreboard.touchCount = 0;
    scoreboard.rallyCount = 0;
    scoreboard.phase = 'RALLY';
    lastCourtSide = serverSideSign;
    globalContactCooldown = 0.12;
    pointPauseTimer = 0;

    refreshPrediction(cfg);
    emitEvent(EVENTS.SERVE, {
      team: servingTeam,
      pos: cloneVec3(ball.pos),
      speed: Math.hypot(vx, vy, vz),
      shotType: SHOT_TYPES.SERVE,
    });
  }

  function awardPoint(winner, reason = 'SAND') {
    if (scoreboard.phase === 'POINT_PAUSE') {
      return;
    }

    if (winner === 1) {
      scoreboard.scoreP1 += 1;
    } else {
      scoreboard.scoreP2 += 1;
    }

    scoreboard.lastPointWinner = winner;
    scoreboard.servingTeam = winner;
    scoreboard.phase = 'POINT_PAUSE';
    pointPauseTimer = POINT_PAUSE_DURATION;
    resetTimingRing();
    ball.active = false;

    let matchOver = false;
    const diff = scoreboard.scoreP1 - scoreboard.scoreP2;
    if (scoreboard.scoreP1 >= winScore && diff >= 2) {
      scoreboard.setsP1 += 1;
      scoreboard.winner = 1;
      matchOver = true;
      scoreboard.bannerText = `TEAM 1 WINS SET! (${scoreboard.scoreP1}-${scoreboard.scoreP2})`;
    } else if (scoreboard.scoreP2 >= winScore && -diff >= 2) {
      scoreboard.setsP2 += 1;
      scoreboard.winner = 2;
      matchOver = true;
      scoreboard.bannerText = `TEAM 2 WINS SET! (${scoreboard.scoreP2}-${scoreboard.scoreP1})`;
    } else {
      scoreboard.bannerText =
        reason === 'TOUCH_VIOLATION'
          ? `4-TOUCH FAULT — POINT TEAM ${winner}!`
          : `POINT TEAM ${winner}! (${scoreboard.rallyCount} HIT RALLY)`;
    }
    scoreboard.bannerTimer = 1.6;

    emitEvent(EVENTS.POINT_SCORED, {
      winner,
      scoreP1: scoreboard.scoreP1,
      scoreP2: scoreboard.scoreP2,
      rallyCount: scoreboard.rallyCount,
      reason,
      matchOver: Boolean(matchOver),
    });
  }

  // ---- Shot Execution (Touch 1, Touch 2, Touch 3) ----

  function setPlayerActionAnim(player, animState, duration) {
    player.animState = animState;
    player._actionAnim = animState;
    player._actionTimer = duration;
    player._actionDuration = duration;
    player.animTime = 0;
    player.animProgress = 0;
  }

  function executeTouch1BumpOrDive(player, cmd, cfg, isDive) {
    const sideSign = player.team === 1 ? -1 : 1;
    const g = cfg.gravity;

    const teammate = players.find((p) => p.team === player.team && p.id !== player.id);
    const targetX = sideSign * (teammate ? 2.2 : 2.35);
    const targetZ = teammate
      ? clamp(teammate.pos.z * 0.45, -1.8, 1.8, 0)
      : clamp(player.pos.z * 0.5 + cmd.aimZ * 1.1, -2.2, 2.2, 0);
    const targetY = 1.85;
    const apexY = isDive ? 4.30 : 4.00;

    const startY = clamp(ball.pos.y, BALL_SPEC.RADIUS + 0.1, 3.6, 1.2);
    const vy = Math.sqrt(2 * g * Math.max(0.55, apexY - startY));
    const tUp = vy / g;
    const tDown = Math.sqrt(2 * Math.max(0.2, apexY - targetY) / g);
    const flightT = clamp(tUp + tDown, 0.85, 1.35, 1.05);

    const vx = clamp((targetX - ball.pos.x) / flightT - 0.14 * wind.windVec3.x, -6.8, 6.8, 0);
    const vz = clamp((targetZ - ball.pos.z) / flightT - 0.14 * wind.windVec3.z, -5.5, 5.5, 0);

    ball.vel.x = vx;
    ball.vel.y = vy;
    ball.vel.z = vz;
    ball.omega = computeSpinOmega(vx, vz, -2.0, 0);
    ball.trailMode = TRAIL_MODES.NEUTRAL;
    ball.shotType = isDive ? SHOT_TYPES.DIVE_SAVE : SHOT_TYPES.BUMP;
    ball.lastHitTeam = player.team;

    scoreboard.activeTeam = player.team;
    scoreboard.touchCount = 1;
    scoreboard.rallyCount += 1;
    resetTimingRing();

    addTeamHeat(player.team, isDive ? 0.55 : 0.45);
    player.strikeCooldown = 0.24;
    player.chargeRatio = 0;
    globalContactCooldown = 0.10;

    for (let i = 0; i < players.length; i++) {
      if (players[i].team === player.team) {
        players[i]._lastTouched = players[i].id === player.id;
      }
    }

    if (isDive) {
      player.diveTimer = Math.max(player.diveTimer, DIVE_DURATION);
      setPlayerActionAnim(player, ANIM_STATES.SAND_DIVE, DIVE_DURATION);
      emitEvent(EVENTS.DIVE, {
        team: player.team,
        playerId: player.id,
        pos: cloneVec3(ball.pos),
        speed: Math.hypot(vx, vy, vz),
        shotType: SHOT_TYPES.DIVE_SAVE,
      });
    } else {
      setPlayerActionAnim(player, ANIM_STATES.UNDERHAND_BUMP, BUMP_ANIM_DURATION);
      emitEvent(EVENTS.BUMP, {
        team: player.team,
        playerId: player.id,
        pos: cloneVec3(ball.pos),
        speed: Math.hypot(vx, vy, vz),
        shotType: SHOT_TYPES.BUMP,
      });
    }
  }

  function executeTouch2Set(player, cmd, cfg) {
    const sideSign = player.team === 1 ? -1 : 1;
    const g = cfg.gravity;

    const primaryAttacker =
      players.find((p) => p.team === player.team && p.role === 'PRIMARY') || player;
    const targetX = sideSign * 1.25;
    const targetZ =
      primaryAttacker.id !== player.id
        ? clamp(primaryAttacker.pos.z * 0.75, -2.4, 2.4, 0)
        : clamp(player.pos.z * 0.7 + cmd.aimZ * 1.3, -2.5, 2.5, 0);

    const apexY = 3.92;
    const strikeY = 3.12;
    const startY = clamp(ball.pos.y, 0.8, 3.4, 1.8);
    const vy = Math.sqrt(2 * g * Math.max(0.45, apexY - startY));
    const tUp = vy / g;
    const tDown = Math.sqrt(2 * Math.max(0.18, apexY - strikeY) / g);
    const setDuration = clamp(tUp + tDown, 0.72, 1.15, 0.95);

    const vx = clamp((targetX - ball.pos.x) / setDuration - 0.14 * wind.windVec3.x, -6.5, 6.5, 0);
    const vz = clamp((targetZ - ball.pos.z) / setDuration - 0.14 * wind.windVec3.z, -5.5, 5.5, 0);

    ball.vel.x = vx;
    ball.vel.y = vy;
    ball.vel.z = vz;
    ball.omega = computeSpinOmega(vx, vz, -2.5, 0);
    ball.trailMode = TRAIL_MODES.NEUTRAL;
    ball.shotType = SHOT_TYPES.SET;
    ball.lastHitTeam = player.team;

    scoreboard.activeTeam = player.team;
    scoreboard.touchCount = 2;
    scoreboard.rallyCount += 1;

    // Clean Bump (0.45) + Set (0.55) = 1.00 (100% Heat Meter!)
    addTeamHeat(player.team, 0.55);
    player.strikeCooldown = 0.24;
    player.chargeRatio = 0;
    globalContactCooldown = 0.10;

    for (let i = 0; i < players.length; i++) {
      if (players[i].team === player.team) {
        players[i]._lastTouched = players[i].id === player.id;
      }
    }

    // Activate shrinking 3D Timing Ring at Set apex/strike zone
    timingRing.active = true;
    timingRing.team = player.team;
    timingRing.pos = createVec3(targetX, strikeY, targetZ);
    timingRing.elapsed = 0;
    timingRing.duration = setDuration;
    timingRing.progress = 0;
    timingRing.radius = 1.25;
    timingRing.sweetSpotMin = 0.65;
    timingRing.sweetSpotMax = 0.95;
    timingRing.inSweetSpot = false;

    setPlayerActionAnim(player, ANIM_STATES.OVERHEAD_SET, SET_ANIM_DURATION);
    emitEvent(EVENTS.SET, {
      team: player.team,
      playerId: player.id,
      pos: cloneVec3(ball.pos),
      speed: Math.hypot(vx, vy, vz),
      shotType: SHOT_TYPES.SET,
    });
  }

  function executeTouch3Attack(player, cmd, cfg, aiAttackOverride = null) {
    const forwardSign = player.team === 1 ? 1 : -1;
    const g = cfg.gravity;
    const headwind = Math.max(0, -wind.windVec3.x * forwardSign);

    const fallbackMoveX = cmd.autoFootwork ? (cmd._manualMoveX ?? 0) : cmd.moveX;
    const fallbackMoveZ = cmd.autoFootwork ? (cmd._manualMoveZ ?? 0) : cmd.moveZ;
    const aimX = cmd.aimX !== 0 ? cmd.aimX : fallbackMoveX;
    const aimZ = cmd.aimZ !== 0 ? cmd.aimZ : fallbackMoveZ;
    const aimForward = aimX * forwardSign;
    const teamHeat = getTeamHeat(player.team);
    const sweetSpot = Boolean(
      timingRing.active && timingRing.team === player.team && timingRing.inSweetSpot,
    );

    let shotKind;
    let sidespinOverride = null;

    if (aiAttackOverride) {
      shotKind = aiAttackOverride.shotKind;
      sidespinOverride = aiAttackOverride.sidespin ?? null;
    } else {
      const wantsPokey = cmd.secondaryHeld || cmd.secondaryJustPressed || aimForward < -0.25;
      if (wantsPokey) {
        shotKind = SHOT_TYPES.POKEY_CUT;
      } else if (teamHeat >= 0.95 || sweetSpot) {
        shotKind = SHOT_TYPES.HEAT_SPIKE;
      } else {
        shotKind = SHOT_TYPES.SPIKE;
      }
    }

    const dxToNet = Math.max(0.35, -ball.pos.x * forwardSign);
    const opponentTeam = player.team === 1 ? 2 : 1;
    const autoAimZ =
      !aiAttackOverride && cmd.autoFootwork && Math.abs(aimZ) < 0.05
        ? pickOpenTargetZ(opponentTeam) * 0.85
        : null;
    const targetZ = clamp(
      aiAttackOverride && typeof aiAttackOverride.targetZ === 'number'
        ? aiAttackOverride.targetZ
        : autoAimZ !== null
          ? autoAimZ
          : aimZ * 3.3,
      -3.5,
      3.5,
      0,
    );

    let vx = 0;
    let vy = 0;
    let vz = 0;
    let topspin = 0;
    let sidespin = 0;

    if (shotKind === SHOT_TYPES.HEAT_SPIKE) {
      topspin = 20.0;
      sidespin = clamp(sidespinOverride ?? aimZ * 8.0, -16, 16, 0);
      // Smoothly ease speedX down on low-contact strikes (y < 2.55m) so low spikes clear the net
      // cleanly and land inside the opponent's court instead of rocketing into the back wall.
      const lowFactor = clamp((2.55 - ball.pos.y) / 0.95, 0, 1, 0);
      const highSpeedX = 14.8 + player.chargeRatio * 2.2 + 0.45 * headwind + 0.25 * Math.abs(ball.pos.x);
      const lowSpeedX = 8.2 + player.chargeRatio * 1.0 + 0.48 * headwind + 0.30 * Math.abs(ball.pos.x);
      let speedX = highSpeedX * (1 - lowFactor) + lowSpeedX * lowFactor;

      const lowContactBoost = clamp((2.55 - ball.pos.y) * 0.20, 0, 0.24, 0);
      const desiredYNet = 2.84 + lowContactBoost; // Clears 2.68m tape cleanly, stays inside <= 3.32m block volume

      const solveHeatVy = (sx) => {
        const tNet = dxToNet / sx;
        const vRelX = sx + headwind;
        const tNetEff = Math.max(0.035, tNet * (1 + 0.5 * cfg.kDrag * vRelX * tNet));
        const gEff = g + cfg.kMagnus * topspin * vRelX;
        let vyReq = (desiredYNet - ball.pos.y + 0.5 * gEff * tNetEff * tNetEff) / tNetEff;
        if (vyReq > 0) {
          vyReq *= 1 + 0.5 * cfg.kDrag * vRelX * tNetEff;
        }
        return { vyReq, tNetEff, gEff };
      };

      let { vyReq: vyNeeded, tNetEff, gEff } = solveHeatVy(speedX);
      const maxVyForContact = lowFactor > 0 ? 7.8 + (1 - lowFactor) * 1.8 : 13.5;
      if (vyNeeded > maxVyForContact && ball.pos.y < desiredYNet) {
        const reqT = Math.max(
          tNetEff,
          (desiredYNet - ball.pos.y + 0.5 * gEff * tNetEff * tNetEff) / (maxVyForContact * 0.92),
        );
        const minSpeedX = Math.max(5.8, 0.40 * headwind + 5.0);
        speedX = clamp(dxToNet / reqT, minSpeedX, speedX, speedX);
        ({ vyReq: vyNeeded } = solveHeatVy(speedX));
      }
      vx = forwardSign * speedX;
      vy = clamp(vyNeeded, -4.5, 13.5, -1.2);
      const targetX = forwardSign * clamp(5.0 + player.chargeRatio * 1.8, 4.2, 7.2, 5.5);
      const tFlight = Math.abs(targetX - ball.pos.x) / speedX;
      const cornerTargetZ = clamp(
        aiAttackOverride && typeof aiAttackOverride.targetZ === 'number'
          ? aiAttackOverride.targetZ
          : autoAimZ !== null
            ? autoAimZ
            : aimZ * 3.6,
        -3.7,
        3.7,
        0,
      );
      vz = clamp((cornerTargetZ - ball.pos.z) / Math.max(0.25, tFlight), -8.2, 8.2, 0);

      ball.trailMode = TRAIL_MODES.FLAME;
      ball.shotType = SHOT_TYPES.HEAT_SPIKE;
      hitStopFrames = 2;
      cameraPunch = 1.0;
      setTeamHeat(player.team, 0);
    } else if (shotKind === SHOT_TYPES.POKEY_CUT) {
      topspin = -16.0;
      sidespin = clamp(sidespinOverride ?? aimZ * 10.0, -18, 18, 0);
      let speedX = 6.3 + 0.45 * headwind + 0.15 * Math.abs(ball.pos.x);
      const lowContactBoost = clamp((2.6 - ball.pos.y) * 0.18, 0, 0.25, 0);
      const desiredYNet = 3.95 + lowContactBoost; // Strictly > 3.35m at X=0 to clear jumping Stuff-Blocker!

      const solvePokeyVy = (sx) => {
        const dxTarget = ball.pos.y < 2.6 ? Math.max(0.28, dxToNet - 0.22) : dxToNet;
        const tNet = dxTarget / Math.max(2.0, sx);
        const vRelX = sx + headwind;
        const tNetEff = Math.max(0.05, tNet * (1 + 0.5 * cfg.kDrag * vRelX * tNet));
        const gEff = Math.max(1.5, g + cfg.kMagnus * topspin * vRelX);
        let vyReq = (desiredYNet - ball.pos.y + 0.5 * gEff * tNetEff * tNetEff) / tNetEff;
        if (vyReq > 0) {
          vyReq *= 1 + 0.5 * cfg.kDrag * vRelX * tNetEff;
        }
        return { vyReq, tNetEff, gEff, dxTarget };
      };

      let { vyReq: vyForNet, tNetEff, gEff, dxTarget } = solvePokeyVy(speedX);
      if (vyForNet > 12.0 && ball.pos.y < desiredYNet) {
        const reqT = Math.max(
          tNetEff,
          (desiredYNet - ball.pos.y + 0.5 * gEff * tNetEff * tNetEff) / 11.4,
        );
        const minSpeedX = Math.max(3.4, 0.24 * headwind + 2.8);
        speedX = clamp(dxTarget / reqT, minSpeedX, speedX, speedX);
        ({ vyReq: vyForNet } = solvePokeyVy(speedX));
      }
      vx = forwardSign * speedX;
      vy = clamp(Math.max(vyForNet, 5.2), 5.2, 12.8, 6.4);
      const targetX = forwardSign * clamp(3.6 + (1 - Math.abs(aimZ)) * 1.2, 2.5, 5.4, 4.0);
      const tFlight = Math.abs(targetX - ball.pos.x) / speedX;
      vz = clamp((targetZ - ball.pos.z) / Math.max(0.35, tFlight), -6.0, 6.0, 0);

      ball.trailMode = TRAIL_MODES.CYAN;
      ball.shotType = SHOT_TYPES.POKEY_CUT;
      cameraPunch = Math.max(cameraPunch, 0.25);
    } else if (shotKind === SHOT_TYPES.LOB) {
      const targetX = forwardSign * 6.0;
      const lobT = 1.95;
      vx = forwardSign * (Math.abs(targetX - ball.pos.x) / lobT + 0.35 * headwind);
      const tNet = dxToNet / Math.max(2.5, Math.abs(vx));
      const baseVy = (1.0 - ball.pos.y + 0.5 * g * lobT * lobT) / lobT;
      const yNetCheck = ball.pos.y + baseVy * tNet - 0.5 * g * tNet * tNet;
      vy = clamp(
        yNetCheck < 5.5 ? baseVy + (5.5 - yNetCheck) / Math.max(0.12, tNet) : baseVy,
        8.8,
        12.4,
        10.2,
      );
      vz = clamp((targetZ - ball.pos.z) / lobT, -4.5, 4.5, 0);
      topspin = -5.0;
      sidespin = clamp(sidespinOverride ?? 0, -10, 10, 0);

      ball.trailMode = TRAIL_MODES.LOB;
      ball.shotType = SHOT_TYPES.LOB;
    } else {
      // Standard Spike
      topspin = 12.0;
      sidespin = clamp(sidespinOverride ?? aimZ * 6.0, -16, 16, 0);
      const lowFactor = clamp((2.55 - ball.pos.y) / 0.95, 0, 1, 0);
      const highSpeedX = 11.8 + player.chargeRatio * 2.0 + 0.45 * headwind + 0.20 * Math.abs(ball.pos.x);
      const lowSpeedX = 7.6 + player.chargeRatio * 0.9 + 0.46 * headwind + 0.26 * Math.abs(ball.pos.x);
      let speedX = highSpeedX * (1 - lowFactor) + lowSpeedX * lowFactor;

      const lowContactBoost = clamp((2.55 - ball.pos.y) * 0.20, 0, 0.24, 0);
      const desiredYNet = 2.92 + lowContactBoost;

      const solveSpikeVy = (sx) => {
        const tNet = dxToNet / sx;
        const vRelX = sx + headwind;
        const tNetEff = Math.max(0.035, tNet * (1 + 0.5 * cfg.kDrag * vRelX * tNet));
        const gEff = g + cfg.kMagnus * topspin * vRelX;
        let vyReq = (desiredYNet - ball.pos.y + 0.5 * gEff * tNetEff * tNetEff) / tNetEff;
        if (vyReq > 0) {
          vyReq *= 1 + 0.5 * cfg.kDrag * vRelX * tNetEff;
        }
        return { vyReq, tNetEff, gEff };
      };

      let { vyReq: vyNeeded, tNetEff, gEff } = solveSpikeVy(speedX);
      const maxVyForContact = lowFactor > 0 ? 7.6 + (1 - lowFactor) * 1.8 : 12.5;
      if (vyNeeded > maxVyForContact && ball.pos.y < desiredYNet) {
        const reqT = Math.max(
          tNetEff,
          (desiredYNet - ball.pos.y + 0.5 * gEff * tNetEff * tNetEff) / (maxVyForContact * 0.92),
        );
        const minSpeedX = Math.max(5.6, 0.38 * headwind + 4.8);
        speedX = clamp(dxToNet / reqT, minSpeedX, speedX, speedX);
        ({ vyReq: vyNeeded } = solveSpikeVy(speedX));
      }
      vx = forwardSign * speedX;
      vy = clamp(vyNeeded, -3.2, 12.5, 1.8);
      const targetX = forwardSign * clamp(4.8 + player.chargeRatio * 1.6, 3.8, 7.0, 5.2);
      const tFlight = Math.abs(targetX - ball.pos.x) / speedX;
      vz = clamp((targetZ - ball.pos.z) / Math.max(0.28, tFlight), -6.0, 6.0, 0);

      ball.trailMode = player.chargeRatio >= 0.65 ? TRAIL_MODES.FLAME : TRAIL_MODES.NEUTRAL;
      ball.shotType = SHOT_TYPES.SPIKE;
      cameraPunch = Math.max(cameraPunch, 0.4);
    }

    ball.vel.x = vx;
    ball.vel.y = vy;
    ball.vel.z = vz;
    ball.omega = computeSpinOmega(vx, vz, topspin, sidespin);
    ball.lastHitTeam = player.team;

    scoreboard.activeTeam = player.team;
    scoreboard.touchCount = 3;
    scoreboard.rallyCount += 1;
    resetTimingRing();

    player.chargeRatio = 0;
    player.strikeCooldown = 0.28;
    globalContactCooldown = 0.12;

    if (!player.isAirborne) {
      player.isAirborne = true;
      player.vel.y = Math.max(player.vel.y, PLAYER_JUMP_VY * 0.75);
    }
    setPlayerActionAnim(player, ANIM_STATES.JUMP_HEAT_SPIKE, SPIKE_ANIM_DURATION);

    const speed = Math.hypot(vx, vy, vz);
    const eventType =
      shotKind === SHOT_TYPES.HEAT_SPIKE
        ? EVENTS.HEAT_SPIKE
        : shotKind === SHOT_TYPES.POKEY_CUT
          ? EVENTS.POKEY_CUT
          : EVENTS.SPIKE;

    emitEvent(eventType, {
      team: player.team,
      playerId: player.id,
      pos: cloneVec3(ball.pos),
      speed,
      shotType: shotKind,
      sweetSpot,
    });
  }

  function triggerNetBlock(player) {
    if (player.isAirborne || player.blockTimer > 0 || player.strikeCooldown > 0) {
      return false;
    }
    const sideSign = player.team === 1 ? -1 : 1;
    player.pos.x = clamp(player.pos.x, sideSign < 0 ? -1.8 : 0.55, sideSign < 0 ? -0.55 : 1.8, sideSign * 0.7);
    player.isAirborne = true;
    player.vel.y = BLOCK_JUMP_VY;
    player.blockTimer = BLOCK_DURATION;
    setPlayerActionAnim(player, ANIM_STATES.NET_BLOCK, BLOCK_DURATION);
    emitEvent(EVENTS.NET_BLOCK, {
      team: player.team,
      playerId: player.id,
      pos: cloneVec3(player.pos),
    });
    return true;
  }

  function triggerSandDive(player, targetX, targetZ) {
    if (player.diveTimer > 0 || player.isAirborne) {
      return false;
    }
    const dx = targetX - player.pos.x;
    const dz = targetZ - player.pos.z;
    const dist = Math.hypot(dx, dz);
    const dirX = dist > 1e-6 ? dx / dist : player.team === 1 ? 1 : -1;
    const dirZ = dist > 1e-6 ? dz / dist : 0;

    player.vel.x = dirX * 8.2;
    player.vel.z = dirZ * 8.2;
    player.diveTimer = DIVE_DURATION;
    if (!player.isHuman) {
      player._aiDiveCooldown = 1.4;
    }
    player.facingYaw = computeFacingYaw(dirX, dirZ, player.facingYaw);
    setPlayerActionAnim(player, ANIM_STATES.SAND_DIVE, DIVE_DURATION);
    return true;
  }

  // ---- Auto-Footwork & AI FSM ----

  function pickOpenTargetZ(opponentTeam) {
    const opps = players.filter((p) => p.team === opponentTeam);
    if (opps.length <= 1) {
      const oppZ = opps[0] ? opps[0].pos.z : 0;
      return oppZ >= 0 ? -3.1 : 3.1;
    }
    const candidates = [-3.4, -2.5, 0.0, 2.5, 3.4];
    let bestZ = -3.4;
    let bestMinDist = -1;
    for (let i = 0; i < candidates.length; i++) {
      const cz = candidates[i];
      let minDist = Infinity;
      for (let j = 0; j < opps.length; j++) {
        const d = Math.abs(cz - opps[j].pos.z);
        if (d < minDist) {
          minDist = d;
        }
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestZ = cz;
      }
    }
    return bestZ;
  }

  function computePartnerCoverPos(player, primary) {
    const sideSign = player.team === 1 ? -1 : 1;
    const primaryZ = primary ? primary.pos.z : 0;
    const coverZ =
      Math.abs(primaryZ) < 0.4
        ? player.team === 1
          ? -1.8
          : 1.8
        : clamp(-primaryZ * 0.85, -2.6, 2.6, player.team === 1 ? -1.4 : 1.4);
    return { x: sideSign * 4.2, z: coverZ };
  }

  function computeDesiredTargetPos(player) {
    const sideSign = player.team === 1 ? -1 : 1;
    const opponentTeam = player.team === 1 ? 2 : 1;
    const ballOnMySide = player.team === 1 ? ball.pos.x <= 0.25 : ball.pos.x >= -0.25;
    const predOnMySide = player.team === 1 ? prediction.x <= 0 : prediction.x >= 0;

    // 2v2 role coordination: determine whether this player should chase the ball
    const teammate = players.find((p) => p.team === player.team && p.id !== player.id);

    if (ballOnMySide || predOnMySide) {
      // Touch 2 Set waiting (or Touch 3 pending) -> Primary attacks, Partner covers deep court
      if (
        (timingRing.active && timingRing.team === player.team) ||
        (scoreboard.activeTeam === player.team && scoreboard.touchCount === 2)
      ) {
        if (player.role === 'PRIMARY' || !teammate) {
          if (timingRing.active && timingRing.team === player.team) {
            return {
              x: clamp(timingRing.pos.x + sideSign * 0.25, sideSign < 0 ? -10 : 0.65, sideSign < 0 ? -0.65 : 10, sideSign * 1.4),
              z: timingRing.pos.z,
            };
          }
          return { x: prediction.x, z: prediction.z };
        }
        // Partner yields Touch 3 to Primary unless emergency low sand save with Primary far away
        const primaryDist = Math.hypot(ball.pos.x - teammate.pos.x, ball.pos.z - teammate.pos.z);
        if (!player._lastTouched && ball.pos.y <= 1.35 && primaryDist > 2.6) {
          return { x: prediction.x, z: prediction.z };
        }
        return computePartnerCoverPos(player, teammate);
      }

      // Touch 1 completed -> Partner (in 2v2) moves to setter zone to execute Touch 2 Set!
      if (scoreboard.activeTeam === player.team && scoreboard.touchCount === 1) {
        if (teammate && player.role === 'PARTNER') {
          return { x: prediction.x, z: prediction.z };
        }
        if (teammate && player.role === 'PRIMARY') {
          // Primary positions near the net to prepare Touch 3 approach
          return { x: sideSign * 1.85, z: clamp(prediction.z * 0.5, -2.2, 2.2, 0) };
        }
        // 1v1: single player tracks the Bump landing point to Set
        return { x: prediction.x, z: prediction.z };
      }

      // Touch 0 (receiving incoming shot): closest player chases prediction
      if (teammate) {
        const myDist = Math.hypot(prediction.x - player.pos.x, prediction.z - player.pos.z);
        const mateDist = Math.hypot(prediction.x - teammate.pos.x, prediction.z - teammate.pos.z);
        if (myDist <= mateDist + 0.35) {
          return { x: prediction.x, z: prediction.z };
        }
        // Other player moves to setter zone ready for Touch 2
        return { x: sideSign * 2.2, z: clamp(-prediction.z * 0.35, -1.6, 1.6, 0) };
      }

      return { x: prediction.x, z: prediction.z };
    }

    // Ball on opponent's side -> style-specific defensive positioning
    if (player.team === 2 && player.role === 'PRIMARY' && !player.isHuman) {
      const oppPrimary = players.find((p) => p.team === opponentTeam && p.role === 'PRIMARY');
      const oppZ = oppPrimary ? oppPrimary.pos.z : ball.pos.z;

      if (aiStyle === AI_STYLES.NET_BLOCKER) {
        if (
          (scoreboard.activeTeam === opponentTeam && scoreboard.touchCount >= 1) ||
          (timingRing.active && timingRing.team === opponentTeam)
        ) {
          return { x: 1.05, z: clamp(oppZ, -3.2, 3.2, 0) };
        }
        return { x: 1.65, z: clamp(ball.pos.z * 0.6, -2.5, 2.5, 0) };
      }

      if (aiStyle === AI_STYLES.WIND_LOBBER) {
        return { x: 5.2, z: clamp(ball.pos.z * 0.4, -2.0, 2.0, 0) };
      }

      // SPIN_SLICER
      return { x: 4.0, z: clamp(ball.pos.z * 0.5, -2.4, 2.4, 0) };
    }

    // Default home position (or 2v2 partner cover)
    if (format === MATCH_FORMATS.TWO_V_TWO) {
      return player.role === 'PARTNER'
        ? { x: sideSign * 2.1, z: player.team === 1 ? -1.4 : 1.4 }
        : { x: sideSign * 4.8, z: player.team === 1 ? 1.4 : -1.4 };
    }
    return { x: sideSign * 4.2, z: clamp(ball.pos.z * 0.35, -2.0, 2.0, 0) };
  }

  function computeMoveVectorToward(player, target) {
    const dx = target.x - player.pos.x;
    const dz = target.z - player.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.14) {
      return { moveX: 0, moveZ: 0 };
    }
    const scale = clamp(dist / 0.85, 0, 1, 0);
    return {
      moveX: (dx / dist) * scale,
      moveZ: (dz / dist) * scale,
    };
  }

  function buildAiCommand(player, dt = FIXED_DT) {
    const opponentTeam = player.team === 1 ? 2 : 1;
    const myTouch = scoreboard.activeTeam === player.team ? scoreboard.touchCount : 0;

    if (player._aiDiveCooldown > 0) {
      player._aiDiveCooldown = Math.max(0, player._aiDiveCooldown - dt);
    }

    const isOpponentAttackShot =
      ball.lastHitTeam === opponentTeam &&
      (ball.shotType === SHOT_TYPES.HEAT_SPIKE ||
        ball.shotType === SHOT_TYPES.SPIKE ||
        ball.shotType === SHOT_TYPES.POKEY_CUT ||
        ball.shotType === SHOT_TYPES.BLOCK_STUFF ||
        ball.shotType === SHOT_TYPES.LOB ||
        ball.shotType === SHOT_TYPES.SERVE);

    const isFastAttack =
      ball.shotType === SHOT_TYPES.HEAT_SPIKE || ball.shotType === SHOT_TYPES.BLOCK_STUFF;

    // Trigger human-like defensive reaction delay whenever opponent strikes an incoming shot
    if (isOpponentAttackShot && scoreboard.rallyCount !== player._aiSeenRallyCount) {
      player._aiSeenRallyCount = scoreboard.rallyCount;
      if (isFastAttack) {
        player._aiReactTimer = 0.28;
      } else if (
        ball.shotType === SHOT_TYPES.SPIKE ||
        ball.shotType === SHOT_TYPES.POKEY_CUT
      ) {
        player._aiReactTimer = 0.22;
      } else {
        player._aiReactTimer = 0.14;
      }
    }

    if (player._aiReactTimer > 0) {
      player._aiReactTimer = Math.max(0, player._aiReactTimer - dt);
    }

    const rawTarget = computeDesiredTargetPos(player);
    const defendingIncoming = myTouch === 0 && isOpponentAttackShot;

    let effectiveTarget;
    let speedScale = 1.0;

    if (defendingIncoming) {
      if (player._aiReactTimer > 0) {
        effectiveTarget = { x: player._aiTargetX, z: player._aiTargetZ };
      } else {
        player._aiTargetX = rawTarget.x;
        player._aiTargetZ = rawTarget.z;
        effectiveTarget = rawTarget;
      }
      speedScale = isFastAttack ? 0.62 : 0.74;
    } else {
      // Crisp full-speed movement on own team's Touch 1->2 Set, Touch 2->3 Attack, and NetBlock setup
      player._aiReactTimer = 0;
      player._aiTargetX = rawTarget.x;
      player._aiTargetZ = rawTarget.z;
      effectiveTarget = rawTarget;
      speedScale = 1.0;
    }

    const rawMove = computeMoveVectorToward(player, effectiveTarget);
    const moveX = rawMove.moveX * speedScale;
    const moveZ = rawMove.moveZ * speedScale;

    const cmd = {
      moveX,
      moveZ,
      aimX: 0,
      aimZ: 0,
      primaryHeld: false,
      primaryJustPressed: false,
      primaryJustReleased: false,
      secondaryHeld: false,
      secondaryJustPressed: false,
      secondaryJustReleased: false,
      isHuman: false,
      autoFootwork: false,
      _aiAttack: null,
    };

    const horizDist = Math.hypot(ball.pos.x - player.pos.x, ball.pos.z - player.pos.z);
    const ballOnMySide = player.team === 1 ? ball.pos.x <= 0.05 : ball.pos.x >= -0.05;

    // NET_BLOCKER jumps to Stuff-Block opponent's Set / Attack!
    if (
      player.team === 2 &&
      player.role === 'PRIMARY' &&
      aiStyle === AI_STYLES.NET_BLOCKER &&
      Math.abs(player.pos.x) <= 1.85 &&
      !player.isAirborne &&
      player.blockTimer <= 0
    ) {
      const oppSetting =
        timingRing.active &&
        timingRing.team === opponentTeam &&
        timingRing.progress >= 0.55;
      const oppSpikingAtNet =
        ball.lastHitTeam === opponentTeam &&
        ball.vel.x > 4.0 &&
        ball.pos.x > -2.5 &&
        ball.pos.x < 0.2 &&
        ball.pos.y >= 1.9 &&
        ball.pos.y <= 3.5;

      if (oppSetting || oppSpikingAtNet) {
        cmd.secondaryJustPressed = true;
        cmd.secondaryHeld = true;
        return cmd;
      }
    }

    if (!ballOnMySide || player.strikeCooldown > 0) {
      return cmd;
    }

    // Touch 1: Bump or realistic-reach SandDive (with AI dive cooldown)
    if (myTouch === 0) {
      const aiBumpReach = isFastAttack ? 1.15 : 1.35;
      if (
        player._aiDiveCooldown <= 0 &&
        horizDist > aiBumpReach &&
        horizDist <= 1.50 &&
        ball.pos.y <= 1.50 &&
        ball.vel.y < 0
      ) {
        cmd.secondaryJustPressed = true;
      } else if (horizDist <= aiBumpReach && ball.pos.y <= 2.35) {
        cmd.primaryJustPressed = true;
        cmd.primaryHeld = true;
      }
      return cmd;
    }

    // Touch 2: Set
    if (myTouch === 1) {
      if (horizDist <= 1.45 && ball.pos.y <= 2.95 && ball.vel.y <= 1.2) {
        cmd.primaryJustPressed = true;
        cmd.primaryHeld = true;
      }
      return cmd;
    }

    // Touch 3: Attack according to AI style!
    if (myTouch === 2) {
      // In 2v2, AI PARTNER yields Touch 3 to PRIMARY after setting (or whenever ball is safely playable)
      if (player.role === 'PARTNER') {
        const primary = players.find((p) => p.team === player.team && p.role === 'PRIMARY');
        if (primary && (player._lastTouched || timingRing.active || ball.pos.y > 1.35)) {
          const coverPos = computePartnerCoverPos(player, primary);
          const coverMove = computeMoveVectorToward(player, coverPos);
          cmd.moveX = coverMove.moveX;
          cmd.moveZ = coverMove.moveZ;
          cmd.primaryJustPressed = false;
          cmd.primaryHeld = false;
          cmd.secondaryJustPressed = false;
          cmd.secondaryHeld = false;
          return cmd;
        }
      }

      const openSideZ = pickOpenTargetZ(opponentTeam);

      const readyToStrike =
        horizDist <= 1.65 &&
        ball.pos.y >= 1.4 &&
        ball.pos.y <= 3.95 &&
        ((timingRing.active && timingRing.progress >= 0.65) || ball.vel.y <= 0.8);

      if (readyToStrike) {
        cmd.primaryJustPressed = true;
        cmd.primaryHeld = true;

        if (player.team === 2 && player.role === 'PRIMARY') {
          if (aiStyle === AI_STYLES.WIND_LOBBER) {
            // Aim high Sky Lob riding the wind!
            const windAssistZ = clamp(openSideZ - wind.windVec3.z * 0.25, -3.4, 3.4, 0);
            cmd._aiAttack = {
              shotKind: SHOT_TYPES.LOB,
              targetZ: windAssistZ,
              sidespin: 0,
            };
          } else if (aiStyle === AI_STYLES.NET_BLOCKER) {
            cmd._aiAttack = {
              shotKind: getTeamHeat(player.team) >= 0.95 ? SHOT_TYPES.HEAT_SPIKE : SHOT_TYPES.SPIKE,
              targetZ: openSideZ,
              sidespin: 0,
            };
          } else {
            // SPIN_SLICER: strong sidespin + Backspin Pokey/Cut toward open sideline
            const sliceDir = openSideZ >= 0 ? 1 : -1;
            cmd._aiAttack = {
              shotKind: SHOT_TYPES.POKEY_CUT,
              targetZ: openSideZ,
              sidespin: sliceDir * 15.0,
            };
          }
        } else {
          // 2v2 emergency partner attack fallback targeting open space away from BOTH opponents
          cmd._aiAttack = {
            shotKind: getTeamHeat(player.team) >= 0.95 ? SHOT_TYPES.HEAT_SPIKE : SHOT_TYPES.SPIKE,
            targetZ: openSideZ,
            sidespin: 0,
          };
        }
      }
    }

    return cmd;
  }

  // ---- Per-Step Player Update & Contact Resolution ----

  function updatePlayerKinematics(player, cmd, dt) {
    if (player.strikeCooldown > 0) {
      player.strikeCooldown = Math.max(0, player.strikeCooldown - dt);
    }
    if (player.diveTimer > 0) {
      player.diveTimer = Math.max(0, player.diveTimer - dt);
    }
    if (player.blockTimer > 0) {
      player.blockTimer = Math.max(0, player.blockTimer - dt);
    }
    if (player._actionTimer > 0) {
      player._actionTimer = Math.max(0, player._actionTimer - dt);
      if (player._actionTimer === 0) {
        player._actionAnim = null;
      }
    }

    // Horizontal movement (suspended during active SandDive slide)
    if (player.diveTimer > 0) {
      const diveDamp = Math.exp(-5.0 * dt);
      player.vel.x *= diveDamp;
      player.vel.z *= diveDamp;
    } else {
      const targetVx = cmd.moveX * PLAYER_MAX_SPEED;
      const targetVz = cmd.moveZ * PLAYER_MAX_SPEED;
      const hasMove = Math.hypot(cmd.moveX, cmd.moveZ) > 0.02;

      if (hasMove) {
        const blend = clamp(PLAYER_ACCEL * dt / PLAYER_MAX_SPEED, 0, 1, 0.2);
        player.vel.x += (targetVx - player.vel.x) * blend;
        player.vel.z += (targetVz - player.vel.z) * blend;
      } else {
        const damp = Math.exp(-PLAYER_GROUND_DRAG * dt);
        player.vel.x *= damp;
        player.vel.z *= damp;
        if (Math.hypot(player.vel.x, player.vel.z) < 0.05) {
          player.vel.x = 0;
          player.vel.z = 0;
        }
      }
    }

    // Vertical jump physics
    if (player.isAirborne || player.pos.y > 0 || player.vel.y > 0) {
      player.vel.y -= PLAYER_GRAVITY * dt;
      player.pos.y += player.vel.y * dt;
      if (player.pos.y <= 0) {
        player.pos.y = 0;
        player.vel.y = 0;
        player.isAirborne = false;
      } else {
        player.isAirborne = true;
      }
    }

    player.pos.x += player.vel.x * dt;
    player.pos.z += player.vel.z * dt;

    // Enforce own-side court & net-clearance boundaries
    const minX = player.team === 1 ? -COURT.ARENA_HALF_X + WALL_PLAYER_MARGIN : NET_CLEAR_X_MARGIN;
    const maxX = player.team === 1 ? -NET_CLEAR_X_MARGIN : COURT.ARENA_HALF_X - WALL_PLAYER_MARGIN;
    player.pos.x = clamp(player.pos.x, minX, maxX, player.team === 1 ? -4.2 : 4.2);
    player.pos.z = clamp(
      player.pos.z,
      -COURT.ARENA_HALF_Z + WALL_PLAYER_MARGIN,
      COURT.ARENA_HALF_Z - WALL_PLAYER_MARGIN,
      0,
    );

    // Facing yaw (Right-handed Math.atan2(dx, dz): +PI/2 faces +X, -PI/2 faces -X)
    const forwardSign = player.team === 1 ? 1 : -1;
    const defaultYaw = player.team === 1 ? Math.PI / 2 : -Math.PI / 2;
    const horizSpeed = Math.hypot(player.vel.x, player.vel.z);

    if (player.diveTimer > 0 && horizSpeed > 0.2) {
      player.facingYaw = computeFacingYaw(player.vel.x, player.vel.z, defaultYaw);
    } else if (player.blockTimer > 0) {
      player.facingYaw = defaultYaw;
    } else if (horizSpeed > 2.0) {
      player.facingYaw = computeFacingYaw(
        player.vel.x * 0.6 + forwardSign * 2.4,
        player.vel.z * 0.6,
        defaultYaw,
      );
    } else {
      player.facingYaw = computeFacingYaw(
        (ball.pos.x - player.pos.x) * 0.35 + forwardSign * 2.5,
        (ball.pos.z - player.pos.z) * 0.35,
        defaultYaw,
      );
    }

    // Charge buildup while holding primary near ball on Touch 3
    const ballOnMySide = player.team === 1 ? ball.pos.x <= 0.5 : ball.pos.x >= -0.5;
    if (cmd.primaryHeld && ballOnMySide && scoreboard.phase === 'RALLY') {
      const prevCharge = player.chargeRatio;
      player.chargeRatio = clamp(player.chargeRatio + dt * 1.15, 0, 1, 0);
      chargeTickAccum += dt;
      if (player.chargeRatio > prevCharge && chargeTickAccum >= 0.08) {
        chargeTickAccum = 0;
        emitEvent(EVENTS.CHARGE_TICK, {
          team: player.team,
          playerId: player.id,
          ratio: player.chargeRatio,
        });
      }
    } else if (!cmd.primaryHeld && !cmd.primaryJustReleased) {
      player.chargeRatio = Math.max(0, player.chargeRatio - dt * 2.4);
    }

    // Update targetBallPos for IK rigs
    const dist3D = Math.hypot(
      ball.pos.x - player.pos.x,
      ball.pos.y - (player.pos.y + 1.2),
      ball.pos.z - player.pos.z,
    );
    player.targetBallPos = ballOnMySide || dist3D <= 5.0 ? cloneVec3(ball.pos) : null;

    // Animation state resolution (exact 7 ANIM_STATES)
    player.animTime += dt;
    if (player.diveTimer > 0) {
      player.animState = ANIM_STATES.SAND_DIVE;
      player.animProgress = clamp(1 - player.diveTimer / DIVE_DURATION, 0, 1, 0);
    } else if (player.blockTimer > 0) {
      player.animState = ANIM_STATES.NET_BLOCK;
      player.animProgress = clamp(1 - player.blockTimer / BLOCK_DURATION, 0, 1, 0);
    } else if (player._actionAnim && (player._actionTimer > 0 || (player._actionAnim === ANIM_STATES.JUMP_HEAT_SPIKE && player.isAirborne))) {
      player.animState = player._actionAnim;
      player.animProgress = clamp(
        1 - player._actionTimer / Math.max(0.05, player._actionDuration),
        0,
        1,
        0,
      );
    } else if (player.isAirborne) {
      player.animState = ANIM_STATES.JUMP_HEAT_SPIKE;
      player.animProgress = clamp(0.5 - player.vel.y / (2 * PLAYER_JUMP_VY), 0, 1, 0.5);
    } else if (horizSpeed > 0.45) {
      player.animState = ANIM_STATES.SPRINT;
      player.animProgress = (player.animTime * 2.6) % 1;
    } else {
      player.animState = ANIM_STATES.IDLE;
      player.animProgress = (player.animTime * 0.8) % 1;
    }
  }

  function handlePlayerActionsAndContacts(player, cmd, cfg) {
    if (scoreboard.phase !== 'RALLY' || !ball.active) {
      return;
    }

    const ballOnMySide = player.team === 1 ? ball.pos.x <= 0.05 : ball.pos.x >= -0.05;
    const horizDist = Math.hypot(ball.pos.x - player.pos.x, ball.pos.z - player.pos.z);

    // 1. Defensive NetBlock initiation near net
    const opponentHasBall =
      (player.team === 1 && ball.pos.x > -0.35) ||
      (player.team === 2 && ball.pos.x < 0.35) ||
      (timingRing.active && timingRing.team !== player.team);

    if (
      cmd.secondaryJustPressed &&
      Math.abs(player.pos.x) <= 1.85 &&
      opponentHasBall &&
      !player.isAirborne
    ) {
      triggerNetBlock(player);
      return;
    }

    if (!ballOnMySide) {
      return;
    }

    const myTouch = scoreboard.activeTeam === player.team ? scoreboard.touchCount : 0;

    // 2. Defensive SandDive initiation on Touch 1
    if (
      myTouch === 0 &&
      cmd.secondaryJustPressed &&
      !player.isAirborne &&
      player.diveTimer <= 0 &&
      (Math.abs(player.pos.x) > 1.85 || ball.pos.y <= 1.95)
    ) {
      triggerSandDive(player, ball.pos.x, ball.pos.z);
    }

    // 3. Jump approach on Touch 3 Set
    if (
      myTouch === 2 &&
      !player.isAirborne &&
      (cmd.primaryJustPressed || cmd.secondaryJustPressed) &&
      horizDist <= 2.6 &&
      ball.pos.y >= 1.5
    ) {
      player.isAirborne = true;
      player.vel.y = PLAYER_JUMP_VY;
      setPlayerActionAnim(player, ANIM_STATES.JUMP_HEAT_SPIKE, SPIKE_ANIM_DURATION);
    }

    // 4. Ball contact resolution (guarded by global & per-player cooldowns)
    if (globalContactCooldown > 0 || player.strikeCooldown > 0) {
      return;
    }

    const activeAction =
      cmd.primaryJustPressed ||
      cmd.primaryJustReleased ||
      cmd.primaryHeld ||
      cmd.secondaryJustPressed ||
      cmd.secondaryHeld;

    // 4th-touch fault if somehow a team already used 3 touches on same side
    if (myTouch >= 3) {
      if (horizDist <= 1.25 && ball.pos.y <= 2.4 && activeAction) {
        awardPoint(player.team === 1 ? 2 : 1, 'TOUCH_VIOLATION');
      }
      return;
    }

    if (myTouch === 0) {
      // Touch 1: Bump/Dig or SandDive (human gets hero 2.25m dive reach; AI uses realistic 1.50m reach)
      const isFastAttack =
        ball.shotType === SHOT_TYPES.HEAT_SPIKE || ball.shotType === SHOT_TYPES.BLOCK_STUFF;
      const diveReach = player.isHuman ? 2.25 : 1.50;
      const bumpReach = player.isHuman ? 1.50 : isFastAttack ? 1.15 : 1.35;
      const divingSave = player.diveTimer > 0 && horizDist <= diveReach && ball.pos.y <= 1.95;
      const explicitBump = activeAction && horizDist <= bumpReach && ball.pos.y <= 2.50;
      const reactiveBump =
        !activeAction &&
        ball.shotType !== SHOT_TYPES.BLOCK_STUFF &&
        ball.vel.y <= 0.5 &&
        horizDist <= (player.isHuman ? 1.05 : isFastAttack ? 0.85 : 1.00) &&
        ball.pos.y <= 1.85;

      if (divingSave) {
        executeTouch1BumpOrDive(player, cmd, cfg, true);
      } else if (explicitBump || reactiveBump) {
        executeTouch1BumpOrDive(player, cmd, cfg, false);
      }
      return;
    }

    if (myTouch === 1) {
      // Touch 2: Set (prefer teammate in 2v2 if primary just bumped, unless ball is about to hit sand)
      const explicitSet =
        activeAction &&
        horizDist <= 1.50 &&
        ball.pos.y >= 0.60 &&
        ball.pos.y <= 3.15 &&
        ball.vel.y <= 1.6;
      const reactiveSet =
        !activeAction &&
        ball.vel.y <= 0.4 &&
        horizDist <= 1.05 &&
        ball.pos.y <= 2.35;

      if (explicitSet || reactiveSet) {
        executeTouch2Set(player, cmd, cfg);
      }
      return;
    }

    if (myTouch === 2) {
      // In 2v2, AI PARTNER yields Touch 3 to PRIMARY except for emergency low-sand saves when PRIMARY is far
      if (player.role === 'PARTNER') {
        const primary = players.find((p) => p.team === player.team && p.role === 'PRIMARY');
        if (primary) {
          const primaryDist = Math.hypot(ball.pos.x - primary.pos.x, ball.pos.z - primary.pos.z);
          if (player._lastTouched || ball.pos.y > 1.25 || primaryDist <= 2.6) {
            return;
          }
        }
      }

      // Touch 3: Attack (Heat Spike / Standard Spike / Backspin Pokey-Cut / Sky Lob)
      const dist3D = Math.hypot(
        ball.pos.x - player.pos.x,
        ball.pos.y - (player.pos.y + 1.8),
        ball.pos.z - player.pos.z,
      );
      const inStrikeReach =
        (horizDist <= 1.65 && ball.pos.y >= 0.9 && ball.pos.y <= 4.15) || dist3D <= 1.75;

      if (!inStrikeReach) {
        return;
      }

      const sweetSpotTrigger =
        timingRing.active &&
        timingRing.team === player.team &&
        timingRing.inSweetSpot &&
        (cmd.primaryHeld || cmd.secondaryHeld);

      const reactiveAttack = cmd.autoFootwork
        ? !activeAction && ball.vel.y < -0.5 && horizDist <= 1.35 && ball.pos.y <= 2.45
        : !activeAction && ball.vel.y < -1.0 && horizDist <= 1.05 && ball.pos.y <= 1.95;

      const triggerAttack =
        cmd.primaryJustPressed ||
        cmd.primaryJustReleased ||
        cmd.secondaryJustPressed ||
        sweetSpotTrigger ||
        ((cmd.primaryHeld || cmd.secondaryHeld) && ball.vel.y <= 0.35) ||
        reactiveAttack;

      if (triggerAttack) {
        executeTouch3Attack(player, cmd, cfg, cmd._aiAttack || null);
      }
    }
  }

  function checkStuffBlockCollisions() {
    if (scoreboard.phase !== 'RALLY' || !ball.active) {
      return;
    }

    for (let i = 0; i < players.length; i++) {
      const blocker = players[i];
      if (blocker.blockTimer <= 0 || blocker.strikeCooldown > 0) {
        continue;
      }
      if (Math.abs(blocker.pos.x) > 1.95) {
        continue;
      }
      if (ball.lastHitTeam === blocker.team) {
        continue;
      }

      // Ball moving toward blocker's court near net plane inside block volume
      const towardBlocker = blocker.team === 1 ? ball.vel.x < -0.5 : ball.vel.x > 0.5;
      if (!towardBlocker) {
        continue;
      }

      // Bias block X-volume toward net plane + blocker's side so close-net spikes cannot tunnel
      // while rising Pokey/Cut shots clear over y > 3.32m without premature clipping on attacker side
      const inBlockX =
        blocker.team === 2
          ? ball.pos.x >= -0.25 && ball.pos.x <= BLOCK_HALF_X
          : ball.pos.x <= 0.25 && ball.pos.x >= -BLOCK_HALF_X;

      const inBlockVolume =
        inBlockX &&
        ball.pos.y >= BLOCK_MIN_Y &&
        ball.pos.y <= BLOCK_MAX_Y &&
        Math.abs(ball.pos.z - blocker.pos.z) <= BLOCK_HALF_Z;

      if (inBlockVolume) {
        const attackerSideSign = blocker.team === 1 ? 1 : -1;
        const deflectSignX = -Math.sign(ball.vel.x) || attackerSideSign;
        ball.pos.x = attackerSideSign * 0.45;
        ball.vel.x = deflectSignX * 2.8;
        ball.vel.y = -8.6;
        ball.vel.z = clamp(
          ball.vel.z * 0.35 + (ball.pos.z - blocker.pos.z) * 1.8,
          -3.5,
          3.5,
          0,
        );
        ball.omega = computeSpinOmega(ball.vel.x, ball.vel.z, 14.0, 0);
        ball.shotType = SHOT_TYPES.BLOCK_STUFF;
        ball.trailMode = TRAIL_MODES.NEUTRAL;
        ball.lastHitTeam = blocker.team;

        const attackerTeam = blocker.team === 1 ? 2 : 1;
        lastCourtSide = attackerSideSign;
        scoreboard.activeTeam = attackerTeam;
        scoreboard.touchCount = 0;
        scoreboard.rallyCount += 1;
        resetTimingRing();

        // Brief recovery cooldown on the attacker whose spike was just stuffed
        let stuffedAttacker = null;
        let bestAttackerDist = Infinity;
        for (let j = 0; j < players.length; j++) {
          const p = players[j];
          if (p.team === attackerTeam) {
            const d = Math.hypot(p.pos.x - ball.pos.x, p.pos.z - ball.pos.z);
            if (d < bestAttackerDist) {
              bestAttackerDist = d;
              stuffedAttacker = p;
            }
          }
        }
        if (stuffedAttacker) {
          stuffedAttacker.strikeCooldown = Math.max(stuffedAttacker.strikeCooldown, 0) + 0.18;
        }

        cameraPunch = Math.max(cameraPunch, 0.75);
        blocker.strikeCooldown = 0.30;
        globalContactCooldown = 0.12;

        emitEvent(EVENTS.STUFF_BLOCK, {
          team: blocker.team,
          playerId: blocker.id,
          pos: cloneVec3(ball.pos),
          shotType: SHOT_TYPES.BLOCK_STUFF,
        });
        return;
      }
    }
  }

  // ---- Core Fixed-Timestep Simulation Step ----

  function executeFixedStep(dt, rawInputs, cfg) {
    const safeDt = clamp(dt, 1e-5, 0.05, physics.FIXED_DT);
    lastPhysicsConfig = cfg;

    if (globalContactCooldown > 0) {
      globalContactCooldown = Math.max(0, globalContactCooldown - safeDt);
    }
    if (cameraPunch > 0) {
      cameraPunch = Math.max(0, cameraPunch - safeDt * 3.8);
    }
    if (scoreboard.bannerTimer > 0) {
      scoreboard.bannerTimer = Math.max(0, scoreboard.bannerTimer - safeDt);
      if (scoreboard.bannerTimer === 0) {
        scoreboard.bannerText = '';
      }
    }

    // 1. Update Heavy Gale 3D wind
    const windResult = physics.updateWind3D(wind, safeDt, cfg);
    if (windResult && windResult.phaseChanged) {
      if (windResult.phase === WIND_PHASES.WARNING) {
        emitEvent(EVENTS.GUST_WARNING, { windVec3: cloneVec3(wind.windVec3) });
      } else if (windResult.phase === WIND_PHASES.GUST) {
        emitEvent(EVENTS.GUST_START, { windVec3: cloneVec3(wind.windVec3) });
      }
    }

    // 2. Point-pause countdown before launching next serve
    if (scoreboard.phase === 'POINT_PAUSE') {
      pointPauseTimer = Math.max(0, pointPauseTimer - safeDt);
      if (pointPauseTimer <= 0) {
        if (scoreboard.winner !== null) {
          scoreboard.scoreP1 = 0;
          scoreboard.scoreP2 = 0;
          scoreboard.winner = null;
        }
        launchServe(scoreboard.servingTeam, cfg);
      }
      return;
    }

    // 3. Normalize inputs & human takeover tracking for P2
    const p1Input = normalizePlayerCmd(rawInputs?.p1);
    const p2Input = normalizePlayerCmd(rawInputs?.p2);

    if (p2Input.isHuman) {
      p2HumanTimer = 6.0;
    } else if (p2HumanTimer > 0) {
      p2HumanTimer = Math.max(0, p2HumanTimer - safeDt);
    }

    // 4. Advance shrinking 3D Timing Ring
    if (timingRing.active) {
      timingRing.elapsed += safeDt;
      const progress = clamp(timingRing.elapsed / Math.max(0.1, timingRing.duration), 0, 1, 0);
      timingRing.progress = progress;
      timingRing.radius = clamp(1.25 - progress * 0.90, 0.28, 1.25, 0.35);
      timingRing.inSweetSpot =
        progress >= timingRing.sweetSpotMin && progress <= timingRing.sweetSpotMax;
      if (timingRing.elapsed > timingRing.duration + 0.55) {
        resetTimingRing();
      }
    }

    // 5. Step ball 3D aerodynamics, walls, net & sand impact
    const prevBallX = ball.pos.x;
    if (prevBallX < 0) {
      lastCourtSide = -1;
    } else if (prevBallX > 0) {
      lastCourtSide = 1;
    }
    const stepResult = physics.stepBall3D(ball, wind, cfg, safeDt, false) || {};

    // Guard finite ball state
    if (!Number.isFinite(ball.pos.x) || !Number.isFinite(ball.pos.y) || !Number.isFinite(ball.pos.z)) {
      ball.pos = createVec3(0, 3, 0);
      ball.vel = createVec3(0, 0, 0);
    }

    // Strict court-side crossing check: ignore exact x === 0 so +0.1 -> 0 -> -0.1
    // always assigns activeTeam = 1 on entering x < 0, and -0.1 -> 0 -> -0.1 never resets touchCount.
    const currentCourtSide = ball.pos.x < 0 ? -1 : ball.pos.x > 0 ? 1 : 0;
    if (currentCourtSide !== 0 && currentCourtSide !== lastCourtSide) {
      lastCourtSide = currentCourtSide;
      const nextTeam = currentCourtSide < 0 ? 1 : 2;
      if (nextTeam !== scoreboard.activeTeam || scoreboard.touchCount > 0) {
        scoreboard.activeTeam = nextTeam;
        scoreboard.touchCount = 0;
        resetTimingRing();
      }
    }

    if (stepResult.wallHit) {
      const wallName =
        typeof stepResult.wallHit === 'string'
          ? stepResult.wallHit
          : typeof stepResult.wallHit.wall === 'string'
            ? stepResult.wallHit.wall
            : 'WALL';
      emitEvent(EVENTS.WALL_BOUNCE, {
        wall: wallName,
        pos: cloneVec3(ball.pos),
        speed: finiteOr(stepResult.wallHit.impactSpeed ?? stepResult.speed, Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z)),
      });
    }

    if (stepResult.netHit) {
      const netPart =
        typeof stepResult.netHit === 'string'
          ? stepResult.netHit
          : typeof stepResult.netHit.part === 'string'
            ? stepResult.netHit.part
            : null;
      const isTape =
        netPart === 'TAPE' ||
        netPart === 'POST' ||
        (netPart === null && ball.pos.y >= COURT.NET_HEIGHT - 0.25);
      emitEvent(isTape ? EVENTS.NET_TAPE_HIT : EVENTS.NET_MESH_HIT, {
        part: netPart || (isTape ? 'TAPE' : 'MESH'),
        pos: cloneVec3(ball.pos),
        speed: finiteOr(stepResult.netHit.impactSpeed ?? stepResult.speed, Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z)),
      });
    }

    // 6. Check Stuff-Block collisions against active NetBlockers
    checkStuffBlockCollisions();

    // 7. Sand impact scoring
    if (stepResult.landed || ball.pos.y <= ball.radius) {
      emitEvent(EVENTS.SAND_IMPACT, {
        pos: cloneVec3(ball.pos),
        speed: finiteOr(stepResult.speed, Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z)),
      });
      const winner = ball.pos.x < 0 ? 2 : 1;
      awardPoint(winner, 'SAND');
      return;
    }

    // 8. Refresh landing prediction for AI & TOUCH auto-footwork
    refreshPrediction(cfg);

    // 9. Update all players (1v1 or 2v2)
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      let cmd;

      if (player.team === 1 && player.role === 'PRIMARY') {
        player.isHuman = true;
        cmd = p1Input;
        if (cmd.autoFootwork) {
          const target = computeDesiredTargetPos(player);
          const autoMove = computeMoveVectorToward(player, target);
          cmd = {
            ...cmd,
            _manualMoveX: cmd.moveX,
            _manualMoveZ: cmd.moveZ,
            moveX: Math.abs(cmd.moveX) > 0.05 ? cmd.moveX : autoMove.moveX,
            moveZ: Math.abs(cmd.moveZ) > 0.05 ? cmd.moveZ : autoMove.moveZ,
          };
        }
      } else if (player.team === 2 && player.role === 'PRIMARY') {
        if (p2HumanTimer > 0) {
          player.isHuman = true;
          cmd = p2Input;
          if (cmd.autoFootwork) {
            const target = computeDesiredTargetPos(player);
            const autoMove = computeMoveVectorToward(player, target);
            cmd = {
              ...cmd,
              _manualMoveX: cmd.moveX,
              _manualMoveZ: cmd.moveZ,
              moveX: Math.abs(cmd.moveX) > 0.05 ? cmd.moveX : autoMove.moveX,
              moveZ: Math.abs(cmd.moveZ) > 0.05 ? cmd.moveZ : autoMove.moveZ,
            };
          }
        } else {
          player.isHuman = false;
          cmd = buildAiCommand(player, safeDt);
        }
      } else {
        // 2v2 AI Partner
        player.isHuman = false;
        cmd = buildAiCommand(player, safeDt);
      }

      updatePlayerKinematics(player, cmd, safeDt);
      handlePlayerActionsAndContacts(player, cmd, cfg);
    }
  }

  // ---- Public API ----

  function getSnapshot() {
    return {
      ball: {
        pos: cloneVec3(ball.pos),
        vel: cloneVec3(ball.vel),
        omega: cloneVec3(ball.omega),
        radius: ball.radius,
        trailMode: ball.trailMode,
        shotType: ball.shotType,
        lastHitTeam: ball.lastHitTeam,
        spinAngle: cloneVec3(ball.spinAngle),
        active: ball.active,
      },
      wind: {
        time: wind.time,
        phase: wind.phase,
        timer: wind.timer,
        windVec3: cloneVec3(wind.windVec3),
        gustTargetVec3: cloneVec3(wind.gustTargetVec3),
        speed: wind.speed,
      },
      prediction: {
        x: prediction.x,
        z: prediction.z,
        hangTime: prediction.hangTime,
        landedWithinSteps: prediction.landedWithinSteps,
        steps: prediction.steps,
        trajectory: Array.isArray(prediction.trajectory)
          ? prediction.trajectory.map((pt) =>
              pt && typeof pt === 'object'
                ? { x: finiteOr(pt.x, 0), y: finiteOr(pt.y, 0), z: finiteOr(pt.z, 0) }
                : { x: 0, y: 0, z: 0 },
            )
          : [],
      },
      players: players.map((p) => ({
        id: p.id,
        team: p.team,
        role: p.role,
        isHuman: p.isHuman,
        pos: cloneVec3(p.pos),
        vel: cloneVec3(p.vel),
        facingYaw: p.facingYaw,
        animState: p.animState,
        animTime: p.animTime,
        animProgress: p.animProgress,
        chargeRatio: p.chargeRatio,
        heatMeter: p.heatMeter,
        isAirborne: p.isAirborne,
        diveTimer: p.diveTimer,
        blockTimer: p.blockTimer,
        strikeCooldown: p.strikeCooldown,
        targetBallPos: p.targetBallPos ? cloneVec3(p.targetBallPos) : null,
      })),
      timingRing: {
        active: timingRing.active,
        pos: cloneVec3(timingRing.pos),
        team: timingRing.team,
        progress: timingRing.progress,
        radius: timingRing.radius,
        sweetSpotMin: timingRing.sweetSpotMin,
        sweetSpotMax: timingRing.sweetSpotMax,
        sweetMin: timingRing.sweetSpotMin,
        sweetMax: timingRing.sweetSpotMax,
        inSweetSpot: timingRing.inSweetSpot,
        isSweetSpot: timingRing.inSweetSpot,
      },
      scoreboard: {
        ...scoreboard,
        scoreT1: scoreboard.scoreP1,
        scoreT2: scoreboard.scoreP2,
        heatT1: scoreboard.team1Heat,
        heatT2: scoreboard.team2Heat,
        windSpeedMs: wind.speed,
        windPhase: wind.phase,
        bannerColor: scoreboard.lastPointWinner === 2 ? '#ff00aa' : '#ffd166',
        paused,
      },
      cameraPunch,
      hitStopFrames,
      events: [...frameEvents, ...pendingExternalEvents].map(cloneEvent),
    };
  }

  function update(rawDt, inputs = null, physicsConfig = PHYSICS_DEFAULTS) {
    frameEvents = pendingExternalEvents;
    pendingExternalEvents = [];
    if (paused) {
      return getSnapshot();
    }

    const cfg = sanitizePhysicsConfig(physicsConfig ?? PHYSICS_DEFAULTS);
    const clampedRawDt = clamp(rawDt, 0, MAX_RAW_DT, 0);

    const p1Norm = normalizePlayerCmd(inputs?.p1);
    const p2Norm = normalizePlayerCmd(inputs?.p2);

    // Latch one-shot edges BEFORE hit-stop check so taps during hit-stop or 0-step frames are never lost
    if (p1Norm.primaryJustPressed) pendingEdges.p1.primaryJustPressed = true;
    if (p1Norm.primaryJustReleased) pendingEdges.p1.primaryJustReleased = true;
    if (p1Norm.secondaryJustPressed) pendingEdges.p1.secondaryJustPressed = true;
    if (p1Norm.secondaryJustReleased) pendingEdges.p1.secondaryJustReleased = true;
    if (p2Norm.primaryJustPressed) pendingEdges.p2.primaryJustPressed = true;
    if (p2Norm.primaryJustReleased) pendingEdges.p2.primaryJustReleased = true;
    if (p2Norm.secondaryJustPressed) pendingEdges.p2.secondaryJustPressed = true;
    if (p2Norm.secondaryJustReleased) pendingEdges.p2.secondaryJustReleased = true;

    // 2-frame Heat Spike hit-stop freezes physics for 2 rendered updates
    if (hitStopFrames > 0) {
      hitStopFrames -= 1;
      return getSnapshot();
    }

    accumulator += clampedRawDt * cfg.gameSpeed;

    const fixedDt = physics.FIXED_DT;
    let steps = 0;

    isStepping = true;
    try {
      while (accumulator >= fixedDt - 1e-9 && steps < MAX_SUBSTEPS) {
        const stepInputs =
          steps === 0
            ? {
                p1: {
                  ...p1Norm,
                  primaryJustPressed: pendingEdges.p1.primaryJustPressed,
                  primaryJustReleased: pendingEdges.p1.primaryJustReleased,
                  secondaryJustPressed: pendingEdges.p1.secondaryJustPressed,
                  secondaryJustReleased: pendingEdges.p1.secondaryJustReleased,
                },
                p2: {
                  ...p2Norm,
                  primaryJustPressed: pendingEdges.p2.primaryJustPressed,
                  primaryJustReleased: pendingEdges.p2.primaryJustReleased,
                  secondaryJustPressed: pendingEdges.p2.secondaryJustPressed,
                  secondaryJustReleased: pendingEdges.p2.secondaryJustReleased,
                },
              }
            : {
                p1: stripCmdEdges(p1Norm),
                p2: stripCmdEdges(p2Norm),
              };

        if (steps === 0) {
          clearPendingEdges();
        }

        executeFixedStep(fixedDt, stepInputs, cfg);
        accumulator = Math.max(0, accumulator - fixedDt);
        steps += 1;

        if (hitStopFrames > 0) {
          accumulator = 0;
          break;
        }
      }
    } finally {
      isStepping = false;
    }

    if (accumulator > fixedDt * MAX_SUBSTEPS) {
      accumulator = 0;
    }

    if (steps > 0) {
      refreshPrediction(cfg);
    }

    return getSnapshot();
  }

  function stepFixed(dt = physics.FIXED_DT, inputs = null, physicsConfig = PHYSICS_DEFAULTS) {
    frameEvents = pendingExternalEvents;
    pendingExternalEvents = [];
    if (paused) {
      return getSnapshot();
    }

    const cfg = sanitizePhysicsConfig(physicsConfig ?? PHYSICS_DEFAULTS);
    if (hitStopFrames > 0) {
      hitStopFrames -= 1;
      return getSnapshot();
    }
    isStepping = true;
    try {
      executeFixedStep(dt, inputs, cfg);
    } finally {
      isStepping = false;
    }
    refreshPrediction(cfg);
    return getSnapshot();
  }

  function setFormat(nextFormat) {
    if (!VALID_FORMATS.has(nextFormat)) {
      return format;
    }
    if (format === nextFormat && players.length === (nextFormat === MATCH_FORMATS.TWO_V_TWO ? 4 : 2)) {
      return format;
    }
    format = nextFormat;
    scoreboard.format = format;
    hitStopFrames = 0;
    accumulator = 0;
    clearPendingEdges();
    if (scoreboard.winner !== null) {
      scoreboard.scoreP1 = 0;
      scoreboard.scoreP2 = 0;
      scoreboard.winner = null;
    }
    players = createRoster(format);
    launchServe(scoreboard.servingTeam, lastPhysicsConfig);
    return format;
  }

  function setAiStyle(nextStyle) {
    if (VALID_AI_STYLES.has(nextStyle)) {
      aiStyle = nextStyle;
      scoreboard.aiStyle = aiStyle;
    }
    return aiStyle;
  }

  function triggerGust(dirSignX = null) {
    physics.triggerGaleSurge(wind, dirSignX);
    emitEvent(EVENTS.GUST_WARNING, {
      windVec3: cloneVec3(wind.windVec3),
      gustTargetVec3: cloneVec3(wind.gustTargetVec3),
    });
    return {
      phase: wind.phase,
      windVec3: cloneVec3(wind.windVec3),
      gustTargetVec3: cloneVec3(wind.gustTargetVec3),
    };
  }

  function resetMatch() {
    accumulator = 0;
    hitStopFrames = 0;
    cameraPunch = 0;
    globalContactCooldown = 0;
    pointPauseTimer = 0;
    p2HumanTimer = 0;
    frameEvents = [];
    pendingExternalEvents = [];
    clearPendingEdges();

    const freshWind = createWindState();
    wind.time = freshWind.time;
    wind.phase = freshWind.phase;
    wind.timer = freshWind.timer;
    wind.windVec3 = freshWind.windVec3;
    wind.gustTargetVec3 = freshWind.gustTargetVec3;
    wind.speed = freshWind.speed;

    scoreboard.scoreP1 = 0;
    scoreboard.scoreP2 = 0;
    scoreboard.setsP1 = 0;
    scoreboard.setsP2 = 0;
    scoreboard.servingTeam = initialServingTeam;
    scoreboard.activeTeam = initialServingTeam === 1 ? 2 : 1;
    scoreboard.touchCount = 0;
    scoreboard.rallyCount = 0;
    scoreboard.winner = null;
    scoreboard.lastPointWinner = null;
    scoreboard.bannerText = '';
    scoreboard.bannerTimer = 0;
    scoreboard.phase = 'RALLY';
    setTeamHeat(1, 0);
    setTeamHeat(2, 0);

    players = createRoster(format);
    launchServe(initialServingTeam, lastPhysicsConfig);
    return getSnapshot();
  }

  function setPaused(val) {
    paused = Boolean(val);
    scoreboard.paused = paused;
    return paused;
  }

  // Initialize roster and launch opening serve
  players = createRoster(format);
  launchServe(initialServingTeam, lastPhysicsConfig);

  return {
    update,
    stepFixed,
    getSnapshot,
    setFormat,
    setAiStyle,
    triggerGust,
    resetMatch,
    setPaused,
  };
}
