import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FIXED_DT,
  updateWind3D,
  triggerGaleSurge,
  stepBall3D,
  predictLandingPoint3D,
} from '../../src/physics3d.js';

import {
  MAX_PREDICT_STEPS,
  COURT,
  BALL_SPEC,
  PHYSICS_DEFAULTS,
  WIND_PHASES,
  computeSpinOmega,
  createBallState,
  createWindState,
} from '../../src/contracts.js';

function assertAllFiniteVec3(vec, label) {
  assert.ok(Number.isFinite(vec.x), `${label}.x must be finite, got ${vec.x}`);
  assert.ok(Number.isFinite(vec.y), `${label}.y must be finite, got ${vec.y}`);
  assert.ok(Number.isFinite(vec.z), `${label}.z must be finite, got ${vec.z}`);
}

function stepUntilLanded(ball, wind, cfg, maxSteps = 1000) {
  let prevX = ball.pos.x;
  let prevY = ball.pos.y;
  let prevZ = ball.pos.z;
  for (let step = 1; step <= maxSteps; step++) {
    prevX = ball.pos.x;
    prevY = ball.pos.y;
    prevZ = ball.pos.z;
    const res = stepBall3D(ball, wind, cfg, FIXED_DT, false);
    if (res.landed) {
      return { step, prevX, prevY, prevZ, res };
    }
  }
  return { step: maxSteps, prevX, prevY, prevZ, res: { landed: false } };
}

describe('physics3d.js — module boundary & exports', () => {
  it('re-exports exact FIXED_DT === 1/120', () => {
    assert.equal(FIXED_DT, 1 / 120);
  });

  it('imports ONLY ./contracts.js and uses zero DOM, Three.js, or Math.random()', () => {
    const src = readFileSync(new URL('../../src/physics3d.js', import.meta.url), 'utf8');
    const importMatches = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.ok(importMatches.length >= 1, 'expected at least one import/re-export');
    for (const spec of importMatches) {
      assert.equal(spec, './contracts.js', `forbidden import specifier: ${spec}`);
    }
    assert.equal(src.includes('Math.random'), false, 'physics3d.js must never call Math.random()');
    assert.equal(/\b(window|document|THREE)\b/.test(src), false, 'physics3d.js must have zero DOM/Three references');
  });
});

describe('physics3d.js — F02: 120Hz semi-implicit Euler, determinism & spin decay/cap', () => {
  it('produces bitwise-identical trajectories for identical initial states', () => {
    const cfg = { ...PHYSICS_DEFAULTS };
    const b1 = createBallState({
      pos: { x: -4.5, y: 2.8, z: 1.1 },
      vel: { x: 11.4, y: 4.9, z: -2.2 },
      omega: computeSpinOmega(11.4, -2.2, 16, 7),
    });
    const b2 = structuredClone(b1);
    const w1 = createWindState({ windVec3: { x: -3.4, y: 0.2, z: 1.5 } });
    const w2 = structuredClone(w1);

    for (let i = 0; i < 120; i++) {
      const r1 = stepBall3D(b1, w1, cfg, FIXED_DT, false);
      const r2 = stepBall3D(b2, w2, cfg, FIXED_DT, false);
      assert.deepStrictEqual(r1, r2);
      assert.deepStrictEqual(b1, b2);
    }
  });

  it('matches exact analytical semi-implicit Euler gravity in vacuum', () => {
    const cfg = { ...PHYSICS_DEFAULTS, kDrag: 0, kMagnus: 0, gravity: 11.2 };
    const ball = createBallState({ pos: { x: -3, y: 6.0, z: 0 }, vel: { x: 0, y: 0, z: 0 } });
    const wind = createWindState();

    let expectedY = 6.0;
    let expectedVy = 0;
    for (let i = 0; i < 40; i++) {
      stepBall3D(ball, wind, cfg, FIXED_DT, false);
      expectedVy -= cfg.gravity * FIXED_DT;
      expectedY += expectedVy * FIXED_DT;
    }

    assert.ok(Math.abs(ball.vel.y - expectedVy) < 1e-12);
    assert.ok(Math.abs(ball.pos.y - expectedY) < 1e-12);
  });

  it('clamps omega magnitude to MAX_OMEGA, decays monotonically, and updates spinAngle only when !isSimulation', () => {
    const ball = createBallState({
      pos: { x: -3, y: 5, z: 0 },
      vel: { x: 4, y: 2, z: 0 },
      omega: { x: 0, y: 30, z: 40 }, // magnitude 50 > MAX_OMEGA (24)
    });
    const wind = createWindState();

    stepBall3D(ball, wind, PHYSICS_DEFAULTS, FIXED_DT, false);
    const mag1 = Math.hypot(ball.omega.x, ball.omega.y, ball.omega.z);
    assert.ok(mag1 <= BALL_SPEC.MAX_OMEGA + 1e-12, `expected |omega| <= 24, got ${mag1}`);
    assert.ok(
      Math.abs(mag1 - BALL_SPEC.MAX_OMEGA * BALL_SPEC.SPIN_DECAY_PER_STEP) < 1e-9,
      `expected capped & decayed magnitude, got ${mag1}`,
    );
    // Preserves direction ratio 3:4
    assert.ok(Math.abs(ball.omega.y / ball.omega.z - 0.75) < 1e-9);
    assert.ok(ball.spinAngle.y > 0 && ball.spinAngle.z > 0, 'spinAngle should integrate when !isSimulation');

    const prevSpinAngle = structuredClone(ball.spinAngle);
    stepBall3D(ball, wind, PHYSICS_DEFAULTS, FIXED_DT, true);
    const mag2 = Math.hypot(ball.omega.x, ball.omega.y, ball.omega.z);
    assert.ok(mag2 < mag1, 'omega should decay monotonically');
    assert.deepStrictEqual(ball.spinAngle, prevSpinAngle, 'spinAngle must not mutate when isSimulation=true');
  });

  it('does not advance position or velocity when active === false or dt <= 0', () => {
    const inactive = createBallState({
      pos: { x: -2, y: 3, z: 1 },
      vel: { x: 8, y: 4, z: -2 },
      active: false,
    });
    const beforeInactive = structuredClone(inactive);
    const wind = createWindState();

    const r1 = stepBall3D(inactive, wind, PHYSICS_DEFAULTS, FIXED_DT, false);
    assert.equal(r1.landed, false);
    assert.equal(r1.crossedNet, false);
    assert.deepStrictEqual(inactive.pos, beforeInactive.pos);
    assert.deepStrictEqual(inactive.vel, beforeInactive.vel);

    const active = createBallState({ pos: { x: -2, y: 3, z: 1 }, vel: { x: 8, y: 4, z: -2 } });
    const beforeZero = structuredClone(active);
    const r2 = stepBall3D(active, wind, PHYSICS_DEFAULTS, 0, false);
    const r3 = stepBall3D(active, wind, PHYSICS_DEFAULTS, -0.05, false);
    assert.equal(r2.landed, false);
    assert.equal(r3.landed, false);
    assert.deepStrictEqual(active.pos, beforeZero.pos);
    assert.deepStrictEqual(active.vel, beforeZero.vel);
  });

  it('does not multiply dt by physicsConfig.gameSpeed inside stepBall3D or updateWind3D', () => {
    const b1 = createBallState({ pos: { x: -3, y: 4, z: 0 }, vel: { x: 6, y: 3, z: 0 } });
    const b2 = structuredClone(b1);
    const w1 = createWindState();
    const w2 = createWindState();

    updateWind3D(w1, FIXED_DT, { ...PHYSICS_DEFAULTS, gameSpeed: 1.0 });
    updateWind3D(w2, FIXED_DT, { ...PHYSICS_DEFAULTS, gameSpeed: 1.6 });
    assert.deepStrictEqual(w1, w2);

    stepBall3D(b1, w1, { ...PHYSICS_DEFAULTS, gameSpeed: 1.0 }, FIXED_DT);
    stepBall3D(b2, w2, { ...PHYSICS_DEFAULTS, gameSpeed: 1.6 }, FIXED_DT);
    assert.deepStrictEqual(b1, b2);
  });
});

