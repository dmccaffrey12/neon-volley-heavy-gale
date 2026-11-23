/**
 * SUMMER HEAT 3D — 120Hz Deterministic 3D Beach-Volleyball Physics Engine
 *
 * Pure ES2022+ module importing ONLY ./contracts.js (zero DOM, zero Three.js, pure deterministic math).
 * Implements:
 * - Heavy Gale 3D oscillating crosswinds & 4-second surges (BREEZE -> WARNING -> GUST -> BREEZE)
 * - 120Hz Semi-Implicit Euler integration with quadratic air drag & 3D Magnus curve
 * - Spin-reactive outer stadium arcade walls & ceiling (balls stay live until sand impact)
 * - Swept anti-tunneling net collisions (rounded cylinder tape, mesh plane, two cylindrical posts)
 * - Pure, non-mutating 180-step lookahead landing predictor with analytic quadratic Sky Lob tail
 */

import {
  FIXED_DT,
  MAX_PREDICT_STEPS,
  COURT,
  BALL_SPEC,
  PHYSICS_DEFAULTS,
  WIND_PHASES,
  clamp,
  sanitizePhysicsConfig,
} from './contracts.js';

export { FIXED_DT } from './contracts.js';

const EPS = 1e-8;
const SEP_EPS = 1e-4;
const MAX_BALL_RADIUS = 2.0;
const NET_MESH_HALF_THICK = 0.03;
const WALL_OMEGA_DAMP = 0.88;
const NET_TAPE_OMEGA_DAMP = 0.9;
const NET_MESH_OMEGA_DAMP = 0.75;
const MAX_PREDICT_CLAMP = 600;

function sanitizeRadius(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(raw, MAX_BALL_RADIUS)
    : BALL_SPEC.RADIUS;
}

function normalizeZero(n) {
  return n === 0 ? 0 : n;
}

function finiteOr(val, fallback) {
  return typeof val === 'number' && Number.isFinite(val) ? normalizeZero(val) : fallback;
}

function sanitizeVec3InPlace(vec, fx = 0, fy = 0, fz = 0) {
  vec.x = finiteOr(vec.x, fx);
  vec.y = finiteOr(vec.y, fy);
  vec.z = finiteOr(vec.z, fz);
  return vec;
}

function ensureVec3(obj, key, fx = 0, fy = 0, fz = 0) {
  const existing = obj[key];
  if (existing !== null && typeof existing === 'object') {
    return sanitizeVec3InPlace(existing, fx, fy, fz);
  }
  const fresh = { x: fx, y: fy, z: fz };
  obj[key] = fresh;
  return fresh;
}

function resolvePhysicsConfig(physicsConfig) {
  if (physicsConfig === PHYSICS_DEFAULTS || physicsConfig === undefined) {
    return PHYSICS_DEFAULTS;
  }
  return sanitizePhysicsConfig(physicsConfig);
}

/**
 * Deterministic pseudo-random unit scalar in [0, 1] derived purely from state values.
 */
function deterministicUnit(seed) {
  const safeSeed = finiteOr(seed, 0);
  const raw = Math.sin(safeSeed * 12.9898 + 78.233) * 43758.5453;
  const frac = raw - Math.floor(raw);
  return Number.isFinite(frac) ? clamp(frac, 0, 1, 0.5) : 0.5;
}

/**
 * Populate a deterministic elevated 3D gust target vector into `windState.gustTargetVec3`.
 * Magnitude bounds: |x| in [5.0, 6.8], |z| in [1.2, 2.6], y in [-0.3, 0.4] (m/s).
 */
function assignDeterministicGustTarget(windState, dirSignX) {
  const t = finiteOr(windState.time, 0);
  const target = ensureVec3(windState, 'gustTargetVec3', 0, 0, 0);
  const prevX = target.x;
  const prevZ = target.z;

  let signX;
  if (typeof dirSignX === 'number' && Number.isFinite(dirSignX) && dirSignX !== 0) {
    signX = dirSignX > 0 ? 1 : -1;
  } else if (prevX > 0) {
    signX = -1;
  } else if (prevX < 0) {
    signX = 1;
  } else {
    signX = Math.sin(t * 3.17 + 0.5) >= 0 ? 1 : -1;
  }

  const baseSeed = t * 1.91 + prevX * 0.37 + prevZ * 0.53;
  const u1 = deterministicUnit(baseSeed + 1.13);
  const u2 = deterministicUnit(baseSeed + 3.71);
  const u3 = deterministicUnit(baseSeed + 7.29);
  const uSignZ = deterministicUnit(baseSeed + 11.47);
  const signZ = uSignZ >= 0.5 ? 1 : -1;

  target.x = normalizeZero(signX * (5.0 + 1.8 * u1));
  target.y = normalizeZero(-0.3 + 0.7 * u3);
  target.z = normalizeZero(signZ * (1.2 + 1.4 * u2));
  return target;
}

/**
 * Immediately enter a 1.0s Heavy Gale WARNING phase with a deterministic 3D surge vector.
 */
export function triggerGaleSurge(windState, dirSignX = null) {
  if (windState === null || typeof windState !== 'object') {
    return windState;
  }
  windState.time = finiteOr(windState.time, 0);
  ensureVec3(windState, 'windVec3', 0, 0, 0);
  assignDeterministicGustTarget(windState, dirSignX);
  windState.phase = WIND_PHASES.WARNING;
  windState.timer = 1.0;
  const fallbackSpeed = finiteOr(
    Math.hypot(windState.windVec3.x, windState.windVec3.y, windState.windVec3.z),
    0,
  );
  windState.speed =
    typeof windState.speed === 'number' && Number.isFinite(windState.speed) && windState.speed >= 0
      ? normalizeZero(windState.speed)
      : fallbackSpeed;
  return windState;
}

