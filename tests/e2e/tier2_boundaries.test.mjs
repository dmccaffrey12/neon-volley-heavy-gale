/**
 * Tier 2 — Boundary Value Analysis & Corner Cases (Opaque-Box E2E Suite)
 *
 * Covers 28 boundary & resilience tests across Areas A-E (>= 5 per major
 * feature area) strictly derived from ORIGINAL_REQUEST.md, PROJECT.md,
 * AGENTS.md, and src/contracts.js.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as Contracts from '../../src/contracts.js';
import {
  installInputShims,
  installAudioContextSpy,
  createMemoryStorage,
  createMockGamepad,
  readScores,
  readTimingRing,
  readTouchCount,
  extractEventTypes,
  makeIdleInputs,
  assertFiniteVec3,
  createBotController,
} from './_helpers/browserShims.mjs';

const {
  FIXED_DT,
  MAX_PREDICT_STEPS,
  COURT,
  BALL_SPEC,
  PHYSICS_DEFAULTS,
  PHYSICS_LIMITS,
  STORAGE_KEYS,
  INPUT_MODES,
  AI_STYLES,
  MATCH_FORMATS,
  ANIM_STATES,
  SHOT_TYPES,
  EVENTS,
  computeSpinOmega,
  createBallState,
  createWindState,
  createPlayerState,
  createDefaultBindings,
  sanitizePhysicsConfig,
} = Contracts;

/* ========================================================================== *
 * AREA A — Physics & Predictor Boundaries (src/physics3d.js)
 * ========================================================================== */