describe('physics3d.js — F03: Heavy Gale 3D crosswinds & 4-second surges', () => {
  it('cycles BREEZE -> WARNING (1.0s) -> GUST (4.0s) -> BREEZE (8..12s) deterministically', () => {
    const wind = createWindState({ phase: WIND_PHASES.BREEZE, timer: 1.0 });
    const transitions = [];
    let breezeMaxSpeed = 0;
    let gustMaxSpeed = 0;

    // Step 8.0 seconds at 120Hz (960 steps)
    for (let i = 0; i < 960; i++) {
      const out = updateWind3D(wind, FIXED_DT, PHYSICS_DEFAULTS);
      if (out.phaseChanged) {
        transitions.push({ step: i + 1, phase: out.phase, timer: wind.timer });
      }
      if (out.phase === WIND_PHASES.BREEZE && i < 110) {
        breezeMaxSpeed = Math.max(breezeMaxSpeed, wind.speed);
      }
      if (out.phase === WIND_PHASES.GUST) {
        gustMaxSpeed = Math.max(gustMaxSpeed, wind.speed);
      }
    }

    assert.equal(transitions.length, 3, `expected 3 phase transitions, got ${JSON.stringify(transitions)}`);
    assert.equal(transitions[0].phase, WIND_PHASES.WARNING);
    assert.equal(transitions[0].timer, 1.0);
    assert.equal(transitions[1].phase, WIND_PHASES.GUST);
    assert.equal(transitions[1].timer, 4.0);
    assert.equal(transitions[2].phase, WIND_PHASES.BREEZE);
    assert.ok(
      transitions[2].timer >= 8.0 && transitions[2].timer <= 12.0,
      `expected BREEZE timer in [8, 12], got ${transitions[2].timer}`,
    );
    assert.ok(
      gustMaxSpeed > breezeMaxSpeed + 2.5,
      `expected elevated GUST speed (${gustMaxSpeed}) > BREEZE (${breezeMaxSpeed})`,
    );
    assert.ok(Math.abs(wind.gustTargetVec3.z) >= 1.2, 'expected genuine 3D Z crosswind in gust');
  });

  it('triggerGaleSurge respects dirSignX, enforces exact 3D gust bounds, and alternates deterministically', () => {
    const wPos = createWindState({ time: 2.5 });
    const ret = triggerGaleSurge(wPos, +1);
    assert.equal(ret, wPos);
    assert.equal(wPos.phase, WIND_PHASES.WARNING);
    assert.equal(wPos.timer, 1.0);
    assert.ok(wPos.gustTargetVec3.x >= 5.0 && wPos.gustTargetVec3.x <= 6.8);
    assert.ok(Math.abs(wPos.gustTargetVec3.z) >= 1.2 && Math.abs(wPos.gustTargetVec3.z) <= 2.6);
    assert.ok(wPos.gustTargetVec3.y >= -0.3 && wPos.gustTargetVec3.y <= 0.4);

    const wNeg = createWindState({ time: 2.5 });
    triggerGaleSurge(wNeg, -1);
    assert.ok(wNeg.gustTargetVec3.x <= -5.0 && wNeg.gustTargetVec3.x >= -6.8);

    // Alternating sign when dirSignX is null
    const wAlt = createWindState({ time: 4.2 });
    triggerGaleSurge(wAlt, null);
    const firstSign = Math.sign(wAlt.gustTargetVec3.x);
    assert.notEqual(firstSign, 0);
    wAlt.time += 1.5;
    triggerGaleSurge(wAlt, null);
    assert.equal(Math.sign(wAlt.gustTargetVec3.x), -firstSign);
  });

  it('scales wind with gustScale and immediately zeroes wind when gustScale === 0', () => {
    const w1 = createWindState({ time: 1.0, phase: WIND_PHASES.BREEZE, timer: 10 });
    const w2 = structuredClone(w1);

    for (let i = 0; i < 60; i++) {
      updateWind3D(w1, FIXED_DT, { ...PHYSICS_DEFAULTS, gustScale: 1.0 });
      updateWind3D(w2, FIXED_DT, { ...PHYSICS_DEFAULTS, gustScale: 2.0 });
    }
    assert.ok(w1.speed > 0.2);
    assert.ok(Math.abs(w2.speed - 2 * w1.speed) < 1e-9);
    assert.ok(Math.abs(w2.windVec3.x - 2 * w1.windVec3.x) < 1e-9);
    assert.ok(Math.abs(w2.windVec3.z - 2 * w1.windVec3.z) < 1e-9);

    // Mid-gust gustScale === 0 immediately zeroes windVec3 and speed
    triggerGaleSurge(w2, +1);
    updateWind3D(w2, 1.0, PHYSICS_DEFAULTS);
    updateWind3D(w2, 0.5, PHYSICS_DEFAULTS);
    assert.ok(w2.speed > 3.0);
    updateWind3D(w2, FIXED_DT, { ...PHYSICS_DEFAULTS, gustScale: 0 });
    assert.deepStrictEqual(w2.windVec3, { x: 0, y: 0, z: 0 });
    assert.equal(w2.speed, 0);
  });
});