/**
 * Advance the Heavy Gale 3D wind state machine:
 * BREEZE (8.0–12.0s) -> WARNING (1.0s) -> GUST (4.0s) -> BREEZE (8.0–12.0s).
 */
export function updateWind3D(windState, dt, physicsConfig = PHYSICS_DEFAULTS) {
  if (windState === null || typeof windState !== 'object') {
    return {
      phaseChanged: false,
      phase: WIND_PHASES.BREEZE,
      windVec3: { x: 0, y: 0, z: 0 },
    };
  }

  const cfg = resolvePhysicsConfig(physicsConfig);
  const gustScale = cfg.gustScale;
  const safeDt = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? dt : 0;

  windState.time = finiteOr(windState.time, 0);
  windState.timer = finiteOr(windState.timer, 6.0);
  const windVec3 = ensureVec3(windState, 'windVec3', 0, 0, 0);
  const gustTarget = ensureVec3(windState, 'gustTargetVec3', 0, 0, 0);

  const validPhase =
    windState.phase === WIND_PHASES.BREEZE ||
    windState.phase === WIND_PHASES.WARNING ||
    windState.phase === WIND_PHASES.GUST;
  if (!validPhase) {
    windState.phase = WIND_PHASES.BREEZE;
    windState.timer = 8.0;
  }

  const prevPhase = windState.phase;

  if (safeDt > 0) {
    const nextTime = windState.time + safeDt;
    windState.time = Number.isFinite(nextTime) ? normalizeZero(nextTime) : 0;
    const nextTimer = windState.timer - safeDt;
    windState.timer = Number.isFinite(nextTimer) ? normalizeZero(nextTimer) : 0;

    if (windState.timer <= 0) {
      if (windState.phase === WIND_PHASES.BREEZE) {
        triggerGaleSurge(windState, null);
      } else if (windState.phase === WIND_PHASES.WARNING) {
        if (Math.hypot(gustTarget.x, gustTarget.y, gustTarget.z) < EPS) {
          assignDeterministicGustTarget(windState, null);
        }
        windState.phase = WIND_PHASES.GUST;
        windState.timer = 4.0;
      } else {
        const uDur = deterministicUnit(windState.time * 0.89 + gustTarget.x * 0.41 + 5.7);
        windState.phase = WIND_PHASES.BREEZE;
        windState.timer = 8.0 + 4.0 * uDur;
      }
    }
  }

  const phaseChanged = windState.phase !== prevPhase;

  if (gustScale <= 0) {
    windVec3.x = 0;
    windVec3.y = 0;
    windVec3.z = 0;
    windState.speed = 0;
  } else {
    const t = windState.time;
    const baseX = 1.6 * Math.sin(t * 0.65) + 0.55 * Math.cos(t * 1.45);
    const baseY = 0.14 * Math.sin(t * 0.95);
    const baseZ = 0.85 * Math.cos(t * 0.52) + 0.35 * Math.sin(t * 1.25);

    let tx;
    let ty;
    let tz;
    if (windState.phase === WIND_PHASES.GUST) {
      tx = gustTarget.x * gustScale;
      ty = gustTarget.y * gustScale;
      tz = gustTarget.z * gustScale;
    } else {
      tx = baseX * gustScale;
      ty = baseY * gustScale;
      tz = baseZ * gustScale;
    }

    if (safeDt > 0) {
      const rate = windState.phase === WIND_PHASES.GUST ? 6.5 : 3.2;
      const alpha = 1 - Math.exp(-rate * safeDt);
      windVec3.x = normalizeZero(windVec3.x + (tx - windVec3.x) * alpha);
      windVec3.y = normalizeZero(windVec3.y + (ty - windVec3.y) * alpha);
      windVec3.z = normalizeZero(windVec3.z + (tz - windVec3.z) * alpha);
    }

    sanitizeVec3InPlace(windVec3, 0, 0, 0);
    windState.speed = finiteOr(Math.hypot(windVec3.x, windVec3.y, windVec3.z), 0);
  }

  return {
    phaseChanged,
    phase: windState.phase,
    windVec3,
  };
}

/**
 * Earliest intersection parameter t in [0, 1] of 2D segment (x0,y0)->(x1,y1) with circle (cx,cy,radius).
 * Returns -1 if moving cleanly outward/separating from the boundary or if no intersection occurs in [0, 1].
 * Returns 0 only when already inside and moving inward or remaining deeply embedded.
 */
function intersectSegmentCircle2D(x0, y0, x1, y1, cx, cy, radius) {
  const ox = x0 - cx;
  const oy = y0 - cy;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const r2 = radius * radius;
  const c = ox * ox + oy * oy - r2;
  const dotOD = ox * dx + oy * dy;
  if (c <= 0) {
    const ex = x1 - cx;
    const ey = y1 - cy;
    const c1 = ex * ex + ey * ey - r2;
    if (dotOD >= 0 && (c1 >= 0 || c >= -1e-6)) {
      return -1;
    }
    return 0;
  }
  const a = dx * dx + dy * dy;
  if (a < EPS * EPS || !Number.isFinite(a)) {
    return -1;
  }
  const b = 2 * dotOD;
  if (b >= 0 || !Number.isFinite(b)) {
    return -1;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0 || !Number.isFinite(disc)) {
    return -1;
  }
  const denom = -b + Math.sqrt(disc);
  const t = denom > EPS ? (2 * c) / denom : (-b - Math.sqrt(disc)) / (2 * a);
  if (t >= 0 && t <= 1) {
    return t;
  }
  return -1;
}