describe('Tier 2 — Area A: Physics & Predictor Boundaries (src/physics3d.js)', () => {
  let physics;

  before(async () => {
    physics = await import('../../src/physics3d.js');
  });

  it('T2-A1: Sky Lob (> 1.50s) triggers analytic quadratic tail, arena clamp, and zero input mutation', () => {
    const ball = createBallState({
      pos: { x: 0, y: 2.0, z: 0 },
      vel: { x: 2.0, y: 13.5, z: 0.5 },
      omega: { x: 0, y: 0, z: 0 },
    });
    const wind = createWindState({
      windVec3: { x: 1.5, y: 0, z: -0.5 },
      speed: Math.hypot(1.5, -0.5),
    });

    const ballBefore = structuredClone(ball);
    const windBefore = structuredClone(wind);

    const pred = physics.predictLandingPoint3D(ball, wind, PHYSICS_DEFAULTS, MAX_PREDICT_STEPS);

    assert.deepStrictEqual(ball, ballBefore, 'predictLandingPoint3D must not mutate ballState on analytic tail path');
    assert.deepStrictEqual(wind, windBefore, 'predictLandingPoint3D must not mutate windState on analytic tail path');

    assert.equal(pred.landedWithinSteps, false, 'High sky lob (> 2s) must exceed 180 exact steps');
    assert.equal(pred.steps, MAX_PREDICT_STEPS, 'steps must equal MAX_PREDICT_STEPS (180)');
    assert.ok(Number.isFinite(pred.hangTime) && pred.hangTime > 1.5, `hangTime must be > 1.5s, got ${pred.hangTime}`);
    assert.ok(
      Number.isFinite(pred.x) && Math.abs(pred.x) <= COURT.ARENA_HALF_X - BALL_SPEC.RADIUS + 1e-4,
      `Predicted x (${pred.x}) must stay clamped inside arena`,
    );
    assert.ok(
      Number.isFinite(pred.z) && Math.abs(pred.z) <= COURT.ARENA_HALF_Z - BALL_SPEC.RADIUS + 1e-4,
      `Predicted z (${pred.z}) must stay clamped inside arena`,
    );
  });

  it('T2-A2: gustScale=0 suppresses all wind while gustScale=2.0 amplifies gust speed cleanly', () => {
    const cfgZero = { ...PHYSICS_DEFAULTS, gustScale: 0 };
    const cfgNormal = { ...PHYSICS_DEFAULTS, gustScale: 1.0 };
    const cfgDouble = { ...PHYSICS_DEFAULTS, gustScale: 2.0 };

    const wZero = createWindState();
    const wNormal = createWindState();
    const wDouble = createWindState();

    physics.triggerGaleSurge(wZero, 1);
    physics.triggerGaleSurge(wNormal, 1);
    physics.triggerGaleSurge(wDouble, 1);

    let maxZero = 0;
    let maxNormal = 0;
    let maxDouble = 0;

    for (let i = 0; i < 600; i++) {
      physics.updateWind3D(wZero, FIXED_DT, cfgZero);
      physics.updateWind3D(wNormal, FIXED_DT, cfgNormal);
      physics.updateWind3D(wDouble, FIXED_DT, cfgDouble);

      assertFiniteVec3(wZero.windVec3, 'wZero.windVec3');
      assertFiniteVec3(wDouble.windVec3, 'wDouble.windVec3');
      maxZero = Math.max(maxZero, Math.hypot(wZero.windVec3.x, wZero.windVec3.y, wZero.windVec3.z), wZero.speed);
      maxNormal = Math.max(maxNormal, wNormal.speed);
      maxDouble = Math.max(maxDouble, wDouble.speed);
    }

    assert.ok(maxZero <= 1e-6, `gustScale=0 must produce zero wind speed, got ${maxZero}`);
    assert.ok(
      maxDouble > maxNormal * 1.4,
      `gustScale=2.0 peak speed (${maxDouble.toFixed(2)}) must be strictly larger than gustScale=1.0 (${maxNormal.toFixed(2)})`,
    );
  });

  it('T2-A3: Zero relative airspeed (vRel === 0) produces zero drag, zero Magnus, and zero NaN', () => {
    const cfg = sanitizePhysicsConfig({ ...PHYSICS_DEFAULTS, kDrag: 0.05, kMagnus: 0.05 });
    const windVec = { x: 3.5, y: 0, z: -1.2 };
    const ball = createBallState({
      pos: { x: 0, y: 5.0, z: 0 },
      vel: { ...windVec },
      omega: { x: 0, y: 10, z: -10 },
    });
    const wind = createWindState({ windVec3: { ...windVec }, speed: Math.hypot(windVec.x, windVec.z) });

    const res = physics.stepBall3D(ball, wind, cfg, FIXED_DT, true);
    assertFiniteVec3(ball.vel, 'ball.vel');
    assertFiniteVec3(ball.pos, 'ball.pos');
    assert.ok(Math.abs(ball.vel.x - windVec.x) < 1e-9, 'vRel=0 must produce zero X drag/Magnus acceleration');
    assert.ok(Math.abs(ball.vel.z - windVec.z) < 1e-9, 'vRel=0 must produce zero Z drag/Magnus acceleration');
    assert.ok(
      Math.abs(ball.vel.y - (windVec.y - cfg.gravity * FIXED_DT)) < 1e-9,
      `vRel=0 must apply only gravity on Y (expected ${(windVec.y - cfg.gravity * FIXED_DT).toFixed(6)}, got ${ball.vel.y.toFixed(6)})`,
    );
    assert.ok(Number.isFinite(res.speed));
  });

  it('T2-A4: High-speed corner triple-impact keeps ball bounded inside arena and caps |omega| <= MAX_OMEGA', () => {
    const ball = createBallState({
      pos: { x: 11.2, y: 13.7, z: 6.2 },
      vel: { x: 35, y: 25, z: 25 },
      omega: { x: 40, y: 40, z: 40 },
    });
    const wind = createWindState();

    for (let i = 0; i < 10; i++) {
      const res = physics.stepBall3D(ball, wind, PHYSICS_DEFAULTS, FIXED_DT, true);
      assert.equal(res.landed, false, 'High corner impact must keep ball live');
      assertFiniteVec3(ball.pos, 'corner ball.pos');
      assertFiniteVec3(ball.vel, 'corner ball.vel');
      assertFiniteVec3(ball.omega, 'corner ball.omega');

      assert.ok(Math.abs(ball.pos.x) <= COURT.ARENA_HALF_X - BALL_SPEC.RADIUS + 1e-4, `x escaped arena: ${ball.pos.x}`);
      assert.ok(Math.abs(ball.pos.z) <= COURT.ARENA_HALF_Z - BALL_SPEC.RADIUS + 1e-4, `z escaped arena: ${ball.pos.z}`);
      assert.ok(ball.pos.y <= COURT.CEILING_Y - BALL_SPEC.RADIUS + 1e-4, `y escaped ceiling: ${ball.pos.y}`);
      const omegaMag = Math.hypot(ball.omega.x, ball.omega.y, ball.omega.z);
      assert.ok(
        omegaMag <= BALL_SPEC.MAX_OMEGA + 1e-5,
        `|omega| (${omegaMag.toFixed(3)}) must be capped to BALL_SPEC.MAX_OMEGA (${BALL_SPEC.MAX_OMEGA})`,
      );
    }
  });

  it('T2-A5: Net-tape center, top grazing, and net-post edge (Z = ±4.5) produce finite rebounds without sticking', () => {
    const wind = createWindState();
    const cases = [
      { label: 'tape-center', pos: { x: -0.05, y: COURT.NET_HEIGHT, z: 0 }, vel: { x: 8, y: 0, z: 0 } },
      { label: 'tape-top-graze', pos: { x: -0.05, y: COURT.NET_HEIGHT + COURT.NET_TAPE_RADIUS + BALL_SPEC.RADIUS - 0.01, z: 0 }, vel: { x: 8, y: -0.2, z: 0 } },
      { label: 'post-pos-z', pos: { x: -0.15, y: 1.5, z: COURT.NET_HALF_Z }, vel: { x: 9, y: 0, z: 0 } },
      { label: 'post-neg-z', pos: { x: 0.15, y: 1.5, z: -COURT.NET_HALF_Z }, vel: { x: -9, y: 0, z: 0 } },
    ];

    for (const c of cases) {
      const ball = createBallState({ pos: c.pos, vel: c.vel });
      for (let i = 0; i < 15; i++) {
        const r = physics.stepBall3D(ball, wind, PHYSICS_DEFAULTS, FIXED_DT, true);
        assertFiniteVec3(ball.pos, `${c.label}.pos`);
        assertFiniteVec3(ball.vel, `${c.label}.vel`);
        assert.ok(Number.isFinite(r.speed), `${c.label}.speed must be finite`);
      }
      // Must not remain frozen inside x=0, y=NET_HEIGHT
      const speedAfter = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);
      assert.ok(speedAfter > 0.05, `${c.label} must not stick at zero velocity`);
    }
  });

  it('T2-A6: Zero-length vectors, NaN/Infinity inputs, and zero/negative dt remain strictly finite', () => {
    const zeroDir = computeSpinOmega(0, 0, 18, 10);
    assert.deepEqual(zeroDir, { x: 0, y: 10, z: 0 });

    const capped = computeSpinOmega(1, 0, 100, 100);
    assert.ok(Math.hypot(capped.x, capped.y, capped.z) <= BALL_SPEC.MAX_OMEGA + 1e-6);

    const nanDir = computeSpinOmega(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN, Number.NEGATIVE_INFINITY);
    assertFiniteVec3(nanDir, 'nanDir');

    const wind = createWindState();
    for (const badDt of [0, -0.01, Number.NaN]) {
      const ball = createBallState({ pos: { x: -2, y: 3, z: 0 }, vel: { x: 4, y: 2, z: 0 } });
      assert.doesNotThrow(() => physics.stepBall3D(ball, wind, PHYSICS_DEFAULTS, badDt, true));
      assertFiniteVec3(ball.pos, `badDt(${badDt}).pos`);
      assertFiniteVec3(ball.vel, `badDt(${badDt}).vel`);
      assertFiniteVec3(ball.omega, `badDt(${badDt}).omega`);
    }

    // Corrupted ball fields injected directly
    const corrupt = createBallState({ pos: { x: 0, y: 3, z: 0 } });
    corrupt.vel.x = Number.NaN;
    corrupt.omega.z = Number.POSITIVE_INFINITY;
    assert.doesNotThrow(() => physics.stepBall3D(corrupt, wind, PHYSICS_DEFAULTS, FIXED_DT, true));
    assertFiniteVec3(corrupt.pos, 'corrupt.pos');
    assertFiniteVec3(corrupt.vel, 'corrupt.vel');
    assertFiniteVec3(corrupt.omega, 'corrupt.omega');
  });

  it('T2-A7: Exact sand boundary (y <= BALL_SPEC.RADIUS) and negative y clamp cleanly with landed=true', () => {
    const wind = createWindState();

    const exactSand = createBallState({ pos: { x: 2, y: BALL_SPEC.RADIUS, z: 0 }, vel: { x: 0, y: 0, z: 0 } });
    const r1 = physics.stepBall3D(exactSand, wind, PHYSICS_DEFAULTS, FIXED_DT, true);
    assert.equal(r1.landed, true, 'Ball at exact y === RADIUS with gravity must land');
    assert.ok(exactSand.pos.y >= BALL_SPEC.RADIUS - 1e-6);
    assertFiniteVec3(exactSand.vel, 'exactSand.vel');

    const belowSand = createBallState({ pos: { x: -2, y: -0.5, z: 1 }, vel: { x: 3, y: -20, z: 0 } });
    const r2 = physics.stepBall3D(belowSand, wind, PHYSICS_DEFAULTS, FIXED_DT, true);
    assert.equal(r2.landed, true, 'Ball below sand (y=-0.5) must report landed=true');
    assert.ok(belowSand.pos.y >= BALL_SPEC.RADIUS - 1e-6, `Ball y must clamp >= radius, got ${belowSand.pos.y}`);
    assertFiniteVec3(belowSand.vel, 'belowSand.vel');
  });
});