describe('physics3d.js — F04: quadratic air drag & 3D Magnus curve', () => {
  it('applies quadratic drag opposing vRel (headwind shortens carry, tailwind extends, kDrag=0 conserves vx)', () => {
    const baseBall = () =>
      createBallState({ pos: { x: -6, y: 3.5, z: 0 }, vel: { x: 10, y: 4.5, z: 0 } });
    const cfgNoMag = { ...PHYSICS_DEFAULTS, kMagnus: 0 };

    const bCalm = baseBall();
    const bHead = baseBall();
    const bTail = baseBall();
    stepUntilLanded(bCalm, createWindState({ windVec3: { x: 0, y: 0, z: 0 } }), cfgNoMag);
    stepUntilLanded(bHead, createWindState({ windVec3: { x: -6, y: 0, z: 0 } }), cfgNoMag);
    stepUntilLanded(bTail, createWindState({ windVec3: { x: 6, y: 0, z: 0 } }), cfgNoMag);

    assert.ok(bHead.pos.x < bCalm.pos.x - 0.5, 'headwind must shorten horizontal carry');
    assert.ok(bTail.pos.x > bCalm.pos.x + 0.5, 'tailwind must extend horizontal carry');

    // Resting ball pushed by 3D wind accelerates in wind direction
    const bHover = createBallState({ pos: { x: -3, y: 5, z: 0 }, vel: { x: 0, y: 0, z: 0 } });
    stepBall3D(bHover, createWindState({ windVec3: { x: 5, y: 0, z: -2 } }), cfgNoMag, FIXED_DT);
    assert.ok(bHover.vel.x > 0 && bHover.vel.z < 0);

    // Zero drag conserves horizontal velocity
    const bVac = createBallState({ pos: { x: -4, y: 6, z: 0 }, vel: { x: 9.5, y: 2, z: -1.5 } });
    for (let i = 0; i < 30; i++) {
      stepBall3D(bVac, createWindState({ windVec3: { x: -8, y: 0, z: 4 } }), {
        ...PHYSICS_DEFAULTS,
        kDrag: 0,
        kMagnus: 0,
      });
    }
    assert.ok(Math.abs(bVac.vel.x - 9.5) < 1e-12);
    assert.ok(Math.abs(bVac.vel.z + 1.5) < 1e-12);
  });

  it('produces symmetric topspin dive (-Y) and backspin float (+Y) in both +X and -X directions', () => {
    const calm = createWindState();

    function launch(dirX, topspinRadS) {
      const ball = createBallState({
        pos: { x: -dirX * 5.0, y: 4.5, z: 0 },
        vel: { x: dirX * 11.0, y: 3.5, z: 0 },
        omega: computeSpinOmega(dirX, 0, topspinRadS, 0),
      });
      const result = stepUntilLanded(ball, calm, PHYSICS_DEFAULTS);
      return { ball, steps: result.step, carry: Math.abs(ball.pos.x - -dirX * 5.0) };
    }

    const posZero = launch(+1, 0);
    const posTop = launch(+1, +18);
    const posBack = launch(+1, -18);

    const negZero = launch(-1, 0);
    const negTop = launch(-1, +18);
    const negBack = launch(-1, -18);

    // Topspin dives faster & lands shorter; backspin floats longer & lands farther
    assert.ok(posTop.steps < posZero.steps, `topspin +X must have shorter hang time (${posTop.steps} vs ${posZero.steps})`);
    assert.ok(posTop.carry < posZero.carry - 0.3, 'topspin +X must dive shorter');
    assert.ok(posBack.steps > posZero.steps, `backspin +X must float longer (${posBack.steps} vs ${posZero.steps})`);
    assert.ok(posBack.carry > posZero.carry + 0.3, 'backspin +X must carry farther');

    // Exact +X / -X symmetry
    assert.equal(posZero.steps, negZero.steps);
    assert.equal(posTop.steps, negTop.steps);
    assert.equal(posBack.steps, negBack.steps);
    assert.ok(Math.abs(posZero.carry - negZero.carry) < 1e-9);
    assert.ok(Math.abs(posTop.carry - negTop.carry) < 1e-9);
    assert.ok(Math.abs(posBack.carry - negBack.carry) < 1e-9);
  });

  it('curves laterally under sidespin and disables curve when kMagnus === 0', () => {
    const calm = createWindState();

    const bLeft = createBallState({
      pos: { x: -5, y: 4.0, z: 0 },
      vel: { x: 11, y: 3.0, z: 0 },
      omega: computeSpinOmega(1, 0, 0, +16),
    });
    const bRight = createBallState({
      pos: { x: -5, y: 4.0, z: 0 },
      vel: { x: 11, y: 3.0, z: 0 },
      omega: computeSpinOmega(1, 0, 0, -16),
    });
    const bZeroMag = createBallState({
      pos: { x: -5, y: 4.0, z: 0 },
      vel: { x: 11, y: 3.0, z: 0 },
      omega: computeSpinOmega(1, 0, +18, +16),
    });
    const bNoSpin = createBallState({
      pos: { x: -5, y: 4.0, z: 0 },
      vel: { x: 11, y: 3.0, z: 0 },
      omega: { x: 0, y: 0, z: 0 },
    });

    for (let i = 0; i < 60; i++) {
      stepBall3D(bLeft, calm, PHYSICS_DEFAULTS);
      stepBall3D(bRight, calm, PHYSICS_DEFAULTS);
      stepBall3D(bZeroMag, calm, { ...PHYSICS_DEFAULTS, kMagnus: 0 });
      stepBall3D(bNoSpin, calm, { ...PHYSICS_DEFAULTS, kMagnus: 0 });
    }

    assert.ok(bLeft.pos.z < -0.25, `sidespin +16 should curve toward -Z, got ${bLeft.pos.z}`);
    assert.ok(bRight.pos.z > 0.25, `sidespin -16 should curve toward +Z, got ${bRight.pos.z}`);
    assert.ok(Math.abs(bLeft.pos.z + bRight.pos.z) < 1e-9, 'sidespin hook must be symmetric');
    assert.deepStrictEqual(bZeroMag.pos, bNoSpin.pos, 'kMagnus=0 must match zero-spin control');
  });
});