/**
 * Earliest intersection parameter t in [0, 1] of 3D segment P0->P1 with sphere (cx,cy,cz,radius).
 * Returns -1 if moving cleanly outward/separating from the boundary or if no intersection occurs in [0, 1].
 * Returns 0 only when already inside and moving inward or remaining deeply embedded.
 */
function intersectSegmentSphere3D(x0, y0, z0, x1, y1, z1, cx, cy, cz, radius) {
  const ox = x0 - cx;
  const oy = y0 - cy;
  const oz = z0 - cz;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const r2 = radius * radius;
  const c = ox * ox + oy * oy + oz * oz - r2;
  const dotOD = ox * dx + oy * dy + oz * dz;
  if (c <= 0) {
    const ex = x1 - cx;
    const ey = y1 - cy;
    const ez = z1 - cz;
    const c1 = ex * ex + ey * ey + ez * ez - r2;
    if (dotOD >= 0 && (c1 >= 0 || c >= -1e-6)) {
      return -1;
    }
    return 0;
  }
  const a = dx * dx + dy * dy + dz * dz;
  if (a < EPS * EPS || !Number.isFinite(a)) {
    return -1;
  }
  const b = 2 * dotOD;
  if (b >= 0 || !Number.isFinite(b)) {
    return -1;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0 || !Number.isFinite(disc)) {
    return -1;
  }
  const denom = -b + Math.sqrt(disc);
  const t = denom > EPS ? (2 * c) / denom : (-b - Math.sqrt(disc)) / (2 * a);
  if (t >= 0 && t <= 1) {
    return t;
  }
  return -1;
}

/**
 * Resolve outer stadium arcade walls & ceiling with spin-reactive velocity kick.
 * Balls stay live (never triggers `landed`).
 */
function resolveArenaWalls(pos, vel, omega, r, cfg) {
  const minX = -COURT.ARENA_HALF_X + r;
  const maxX = COURT.ARENA_HALF_X - r;
  const minZ = -COURT.ARENA_HALF_Z + r;
  const maxZ = COURT.ARENA_HALF_Z - r;
  const maxY = COURT.CEILING_Y - r;

  let wallHit = null;

  function handleWall(wall, nx, ny, nz, contactX, contactY, contactZ) {
    const vn = vel.x * nx + vel.y * ny + vel.z * nz;

    if (vn < 0) {
      const impactSpeed = Math.max(0, finiteOr(-vn, 0));
      const impulse = -(1 + cfg.eWall) * vn;
      vel.x += impulse * nx;
      vel.y += impulse * ny;
      vel.z += impulse * nz;

      // Spin-reactive wall kick: v_kick = kWallSpin * (inwardNormal x omega)
      const kx = cfg.kWallSpin * (ny * omega.z - nz * omega.y);
      const ky = cfg.kWallSpin * (nz * omega.x - nx * omega.z);
      const kz = cfg.kWallSpin * (nx * omega.y - ny * omega.x);
      vel.x += kx;
      vel.y += ky;
      vel.z += kz;

      omega.x *= WALL_OMEGA_DAMP;
      omega.y *= WALL_OMEGA_DAMP;
      omega.z *= WALL_OMEGA_DAMP;

      if (wallHit === null || impactSpeed > wallHit.impactSpeed) {
        wallHit = {
          wall,
          normal: { x: nx, y: ny, z: nz },
          point: {
            x: finiteOr(contactX, 0),
            y: finiteOr(contactY, 0),
            z: finiteOr(contactZ, 0),
          },
          impactSpeed,
        };
      }
    }
  }

  if (pos.x < minX) {
    pos.x = minX;
    handleWall('LEFT', 1, 0, 0, -COURT.ARENA_HALF_X, pos.y, pos.z);
  } else if (pos.x > maxX) {
    pos.x = maxX;
    handleWall('RIGHT', -1, 0, 0, COURT.ARENA_HALF_X, pos.y, pos.z);
  }

  if (pos.z < minZ) {
    pos.z = minZ;
    handleWall('FAR', 0, 0, 1, pos.x, pos.y, -COURT.ARENA_HALF_Z);
  } else if (pos.z > maxZ) {
    pos.z = maxZ;
    handleWall('NEAR', 0, 0, -1, pos.x, pos.y, COURT.ARENA_HALF_Z);
  }

  if (pos.y > maxY) {
    pos.y = maxY;
    handleWall('CEILING', 0, -1, 0, pos.x, COURT.CEILING_Y, pos.z);
  }

  return wallHit;
}

/**
 * Resolve swept net collisions (rounded cylinder tape, mesh plane, and two vertical posts).
 * Picks the earliest time of impact along prevPos -> pos so high-speed spikes never tunnel.
 */
