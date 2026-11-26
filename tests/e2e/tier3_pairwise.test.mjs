/**
 * Tier 3 — Cross-Feature Pairwise Combinatorial Tests (Opaque-Box E2E Suite)
 *
 * Covers all 9 pairwise cross-module interactions (T3-P1 .. T3-P9) derived
 * from TEST_INFRA.md, PROJECT.md, AGENTS.md, and src/contracts.js.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as Contracts from '../../src/contracts.js';
import {
  installInputShims,
  installAudioContextSpy,
  readScores,
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
  STORAGE_KEYS,
  INPUT_MODES,
  AI_STYLES,
  MATCH_FORMATS,
  ANIM_STATES,
  WIND_PHASES,
  TRAIL_MODES,
  SHOT_TYPES,
  EVENTS,
  computeSpinOmega,
  createBallState,
  createWindState,
  createDefaultBindings,
  sanitizePhysicsConfig,
} = Contracts;

describe('Tier 3 — Cross-Feature Pairwise Combinatorial Suite (T3-P1 .. T3-P9)', () => {
  let physics;
  let rigs;
  let rallyMod;
  let inputMod;
  let audioMod;

  let activeShims = null;
  let activeInput = null;
  let activeAudioSpy = null;
  let activeAudio = null;

  before(async () => {
    physics = await import('../../src/physics3d.js');
    rigs = await import('../../src/playerRigs.js');
    rallyMod = await import('../../src/rallyEngine.js');
    inputMod = await import('../../src/inputManager.js');
    audioMod = await import('../../src/audioSynth.js');
  });

  afterEach(() => {
    if (activeInput) {
      activeInput.destroy();
      activeInput = null;
    }
    if (activeShims) {
      activeShims.restore();
      activeShims = null;
    }
    if (activeAudio) {
      activeAudio.dispose();
      activeAudio = null;
    }
    if (activeAudioSpy) {
      activeAudioSpy.restore();
      activeAudioSpy = null;
    }
  });

  it('T3-P1: Heavy Gale (GUST, gustScale=2.0) × Heat Spike (FLAME topspin) × predictLandingPoint3D', () => {
    const gustCfg = sanitizePhysicsConfig({ ...PHYSICS_DEFAULTS, gustScale: 2.0 });
    const calmCfg = sanitizePhysicsConfig({ ...PHYSICS_DEFAULTS, gustScale: 0 });
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.WIND_LOBBER });
    engine.triggerGust(-1);

    const bot = createBotController({ team: 1 });
    let capturedSpikeBall = null;
    let capturedSpikeWind = null;
    let maxHitStop = 0;
    let sawFlame = false;

    for (let step = 0; step < 120 * 24; step++) {
      // Keep gale cycling WARNING -> GUST throughout the rally so Heat Spike fires under active gale wind
      if (engine.getSnapshot().wind.phase === WIND_PHASES.BREEZE) {
        engine.triggerGust(-1);
      }
      const snap = engine.getSnapshot();
      const { cmd } = bot.step(snap);
      engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: cmd }), gustCfg);

      const next = engine.getSnapshot();
      const evTypes = extractEventTypes(next.events);
      if (next.hitStopFrames > maxHitStop) maxHitStop = next.hitStopFrames;

      if (evTypes.includes(EVENTS.HEAT_SPIKE) || next.ball.shotType === SHOT_TYPES.HEAT_SPIKE) {
        if (next.ball.trailMode === TRAIL_MODES.FLAME) sawFlame = true;
        if (next.wind.speed > 0.5) {
          capturedSpikeBall = structuredClone(next.ball);
          capturedSpikeWind = structuredClone(next.wind);
        }
        if (sawFlame && maxHitStop >= 2 && capturedSpikeWind && capturedSpikeWind.speed > 0.5) break;
      }
    }

    assert.ok(capturedSpikeBall, 'Must unleash Heat Spike during active Heavy Gale rally');
    assert.ok(
      capturedSpikeWind && capturedSpikeWind.speed > 0.5,
      `Heat Spike must occur under genuine gale wind (speed=${capturedSpikeWind?.speed})`,
    );
    assert.ok(sawFlame, 'Heat Spike must set TRAIL_MODES.FLAME');
    assert.ok(maxHitStop >= 2, `Heat Spike must produce hitStopFrames >= 2 (got ${maxHitStop})`);

    const predGust = physics.predictLandingPoint3D(capturedSpikeBall, capturedSpikeWind, gustCfg, MAX_PREDICT_STEPS);
    const predCalm = physics.predictLandingPoint3D(
      capturedSpikeBall,
      createWindState({ windVec3: { x: 0, y: 0, z: 0 }, speed: 0 }),
      calmCfg,
      MAX_PREDICT_STEPS,
    );

    const windShift = Math.hypot(predGust.x - predCalm.x, predGust.z - predCalm.z);
    assert.ok(windShift > 0.05, `Heavy Gale must visibly shift Heat Spike landing (shift=${windShift.toFixed(4)}m)`);

    // Unconditionally verify predictor matches actual stepBall3D sand landing under the same gust
    const simBall = structuredClone(capturedSpikeBall);
    const simWind = structuredClone(capturedSpikeWind);
    let landed = false;
    for (let i = 0; i < MAX_PREDICT_STEPS + 60; i++) {
      const r = physics.stepBall3D(simBall, simWind, gustCfg, FIXED_DT, true);
      if (r.landed) {
        landed = true;
        break;
      }
    }
    assert.equal(landed, true, 'Simulated Heat Spike must land on sand within predictor horizon');
    assert.equal(
      predGust.landedWithinSteps,
      true,
      'predictLandingPoint3D must land fast diving Heat Spike within MAX_PREDICT_STEPS',
    );
    const err = Math.hypot(predGust.x - simBall.pos.x, predGust.z - simBall.pos.z);
    assert.ok(err <= 0.1, `Gust Heat Spike landing prediction error ${err.toFixed(4)}m exceeded 0.1m`);
  });

  it('T3-P2: 2v2 AI Partner × 3-Touch Loop × NET_BLOCKER Opponent', () => {
    const engine = rallyMod.createRallyEngine({
      format: MATCH_FORMATS.TWO_V_TWO,
      aiStyle: AI_STYLES.NET_BLOCKER,
    });
    const init = engine.getSnapshot();
    assert.equal(init.players.length, 4, '2v2 must spawn 4 active players');

    const partnerInitPos = structuredClone(init.players.find((p) => p.team === 1 && p.role === 'PARTNER').pos);
    const bot = createBotController({ team: 1 });

    let partnerMaxDisp = 0;
    let sawBlockerNearNet = false;
    let sawOpponentAction = false;

    for (let step = 0; step < 120 * 16; step++) {
      const snap = engine.getSnapshot();
      const { cmd } = bot.step(snap);
      engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: cmd }), PHYSICS_DEFAULTS);

      const next = engine.getSnapshot();
      const partner = next.players.find((p) => p.team === 1 && p.role === 'PARTNER');
      const team2 = next.players.filter((p) => p.team === 2);

      const disp = Math.hypot(partner.pos.x - partnerInitPos.x, partner.pos.z - partnerInitPos.z);
      if (disp > partnerMaxDisp) partnerMaxDisp = disp;

      for (const opp of team2) {
        if (Math.abs(opp.pos.x) < 2.2 || opp.animState === ANIM_STATES.NET_BLOCK) {
          sawBlockerNearNet = true;
        }
      }
      if (next.ball.lastHitTeam === 2 && next.ball.active) sawOpponentAction = true;
    }

    assert.ok(partnerMaxDisp > 0.35, `2v2 Team 1 AI partner must actively engage (maxDisp=${partnerMaxDisp.toFixed(2)}m)`);
    assert.ok(sawBlockerNearNet, 'NET_BLOCKER opponent must contest near the net');
    assert.ok(sawOpponentAction, 'Team 2 NET_BLOCKER squad must return balls during 2v2 rally');
  });

  it('T3-P3: sanitizePhysicsConfig × physics3d & rallyEngine (custom gravity & gameSpeed)', () => {
    const customV2 = sanitizePhysicsConfig({
      gravity: 16.0,
      kDrag: 0.06,
      kMagnus: 0.05,
      gustScale: 1.8,
      gameSpeed: 1.4,
    });
    assert.equal(customV2.gravity, 16.0);
    assert.equal(customV2.gameSpeed, 1.4);

    // 1. Verify custom gravity=16.0 shortens hangTime & landing X vs default gravity=11.2 in physics3d
    const launchBall = createBallState({ pos: { x: -4, y: 2.5, z: 0 }, vel: { x: 8, y: 6, z: 0 } });
    const calmWind = createWindState();
    const predHeavy = physics.predictLandingPoint3D(launchBall, calmWind, customV2, MAX_PREDICT_STEPS);
    const predNorm = physics.predictLandingPoint3D(launchBall, calmWind, PHYSICS_DEFAULTS, MAX_PREDICT_STEPS);

    assert.ok(
      predHeavy.hangTime < predNorm.hangTime - 0.15,
      `gravity=16.0 hangTime (${predHeavy.hangTime.toFixed(3)}s) must be strictly shorter than gravity=11.2 (${predNorm.hangTime.toFixed(3)}s)`,
    );
    assert.ok(
      predHeavy.x < predNorm.x - 0.5,
      `gravity=16.0 landing x (${predHeavy.x.toFixed(2)}m) must drop strictly earlier than gravity=11.2 (${predNorm.x.toFixed(2)}m)`,
    );

    // 2. Verify custom gameSpeed=1.4 advances rallyEngine simulation strictly faster than 1.0
    const engFast = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE });
    const engNorm = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE });
    for (let i = 0; i < 30; i++) {
      engFast.update(1 / 60, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD), customV2);
      engNorm.update(1 / 60, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD), PHYSICS_DEFAULTS);
    }
    assert.ok(
      engFast.getSnapshot().wind.time > engNorm.getSnapshot().wind.time + 0.05,
      'Custom gameSpeed=1.4 must advance simulation strictly faster than gameSpeed=1.0',
    );
  });

  it('T3-P4: Covering Array — Input Mode × Format × AI Style × playerRigs IK Pipeline', () => {
    // 9-row pairwise covering array covering 100% of all 3x3 (mode, aiStyle) pairs plus all (mode, format) & (format, aiStyle) pairs
    const coveringArray = [
      { mode: INPUT_MODES.ONE_PAD_SPLIT, format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.WIND_LOBBER },
      { mode: INPUT_MODES.ONE_PAD_SPLIT, format: MATCH_FORMATS.TWO_V_TWO, aiStyle: AI_STYLES.NET_BLOCKER },
      { mode: INPUT_MODES.ONE_PAD_SPLIT, format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.SPIN_SLICER },
      { mode: INPUT_MODES.TWO_PAD_KEYBOARD, format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.SPIN_SLICER },
      { mode: INPUT_MODES.TWO_PAD_KEYBOARD, format: MATCH_FORMATS.TWO_V_TWO, aiStyle: AI_STYLES.WIND_LOBBER },
      { mode: INPUT_MODES.TWO_PAD_KEYBOARD, format: MATCH_FORMATS.TWO_V_TWO, aiStyle: AI_STYLES.NET_BLOCKER },
      { mode: INPUT_MODES.TOUCH_AUTO, format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.NET_BLOCKER },
      { mode: INPUT_MODES.TOUCH_AUTO, format: MATCH_FORMATS.TWO_V_TWO, aiStyle: AI_STYLES.SPIN_SLICER },
      { mode: INPUT_MODES.TOUCH_AUTO, format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.WIND_LOBBER },
    ];

    const validAnims = new Set(Object.values(ANIM_STATES));

    for (const row of coveringArray) {
      activeShims = installInputShims();
      activeInput = inputMod.createInputManager(activeShims.canvas);
      activeInput.setMode(row.mode);

      const engine = rallyMod.createRallyEngine({ format: row.format, aiStyle: row.aiStyle });
      const initialSnap = engine.getSnapshot();
      const rigMap = new Map();
      for (const p of initialSnap.players) {
        rigMap.set(p.id, rigs.createPlayerRig({ id: p.id, team: p.team, role: p.role }));
      }

      for (let tick = 0; tick < 120; tick++) {
        if (tick === 5) activeShims.dispatchKey('keydown', 'Space');
        if (tick === 8) activeShims.dispatchKey('keyup', 'Space');
        const inputs = activeInput.pollInputs(1 / 60);
        engine.update(1 / 60, inputs, PHYSICS_DEFAULTS);

        const snap = engine.getSnapshot();
        assertFiniteVec3(snap.ball.pos, `${row.mode}/${row.format}/${row.aiStyle}.ball.pos`);
        assert.equal(snap.players.length, row.format === MATCH_FORMATS.TWO_V_TWO ? 4 : 2);

        for (const p of snap.players) {
          assert.ok(validAnims.has(p.animState), `Invalid animState ${p.animState}`);
          const rig = rigMap.get(p.id);
          assert.ok(rig, `Missing rig for ${p.id}`);
          rigs.updatePlayerRig(rig, p, snap.ball, 1 / 60);
          rig.root.updateMatrixWorld(true);
          assert.ok(Number.isFinite(rig.root.position.x) && Number.isFinite(rig.root.rotation.y));
        }
      }

      for (const rig of rigMap.values()) rigs.disposePlayerRig(rig);
      activeInput.destroy();
      activeInput = null;
      activeShims.restore();
      activeShims = null;
    }
  });

  it('T3-P5: Quick-Bind Calibration × STORAGE_KEYS.BINDINGS Reload × rallyEngine Strike', () => {
    activeShims = installInputShims();
    activeInput = inputMod.createInputManager(activeShims.canvas);
    activeInput.setMode(INPUT_MODES.TWO_PAD_KEYBOARD);

    let done = false;
    activeInput.startQuickBind(
      () => {},
      () => {
        done = true;
      },
    );

    // Bind first slot (p1Primary) to KeyF, then finish remaining slots
    for (const key of ['KeyF', 'KeyG', 'KeyJ', 'KeyK']) {
      activeShims.dispatchKey('keydown', key);
      activeInput.pollInputs(0.05);
      activeShims.dispatchKey('keyup', key);
      activeInput.pollInputs(0.05);
      if (done) break;
    }
    for (let i = 0; i < 140 && !done; i++) {
      activeInput.pollInputs(0.1);
    }
    assert.equal(done, true, 'Quick-Bind must complete and save bindings');
    assert.ok(activeShims.localStorage.getItem(STORAGE_KEYS.BINDINGS), 'Bindings must be persisted');

    // Destroy & re-instantiate fresh inputManager from persisted storage
    activeInput.destroy();
    activeInput = inputMod.createInputManager(activeShims.canvas);
    activeInput.setMode(INPUT_MODES.TWO_PAD_KEYBOARD);

    // Press newly bound KeyF and pipe into rallyEngine
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE });
    activeShims.dispatchKey('keydown', 'KeyF');
    const polled = activeInput.pollInputs(FIXED_DT);
    assert.equal(polled.p1.primaryJustPressed, true, 'Reloaded Quick-Bind KeyF must drive p1.primaryJustPressed');

    engine.stepFixed(FIXED_DT, polled, PHYSICS_DEFAULTS);
    activeShims.dispatchKey('keyup', 'KeyF');
    engine.stepFixed(FIXED_DT, activeInput.pollInputs(FIXED_DT), PHYSICS_DEFAULTS);

    // Advance a few frames to confirm serve/action took effect cleanly
    for (let i = 0; i < 10; i++) {
      engine.stepFixed(FIXED_DT, activeInput.pollInputs(FIXED_DT), PHYSICS_DEFAULTS);
    }
    assertFiniteVec3(engine.getSnapshot().ball.pos, 'post-quickbind ball.pos');
  });

  it('T3-P6: TOUCH Auto-Footwork × 3-Touch Loop × predictLandingPoint3D', () => {
    activeShims = installInputShims();
    activeInput = inputMod.createInputManager(activeShims.canvas);
    activeInput.setMode(INPUT_MODES.TOUCH_AUTO);

    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.WIND_LOBBER });
    const startP1Pos = structuredClone(engine.getSnapshot().players.find((p) => p.team === 1).pos);

    let p1AutoMoved = false;
    let pointerDown = false;
    let holdFrames = 0;
    let cooldown = 0;
    let p1TouchedOrServed = false;

    for (let step = 0; step < 120 * 12; step++) {
      const snap = engine.getSnapshot();
      const p1 = snap.players.find((p) => p.team === 1);
      const ball = snap.ball;
      const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);
      const hdist = Math.hypot(ball.pos.x - p1.pos.x, ball.pos.z - p1.pos.z);

      if (cooldown > 0) cooldown -= 1;

      if (!pointerDown && cooldown === 0) {
        if (!ball.active || (speed < 0.25 && ball.pos.x < 0) || (ball.pos.x < 0.2 && hdist < 2.6 && ball.pos.y < 3.2)) {
          activeShims.dispatchPointer('pointerdown', { clientX: 360, clientY: 480 });
          pointerDown = true;
          holdFrames = 3;
          cooldown = 24;
        }
      } else if (pointerDown) {
        holdFrames -= 1;
        if (holdFrames <= 0) {
          activeShims.dispatchPointer('pointerup', { clientX: 440, clientY: 300 });
          pointerDown = false;
        }
      }

      const polled = activeInput.pollInputs(FIXED_DT);
      assert.equal(polled.p1.autoFootwork, true, 'TOUCH mode must keep p1.autoFootwork === true');
      engine.stepFixed(FIXED_DT, polled, PHYSICS_DEFAULTS);

      const next = engine.getSnapshot();
      const nextP1 = next.players.find((p) => p.team === 1);
      if (Math.hypot(nextP1.pos.x - startP1Pos.x, nextP1.pos.z - startP1Pos.z) > 0.3) {
        p1AutoMoved = true;
      }
      const evTypes = extractEventTypes(next.events);
      if (
        evTypes.includes(EVENTS.SERVE) ||
        evTypes.includes(EVENTS.BUMP) ||
        evTypes.includes(EVENTS.SET) ||
        evTypes.includes(EVENTS.SPIKE) ||
        evTypes.includes(EVENTS.HEAT_SPIKE)
      ) {
        p1TouchedOrServed = true;
      }
      if (p1AutoMoved && p1TouchedOrServed) break;
    }

    assert.ok(p1AutoMoved, 'TOUCH autoFootwork must automatically steer P1 toward predicted landing without stick input');
    assert.ok(p1TouchedOrServed, 'TOUCH tap/swipe must execute serve/touches in rallyEngine');
  });

  it('T3-P7: SPIN_SLICER AI × Backspin POKEY_CUT × Spin-Reactive Arcade Wall Kick (±X)', () => {
    // 1. Run SPIN_SLICER rally and confirm spin-rich exchange
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.SPIN_SLICER });
    const pokeyBot = createBotController({ team: 1, useSecondaryOnTouch3: true });

    let sawPokey = false;
    let sawSpinSlicerReturn = false;

    for (let step = 0; step < 120 * 16; step++) {
      const snap = engine.getSnapshot();
      const { cmd } = pokeyBot.step(snap);
      engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: cmd }), PHYSICS_DEFAULTS);
      const next = engine.getSnapshot();
      const evTypes = extractEventTypes(next.events);
      if (evTypes.includes(EVENTS.POKEY_CUT) || next.ball.shotType === SHOT_TYPES.POKEY_CUT) {
        sawPokey = true;
      }
      if (next.ball.lastHitTeam === 2 && Math.hypot(next.ball.omega.x, next.ball.omega.y, next.ball.omega.z) > 1.0) {
        sawSpinSlicerReturn = true;
      }
      if (sawPokey && sawSpinSlicerReturn) break;
    }
    assert.ok(sawPokey, 'Secondary attack must produce backspin POKEY_CUT against SPIN_SLICER');
    assert.ok(sawSpinSlicerReturn, 'SPIN_SLICER AI must return with active spin');

    // 2. Verify spin-reactive vertical wall kick on BOTH ±X outer walls stays live until sand impact
    const calm = createWindState();
    for (const wallSign of [1, -1]) {
      const xStart = wallSign * (COURT.ARENA_HALF_X - BALL_SPEC.RADIUS - 0.04);
      const bBack = createBallState({
        pos: { x: xStart, y: 3.5, z: 0 },
        vel: { x: wallSign * 14, y: 0, z: 0 },
        omega: computeSpinOmega(wallSign, 0, -18, 0),
        shotType: SHOT_TYPES.POKEY_CUT,
      });
      const bTop = createBallState({
        pos: { x: xStart, y: 3.5, z: 0 },
        vel: { x: wallSign * 14, y: 0, z: 0 },
        omega: computeSpinOmega(wallSign, 0, 18, 0),
        shotType: SHOT_TYPES.SPIKE,
      });

      const rB = physics.stepBall3D(bBack, calm, PHYSICS_DEFAULTS, FIXED_DT, true);
      const rT = physics.stepBall3D(bTop, calm, PHYSICS_DEFAULTS, FIXED_DT, true);

      assert.ok(rB.wallHit && rT.wallHit);
      assert.equal(rB.landed, false, 'Wall bounce must remain live until sand impact');
      assert.equal(rT.landed, false, 'Wall bounce must remain live until sand impact');
      assert.ok(bBack.vel.y > bTop.vel.y + 1.0, `Backspin must pop higher than topspin on wallSign=${wallSign}`);
    }
  });

  it('T3-P8: WIND_LOBBER AI × Sky Lob (>1.5s) × Predictor Analytic Tail × audioSynth', () => {
    activeAudioSpy = installAudioContextSpy();
    activeAudio = audioMod.createAudioSynth();
    activeAudio.setEnabled(true);

    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.WIND_LOBBER });
    engine.triggerGust();
    const bot = createBotController({ team: 1 });

    let sawEvents = 0;
    for (let step = 0; step < 120 * 10; step++) {
      const snap = engine.getSnapshot();
      const { cmd } = bot.step(snap);
      engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: cmd }), PHYSICS_DEFAULTS);

      const next = engine.getSnapshot();
      activeAudio.updateAmbience(next.wind);
      if (Array.isArray(next.events) && next.events.length > 0) {
        sawEvents += next.events.length;
        activeAudio.handleEvents(next.events);
      }
    }

    assert.ok(sawEvents > 0, 'Rally must emit gameplay/wind events consumed by audioSynth');
    assert.deepEqual(activeAudioSpy.spy.nonFiniteParams, [], 'audioSynth must schedule strictly finite params');

    // Verify high sky lob (>1.5s) exercises analytic quadratic tail cleanly
    const skyLob = createBallState({
      pos: { x: 4.0, y: 2.5, z: 0 },
      vel: { x: -4.5, y: 13.0, z: 0.4 },
      shotType: SHOT_TYPES.LOB,
      trailMode: TRAIL_MODES.LOB,
    });
    const gustWind = createWindState({ windVec3: { x: -3.0, y: 0, z: 1.0 }, speed: Math.hypot(-3, 1) });
    const pred = physics.predictLandingPoint3D(skyLob, gustWind, PHYSICS_DEFAULTS, MAX_PREDICT_STEPS);

    assert.equal(pred.landedWithinSteps, false, 'Sky lob (> 1.5s) must engage analytic tail');
    assert.equal(pred.steps, MAX_PREDICT_STEPS);
    assert.ok(pred.hangTime > 1.5 && Number.isFinite(pred.hangTime));
    assert.ok(Math.abs(pred.x) <= COURT.ARENA_HALF_X - BALL_SPEC.RADIUS + 1e-4);
    assert.ok(Math.abs(pred.z) <= COURT.ARENA_HALF_Z - BALL_SPEC.RADIUS + 1e-4);
  });

  it('T3-P9: rallyEngine.setPaused() × inputManager Mode/Binding Persistence × playerRigs Freeze & Resume Invariance', () => {
    // 1. Exercise real inputManager STORAGE_KEYS.BINDINGS persistence across destroy & re-instantiation
    activeShims = installInputShims();
    activeInput = inputMod.createInputManager(activeShims.canvas);
    activeInput.setMode(INPUT_MODES.TWO_PAD_KEYBOARD);

    const custom = createDefaultBindings();
    custom.keyboard.p1.primary = ['KeyF'];
    activeInput.setBindings(custom);

    activeInput.destroy();
    activeInput = inputMod.createInputManager(activeShims.canvas);
    activeInput.setMode(INPUT_MODES.TWO_PAD_KEYBOARD);
    assert.ok(
      activeInput.getBindings().keyboard.p1.primary.includes('KeyF'),
      'Re-instantiated inputManager must reload KeyF binding from STORAGE_KEYS.BINDINGS',
    );

    // 2. Drive 2v2 rallyEngine + all 4 real Three.js playerRigs
    const engine = rallyMod.createRallyEngine({
      format: MATCH_FORMATS.TWO_V_TWO,
      aiStyle: AI_STYLES.SPIN_SLICER,
    });
    const rigMap = new Map();
    try {
      for (const p of engine.getSnapshot().players) {
        rigMap.set(p.id, rigs.createPlayerRig({ id: p.id, team: p.team, role: p.role }));
      }
      assert.equal(rigMap.size, 4, '2v2 must build 4 articulated player rigs');

      activeShims.dispatchKey('keydown', 'KeyD');
      for (let i = 0; i < 20; i++) {
        engine.update(1 / 60, activeInput.pollInputs(1 / 60), PHYSICS_DEFAULTS);
        const snap = engine.getSnapshot();
        for (const p of snap.players) {
          rigs.updatePlayerRig(rigMap.get(p.id), p, snap.ball, 1 / 60);
        }
      }

      // 3. Pause engine and capture exact snapshot + rig positions
      engine.setPaused(true);
      const frozenSnap = structuredClone(engine.getSnapshot());
      const frozenRigPos = Array.from(rigMap.values()).map((r) => r.root.position.toArray());

      // 4. Pump active input (KeyF + KeyD) while paused -> bit-exact freeze invariance on engine & rigs
      activeShims.dispatchKey('keydown', 'KeyF');
      for (let i = 0; i < 20; i++) {
        engine.update(1 / 60, activeInput.pollInputs(1 / 60), PHYSICS_DEFAULTS);
        const snap = engine.getSnapshot();
        for (const p of snap.players) {
          rigs.updatePlayerRig(rigMap.get(p.id), p, snap.ball, 0);
        }
      }
      const stillFrozen = engine.getSnapshot();
      const stillFrozenRigPos = Array.from(rigMap.values()).map((r) => r.root.position.toArray());

      assert.deepStrictEqual(stillFrozen.ball.pos, frozenSnap.ball.pos, 'ball.pos must stay frozen while paused');
      assert.deepStrictEqual(
        stillFrozen.players.map((p) => p.pos),
        frozenSnap.players.map((p) => p.pos),
        'players[].pos must stay frozen while paused',
      );
      assert.equal(stillFrozen.wind.time, frozenSnap.wind.time, 'wind.time must stay frozen while paused');
      assert.deepStrictEqual(readScores(stillFrozen), readScores(frozenSnap), 'scores must stay frozen while paused');
      assert.deepStrictEqual(stillFrozenRigPos, frozenRigPos, 'All 4 playerRig root positions must stay frozen while paused');

      // 5. Unpause and verify simulation & rigs resume motion cleanly
      engine.setPaused(false);
      activeShims.dispatchKey('keyup', 'KeyF');
      for (let i = 0; i < 20; i++) {
        engine.update(1 / 60, activeInput.pollInputs(1 / 60), PHYSICS_DEFAULTS);
        const snap = engine.getSnapshot();
        for (const p of snap.players) {
          rigs.updatePlayerRig(rigMap.get(p.id), p, snap.ball, 1 / 60);
        }
      }
      activeShims.dispatchKey('keyup', 'KeyD');

      const resumedSnap = engine.getSnapshot();
      const resumedRigPos = Array.from(rigMap.values()).map((r) => r.root.position.toArray());

      assert.ok(resumedSnap.wind.time > frozenSnap.wind.time, 'Unpausing must advance wind.time');
      const ballMoved =
        Math.hypot(
          resumedSnap.ball.pos.x - frozenSnap.ball.pos.x,
          resumedSnap.ball.pos.y - frozenSnap.ball.pos.y,
          resumedSnap.ball.pos.z - frozenSnap.ball.pos.z,
        ) > 1e-4;
      const anyPlayerMoved = resumedSnap.players.some((p, idx) => {
        const prev = frozenSnap.players[idx].pos;
        return Math.hypot(p.pos.x - prev.x, p.pos.y - prev.y, p.pos.z - prev.z) > 1e-4;
      });
      const anyRigMoved = resumedRigPos.some((pos, idx) => {
        const prev = frozenRigPos[idx];
        return Math.hypot(pos[0] - prev[0], pos[1] - prev[1], pos[2] - prev[2]) > 1e-4;
      });
      assert.ok(ballMoved || anyPlayerMoved, 'Unpausing must resume ball/player motion');
      assert.ok(anyRigMoved, 'Unpausing must resume playerRig root movement');

      const finalScores = readScores(resumedSnap);
      assert.ok(finalScores.team1 >= 0 && finalScores.team2 >= 0);
    } finally {
      for (const rig of rigMap.values()) {
        rigs.disposePlayerRig(rig);
      }
    }
  });
});