describe('physics3d.js — F05: spin-reactive walls, net tape/mesh/posts & anti-tunneling', () => {
  it('applies symmetric spin-reactive vertical kicks on LEFT and RIGHT outer arcade walls while keeping ball live', () => {
    const cfg = { ...PHYSICS_DEFAULTS, kDrag: 0, kMagnus: 0 };
    const calm = createWindState();
    const r = BALL_SPEC.RADIUS;

    function bounceXWall(dirX, topspinRadS) {
      const wallX = dirX > 0 ? COURT.ARENA_HALF_X - r - 0.02 : -(COURT.ARENA_HALF_X - r - 0.02);
      const ball = createBallState({
        pos: { x: wallX, y: 4.0, z: 0 },
        vel: { x: dirX * 14.0, y: 0, z: 0 },
        omega: computeSpinOmega(dirX, 0, topspinRadS, 0),
      });
      const res = stepBall3D(ball, calm, cfg, FIXED_DT);
      return { ball, res };
    }

    const rZero = bounceXWall(+1, 0);
    const rTop = bounceXWall(+1, +18);
    const rBack = bounceXWall(+1, -18);

    const lZero = bounceXWall(-1, 0);
    const lTop = bounceXWall(-1, +18);
    const lBack = bounceXWall(-1, -18);

    assert.equal(rTop.res.landed, false, 'right wall bounce must keep ball live');
    assert.equal(rTop.res.wallHit?.wall, 'RIGHT');
    assert.equal(lTop.res.landed, false, 'left wall bounce must keep ball live');
    assert.equal(lTop.res.wallHit?.wall, 'LEFT');

    assert.ok(rTop.ball.vel.x < 0 && lTop.ball.vel.x > 0, 'normal velocity must reflect inward');
    assert.ok(rTop.ball.vel.y < rZero.ball.vel.y - 1.5, 'right wall topspin must kick downward (-Y)');
    assert.ok(lTop.ball.vel.y < lZero.ball.vel.y - 1.5, 'left wall topspin must kick downward (-Y)');
    assert.ok(rBack.ball.vel.y > rZero.ball.vel.y + 1.5, 'right wall backspin must kick upward (+Y)');
    assert.ok(lBack.ball.vel.y > lZero.ball.vel.y + 1.5, 'left wall backspin must kick upward (+Y)');

    assert.ok(Math.abs(rTop.ball.vel.y - lTop.ball.vel.y) < 1e-9, 'topspin wall kick must be left/right symmetric');
    assert.ok(Math.abs(rBack.ball.vel.y - lBack.ball.vel.y) < 1e-9, 'backspin wall kick must be left/right symmetric');
  });

  it('rebounds off NEAR, FAR, and CEILING walls and enforces corner arena bounds', () => {
    const calm = createWindState();
    const r = BALL_SPEC.RADIUS;

    const bNear = createBallState({ pos: { x: 2, y: 4, z: COURT.ARENA_HALF_Z - r - 0.01 }, vel: { x: 0, y: 0, z: 12 } });
    const resNear = stepBall3D(bNear, calm, PHYSICS_DEFAULTS);
    assert.equal(resNear.landed, false);
    assert.equal(resNear.wallHit?.wall, 'NEAR');
    assert.ok(bNear.vel.z < 0 && bNear.pos.z <= COURT.ARENA_HALF_Z - r);

    const bFar = createBallState({ pos: { x: 2, y: 4, z: -(COURT.ARENA_HALF_Z - r - 0.01) }, vel: { x: 0, y: 0, z: -12 } });
    const resFar = stepBall3D(bFar, calm, PHYSICS_DEFAULTS);
    assert.equal(resFar.landed, false);
    assert.equal(resFar.wallHit?.wall, 'FAR');
    assert.ok(bFar.vel.z > 0 && bFar.pos.z >= -(COURT.ARENA_HALF_Z - r));

    const bCeil = createBallState({ pos: { x: 0, y: COURT.CEILING_Y - r - 0.01, z: 0 }, vel: { x: 0, y: 15, z: 0 } });
    const resCeil = stepBall3D(bCeil, calm, PHYSICS_DEFAULTS);
    assert.equal(resCeil.landed, false);
    assert.equal(resCeil.wallHit?.wall, 'CEILING');
    assert.ok(bCeil.vel.y < 0 && bCeil.pos.y <= COURT.CEILING_Y - r);

    // Corner multi-wall clamp
    const bCorner = createBallState({
      pos: { x: COURT.ARENA_HALF_X - r - 0.01, y: COURT.CEILING_Y - r - 0.01, z: COURT.ARENA_HALF_Z - r - 0.01 },
      vel: { x: 20, y: 20, z: 20 },
    });
    const resCorner = stepBall3D(bCorner, calm, PHYSICS_DEFAULTS);
    assert.equal(resCorner.landed, false);
    assert.ok(bCorner.pos.x <= COURT.ARENA_HALF_X - r);
    assert.ok(bCorner.pos.y <= COURT.CEILING_Y - r);
    assert.ok(bCorner.pos.z <= COURT.ARENA_HALF_Z - r);
    assert.ok(bCorner.vel.x < 0 && bCorner.vel.y < 0 && bCorner.vel.z < 0);
  });

  it('deflects off rounded net tape, deadens on net mesh, deflects off net posts, and allows around-the-post clears', () => {
    const cfg = { ...PHYSICS_DEFAULTS, kDrag: 0, kMagnus: 0 };
    const calm = createWindState();

    // 1. Head-on rounded net tape hit at y = NET_HEIGHT (2.38)
    const bTape = createBallState({ pos: { x: -0.35, y: COURT.NET_HEIGHT, z: 0 }, vel: { x: 14, y: 0, z: 0 } });
    const resTape = stepBall3D(bTape, calm, cfg);
    assert.equal(resTape.netHit?.part, 'TAPE');
    assert.equal(resTape.crossedNet, false);
    assert.ok(bTape.vel.x < 0, 'head-on tape hit must rebound back to -X');
    assert.ok(Math.abs(bTape.vel.x + 14 * cfg.eNetTape) < 0.3, `expected ~eNetTape rebound, got ${bTape.vel.x}`);

    // 2. High grazing hit on top of rounded tape deflects upward/forward (dribble over)
    const bGraze = createBallState({ pos: { x: -0.25, y: COURT.NET_HEIGHT + 0.25, z: 0 }, vel: { x: 12, y: 0, z: 0 } });
    const resGraze = stepBall3D(bGraze, calm, cfg);
    assert.equal(resGraze.netHit?.part, 'TAPE');
    assert.ok(bGraze.vel.y > 1.0, `high tape graze must deflect upward (+Y), got vy=${bGraze.vel.y}`);

    // 3. Soft net mesh rebound (eNetMesh = 0.35)
    const bMesh = createBallState({ pos: { x: -0.28, y: 1.4, z: 0 }, vel: { x: 10, y: 0, z: 0 } });
    const resMesh = stepBall3D(bMesh, calm, cfg);
    assert.equal(resMesh.netHit?.part, 'MESH');
    assert.equal(resMesh.crossedNet, false);
    assert.ok(bMesh.pos.x < 0 && bMesh.vel.x < 0);
    assert.ok(Math.abs(bMesh.vel.x + 10 * cfg.eNetMesh) < 0.2, `expected ~eNetMesh rebound, got ${bMesh.vel.x}`);

    // 4. Vertical net post at z = +NET_HALF_Z (4.5)
    const bPost = createBallState({ pos: { x: -0.35, y: 1.5, z: COURT.NET_HALF_Z }, vel: { x: 14, y: 0, z: 0 } });
    const resPost = stepBall3D(bPost, calm, cfg);
    assert.equal(resPost.netHit?.part, 'POST');
    assert.equal(resPost.crossedNet, false);
    assert.ok(bPost.vel.x < 0);

    // 5. Around-the-post clear (|z| > NET_HALF_Z + NET_POST_RADIUS + radius = 4.81)
    const bAround = createBallState({ pos: { x: -0.05, y: 1.5, z: 5.1 }, vel: { x: 14, y: 0, z: 0 } });
    const resAround = stepBall3D(bAround, calm, cfg);
    assert.equal(resAround.netHit, null);
    assert.equal(resAround.crossedNet, true);
    assert.ok(bAround.pos.x > 0);

    // 6. Clean clear over the net tape
    const bOver = createBallState({ pos: { x: -0.05, y: COURT.NET_HEIGHT + 0.6, z: 0 }, vel: { x: 14, y: 0, z: 0 } });
    const resOver = stepBall3D(bOver, calm, cfg);
    assert.equal(resOver.netHit, null);
    assert.equal(resOver.crossedNet, true);
    assert.ok(bOver.pos.x > 0);
  });

  it('prevents net tunneling for high-speed Heat Spikes at 35 m/s and 60 m/s', () => {
    const calm = createWindState();
    for (const speedX of [35, 60]) {
      // Mesh anti-tunneling
      const bMesh = createBallState({ pos: { x: -0.15, y: 1.5, z: 0 }, vel: { x: speedX, y: 0, z: 0 } });
      const resMesh = stepBall3D(bMesh, calm, PHYSICS_DEFAULTS);
      assert.equal(resMesh.netHit?.part, 'MESH', `speed ${speedX} m/s must hit MESH`);
      assert.equal(resMesh.crossedNet, false, `speed ${speedX} m/s must not tunnel through MESH`);
      assert.ok(bMesh.pos.x < 0 && bMesh.vel.x < 0);

      // Tape anti-tunneling
      const bTape = createBallState({ pos: { x: -0.15, y: COURT.NET_HEIGHT, z: 0 }, vel: { x: speedX, y: 0, z: 0 } });
      const resTape = stepBall3D(bTape, calm, PHYSICS_DEFAULTS);
      assert.equal(resTape.netHit?.part, 'TAPE', `speed ${speedX} m/s must hit TAPE`);
      assert.equal(resTape.crossedNet, false, `speed ${speedX} m/s must not tunnel through TAPE`);
      assert.ok(bTape.pos.x < 0 && bTape.vel.x < 0);
    }
  });

  it('clamps sand floor impact to y === radius and prevents sinking', () => {
    const ball = createBallState({ pos: { x: 2, y: 0.25, z: 0 }, vel: { x: 3, y: -8, z: 0 } });
    const res = stepBall3D(ball, createWindState(), PHYSICS_DEFAULTS);
    assert.equal(res.landed, true);
    assert.equal(ball.pos.y, COURT.SAND_Y + BALL_SPEC.RADIUS);
    assert.ok(ball.vel.y >= 0);
    assert.ok(Number.isFinite(res.speed));
  });
});