function resolveNetCollision(pos, vel, omega, prevX, prevY, prevZ, r, cfg, dt) {
  const tapeR = r + COURT.NET_TAPE_RADIUS;
  const postR = r + COURT.NET_POST_RADIUS;
  const meshHalfX = r + NET_MESH_HALF_THICK;
  const maxReachX = Math.max(tapeR, postR, meshHalfX);

  // Fast broad-phase reject when entire swept segment stays well clear of x = NET_X
  if (
    (prevX < COURT.NET_X - maxReachX && pos.x < COURT.NET_X - maxReachX) ||
    (prevX > COURT.NET_X + maxReachX && pos.x > COURT.NET_X + maxReachX)
  ) {
    return null;
  }

  const dx = pos.x - prevX;
  const dy = pos.y - prevY;
  const dz = pos.z - prevZ;

  // Priority on equal TOI: TAPE (0) < POST (1) < MESH (2)
  let bestT = Infinity;
  let bestPriority = 99;
  let bestKind = null;
  let bestHitX = 0;
  let bestHitY = 0;
  let bestHitZ = 0;
  let bestAux = 0; // postZ for POST, sideSign for MESH

  function considerCandidate(t, priority, kind, hx, hy, hz, aux) {
    if (t < bestT - EPS || (Math.abs(t - bestT) <= EPS && priority < bestPriority)) {
      bestT = t;
      bestPriority = priority;
      bestKind = kind;
      bestHitX = hx;
      bestHitY = hy;
      bestHitZ = hz;
      bestAux = aux;
    }
  }

  // 1. Rounded horizontal cylinder net tape: x = 0, y = NET_HEIGHT, z in [-NET_HALF_Z, +NET_HALF_Z]
  const tTape = intersectSegmentCircle2D(
    prevX,
    prevY,
    pos.x,
    pos.y,
    COURT.NET_X,
    COURT.NET_HEIGHT,
    tapeR,
  );
  if (tTape >= 0) {
    const hx = prevX + dx * tTape;
    const hy = prevY + dy * tTape;
    const hz = prevZ + dz * tTape;
    if (Math.abs(hz) <= COURT.NET_HALF_Z) {
      considerCandidate(tTape, 0, 'TAPE', hx, hy, hz, 0);
    }
  }

  // 2. Two vertical cylindrical net posts (with spherical top caps): x = 0, z = +-NET_HALF_Z, y in [0, NET_HEIGHT]
  for (let p = 0; p < 2; p++) {
    const postZ = p === 0 ? -COURT.NET_HALF_Z : COURT.NET_HALF_Z;
    const tPost = intersectSegmentCircle2D(
      prevX,
      prevZ,
      pos.x,
      pos.z,
      COURT.NET_X,
      postZ,
      postR,
    );
    if (tPost >= 0) {
      const hx = prevX + dx * tPost;
      const hy = prevY + dy * tPost;
      const hz = prevZ + dz * tPost;
      if (hy >= COURT.SAND_Y - postR && hy <= COURT.NET_HEIGHT) {
        considerCandidate(tPost, 1, 'POST', hx, hy, hz, postZ);
      }
    }
    const tTop = intersectSegmentSphere3D(
      prevX,
      prevY,
      prevZ,
      pos.x,
      pos.y,
      pos.z,
      COURT.NET_X,
      COURT.NET_HEIGHT,
      postZ,
      postR,
    );
    if (tTop >= 0) {
      considerCandidate(
        tTop,
        1,
        'POST',
        prevX + dx * tTop,
        prevY + dy * tTop,
        prevZ + dz * tTop,
        postZ,
      );
    }
  }

  // 3. Net mesh plane: x = 0, y in [0, NET_HEIGHT), z in [-NET_HALF_Z, +NET_HALF_Z]
  let tMesh = -1;
  let meshSideSign = 0;
  if (prevX <= COURT.NET_X - meshHalfX && pos.x > COURT.NET_X - meshHalfX && dx > EPS) {
    tMesh = (COURT.NET_X - meshHalfX - prevX) / dx;
    meshSideSign = -1;
  } else if (prevX >= COURT.NET_X + meshHalfX && pos.x < COURT.NET_X + meshHalfX && dx < -EPS) {
    tMesh = (COURT.NET_X + meshHalfX - prevX) / dx;
    meshSideSign = 1;
  } else if (Math.abs(prevX - COURT.NET_X) < meshHalfX) {
    // Started inside mesh thickness slab; intercept if crossing x=0 or moving toward mesh center
    meshSideSign =
      Math.abs(prevX - COURT.NET_X) > EPS
        ? prevX < COURT.NET_X
          ? -1
          : 1
        : vel.x >= 0
          ? -1
          : 1;
    const crossedPlane =
      (prevX < COURT.NET_X && pos.x > COURT.NET_X) ||
      (prevX > COURT.NET_X && pos.x < COURT.NET_X);
    if (crossedPlane || vel.x * meshSideSign < 0 || Math.abs(pos.x - COURT.NET_X) < meshHalfX) {
      tMesh = 0;
    }
  }

  if (tMesh >= 0 && tMesh <= 1) {
    // For an embedded fast ball crossing x = 0, inspect y/z at the plane crossing if applicable
    let sampleT = tMesh;
    if (
      tMesh === 0 &&
      Math.abs(dx) > EPS &&
      ((prevX < COURT.NET_X && pos.x > COURT.NET_X) ||
        (prevX > COURT.NET_X && pos.x < COURT.NET_X))
    ) {
      sampleT = clamp((COURT.NET_X - prevX) / dx, 0, 1, 0);
    }
    const hy = prevY + dy * sampleT;
    const hz = prevZ + dz * sampleT;
    if (hy < COURT.NET_HEIGHT && Math.abs(hz) <= COURT.NET_HALF_Z) {
      considerCandidate(tMesh, 2, 'MESH', COURT.NET_X + meshSideSign * meshHalfX, hy, hz, meshSideSign);
    }
  }

  if (bestKind === null) {
    return null;
  }

  if (bestKind === 'TAPE') {
    const cz = clamp(bestHitZ, -COURT.NET_HALF_Z, COURT.NET_HALF_Z, 0);
    let nx = bestHitX - COURT.NET_X;
    let ny = bestHitY - COURT.NET_HEIGHT;
    let nz = bestHitZ - cz;
    const len = Math.hypot(nx, ny, nz);
    if (len < EPS || !Number.isFinite(len)) {
      nx = Math.abs(prevX - COURT.NET_X) > EPS ? (prevX < COURT.NET_X ? -1 : 1) : vel.x >= 0 ? -1 : 1;
      ny = 0;
      nz = 0;
    } else {
      nx /= len;
      ny /= len;
      nz /= len;
    }

    const sepR = tapeR + SEP_EPS;
    const vn = vel.x * nx + vel.y * ny + vel.z * nz;
    if (vn < 0) {
      const impactSpeed = Math.max(0, finiteOr(-vn, 0));
      const impulse = -(1 + cfg.eNetTape) * vn;
      vel.x += impulse * nx;
      vel.y += impulse * ny;
      vel.z += impulse * nz;

      // Subtle tangential spin roll off rounded tape
      const roll = 0.5 * cfg.kWallSpin;
      vel.x += roll * (ny * omega.z - nz * omega.y);
      vel.y += roll * (nz * omega.x - nx * omega.z);
      vel.z += roll * (nx * omega.y - ny * omega.x);

      omega.x *= NET_TAPE_OMEGA_DAMP;
      omega.y *= NET_TAPE_OMEGA_DAMP;
      omega.z *= NET_TAPE_OMEGA_DAMP;

      const cx = COURT.NET_X + nx * sepR;
      const cy = COURT.NET_HEIGHT + ny * sepR;
      const cPosZ = cz + nz * sepR;
      const remDt = Math.max(0, 1 - bestT) * dt;
      const nextX = cx + vel.x * remDt;
      const nextY = cy + vel.y * remDt;
      const nextZ = cPosZ + vel.z * remDt;

      const ndx = nextX - COURT.NET_X;
      const ndy = nextY - COURT.NET_HEIGHT;
      const crossesIntoMesh =
        nextY < COURT.NET_HEIGHT &&
        Math.abs(nextZ) <= COURT.NET_HALF_Z &&
        ((prevX < COURT.NET_X && nextX > COURT.NET_X - meshHalfX) ||
          (prevX > COURT.NET_X && nextX < COURT.NET_X + meshHalfX));

      if (
        Number.isFinite(nextX) &&
        Number.isFinite(nextY) &&
        Number.isFinite(nextZ) &&
        ndx * ndx + ndy * ndy >= tapeR * tapeR &&
        !crossesIntoMesh
      ) {
        pos.x = nextX;
        pos.y = nextY;
        pos.z = nextZ;
      } else {
        pos.x = cx;
        pos.y = cy;
        pos.z = cPosZ;
      }

      return {
        part: 'TAPE',
        normal: { x: finiteOr(nx, 0), y: finiteOr(ny, 0), z: finiteOr(nz, 0) },
        point: {
          x: finiteOr(COURT.NET_X + nx * COURT.NET_TAPE_RADIUS, COURT.NET_X),
          y: finiteOr(COURT.NET_HEIGHT + ny * COURT.NET_TAPE_RADIUS, COURT.NET_HEIGHT),
          z: finiteOr(cz + nz * COURT.NET_TAPE_RADIUS, 0),
        },
        impactSpeed,
      };
    }

    // Separating (vn >= 0): never snap back to prevPos; only depenetrate if end-of-step pos is strictly inside
    const ex = pos.x - COURT.NET_X;
    const ey = pos.y - COURT.NET_HEIGHT;
    const eDistSq = ex * ex + ey * ey;
    if (Math.abs(pos.z) <= COURT.NET_HALF_Z && eDistSq < tapeR * tapeR) {
      const eDist = Math.sqrt(eDistSq);
      if (eDist < EPS) {
        pos.x = COURT.NET_X + nx * sepR;
        pos.y = COURT.NET_HEIGHT + ny * sepR;
      } else {
        const s = sepR / eDist;
        pos.x = COURT.NET_X + ex * s;
        pos.y = COURT.NET_HEIGHT + ey * s;
      }
    }
    return null;
  }

  if (bestKind === 'POST') {
    const postZ = bestAux;
    const cy = clamp(bestHitY, COURT.SAND_Y, COURT.NET_HEIGHT, COURT.SAND_Y);
    let nx = bestHitX - COURT.NET_X;
    let ny = bestHitY - cy;
    let nz = bestHitZ - postZ;
    const len = Math.hypot(nx, ny, nz);
    if (len < EPS || !Number.isFinite(len)) {
      nx = Math.abs(prevX - COURT.NET_X) > EPS ? (prevX < COURT.NET_X ? -1 : 1) : vel.x >= 0 ? -1 : 1;
      ny = 0;
      nz = 0;
    } else {
      nx /= len;
      ny /= len;
      nz /= len;
    }

    const sepR = postR + SEP_EPS;
    const vn = vel.x * nx + vel.y * ny + vel.z * nz;
    if (vn < 0) {
      const impactSpeed = Math.max(0, finiteOr(-vn, 0));
      const impulse = -(1 + cfg.eNetTape) * vn;
      vel.x += impulse * nx;
      vel.y += impulse * ny;
      vel.z += impulse * nz;

      omega.x *= NET_TAPE_OMEGA_DAMP;
      omega.y *= NET_TAPE_OMEGA_DAMP;
      omega.z *= NET_TAPE_OMEGA_DAMP;

      const cx = COURT.NET_X + nx * sepR;
      const cyPos = cy + ny * sepR;
      const czPos = postZ + nz * sepR;
      const remDt = Math.max(0, 1 - bestT) * dt;
      const nextX = cx + vel.x * remDt;
      const nextY = cyPos + vel.y * remDt;
      const nextZ = czPos + vel.z * remDt;

      const nextCy = clamp(nextY, COURT.SAND_Y, COURT.NET_HEIGHT, COURT.SAND_Y);
      const ndx = nextX - COURT.NET_X;
      const ndy = nextY - nextCy;
      const ndz = nextZ - postZ;
      const crossesIntoMesh =
        nextY < COURT.NET_HEIGHT &&
        Math.abs(nextZ) <= COURT.NET_HALF_Z &&
        ((prevX < COURT.NET_X && nextX > COURT.NET_X - meshHalfX) ||
          (prevX > COURT.NET_X && nextX < COURT.NET_X + meshHalfX));

      if (
        Number.isFinite(nextX) &&
        Number.isFinite(nextY) &&
        Number.isFinite(nextZ) &&
        ndx * ndx + ndy * ndy + ndz * ndz >= postR * postR &&
        !crossesIntoMesh
      ) {
        pos.x = nextX;
        pos.y = nextY;
        pos.z = nextZ;
      } else {
        pos.x = cx;
        pos.y = cyPos;
        pos.z = czPos;
      }

      return {
        part: 'POST',
        normal: { x: finiteOr(nx, 0), y: finiteOr(ny, 0), z: finiteOr(nz, 0) },
        point: {
          x: finiteOr(COURT.NET_X + nx * COURT.NET_POST_RADIUS, COURT.NET_X),
          y: finiteOr(cy + ny * COURT.NET_POST_RADIUS, cy),
          z: finiteOr(postZ + nz * COURT.NET_POST_RADIUS, postZ),
        },
        impactSpeed,
      };
    }

    // Separating (vn >= 0): never snap back to prevPos; only depenetrate if end-of-step pos is strictly inside
    const endCy = clamp(pos.y, COURT.SAND_Y, COURT.NET_HEIGHT, COURT.SAND_Y);
    const ex = pos.x - COURT.NET_X;
    const ey = pos.y - endCy;
    const ez = pos.z - postZ;
    const eDistSq = ex * ex + ey * ey + ez * ez;
    if (eDistSq < postR * postR) {
      const eDist = Math.sqrt(eDistSq);
      if (eDist < EPS) {
        pos.x = COURT.NET_X + nx * sepR;
        pos.y = endCy + ny * sepR;
        pos.z = postZ + nz * sepR;
      } else {
        const s = sepR / eDist;
        pos.x = COURT.NET_X + ex * s;
        pos.y = endCy + ey * s;
        pos.z = postZ + ez * s;
      }
    }
    return null;
  }

  // MESH
  const sideSign = bestAux;
  const sepX = COURT.NET_X + sideSign * (meshHalfX + SEP_EPS);
  const vn = vel.x * sideSign;
  if (vn < 0) {
    const impactSpeed = Math.max(0, finiteOr(-vn, 0));
    vel.x = sideSign * impactSpeed * cfg.eNetMesh;
    omega.x *= NET_MESH_OMEGA_DAMP;
    omega.y *= NET_MESH_OMEGA_DAMP;
    omega.z *= NET_MESH_OMEGA_DAMP;

    const remDt = Math.max(0, 1 - bestT) * dt;
    const nextX = sepX + vel.x * remDt;
    pos.x = Number.isFinite(nextX) && sideSign * (nextX - COURT.NET_X) >= meshHalfX ? nextX : sepX;

    return {
      part: 'MESH',
      normal: { x: sideSign, y: 0, z: 0 },
      point: { x: COURT.NET_X, y: finiteOr(bestHitY, 0), z: finiteOr(bestHitZ, 0) },
      impactSpeed,
    };
  }

  // Separating (vn >= 0): never overwrite pos.y or pos.z; only depenetrate pos.x if still inside slab
  if (Math.abs(pos.x - COURT.NET_X) < meshHalfX) {
    pos.x = sepX;
  }
  return null;
}

