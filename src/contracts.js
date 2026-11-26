/**
 * SUMMER HEAT 3D — Frozen Shared Contracts, Constants & State Factories
 *
 * Zero-dependency ES2022+ module (imports NOTHING).
 * All exported constant objects and nested arrays are recursively deep-frozen.
 * Read-only after M0 contract freeze.
 */

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const propNames = Object.getOwnPropertyNames(value);
  for (let i = 0; i < propNames.length; i++) {
    const prop = value[propNames[i]];
    if (prop !== null && typeof prop === 'object' && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  }
  return Object.freeze(value);
}

function normalizeZero(n) {
  return n === 0 ? 0 : n;
}

function finiteOr(val, fallback) {
  return typeof val === 'number' && Number.isFinite(val) ? normalizeZero(val) : fallback;
}

function parseNumericInput(val) {
  if (typeof val === 'number') {
    return val;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.length === 0) {
      return Number.NaN;
    }
    return Number(trimmed);
  }
  return Number.NaN;
}

/** 120Hz fixed physics timestep (seconds). */
export const FIXED_DT = 1 / 120;

/** Maximum exact fixed-dt lookahead steps for predictLandingPoint3D (1.50s). */
export const MAX_PREDICT_STEPS = 180;

/** Canonical right-handed Three.js SI coordinate system convention. */
export const COORDINATE_SYSTEM = deepFreeze({
  handedness: 'right',
  up: '+Y',
  team1Side: '-X',
  team2Side: '+X',
  nearSideline: '+Z',
  oceanHorizon: '-Z',
});

/** Court, net, and spin-reactive outer arcade arena dimensions (meters). */
export const COURT = deepFreeze({
  LENGTH: 16,
  HALF_LENGTH: 8,
  WIDTH: 8,
  HALF_WIDTH: 4,
  ARENA_HALF_X: 11.5,
  ARENA_HALF_Z: 6.5,
  CEILING_Y: 14.0,
  NET_X: 0,
  NET_HEIGHT: 2.38,
  NET_TAPE_RADIUS: 0.08,
  NET_HALF_Z: 4.5,
  NET_POST_RADIUS: 0.09,
  SAND_Y: 0,
});

/** Beach-volleyball physical constants (SI units). */
export const BALL_SPEC = deepFreeze({
  RADIUS: 0.22,
  MAX_OMEGA: 24.0,
  SPIN_DECAY_PER_STEP: 0.9965,
});

/** Default Heavy Gale 3D aerodynamic & restitution parameters (SI units). */
export const PHYSICS_DEFAULTS = deepFreeze({
  gravity: 11.2,
  kDrag: 0.032,
  kMagnus: 0.028,
  eWall: 0.78,
  eNetTape: 0.72,
  eNetMesh: 0.35,
  kWallSpin: 0.14,
  gustScale: 1.0,
  gameSpeed: 1.0,
});

/** Physics Lab slider ranges and step sizes: [min, max, step]. */
export const PHYSICS_LIMITS = deepFreeze({
  gravity: [6, 18, 0.2],
  kDrag: [0, 0.08, 0.002],
  kMagnus: [0, 0.07, 0.002],
  gustScale: [0, 2.0, 0.05],
  gameSpeed: [0.5, 1.6, 0.05],
});

/** Isolated v2 localStorage keys (never colliding with v1 Classic 2D storage). */
export const STORAGE_KEYS = deepFreeze({
  PHYSICS: 'summer_heat_3d_physics_v2',
  BINDINGS: 'summer_heat_3d_bindings_v2',
  SETTINGS: 'summer_heat_3d_settings_v2',
});

/** HUD-selectable input modes. */
export const INPUT_MODES = deepFreeze({
  ONE_PAD_SPLIT: '1PAD',
  TWO_PAD_KEYBOARD: '2PAD',
  TOUCH_AUTO: 'TOUCH',
});

/** Camera rendering modes. */
export const CAMERA_MODES = deepFreeze({
  BROADCAST: 'BROADCAST',
  SPLIT_SCREEN: 'SPLIT',
});

/** Solo AI opponent FSM styles. */
export const AI_STYLES = deepFreeze({
  WIND_LOBBER: 'WIND_LOBBER',
  NET_BLOCKER: 'NET_BLOCKER',
  SPIN_SLICER: 'SPIN_SLICER',
});

/** Match player formats. */
export const MATCH_FORMATS = deepFreeze({
  ONE_V_ONE: '1v1',
  TWO_V_TWO: '2v2',
});