describe('physics3d.js — F06: predictLandingPoint3D purity, accuracy & Sky Lob analytic tail', () => {
  it('never mutates ballState, windState, or physicsConfig', () => {
    const ball = createBallState({
      pos: { x: -4.2, y: 3.1, z: 1.3 },
      vel: { x: 9.8, y: 5.4, z: -2.1 },
      omega: computeSpinOmega(9.8, -2.1, 14, -6),
      spinAngle: { x: 0.3, y: 0.5, z: 0.7 },
    });
    const wind = createWindState({
      time: 4.5,
      phase: WIND_PHASES.GUST,
      timer: 2.3,
      windVec3: { x: -5.2, y: 0.1, z: 1.8 },
      gustTargetVec3: { x: -5.8, y: 0.2, z: 1.9 },
      speed: 5.5,
    });
    const cfg = { ...PHYSICS_DEFAULTS };

    const ballBefore = structuredClone(ball);
    const windBefore = structuredClone(wind);
    const cfgBefore = structuredClone(cfg);

    const pred = predictLandingPoint3D(ball, wind, cfg);

    assert.deepStrictEqual(ball, ballBefore);
    assert.deepStrictEqual(wind, windBefore);
    assert.deepStrictEqual(cfg, cfgBefore);
    assert.ok(Number.isFinite(pred.x) && Number.isFinite(pred.z) && Number.isFinite(pred.hangTime));
  });

  it('matches constant-wind stepBall3D rollout to sub-millimeter precision on curved shots', () => {
    const ball = createBallState({
      pos: { x: -5.2, y: 3.4, z: -0.8 },
      vel: { x: 10.5, y: 4.2, z: 1.6 },
      omega: computeSpinOmega(10.5, 1.6, 12, 8),
    });
    const wind = createWindState({ windVec3: { x: -3.6, y: 0.1, z: 1.9 } });

    const pred = predictLandingPoint3D(ball, wind, PHYSICS_DEFAULTS);
    assert.equal(pred.landedWithinSteps, true);
    assert.ok(pred.steps > 0 && pred.steps <= MAX_PREDICT_STEPS);

    const rolloutBall = structuredClone(ball);
    const { step, prevX, prevZ, res } = stepUntilLanded(rolloutBall, wind, PHYSICS_DEFAULTS);
    assert.equal(res.landed, true);
    assert.equal(pred.steps, step);
    // Interpolated landing lies on the exact landing step segment [prev -> final]
    const minSegX = Math.min(prevX, rolloutBall.pos.x) - 1e-9;
    const maxSegX = Math.max(prevX, rolloutBall.pos.x) + 1e-9;
    const minSegZ = Math.min(prevZ, rolloutBall.pos.z) - 1e-9;
    const maxSegZ = Math.max(prevZ, rolloutBall.pos.z) + 1e-9;
    assert.ok(pred.x >= minSegX && pred.x <= maxSegX, `pred.x=${pred.x} outside [${minSegX}, ${maxSegX}]`);
    assert.ok(pred.z >= minSegZ && pred.z <= maxSegZ, `pred.z=${pred.z} outside [${minSegZ}, ${maxSegZ}]`);
    assert.ok(pred.hangTime >= (step - 1) * FIXED_DT - 1e-9 && pred.hangTime <= step * FIXED_DT + 1e-9);
    const lastPt = pred.trajectory[pred.trajectory.length - 1];
    assert.equal(lastPt.y, BALL_SPEC.RADIUS);
    assert.equal(lastPt.x, pred.x);
    assert.equal(lastPt.z, pred.z);
  });

  it('predicts spin-reactive outer wall rebounds accurately', () => {
    const ball = createBallState({
      pos: { x: 8.5, y: 3.5, z: 1.0 },
      vel: { x: 14.0, y: 2.0, z: 0.5 },
      omega: computeSpinOmega(1, 0, 15, 0),
    });
    const wind = createWindState();

    const pred = predictLandingPoint3D(ball, wind, PHYSICS_DEFAULTS);
    assert.equal(pred.landedWithinSteps, true);
    assert.ok(pred.x < COURT.ARENA_HALF_X - BALL_SPEC.RADIUS, 'wall-rebounded landing should bounce back inward');

    const rolloutBall = structuredClone(ball);
    const { step } = stepUntilLanded(rolloutBall, wind, PHYSICS_DEFAULTS);
    assert.equal(pred.steps, step);
    assert.ok(Math.abs(pred.x - rolloutBall.pos.x) < 0.12);
    assert.ok(Math.abs(pred.z - rolloutBall.pos.z) < 0.12);
  });

  it('uses analytic quadratic ballistic tail for high Sky Lobs exceeding 180 steps', () => {
    const skyLob = createBallState({
      pos: { x: -3.0, y: 2.5, z: 0.5 },
      vel: { x: 4.0, y: 14.5, z: 1.0 },
    });
    const wind = createWindState({ windVec3: { x: 1.2, y: 0, z: -0.5 } });

    const pred = predictLandingPoint3D(skyLob, wind, PHYSICS_DEFAULTS, MAX_PREDICT_STEPS);
    assert.equal(pred.landedWithinSteps, false);
    assert.equal(pred.steps, MAX_PREDICT_STEPS);
    assert.ok(pred.hangTime > MAX_PREDICT_STEPS * FIXED_DT, `expected hangTime > 1.5s, got ${pred.hangTime}`);
    assert.ok(Math.abs(pred.x) <= COURT.ARENA_HALF_X - BALL_SPEC.RADIUS);
    assert.ok(Math.abs(pred.z) <= COURT.ARENA_HALF_Z - BALL_SPEC.RADIUS);
    const lastPt = pred.trajectory[pred.trajectory.length - 1];
    assert.equal(lastPt.y, BALL_SPEC.RADIUS);
    assert.equal(lastPt.x, pred.x);
    assert.equal(lastPt.z, pred.z);
  });

  it('handles already-landed ball and maxSteps === 0 cleanly', () => {
    const landedBall = createBallState({ pos: { x: 3.2, y: BALL_SPEC.RADIUS, z: -1.4 }, vel: { x: 5, y: 0, z: 0 } });
    const predLanded = predictLandingPoint3D(landedBall, createWindState(), PHYSICS_DEFAULTS);
    assert.equal(predLanded.landedWithinSteps, true);
    assert.equal(predLanded.steps, 0);
    assert.equal(predLanded.hangTime, 0);
    assert.equal(predLanded.x, 3.2);
    assert.equal(predLanded.z, -1.4);

    // maxSteps = 0 triggers analytic tail directly
    const airBall = createBallState({ pos: { x: 0, y: 2.22, z: 0 }, vel: { x: 3, y: 0, z: -2 } });
    const predZero = predictLandingPoint3D(airBall, createWindState(), { ...PHYSICS_DEFAULTS, gravity: 10 }, 0);
    assert.equal(predZero.landedWithinSteps, false);
    assert.equal(predZero.steps, 0);
    const expectedT = Math.sqrt((2 * 2.0) / 10);
    assert.ok(Math.abs(predZero.hangTime - expectedT) < 1e-9);
    assert.ok(Math.abs(predZero.x - 3 * expectedT) < 1e-9);
    assert.ok(Math.abs(predZero.z - -2 * expectedT) < 1e-9);
  });
});