/* ========================================================================== *
 * AREA B — Rally Engine & Gameplay Boundaries (src/rallyEngine.js)
 * ========================================================================== */
describe('Tier 2 — Area B: Rally Engine & Gameplay Boundaries (src/rallyEngine.js)', () => {
  let rallyMod;
  let physics;

  before(async () => {
    rallyMod = await import('../../src/rallyEngine.js');
    physics = await import('../../src/physics3d.js');
  });

  it('T2-B1: 4th-touch violation never stays live and awards point to opposing team', () => {
    // Use documented options.physics DI wrapping real physics3d.js to produce one realistic
    // lower-net rebound on Team 1's 3rd touch so P1 gets an airborne 4th-touch opportunity.
    let reboundedThirdTouch = false;
    const wrappedPhysics = {
      ...physics,
      stepBall3D(ballState, windState, cfg, dt, isSim) {
        if (
          !isSim &&
          !reboundedThirdTouch &&
          ballState.lastHitTeam === 1 &&
          (ballState.shotType === SHOT_TYPES.HEAT_SPIKE ||
            ballState.shotType === SHOT_TYPES.SPIKE ||
            ballState.shotType === SHOT_TYPES.POKEY_CUT) &&
          ballState.vel.x > 0 &&
          ballState.pos.x < 0
        ) {
          reboundedThirdTouch = true;
          ballState.pos.x = Math.min(ballState.pos.x, -0.75);
          ballState.vel.x = -1.6;
          ballState.vel.y = 3.0;
          ballState.vel.z = 0;
          return { landed: false, wallHit: null, netHit: { part: 'MESH', impactSpeed: 8.0 }, crossedNet: false, speed: 3.4 };
        }
        return physics.stepBall3D(ballState, windState, cfg, dt, isSim);
      },
    };

    const engine = rallyMod.createRallyEngine({
      format: MATCH_FORMATS.ONE_V_ONE,
      aiStyle: AI_STYLES.WIND_LOBBER,
      physics: wrappedPhysics,
    });
    const bot = createBotController({ team: 1 });

    let maxTouchObserved = 0;
    let pointAwardedToTeam2 = false;
    let sawTouchFaultOrReset = false;
    let prevTeam2Score = 0;
    let prevTouches = 0;

    for (let step = 0; step < 120 * 20; step++) {
      const snap = engine.getSnapshot();
      const p1 = snap.players.find((p) => p.team === 1 && p.role === 'PRIMARY');
      const ball = snap.ball;
      const touches = readTouchCount(snap, 1);

      if (touches > maxTouchObserved) maxTouchObserved = touches;

      let p1Cmd;
      if (reboundedThirdTouch && touches >= 3) {
        // Steer P1 directly underneath the rebounded airborne ball and attempt a 4th touch
        const moveX = Math.max(-1, Math.min(1, (ball.pos.x - p1.pos.x) * 3.0));
        const moveZ = Math.max(-1, Math.min(1, (ball.pos.z - p1.pos.z) * 3.0));
        p1Cmd = {
          moveX,
          moveZ,
          aimX: 1,
          aimZ: 0,
          primaryHeld: true,
          primaryJustPressed: step % 4 === 0,
          primaryJustReleased: step % 4 === 2,
          secondaryHeld: false,
          secondaryJustPressed: false,
          secondaryJustReleased: false,
          isHuman: true,
          autoFootwork: false,
        };
      } else {
        p1Cmd = bot.step(snap).cmd;
      }

      engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: p1Cmd }), PHYSICS_DEFAULTS);

      const next = engine.getSnapshot();
      const evTypes = extractEventTypes(next.events);
      const nextTouches = readTouchCount(next, 1);
      const scores = readScores(next);

      if (next.ball.active && !evTypes.includes(EVENTS.POINT_SCORED)) {
        assert.ok(nextTouches <= 3, `Live touch count must never exceed 3 (got ${nextTouches})`);
      }
      if (nextTouches > maxTouchObserved) maxTouchObserved = nextTouches;

      if (scores.team2 > prevTeam2Score) {
        pointAwardedToTeam2 = true;
        if (prevTouches >= 3 && !evTypes.includes(EVENTS.SAND_IMPACT) && !next.ball.active) {
          sawTouchFaultOrReset = true;
        }
        prevTeam2Score = scores.team2;
        if (sawTouchFaultOrReset) break;
      }
      prevTouches = nextTouches;
    }

    assert.equal(reboundedThirdTouch, true, 'Must reach Team 1 3rd-touch net rebound setup');
    assert.ok(maxTouchObserved >= 3, `Must reach 3 touches before 4th-touch fault (max=${maxTouchObserved})`);
    assert.ok(
      sawTouchFaultOrReset,
      'Attempting 4th touch on same side must trigger immediate airborne touch fault (not sand drop)',
    );
    assert.ok(pointAwardedToTeam2, '4th-touch violation must award point to Team 2');
  });

  it('T2-B2: rawDt = 10.0s background-tab clamp (<= 0.05s) and invalid rawDt (0, -5, NaN) never tunnel or throw', () => {
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE });
    const idle = makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD);

    // Start play (press + tap-release for serve compatibility)
    engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, {
      p1Overrides: { primaryHeld: true, primaryJustPressed: true },
    }), PHYSICS_DEFAULTS);
    engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, {
      p1Overrides: { primaryHeld: false, primaryJustReleased: true },
    }), PHYSICS_DEFAULTS);

    const before = engine.getSnapshot();
    const beforeWindTime = before.wind.time;

    // Massive background-tab delta must be clamped to <= 0.05s (and still advance simulation)
    assert.doesNotThrow(() => engine.update(10.0, idle, PHYSICS_DEFAULTS));
    const afterGiant = engine.getSnapshot();
    assertFiniteVec3(afterGiant.ball.pos, 'afterGiant.ball.pos');
    assertFiniteVec3(afterGiant.ball.vel, 'afterGiant.ball.vel');
    assert.ok(afterGiant.ball.pos.y >= BALL_SPEC.RADIUS - 1e-4, 'Ball must never tunnel below sand on huge rawDt');
    const windDelta = afterGiant.wind.time - beforeWindTime;
    assert.ok(
      windDelta >= 0.04 && windDelta <= 0.06 + 1e-6,
      `rawDt=10.0s must advance clamped ~0.05s (got ${windDelta.toFixed(4)}s)`,
    );

    // Invalid rawDt values
    for (const badDt of [0, -5.0, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.doesNotThrow(() => engine.update(badDt, idle, PHYSICS_DEFAULTS));
      const snap = engine.getSnapshot();
      assertFiniteVec3(snap.ball.pos, `badDt(${badDt}).ball.pos`);
      assertFiniteVec3(snap.ball.vel, `badDt(${badDt}).ball.vel`);
    }
  });

  it('T2-B3: Timing Ring early & late edges degrade safely without crashing', () => {
    for (const mode of ['early', 'late']) {
      const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.WIND_LOBBER });
      const bot = createBotController({
        team: 1,
        earlyAttack: mode === 'early',
        lateAttack: mode === 'late',
      });

      let sawRing = false;
      for (let step = 0; step < 120 * 14; step++) {
        const snap = engine.getSnapshot();
        const { cmd } = bot.step(snap);
        assert.doesNotThrow(() => {
          engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: cmd }), PHYSICS_DEFAULTS);
        });
        const next = engine.getSnapshot();
        assertFiniteVec3(next.ball.pos, `${mode}.ball.pos`);
        assertFiniteVec3(next.ball.vel, `${mode}.ball.vel`);
        if (readTimingRing(next).active) sawRing = true;
      }
      assert.ok(sawRing, `${mode} timing test must reach Touch 2 Set & activate Timing Ring`);
    }
  });

  it('T2-B4: Player movement is strictly clamped inside court sidelines and behind the net line', () => {
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE });

    // Drive P1 toward +X/+Z and P2 toward -X/-Z for 5 seconds
    for (let step = 0; step < 120 * 5; step++) {
      const inputs = makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, {
        p1Overrides: { moveX: 1, moveZ: 1, isHuman: true },
        p2Overrides: { moveX: -1, moveZ: -1, isHuman: true },
      });
      engine.stepFixed(FIXED_DT, inputs, PHYSICS_DEFAULTS);
    }

    const snap = engine.getSnapshot();
    const p1 = snap.players.find((p) => p.team === 1 && p.role === 'PRIMARY');
    const p2 = snap.players.find((p) => p.team === 2 && p.role === 'PRIMARY');

    assert.ok(p1.pos.x < -0.1, `P1 must stay strictly on Team 1 side of net (got x=${p1.pos.x.toFixed(3)})`);
    assert.ok(p2.pos.x > 0.1, `P2 must stay strictly on Team 2 side of net (got x=${p2.pos.x.toFixed(3)})`);
    assert.ok(Math.abs(p1.pos.z) <= COURT.ARENA_HALF_Z, `P1 must remain inside sideline walls (z=${p1.pos.z.toFixed(3)})`);
    assert.ok(Math.abs(p2.pos.z) <= COURT.ARENA_HALF_Z, `P2 must remain inside sideline walls (z=${p2.pos.z.toFixed(3)})`);
  });

  it('T2-B5: setPaused(true) freezes ball, players, wind, and scores completely until resumed', () => {
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE });
    // Serve (press + tap-release) and run a few ticks so ball is actively flying
    engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, {
      p1Overrides: { primaryHeld: true, primaryJustPressed: true },
    }), PHYSICS_DEFAULTS);
    engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, {
      p1Overrides: { primaryHeld: false, primaryJustReleased: true },
    }), PHYSICS_DEFAULTS);
    for (let i = 0; i < 30; i++) {
      engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD), PHYSICS_DEFAULTS);
    }

    engine.setPaused(true);
    const frozenSnap = structuredClone(engine.getSnapshot());

    for (let i = 0; i < 60; i++) {
      engine.update(0.05, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: { moveX: 1 } }), PHYSICS_DEFAULTS);
    }

    const stillFrozen = engine.getSnapshot();
    assert.deepStrictEqual(stillFrozen.ball.pos, frozenSnap.ball.pos, 'Ball position must freeze while paused');
    assert.deepStrictEqual(stillFrozen.players.map((p) => p.pos), frozenSnap.players.map((p) => p.pos), 'Player positions must freeze while paused');
    assert.equal(stillFrozen.wind.time, frozenSnap.wind.time, 'Wind time must freeze while paused');
    assert.deepStrictEqual(readScores(stillFrozen), readScores(frozenSnap), 'Scores must freeze while paused');

    // Resume and verify motion continues
    engine.setPaused(false);
    for (let i = 0; i < 10; i++) {
      engine.update(0.02, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: { moveX: 1 } }), PHYSICS_DEFAULTS);
    }
    const resumed = engine.getSnapshot();
    assert.ok(resumed.wind.time > frozenSnap.wind.time, 'Unpausing must immediately resume simulation');
  });

  it('T2-B6: Mid-rally 1v1 <-> 2v2 format switch & resetMatch() during active gust clear state cleanly', () => {
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE });
    engine.triggerGust();

    for (let i = 0; i < 150; i++) {
      engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD), PHYSICS_DEFAULTS);
    }

    engine.setFormat(MATCH_FORMATS.TWO_V_TWO);
    assert.equal(engine.getSnapshot().players.length, 4);

    engine.setFormat(MATCH_FORMATS.ONE_V_ONE);
    assert.equal(engine.getSnapshot().players.length, 2);

    engine.resetMatch();
    const after = engine.getSnapshot();
    assert.equal(after.hitStopFrames, 0, 'resetMatch() must clear hitStopFrames');
    assert.deepEqual(readScores(after), { team1: 0, team2: 0 });
    assertFiniteVec3(after.ball.pos, 'reset.ball.pos');
    for (const p of after.players) {
      assertFiniteVec3(p.pos, `reset.${p.id}.pos`);
    }
  });
});