/**
 * Shared internal 3D ball step used by both `stepBall3D` and `predictLandingPoint3D`.
 */
function stepBallInternal(ballState, windX, windY, windZ, cfg, dt, isSimulation) {
  const pos = ensureVec3(ballState, 'pos', 0, BALL_SPEC.RADIUS, 0);
  const vel = ensureVec3(ballState, 'vel', 0, 0, 0);
  const omega = ensureVec3(ballState, 'omega', 0, 0, 0);
  const r = sanitizeRadius(ballState.radius);
  const floorY = COURT.SAND_Y + r;

  if (!isSimulation && ballState.spinAngle !== null && typeof ballState.spinAngle === 'object') {
    sanitizeVec3InPlace(ballState.spinAngle, 0, 0, 0);
  }

  if (ballState.active === false || typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0) {
    return {
      landed: pos.y <= floorY,
      wallHit: null,
      netHit: null,
      crossedNet: false,
      speed: finiteOr(Math.hypot(vel.x, vel.y, vel.z), 0),
      unclampedY: pos.y,
    };
  }

  const prevX = pos.x;
  const prevY = pos.y;
  const prevZ = pos.z;

  // 1. Cap |omega| <= MAX_OMEGA, then apply per-step spin decay
  let ox = omega.x;
  let oy = omega.y;
  let oz = omega.z;
  const rawOmegaMag = Math.hypot(ox, oy, oz);
  if (rawOmegaMag > BALL_SPEC.MAX_OMEGA) {
    const capScale = BALL_SPEC.MAX_OMEGA / rawOmegaMag;
    ox *= capScale;
    oy *= capScale;
    oz *= capScale;
  }

  const decay =
    dt === FIXED_DT
      ? BALL_SPEC.SPIN_DECAY_PER_STEP
      : Math.pow(BALL_SPEC.SPIN_DECAY_PER_STEP, dt / FIXED_DT);
  ox = normalizeZero(ox * decay);
  oy = normalizeZero(oy * decay);
  oz = normalizeZero(oz * decay);
  omega.x = ox;
  omega.y = oy;
  omega.z = oz;

  // 2. Relative air velocity, quadratic drag, 3D Magnus (omega x vRel), and gravity
  const vRelX = vel.x - windX;
  const vRelY = vel.y - windY;
  const vRelZ = vel.z - windZ;
  const vRelMag = Math.hypot(vRelX, vRelY, vRelZ);

  const dragFactor = -cfg.kDrag * vRelMag;
  const aDragX = dragFactor * vRelX;
  const aDragY = dragFactor * vRelY;
  const aDragZ = dragFactor * vRelZ;

  const kMag = cfg.kMagnus;
  const aMagX = kMag * (oy * vRelZ - oz * vRelY);
  const aMagY = kMag * (oz * vRelX - ox * vRelZ);
  const aMagZ = kMag * (ox * vRelY - oy * vRelX);

  const ax = aDragX + aMagX;
  const ay = -cfg.gravity + aDragY + aMagY;
  const az = aDragZ + aMagZ;

  // 3. Semi-Implicit Euler integration
  vel.x = normalizeZero(vel.x + ax * dt);
  vel.y = normalizeZero(vel.y + ay * dt);
  vel.z = normalizeZero(vel.z + az * dt);

  pos.x = normalizeZero(pos.x + vel.x * dt);
  pos.y = normalizeZero(pos.y + vel.y * dt);
  pos.z = normalizeZero(pos.z + vel.z * dt);

  // Guard against float64 overflow from extreme synthetic velocity/dt inputs before collision resolution
  if (!Number.isFinite(vel.x) || !Number.isFinite(vel.y) || !Number.isFinite(vel.z)) {
    sanitizeVec3InPlace(vel, 0, 0, 0);
  }
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
    pos.x = prevX;
    pos.y = prevY;
    pos.z = prevZ;
  }

  if (!isSimulation && ballState.spinAngle !== null && typeof ballState.spinAngle === 'object') {
    ballState.spinAngle.x = finiteOr(ballState.spinAngle.x + ox * dt, 0);
    ballState.spinAngle.y = finiteOr(ballState.spinAngle.y + oy * dt, 0);
    ballState.spinAngle.z = finiteOr(ballState.spinAngle.z + oz * dt, 0);
  }

  // 4. Spin-reactive outer arcade walls & ceiling (balls stay live)
  const wallHit = resolveArenaWalls(pos, vel, omega, r, cfg);

  // 5. Swept net collisions (rounded tape, vertical posts, mesh plane)
  const netHit = resolveNetCollision(pos, vel, omega, prevX, prevY, prevZ, r, cfg, dt);

  // Re-ensure arena X/Z/ceiling bounds if a net separation pushed near a boundary
  const minX = -COURT.ARENA_HALF_X + r;
  const maxX = COURT.ARENA_HALF_X - r;
  const minZ = -COURT.ARENA_HALF_Z + r;
  const maxZ = COURT.ARENA_HALF_Z - r;
  const maxY = COURT.CEILING_Y - r;
  if (pos.x < minX) pos.x = minX;
  else if (pos.x > maxX) pos.x = maxX;
  if (pos.z < minZ) pos.z = minZ;
  else if (pos.z > maxZ) pos.z = maxZ;
  if (pos.y > maxY) pos.y = maxY;

  // 6. Net crossing flag evaluated AFTER net collisions
  const crossedNet =
    pos.x !== prevX &&
    ((prevX < COURT.NET_X && pos.x >= COURT.NET_X) ||
      (prevX > COURT.NET_X && pos.x <= COURT.NET_X));

  // 7. Sand floor impact
  const unclampedY = pos.y;
  let landed = false;
  if (pos.y <= floorY) {
    pos.y = floorY;
    landed = true;
    if (vel.y < 0) {
      vel.y = 0;
    }
  }

  sanitizeVec3InPlace(pos, 0, floorY, 0);
  sanitizeVec3InPlace(vel, 0, 0, 0);
  sanitizeVec3InPlace(omega, 0, 0, 0);

  return {
    landed,
    wallHit,
    netHit,
    crossedNet,
    speed: finiteOr(Math.hypot(vel.x, vel.y, vel.z), 0),
    unclampedY,
  };
}