describe('physics3d.js — defensive numeric & corrupt input guards', () => {
  it('sanitizes NaN, Infinity, null, and corrupt configs without throwing or emitting NaN', () => {
    const badWind = {
      time: Number.NaN,
      phase: 'BROKEN_PHASE',
      timer: Number.POSITIVE_INFINITY,
      windVec3: { x: Number.NaN, y: Number.NEGATIVE_INFINITY, z: undefined },
      gustTargetVec3: null,
      speed: Number.NaN,
    };
    const badCfg = { gravity: Number.NaN, kDrag: 'oops', kMagnus: Infinity, gustScale: -5 };

    triggerGaleSurge(badWind, Number.NaN);
    assertAllFiniteVec3(badWind.gustTargetVec3, 'badWind.gustTargetVec3');
    const windOut = updateWind3D(badWind, Number.NaN, badCfg);
    assertAllFiniteVec3(windOut.windVec3, 'windOut.windVec3');
    assert.ok(Number.isFinite(badWind.speed));

    const badBall = {
      pos: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: -Infinity },
      vel: { x: Number.NaN, y: undefined, z: Infinity },
      omega: { x: Infinity, y: Number.NaN, z: 999 },
      radius: -5,
      spinAngle: { x: Number.NaN, y: 0, z: 0 },
    };
    const stepOut = stepBall3D(badBall, badWind, badCfg, FIXED_DT, false);
    assertAllFiniteVec3(badBall.pos, 'badBall.pos');
    assertAllFiniteVec3(badBall.vel, 'badBall.vel');
    assertAllFiniteVec3(badBall.omega, 'badBall.omega');
    assert.ok(Number.isFinite(stepOut.speed));

    const predOut = predictLandingPoint3D(
      { pos: { x: Number.NaN, y: 4, z: Infinity }, vel: { x: Infinity, y: Number.NaN, z: 0 }, omega: null },
      null,
      badCfg,
      Number.NaN,
    );
    assert.ok(Number.isFinite(predOut.x));
    assert.ok(Number.isFinite(predOut.z));
    assert.ok(Number.isFinite(predOut.hangTime));
    assert.ok(predOut.trajectory.length >= 1);
    for (const pt of predOut.trajectory) {
      assertAllFiniteVec3(pt, 'trajectory point');
    }
  });

  it('hardens extreme radius, astronomical finite velocity, wind overflow, negative wind speed, wall vn>=0, and tail ceiling clamp', () => {
    const calm = createWindState();

    // 1. Out-of-bounds spawn moving inward (vn >= 0) clamps cleanly without emitting a zero-impact wallHit
    const bSpawnOut = createBallState({
      pos: { x: COURT.ARENA_HALF_X + 1.0, y: 4.0, z: 0 },
      vel: { x: -5.0, y: 0, z: 0 },
    });
    const rSpawnOut = stepBall3D(bSpawnOut, calm, PHYSICS_DEFAULTS, FIXED_DT);
    assert.equal(rSpawnOut.wallHit, null, 'inward-moving wall clamp must not emit zero-impact wallHit');
    assert.ok(bSpawnOut.pos.x <= COURT.ARENA_HALF_X - BALL_SPEC.RADIUS + 1e-9);

    // 2. Absurd radius > arena half-width is clamped safely without inverting arena bounds
    const bHuge = createBallState({ pos: { x: 0, y: 5, z: 0 }, vel: { x: 8, y: 0, z: 0 }, radius: 100 });
    stepBall3D(bHuge, calm, PHYSICS_DEFAULTS, FIXED_DT);
    assert.ok(Math.abs(bHuge.pos.x) <= COURT.ARENA_HALF_X);
    assert.ok(Math.abs(bHuge.pos.z) <= COURT.ARENA_HALF_Z);

    // 3. Astronomical finite velocity does not emit Infinity/NaN in pos, vel, speed, wallHit, or netHit
    const bAstro = createBallState({
      pos: { x: -1, y: 3, z: 0 },
      vel: { x: 1e200, y: 1e200, z: -1e200 },
    });
    const rAstro = stepBall3D(bAstro, { windVec3: { x: -1e200, y: 0, z: 0 } }, PHYSICS_DEFAULTS, FIXED_DT);
    assertAllFiniteVec3(bAstro.pos, 'bAstro.pos');
    assertAllFiniteVec3(bAstro.vel, 'bAstro.vel');
    assert.ok(Number.isFinite(rAstro.speed));
    if (rAstro.wallHit) {
      assert.ok(Number.isFinite(rAstro.wallHit.impactSpeed));
      assertAllFiniteVec3(rAstro.wallHit.point, 'rAstro.wallHit.point');
    }
    if (rAstro.netHit) {
      assert.ok(Number.isFinite(rAstro.netHit.impactSpeed));
      assertAllFiniteVec3(rAstro.netHit.point, 'rAstro.netHit.point');
    }

    // 4. triggerGaleSurge sanitizes negative windState.speed; updateWind3D prevents time Infinity overflow
    const wExtreme = createWindState({ time: 1e308, speed: -5 });
    triggerGaleSurge(wExtreme, +1);
    assert.ok(Number.isFinite(wExtreme.speed) && wExtreme.speed >= 0);
    updateWind3D(wExtreme, 1e308, PHYSICS_DEFAULTS);
    assert.ok(Number.isFinite(wExtreme.time));
    assert.ok(Number.isFinite(wExtreme.speed) && wExtreme.speed >= 0);

    // 5. predictLandingPoint3D analytic tail clamps intermediate py to [floorY, CEILING_Y - r]
    const bRocket = createBallState({ pos: { x: 0, y: 10, z: 0 }, vel: { x: 2, y: 30, z: 0 } });
    const predRocket = predictLandingPoint3D(bRocket, calm, PHYSICS_DEFAULTS, 0);
    const maxY = COURT.CEILING_Y - BALL_SPEC.RADIUS;
    for (const pt of predRocket.trajectory) {
      assert.ok(pt.y >= BALL_SPEC.RADIUS - 1e-9 && pt.y <= maxY + 1e-9, `tail py=${pt.y} out of bounds`);
    }
  });
});