/* ========================================================================== *
 * AREA C — Player Rig Boundaries (src/playerRigs.js)
 * ========================================================================== */
describe('Tier 2 — Area C: Player Rig Boundaries (src/playerRigs.js)', () => {
  let rigs;

  before(async () => {
    rigs = await import('../../src/playerRigs.js');
  });

  function assertRigFinite(root, label) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      for (const n of [
        o.position.x,
        o.position.y,
        o.position.z,
        o.rotation.x,
        o.rotation.y,
        o.rotation.z,
        o.quaternion.x,
        o.quaternion.y,
        o.quaternion.z,
        o.quaternion.w,
        o.scale.x,
        o.scale.y,
        o.scale.z,
      ]) {
        assert.ok(Number.isFinite(n), `${label}: non-finite transform value (${n}) on ${o.name || o.type}`);
      }
    });
  }

  it('T2-C1: Unknown, null, and undefined animState fall back safely with finite transforms', () => {
    const rig = rigs.createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const ball = createBallState({ pos: { x: -2, y: 2, z: 0 } });

    for (const badState of ['UNKNOWN_POSE', null, undefined, '']) {
      const player = createPlayerState({ id: 'p1', team: 1 });
      player.animState = badState;
      assert.doesNotThrow(() => rigs.updatePlayerRig(rig, player, ball, 1 / 60));
      assertRigFinite(rig.root, `badState(${String(badState)})`);
    }

    rigs.disposePlayerRig(rig);
  });

  it('T2-C2: Extreme dt (0, 0.5, -1, NaN) keeps spring scales strictly positive and bounded', () => {
    const rig = rigs.createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const ball = createBallState({ pos: { x: -2, y: 2, z: 0 } });
    const player = createPlayerState({ id: 'p1', team: 1, animState: ANIM_STATES.JUMP_HEAT_SPIKE, isAirborne: true });

    for (const dt of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.doesNotThrow(() => rigs.updatePlayerRig(rig, player, ball, dt));
      assertRigFinite(rig.root, `dt(${dt})`);
      for (const s of [rig.root.scale.x, rig.root.scale.y, rig.root.scale.z]) {
        assert.ok(s > 0.2 && s < 3.0, `Root scale must stay bounded in (0.2, 3.0) for dt=${dt}, got ${s}`);
      }
      rig.root.traverse((o) => {
        for (const s of [o.scale.x, o.scale.y, o.scale.z]) {
          assert.ok(Number.isFinite(s) && s > 0 && s < 4.0, `Descendant scale must stay finite in (0, 4.0) for dt=${dt}, got ${s}`);
        }
      });
    }

    rigs.disposePlayerRig(rig);
  });

  it('T2-C3: Degenerate IK targets (null, {999,999,999}, player origin) produce zero NaN quaternions', () => {
    const rig = rigs.createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const origin = { x: -3, y: 0, z: 0 };
    const targets = [null, { x: 999, y: 999, z: 999 }, { ...origin }, { x: Number.NaN, y: 0, z: 0 }];

    for (const t of targets) {
      const player = createPlayerState({
        id: 'p1',
        team: 1,
        pos: { ...origin },
        animState: ANIM_STATES.OVERHEAD_SET,
      });
      player.targetBallPos = t;
      const ball = createBallState({ pos: t && Number.isFinite(t.x) ? t : { x: 0, y: 2, z: 0 } });
      assert.doesNotThrow(() => rigs.updatePlayerRig(rig, player, ball, 1 / 60));
      assertRigFinite(rig.root, `ikTarget(${JSON.stringify(t)})`);
    }

    rigs.disposePlayerRig(rig);
  });

  it('T2-C4: Out-of-range chargeRatio (-10, 99, NaN) and rapid 7-state thrashing remain stable', () => {
    const rig = rigs.createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const ball = createBallState({ pos: { x: -2, y: 2.2, z: 0 } });
    const states = Object.values(ANIM_STATES);
    const ratios = [-10, 99, Number.NaN, Number.POSITIVE_INFINITY, 0.5];

    for (let i = 0; i < 35; i++) {
      const player = createPlayerState({ id: 'p1', team: 1, animState: states[i % states.length] });
      player.chargeRatio = ratios[i % ratios.length];
      assert.doesNotThrow(() => rigs.updatePlayerRig(rig, player, ball, 1 / 60));
      assertRigFinite(rig.root, `thrash(${i})`);
    }

    rigs.disposePlayerRig(rig);
  });

  it('T2-C5: disposePlayerRig is idempotent across sequential double calls', () => {
    const rig = rigs.createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    assert.doesNotThrow(() => {
      rigs.disposePlayerRig(rig);
      rigs.disposePlayerRig(rig);
    });
  });
});