/**
 * Advance a 3D beach ball by one physics step (default FIXED_DT = 1/120s).
 */
export function stepBall3D(
  ballState,
  windState,
  physicsConfig = PHYSICS_DEFAULTS,
  dt = FIXED_DT,
  isSimulation = false,
) {
  if (ballState === null || typeof ballState !== 'object') {
    return {
      landed: false,
      wallHit: null,
      netHit: null,
      crossedNet: false,
      speed: 0,
    };
  }

  const cfg = resolvePhysicsConfig(physicsConfig);
  const wv = windState !== null && typeof windState === 'object' ? windState.windVec3 : null;
  const windX = finiteOr(wv?.x, 0);
  const windY = finiteOr(wv?.y, 0);
  const windZ = finiteOr(wv?.z, 0);

  const res = stepBallInternal(ballState, windX, windY, windZ, cfg, dt, Boolean(isSimulation));
  return {
    landed: res.landed,
    wallHit: res.wallHit,
    netHit: res.netHit,
    crossedNet: res.crossedNet,
    speed: res.speed,
  };
}

/**
 * Pure, non-mutating 3D sand landing point predictor.
 * Simulates up to `maxSteps` exact FIXED_DT steps (default 180 = 1.50s), then appends an
 * analytic quadratic ballistic tail if the ball is still airborne (e.g., high Sky Lob).
 */