describe('physics3d.js — multi-step net collision & predictor parity regression suite', () => {
  it('separates cleanly after head-on net tape hits, lands well before 180 steps, and matches predictLandingPoint3D', () => {
    const calm = createWindState();
    const cases = [
      { pos: { x: -0.45, y: 2.40, z: 0 }, vel: { x: 22, y: 0, z: 0 } },
      { pos: { x: -0.35, y: COURT.NET_HEIGHT, z: 0 }, vel: { x: 14, y: 0, z: 0 } },
    ];

    for (const fixture of cases) {
      const ball = createBallState(fixture);
      const pred = predictLandingPoint3D(ball, calm, PHYSICS_DEFAULTS);
      assert.equal(pred.landedWithinSteps, true, `head-on tape hit must land within 180 steps (x0=${fixture.pos.x})`);
      assert.ok(pred.steps < 140, `expected landing well before 180 steps, got ${pred.steps}`);
      assert.ok(pred.x < -1.0, `head-on tape rebound must land back in -X court, got x=${pred.x}`);

      let tapeHits = 0;
      let landedStep = -1;
      let prevX = ball.pos.x;
      let prevZ = ball.pos.z;
      for (let s = 1; s <= 180; s++) {
        prevX = ball.pos.x;
        prevZ = ball.pos.z;
        const r = stepBall3D(ball, calm, PHYSICS_DEFAULTS, FIXED_DT);
        if (r.netHit?.part === 'TAPE') {
          tapeHits++;
          assert.equal(r.crossedNet, false, 'head-on tape bounce-back must never set crossedNet=true');
        }
        if (r.landed) {
          landedStep = s;
          break;
        }
      }

      assert.equal(tapeHits, 1, `expected exactly 1 clean TAPE hit, got ${tapeHits}`);
      assert.equal(landedStep, pred.steps, 'rollout landing step must match predictLandingPoint3D');
      assert.ok(
        pred.x >= Math.min(prevX, ball.pos.x) - 1e-9 && pred.x <= Math.max(prevX, ball.pos.x) + 1e-9,
        `pred.x=${pred.x} outside final step segment [${prevX}, ${ball.pos.x}]`,
      );
      assert.ok(
        pred.z >= Math.min(prevZ, ball.pos.z) - 1e-9 && pred.z <= Math.max(prevZ, ball.pos.z) + 1e-9,
        `pred.z=${pred.z} outside final step segment [${prevZ}, ${ball.pos.z}]`,
      );
    }
  });

  it('never freezes across off-center/angled net tape grid (dy in [-0.25, +0.28]) and vertical apex drop', () => {
    const calm = createWindState();
    let observedTapeHits = 0;

    for (let dy = -0.25; dy <= 0.28 + 1e-9; dy += 0.025) {
      const ball = createBallState({
        pos: { x: -0.45, y: COURT.NET_HEIGHT + dy, z: 0 },
        vel: { x: 16, y: dy * -2, z: 1.5 },
        omega: computeSpinOmega(16, 1.5, 14, -5),
      });
      const pred = predictLandingPoint3D(ball, calm, PHYSICS_DEFAULTS);
      let hitTape = false;
      let hitCount = 0;
      let landedStep = -1;
      for (let s = 1; s <= 400; s++) {
        const r = stepBall3D(ball, calm, PHYSICS_DEFAULTS, FIXED_DT);
        if (r.netHit?.part === 'TAPE') {
          hitTape = true;
          hitCount++;
          if (ball.vel.x < 0) {
            assert.equal(r.crossedNet, false, `bounce-back at dy=${dy} must not set crossedNet=true`);
          }
        }
        if (r.landed) {
          landedStep = s;
          break;
        }
      }
      assert.ok(landedStep > 0, `ball stuck in mid-air at dy=${dy}`);
      assert.ok(hitCount <= 3, `phantom repeated tape hits (${hitCount}) at dy=${dy}`);
      if (hitTape) {
        observedTapeHits++;
        if (pred.landedWithinSteps) {
          assert.equal(pred.steps, landedStep, `predictor step mismatch at dy=${dy}`);
        } else {
          assert.ok(landedStep > MAX_PREDICT_STEPS, `predictor missed landing at dy=${dy}`);
        }
      }
    }
    assert.ok(observedTapeHits >= 12, `expected broad tape hit coverage, observed ${observedTapeHits}`);

    // Vertical apex drop onto exact top of net tape
    const bApex = createBallState({ pos: { x: 0, y: 2.73, z: 0 }, vel: { x: 0, y: -10, z: 0 } });
    let maxPostBounceY = 0;
    let apexTapeHits = 0;
    for (let s = 1; s <= 120; s++) {
      const r = stepBall3D(bApex, calm, PHYSICS_DEFAULTS, FIXED_DT);
      if (r.netHit?.part === 'TAPE') apexTapeHits++;
      if (apexTapeHits >= 1) {
        maxPostBounceY = Math.max(maxPostBounceY, bApex.pos.y);
      }
    }
    assert.ok(apexTapeHits >= 1 && apexTapeHits <= 2, `expected clean apex bounce(s), got ${apexTapeHits}`);
    assert.ok(maxPostBounceY > 4.0, `vertical tape drop must rebound cleanly upward, got maxY=${maxPostBounceY}`);
  });

  it('never freezes on net post shaft hits (dz in [-0.20, +0.20]) or spherical post top-cap hits and matches predictor', () => {
    const calm = createWindState();
    let shaftHits = 0;
    let capHits = 0;

    // Post shaft sweep
    for (let dz = -0.20; dz <= 0.20 + 1e-9; dz += 0.04) {
      const ball = createBallState({
        pos: { x: -0.45, y: 1.5, z: COURT.NET_HALF_Z + dz },
        vel: { x: 16, y: 0, z: 0 },
      });
      const pred = predictLandingPoint3D(ball, calm, PHYSICS_DEFAULTS);
      let hitPost = false;
      let hitCount = 0;
      let landedStep = -1;
      for (let s = 1; s <= 400; s++) {
        const r = stepBall3D(ball, calm, PHYSICS_DEFAULTS, FIXED_DT);
        if (r.netHit?.part === 'POST') {
          hitPost = true;
          hitCount++;
          if (ball.vel.x < 0) {
            assert.equal(r.crossedNet, false, `post shaft bounce-back at dz=${dz} must not set crossedNet=true`);
          }
        }
        if (r.landed) {
          landedStep = s;
          break;
        }
      }
      assert.ok(landedStep > 0, `ball froze on post shaft at dz=${dz}`);
      assert.ok(hitCount <= 3, `phantom post shaft hits (${hitCount}) at dz=${dz}`);
      if (hitPost) {
        shaftHits++;
        assert.equal(pred.landedWithinSteps, landedStep <= MAX_PREDICT_STEPS);
        if (pred.landedWithinSteps) {
          assert.equal(pred.steps, landedStep, `post shaft predictor mismatch at dz=${dz}`);
        }
      }
    }
    assert.ok(shaftHits >= 8, `expected post shaft hits across sweep, got ${shaftHits}`);

    // Spherical post top-cap sweep
    for (let y = 2.40; y <= 2.66 + 1e-9; y += 0.026) {
      const ball = createBallState({
        pos: { x: -0.45, y, z: COURT.NET_HALF_Z },
        vel: { x: 14, y: 0, z: 0 },
      });
      const pred = predictLandingPoint3D(ball, calm, PHYSICS_DEFAULTS);
      let hitPost = false;
      let hitCount = 0;
      let landedStep = -1;
      for (let s = 1; s <= 400; s++) {
        const r = stepBall3D(ball, calm, PHYSICS_DEFAULTS, FIXED_DT);
        if (r.netHit?.part === 'POST') {
          hitPost = true;
          hitCount++;
        }
        if (r.landed) {
          landedStep = s;
          break;
        }
      }
      assert.ok(landedStep > 0, `ball froze on post top-cap at y=${y}`);
      assert.ok(hitCount <= 3, `phantom post top-cap hits (${hitCount}) at y=${y}`);
      if (hitPost) {
        capHits++;
        assert.equal(pred.landedWithinSteps, landedStep <= MAX_PREDICT_STEPS);
        if (pred.landedWithinSteps) {
          assert.equal(pred.steps, landedStep, `post top-cap predictor mismatch at y=${y}`);
        }
      }
    }
    assert.ok(capHits >= 8, `expected post top-cap hits across sweep, got ${capHits}`);
  });

  it('handles net mesh eNetMesh=0, preserves pos.y/pos.z on inside-slab vn>=0 separation, and does not shadow mesh under tape', () => {
    const calm = createWindState();

    // 1. eNetMesh === 0 dead-drop without sticking or repeated hits
    const bZero = createBallState({ pos: { x: -0.35, y: 1.5, z: 0 }, vel: { x: 12, y: 0, z: 0 } });
    const predZero = predictLandingPoint3D(bZero, calm, { ...PHYSICS_DEFAULTS, eNetMesh: 0 });
    let meshHits = 0;
    let landedStep = -1;
    for (let s = 1; s <= 250; s++) {
      const r = stepBall3D(bZero, calm, { ...PHYSICS_DEFAULTS, eNetMesh: 0 }, FIXED_DT);
      if (r.netHit?.part === 'MESH') {
        meshHits++;
        assert.equal(r.crossedNet, false);
      }
      if (r.landed) {
        landedStep = s;
        break;
      }
    }
    assert.equal(meshHits, 1, `expected 1 clean MESH hit with eNetMesh=0, got ${meshHits}`);
    assert.ok(landedStep > 0 && landedStep <= MAX_PREDICT_STEPS);
    assert.equal(predZero.landedWithinSteps, true);
    assert.equal(predZero.steps, landedStep);

    // 2. Inside-slab escaping ball (vn >= 0): pos.x depenetrates while pos.y and pos.z continue smoothly
    const cfgNoAero = { ...PHYSICS_DEFAULTS, kDrag: 0, kMagnus: 0 };
    const bSep = createBallState({ pos: { x: -0.20, y: 1.80, z: 1.0 }, vel: { x: -2.0, y: -5.0, z: 3.0 } });
    const rSep = stepBall3D(bSep, calm, cfgNoAero, FIXED_DT);
    assert.equal(rSep.netHit, null, 'separating inside-slab ball must not report a MESH collision');
    assert.ok(bSep.pos.x < -0.25, `expected pos.x depenetrated outside mesh slab, got ${bSep.pos.x}`);
    const expectedY = 1.80 + (-5.0 - cfgNoAero.gravity * FIXED_DT) * FIXED_DT;
    const expectedZ = 1.0 + 3.0 * FIXED_DT;
    assert.ok(Math.abs(bSep.pos.y - expectedY) < 1e-12, `pos.y frozen: expected ${expectedY}, got ${bSep.pos.y}`);
    assert.ok(Math.abs(bSep.pos.z - expectedZ) < 1e-12, `pos.z frozen: expected ${expectedZ}, got ${bSep.pos.z}`);

    // 3. Ball touching underside of tape moving away from tape into mesh must hit MESH (no spurious tTape=0 shadowing)
    const tapeR = BALL_SPEC.RADIUS + COURT.NET_TAPE_RADIUS;
    const yOnUnderside = COURT.NET_HEIGHT - Math.sqrt(tapeR * tapeR - 0.26 * 0.26);
    const bUnder = createBallState({ pos: { x: -0.26, y: yOnUnderside, z: 0 }, vel: { x: 4, y: -12, z: 0 } });
    const rUnder = stepBall3D(bUnder, calm, cfgNoAero, FIXED_DT);
    assert.equal(rUnder.netHit?.part, 'MESH', 'underside tape separation must not shadow real MESH hit');
    assert.ok(bUnder.vel.x < 0, 'real MESH hit must reflect vel.x back to -X');
  });

  it('completes 2,000-step multi-bounce endurance rally across net tape/post/mesh/walls with zero freezes or NaN', () => {
    const wind = createWindState();
    const ball = createBallState({
      pos: { x: -4.0, y: 2.5, z: 0 },
      vel: { x: 13.0, y: 2.5, z: 1.0 },
      omega: computeSpinOmega(13, 1, 16, 5),
    });

    let relaunches = 0;
    let totalNetHits = 0;
    let totalWallHits = 0;
    let consecNetHits = 0;
    let maxConsecNetHits = 0;

    for (let s = 1; s <= 2000; s++) {
      updateWind3D(wind, FIXED_DT, PHYSICS_DEFAULTS);
      const r = stepBall3D(ball, wind, PHYSICS_DEFAULTS, FIXED_DT);
      if (r.wallHit) totalWallHits++;
      if (r.netHit) {
        totalNetHits++;
        consecNetHits++;
        maxConsecNetHits = Math.max(maxConsecNetHits, consecNetHits);
      } else {
        consecNetHits = 0;
      }

      assertAllFiniteVec3(ball.pos, `step ${s} pos`);
      assertAllFiniteVec3(ball.vel, `step ${s} vel`);
      assertAllFiniteVec3(ball.omega, `step ${s} omega`);
      assert.ok(Number.isFinite(r.speed), `step ${s} speed must be finite`);
      assert.ok(Math.abs(ball.pos.x) <= COURT.ARENA_HALF_X - BALL_SPEC.RADIUS + 1e-9);
      assert.ok(Math.abs(ball.pos.z) <= COURT.ARENA_HALF_Z - BALL_SPEC.RADIUS + 1e-9);
      assert.ok(ball.pos.y >= BALL_SPEC.RADIUS - 1e-9 && ball.pos.y <= COURT.CEILING_Y - BALL_SPEC.RADIUS + 1e-9);

      if (r.landed) {
        relaunches++;
        const dir = ball.pos.x < 0 ? 1 : -1;
        ball.pos.y = 1.6;
        ball.vel.x = dir * (10 + (s % 12));
        ball.vel.y = 3.2 + ((s * 7) % 6) * 0.65;
        ball.vel.z = ((s % 9) - 4) * 1.25;
        const sp = computeSpinOmega(ball.vel.x, ball.vel.z, ((s % 5) - 2) * 9, ((s % 3) - 1) * 7);
        ball.omega.x = sp.x;
        ball.omega.y = sp.y;
        ball.omega.z = sp.z;
      }
    }

    assert.ok(relaunches >= 10, `expected repeated rally cycles without freezing, got ${relaunches}`);
    assert.ok(totalNetHits >= 1, `expected net interactions during rally, got ${totalNetHits}`);
    assert.ok(totalWallHits >= 1, `expected wall interactions during rally, got ${totalWallHits}`);
    assert.ok(maxConsecNetHits <= 2, `phantom net hit loop detected (max consecutive=${maxConsecNetHits})`);
  });
});