/* ========================================================================== *
 * AREA D — Input Manager, Quick-Bind & Storage Boundaries
 * ========================================================================== */
describe('Tier 2 — Area D (M0 Contract): Physics Lab Config Sanitization', () => {
  it('T2-D3: Extreme, corrupt, and empty Physics Lab values clamp strictly to PHYSICS_LIMITS & defaults', () => {
    const out = sanitizePhysicsConfig({
      gravity: -999,
      kDrag: 5,
      kMagnus: 'NaN',
      gustScale: Number.POSITIVE_INFINITY,
      gameSpeed: '',
      eWall: 2,
      eNetTape: -1,
      eNetMesh: null,
      kWallSpin: 99,
    });

    assert.equal(out.gravity, PHYSICS_LIMITS.gravity[0]);
    assert.equal(out.kDrag, PHYSICS_LIMITS.kDrag[1]);
    assert.equal(out.kMagnus, PHYSICS_DEFAULTS.kMagnus);
    assert.equal(out.gustScale, PHYSICS_DEFAULTS.gustScale);
    assert.equal(out.gameSpeed, PHYSICS_DEFAULTS.gameSpeed);
    assert.equal(out.eWall, 1);
    assert.equal(out.eNetTape, 0);
    assert.equal(out.eNetMesh, PHYSICS_DEFAULTS.eNetMesh);
    assert.equal(out.kWallSpin, 0.5);

    // Non-object / array / null inputs fall back completely to defaults
    for (const bad of [null, undefined, [], 'bad', 42]) {
      assert.deepEqual(sanitizePhysicsConfig(bad), { ...PHYSICS_DEFAULTS });
    }
  });
});