export function predictLandingPoint3D(
  ballState,
  windState,
  physicsConfig = PHYSICS_DEFAULTS,
  maxSteps = MAX_PREDICT_STEPS,
) {
  const cfg = resolvePhysicsConfig(physicsConfig);
  const r = sanitizeRadius(ballState?.radius);

  const floorY = COURT.SAND_Y + r;
  const maxY = COURT.CEILING_Y - r;
  const minX = -COURT.ARENA_HALF_X + r;
  const maxX = COURT.ARENA_HALF_X - r;
  const minZ = -COURT.ARENA_HALF_Z + r;
  const maxZ = COURT.ARENA_HALF_Z - r;

  const limit =
    typeof maxSteps === 'number' && Number.isFinite(maxSteps)
      ? clamp(Math.floor(maxSteps), 0, MAX_PREDICT_CLAMP, MAX_PREDICT_STEPS)
      : MAX_PREDICT_STEPS;

  const wv = windState !== null && typeof windState === 'object' ? windState.windVec3 : null;
  const windX = finiteOr(wv?.x, 0);
  const windY = finiteOr(wv?.y, 0);
  const windZ = finiteOr(wv?.z, 0);

  const simBall = {
    pos: {
      x: finiteOr(ballState?.pos?.x, 0),
      y: finiteOr(ballState?.pos?.y, floorY),
      z: finiteOr(ballState?.pos?.z, 0),
    },
    vel: {
      x: finiteOr(ballState?.vel?.x, 0),
      y: finiteOr(ballState?.vel?.y, 0),
      z: finiteOr(ballState?.vel?.z, 0),
    },
    omega: {
      x: finiteOr(ballState?.omega?.x, 0),
      y: finiteOr(ballState?.omega?.y, 0),
      z: finiteOr(ballState?.omega?.z, 0),
    },
    radius: r,
    active: true,
  };

  if (simBall.pos.y <= floorY) {
    const landX = clamp(simBall.pos.x, minX, maxX, 0);
    const landZ = clamp(simBall.pos.z, minZ, maxZ, 0);
    return {
      x: landX,
      z: landZ,
      hangTime: 0,
      landedWithinSteps: true,
      steps: 0,
      trajectory: [{ x: landX, y: floorY, z: landZ, t: 0 }],
    };
  }

  const trajectory = [
    {
      x: simBall.pos.x,
      y: simBall.pos.y,
      z: simBall.pos.z,
      t: 0,
    },
  ];

  for (let step = 1; step <= limit; step++) {
    const prevX = simBall.pos.x;
    const prevY = simBall.pos.y;
    const prevZ = simBall.pos.z;

    const res = stepBallInternal(simBall, windX, windY, windZ, cfg, FIXED_DT, true);

    if (res.landed) {
      const denom = prevY - res.unclampedY;
      const frac = denom > EPS ? clamp((prevY - floorY) / denom, 0, 1, 1) : 1;
      const landX = clamp(prevX + (simBall.pos.x - prevX) * frac, minX, maxX, 0);
      const landZ = clamp(prevZ + (simBall.pos.z - prevZ) * frac, minZ, maxZ, 0);
      const hangTime = normalizeZero((step - 1 + frac) * FIXED_DT);

      trajectory.push({ x: landX, y: floorY, z: landZ, t: hangTime });
      return {
        x: landX,
        z: landZ,
        hangTime,
        landedWithinSteps: true,
        steps: step,
        trajectory,
      };
    }

    if (step % 3 === 0 || step === limit) {
      trajectory.push({
        x: simBall.pos.x,
        y: simBall.pos.y,
        z: simBall.pos.z,
        t: step * FIXED_DT,
      });
    }
  }

  // Analytic quadratic ballistic tail when still airborne after `limit` steps (e.g., high Sky Lob)
  const t0 = limit * FIXED_DT;
  const x0 = simBall.pos.x;
  const y0 = simBall.pos.y;
  const z0 = simBall.pos.z;
  const vx = simBall.vel.x;
  const vy = simBall.vel.y;
  const vz = simBall.vel.z;
  const h = Math.max(0, y0 - floorY);
  const g = cfg.gravity;
  const disc = Math.max(0, vy * vy + 2 * g * h);
  const rawDtTail = g > 1e-6 ? (vy + Math.sqrt(disc)) / g : 0;
  const dtTail = Number.isFinite(rawDtTail) && rawDtTail > 0 ? rawDtTail : 0;

  for (let i = 1; i <= 3; i++) {
    const dtSub = dtTail * (i * 0.25);
    const px = clamp(x0 + vx * dtSub, minX, maxX, 0);
    const py = clamp(y0 + vy * dtSub - 0.5 * g * dtSub * dtSub, floorY, maxY, floorY);
    const pz = clamp(z0 + vz * dtSub, minZ, maxZ, 0);
    trajectory.push({ x: px, y: py, z: pz, t: finiteOr(t0 + dtSub, t0) });
  }

  const landX = clamp(x0 + vx * dtTail, minX, maxX, 0);
  const landZ = clamp(z0 + vz * dtTail, minZ, maxZ, 0);
  const hangTime = finiteOr(t0 + dtTail, t0);
  trajectory.push({ x: landX, y: floorY, z: landZ, t: hangTime });

  return {
    x: landX,
    z: landZ,
    hangTime,
    landedWithinSteps: false,
    steps: limit,
    trajectory,
  };
}
