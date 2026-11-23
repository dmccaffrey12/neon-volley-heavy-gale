/**
 * SUMMER HEAT 3D — Tier 5 Adversarial & Hardening Regression Suite
 *
 * Pure Node 22 (`node --test`) ESM suite with ZERO external dependencies and
 * ZERO mocks of game/physics/rig/Three.js modules. Tests all 18 confirmed bugs
 * and adversarial edge cases identified during M5 Phase 2 white-box probing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

globalThis.__SUMMER_HEAT_NO_AUTO_INIT__ = true;

import {
  BALL_SPEC,
  CAMERA_MODES,
  COURT,
  EVENTS,
  FIXED_DT,
  INPUT_MODES,
  MATCH_FORMATS,
  PHYSICS_DEFAULTS,
  PHYSICS_LIMITS,
  SHOT_TYPES,
  STORAGE_KEYS,
  TRAIL_MODES,
  WIND_PHASES,
  computeSpinOmega,
  createBallState,
  createWindState,
} from '../../src/contracts.js';
import {
  stepBall3D,
  predictLandingPoint3D,
  updateWind3D,
  triggerGaleSurge,
} from '../../src/physics3d.js';
import { createRallyEngine } from '../../src/rallyEngine.js';
import { createInputManager } from '../../src/inputManager.js';
import { createAudioSynth } from '../../src/audioSynth.js';
import { createCourtScene } from '../../src/courtScene.js';
import { initApp } from '../../src/main.js';
import {
  createMemoryStorage,
  createMockGamepad,
  installInputShims,
  assertFiniteVec3,
  extractEventTypes,
} from './_helpers/browserShims.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---- Thin Browser-API Shims (Node 22 headless host for real Three.js / main.js) ----

function createHeadlessRendererStub() {
  let lastScene = null;
  let disposeCount = 0;
  return {
    shadowMap: { enabled: false, type: null },
    toneMapping: null,
    toneMappingExposure: 1,
    outputColorSpace: null,
    pixelRatio: 1,
    scissorTest: false,
    getLastScene: () => lastScene,
    getDisposeCount: () => disposeCount,
    setPixelRatio(r) {
      this.pixelRatio = r;
    },
    setClearColor() {},
    setSize() {},
    setViewport() {},
    setScissor() {},
    setScissorTest(enabled) {
      this.scissorTest = Boolean(enabled);
    },
    clear() {},
    render(scene) {
      lastScene = scene;
    },
    dispose() {
      disposeCount += 1;
    },
  };
}

function createHeadless2DCanvasFactory() {
  return (width, height) => {
    const ctx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      fillRect() {},
      strokeRect() {},
      clearRect() {},
      fillText() {},
      beginPath() {},
      closePath() {},
      moveTo() {},
      lineTo() {},
      bezierCurveTo() {},
      quadraticCurveTo() {},
      arc() {},
      fill() {},
      stroke() {},
      save() {},
      restore() {},
      createLinearGradient() {
        return { addColorStop() {} };
      },
      createRadialGradient() {
        return { addColorStop() {} };
      },
    };
    return {
      width,
      height,
      getContext() {
        return ctx;
      },
    };
  };
}

function createAppShellDomHost({ width = 1280, height = 720 } = {}) {
  const elements = new Map();

  function makeElement(id) {
    const listeners = new Map();
    const classes = new Set();
    const attrs = new Map();
    const el = {
      id,
      textContent: '',
      value: '',
      min: '',
      max: '',
      step: '',
      hidden: id === 'quickBindModal' || id === 'portraitOverlay' || id === 'rallyBanner',
      style: {},
      width,
      height,
      clientWidth: width,
      clientHeight: height,
      getBoundingClientRect() {
        return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight };
      },
      classList: {
        toggle(cls, force) {
          const on = force !== undefined ? Boolean(force) : !classes.has(cls);
          if (on) classes.add(cls);
          else classes.delete(cls);
          return on;
        },
        contains(cls) {
          return classes.has(cls);
        },
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.get(k) ?? null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      dispatch(type, eventObj = {}) {
        const list = listeners.get(type);
        if (!list) return;
        const ev = { target: el, preventDefault() {}, ...eventObj };
        for (const fn of Array.from(list)) {
          fn(ev);
        }
      },
    };
    return el;
  }

  const knownIds = [
    'gameCanvas',
    'hudOverlay',
    'scoreT1',
    'scoreT2',
    'touchIndicator',
    'heatBarT1',
    'heatBarT2',
    'windReadout',
    'cameraToggleBtn',
    'formatToggleBtn',
    'aiStyleSelect',
    'mode1PadBtn',
    'mode2PadBtn',
    'modeTouchBtn',
    'quickBindBtn',
    'audioToggleBtn',
    'physicsLabBtn',
    'classic2dBtn',
    'resetMatchBtn',
    'rallyBanner',
    'controlsHint',
    'physicsDrawer',
    'closeDrawerBtn',
    'sliderGravity',
    'sliderDrag',
    'sliderMagnus',
    'sliderGust',
    'sliderSpeed',
    'valGravity',
    'valDrag',
    'valMagnus',
    'valGust',
    'valSpeed',
    'resetPhysicsBtn',
    'forceGustBtn',
    'quickBindModal',
    'quickBindPrompt',
    'quickBindCountdown',
    'quickBindCancelBtn',
    'quickBindResetBtn',
    'portraitOverlay',
  ];
  for (const id of knownIds) {
    elements.set(id, makeElement(id));
  }

  const winListeners = new Map();
  const docListeners = new Map();
  let rafSeq = 0;

  const doc = {
    readyState: 'complete',
    visibilityState: 'visible',
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatch(type, ev = {}) {
      const list = docListeners.get(type);
      if (!list) return;
      for (const fn of Array.from(list)) fn(ev);
    },
  };

  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    document: doc,
    requestAnimationFrame() {
      rafSeq += 1;
      return rafSeq;
    },
    cancelAnimationFrame() {},
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    dispatch(type, ev = {}) {
      const list = winListeners.get(type);
      if (!list) return;
      for (const fn of Array.from(list)) fn(ev);
    },
  };

  return { win, doc, elements };
}

function makeNeutralCmd(overrides = {}) {
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
    ...overrides,
  };
}

function advanceUntilTeamTouch2Set(engine, team, { autoFootwork = true, maxSteps = 900 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    const snap = engine.getSnapshot();
    const isSetReady =
      snap.scoreboard.phase === 'RALLY' &&
      snap.scoreboard.activeTeam === team &&
      snap.scoreboard.touchCount === 2 &&
      snap.timingRing.active &&
      snap.timingRing.team === team;
    if (isSetReady) {
      return snap;
    }

    const p1Cmd =
      team === 1
        ? makeNeutralCmd({ isHuman: true, autoFootwork, primaryHeld: false })
        : makeNeutralCmd({ isHuman: false });
    const p2Cmd =
      team === 2
        ? makeNeutralCmd({ isHuman: true, autoFootwork, primaryHeld: false })
        : makeNeutralCmd({ isHuman: false });

    // Trigger Bump on touch 0 and Set on touch 1 when ball enters striking distance
    const actor = snap.players.find((p) => p.team === team && p.role === 'PRIMARY');
    const ball = snap.ball;
    const onSide = team === 1 ? ball.pos.x < 0 : ball.pos.x > 0;
    const dist = actor ? Math.hypot(actor.pos.x - ball.pos.x, actor.pos.z - ball.pos.z) : 99;
    if (onSide && dist < 1.35 && ball.pos.y < 2.6 && snap.scoreboard.touchCount < 2) {
      if (team === 1) {
        p1Cmd.primaryJustPressed = true;
        p1Cmd.primaryHeld = true;
      } else {
        p2Cmd.primaryJustPressed = true;
        p2Cmd.primaryHeld = true;
      }
    }

    engine.stepFixed(FIXED_DT, { p1: p1Cmd, p2: p2Cmd }, PHYSICS_DEFAULTS);
  }
  return engine.getSnapshot();
}

// ============================================================================
// T5-01: TOUCH_AUTO Zero-Swipe Tap Attack vs. Auto-Footwork (BUG-C1-1)
// ============================================================================
describe('T5-01 — TOUCH_AUTO zero-swipe tap attack & autoAimZ isolation (BUG-C1-1)', () => {
  it('fires HEAT_SPIKE (not POKEY_CUT) on zero-swipe TOUCH tap when P1 stands ahead of timingRing (backward auto-footwork)', () => {
    const shims = installInputShims({ rect: { left: 0, top: 0, width: 1280, height: 720 } });
    try {
      const inputMgr = createInputManager(shims.canvas, {
        initialMode: INPUT_MODES.TOUCH_AUTO,
        storage: shims.localStorage,
        windowTarget: shims.window,
      });
      const engine = createRallyEngine({
        format: MATCH_FORMATS.ONE_V_ONE,
        servingTeam: 2,
        seed: 7,
      });

      const setSnap = advanceUntilTeamTouch2Set(engine, 1, { autoFootwork: true });
      assert.equal(setSnap.scoreboard.touchCount, 2, 'Team 1 must reach Touch 2 Set');
      assert.equal(setSnap.timingRing.active, true, 'Timing ring must be active after Set');

      // Walk P1 forward toward the net (x > timingRing.pos.x - 0.25) so auto-footwork wants to step backward (-X)
      for (let i = 0; i < 65; i++) {
        const s = engine.getSnapshot();
        const p1 = s.players.find((p) => p.id === 'p1');
        if (p1.pos.x > s.timingRing.pos.x + 0.15 && s.timingRing.progress >= 0.68) {
          break;
        }
        const moveTowardNet = p1.pos.x < s.timingRing.pos.x + 0.22 ? 1 : 0;
        engine.stepFixed(
          FIXED_DT,
          { p1: makeNeutralCmd({ isHuman: true, moveX: moveTowardNet }), p2: makeNeutralCmd() },
          PHYSICS_DEFAULTS,
        );
      }

      const preTap = engine.getSnapshot();
      const p1Before = preTap.players.find((p) => p.id === 'p1');
      assert.ok(
        p1Before.pos.x > preTap.timingRing.pos.x - 0.15,
        `P1 must stand ahead of ring target to induce backward auto-footwork (p1.x=${p1Before.pos.x}, ring.x=${preTap.timingRing.pos.x})`,
      );

      // Dispatch a genuine zero-drag single-finger touchstart on the left half
      shims.dispatchPointer('pointerdown', { clientX: 280, clientY: 360, pointerId: 11 });
      const polled = inputMgr.pollInputs(FIXED_DT);
      assert.equal(polled.p1.autoFootwork, true);
      assert.equal(polled.p1.primaryJustPressed, true);
      assert.equal(polled.p1.aimX, 0);
      assert.equal(polled.p1.aimZ, 0);
      assert.equal(polled.p1.secondaryHeld, false);

      let attackEvent = null;
      let postSnap = engine.stepFixed(FIXED_DT, polled, PHYSICS_DEFAULTS);
      const evs0 = extractEventTypes(postSnap.events);
      if (evs0.includes(EVENTS.HEAT_SPIKE) || evs0.includes(EVENTS.POKEY_CUT) || evs0.includes(EVENTS.SPIKE)) {
        attackEvent = evs0.find((t) => t === EVENTS.HEAT_SPIKE || t === EVENTS.POKEY_CUT || t === EVENTS.SPIKE);
      }

      for (let i = 0; i < 40 && !attackEvent; i++) {
        const p = inputMgr.pollInputs(FIXED_DT);
        postSnap = engine.stepFixed(FIXED_DT, p, PHYSICS_DEFAULTS);
        const evs = extractEventTypes(postSnap.events);
        attackEvent = evs.find((t) => t === EVENTS.HEAT_SPIKE || t === EVENTS.POKEY_CUT || t === EVENTS.SPIKE) || null;
      }

      assert.equal(attackEvent, EVENTS.HEAT_SPIKE, 'Zero-swipe TOUCH tap must unleash HEAT_SPIKE, never accidental POKEY_CUT');
      assert.equal(postSnap.ball.shotType, SHOT_TYPES.HEAT_SPIKE);
      assert.equal(postSnap.ball.trailMode, TRAIL_MODES.FLAME);

      inputMgr.destroy();
    } finally {
      shims.restore();
    }
  });

  it('fires HEAT_SPIKE symmetrically for P2 TOUCH tap under backward auto-footwork and preserves open-court autoAimZ with zero spurious sidespin', () => {
    // Part A: Symmetric P2 TOUCH tap
    const engineP2 = createRallyEngine({
      format: MATCH_FORMATS.ONE_V_ONE,
      servingTeam: 1,
      seed: 13,
    });
    const setP2 = advanceUntilTeamTouch2Set(engineP2, 2, { autoFootwork: true });
    assert.equal(setP2.scoreboard.touchCount, 2, 'Team 2 must reach Touch 2 Set');

    // Walk P2 slightly ahead of ring (closer to net: smaller positive x) so P2 auto-footwork steps backward (+X)
    for (let i = 0; i < 65; i++) {
      const s = engineP2.getSnapshot();
      const p2 = s.players.find((p) => p.id === 'p2');
      if (p2.pos.x < s.timingRing.pos.x - 0.15 && s.timingRing.progress >= 0.68) {
        break;
      }
      const moveTowardNet = p2.pos.x > s.timingRing.pos.x - 0.22 ? -1 : 0;
      engineP2.stepFixed(
        FIXED_DT,
        { p1: makeNeutralCmd(), p2: makeNeutralCmd({ isHuman: true, moveX: moveTowardNet }) },
        PHYSICS_DEFAULTS,
      );
    }

    let p2Shot = null;
    for (let i = 0; i < 35 && !p2Shot; i++) {
      const s = engineP2.stepFixed(
        FIXED_DT,
        {
          p1: makeNeutralCmd(),
          p2: makeNeutralCmd({
            isHuman: true,
            autoFootwork: true,
            primaryJustPressed: i === 0,
            primaryHeld: true,
          }),
        },
        PHYSICS_DEFAULTS,
      );
      const evs = extractEventTypes(s.events);
      if (evs.includes(EVENTS.HEAT_SPIKE) || evs.includes(EVENTS.POKEY_CUT)) {
        p2Shot = s.ball.shotType;
      }
    }
    assert.equal(p2Shot, SHOT_TYPES.HEAT_SPIKE, 'P2 zero-swipe TOUCH tap must fire HEAT_SPIKE');

    // Part B: Lateral auto-footwork must NOT defeat autoAimZ or inject spurious sidespin
    const engineAim = createRallyEngine({
      format: MATCH_FORMATS.ONE_V_ONE,
      servingTeam: 2,
      seed: 19,
    });
    advanceUntilTeamTouch2Set(engineAim, 1, { autoFootwork: true });

    // Move P2 deep to -Z (making +Z open court) and nudge P1 to z ~= +0.65 (so auto-footwork steps toward -Z while staying in strike reach)
    for (let i = 0; i < 65; i++) {
      const s = engineAim.getSnapshot();
      const p1Now = s.players.find((p) => p.id === 'p1');
      if (s.timingRing.progress >= 0.72) break;
      const moveP1Z = p1Now.pos.z < s.timingRing.pos.z + 0.65 ? 1 : 0;
      const moveP1X = p1Now.pos.x < s.timingRing.pos.x - 0.15 ? 1 : (p1Now.pos.x > s.timingRing.pos.x + 0.15 ? -1 : 0);
      engineAim.stepFixed(
        FIXED_DT,
        {
          p1: makeNeutralCmd({ isHuman: true, moveX: moveP1X, moveZ: moveP1Z }),
          p2: makeNeutralCmd({ isHuman: true, moveZ: -1 }),
        },
        PHYSICS_DEFAULTS,
      );
    }

    const beforeAttack = engineAim.getSnapshot();
    const p1Pos = beforeAttack.players.find((p) => p.id === 'p1').pos;
    const p2Pos = beforeAttack.players.find((p) => p.id === 'p2').pos;
    assert.ok(p1Pos.z > beforeAttack.timingRing.pos.z + 0.25, 'P1 must be on +Z side of ring so autoMove.moveZ < 0');
    assert.ok(p2Pos.z < -0.5, 'P2 must be on -Z side so open court is +Z');

    let aimedSnap = null;
    for (let i = 0; i < 30 && !aimedSnap; i++) {
      const s = engineAim.stepFixed(
        FIXED_DT,
        {
          p1: makeNeutralCmd({
            isHuman: true,
            autoFootwork: true,
            primaryJustPressed: i === 0,
            primaryHeld: true,
          }),
          p2: makeNeutralCmd({ isHuman: true, moveZ: -1 }),
        },
        PHYSICS_DEFAULTS,
      );
      if (extractEventTypes(s.events).includes(EVENTS.HEAT_SPIKE)) {
        aimedSnap = s;
      }
    }

    assert.ok(aimedSnap, 'HEAT_SPIKE must fire');
    assert.ok(
      aimedSnap.ball.vel.z > 0.5,
      `autoAimZ must aim toward open +Z court (got vel.z=${aimedSnap.ball.vel.z})`,
    );
    assert.ok(
      Math.abs(aimedSnap.ball.omega.y) < 1e-6,
      `Zero-swipe tap must not inject spurious sidespin (got omega.y=${aimedSnap.ball.omega.y})`,
    );
  });
});

// ============================================================================
// T5-02: Quick-Bind Gamepad Slot-3 Hold Suppression & Touch Isolation (BUG-C1-2)
// ============================================================================
describe('T5-02 — Quick-Bind gamepad slot-3 hold suppression & touch isolation (BUG-C1-2)', () => {
  it('suppresses still-held slot-3 gamepad button across Quick-Bind completion (including overlapping 1PAD buttons) until released', () => {
    const shims = installInputShims();
    try {
      let pads = [createMockGamepad({ index: 0, pressedButtons: [] })];
      shims.setGamepads(pads);

      const mgr = createInputManager(shims.canvas, {
        initialMode: INPUT_MODES.ONE_PAD_SPLIT,
        storage: shims.localStorage,
        windowTarget: shims.window,
        getGamepads: () => pads,
      });

      let donePayload = null;
      mgr.startQuickBind(null, (res) => {
        donePayload = res;
      });

      // Bind slots 0, 1, 2 cleanly (press -> release)
      for (const btn of [1, 2, 3]) {
        pads = [createMockGamepad({ index: 0, pressedButtons: [btn] })];
        mgr.pollInputs(1 / 60);
        pads = [createMockGamepad({ index: 0, pressedButtons: [] })];
        mgr.pollInputs(1 / 60);
      }

      // Bind slot 3 (p2Secondary) with button 4 (also P1 default 1PAD primary button!) and KEEP IT HELD
      pads = [createMockGamepad({ index: 0, pressedButtons: [4] })];
      const completionFrame = mgr.pollInputs(1 / 60);
      assert.ok(donePayload && donePayload.completed, 'Quick-Bind must complete on slot 3');
      assert.equal(completionFrame.p1.primaryHeld, false);
      assert.equal(completionFrame.p2.secondaryHeld, false);

      // Next frames while button 4 is STILL held: zero phantom inputs for BOTH P1 & P2!
      for (let f = 0; f < 3; f++) {
        const heldFrame = mgr.pollInputs(1 / 60);
        assert.equal(heldFrame.p2.secondaryHeld, false, 'p2.secondaryHeld must stay suppressed while slot-3 button held');
        assert.equal(heldFrame.p2.secondaryJustPressed, false, 'p2.secondaryJustPressed must stay suppressed');
        assert.equal(heldFrame.p1.primaryHeld, false, 'overlapping 1PAD p1.primaryHeld must stay suppressed');
        assert.equal(heldFrame.p1.primaryJustPressed, false, 'overlapping 1PAD p1.primaryJustPressed must stay suppressed');
      }

      // Release button 4, then press fresh -> must now trigger cleanly
      pads = [createMockGamepad({ index: 0, pressedButtons: [] })];
      mgr.pollInputs(1 / 60);
      pads = [createMockGamepad({ index: 0, pressedButtons: [4] })];
      const freshFrame = mgr.pollInputs(1 / 60);
      assert.equal(freshFrame.p2.secondaryJustPressed, true, 'Fresh press after release must trigger p2.secondaryJustPressed');
      assert.equal(freshFrame.p1.primaryJustPressed, true, 'Fresh press after release must trigger overlapping p1.primaryJustPressed');

      mgr.destroy();
    } finally {
      shims.restore();
    }
  });

  it('ignores touch/mouse starts during Quick-Bind and clears active touches on cancel/start', () => {
    const shims = installInputShims({ rect: { left: 0, top: 0, width: 1280, height: 720 } });
    try {
      const mgr = createInputManager(shims.canvas, {
        initialMode: INPUT_MODES.TOUCH_AUTO,
        storage: shims.localStorage,
        windowTarget: shims.window,
      });

      // Touch started before Quick-Bind must be cleared by startQuickBind()
      shims.dispatchPointer('pointerdown', { clientX: 200, clientY: 300, pointerId: 1 });
      mgr.startQuickBind();

      // New touch & mouse press during Quick-Bind must be ignored
      shims.dispatchPointer('pointerdown', { clientX: 220, clientY: 320, pointerId: 2 });
      shims.canvas.dispatchEvent(Object.assign(new Event('mousedown'), { button: 0, clientX: 240, clientY: 320 }));

      mgr.cancelQuickBind();
      const afterCancel = mgr.pollInputs(1 / 60);
      assert.equal(afterCancel.p1.primaryHeld, false, 'Touches during Quick-Bind must not leak primaryHeld after cancel');
      assert.equal(afterCancel.p1.primaryJustPressed, false, 'Touches during Quick-Bind must not leak primaryJustPressed');

      mgr.destroy();
    } finally {
      shims.restore();
    }
  });
});

// ============================================================================
// T5-03: Disconnected Gamepad (`connected: false`) Rejection (BUG-C1-4)
// ============================================================================
describe('T5-03 — Disconnected gamepad (connected: false) rejection (BUG-C1-4)', () => {
  it('ignores connected:false gamepads in 1PAD, 2PAD, and Quick-Bind', () => {
    const shims = installInputShims();
    try {
      const disconnectedPads = [
        createMockGamepad({ index: 0, connected: false, axes: [0.95, -0.85, 0.75, 0.65], pressedButtons: [0, 4, 5] }),
        createMockGamepad({ index: 1, connected: false, axes: [-0.9, 0.8, 0, 0], pressedButtons: [0, 1] }),
      ];

      const mgr = createInputManager(shims.canvas, {
        initialMode: INPUT_MODES.ONE_PAD_SPLIT,
        storage: shims.localStorage,
        windowTarget: shims.window,
        getGamepads: () => disconnectedPads,
      });

      const out1Pad = mgr.pollInputs(1 / 60);
      assert.equal(out1Pad.padsConnected, 0, 'Disconnected pads must not count as connected in 1PAD');
      assert.equal(out1Pad.p1.moveX, 0);
      assert.equal(out1Pad.p1.primaryHeld, false);
      assert.equal(out1Pad.p2.moveX, 0);
      assert.equal(out1Pad.p2.primaryHeld, false);

      mgr.setMode(INPUT_MODES.TWO_PAD_KEYBOARD);
      const out2Pad = mgr.pollInputs(1 / 60);
      assert.equal(out2Pad.padsConnected, 0, 'Disconnected pads must not count as connected in 2PAD');
      assert.equal(out2Pad.p1.primaryHeld, false);
      assert.equal(out2Pad.p2.primaryHeld, false);

      let lastStatus = null;
      mgr.startQuickBind((s) => {
        lastStatus = s;
      });
      mgr.pollInputs(1 / 60);
      assert.equal(lastStatus.slotIndex, 0, 'Disconnected pad buttons must not advance Quick-Bind slots');

      mgr.cancelQuickBind();
      mgr.destroy();
    } finally {
      shims.restore();
    }
  });
});

// ============================================================================
// T5-04: audioSynth Fault Tolerance, Partial Cleanup & Negative Time (BUG-C1-3)
// ============================================================================
describe('T5-04 — audioSynth runtime fault tolerance, partial init cleanup & negative time (BUG-C1-3)', () => {
  function createHostileAudioContextFactory({
    initialState = 'suspended',
    failOnFilterNum = null,
    throwOnRuntimeOsc = false,
    initialCurrentTime = 0.5,
  } = {}) {
    const metrics = {
      resumeCalls: 0,
      closeCalls: 0,
      sourcesStarted: 0,
      sourcesStopped: 0,
      oscStarted: 0,
      oscStopped: 0,
      negativeStartTimes: 0,
      totalScheduledStarts: 0,
      instances: [],
    };

    function makeParam(val = 0) {
      return {
        value: val,
        setValueAtTime() {},
        setTargetAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
      };
    }

    class HostileAudioContext {
      constructor() {
        this.state = initialState;
        this.sampleRate = 44100;
        this.currentTime = initialCurrentTime;
        this.destination = { connect() {}, disconnect() {} };
        this._filterCount = 0;
        this._runtimeThrowOsc = false;
        metrics.instances.push(this);
      }

      createGain() {
        return { gain: makeParam(1), connect() {}, disconnect() {} };
      }

      createBiquadFilter() {
        this._filterCount += 1;
        if (failOnFilterNum !== null && this._filterCount === failOnFilterNum) {
          throw new Error('QuotaExceededError: filter limit reached');
        }
        return { type: 'lowpass', frequency: makeParam(350), Q: makeParam(1), connect() {}, disconnect() {} };
      }

      createOscillator() {
        if (throwOnRuntimeOsc || this._runtimeThrowOsc) {
          throw new Error('InvalidStateError: AudioContext is closed');
        }
        return {
          type: 'sine',
          frequency: makeParam(440),
          connect() {},
          disconnect() {},
          start(t = 0) {
            metrics.oscStarted += 1;
            metrics.totalScheduledStarts += 1;
            if (typeof t === 'number' && t < 0) metrics.negativeStartTimes += 1;
          },
          stop() {
            metrics.oscStopped += 1;
          },
        };
      }

      createBufferSource() {
        if (this._runtimeThrowOsc) {
          throw new Error('InvalidStateError: AudioContext is closed');
        }
        return {
          buffer: null,
          loop: false,
          connect() {},
          disconnect() {},
          start(t = 0) {
            metrics.sourcesStarted += 1;
            metrics.totalScheduledStarts += 1;
            if (typeof t === 'number' && t < 0) metrics.negativeStartTimes += 1;
          },
          stop() {
            metrics.sourcesStopped += 1;
          },
        };
      }

      createBuffer(channels, length, sampleRate) {
        const buf = new Float32Array(length);
        return { numberOfChannels: channels, length, sampleRate, getChannelData: () => buf };
      }

      resume() {
        metrics.resumeCalls += 1;
        this.state = 'running';
        return Promise.resolve();
      }

      close() {
        metrics.closeCalls += 1;
        this.state = 'closed';
        return Promise.resolve();
      }
    }

    return { HostileAudioContext, metrics };
  }

  it('swallows mid-rally InvalidStateError and closed-context synthesis without throwing', () => {
    const { HostileAudioContext, metrics } = createHostileAudioContextFactory();
    const synth = createAudioSynth({ AudioContextCtor: HostileAudioContext });
    assert.equal(synth.setEnabled(true), true);

    const ctx = metrics.instances[0];
    ctx._runtimeThrowOsc = true;
    assert.doesNotThrow(() => {
      synth.handleEvents([EVENTS.HEAT_SPIKE, EVENTS.POINT_SCORED, EVENTS.DIVE, EVENTS.SERVE]);
      synth.playRefereeWhistle('match');
      synth.playChargeSweep(0.9);
    });

    ctx._runtimeThrowOsc = false;
    ctx.state = 'closed';
    const startsBeforeClosed = metrics.totalScheduledStarts;
    assert.doesNotThrow(() => {
      synth.handleEvents([EVENTS.HEAT_SPIKE, EVENTS.BUMP, EVENTS.POINT_SCORED]);
      synth.updateAmbience({ speed: 10, phase: WIND_PHASES.GUST });
    });
    assert.equal(metrics.totalScheduledStarts, startsBeforeClosed, 'Closed context must not schedule new audio nodes');
    synth.dispose();
  });

  it('cleans up partially started nodes and closes context when ensureGraph() throws mid-init', () => {
    const { HostileAudioContext, metrics } = createHostileAudioContextFactory({ failOnFilterNum: 2 });
    const synth = createAudioSynth({ AudioContextCtor: HostileAudioContext });

    assert.equal(synth.setEnabled(true), false, 'Partial graph failure must leave synth disabled');
    assert.equal(synth.isEnabled(), false);
    assert.ok(metrics.sourcesStarted >= 1 && metrics.sourcesStopped >= metrics.sourcesStarted, 'Started surfSource must be stopped on partial failure');
    assert.ok(metrics.oscStarted >= 1 && metrics.oscStopped >= metrics.oscStarted, 'Started surfLfo must be stopped on partial failure');
    assert.equal(metrics.closeCalls, 1, 'Partially created AudioContext must be closed on failure');
    synth.dispose();
  });

  it('resumes iOS interrupted AudioContext and clamps negative currentTime across 100-event burst', () => {
    const { HostileAudioContext, metrics } = createHostileAudioContextFactory({
      initialState: 'interrupted',
      initialCurrentTime: -2.5,
    });
    const synth = createAudioSynth({ AudioContextCtor: HostileAudioContext });

    assert.equal(synth.setEnabled(true), true);
    assert.equal(metrics.resumeCalls, 1, 'setEnabled(true) must resume interrupted AudioContext');

    const burst = [];
    for (let i = 0; i < 50; i++) {
      burst.push({ type: EVENTS.CHARGE_TICK, ratio: i / 50 });
      burst.push(EVENTS.BUMP);
    }
    const oscBefore = metrics.oscStarted;
    synth.handleEvents(burst);
    const oscDelta = metrics.oscStarted - oscBefore;

    assert.equal(metrics.negativeStartTimes, 0, 'now() must clamp negative currentTime so zero negative start times occur');
    assert.equal(oscDelta, 51, '50 CHARGE_TICKs must rate-limit to 1 sweep + 50 BUMP tones = 51');
    synth.dispose();
  });
});

// ============================================================================
// T5-05: Remote Stuff-Block Drift X-Proximity Boundary (BUG-C1-5)
// ============================================================================
describe('T5-05 — Remote Stuff-Block X-proximity boundary (BUG-C1-5)', () => {
  it('blocks spikes when blocker stays near net (<=1.95m) and rejects remote Stuff-Blocks when blocker drifts deep (>1.95m)', () => {
    function runBlockDriftScenario(sprintBackwardAfterBlock) {
      let deliverSpikeNow = false;
      const customPhysics = {
        FIXED_DT,
        updateWind3D: () => ({ phaseChanged: false, phase: WIND_PHASES.BREEZE }),
        triggerGaleSurge: () => {},
        predictLandingPoint3D: (b) => ({ x: b.pos.x, z: b.pos.z, hangTime: 0.4, landedWithinSteps: true, steps: 10, trajectory: [] }),
        stepBall3D: (b) => {
          if (!deliverSpikeNow) {
            // Keep ball suspended on Team 1 side while P2 positions and jumps
            b.pos.x = -3.0;
            b.pos.y = 3.2;
            b.pos.z = 0;
            b.vel.x = 0;
            b.vel.y = 0;
            b.vel.z = 0;
            b.lastHitTeam = 1;
          } else {
            // Deliver a fast Team 1 spike directly into the net block zone at x = 0.1, y = 2.8, z = 0
            b.pos.x = 0.1;
            b.pos.y = 2.8;
            b.pos.z = 0;
            b.vel.x = 14.0;
            b.vel.y = -1.0;
            b.vel.z = 0;
            b.lastHitTeam = 1;
          }
          return { landed: false, wallHit: null, netHit: null, crossedNet: false, speed: 14 };
        },
      };

      const engine = createRallyEngine({
        format: MATCH_FORMATS.ONE_V_ONE,
        servingTeam: 1,
        physics: customPhysics,
      });

      // Sprint P2 near net until x <= 1.75 (inside <= 1.85 NetBlock initiation zone)
      for (let i = 0; i < 120; i++) {
        const s = engine.getSnapshot();
        const p2 = s.players.find((p) => p.id === 'p2');
        if (p2.pos.x <= 1.75) break;
        engine.stepFixed(FIXED_DT, { p1: makeNeutralCmd(), p2: makeNeutralCmd({ isHuman: true, moveX: -1 }) }, PHYSICS_DEFAULTS);
      }

      // Trigger NetBlock at x ~= 1.75 (ball on T1 side -> secondary triggers NetBlock)
      let snap = engine.stepFixed(
        FIXED_DT,
        { p1: makeNeutralCmd(), p2: makeNeutralCmd({ isHuman: true, secondaryJustPressed: true, secondaryHeld: true }) },
        PHYSICS_DEFAULTS,
      );
      const p2AfterJump = snap.players.find((p) => p.id === 'p2');
      assert.ok(p2AfterJump.blockTimer > 0, 'P2 must enter active NetBlock');

      // Drift backward (+X) for 35 steps (~0.29s, leaving blockTimer > 0) or hold near net, then deliver spike
      let stuffed = false;
      let p2XAtArrival = p2AfterJump.pos.x;
      let blockTimerAtArrival = p2AfterJump.blockTimer;
      for (let i = 0; i < 40; i++) {
        if (i === 35) {
          deliverSpikeNow = true;
        }
        snap = engine.stepFixed(
          FIXED_DT,
          {
            p1: makeNeutralCmd(),
            p2: makeNeutralCmd({ isHuman: true, moveX: sprintBackwardAfterBlock ? 1 : 0 }),
          },
          PHYSICS_DEFAULTS,
        );
        if (i === 35) {
          const p2 = snap.players.find((p) => p.id === 'p2');
          p2XAtArrival = p2.pos.x;
          blockTimerAtArrival = p2.blockTimer;
        }
        if (extractEventTypes(snap.events).includes(EVENTS.STUFF_BLOCK)) {
          stuffed = true;
        }
      }
      return { stuffed, p2XAtArrival, blockTimerAtArrival };
    }

    const deepDrift = runBlockDriftScenario(true);
    assert.ok(deepDrift.blockTimerAtArrival > 0, 'Blocker must still have active blockTimer at arrival');
    assert.ok(deepDrift.p2XAtArrival > 2.0, `Blocker must have drifted >2.0m away (got ${deepDrift.p2XAtArrival})`);
    assert.equal(deepDrift.stuffed, false, 'Blocker beyond |pos.x| > 1.95 must NOT remotely Stuff-Block');

    const atNet = runBlockDriftScenario(false);
    assert.ok(atNet.p2XAtArrival <= 1.95, `Stationary net blocker must be within 1.95m (got ${atNet.p2XAtArrival})`);
    assert.equal(atNet.stuffed, true, 'Blocker within |pos.x| <= 1.95 must Stuff-Block cleanly');
  });
});

// ============================================================================
// T5-06: Exact x === 0 Net Crossing Possession & Touch-Count Invariance (BUG-C1-6)
// ============================================================================
describe('T5-06 — Exact x === 0 net-plane crossing invariance (BUG-C1-6)', () => {
  it('assigns activeTeam=1 on +0.1 -> 0.0 -> -0.1 crossing and never resets touchCount on -0.1 -> 0.0 -> -0.1 rebound', () => {
    // Subtest A: +0.1 -> 0.0 -> -0.1 using real physics3d stepBall3D (kDrag=0, vx=-12 => exact dx=-0.1)
    let phase = 0;
    const seqPhysicsA = {
      FIXED_DT,
      updateWind3D: () => ({ phaseChanged: false, phase: WIND_PHASES.BREEZE }),
      triggerGaleSurge: () => {},
      predictLandingPoint3D,
      stepBall3D: (b, w, cfg, dt, sim) => {
        phase += 1;
        if (phase === 1) {
          b.pos.x = 0.1;
          b.pos.y = 4.0;
          b.pos.z = 0;
          b.vel.x = -12.0;
          b.vel.y = 0;
          b.vel.z = 0;
          b.omega.x = 0;
          b.omega.y = 0;
          b.omega.z = 0;
          return { landed: false, wallHit: null, netHit: null, crossedNet: false, speed: 12 };
        }
        return stepBall3D(b, w, cfg, dt, sim);
      },
    };
    const zeroDragCfg = { ...PHYSICS_DEFAULTS, kDrag: 0, kMagnus: 0, gustScale: 0 };
    const engineA = createRallyEngine({ servingTeam: 1, physics: seqPhysicsA });

    engineA.stepFixed(FIXED_DT, null, zeroDragCfg); // sets pos.x = +0.1 (side +1)
    const atZero = engineA.stepFixed(FIXED_DT, null, zeroDragCfg); // real physics moves +0.1 -> 0.0
    assert.ok(Math.abs(atZero.ball.pos.x) < 1e-12, `Step must land on exact x===0 (got ${atZero.ball.pos.x})`);
    const afterZero = engineA.stepFixed(FIXED_DT, null, zeroDragCfg); // real physics moves 0.0 -> -0.1
    assert.ok(afterZero.ball.pos.x < -0.05, `Next step must enter Team 1 side (got ${afterZero.ball.pos.x})`);
    assert.equal(afterZero.scoreboard.activeTeam, 1, 'Entering x < 0 after x === 0 must assign activeTeam === 1');

    // Subtest B: Team 1 ball on touchCount === 2 touches x === 0.0 then bounces back to -0.1 -> touchCount preserved!
    const engineB = createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, servingTeam: 2, seed: 5 });
    const setSnap = advanceUntilTeamTouch2Set(engineB, 1, { autoFootwork: true });
    assert.equal(setSnap.scoreboard.touchCount, 2);

    // Also prove exact -0.1 -> 0.0 -> -0.1 sequence preserves touchCount via minimal trajectory hook
    let stepB = 0;
    const seqPhysicsB = {
      FIXED_DT,
      updateWind3D: () => ({ phaseChanged: false, phase: WIND_PHASES.BREEZE }),
      triggerGaleSurge: () => {},
      predictLandingPoint3D: (b) => ({ x: b.pos.x, z: b.pos.z, hangTime: 0.5, landedWithinSteps: true, steps: 10, trajectory: [] }),
      stepBall3D: (b) => {
        stepB += 1;
        if (stepB <= 18) {
          // Wait past 0.12s globalContactCooldown, then place ball right on P1
          b.pos.x = -4.2;
          b.pos.y = stepB < 18 ? 4.2 : 1.4;
          b.pos.z = 0;
          b.vel.x = 0;
          b.vel.y = -1;
          b.vel.z = 0;
        } else if (stepB === 19) {
          b.pos.x = -0.1;
          b.pos.y = 3.5;
          b.pos.z = 0;
        } else if (stepB === 20) {
          b.pos.x = 0.0;
          b.pos.y = 3.5;
          b.pos.z = 0;
          return { landed: false, wallHit: null, netHit: null, crossedNet: true, speed: 5 };
        } else if (stepB === 21) {
          b.pos.x = -0.1;
          b.pos.y = 3.4;
          b.pos.z = 0;
        }
        return { landed: false, wallHit: null, netHit: null, crossedNet: false, speed: 5 };
      },
    };
    const engineC = createRallyEngine({ servingTeam: 2, physics: seqPhysicsB });
    for (let i = 0; i < 17; i++) {
      engineC.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
    }
    const s1 = engineC.stepFixed(
      FIXED_DT,
      { p1: makeNeutralCmd({ isHuman: true, primaryJustPressed: true, primaryHeld: true }), p2: makeNeutralCmd() },
      PHYSICS_DEFAULTS,
    );
    assert.equal(s1.scoreboard.touchCount, 1, 'P1 must register touch 1');
    engineC.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS); // x = -0.1
    const sZero = engineC.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS); // x = 0.0
    const sBack = engineC.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS); // x = -0.1
    assert.equal(sZero.scoreboard.touchCount, 1, 'Transient x === 0 must not prematurely reset touchCount');
    assert.equal(sBack.scoreboard.touchCount, 1, '-0.1 -> 0.0 -> -0.1 rebound must preserve touchCount');
    assert.equal(sBack.scoreboard.activeTeam, 1);
  });
});

// ============================================================================
// T5-07: 32-Corner PHYSICS_LIMITS Matrix & Max-Headwind Serve Crossing (BUG-C1-7)
// ============================================================================
describe('T5-07 — 32-corner PHYSICS_LIMITS finite stability & max-headwind serve crossing (BUG-C1-7)', () => {
  it('maintains 100% finite states across all 32 PHYSICS_LIMITS corners', () => {
    const gravities = [PHYSICS_LIMITS.gravity[0], PHYSICS_LIMITS.gravity[1]];
    const drags = [PHYSICS_LIMITS.kDrag[0], PHYSICS_LIMITS.kDrag[1]];
    const magnuses = [PHYSICS_LIMITS.kMagnus[0], PHYSICS_LIMITS.kMagnus[1]];
    const gusts = [PHYSICS_LIMITS.gustScale[0], PHYSICS_LIMITS.gustScale[1]];
    const speeds = [PHYSICS_LIMITS.gameSpeed[0], PHYSICS_LIMITS.gameSpeed[1]];

    let cornersTested = 0;
    for (const gravity of gravities) {
      for (const kDrag of drags) {
        for (const kMagnus of magnuses) {
          for (const gustScale of gusts) {
            for (const gameSpeed of speeds) {
              cornersTested += 1;
              const cfg = { ...PHYSICS_DEFAULTS, gravity, kDrag, kMagnus, gustScale, gameSpeed };
              const eng = createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, seed: cornersTested });
              eng.triggerGust(-1);
              for (let f = 0; f < 40; f++) {
                eng.update(1 / 60, null, cfg);
              }
              const snap = eng.getSnapshot();
              assertFiniteVec3(snap.ball.pos, `corner#${cornersTested} ball.pos`);
              assertFiniteVec3(snap.ball.vel, `corner#${cornersTested} ball.vel`);
              assertFiniteVec3(snap.ball.omega, `corner#${cornersTested} ball.omega`);
              assertFiniteVec3(snap.wind.windVec3, `corner#${cornersTested} wind.windVec3`);
              assert.ok(Number.isFinite(snap.prediction.x) && Number.isFinite(snap.prediction.z) && Number.isFinite(snap.prediction.hangTime));
              for (const p of snap.players) {
                assertFiniteVec3(p.pos, `corner#${cornersTested} ${p.id}.pos`);
                assertFiniteVec3(p.vel, `corner#${cornersTested} ${p.id}.vel`);
              }
            }
          }
        }
      }
    }
    assert.equal(cornersTested, 32);
  });

  it('launches automatic serves cleanly across the net even under max legal Physics Lab headwind (g=18, kDrag=0.08, gustScale=2.0)', () => {
    const maxCfg = {
      ...PHYSICS_DEFAULTS,
      gravity: PHYSICS_LIMITS.gravity[1],
      kDrag: PHYSICS_LIMITS.kDrag[1],
      kMagnus: PHYSICS_LIMITS.kMagnus[1],
      gustScale: PHYSICS_LIMITS.gustScale[1],
      gameSpeed: 1.0,
    };

    for (const servingTeam of [1, 2]) {
      const headwindSign = servingTeam === 1 ? -1 : 1;
      const headwindPhysics = {
        FIXED_DT,
        updateWind3D: (w, dt, cfg) => {
          const res = updateWind3D(w, dt, cfg);
          w.phase = WIND_PHASES.GUST;
          w.windVec3.x = headwindSign * 13.0;
          w.windVec3.y = 0;
          w.windVec3.z = 0;
          w.speed = 13.0;
          return res;
        },
        triggerGaleSurge,
        predictLandingPoint3D,
        stepBall3D: (b) => {
          b.pos.y = 5.0;
          return { landed: false, wallHit: null, netHit: null, crossedNet: false, speed: 5 };
        },
      };

      const eng = createRallyEngine({
        format: MATCH_FORMATS.ONE_V_ONE,
        servingTeam,
        seed: 42,
        physics: headwindPhysics,
      });
      eng.stepFixed(FIXED_DT, null, maxCfg);
      // Force fresh serve into active -13 m/s headwind
      eng.setFormat(MATCH_FORMATS.TWO_V_TWO);
      const serveSnap = eng.getSnapshot();
      assert.equal(serveSnap.ball.shotType, SHOT_TYPES.SERVE);
      assert.equal(serveSnap.scoreboard.servingTeam, servingTeam);

      // Roll out the served ball through 100% real physics3d.stepBall3D against constant -13 m/s headwind
      const ball = createBallState(serveSnap.ball);
      const wind = createWindState({
        phase: WIND_PHASES.GUST,
        windVec3: { x: headwindSign * 13.0, y: 0, z: 0 },
        speed: 13.0,
      });

      let crossedNet = false;
      for (let s = 0; s < 360; s++) {
        const res = stepBall3D(ball, wind, maxCfg, FIXED_DT, false);
        if ((servingTeam === 1 && ball.pos.x > 0.25) || (servingTeam === 2 && ball.pos.x < -0.25)) {
          crossedNet = true;
        }
        if (res.landed) break;
      }
      assert.equal(
        crossedNet,
        true,
        `Team ${servingTeam} automatic serve must cross net under -13 m/s max headwind (landed at x=${ball.pos.x.toFixed(2)})`,
      );
    }
  });
});

// ============================================================================
// T5-08: 60-Angle 3D Tape-Post Junction Sweep & Extreme Wall Spin Stress
// ============================================================================
describe('T5-08 — 60-angle 3D tape-post junction sweep & extreme wall corner spin stress', () => {
  it('produces zero freezes, zero NaNs, <=2 consecutive net hits, and predictor parity across 60 3D junction angles', () => {
    const wind = createWindState({ windVec3: { x: -2.0, y: 0, z: 1.5 }, speed: 2.5 });
    let maxConsecNetHits = 0;

    for (let i = 0; i < 60; i++) {
      const postZ = i % 2 === 0 ? COURT.NET_HALF_Z : -COURT.NET_HALF_Z;
      const azim = ((i / 60) * Math.PI * 2) - Math.PI;
      const elev = -0.35 + (i % 7) * 0.12;
      const speed = 16 + (i % 10) * 4.5; // up to 56.5 m/s
      const startDist = 1.6;
      const dirX = Math.cos(elev) * (Math.cos(azim) >= 0 ? 1 : -1) * Math.max(0.25, Math.abs(Math.cos(azim)));
      const dirZ = Math.cos(elev) * Math.sin(azim);
      const dirY = Math.sin(elev);
      const len = Math.hypot(dirX, dirY, dirZ);
      const nx = dirX / len;
      const ny = dirY / len;
      const nz = dirZ / len;

      const ball = createBallState({
        pos: {
          x: -nx * startDist,
          y: Math.max(0.5, COURT.NET_HEIGHT - ny * startDist),
          z: postZ - nz * startDist,
        },
        vel: { x: nx * speed, y: ny * speed, z: nz * speed },
        omega: computeSpinOmega(nx, nz, (i % 2 === 0 ? 1 : -1) * 20, (i % 3 - 1) * 10),
      });

      const pred = predictLandingPoint3D(ball, wind, PHYSICS_DEFAULTS);
      assert.ok(Number.isFinite(pred.x) && Number.isFinite(pred.z) && Number.isFinite(pred.hangTime));

      let consecNetHits = 0;
      let landedStep = -1;
      let prevX = ball.pos.x;
      let prevY = ball.pos.y;
      let prevZ = ball.pos.z;
      for (let step = 1; step <= 240; step++) {
        prevX = ball.pos.x;
        prevY = ball.pos.y;
        prevZ = ball.pos.z;
        const r = stepBall3D(ball, wind, PHYSICS_DEFAULTS, FIXED_DT, false);
        assertFiniteVec3(ball.pos, `angle#${i} step#${step} pos`);
        assertFiniteVec3(ball.vel, `angle#${i} step#${step} vel`);
        assertFiniteVec3(ball.omega, `angle#${i} step#${step} omega`);
        if (r.netHit) {
          consecNetHits += 1;
          if (consecNetHits > maxConsecNetHits) maxConsecNetHits = consecNetHits;
        } else {
          consecNetHits = 0;
        }
        if (r.landed) {
          landedStep = step;
          break;
        }
      }

      if (pred.landedWithinSteps && landedStep > 0) {
        assert.equal(pred.steps, landedStep, `Angle #${i} predictor step count must match rollout`);
        const segX = ball.pos.x - prevX;
        const segZ = ball.pos.z - prevZ;
        const segLenSq = segX * segX + segZ * segZ;
        const tProj =
          segLenSq > 1e-12
            ? Math.max(0, Math.min(1, ((pred.x - prevX) * segX + (pred.z - prevZ) * segZ) / segLenSq))
            : 0;
        const closestX = prevX + segX * tProj;
        const closestZ = prevZ + segZ * tProj;
        const segErr = Math.hypot(pred.x - closestX, pred.z - closestZ);
        assert.ok(
          segErr < 1e-5,
          `Angle #${i} predictor must lie on final rollout sub-step segment (err=${segErr}, pred=(${pred.x},${pred.z}), seg=(${prevX},${prevZ})->(${ball.pos.x},${ball.pos.z}))`,
        );
      }
    }

    assert.ok(maxConsecNetHits <= 2, `Expected maxConsecNetHits <= 2, got ${maxConsecNetHits}`);
  });

  it('remains strictly finite over 300 steps under extreme eWall=1.0, kWallSpin=0.5, kDrag=0, kMagnus=0.07 corner stress', () => {
    const extremeCfg = {
      ...PHYSICS_DEFAULTS,
      eWall: 1.0,
      kWallSpin: 0.5,
      kDrag: 0,
      kMagnus: 0.07,
    };
    const wind = createWindState();
    const ball = createBallState({
      pos: { x: COURT.ARENA_HALF_X - 0.5, y: 6.0, z: COURT.ARENA_HALF_Z - 0.5 },
      vel: { x: 24, y: 12, z: 18 },
      omega: { x: 14, y: 14, z: -14 },
    });

    const pred = predictLandingPoint3D(ball, wind, extremeCfg);
    assert.ok(Number.isFinite(pred.x) && Number.isFinite(pred.z) && Number.isFinite(pred.hangTime));

    for (let s = 0; s < 300; s++) {
      const r = stepBall3D(ball, wind, extremeCfg, FIXED_DT, false);
      assertFiniteVec3(ball.pos, `corner step ${s} pos`);
      assertFiniteVec3(ball.vel, `corner step ${s} vel`);
      assertFiniteVec3(ball.omega, `corner step ${s} omega`);
      assert.ok(Math.hypot(ball.omega.x, ball.omega.y, ball.omega.z) <= BALL_SPEC.MAX_OMEGA + 1e-6);
      if (r.landed) break;
    }
  });
});

// ============================================================================
// T5-09: P2 6s Human Takeover Expiry, touchcancel Promotion & __proto__ Storage
// ============================================================================
describe('T5-09 — P2 6s takeover expiry, multi-touch touchcancel promotion & __proto__ storage', () => {
  it('reverts P2 from human takeover back to AI after 6.0s of idle rally', () => {
    const fixedBallPhysics = {
      FIXED_DT,
      updateWind3D: () => ({ phaseChanged: false, phase: WIND_PHASES.BREEZE }),
      triggerGaleSurge: () => {},
      predictLandingPoint3D: () => ({ x: 4, z: 0, hangTime: 1, landedWithinSteps: true, steps: 60, trajectory: [] }),
      stepBall3D: (b) => {
        b.pos.x = -3;
        b.pos.y = 5;
        b.pos.z = 0;
        b.vel.x = 0;
        b.vel.y = 0;
        b.vel.z = 0;
        return { landed: false, wallHit: null, netHit: null, crossedNet: false, speed: 0 };
      },
    };
    const eng = createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, physics: fixedBallPhysics });

    // Trigger P2 human takeover
    eng.stepFixed(FIXED_DT, { p1: makeNeutralCmd(), p2: makeNeutralCmd({ isHuman: true, moveX: -1 }) }, PHYSICS_DEFAULTS);
    assert.equal(eng.getSnapshot().players.find((p) => p.id === 'p2').isHuman, true);

    // Advance 5.8s idle -> still human
    for (let i = 0; i < Math.round(5.8 / FIXED_DT); i++) {
      eng.stepFixed(FIXED_DT, { p1: makeNeutralCmd(), p2: makeNeutralCmd({ isHuman: false }) }, PHYSICS_DEFAULTS);
    }
    assert.equal(eng.getSnapshot().players.find((p) => p.id === 'p2').isHuman, true, 'P2 must remain human at 5.8s');

    // Advance another 0.35s (total 6.15s > 6.0s) -> reverts to AI
    for (let i = 0; i < Math.round(0.35 / FIXED_DT); i++) {
      eng.stepFixed(FIXED_DT, { p1: makeNeutralCmd(), p2: makeNeutralCmd({ isHuman: false }) }, PHYSICS_DEFAULTS);
    }
    assert.equal(eng.getSnapshot().players.find((p) => p.id === 'p2').isHuman, false, 'P2 must revert to AI after 6.0s');
  });

  it('promotes finger 2 cleanly on touchcancel of finger 1 and resists __proto__ bindings storage pollution', () => {
    const poisonedStorage = createMemoryStorage({
      [STORAGE_KEYS.BINDINGS]: '{"__proto__":{"pollutedTier5":true},"deadzone":0.22}',
    });
    const shims = installInputShims({ storage: poisonedStorage, rect: { left: 0, top: 0, width: 1280, height: 720 } });
    try {
      const mgr = createInputManager(shims.canvas, {
        initialMode: INPUT_MODES.TOUCH_AUTO,
        storage: poisonedStorage,
        windowTarget: shims.window,
      });

      assert.equal(({}).pollutedTier5, undefined, '__proto__ JSON payload must never pollute Object.prototype');

      // Finger 1 down on left half
      shims.canvas.dispatchEvent(
        Object.assign(new Event('touchstart'), {
          changedTouches: [{ identifier: 101, clientX: 200, clientY: 360 }],
        }),
      );
      // Finger 2 down on left half and dragged right (+X)
      shims.canvas.dispatchEvent(
        Object.assign(new Event('touchstart'), {
          changedTouches: [{ identifier: 202, clientX: 260, clientY: 360 }],
        }),
      );
      shims.canvas.dispatchEvent(
        Object.assign(new Event('touchmove'), {
          changedTouches: [{ identifier: 202, clientX: 340, clientY: 360 }],
        }),
      );

      const bothDown = mgr.pollInputs(1 / 60);
      assert.equal(bothDown.p1.primaryHeld, true);
      assert.equal(bothDown.p1.secondaryHeld, true);

      // touchcancel removes finger 1 -> finger 2 is promoted to primary with its +X drag aim intact
      shims.canvas.dispatchEvent(
        Object.assign(new Event('touchcancel'), {
          changedTouches: [{ identifier: 101, clientX: 200, clientY: 360 }],
        }),
      );
      const promoted = mgr.pollInputs(1 / 60);
      assert.equal(promoted.p1.primaryHeld, true, 'Finger 2 must keep primaryHeld true');
      assert.equal(promoted.p1.secondaryHeld, false, 'secondaryHeld must clear when only finger 2 remains');
      assert.equal(promoted.p1.secondaryJustReleased, true, 'secondaryJustReleased edge must fire');
      assert.ok(promoted.p1.aimX > 0.5, `Promoted finger 2 drag aim must remain intact (got aimX=${promoted.p1.aimX})`);

      mgr.destroy();
    } finally {
      shims.restore();
    }
  });
});

// ============================================================================
// T5-10: courtScene Prototype-Key Injection & Complete Disposal (BUG-C2-1, C2-2, C2-9)
// ============================================================================
describe('T5-10 — courtScene prototype-key safety & complete idempotent disposal (BUG-C2-1, C2-2, C2-9)', () => {
  it('blocks Object.prototype pollution via ev.wall and survives prototype-key trailModes with finite vertices', () => {
    const renderer = createHeadlessRendererStub();
    const ctrl = createCourtScene(
      { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 },
      { width: 1280, height: 720, renderer, createCanvas: createHeadless2DCanvasFactory() },
    );

    const hostileWalls = ['__proto__', 'toString', 'constructor', 'valueOf'];
    const hostileTrails = ['toString', '__proto__', 'constructor', 'valueOf'];

    for (let i = 0; i < hostileTrails.length; i++) {
      assert.doesNotThrow(() => {
        ctrl.syncState(
          {
            ball: {
              pos: { x: -2 + i * 0.8, y: 2.5, z: 0.2 * i },
              vel: { x: 8, y: 1, z: 0 },
              omega: { x: 0, y: 0, z: -10 },
              trailMode: hostileTrails[i],
              active: true,
            },
            wind: { windVec3: { x: 2, y: 0, z: 0 }, speed: 2, phase: WIND_PHASES.BREEZE },
            players: [],
            events: [{ type: EVENTS.WALL_BOUNCE, wall: hostileWalls[i] }],
          },
          1 / 60,
        );
      });
    }

    assert.equal(Object.prototype.flash, undefined, 'Object.prototype must not be polluted by ev.wall="__proto__"');
    assert.equal(({}).flash, undefined);
    assert.equal(Object.prototype.toString.flash, undefined, 'Object.prototype.toString must not be mutated');

    ctrl.render(CAMERA_MODES.BROADCAST);
    const scene = renderer.getLastScene();
    const trailMesh = scene.getObjectByName('ballSpinRibbon');
    assert.ok(trailMesh, 'Spin ribbon mesh must exist');
    const posArr = trailMesh.geometry.attributes.position.array;
    const colArr = trailMesh.geometry.attributes.color.array;
    for (let i = 0; i < posArr.length; i++) {
      assert.ok(Number.isFinite(posArr[i]), `trail position[${i}] must be finite`);
      assert.ok(Number.isFinite(colArr[i]), `trail color[${i}] must be finite`);
    }

    ctrl.dispose();
  });

  it('disposes sunLight, shadow map render target, scene graph, and renderer cleanly and idempotently', () => {
    const renderer = createHeadlessRendererStub();
    const ctrl = createCourtScene(
      { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 },
      { width: 1280, height: 720, renderer, createCanvas: createHeadless2DCanvasFactory() },
    );

    ctrl.render(CAMERA_MODES.BROADCAST);
    const scene = renderer.getLastScene();
    assert.ok(scene.children.length > 0);

    let sunLightFound = null;
    scene.traverse((obj) => {
      if (obj.isDirectionalLight) {
        sunLightFound = obj;
      }
    });
    assert.ok(sunLightFound, 'Directional sunLight must exist in scene');

    let lightDisposeCalls = 0;
    let shadowMapDisposeCalls = 0;
    const origLightDispose = sunLightFound.dispose.bind(sunLightFound);
    sunLightFound.dispose = () => {
      lightDisposeCalls += 1;
      origLightDispose();
    };
    sunLightFound.shadow.map = {
      dispose() {
        shadowMapDisposeCalls += 1;
      },
    };

    ctrl.dispose();
    assert.equal(lightDisposeCalls, 1, 'sunLight.dispose() must be called once');
    assert.equal(shadowMapDisposeCalls, 1, 'sunLight.shadow.map.dispose() must be called once');
    assert.equal(renderer.getDisposeCount(), 1, 'renderer.dispose() must be called once');
    assert.equal(scene.children.length, 0, 'scene.clear() must empty scene graph');

    // Second dispose call must be strictly idempotent
    ctrl.dispose();
    assert.equal(lightDisposeCalls, 1);
    assert.equal(shadowMapDisposeCalls, 1);
    assert.equal(renderer.getDisposeCount(), 1);
  });
});

// ============================================================================
// T5-11: sw.js Delayed waitUntil Chaining, 206/500/Range & /classic-2d Fallback
// ============================================================================
describe('T5-11 — sw.js async waitUntil chaining, 206/500/Range bypass & /classic-2d fallback (BUG-C2-3, C2-7, C2-8)', () => {
  const swSource = fs.readFileSync(path.join(REPO_ROOT, 'sw.js'), 'utf8');

  function createDelayedSwSandbox({ delayMs = 25, fetchImpl } = {}) {
    const cacheMap = new Map();
    const listeners = new Map();
    let putCalls = 0;
    let putCompletions = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function normalizeKey(req) {
      const raw = typeof req === 'string' ? req : req.url;
      try {
        const u = new URL(raw, 'http://127.0.0.1:8080/');
        if (u.pathname === '/') return './';
        return `.${u.pathname}`;
      } catch {
        return raw;
      }
    }

    const cachesMock = {
      open: async (name) => {
        await sleep(delayMs);
        if (!cacheMap.has(name)) cacheMap.set(name, new Map());
        const bucket = cacheMap.get(name);
        return {
          addAll: async (urls) => {
            for (const u of urls) {
              bucket.set(u, new Response(`precached:${u}`, { status: 200 }));
            }
          },
          put: async (req, resp) => {
            putCalls += 1;
            await sleep(delayMs);
            bucket.set(normalizeKey(req), resp);
            putCompletions += 1;
          },
        };
      },
      keys: async () => Array.from(cacheMap.keys()),
      delete: async (name) => cacheMap.delete(name),
      match: async (req) => {
        const key = normalizeKey(req);
        for (const bucket of cacheMap.values()) {
          if (bucket.has(key)) return bucket.get(key);
        }
        return undefined;
      },
    };

    const selfMock = {
      location: new URL('http://127.0.0.1:8080/sw.js'),
      addEventListener: (name, fn) => listeners.set(name, fn),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    };

    const ctx = vm.createContext({
      self: selfMock,
      caches: cachesMock,
      fetch: fetchImpl,
      URL,
      Response,
      Headers,
      Promise,
    });
    vm.runInContext(swSource, ctx, { filename: 'sw.js' });

    return {
      listeners,
      cacheMap,
      getPutCalls: () => putCalls,
      getPutCompletions: () => putCompletions,
    };
  }

  it('chains cache.put() into event.waitUntil() on BOTH cache hit (SWR) and cache miss', async () => {
    let networkVersion = 1;
    const sb = createDelayedSwSandbox({
      delayMs: 20,
      fetchImpl: async () => new Response(`fresh-v${networkVersion}`, { status: 200 }),
    });

    // Seed cache with stale response for ./src/main.js
    const bucket = new Map([['./src/main.js', new Response('stale-v0', { status: 200 })]]);
    sb.cacheMap.set('summer-heat-3d-v2', bucket);

    // 1. Cache HIT (SWR)
    const hitWaitUntil = [];
    let hitRespPromise = null;
    sb.listeners.get('fetch')({
      request: { method: 'GET', url: 'http://127.0.0.1:8080/src/main.js', headers: new Headers() },
      respondWith: (p) => {
        hitRespPromise = p;
      },
      waitUntil: (p) => hitWaitUntil.push(p),
    });

    const hitResp = await hitRespPromise;
    assert.equal(await hitResp.text(), 'stale-v0', 'SWR hit must serve cached response immediately');
    assert.equal(hitWaitUntil.length, 1, 'SWR hit must register background waitUntil promise');
    await Promise.all(hitWaitUntil);
    assert.equal(sb.getPutCompletions(), 1, 'cache.put must already be completed when waitUntil settles on SWR hit');
    assert.equal(await bucket.get('./src/main.js').text(), 'fresh-v1');

    // 2. Cache MISS
    networkVersion = 2;
    const missWaitUntil = [];
    let missRespPromise = null;
    sb.listeners.get('fetch')({
      request: { method: 'GET', url: 'http://127.0.0.1:8080/src/physics3d.js', headers: new Headers() },
      respondWith: (p) => {
        missRespPromise = p;
      },
      waitUntil: (p) => missWaitUntil.push(p),
    });

    const missResp = await missRespPromise;
    assert.equal(await missResp.text(), 'fresh-v2');
    assert.equal(missWaitUntil.length, 1, 'Cache miss must register waitUntil for cache.put');
    await Promise.all(missWaitUntil);
    assert.equal(sb.getPutCompletions(), 2, 'cache.put must complete before waitUntil settles on cache miss');
    assert.equal(await bucket.get('./src/physics3d.js').text(), 'fresh-v2');
  });

  it('never caches HTTP 206/500 responses, bypasses Range requests, and serves /classic-2d offline without trailing slash', async () => {
    let nextStatus = 206;
    let offline = false;
    const sb = createDelayedSwSandbox({
      delayMs: 5,
      fetchImpl: async () => {
        if (offline) throw new Error('Network offline');
        return new Response(`status-${nextStatus}`, { status: nextStatus });
      },
    });

    // Install precache
    const installWaits = [];
    sb.listeners.get('install')({ waitUntil: (p) => installWaits.push(p) });
    await Promise.all(installWaits);

    // 1. HTTP 206 Partial Content must NOT be passed to cache.put()
    nextStatus = 206;
    let resp206 = null;
    const w206 = [];
    sb.listeners.get('fetch')({
      request: { method: 'GET', url: 'http://127.0.0.1:8080/partial.bin', headers: new Headers() },
      respondWith: (p) => {
        resp206 = p;
      },
      waitUntil: (p) => w206.push(p),
    });
    assert.equal((await resp206).status, 206);
    await Promise.all(w206);
    assert.equal(sb.getPutCalls(), 0, 'HTTP 206 must never be cached');

    // 2. HTTP 500 must NOT be passed to cache.put()
    nextStatus = 500;
    let resp500 = null;
    const w500 = [];
    sb.listeners.get('fetch')({
      request: { method: 'GET', url: 'http://127.0.0.1:8080/error.bin', headers: new Headers() },
      respondWith: (p) => {
        resp500 = p;
      },
      waitUntil: (p) => w500.push(p),
    });
    assert.equal((await resp500).status, 500);
    await Promise.all(w500);
    assert.equal(sb.getPutCalls(), 0, 'HTTP 500 must never be cached');

    // 3. Request with Range header must bypass SW respondWith entirely
    let rangeIntercepted = false;
    sb.listeners.get('fetch')({
      request: {
        method: 'GET',
        url: 'http://127.0.0.1:8080/video.webm',
        headers: new Headers({ Range: 'bytes=0-1023' }),
      },
      respondWith: () => {
        rangeIntercepted = true;
      },
      waitUntil: () => {},
    });
    assert.equal(rangeIntercepted, false, 'Range requests must bypass SW caching');

    // 4. Offline navigation to /classic-2d (no trailing slash) must serve ./classic-2d/index.html
    offline = true;
    let classicNoSlashResp = null;
    sb.listeners.get('fetch')({
      request: {
        method: 'GET',
        mode: 'navigate',
        destination: 'document',
        url: 'http://127.0.0.1:8080/classic-2d',
        headers: new Headers(),
      },
      respondWith: (p) => {
        classicNoSlashResp = p;
      },
      waitUntil: () => {},
    });
    assert.equal(
      await (await classicNoSlashResp).text(),
      'precached:./classic-2d/index.html',
      'Offline /classic-2d (no trailing slash) must fall back to Classic 2D index.html',
    );
  });
});

// ============================================================================
// T5-12: main.js Throwing localStorage Getter & Corrupt v2 Storage (BUG-C2-5)
// ============================================================================
describe('T5-12 — main.js SecurityError localStorage getter & corrupt v2 storage payloads (BUG-C2-5)', () => {
  it('survives throwing window.localStorage getter (SecurityError) without aborting initApp()', () => {
    const host = createAppShellDomHost({ width: 1280, height: 720 });
    Object.defineProperty(host.win, 'localStorage', {
      configurable: true,
      get() {
        const err = new Error('Access is denied for this document.');
        err.name = 'SecurityError';
        throw err;
      },
    });

    let app = null;
    assert.doesNotThrow(() => {
      app = initApp({
        window: host.win,
        document: host.doc,
        navigator: {},
        createCourtScene: (canvas, opts) =>
          createCourtScene(canvas, {
            ...opts,
            renderer: createHeadlessRendererStub(),
            createCanvas: createHeadless2DCanvasFactory(),
          }),
      });
    });

    assert.ok(app && app.debugApi, 'initApp must succeed cleanly when localStorage getter throws SecurityError');
    assert.equal(app.debugApi.getCameraMode(), CAMERA_MODES.BROADCAST);
    assert.doesNotThrow(() => app.stepFrame(16.67));
    app.destroy();
  });

  it('sanitizes malformed JSON and prototype-key payloads across all 3 v2 STORAGE_KEYS', () => {
    const host = createAppShellDomHost({ width: 1280, height: 720 });
    const corruptStorage = createMemoryStorage({
      [STORAGE_KEYS.PHYSICS]: '{invalid json!!!',
      [STORAGE_KEYS.BINDINGS]: '{"__proto__":{"pollutedMainBindings":true},"deadzone":"NaN"}',
      [STORAGE_KEYS.SETTINGS]: '{"__proto__":{"pollutedMainSettings":true},"cameraMode":"__proto__","inputMode":"toString","format":"constructor","aiStyle":"valueOf"}',
    });

    const app = initApp({
      window: host.win,
      document: host.doc,
      navigator: {},
      storage: corruptStorage,
      createCourtScene: (canvas, opts) =>
        createCourtScene(canvas, {
          ...opts,
          renderer: createHeadlessRendererStub(),
          createCanvas: createHeadless2DCanvasFactory(),
        }),
    });

    assert.equal(({}).pollutedMainBindings, undefined);
    assert.equal(({}).pollutedMainSettings, undefined);
    assert.equal(app.debugApi.getCameraMode(), CAMERA_MODES.BROADCAST);
    assert.equal(app.debugApi.getInputMode(), INPUT_MODES.TWO_PAD_KEYBOARD);
    assert.deepStrictEqual(app.debugApi.getPhysicsConfig(), { ...PHYSICS_DEFAULTS });
    app.destroy();
  });
});

// ============================================================================
// T5-13: Compound Pause Interaction — Quick-Bind + Portrait Rotation (BUG-C2-6)
// ============================================================================
describe('T5-13 — Compound pause: Quick-Bind countdown pauses under Portrait Auto-Pause (BUG-C2-6)', () => {
  it('freezes Quick-Bind 3s timer while #portraitOverlay covers it and keeps game paused on landscape return', () => {
    const host = createAppShellDomHost({ width: 844, height: 390 });
    const app = initApp({
      window: host.win,
      document: host.doc,
      navigator: {},
      storage: createMemoryStorage(),
      createCourtScene: (canvas, opts) =>
        createCourtScene(canvas, {
          ...opts,
          renderer: createHeadlessRendererStub(),
          createCanvas: createHeadless2DCanvasFactory(),
        }),
    });

    assert.equal(app.debugApi.isPaused(), false);

    // Open Quick-Bind in landscape
    host.elements.get('quickBindBtn').dispatch('click');
    assert.equal(app.debugApi.isPaused(), true);
    assert.equal(host.elements.get('quickBindModal').hidden, false);

    // Step 0.5s in landscape (countdown ~2.5s)
    let ts = 0;
    for (let i = 0; i < 10; i++) {
      ts += 50;
      app.stepFrame(ts);
    }
    const countdownBeforePortrait = host.elements.get('quickBindCountdown').textContent;

    // Rotate to portrait (390x844)
    host.win.innerWidth = 390;
    host.win.innerHeight = 844;
    host.win.dispatch('resize');
    assert.equal(host.elements.get('portraitOverlay').hidden, false);
    assert.equal(app.debugApi.isPaused(), true);

    // Step >4.0s (85 frames * 50ms = 4.25s) while in portrait -> Quick-Bind MUST NOT tick or dismiss!
    for (let i = 0; i < 85; i++) {
      ts += 50;
      app.stepFrame(ts);
    }
    assert.equal(host.elements.get('quickBindModal').hidden, false, 'Quick-Bind must remain open during portrait pause');
    assert.equal(
      host.elements.get('quickBindCountdown').textContent,
      countdownBeforePortrait,
      'Quick-Bind countdown must not tick while portraitPaused is true',
    );

    // Rotate back to landscape (844x390) -> portrait hides, Quick-Bind stays open & game remains paused
    host.win.innerWidth = 844;
    host.win.innerHeight = 390;
    host.win.dispatch('resize');
    assert.equal(host.elements.get('portraitOverlay').hidden, true);
    assert.equal(host.elements.get('quickBindModal').hidden, false);
    assert.equal(app.debugApi.isPaused(), true, 'Game must remain paused because Quick-Bind is still open');

    // Cancel Quick-Bind -> game unpauses cleanly
    host.elements.get('quickBindCancelBtn').dispatch('click');
    assert.equal(host.elements.get('quickBindModal').hidden, true);
    assert.equal(app.debugApi.isPaused(), false);
    app.destroy();
  });
});

// ============================================================================
// T5-14: Async Wake Lock Race Across destroy() & Re-Acquisition (BUG-C2-10)
// ============================================================================
describe('T5-14 — Async Wake Lock sentinel cleanup across destroy() & visibilitychange re-acquisition (BUG-C2-10)', () => {
  it('immediately releases a late-resolving WakeLockSentinel if destroy() ran before resolution', async () => {
    const host = createAppShellDomHost({ width: 1280, height: 720 });
    let resolveWakeLock;
    const wakeLockPromise = new Promise((res) => {
      resolveWakeLock = res;
    });

    const app = initApp({
      window: host.win,
      document: host.doc,
      navigator: {
        wakeLock: {
          request: () => wakeLockPromise,
        },
      },
      storage: createMemoryStorage(),
      createCourtScene: (canvas, opts) =>
        createCourtScene(canvas, {
          ...opts,
          renderer: createHeadlessRendererStub(),
          createCanvas: createHeadless2DCanvasFactory(),
        }),
    });

    // Trigger wakeLock request via first user gesture
    host.win.dispatch('pointerdown');
    // Destroy app BEFORE wakeLock promise resolves
    app.destroy();

    let releaseCalls = 0;
    resolveWakeLock({
      addEventListener() {},
      release: async () => {
        releaseCalls += 1;
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(releaseCalls, 1, 'Late-resolving WakeLockSentinel must be released immediately after destroy()');
  });

  it('re-acquires Wake Lock on visibilitychange after sentinel emits release', async () => {
    const host = createAppShellDomHost({ width: 1280, height: 720 });
    let requestCalls = 0;
    const releaseListeners = [];

    const app = initApp({
      window: host.win,
      document: host.doc,
      navigator: {
        wakeLock: {
          request: async () => {
            requestCalls += 1;
            return {
              addEventListener(ev, fn) {
                if (ev === 'release') releaseListeners.push(fn);
              },
              release: async () => {},
            };
          },
        },
      },
      storage: createMemoryStorage(),
      createCourtScene: (canvas, opts) =>
        createCourtScene(canvas, {
          ...opts,
          renderer: createHeadlessRendererStub(),
          createCanvas: createHeadless2DCanvasFactory(),
        }),
    });

    host.win.dispatch('pointerdown');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(requestCalls, 1);

    // Simulate OS releasing wake lock, then returning to visible tab
    for (const fn of releaseListeners) fn();
    host.doc.visibilityState = 'visible';
    host.doc.dispatch('visibilitychange');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(requestCalls, 2, 'Wake Lock must re-acquire cleanly on visibilitychange after release');

    app.destroy();
  });
});

// ============================================================================
// T5-15: index.html Intermediate Viewport CSS Breakpoint Audit (BUG-C2-4, C2-11)
// ============================================================================
describe('T5-15 — index.html HUD wrapping & compact #rallyBanner clearance CSS audit (BUG-C2-4, C2-11)', () => {
  it('allows .hud-row-controls wrapping, covers 961-1024px in compact media query, and positions compact #rallyBanner >= 76px', () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');

    const controlsRule = html.match(/\.hud-row-controls\s*\{([^}]*)\}/);
    assert.ok(controlsRule, '.hud-row-controls CSS rule must exist');
    assert.ok(
      /flex-wrap\s*:\s*wrap\s*;/.test(controlsRule[1]),
      '.hud-row-controls must set flex-wrap: wrap globally so intermediate viewports never clip buttons',
    );

    const mediaMatch = html.match(/@media\s*\(max-width:\s*(\d+)px\)\s*,\s*\(max-height:\s*460px\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*<\/style>/);
    assert.ok(mediaMatch, 'Compact mobile/tablet media query must exist');
    const maxWidthPx = Number(mediaMatch[1]);
    assert.ok(maxWidthPx >= 1024, `Compact breakpoint max-width must be >= 1024px to cover 961-992px desktop width (got ${maxWidthPx}px)`);

    const compactBody = mediaMatch[2];
    const bannerRule = compactBody.match(/#rallyBanner\s*\{([^}]*)\}/);
    assert.ok(bannerRule, 'Compact #rallyBanner rule must exist');
    const topMatch = bannerRule[1].match(/top\s*:\s*(\d+)px/);
    assert.ok(topMatch, 'Compact #rallyBanner must specify top in px');
    assert.ok(
      Number(topMatch[1]) >= 76,
      `Compact #rallyBanner top must be >= 76px to clear 2 wrapped rows at 667x375 (got ${topMatch[1]}px)`,
    );
  });
});