/** Exact 7 articulated 3D athlete rig animation states. */
export const ANIM_STATES = deepFreeze({
  IDLE: 'Idle',
  SPRINT: 'Sprint',
  UNDERHAND_BUMP: 'UnderhandBump',
  OVERHEAD_SET: 'OverheadSet',
  JUMP_HEAT_SPIKE: 'JumpHeatSpike',
  NET_BLOCK: 'NetBlock',
  SAND_DIVE: 'SandDive',
});

/** Heavy Gale 3D wind state-machine phases. */
export const WIND_PHASES = deepFreeze({
  BREEZE: 'BREEZE',
  WARNING: 'WARNING',
  GUST: 'GUST',
});

/** 3D ball spin ribbon visual modes. */
export const TRAIL_MODES = deepFreeze({
  NEUTRAL: 'NEUTRAL',
  FLAME: 'FLAME',
  CYAN: 'CYAN',
  LOB: 'LOB',
});

/** Discrete volleyball shot taxonomy. */
export const SHOT_TYPES = deepFreeze({
  SERVE: 'SERVE',
  BUMP: 'BUMP',
  DIVE_SAVE: 'DIVE_SAVE',
  SET: 'SET',
  SPIKE: 'SPIKE',
  HEAT_SPIKE: 'HEAT_SPIKE',
  POKEY_CUT: 'POKEY_CUT',
  BLOCK_STUFF: 'BLOCK_STUFF',
  LOB: 'LOB',
});

/** Standardized gameplay/physics event types for visuals & audio. */
export const EVENTS = deepFreeze({
  SERVE: 'SERVE',
  BUMP: 'BUMP',
  DIVE: 'DIVE',
  SET: 'SET',
  SPIKE: 'SPIKE',
  HEAT_SPIKE: 'HEAT_SPIKE',
  POKEY_CUT: 'POKEY_CUT',
  NET_BLOCK: 'NET_BLOCK',
  STUFF_BLOCK: 'STUFF_BLOCK',
  WALL_BOUNCE: 'WALL_BOUNCE',
  NET_TAPE_HIT: 'NET_TAPE_HIT',
  NET_MESH_HIT: 'NET_MESH_HIT',
  SAND_IMPACT: 'SAND_IMPACT',
  POINT_SCORED: 'POINT_SCORED',
  GUST_WARNING: 'GUST_WARNING',
  GUST_START: 'GUST_START',
  CHARGE_TICK: 'CHARGE_TICK',
});

/**
 * Finite-safe numeric clamping.
 * Non-finite or non-number `val` falls back to `fallback` (or `min` if `fallback` is non-finite),
 * then clamps to `[min, max]`.
 */
export function clamp(val, min, max, fallback = min) {
  const safeMin = typeof min === 'number' && Number.isFinite(min) ? min : 0;
  const safeMax = typeof max === 'number' && Number.isFinite(max) ? max : safeMin;
  const lo = safeMin <= safeMax ? safeMin : safeMax;
  const hi = safeMin <= safeMax ? safeMax : safeMin;

  let candidate;
  if (typeof val === 'number' && Number.isFinite(val)) {
    candidate = val;
  } else if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    candidate = fallback;
  } else {
    candidate = lo;
  }

  if (candidate < lo) return normalizeZero(lo);
  if (candidate > hi) return normalizeZero(hi);
  return normalizeZero(candidate);
}

/**
 * Create a fresh mutable plain 3D vector with finite numeric guards.
 */
export function createVec3(x = 0, y = 0, z = 0) {
  return {
    x: finiteOr(x, 0),
    y: finiteOr(y, 0),
    z: finiteOr(z, 0),
  };
}

function cloneVec3(source, fallbackX = 0, fallbackY = 0, fallbackZ = 0) {
  if (source !== null && typeof source === 'object') {
    return createVec3(
      finiteOr(source.x, fallbackX),
      finiteOr(source.y, fallbackY),
      finiteOr(source.z, fallbackZ),
    );
  }
  return createVec3(fallbackX, fallbackY, fallbackZ);
}

