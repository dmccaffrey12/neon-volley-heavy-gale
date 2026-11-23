import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXED_DT,
  MAX_PREDICT_STEPS,
  COORDINATE_SYSTEM,
  COURT,
  BALL_SPEC,
  PHYSICS_DEFAULTS,
  PHYSICS_LIMITS,
  STORAGE_KEYS,
  INPUT_MODES,
  CAMERA_MODES,
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
  createDefaultBindings,
  sanitizePhysicsConfig,
} from '../../src/contracts.js';

function cross3(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

describe('contracts.js — frozen constants & enums', () => {
  it('exports exact scalar constants', () => {
    assert.equal(FIXED_DT, 1 / 120);
    assert.equal(MAX_PREDICT_STEPS, 180);
  });

  it('exports exact COORDINATE_SYSTEM, COURT, BALL_SPEC, PHYSICS_DEFAULTS, PHYSICS_LIMITS', () => {
    assert.deepStrictEqual(COORDINATE_SYSTEM, {
      handedness: 'right',
      up: '+Y',
      team1Side: '-X',
      team2Side: '+X',
      nearSideline: '+Z',
      oceanHorizon: '-Z',
    });

    assert.deepStrictEqual(COURT, {
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

    assert.deepStrictEqual(BALL_SPEC, {
      RADIUS: 0.22,
      MAX_OMEGA: 24.0,
      SPIN_DECAY_PER_STEP: 0.9965,
    });

    assert.deepStrictEqual(PHYSICS_DEFAULTS, {
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

    assert.deepStrictEqual(PHYSICS_LIMITS, {
      gravity: [6, 18, 0.2],
      kDrag: [0, 0.08, 0.002],
      kMagnus: [0, 0.07, 0.002],
      gustScale: [0, 2.0, 0.05],
      gameSpeed: [0.5, 1.6, 0.05],
    });
  });

  it('exports exact isolated v2 STORAGE_KEYS and all enum maps', () => {
    assert.deepStrictEqual(STORAGE_KEYS, {
      PHYSICS: 'summer_heat_3d_physics_v2',
      BINDINGS: 'summer_heat_3d_bindings_v2',
      SETTINGS: 'summer_heat_3d_settings_v2',
    });

    assert.deepStrictEqual(INPUT_MODES, {
      ONE_PAD_SPLIT: '1PAD',
      TWO_PAD_KEYBOARD: '2PAD',
      TOUCH_AUTO: 'TOUCH',
    });

    assert.deepStrictEqual(CAMERA_MODES, {
      BROADCAST: 'BROADCAST',
      SPLIT_SCREEN: 'SPLIT',
    });

    assert.deepStrictEqual(AI_STYLES, {
      WIND_LOBBER: 'WIND_LOBBER',
      NET_BLOCKER: 'NET_BLOCKER',
      SPIN_SLICER: 'SPIN_SLICER',
    });

    assert.deepStrictEqual(MATCH_FORMATS, {
      ONE_V_ONE: '1v1',
      TWO_V_TWO: '2v2',
    });

    assert.deepStrictEqual(ANIM_STATES, {
      IDLE: 'Idle',
      SPRINT: 'Sprint',
      UNDERHAND_BUMP: 'UnderhandBump',
      OVERHEAD_SET: 'OverheadSet',
      JUMP_HEAT_SPIKE: 'JumpHeatSpike',
      NET_BLOCK: 'NetBlock',
      SAND_DIVE: 'SandDive',
    });

    assert.deepStrictEqual(WIND_PHASES, {
      BREEZE: 'BREEZE',
      WARNING: 'WARNING',
      GUST: 'GUST',
    });

    assert.deepStrictEqual(TRAIL_MODES, {
      NEUTRAL: 'NEUTRAL',
      FLAME: 'FLAME',
      CYAN: 'CYAN',
      LOB: 'LOB',
    });

    assert.deepStrictEqual(SHOT_TYPES, {
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

    assert.deepStrictEqual(EVENTS, {
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
  });

  it('deep-freezes all exported constant objects and nested arrays', () => {
    const frozenExports = [
      COORDINATE_SYSTEM,
      COURT,
      BALL_SPEC,
      PHYSICS_DEFAULTS,
      PHYSICS_LIMITS,
      STORAGE_KEYS,
      INPUT_MODES,
      CAMERA_MODES,
      AI_STYLES,
      MATCH_FORMATS,
      ANIM_STATES,
      WIND_PHASES,
      TRAIL_MODES,
      SHOT_TYPES,
      EVENTS,
    ];

    for (const obj of frozenExports) {
      assert.equal(Object.isFrozen(obj), true);
    }

    assert.equal(Object.isFrozen(PHYSICS_LIMITS.gravity), true);
    assert.equal(Object.isFrozen(PHYSICS_LIMITS.kDrag), true);
    assert.equal(Object.isFrozen(PHYSICS_LIMITS.kMagnus), true);
    assert.equal(Object.isFrozen(PHYSICS_LIMITS.gustScale), true);
    assert.equal(Object.isFrozen(PHYSICS_LIMITS.gameSpeed), true);

    assert.throws(() => {
      COURT.NET_HEIGHT = 99;
    }, TypeError);

    assert.throws(() => {
      PHYSICS_LIMITS.gravity[0] = 999;
    }, TypeError);

    assert.throws(() => {
      PHYSICS_LIMITS.gravity.push(1);
    }, TypeError);

    assert.throws(() => {
      EVENTS.EXTRA = 'NOPE';
    }, TypeError);
  });
});

describe('contracts.js — clamp & createVec3', () => {
  it('clamps finite numbers and guards non-finite / non-number inputs', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-3, 0, 10), 0);
    assert.equal(clamp(42, 0, 10), 10);
    assert.equal(clamp(Number.NaN, 0, 10, 4), 4);
    assert.equal(clamp(Number.POSITIVE_INFINITY, 0, 10, 6), 6);
    assert.equal(clamp(Number.NEGATIVE_INFINITY, 0, 10, 2), 2);
    assert.equal(clamp(undefined, 1, 9, 5), 5);
    assert.equal(clamp('7', 0, 10, 3), 3);
    assert.equal(clamp('not-a-number', 0, 10, 3), 3);
    assert.equal(clamp(Number.NaN, 2, 8, Number.NaN), 2);
    assert.equal(clamp(Number.NaN, 2, 8, 99), 8);
    assert.equal(clamp(Number.NaN, 2, 8, -5), 2);
  });

  it('creates fresh mutable Vec3 objects with finite numeric guards', () => {
    const v0 = createVec3();
    const v1 = createVec3();
    assert.deepStrictEqual(v0, { x: 0, y: 0, z: 0 });
    assert.notEqual(v0, v1);

    const v2 = createVec3(1.5, -2.5, 3.25);
    assert.deepStrictEqual(v2, { x: 1.5, y: -2.5, z: 3.25 });

    const vBad = createVec3(Number.NaN, Number.POSITIVE_INFINITY, 'bad');
    assert.deepStrictEqual(vBad, { x: 0, y: 0, z: 0 });
  });
});

describe('contracts.js — computeSpinOmega right-handed Magnus & wall-kick math', () => {
  it('produces downward (-Y) Magnus force for +X, -X, and diagonal topspin', () => {
    // +X shot
    const omegaPosX = computeSpinOmega(1, 0, 10, 0);
    assert.deepStrictEqual(omegaPosX, { x: 0, y: 0, z: -10 });
    const magnusPosX = cross3(omegaPosX, { x: 12, y: 0, z: 0 });
    assert.equal(magnusPosX.y, -120);
    assert.equal(magnusPosX.x, 0);
    assert.equal(magnusPosX.z, 0);

    // -X shot
    const omegaNegX = computeSpinOmega(-1, 0, 10, 0);
    assert.deepStrictEqual(omegaNegX, { x: 0, y: 0, z: 10 });
    const magnusNegX = cross3(omegaNegX, { x: -12, y: 0, z: 0 });
    assert.equal(magnusNegX.y, -120);
    assert.equal(magnusNegX.x, 0);
    assert.equal(magnusNegX.z, 0);

    // Diagonal (1, 1) shot
    const omegaDiag = computeSpinOmega(1, 1, 10, 0);
    const invSqrt2 = Math.SQRT1_2;
    assert.ok(Math.abs(omegaDiag.x - 10 * invSqrt2) < 1e-12);
    assert.equal(omegaDiag.y, 0);
    assert.ok(Math.abs(omegaDiag.z - -10 * invSqrt2) < 1e-12);
    const vDiag = { x: 10 * invSqrt2, y: 0, z: 10 * invSqrt2 };
    const magnusDiag = cross3(omegaDiag, vDiag);
    assert.ok(Math.abs(magnusDiag.y - -100) < 1e-10);
    assert.ok(Math.abs(magnusDiag.x) < 1e-12);
    assert.ok(Math.abs(magnusDiag.z) < 1e-12);
  });

  it('produces upward (+Y) Magnus force for backspin and lateral curve for sidespin', () => {
    const omegaBack = computeSpinOmega(1, 0, -8, 0);
    const magnusBack = cross3(omegaBack, { x: 10, y: 0, z: 0 });
    assert.equal(magnusBack.y, 80);

    const omegaSide = computeSpinOmega(1, 0, 0, 6);
    assert.deepStrictEqual(omegaSide, { x: 0, y: 6, z: 0 });
    const magnusSide = cross3(omegaSide, { x: 10, y: 0, z: 0 });
    assert.equal(magnusSide.y, 0);
    assert.equal(magnusSide.z, -60);
  });

  it('satisfies symmetric spin-reactive wall kick (inwardNormal x omega) on left and right walls', () => {
    const rightWallNormal = { x: -1, y: 0, z: 0 };
    const leftWallNormal = { x: 1, y: 0, z: 0 };

    // Topspin dives downward (-Y) on both right wall (P1 shot) and left wall (P2 shot)
    const p1Topspin = computeSpinOmega(1, 0, 12, 0);
    const p2Topspin = computeSpinOmega(-1, 0, 12, 0);
    assert.ok(cross3(rightWallNormal, p1Topspin).y < 0);
    assert.ok(cross3(leftWallNormal, p2Topspin).y < 0);
    assert.equal(cross3(rightWallNormal, p1Topspin).y, -12);
    assert.equal(cross3(leftWallNormal, p2Topspin).y, -12);

    // Backspin pops upward (+Y) on both right wall and left wall
    const p1Backspin = computeSpinOmega(1, 0, -12, 0);
    const p2Backspin = computeSpinOmega(-1, 0, -12, 0);
    assert.equal(cross3(rightWallNormal, p1Backspin).y, 12);
    assert.equal(cross3(leftWallNormal, p2Backspin).y, 12);
  });

  it('handles zero-length direction safely without NaN and caps magnitude to MAX_OMEGA', () => {
    const zeroDir = computeSpinOmega(0, 0, 15, 7);
    assert.deepStrictEqual(zeroDir, { x: 0, y: 7, z: 0 });

    const zeroDirHugeSide = computeSpinOmega(0, 0, 10, 999);
    assert.deepStrictEqual(zeroDirHugeSide, { x: 0, y: BALL_SPEC.MAX_OMEGA, z: 0 });

    const nanDir = computeSpinOmega(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN, -50);
    assert.deepStrictEqual(nanDir, { x: 0, y: -BALL_SPEC.MAX_OMEGA, z: 0 });

    // Proportional cap when combined topspin + sidespin exceeds MAX_OMEGA
    const capped = computeSpinOmega(1, 0, 30, 40); // raw mag = 50 -> scaled to 24
    const mag = Math.hypot(capped.x, capped.y, capped.z);
    assert.ok(Math.abs(mag - BALL_SPEC.MAX_OMEGA) < 1e-12);
    assert.ok(Math.abs(capped.z / capped.y - -30 / 40) < 1e-12);
  });
});

describe('contracts.js — state factories isolation & defaults', () => {
  it('createBallState provides defaults and deep-copies Vec3 overrides', () => {
    const a = createBallState();
    const b = createBallState();
    assert.deepStrictEqual(a, {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      omega: { x: 0, y: 0, z: 0 },
      radius: BALL_SPEC.RADIUS,
      trailMode: TRAIL_MODES.NEUTRAL,
      shotType: SHOT_TYPES.SERVE,
      lastHitTeam: 1,
      spinAngle: { x: 0, y: 0, z: 0 },
      active: true,
    });
    assert.notEqual(a.pos, b.pos);
    assert.notEqual(a.vel, b.vel);
    assert.notEqual(a.omega, b.omega);
    assert.notEqual(a.spinAngle, b.spinAngle);

    const extPos = { x: -4, y: 2.5, z: 1 };
    const c = createBallState({
      pos: extPos,
      vel: { x: 9, y: 3, z: -1 },
      omega: { x: 0, y: 2, z: -14 },
      trailMode: TRAIL_MODES.FLAME,
      shotType: SHOT_TYPES.HEAT_SPIKE,
      lastHitTeam: 2,
      active: false,
    });
    extPos.x = 999;
    assert.equal(c.pos.x, -4);
    assert.equal(c.trailMode, TRAIL_MODES.FLAME);
    assert.equal(c.shotType, SHOT_TYPES.HEAT_SPIKE);
    assert.equal(c.lastHitTeam, 2);
    assert.equal(c.active, false);
  });

  it('createWindState provides defaults and deep-copies Vec3 overrides', () => {
    const w1 = createWindState();
    const w2 = createWindState();
    assert.deepStrictEqual(w1, {
      time: 0,
      phase: WIND_PHASES.BREEZE,
      timer: 6.0,
      windVec3: { x: 0, y: 0, z: 0 },
      gustTargetVec3: { x: 0, y: 0, z: 0 },
      speed: 0,
    });
    assert.notEqual(w1.windVec3, w2.windVec3);
    assert.notEqual(w1.gustTargetVec3, w2.gustTargetVec3);

    const extWind = { x: 5.5, y: 0.2, z: -1.8 };
    const w3 = createWindState({
      phase: WIND_PHASES.GUST,
      timer: 4.0,
      windVec3: extWind,
      speed: 5.8,
    });
    extWind.x = -100;
    assert.equal(w3.windVec3.x, 5.5);
    assert.equal(w3.phase, WIND_PHASES.GUST);
  });

  it('createPlayerState provides defaults and deep-copies Vec3 overrides', () => {
    const p1 = createPlayerState();
    const p2 = createPlayerState();
    assert.deepStrictEqual(p1, {
      id: 'p1',
      team: 1,
      role: 'PRIMARY',
      isHuman: true,
      pos: { x: -4, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      facingYaw: Math.PI / 2,
      animState: ANIM_STATES.IDLE,
      animTime: 0,
      animProgress: 0,
      chargeRatio: 0,
      heatMeter: 0,
      isAirborne: false,
      diveTimer: 0,
      blockTimer: 0,
      strikeCooldown: 0,
      targetBallPos: null,
    });
    assert.notEqual(p1.pos, p2.pos);
    assert.notEqual(p1.vel, p2.vel);

    const extTarget = { x: 2, y: 1.8, z: -0.5 };
    const p3 = createPlayerState({
      id: 'p2',
      team: 2,
      role: 'PARTNER',
      isHuman: false,
      pos: { x: 4, y: 0, z: 1 },
      animState: ANIM_STATES.JUMP_HEAT_SPIKE,
      chargeRatio: 1.5,
      heatMeter: -0.2,
      targetBallPos: extTarget,
    });
    extTarget.x = 777;
    assert.equal(p3.targetBallPos.x, 2);
    assert.equal(p3.chargeRatio, 1);
    assert.equal(p3.heatMeter, 0);
    assert.equal(p3.team, 2);
    assert.equal(p3.role, 'PARTNER');
    assert.equal(p3.isHuman, false);
  });
});

describe('contracts.js — createDefaultBindings (harvested v1 Stadia + Keyboard)', () => {
  it('matches exact harvested v1 Stadia, 2PAD, and Keyboard indices with fresh mutable copies', () => {
    const b1 = createDefaultBindings();
    const b2 = createDefaultBindings();

    assert.equal(b1.deadzone, 0.16);
    assert.deepStrictEqual(b1.onePadSplit.p1, {
      padIndex: 0,
      axisX: 0,
      axisY: 1,
      dpadLeft: 14,
      dpadRight: 15,
      dpadUp: 12,
      dpadDown: 13,
      primaryButtons: [4, 6],
      secondaryButtons: [10, 8],
    });
    assert.deepStrictEqual(b1.onePadSplit.p2, {
      padIndex: 0,
      axisX: 2,
      axisY: 3,
      primaryButtons: [5, 7, 0],
      secondaryButtons: [1, 2, 3],
    });
    assert.deepStrictEqual(b1.twoPad.p1, {
      padIndex: 0,
      axisX: 0,
      axisY: 1,
      dpadLeft: 14,
      dpadRight: 15,
      dpadUp: 12,
      dpadDown: 13,
      primaryButtons: [0, 4, 5, 6, 7],
      secondaryButtons: [1, 2, 3],
    });
    assert.deepStrictEqual(b1.twoPad.p2, {
      padIndex: 1,
      axisX: 0,
      axisY: 1,
      dpadLeft: 14,
      dpadRight: 15,
      dpadUp: 12,
      dpadDown: 13,
      primaryButtons: [0, 4, 5, 6, 7],
      secondaryButtons: [1, 2, 3],
    });
    assert.deepStrictEqual(b1.keyboard.p1, {
      left: 'KeyA',
      right: 'KeyD',
      up: 'KeyW',
      down: 'KeyS',
      primary: ['Space'],
      secondary: ['ShiftLeft', 'KeyE'],
    });
    assert.deepStrictEqual(b1.keyboard.p2, {
      left: 'ArrowLeft',
      right: 'ArrowRight',
      up: 'ArrowUp',
      down: 'ArrowDown',
      primary: ['Enter', 'NumpadEnter'],
      secondary: ['ShiftRight', 'Slash'],
    });
    assert.deepStrictEqual(b1.quickBindSlots, {
      p1Primary: null,
      p1Secondary: null,
      p2Primary: null,
      p2Secondary: null,
    });

    // Ensure mutating b1 does not leak into b2
    b1.onePadSplit.p1.primaryButtons.push(99);
    b1.keyboard.p1.primary[0] = 'KeyZ';
    b1.quickBindSlots.p1Primary = { type: 'key', code: 'KeyF' };
    assert.deepStrictEqual(b2.onePadSplit.p1.primaryButtons, [4, 6]);
    assert.deepStrictEqual(b2.keyboard.p1.primary, ['Space']);
    assert.equal(b2.quickBindSlots.p1Primary, null);
  });
});

describe('contracts.js — sanitizePhysicsConfig', () => {
  it('returns exact defaults for null, undefined, empty, array, or corrupt inputs', () => {
    for (const bad of [null, undefined, {}, [], 'corrupt', 42]) {
      assert.deepStrictEqual(sanitizePhysicsConfig(bad), { ...PHYSICS_DEFAULTS });
    }

    assert.deepStrictEqual(
      sanitizePhysicsConfig({
        gravity: 'abc',
        kDrag: '',
        kMagnus: Number.NaN,
        eWall: Number.POSITIVE_INFINITY,
        eNetTape: Number.NEGATIVE_INFINITY,
        eNetMesh: null,
        kWallSpin: undefined,
        gustScale: {},
        gameSpeed: [],
      }),
      { ...PHYSICS_DEFAULTS },
    );
  });

  it('clamps extreme values to PHYSICS_LIMITS and valid physical ranges', () => {
    assert.deepStrictEqual(
      sanitizePhysicsConfig({
        gravity: 999,
        kDrag: -5,
        kMagnus: 1.5,
        eWall: 2.0,
        eNetTape: -0.5,
        eNetMesh: 1.2,
        kWallSpin: 9.0,
        gustScale: -10,
        gameSpeed: 5.0,
      }),
      {
        gravity: PHYSICS_LIMITS.gravity[1],
        kDrag: PHYSICS_LIMITS.kDrag[0],
        kMagnus: PHYSICS_LIMITS.kMagnus[1],
        eWall: 1,
        eNetTape: 0,
        eNetMesh: 1,
        kWallSpin: 0.5,
        gustScale: PHYSICS_LIMITS.gustScale[0],
        gameSpeed: PHYSICS_LIMITS.gameSpeed[1],
      },
    );

    assert.deepStrictEqual(
      sanitizePhysicsConfig({
        gravity: '14.4',
        kDrag: '0.04',
        kMagnus: 0.05,
        eWall: 0.85,
        eNetTape: 0.65,
        eNetMesh: 0.4,
        kWallSpin: 0.2,
        gustScale: 1.5,
        gameSpeed: '1.25',
      }),
      {
        gravity: 14.4,
        kDrag: 0.04,
        kMagnus: 0.05,
        eWall: 0.85,
        eNetTape: 0.65,
        eNetMesh: 0.4,
        kWallSpin: 0.2,
        gustScale: 1.5,
        gameSpeed: 1.25,
      },
    );
  });
});