describe('Tier 2 — Area D: Input Manager, Quick-Bind & Storage Boundaries (src/inputManager.js)', () => {
  let inputMod;
  let shims = null;
  let activeManager = null;

  before(async () => {
    inputMod = await import('../../src/inputManager.js');
  });

  afterEach(() => {
    if (activeManager) {
      activeManager.destroy();
      activeManager = null;
    }
    if (shims) {
      shims.restore();
      shims = null;
    }
  });

  it('T2-D1: 3-second Quick-Bind timeout completes cleanly without input and preserves valid default bindings', () => {
    shims = installInputShims();
    activeManager = inputMod.createInputManager(shims.canvas);

    let updateCalls = 0;
    let doneCalled = false;
    activeManager.startQuickBind(
      () => {
        updateCalls += 1;
      },
      () => {
        doneCalled = true;
      },
    );

    // Advance up to 16 seconds (covers up to 4 slots * 3s + margin) without pressing any input
    for (let i = 0; i < 160 && !doneCalled; i++) {
      activeManager.pollInputs(0.1);
    }

    assert.ok(updateCalls > 0, 'Quick-Bind must report progress ticks while counting down');
    assert.equal(doneCalled, true, 'Quick-Bind must time out and invoke onDone without hanging');

    const bindings = activeManager.getBindings();
    const defaults = createDefaultBindings();
    assert.ok(Array.isArray(bindings.keyboard.p1.primary) && bindings.keyboard.p1.primary.length > 0);
    assert.equal(bindings.deadzone, defaults.deadzone);
  });

  it('T2-D2: Corrupt JSON and throwing localStorage recover silently to defaults with zero throws', () => {
    for (const raw of ['{bad-json', 'null', '[]', '"str"', '123']) {
      const mem = createMemoryStorage({ [STORAGE_KEYS.BINDINGS]: raw });
      shims = installInputShims({ storage: mem });
      assert.doesNotThrow(() => {
        activeManager = inputMod.createInputManager(shims.canvas);
      });
      assert.equal(activeManager.getBindings().deadzone, createDefaultBindings().deadzone);
      activeManager.destroy();
      activeManager = null;
      shims.restore();
      shims = null;
    }

    // Throwing localStorage (SecurityError / QuotaExceededError)
    const throwingStore = createMemoryStorage({}, { throwOnRead: true, throwOnWrite: true });
    shims = installInputShims({ storage: throwingStore });
    assert.doesNotThrow(() => {
      activeManager = inputMod.createInputManager(shims.canvas);
      activeManager.setBindings(createDefaultBindings());
      activeManager.resetBindings();
    });
  });

  it('T2-D4: Stadia deadzone threshold (0.159 -> 0 vs 0.161 -> non-zero) & missing/sparse gamepads', () => {
    shims = installInputShims();
    activeManager = inputMod.createInputManager(shims.canvas);
    activeManager.setMode(INPUT_MODES.ONE_PAD_SPLIT);

    // Below 0.16 deadzone
    shims.setGamepads([createMockGamepad({ index: 0, axes: [0.159, -0.159, 0.159, -0.159] })]);
    const below = activeManager.pollInputs(FIXED_DT);
    assert.equal(below.p1.moveX, 0, 'Axis 0.159 (< 0.16 deadzone) must output 0');
    assert.equal(below.p1.moveZ, 0, 'Axis -0.159 (< 0.16 deadzone) must output 0');
    assert.equal(below.p2.moveX, 0, 'P2 axis 0.159 (< 0.16 deadzone) must output 0');

    // Above 0.16 deadzone
    shims.setGamepads([createMockGamepad({ index: 0, axes: [0.161, 0, -0.161, 0] })]);
    const above = activeManager.pollInputs(FIXED_DT);
    assert.ok(above.p1.moveX > 0, 'Axis 0.161 (> 0.16 deadzone) must output > 0');
    assert.ok(above.p2.moveX < 0, 'P2 axis -0.161 (> 0.16 deadzone) must output < 0');

    // Sparse null/undefined gamepad slots
    shims.setGamepads([null, undefined]);
    const sparse = activeManager.pollInputs(FIXED_DT);
    assert.equal(sparse.padsConnected, 0);
    assert.equal(sparse.p1.moveX, 0);

    // Missing navigator.getGamepads entirely
    activeManager.destroy();
    activeManager = null;
    shims.restore();

    shims = installInputShims({ omitGetGamepads: true });
    activeManager = inputMod.createInputManager(shims.canvas);
    assert.doesNotThrow(() => {
      const noApi = activeManager.pollInputs(FIXED_DT);
      assert.equal(noApi.padsConnected, 0);
      assert.equal(noApi.p1.moveX, 0);
    });
  });

  it('T2-D5: Simultaneous opposing keys cancel to moveX === 0 and cancelQuickBind restores normal polling', () => {
    shims = installInputShims();
    activeManager = inputMod.createInputManager(shims.canvas);
    activeManager.setMode(INPUT_MODES.TWO_PAD_KEYBOARD);

    shims.dispatchKey('keydown', 'KeyA');
    shims.dispatchKey('keydown', 'KeyD');
    const opposed = activeManager.pollInputs(FIXED_DT);
    assert.equal(opposed.p1.moveX, 0, 'Simultaneous KeyA + KeyD must cancel to moveX === 0');
    shims.dispatchKey('keyup', 'KeyA');
    shims.dispatchKey('keyup', 'KeyD');
    activeManager.pollInputs(FIXED_DT);

    // Start then cancel Quick-Bind mid-flow
    activeManager.startQuickBind(() => {}, () => {});
    activeManager.pollInputs(0.1);
    assert.doesNotThrow(() => activeManager.cancelQuickBind());

    // Normal keyboard polling must resume cleanly
    shims.dispatchKey('keydown', 'KeyD');
    const resumed = activeManager.pollInputs(FIXED_DT);
    assert.ok(resumed.p1.moveX > 0.5, 'Normal keyboard input must resume after cancelQuickBind()');
  });
});