/**
 * Compute right-handed 3D angular velocity `omega` (rad/s) for a ball traveling
 * horizontally along `(dirX, 0, dirZ)` with requested `topspinRadS` and `sidespinRadS`.
 *
 * Convention:
 * - Magnus acceleration is `a_magnus = kMagnus * (omega × vRel)`.
 * - Topspin axis = `up × dirXZ = (0, 1, 0) × (nx, 0, nz) = (nz, 0, -nx)`.
 * - `topspinRadS > 0` dives downward (`-Y`); `topspinRadS < 0` (backspin) lifts upward (`+Y`).
 * - `sidespinRadS != 0` sets `omega.y` for lateral curve.
 * - Spin-reactive wall kick `kWallSpin * (inwardNormal × omega)` dives downward for topspin
 *   and pops upward for backspin on both left and right stadium walls.
 * - Magnitude is proportionally capped to `BALL_SPEC.MAX_OMEGA`.
 */
export function computeSpinOmega(dirX, dirZ, topspinRadS = 0, sidespinRadS = 0) {
  const dx = finiteOr(dirX, 0);
  const dz = finiteOr(dirZ, 0);
  const top = finiteOr(topspinRadS, 0);
  const side = finiteOr(sidespinRadS, 0);

  const horizLen = Math.hypot(dx, dz);
  if (horizLen < 1e-8) {
    return createVec3(0, clamp(side, -BALL_SPEC.MAX_OMEGA, BALL_SPEC.MAX_OMEGA, 0), 0);
  }

  const nx = dx / horizLen;
  const nz = dz / horizLen;

  let ox = nz * top;
  let oy = side;
  let oz = -nx * top;

  const mag = Math.hypot(ox, oy, oz);
  if (mag > BALL_SPEC.MAX_OMEGA && mag > 0) {
    const scale = BALL_SPEC.MAX_OMEGA / mag;
    ox *= scale;
    oy *= scale;
    oz *= scale;
  }

  return createVec3(ox, oy, oz);
}

/**
 * Create a fresh mutable BallState with deep-copied Vec3 overrides.
 */
export function createBallState(overrides = {}) {
  const o = overrides !== null && typeof overrides === 'object' ? overrides : {};
  const radius = finiteOr(o.radius, BALL_SPEC.RADIUS);
  return {
    pos: cloneVec3(o.pos, 0, 0, 0),
    vel: cloneVec3(o.vel, 0, 0, 0),
    omega: cloneVec3(o.omega, 0, 0, 0),
    radius: radius > 0 ? radius : BALL_SPEC.RADIUS,
    trailMode: typeof o.trailMode === 'string' ? o.trailMode : TRAIL_MODES.NEUTRAL,
    shotType: typeof o.shotType === 'string' ? o.shotType : SHOT_TYPES.SERVE,
    lastHitTeam: o.lastHitTeam === 2 ? 2 : 1,
    spinAngle: cloneVec3(o.spinAngle, 0, 0, 0),
    active: typeof o.active === 'boolean' ? o.active : true,
  };
}

/**
 * Create a fresh mutable WindState with deep-copied Vec3 overrides.
 */
export function createWindState(overrides = {}) {
  const o = overrides !== null && typeof overrides === 'object' ? overrides : {};
  return {
    time: finiteOr(o.time, 0),
    phase: typeof o.phase === 'string' ? o.phase : WIND_PHASES.BREEZE,
    timer: finiteOr(o.timer, 6.0),
    windVec3: cloneVec3(o.windVec3, 0, 0, 0),
    gustTargetVec3: cloneVec3(o.gustTargetVec3, 0, 0, 0),
    speed: finiteOr(o.speed, 0),
  };
}

/**
 * Create a fresh mutable PlayerState with deep-copied Vec3 overrides.
 */
export function createPlayerState(overrides = {}) {
  const o = overrides !== null && typeof overrides === 'object' ? overrides : {};
  return {
    id: typeof o.id === 'string' ? o.id : 'p1',
    team: o.team === 2 ? 2 : 1,
    role: o.role === 'PARTNER' ? 'PARTNER' : 'PRIMARY',
    isHuman: typeof o.isHuman === 'boolean' ? o.isHuman : true,
    pos: cloneVec3(o.pos, -4, 0, 0),
    vel: cloneVec3(o.vel, 0, 0, 0),
    facingYaw: finiteOr(o.facingYaw, Math.PI / 2),
    animState: typeof o.animState === 'string' ? o.animState : ANIM_STATES.IDLE,
    animTime: finiteOr(o.animTime, 0),
    animProgress: finiteOr(o.animProgress, 0),
    chargeRatio: clamp(o.chargeRatio, 0, 1, 0),
    heatMeter: clamp(o.heatMeter, 0, 1, 0),
    isAirborne: typeof o.isAirborne === 'boolean' ? o.isAirborne : false,
    diveTimer: finiteOr(o.diveTimer, 0),
    blockTimer: finiteOr(o.blockTimer, 0),
    strikeCooldown: finiteOr(o.strikeCooldown, 0),
    targetBallPos:
      o.targetBallPos !== null && typeof o.targetBallPos === 'object'
        ? cloneVec3(o.targetBallPos, 0, 0, 0)
        : null,
  };
}