/* ========================================================================== *
 * AREA E — Audio Synth Boundaries (src/audioSynth.js)
 * ========================================================================== */
describe('Tier 2 — Area E: Audio Synth Boundaries (src/audioSynth.js)', () => {
  let audioMod;
  let spyHandle = null;
  let synth = null;

  before(async () => {
    audioMod = await import('../../src/audioSynth.js');
  });

  afterEach(() => {
    if (synth) {
      synth.dispose();
      synth = null;
    }
    if (spyHandle) {
      spyHandle.restore();
      spyHandle = null;
    }
  });

  it('T2-E1: Every public sound method is a strict no-op while muted with zero AudioContext instantiation', () => {
    spyHandle = installAudioContextSpy();
    synth = audioMod.createAudioSynth();

    assert.equal(synth.isEnabled(), false);
    assert.doesNotThrow(() => {
      synth.updateAmbience(createWindState({ speed: 10 }));
      synth.handleEvents([{ type: EVENTS.HEAT_SPIKE }, { type: EVENTS.BUMP }]);
      synth.playChargeSweep(0.8);
      synth.playRefereeWhistle('point');
    });
    assert.equal(spyHandle.spy.constructorCallCount, 0);
  });

  it('T2-E2: Malformed & extreme inputs (NaN, Infinity, null, bogus event) never throw or schedule non-finite params', () => {
    spyHandle = installAudioContextSpy();
    synth = audioMod.createAudioSynth();
    synth.setEnabled(true);

    assert.doesNotThrow(() => {
      synth.playChargeSweep(-5);
      synth.playChargeSweep(99);
      synth.playChargeSweep(Number.NaN);
      synth.playChargeSweep(Number.POSITIVE_INFINITY);
      synth.playRefereeWhistle(null);
      synth.playRefereeWhistle('UNKNOWN_KIND');
      synth.handleEvents(null);
      synth.handleEvents(undefined);
      synth.handleEvents([null, {}, { type: 'BOGUS_EVENT' }]);
      synth.updateAmbience(null);
      synth.updateAmbience({ speed: Number.POSITIVE_INFINITY, windVec3: { x: Number.NaN, y: 0, z: 0 } });
    });

    assert.deepEqual(spyHandle.spy.nonFiniteParams, [], 'No non-finite AudioParam values may be scheduled');
  });

  it('T2-E3: Unavailable AudioContext / webkitAudioContext degrades gracefully with isEnabled() === false', () => {
    spyHandle = installAudioContextSpy({ unavailable: true });
    synth = audioMod.createAudioSynth();

    assert.doesNotThrow(() => {
      synth.toggle();
      synth.setEnabled(true);
      synth.updateAmbience(createWindState());
      synth.handleEvents([{ type: EVENTS.HEAT_SPIKE }]);
    });
    assert.equal(synth.isEnabled(), false);
  });

  it('T2-E4: Rapid toggle() (10x) and sequential double dispose() never throw or double-close', () => {
    spyHandle = installAudioContextSpy();
    synth = audioMod.createAudioSynth();

    assert.doesNotThrow(() => {
      for (let i = 0; i < 10; i++) synth.toggle();
      synth.dispose();
      synth.dispose();
    });
    assert.ok(spyHandle.spy.closeCalls <= 1, `AudioContext.close() should be called at most once, got ${spyHandle.spy.closeCalls}`);
    synth = null;
  });

  it('T2-E5: Rejected AudioContext.resume() is caught internally with zero unhandled promise rejections', async () => {
    let unhandled = null;
    const onUnhandled = (reason) => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      spyHandle = installAudioContextSpy({ rejectResume: true, initialState: 'suspended' });
      synth = audioMod.createAudioSynth();

      assert.doesNotThrow(() => synth.setEnabled(true));
      // Allow microtask queue to flush any unhandled rejection
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(unhandled, null, `Rejected AudioContext.resume() leaked unhandledRejection: ${unhandled}`);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