/**
 * Create a fresh mutable input bindings configuration preserving exact harvested
 * v1 Stadia 1-PAD SPLIT, 2-PAD, and Keyboard defaults plus secondary action slots.
 */
export function createDefaultBindings() {
  return {
    deadzone: 0.16,
    onePadSplit: {
      p1: {
        padIndex: 0,
        axisX: 0,
        axisY: 1,
        dpadLeft: 14,
        dpadRight: 15,
        dpadUp: 12,
        dpadDown: 13,
        primaryButtons: [4, 6],
        secondaryButtons: [10, 8],
      },
      p2: {
        padIndex: 0,
        axisX: 2,
        axisY: 3,
        primaryButtons: [5, 7, 0],
        secondaryButtons: [1, 2, 3],
      },
    },
    twoPad: {
      p1: {
        padIndex: 0,
        axisX: 0,
        axisY: 1,
        dpadLeft: 14,
        dpadRight: 15,
        dpadUp: 12,
        dpadDown: 13,
        primaryButtons: [0, 4, 5, 6, 7],
        secondaryButtons: [1, 2, 3],
      },
      p2: {
        padIndex: 1,
        axisX: 0,
        axisY: 1,
        dpadLeft: 14,
        dpadRight: 15,
        dpadUp: 12,
        dpadDown: 13,
        primaryButtons: [0, 4, 5, 6, 7],
        secondaryButtons: [1, 2, 3],
      },
    },
    keyboard: {
      p1: {
        left: 'KeyA',
        right: 'KeyD',
        up: 'KeyW',
        down: 'KeyS',
        primary: ['Space'],
        secondary: ['ShiftLeft', 'KeyE'],
      },
      p2: {
        left: 'ArrowLeft',
        right: 'ArrowRight',
        up: 'ArrowUp',
        down: 'ArrowDown',
        primary: ['Enter', 'NumpadEnter'],
        secondary: ['ShiftRight', 'Slash'],
      },
    },
    quickBindSlots: {
      p1Primary: null,
      p1Secondary: null,
      p2Primary: null,
      p2Secondary: null,
    },
  };
}

/**
 * Validate and sanitize any raw PhysicsConfig (e.g., from localStorage or UI sliders).
 * Always returns a fresh complete mutable object with finite clamped values.
 */
export function sanitizePhysicsConfig(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  return {
    gravity: clamp(
      parseNumericInput(src.gravity),
      PHYSICS_LIMITS.gravity[0],
      PHYSICS_LIMITS.gravity[1],
      PHYSICS_DEFAULTS.gravity,
    ),
    kDrag: clamp(
      parseNumericInput(src.kDrag),
      PHYSICS_LIMITS.kDrag[0],
      PHYSICS_LIMITS.kDrag[1],
      PHYSICS_DEFAULTS.kDrag,
    ),
    kMagnus: clamp(
      parseNumericInput(src.kMagnus),
      PHYSICS_LIMITS.kMagnus[0],
      PHYSICS_LIMITS.kMagnus[1],
      PHYSICS_DEFAULTS.kMagnus,
    ),
    eWall: clamp(parseNumericInput(src.eWall), 0, 1, PHYSICS_DEFAULTS.eWall),
    eNetTape: clamp(parseNumericInput(src.eNetTape), 0, 1, PHYSICS_DEFAULTS.eNetTape),
    eNetMesh: clamp(parseNumericInput(src.eNetMesh), 0, 1, PHYSICS_DEFAULTS.eNetMesh),
    kWallSpin: clamp(parseNumericInput(src.kWallSpin), 0, 0.5, PHYSICS_DEFAULTS.kWallSpin),
    gustScale: clamp(
      parseNumericInput(src.gustScale),
      PHYSICS_LIMITS.gustScale[0],
      PHYSICS_LIMITS.gustScale[1],
      PHYSICS_DEFAULTS.gustScale,
    ),
    gameSpeed: clamp(
      parseNumericInput(src.gameSpeed),
      PHYSICS_LIMITS.gameSpeed[0],
      PHYSICS_LIMITS.gameSpeed[1],
      PHYSICS_DEFAULTS.gameSpeed,
    ),
  };
}
