import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXED_DT,
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
  createDefaultBindings,
} from '../../src/contracts.js';
import { createInputManager } from '../../src/inputManager.js';
import { createRallyEngine } from '../../src/rallyEngine.js';

// ---- Test Helpers ----

function createMockEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, event) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of Array.from(set)) {
        fn(event);
      }
    },
    listenerCount(type) {
      if (type) return listeners.get(type)?.size ?? 0;
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

function createMockCanvas(width = 844, height = 390, left = 0, top = 0) {
  const target = createMockEventTarget();
  return {
    ...target,
    width,
    height,
    getBoundingClientRect() {
      return { left, top, width, height, right: left + width, bottom: top + height };
    },
  };
}

function createMockStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(k) {
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      data.set(k, String(v));
    },
    removeItem(k) {
      data.delete(k);
    },
  };
}

function makePad(axes = [0, 0, 0, 0], pressedIndices = [], analogValues = {}) {
  const buttons = Array.from({ length: 18 }, (_, i) => ({
    pressed: pressedIndices.includes(i),
    value: i in analogValues ? analogValues[i] : pressedIndices.includes(i) ? 1 : 0,
  }));
  return { axes, buttons, connected: true };
}

function makeKeyEvent(code, overrides = {}) {
  let prevented = false;
  return {
    code,
    repeat: false,
    target: null,
    preventDefault() {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
    ...overrides,
  };
}

function neutralCmd(overrides = {}) {
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

function createDeterministicDiPhysics() {
  return {
    FIXED_DT,
    updateWind3D(windState, dt) {
      windState.time += dt;
      return { phaseChanged: false, phase: windState.phase, windVec3: windState.windVec3 };
    },
    triggerGaleSurge(windState, dirSignX = 1) {
      windState.phase = WIND_PHASES.WARNING;
      windState.timer = 1.0;
      windState.gustTargetVec3 = { x: (dirSignX || 1) * 5.5, y: 0, z: 1.5 };
      return windState;
    },
    stepBall3D(ballState, windState, cfg, dt) {
      const prevX = ballState.pos.x;
      ballState.vel.y -= cfg.gravity * dt;
      ballState.pos.x += ballState.vel.x * dt;
      ballState.pos.y += ballState.vel.y * dt;
      ballState.pos.z += ballState.vel.z * dt;
      const crossedNet = (prevX < 0 && ballState.pos.x >= 0) || (prevX > 0 && ballState.pos.x <= 0);
      let landed = false;
      if (ballState.pos.y <= ballState.radius) {
        ballState.pos.y = ballState.radius;
        landed = true;
      }
      return {
        landed,
        wallHit: null,
        netHit: null,
        crossedNet,
        speed: Math.hypot(ballState.vel.x, ballState.vel.y, ballState.vel.z),
      };
    },
    predictLandingPoint3D(ballState, windState, cfg) {
      const g = cfg.gravity;
      const y0 = Math.max(0, ballState.pos.y - ballState.radius);
      const vy = ballState.vel.y;
      const disc = vy * vy + 2 * g * y0;
      const t = Math.max(0, (vy + Math.sqrt(Math.max(0, disc))) / Math.max(0.1, g));
      return {
        x: Math.max(-COURT.ARENA_HALF_X, Math.min(COURT.ARENA_HALF_X, ballState.pos.x + ballState.vel.x * t)),
        z: Math.max(-COURT.ARENA_HALF_Z, Math.min(COURT.ARENA_HALF_Z, ballState.pos.z + ballState.vel.z * t)),
        hangTime: t,
        landedWithinSteps: t <= 1.5,
        steps: Math.min(180, Math.round(t / FIXED_DT)),
        trajectory: [],
      };
    },
  };
}

function assertAllFiniteSnapshot(snap) {
  const nums = [
    snap.ball.pos.x,
    snap.ball.pos.y,
    snap.ball.pos.z,
    snap.ball.vel.x,
    snap.ball.vel.y,
    snap.ball.vel.z,
    snap.ball.omega.x,
    snap.ball.omega.y,
    snap.ball.omega.z,
    snap.wind.windVec3.x,
    snap.wind.windVec3.y,
    snap.wind.windVec3.z,
    snap.wind.speed,
    snap.prediction.x,
    snap.prediction.z,
    snap.prediction.hangTime,
    snap.cameraPunch,
    snap.hitStopFrames,
  ];
  for (const p of snap.players) {
    nums.push(
      p.pos.x,
      p.pos.y,
      p.pos.z,
      p.vel.x,
      p.vel.y,
      p.vel.z,
      p.facingYaw,
      p.chargeRatio,
      p.heatMeter,
    );
  }
  for (const n of nums) {
    assert.equal(typeof n, 'number');
    assert.ok(Number.isFinite(n), `Expected finite number, got ${n}`);
  }
}

// ============================================================================
// 1. INPUT MANAGER TESTS
// ============================================================================

test('InputManager: headless instantiation and idempotent destroy() remove all listeners', () => {
  const headless = createInputManager(null, { storage: null, windowTarget: null });
  assert.equal(headless.getMode(), INPUT_MODES.ONE_PAD_SPLIT);
  const frame = headless.pollInputs(1 / 60);
  assert.equal(frame.mode, INPUT_MODES.ONE_PAD_SPLIT);
  assert.equal(frame.padsConnected, 0);
  assert.equal(frame.p1.isHuman, false);
  assert.equal(frame.p2.isHuman, false);
  headless.destroy();
  headless.destroy(); // idempotent

  const win = createMockEventTarget();
  const canvas = createMockCanvas();
  const mgr = createInputManager(canvas, { windowTarget: win, storage: createMockStorage() });
  assert.ok(win.listenerCount() > 0);
  assert.ok(canvas.listenerCount() > 0);
  mgr.destroy();
  assert.equal(win.listenerCount(), 0);
  assert.equal(canvas.listenerCount(), 0);
  mgr.destroy();
});

test('InputManager: Stadia 1PAD split mappings, deadzone 0.16, D-pad, analog triggers, and edges', () => {
  let pads = [makePad([0.15, -0.15, -0.15, 0.15], [])];
  const mgr = createInputManager(null, {
    initialMode: INPUT_MODES.ONE_PAD_SPLIT,
    getGamepads: () => pads,
    storage: createMockStorage(),
    windowTarget: null,
  });

  // Inside deadzone (< 0.16) -> 0
  let f = mgr.pollInputs(1 / 60);
  assert.equal(f.padsConnected, 1);
  assert.equal(f.p1.moveX, 0);
  assert.equal(f.p1.moveZ, 0);
  assert.equal(f.p2.moveX, 0);
  assert.equal(f.p2.moveZ, 0);
  assert.equal(f.p1.isHuman, false);
  assert.equal(f.p2.isHuman, false);

  // Active sticks + P1 analog L2 trigger (button 6 value=0.45 > 0.35) + P2 R1 (button 5) + B (button 1)
  pads = [makePad([0.6, -0.4, -0.8, 0.5], [5, 1], { 6: 0.45 })];
  f = mgr.pollInputs(1 / 60);
  assert.ok(Math.abs(f.p1.moveX - 0.6) < 1e-6);
  assert.ok(Math.abs(f.p1.moveZ - -0.4) < 1e-6);
  assert.equal(f.p1.primaryHeld, true);
  assert.equal(f.p1.primaryJustPressed, true);
  assert.equal(f.p1.secondaryHeld, false);
  assert.equal(f.p1.isHuman, true);

  assert.ok(Math.abs(f.p2.moveX - -0.8) < 1e-6);
  assert.ok(Math.abs(f.p2.moveZ - 0.5) < 1e-6);
  assert.equal(f.p2.primaryHeld, true);
  assert.equal(f.p2.primaryJustPressed, true);
  assert.equal(f.p2.secondaryHeld, true);
  assert.equal(f.p2.secondaryJustPressed, true);

  // Next frame still held -> JustPressed becomes false; test D-pad (14=Left, 12=Up->-Z) & P1 secondary [10]
  pads = [makePad([0, 0, Number.NaN, Infinity], [14, 12, 10, 0], { 6: 0.5 })];
  f = mgr.pollInputs(1 / 60);
  assert.equal(f.p1.primaryJustPressed, false);
  assert.equal(f.p1.secondaryJustPressed, true);
  // Diagonal D-pad normalized (len <= 1)
  assert.ok(Math.abs(Math.hypot(f.p1.moveX, f.p1.moveZ) - 1) < 1e-6);
  assert.ok(f.p1.moveX < 0 && f.p1.moveZ < 0); // Left (-X), Up (-Z)
  // NaN/Infinity axes on P2 safely guarded; button 0 (A) = P2 primary still held
  assert.equal(f.p2.moveX, 0);
  assert.equal(f.p2.moveZ, 0);
  assert.equal(f.p2.primaryHeld, true);
  assert.equal(f.p2.secondaryJustReleased, true);

  // Release all -> JustReleased edges fire
  pads = [makePad([0, 0, 0, 0], [])];
  f = mgr.pollInputs(1 / 60);
  assert.equal(f.p1.primaryJustReleased, true);
  assert.equal(f.p1.secondaryJustReleased, true);
  assert.equal(f.p2.primaryJustReleased, true);
  mgr.destroy();
});

test('InputManager: 2PAD dual gamepads & keyboard active across ALL 3 modes with form-input guard', () => {
  const win = createMockEventTarget();
  let pads = [makePad([0.5, 0, 0, 0], [0]), makePad([-0.7, 0.3, 0, 0], [7, 2])];
  const mgr = createInputManager(null, {
    initialMode: INPUT_MODES.TWO_PAD_KEYBOARD,
    getGamepads: () => pads,
    windowTarget: win,
    storage: createMockStorage(),
  });

  let f = mgr.pollInputs(1 / 60);
  assert.equal(f.padsConnected, 2);
  assert.equal(f.p1.moveX, 0.5);
  assert.equal(f.p1.primaryHeld, true);
  assert.equal(f.p2.moveX, -0.7);
  assert.equal(f.p2.moveZ, 0.3);
  assert.equal(f.p2.primaryHeld, true);
  assert.equal(f.p2.secondaryHeld, true);

  // Disconnect pads, test keyboard across ALL 3 modes
  pads = [];
  for (const m of [INPUT_MODES.ONE_PAD_SPLIT, INPUT_MODES.TWO_PAD_KEYBOARD, INPUT_MODES.TOUCH_AUTO]) {
    mgr.setMode(m);
    const eW = makeKeyEvent('KeyW');
    const eD = makeKeyEvent('KeyD');
    const eSpace = makeKeyEvent('Space');
    const eKeyE = makeKeyEvent('KeyE');
    const eArrLeft = makeKeyEvent('ArrowLeft');
    const eEnter = makeKeyEvent('NumpadEnter');
    const eSlash = makeKeyEvent('Slash');
    win.dispatch('keydown', eW);
    win.dispatch('keydown', eD);
    win.dispatch('keydown', eSpace);
    win.dispatch('keydown', eKeyE);
    win.dispatch('keydown', eArrLeft);
    win.dispatch('keydown', eEnter);
    win.dispatch('keydown', eSlash);

    assert.equal(eSpace.defaultPrevented, true);
    assert.equal(eArrLeft.defaultPrevented, true);
    assert.equal(eEnter.defaultPrevented, true);

    f = mgr.pollInputs(1 / 60);
    assert.equal(f.mode, m);
    assert.equal(f.p1.autoFootwork, m === INPUT_MODES.TOUCH_AUTO);
    assert.ok(f.p1.moveX > 0 && f.p1.moveZ < 0); // D = +X, W = -Z
    assert.ok(Math.hypot(f.p1.moveX, f.p1.moveZ) <= 1 + 1e-6);
    assert.equal(f.p1.primaryHeld, true);
    assert.equal(f.p1.secondaryHeld, true);
    assert.equal(f.p2.moveX, -1);
    assert.equal(f.p2.primaryHeld, true);
    assert.equal(f.p2.secondaryHeld, true);

    win.dispatch('blur', {});
  }

  // Form element focus must ignore keyboard input
  const formEv = makeKeyEvent('Space', { target: { tagName: 'INPUT' } });
  win.dispatch('keydown', formEv);
  f = mgr.pollInputs(1 / 60);
  assert.equal(f.p1.primaryHeld, false);
  assert.equal(formEv.defaultPrevented, false);

  mgr.destroy();
});

test('InputManager: TOUCH auto-footwork multi-touch split-court, 2nd finger secondary, and mouse fallback', () => {
  const win = createMockEventTarget();
  const canvas = createMockCanvas(844, 390, 0, 0);
  const mgr = createInputManager(canvas, {
    initialMode: INPUT_MODES.TOUCH_AUTO,
    windowTarget: win,
    storage: createMockStorage(),
  });

  // Left half (x=200 < 422) -> P1; Right half (x=650 >= 422) -> P2
  canvas.dispatch('touchstart', {
    preventDefault() {},
    changedTouches: [
      { identifier: 101, clientX: 200, clientY: 200 },
      { identifier: 202, clientX: 650, clientY: 200 },
    ],
  });

  // Drag P1 right+up (+X, -Z) and P2 left+down (-X, +Z)
  canvas.dispatch('touchmove', {
    preventDefault() {},
    changedTouches: [
      { identifier: 101, clientX: 260, clientY: 160 },
      { identifier: 202, clientX: 590, clientY: 250 },
    ],
  });

  let f = mgr.pollInputs(1 / 60);
  assert.equal(f.p1.autoFootwork, true);
  assert.equal(f.p2.autoFootwork, true);
  assert.equal(f.p1.primaryHeld, true);
  assert.equal(f.p1.primaryJustPressed, true);
  assert.equal(f.p1.secondaryHeld, false);
  assert.ok(f.p1.aimX > 0 && f.p1.aimZ < 0);
  assert.ok(Math.hypot(f.p1.aimX, f.p1.aimZ) <= 1 + 1e-6);
  assert.equal(f.p2.primaryHeld, true);
  assert.ok(f.p2.aimX < 0 && f.p2.aimZ > 0);

  // Add 2nd simultaneous touch on P1's half -> secondaryHeld = true
  canvas.dispatch('touchstart', {
    preventDefault() {},
    changedTouches: [{ identifier: 103, clientX: 180, clientY: 220 }],
  });
  f = mgr.pollInputs(1 / 60);
  assert.equal(f.p1.secondaryHeld, true);
  assert.equal(f.p1.secondaryJustPressed, true);

  // End touches -> release edges
  canvas.dispatch('touchend', {
    preventDefault() {},
    changedTouches: [
      { identifier: 101 },
      { identifier: 103 },
      { identifier: 202 },
    ],
  });
  f = mgr.pollInputs(1 / 60);
  assert.equal(f.p1.primaryJustReleased, true);
  assert.equal(f.p1.secondaryJustReleased, true);
  assert.equal(f.p2.primaryJustReleased, true);

  // Mouse drag fallback on right half -> P2
  canvas.dispatch('mousedown', { button: 0, clientX: 600, clientY: 200 });
  win.dispatch('mousemove', { clientX: 550, clientY: 160 });
  f = mgr.pollInputs(1 / 60);
  assert.equal(f.p2.primaryHeld, true);
  assert.ok(f.p2.aimX < 0 && f.p2.aimZ < 0);
  win.dispatch('mouseup', {});
  f = mgr.pollInputs(1 / 60);
  assert.equal(f.p2.primaryJustReleased, true);

  mgr.destroy();
});

test('InputManager: bindings persistence, corrupt JSON fallback, throwing storage, and immutability', () => {
  // Corrupt JSON falls back cleanly
  const corruptStorage = createMockStorage({ [STORAGE_KEYS.BINDINGS]: '{broken json!!!' });
  const mgr1 = createInputManager(null, { storage: corruptStorage, windowTarget: null });
  assert.deepEqual(mgr1.getBindings(), createDefaultBindings());

  // Deep-clone immutability
  const copy = mgr1.getBindings();
  copy.deadzone = 0.99;
  copy.onePadSplit.p1.primaryButtons.push(99);
  assert.equal(mgr1.getBindings().deadzone, 0.16);
  assert.deepEqual(mgr1.getBindings().onePadSplit.p1.primaryButtons, [4, 6]);

  // Sanitization & persistence under STORAGE_KEYS.BINDINGS only
  const updated = mgr1.setBindings({
    deadzone: 0.25,
    quickBindSlots: {
      p1Primary: { type: 'key', code: 'KeyF' },
      p2Primary: { type: 'gamepad', padIndex: 0, buttonIndex: 9 },
    },
  });
  assert.equal(updated.deadzone, 0.25);
  assert.deepEqual(updated.quickBindSlots.p1Primary, { type: 'key', code: 'KeyF' });
  assert.deepEqual(updated.quickBindSlots.p2Primary, { type: 'gamepad', padIndex: 0, buttonIndex: 9 });
  assert.ok(corruptStorage.data.has(STORAGE_KEYS.BINDINGS));
  assert.equal(corruptStorage.data.has('neon_volley_heavy_gale_physics_v1'), false);

  // Reloading from storage restores persisted bindings
  const mgr2 = createInputManager(null, { storage: corruptStorage, windowTarget: null });
  assert.equal(mgr2.getBindings().deadzone, 0.25);
  assert.deepEqual(mgr2.getBindings().quickBindSlots.p1Primary, { type: 'key', code: 'KeyF' });

  // Reset restores defaults
  mgr2.resetBindings();
  assert.deepEqual(mgr2.getBindings(), createDefaultBindings());

  // Throwing storage never throws
  const brokenStorage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  const mgr3 = createInputManager(null, { storage: brokenStorage, windowTarget: null });
  assert.equal(mgr3.getBindings().deadzone, 0.16);
  mgr3.setBindings({ deadzone: 0.3 });
  assert.equal(mgr3.getBindings().deadzone, 0.3);

  mgr1.destroy();
  mgr2.destroy();
  mgr3.destroy();
});

test('InputManager: 3-second Quick-Bind FSM (stale held protection, timeout, capture & cancel)', () => {
  const win = createMockEventTarget();
  const storage = createMockStorage();
  // Start with gamepad button 4 already held BEFORE Quick-Bind opens!
  let pads = [makePad([0, 0, 0, 0], [4])];
  const mgr = createInputManager(null, {
    windowTarget: win,
    storage,
    getGamepads: () => pads,
  });

  const updates = [];
  let donePayload = null;

  mgr.startQuickBind(
    (status) => updates.push(status),
    (res) => {
      donePayload = res;
    },
  );

  // Initial status: slot 0 (p1Primary), 3.0s
  assert.equal(updates[0].active, true);
  assert.equal(updates[0].slotKey, 'p1Primary');
  assert.equal(updates[0].remainingSec, 3.0);

  // Polling while button 4 is STILL held must NOT capture slot 0, and returns neutral commands
  let f = mgr.pollInputs(0.5);
  assert.equal(f.p1.primaryHeld, false);
  assert.equal(updates.at(-1).slotIndex, 0);
  assert.equal(updates.at(-1).remainingSec, 2.5);

  // Release button 4, then press button 4 freshly -> captures slot 0 (p1Primary)
  pads = [makePad([0, 0, 0, 0], [])];
  mgr.pollInputs(0.1);
  pads = [makePad([0, 0, 0, 0], [4])];
  mgr.pollInputs(0.1);
  assert.equal(updates.at(-1).slotIndex, 1);
  assert.equal(updates.at(-1).slotKey, 'p1Secondary');
  assert.deepEqual(updates.at(-1).lastResult.captured, { type: 'gamepad', padIndex: 0, buttonIndex: 4 });

  // Continuing to hold button 4 into slot 1 must NOT auto-capture slot 1!
  mgr.pollInputs(0.2);
  assert.equal(updates.at(-1).slotIndex, 1);

  // Capture slot 1 (p1Secondary) with keyboard KeyG
  win.dispatch('keydown', makeKeyEvent('KeyG'));
  assert.equal(updates.at(-1).slotIndex, 2);
  assert.equal(updates.at(-1).slotKey, 'p2Primary');

  // Holding KeyG (repeat or non-released) must NOT auto-capture slot 2
  win.dispatch('keydown', makeKeyEvent('KeyG', { repeat: true }));
  assert.equal(updates.at(-1).slotIndex, 2);
  win.dispatch('keyup', makeKeyEvent('KeyG'));

  // Let slot 2 (p2Primary) time out after 3.0s (6 * 0.5s) -> preserves null and advances to slot 3
  pads = [makePad([0, 0, 0, 0], [])];
  for (let i = 0; i < 6; i++) {
    mgr.pollInputs(0.5);
  }
  assert.equal(updates.at(-1).slotIndex, 3);
  assert.equal(updates.at(-1).slotKey, 'p2Secondary');
  assert.equal(updates.at(-1).lastResult.timedOut, true);
  assert.equal(updates.at(-1).lastResult.captured, null);

  // Capture slot 3 (p2Secondary) with KeyK -> completes & persists to storage!
  win.dispatch('keydown', makeKeyEvent('KeyK'));
  assert.ok(donePayload);
  assert.equal(donePayload.completed, true);
  assert.equal(donePayload.cancelled, false);
  assert.deepEqual(donePayload.bindings.quickBindSlots.p1Primary, {
    type: 'gamepad',
    padIndex: 0,
    buttonIndex: 4,
  });
  assert.deepEqual(donePayload.bindings.quickBindSlots.p1Secondary, { type: 'key', code: 'KeyG' });
  assert.equal(donePayload.bindings.quickBindSlots.p2Primary, null);
  assert.deepEqual(donePayload.bindings.quickBindSlots.p2Secondary, { type: 'key', code: 'KeyK' });
  assert.ok(storage.getItem(STORAGE_KEYS.BINDINGS).includes('KeyK'));

  // Verify quick-bound KeyG activates P1 secondary during normal polling
  win.dispatch('keyup', makeKeyEvent('KeyK'));
  win.dispatch('keydown', makeKeyEvent('KeyG'));
  f = mgr.pollInputs(1 / 60);
  assert.equal(f.p1.secondaryHeld, true);
  win.dispatch('keyup', makeKeyEvent('KeyG'));

  // Test Escape cancellation discards partial draft without mutating saved bindings
  let cancelPayload = null;
  mgr.startQuickBind(null, (res) => {
    cancelPayload = res;
  });
  win.dispatch('keydown', makeKeyEvent('KeyZ')); // overwrites slot 0 in draft only
  win.dispatch('keydown', makeKeyEvent('Escape'));
  assert.ok(cancelPayload);
  assert.equal(cancelPayload.completed, false);
  assert.equal(cancelPayload.cancelled, true);
  assert.deepEqual(mgr.getBindings().quickBindSlots.p1Primary, {
    type: 'gamepad',
    padIndex: 0,
    buttonIndex: 4,
  });

  mgr.destroy();
});

// ============================================================================
// 2. RALLY ENGINE TESTS (DI + REAL physics3d.js INTEGRATION)
// ============================================================================

test('RallyEngine: DI physics fixed-timestep 120Hz clamping, pause, gameSpeed, and triggerGust()', () => {
  let stepCalls = 0;
  const diPhysics = createDeterministicDiPhysics();
  const origStep = diPhysics.stepBall3D;
  diPhysics.stepBall3D = (...args) => {
    stepCalls += 1;
    return origStep(...args);
  };

  const engine = createRallyEngine({ physics: diPhysics, servingTeam: 2 });

  // Pause freezes simulation completely
  engine.setPaused(true);
  const beforePause = engine.getSnapshot();
  const afterPause = engine.update(0.05, null, PHYSICS_DEFAULTS);
  assert.equal(stepCalls, 0);
  assert.equal(afterPause.scoreboard.paused, true);
  assert.deepEqual(afterPause.ball.pos, beforePause.ball.pos);

  // Unpause & clamp huge rawDt (5.0s -> 0.05s = 6 steps at 120Hz)
  engine.setPaused(false);
  engine.update(5.0, null, PHYSICS_DEFAULTS);
  assert.equal(stepCalls, 6);

  // gameSpeed 1.5x on 0.04s -> 0.06s -> 7 steps
  const prevCalls = stepCalls;
  engine.update(0.04, null, { ...PHYSICS_DEFAULTS, gameSpeed: 1.5 });
  assert.ok(stepCalls - prevCalls >= 7 && stepCalls - prevCalls <= 8);

  // triggerGust enters WARNING phase and emits GUST_WARNING
  engine.triggerGust(1);
  const gustSnap = engine.getSnapshot();
  assert.equal(gustSnap.wind.phase, WIND_PHASES.WARNING);
  assert.ok(gustSnap.events.some((e) => e.type === EVENTS.GUST_WARNING));
});

test('RallyEngine (real physics3d.js): Full 3-touch Bump -> Set -> Heat Spike chain with 2-frame hit-stop', () => {
  const engine = createRallyEngine({
    format: MATCH_FORMATS.ONE_V_ONE,
    aiStyle: AI_STYLES.WIND_LOBBER,
    servingTeam: 2,
    rng: () => 0.5,
  });

  let sawBump = false;
  let sawSet = false;
  let sawTimingRing = false;
  let sawSweetSpot = false;
  let sawHeatSpike = false;
  let heatAfterBump = 0;
  let heatAfterSet = 0;
  let heatAfterSpike = -1;
  let spikeOmega = null;
  let spikeVelX = 0;
  let hitStopObserved = [];

  for (let frame = 0; frame < 360; frame++) {
    const cur = engine.getSnapshot();
    const p1 = cur.players.find((p) => p.id === 'p1');

    // Move P1 cleanly toward predicted landing point (or timingRing on Set)
    const tx = cur.timingRing.active && cur.timingRing.team === 1 ? cur.timingRing.pos.x : cur.prediction.x;
    const tz = cur.timingRing.active && cur.timingRing.team === 1 ? cur.timingRing.pos.z : cur.prediction.z;
    const dx = tx - p1.pos.x;
    const dz = tz - p1.pos.z;
    const dist = Math.hypot(dx, dz);
    const moveX = dist > 0.15 ? dx / dist : 0;
    const moveZ = dist > 0.15 ? dz / dist : 0;

    const p1HasBall = cur.ball.pos.x <= 0.35;
    const horizDist = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);

    let pressPrimary = false;
    let holdPrimary = false;

    if (p1HasBall && cur.scoreboard.touchCount === 0 && horizDist <= 1.45 && cur.ball.pos.y <= 2.3) {
      pressPrimary = true;
      holdPrimary = true;
    } else if (p1HasBall && cur.scoreboard.touchCount === 1 && horizDist <= 1.45 && cur.ball.pos.y <= 2.8 && cur.ball.vel.y <= 0.8) {
      pressPrimary = true;
      holdPrimary = true;
    } else if (cur.scoreboard.touchCount === 2 && cur.timingRing.active && cur.timingRing.team === 1) {
      sawTimingRing = true;
      if (cur.timingRing.inSweetSpot) {
        sawSweetSpot = true;
        pressPrimary = true;
        holdPrimary = true;
      }
    }

    const snap = engine.update(
      1 / 60,
      {
        p1: neutralCmd({
          isHuman: true,
          moveX,
          moveZ,
          aimX: 1,
          aimZ: 0,
          primaryHeld: holdPrimary,
          primaryJustPressed: pressPrimary,
        }),
        p2: neutralCmd(),
      },
      PHYSICS_DEFAULTS,
    );

    assertAllFiniteSnapshot(snap);

    for (const ev of snap.events) {
      if (ev.type === EVENTS.BUMP && ev.team === 1) {
        sawBump = true;
        heatAfterBump = snap.scoreboard.team1Heat;
      }
      if (ev.type === EVENTS.SET && ev.team === 1) {
        sawSet = true;
        heatAfterSet = snap.scoreboard.team1Heat;
        assert.equal(snap.timingRing.active, true);
      }
      if (ev.type === EVENTS.HEAT_SPIKE && ev.team === 1) {
        sawHeatSpike = true;
        heatAfterSpike = snap.scoreboard.team1Heat;
        spikeOmega = { ...snap.ball.omega };
        spikeVelX = snap.ball.vel.x;
        assert.equal(snap.ball.shotType, SHOT_TYPES.HEAT_SPIKE);
        assert.equal(snap.ball.trailMode, TRAIL_MODES.FLAME);
        assert.equal(snap.hitStopFrames, 2);
        assert.equal(snap.cameraPunch, 1.0);

        // Verify 2-frame hit-stop genuinely freezes ball across next 2 update() frames (2 -> 1 -> 0)
        const frozenPos = { ...snap.ball.pos };
        const hs1 = engine.update(1 / 60, null, PHYSICS_DEFAULTS);
        hitStopObserved.push(hs1.hitStopFrames);
        assert.deepEqual(hs1.ball.pos, frozenPos);

        const hs2 = engine.update(1 / 60, null, PHYSICS_DEFAULTS);
        hitStopObserved.push(hs2.hitStopFrames);
        assert.deepEqual(hs2.ball.pos, frozenPos);

        // Next update resumes motion
        const resumed = engine.update(1 / 60, null, PHYSICS_DEFAULTS);
        assert.notDeepEqual(resumed.ball.pos, frozenPos);
        break;
      }
    }

    if (sawHeatSpike) {
      break;
    }
  }

  assert.equal(sawBump, true, 'Expected Touch 1 Bump');
  assert.ok(heatAfterBump >= 0.40 && heatAfterBump < 1.0, `Expected heat after Bump ~0.45, got ${heatAfterBump}`);
  assert.equal(sawSet, true, 'Expected Touch 2 Set');
  assert.equal(heatAfterSet, 1.0, 'Expected Heat Meter to reach 1.0 after Bump -> Set');
  assert.equal(sawTimingRing, true, 'Expected shrinking 3D Timing Ring active after Set');
  assert.equal(sawSweetSpot, true, 'Expected Timing Ring to enter sweet spot');
  assert.equal(sawHeatSpike, true, 'Expected Touch 3 Heat Spike');
  assert.equal(heatAfterSpike, 0, 'Expected Heat Spike to consume Heat Meter to 0');
  assert.deepEqual(hitStopObserved, [1, 0], 'Expected 2-frame hit-stop decrement 2 -> 1 -> 0');
  // Topspin for +X shot has negative omega.z (omega × vRel points downward -Y)
  assert.ok(spikeVelX > 10, `Expected fast forward Heat Spike, got vx=${spikeVelX}`);
  assert.ok(spikeOmega.z < -10, `Expected strong topspin omega.z < -10, got ${spikeOmega.z}`);
});

test('RallyEngine (real physics3d.js): Stuff-Block stops low Spike while Backspin Pokey/Cut clears NetBlock', () => {
  // Scenario A: Team 1 fires Heat Spike into jumping Team 2 NetBlocker -> STUFF_BLOCK!
  function runAttackVsBlocker(usePokey) {
    const engine = createRallyEngine({
      format: MATCH_FORMATS.ONE_V_ONE,
      aiStyle: AI_STYLES.NET_BLOCKER,
      servingTeam: 2,
      rng: () => 0.5,
    });

    let sawNetBlock = false;
    let sawStuffBlock = false;
    let sawPokeyCut = false;
    let pokeyOmega = null;
    let maxNetHeightCross = 0;

    for (let frame = 0; frame < 420; frame++) {
      const cur = engine.getSnapshot();
      const p1 = cur.players.find((p) => p.id === 'p1');
      const tx = cur.timingRing.active && cur.timingRing.team === 1 ? cur.timingRing.pos.x : cur.prediction.x;
      const tz = cur.timingRing.active && cur.timingRing.team === 1 ? cur.timingRing.pos.z : cur.prediction.z;
      const dx = tx - p1.pos.x;
      const dz = tz - p1.pos.z;
      const dist = Math.hypot(dx, dz);
      const moveX = dist > 0.12 ? dx / dist : 0;
      const moveZ = dist > 0.12 ? dz / dist : 0;
      const horizDist = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);

      let primaryJustPressed = false;
      let primaryHeld = false;
      let secondaryJustPressed = false;
      let secondaryHeld = false;

      if (cur.ball.pos.x <= 0.35 && cur.scoreboard.touchCount === 0 && horizDist <= 1.45 && cur.ball.pos.y <= 2.3) {
        primaryJustPressed = true;
        primaryHeld = true;
      } else if (cur.ball.pos.x <= 0.35 && cur.scoreboard.touchCount === 1 && horizDist <= 1.45 && cur.ball.pos.y <= 2.8 && cur.ball.vel.y <= 0.8) {
        primaryJustPressed = true;
        primaryHeld = true;
      } else if (cur.scoreboard.touchCount === 2 && cur.timingRing.active && cur.timingRing.team === 1 && cur.timingRing.inSweetSpot) {
        if (usePokey) {
          secondaryJustPressed = true;
          secondaryHeld = true;
        } else {
          primaryJustPressed = true;
          primaryHeld = true;
        }
      }

      const snap = engine.update(
        1 / 60,
        {
          p1: neutralCmd({
            isHuman: true,
            moveX,
            moveZ,
            aimX: usePokey ? -0.6 : 1.0,
            aimZ: 0,
            primaryHeld,
            primaryJustPressed,
            secondaryHeld,
            secondaryJustPressed,
          }),
          p2: neutralCmd(),
        },
        PHYSICS_DEFAULTS,
      );

      if (Math.abs(snap.ball.pos.x) < 0.45 && snap.ball.lastHitTeam === 1) {
        maxNetHeightCross = Math.max(maxNetHeightCross, snap.ball.pos.y);
      }

      for (const ev of snap.events) {
        if (ev.type === EVENTS.NET_BLOCK && ev.team === 2) {
          sawNetBlock = true;
        }
        if (ev.type === EVENTS.STUFF_BLOCK && ev.team === 2) {
          sawStuffBlock = true;
          assert.equal(snap.ball.shotType, SHOT_TYPES.BLOCK_STUFF);
          assert.ok(snap.ball.vel.x < 0, 'Stuff-Block must deflect ball back onto attacker side');
          assert.ok(snap.ball.vel.y < 0, 'Stuff-Block must drive ball downward');
          assert.equal(snap.scoreboard.touchCount, 0);
        }
        if (ev.type === EVENTS.POKEY_CUT && ev.team === 1) {
          sawPokeyCut = true;
          pokeyOmega = { ...snap.ball.omega };
          assert.equal(snap.ball.shotType, SHOT_TYPES.POKEY_CUT);
          assert.equal(snap.ball.trailMode, TRAIL_MODES.CYAN);
        }
      }

      if (sawStuffBlock) break;
      if (usePokey && sawPokeyCut && snap.ball.pos.x > 1.8) break;
    }

    return { sawNetBlock, sawStuffBlock, sawPokeyCut, pokeyOmega, maxNetHeightCross };
  }

  const blockedRun = runAttackVsBlocker(false);
  assert.equal(blockedRun.sawNetBlock, true, 'NET_BLOCKER AI must jump into NetBlock on opponent Set');
  assert.equal(blockedRun.sawStuffBlock, true, 'Jumping NetBlocker must Stuff-Block low Spike');

  const pokeyRun = runAttackVsBlocker(true);
  assert.equal(pokeyRun.sawNetBlock, true, 'NET_BLOCKER AI must jump on opponent Set');
  assert.equal(pokeyRun.sawPokeyCut, true, 'Expected Backspin Pokey/Cut');
  assert.equal(pokeyRun.sawStuffBlock, false, 'Backspin Pokey/Cut must clear jumping Stuff-Blocker');
  assert.ok(pokeyRun.pokeyOmega.z > 10, `Expected backspin omega.z > 10 for +X Pokey/Cut, got ${pokeyRun.pokeyOmega.z}`);
  assert.ok(pokeyRun.maxNetHeightCross > 3.35, `Expected Pokey/Cut net height > 3.35m, got ${pokeyRun.maxNetHeightCross}`);
});

test('RallyEngine (real physics3d.js): AI styles (WIND_LOBBER, SPIN_SLICER) produce distinct Touch-3 signatures', () => {
  function runAiStyle(style) {
    const engine = createRallyEngine({
      format: MATCH_FORMATS.ONE_V_ONE,
      aiStyle: style,
      servingTeam: 1, // P1 serves directly to Team 2 AI!
      rng: () => 0.5,
    });

    let attackShot = null;
    let attackTrail = null;
    let attackOmegaY = 0;

    for (let i = 0; i < 420; i++) {
      const snap = engine.update(1 / 60, null, PHYSICS_DEFAULTS);
      assertAllFiniteSnapshot(snap);
      for (const ev of snap.events) {
        if (ev.team === 2 && (ev.type === EVENTS.SPIKE || ev.type === EVENTS.HEAT_SPIKE || ev.type === EVENTS.POKEY_CUT)) {
          attackShot = snap.ball.shotType;
          attackTrail = snap.ball.trailMode;
          attackOmegaY = snap.ball.omega.y;
          break;
        }
      }
      if (attackShot) break;
    }

    return { attackShot, attackTrail, attackOmegaY };
  }

  const lobber = runAiStyle(AI_STYLES.WIND_LOBBER);
  assert.equal(lobber.attackShot, SHOT_TYPES.LOB);
  assert.equal(lobber.attackTrail, TRAIL_MODES.LOB);

  const slicer = runAiStyle(AI_STYLES.SPIN_SLICER);
  assert.equal(slicer.attackShot, SHOT_TYPES.POKEY_CUT);
  assert.equal(slicer.attackTrail, TRAIL_MODES.CYAN);
  assert.ok(Math.abs(slicer.attackOmegaY) >= 8, `Expected strong sidespin |omega.y| >= 8, got ${slicer.attackOmegaY}`);
});

test('RallyEngine (real physics3d.js): 2v2 AI partner sets after P1 Bump & TOUCH auto-footwork + 600-step stress', () => {
  const engine = createRallyEngine({
    format: MATCH_FORMATS.TWO_V_TWO,
    aiStyle: AI_STYLES.WIND_LOBBER,
    servingTeam: 2,
    rng: () => 0.5,
  });

  const initSnap = engine.getSnapshot();
  assert.equal(initSnap.players.length, 4);
  assert.equal(initSnap.scoreboard.format, MATCH_FORMATS.TWO_V_TWO);

  let p1Bumped = false;
  let partnerSet = false;
  let p1StartX = initSnap.players.find((p) => p.id === 'p1').pos.x;
  let p1MovedByAutoFootwork = false;

  for (let i = 0; i < 300; i++) {
    const cur = engine.getSnapshot();
    const p1 = cur.players.find((p) => p.id === 'p1');
    if (Math.abs(p1.pos.x - p1StartX) > 0.25) {
      p1MovedByAutoFootwork = true;
    }

    const horizDist = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);
    const pressBump =
      !p1Bumped && cur.ball.pos.x < 0 && cur.scoreboard.touchCount === 0 && horizDist <= 1.5 && cur.ball.pos.y <= 2.3;

    const snap = engine.update(
      1 / 60,
      {
        p1: neutralCmd({
          isHuman: true,
          autoFootwork: true,
          primaryJustPressed: pressBump,
          primaryHeld: pressBump,
        }),
        p2: neutralCmd(),
      },
      PHYSICS_DEFAULTS,
    );
    assertAllFiniteSnapshot(snap);

    for (const ev of snap.events) {
      if (ev.type === EVENTS.BUMP && ev.playerId === 'p1') {
        p1Bumped = true;
      }
      if (ev.type === EVENTS.SET && ev.playerId === 'p1_partner') {
        partnerSet = true;
        assert.equal(snap.timingRing.active, true);
        assert.equal(snap.timingRing.team, 1);
      }
    }
    if (p1Bumped && partnerSet) break;
  }

  assert.equal(p1MovedByAutoFootwork, true, 'Expected TOUCH autoFootwork to move P1 smoothly');
  assert.equal(p1Bumped, true, 'Expected P1 to execute Touch 1 Bump in 2v2');
  assert.equal(partnerSet, true, 'Expected 2v2 AI partner to execute Touch 2 Set after P1 Bump');

  // Switch back to 1v1, verify scoring on SAND_IMPACT, resetMatch(), and 600-step zero-NaN stability
  engine.setFormat(MATCH_FORMATS.ONE_V_ONE);
  assert.equal(engine.getSnapshot().players.length, 2);

  let pointScored = false;
  for (let step = 0; step < 600; step++) {
    const snap = engine.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
    assertAllFiniteSnapshot(snap);
    if (snap.events.some((e) => e.type === EVENTS.POINT_SCORED)) {
      pointScored = true;
    }
  }
  assert.equal(pointScored, true, 'Expected SAND_IMPACT & POINT_SCORED within 600 steps when P1 is idle');
  assert.ok(
    engine.getSnapshot().scoreboard.scoreP1 + engine.getSnapshot().scoreboard.scoreP2 >= 1,
    'Expected scoreboard to increment after point',
  );

  const resetSnap = engine.resetMatch();
  assert.equal(resetSnap.scoreboard.scoreP1, 0);
  assert.equal(resetSnap.scoreboard.scoreP2, 0);
  assert.equal(resetSnap.scoreboard.scoreT1, 0);
  assert.equal(resetSnap.scoreboard.scoreT2, 0);
  assert.equal(resetSnap.scoreboard.team1Heat, 0);
  assert.equal(resetSnap.scoreboard.team2Heat, 0);
});

test('RallyEngine (real physics3d.js): SandDive save triggers ANIM_STATES.SAND_DIVE, EVENTS.DIVE & +0.55 Heat', () => {
  const engine = createRallyEngine({
    format: MATCH_FORMATS.ONE_V_ONE,
    servingTeam: 2,
    rng: () => 0.5,
  });

  // Move P1 slightly away from landing spot so dive lunge catches it
  let sawDive = false;
  let heatAfterDive = 0;

  for (let frame = 0; frame < 200; frame++) {
    const cur = engine.getSnapshot();
    const p1 = cur.players.find((p) => p.id === 'p1');
    // Offset P1 ~1.7m away from landing X so secondary triggers SandDive save
    const targetX = cur.prediction.x - 1.65;
    const dx = targetX - p1.pos.x;
    const moveX = Math.abs(dx) > 0.1 ? Math.sign(dx) : 0;
    const horizDist = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);

    const triggerDive =
      cur.ball.pos.x < 0 &&
      cur.scoreboard.touchCount === 0 &&
      horizDist <= 2.15 &&
      cur.ball.pos.y <= 1.85 &&
      cur.ball.vel.y < 0;

    const snap = engine.update(
      1 / 60,
      {
        p1: neutralCmd({
          isHuman: true,
          moveX,
          moveZ: 0,
          secondaryJustPressed: triggerDive,
          secondaryHeld: triggerDive,
        }),
        p2: neutralCmd(),
      },
      PHYSICS_DEFAULTS,
    );

    for (const ev of snap.events) {
      if (ev.type === EVENTS.DIVE && ev.team === 1) {
        sawDive = true;
        heatAfterDive = snap.scoreboard.team1Heat;
        const p1After = snap.players.find((p) => p.id === 'p1');
        assert.equal(p1After.animState, ANIM_STATES.SAND_DIVE);
        assert.equal(snap.ball.shotType, SHOT_TYPES.DIVE_SAVE);
      }
    }
    if (sawDive) break;
  }

  assert.equal(sawDive, true, 'Expected SandDive save event');
  assert.ok(heatAfterDive >= 0.54, `Expected SandDive to charge Heat Meter >= 0.55, got ${heatAfterDive}`);
});

test('RallyEngine (real physics3d.js): net-crossing resets touchCount, anti-double-hit holds, and P2 human takeover works', () => {
  const engine = createRallyEngine({
    format: MATCH_FORMATS.ONE_V_ONE,
    aiStyle: AI_STYLES.WIND_LOBBER,
    servingTeam: 1, // P1 serves to P2
    rng: () => 0.5,
  });

  // P2 human takeover on human input
  const takeoverSnap = engine.update(
    1 / 60,
    {
      p1: neutralCmd(),
      p2: neutralCmd({ isHuman: true, moveX: -1 }),
    },
    PHYSICS_DEFAULTS,
  );
  const p2 = takeoverSnap.players.find((p) => p.id === 'p2');
  assert.equal(p2.isHuman, true);
  assert.ok(p2.vel.x < 0, 'Expected P2 to move toward net under human control');

  // Verify ball crossing X=0 from Team 1 -> Team 2 resets touchCount === 0 and sets activeTeam === 2
  let sawNetCross = false;
  for (let i = 0; i < 180; i++) {
    const snap = engine.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
    if (snap.ball.pos.x > 0.2) {
      sawNetCross = true;
      assert.equal(snap.scoreboard.activeTeam, 2);
      assert.equal(snap.scoreboard.touchCount, 0);
      break;
    }
  }
  assert.equal(sawNetCross, true, 'Expected serve to cross net into Team 2 court');

  // Verify anti-double-hit cooldown: pressing primary on consecutive 120Hz steps cannot increment touchCount twice immediately
  const engine2 = createRallyEngine({
    format: MATCH_FORMATS.ONE_V_ONE,
    servingTeam: 2,
    rng: () => 0.5,
  });

  let firstBumpStep = -1;
  for (let step = 0; step < 260; step++) {
    const snap = engine2.stepFixed(
      FIXED_DT,
      {
        p1: neutralCmd({ isHuman: true, primaryHeld: true, primaryJustPressed: true }),
        p2: neutralCmd(),
      },
      PHYSICS_DEFAULTS,
    );
    if (firstBumpStep === -1 && snap.events.some((e) => e.type === EVENTS.BUMP && e.team === 1)) {
      firstBumpStep = step;
      assert.equal(snap.scoreboard.touchCount, 1);
    } else if (firstBumpStep !== -1 && step <= firstBumpStep + 5) {
      assert.equal(snap.scoreboard.touchCount, 1, 'Adjacent 120Hz steps must not double-hit');
    }
  }
  assert.ok(firstBumpStep >= 0, 'Expected initial Bump contact');
});

// ============================================================================
// 3. M3 ITERATION 2 REGRESSION TESTS
// ============================================================================

test('RallyEngine (real physics3d.js): low-contact HEAT_SPIKE clears net under calm & Heavy Gale headwind while sweet-spot stays in Stuff-Block window', async () => {
  const realPhysics = await import('../../src/physics3d.js');

  function runExactStrike(startX, startY, windX) {
    let holdBall = false;
    let released = false;
    const wrappedPhysics = {
      ...realPhysics,
      updateWind3D(w, dt) {
        w.time += dt;
        w.windVec3.x = windX;
        w.windVec3.y = 0;
        w.windVec3.z = 0;
        w.speed = Math.abs(windX);
        return { phaseChanged: false, phase: w.phase, windVec3: w.windVec3 };
      },
      stepBall3D(b, w, cfg, dt, isSim) {
        if (holdBall && !released) {
          b.pos.x = startX;
          b.pos.y = startY;
          b.pos.z = 0;
          b.vel.x = 0;
          b.vel.y = -0.2;
          b.vel.z = 0;
          return { landed: false, wallHit: null, netHit: null, crossedNet: false, speed: 0.2 };
        }
        return realPhysics.stepBall3D(b, w, cfg, dt, isSim);
      },
    };

    const engine = createRallyEngine({
      physics: wrappedPhysics,
      format: MATCH_FORMATS.ONE_V_ONE,
      aiStyle: AI_STYLES.WIND_LOBBER,
      servingTeam: 2,
      rng: () => 0.5,
    });

    let crossed = false;
    let yAtNet = null;
    let netHit = null;
    let shotType = null;

    for (let i = 0; i < 600; i++) {
      const cur = engine.getSnapshot();
      const p1 = cur.players.find((p) => p.id === 'p1');
      let moveX = 0;
      let primaryJustPressed = false;
      let primaryHeld = false;

      if (!released) {
        if (cur.scoreboard.touchCount < 2) {
          moveX = Math.sign(cur.prediction.x - p1.pos.x);
          const d = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);
          if (cur.ball.pos.x < 0 && d < 1.4 && cur.ball.pos.y < 2.6) {
            primaryJustPressed = true;
            primaryHeld = true;
          }
        } else {
          holdBall = true;
          moveX = Math.sign(startX - p1.pos.x);
          if (Math.abs(startX - p1.pos.x) < 0.35 && p1.strikeCooldown <= 0) {
            primaryJustPressed = true;
            primaryHeld = true;
          }
        }
      }

      const prevX = cur.ball.pos.x;
      const prevY = cur.ball.pos.y;
      const snap = engine.stepFixed(
        FIXED_DT,
        {
          p1: neutralCmd({
            isHuman: true,
            moveX,
            aimX: 1,
            aimZ: 0,
            primaryJustPressed,
            primaryHeld,
          }),
          p2: neutralCmd(),
        },
        PHYSICS_DEFAULTS,
      );

      if (!released && snap.events.some((e) => e.type === EVENTS.HEAT_SPIKE || e.type === EVENTS.SPIKE)) {
        released = true;
        shotType = snap.ball.shotType;
      } else if (released) {
        const hitEv = snap.events.find(
          (e) => e.type === EVENTS.NET_TAPE_HIT || e.type === EVENTS.NET_MESH_HIT,
        );
        if (hitEv) {
          netHit = hitEv.part;
        }
        if (prevX < 0 && snap.ball.pos.x >= 0) {
          crossed = true;
          const frac = (0 - prevX) / (snap.ball.pos.x - prevX);
          yAtNet = prevY + frac * (snap.ball.pos.y - prevY);
          break;
        }
      }
    }

    return { shotType, crossed, yAtNet, netHit };
  }

  for (const [startX, startY, windX] of [
    [-1.5, 1.8, 0],
    [-1.5, 1.8, -5.5],
    [-1.5, 2.2, 0],
    [-1.5, 2.2, -5.5],
  ]) {
    const res = runExactStrike(startX, startY, windX);
    assert.equal(res.shotType, SHOT_TYPES.HEAT_SPIKE);
    assert.equal(res.crossed, true, `Expected HEAT_SPIKE from (${startX}, ${startY}) wind=${windX} to cross net`);
    assert.equal(res.netHit, null, `Expected zero net tape/mesh hit from (${startX}, ${startY}) wind=${windX}, got ${res.netHit}`);
    assert.ok(res.yAtNet >= 2.68 && res.yAtNet <= 3.32, `Expected yAtNet in [2.68, 3.32], got ${res.yAtNet}`);
  }

  // Sweet-spot high HEAT_SPIKE (y = 3.1m) must stay inside [2.75, 3.15] (Stuff-Block window <= 3.32m)
  const highCalm = runExactStrike(-1.25, 3.1, 0);
  assert.equal(highCalm.crossed, true);
  assert.equal(highCalm.netHit, null);
  assert.ok(highCalm.yAtNet >= 2.75 && highCalm.yAtNet <= 3.15, `Expected high calm yAtNet in [2.75, 3.15], got ${highCalm.yAtNet}`);

  const highWind = runExactStrike(-1.25, 3.1, -5.5);
  assert.equal(highWind.crossed, true);
  assert.equal(highWind.netHit, null);
  assert.ok(highWind.yAtNet >= 2.75 && highWind.yAtNet <= 3.15, `Expected high headwind yAtNet in [2.75, 3.15], got ${highWind.yAtNet}`);

  // Reactive TOUCH auto-footwork rally must never clip net tape or freeze over 1200 steps
  const touchEngine = createRallyEngine({
    format: MATCH_FORMATS.ONE_V_ONE,
    aiStyle: AI_STYLES.WIND_LOBBER,
    servingTeam: 2,
    rng: () => 0.5,
  });
  let netTapeHits = 0;
  for (let i = 0; i < 1200; i++) {
    const snap = touchEngine.stepFixed(
      FIXED_DT,
      { p1: neutralCmd({ isHuman: true, autoFootwork: true }), p2: neutralCmd() },
      PHYSICS_DEFAULTS,
    );
    assertAllFiniteSnapshot(snap);
    if (snap.events.some((e) => e.type === EVENTS.NET_TAPE_HIT || e.type === EVENTS.NET_MESH_HIT)) {
      netTapeHits += 1;
    }
  }
  assert.equal(netTapeHits, 0, 'Expected zero net tape/mesh hits in reactive TOUCH auto-footwork rally');
});

test('RallyEngine (real physics3d.js): close-net & charged HEAT_SPIKE is Stuff-Blocked without tunneling while POKEY_CUT clears', async () => {
  const realPhysics = await import('../../src/physics3d.js');

  function runCloseNetScenario(startX, windX, charged, usePokey) {
    let holdBall = false;
    let released = false;
    const wrappedPhysics = {
      ...realPhysics,
      updateWind3D(w, dt) {
        w.time += dt;
        w.windVec3.x = windX;
        w.windVec3.y = 0;
        w.windVec3.z = 0;
        w.speed = Math.abs(windX);
        return { phaseChanged: false, phase: w.phase, windVec3: w.windVec3 };
      },
      stepBall3D(b, w, cfg, dt, isSim) {
        if (holdBall && !released) {
          b.pos.x = startX;
          b.pos.y = 2.95;
          b.pos.z = 0;
          b.vel.x = 0;
          b.vel.y = -0.2;
          b.vel.z = 0;
          return { landed: false, wallHit: null, netHit: null, crossedNet: false, speed: 0.2 };
        }
        return realPhysics.stepBall3D(b, w, cfg, dt, isSim);
      },
    };

    const engine = createRallyEngine({
      physics: wrappedPhysics,
      format: MATCH_FORMATS.ONE_V_ONE,
      aiStyle: AI_STYLES.NET_BLOCKER,
      servingTeam: 2,
      rng: () => 0.5,
    });

    let chargeTicks = 0;
    let stuffed = false;
    let stuffVel = null;
    let crossed = false;
    let yAtNet = null;

    for (let i = 0; i < 600; i++) {
      const cur = engine.getSnapshot();
      const p1 = cur.players.find((p) => p.id === 'p1');
      const p2 = cur.players.find((p) => p.id === 'p2');
      let moveX = 0;
      let pPress = false;
      let pHeld = false;
      let sPress = false;
      let sHeld = false;

      if (!released) {
        if (cur.scoreboard.touchCount < 2) {
          moveX = Math.sign(cur.prediction.x - p1.pos.x);
          const d = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);
          if (cur.ball.pos.x < 0 && d < 1.4 && cur.ball.pos.y < 2.6) {
            pPress = true;
            pHeld = true;
          }
        } else {
          holdBall = true;
          moveX = Math.sign(startX - p1.pos.x);
          if (Math.abs(startX - p1.pos.x) < 0.35 && p1.strikeCooldown <= 0 && Math.abs(p2.pos.x) <= 1.5) {
            if (charged && chargeTicks < 55) {
              pHeld = true;
              chargeTicks += 1;
            } else if (p2.blockTimer > 0.2) {
              if (usePokey) {
                sPress = true;
                sHeld = true;
              } else {
                pPress = true;
                pHeld = true;
              }
            }
          }
        }
      }

      const prevX = cur.ball.pos.x;
      const prevY = cur.ball.pos.y;
      const snap = engine.stepFixed(
        FIXED_DT,
        {
          p1: neutralCmd({
            isHuman: true,
            moveX,
            aimX: usePokey ? -0.8 : 1,
            aimZ: 0,
            primaryJustPressed: pPress,
            primaryHeld: pHeld,
            secondaryJustPressed: sPress,
            secondaryHeld: sHeld,
          }),
          p2: neutralCmd(),
        },
        PHYSICS_DEFAULTS,
      );

      if (!released && snap.events.some((e) => e.type === EVENTS.HEAT_SPIKE || e.type === EVENTS.POKEY_CUT)) {
        released = true;
      } else if (released) {
        if (snap.events.some((e) => e.type === EVENTS.STUFF_BLOCK)) {
          stuffed = true;
          stuffVel = { ...snap.ball.vel };
          break;
        }
        if (prevX < 0 && snap.ball.pos.x >= 0) {
          crossed = true;
          const frac = (0 - prevX) / (snap.ball.pos.x - prevX);
          yAtNet = prevY + frac * (snap.ball.pos.y - prevY);
        }
        if (snap.ball.pos.x > 1.5) {
          break;
        }
      }
    }

    return { stuffed, stuffVel, crossed, yAtNet };
  }

  for (const [startX, windX, charged] of [
    [-0.95, 0, false],
    [-0.95, 0, true],
    [-0.80, 0, false],
    [-1.10, -5.5, true],
  ]) {
    const res = runCloseNetScenario(startX, windX, charged, false);
    assert.equal(res.stuffed, true, `Expected close-net HEAT_SPIKE (x=${startX}, wind=${windX}, charged=${charged}) to be Stuff-Blocked`);
    assert.ok(res.stuffVel.x < -2.0, `Expected sharp backward Stuff-Block vx < -2.0, got ${res.stuffVel.x}`);
    assert.ok(res.stuffVel.y <= -8.0, `Expected sharp downward Stuff-Block vy <= -8.0, got ${res.stuffVel.y}`);
  }

  const pokeyRes = runCloseNetScenario(-0.95, 0, false, true);
  assert.equal(pokeyRes.stuffed, false, 'Close-net Backspin Pokey/Cut must clear jumping Stuff-Blocker');
  assert.equal(pokeyRes.crossed, true);
  assert.ok(pokeyRes.yAtNet > 3.35, `Expected Pokey/Cut yAtNet > 3.35, got ${pokeyRes.yAtNet}`);
});

test('RallyEngine: external events queue delivers triggerGust() on next update(), matchOver flag on POINT_SCORED, and deep-clones prediction.trajectory', () => {
  const diPhysics = createDeterministicDiPhysics();
  const origPredict = diPhysics.predictLandingPoint3D;
  diPhysics.predictLandingPoint3D = (...args) => {
    const res = origPredict(...args);
    res.trajectory = [{ x: 1, y: 2, z: 3 }];
    return res;
  };

  const engine = createRallyEngine({ physics: diPhysics, servingTeam: 2, winScore: 2 });

  // Snapshot trajectory must be deep-cloned (mutating snapshot must not mutate internal state)
  const snapA = engine.getSnapshot();
  assert.equal(snapA.prediction.trajectory.length, 1);
  snapA.prediction.trajectory[0].x = 999;
  snapA.prediction.trajectory.push({ x: 7, y: 8, z: 9 });
  const snapB = engine.getSnapshot();
  assert.equal(snapB.prediction.trajectory.length, 1);
  assert.equal(snapB.prediction.trajectory[0].x, 1);

  // triggerGust() visible immediately via getSnapshot(), delivered on next update(), cleared on frame after
  engine.triggerGust(1);
  assert.ok(engine.getSnapshot().events.some((e) => e.type === EVENTS.GUST_WARNING));
  const frame1 = engine.update(1 / 60, null, PHYSICS_DEFAULTS);
  assert.ok(
    frame1.events.some((e) => e.type === EVENTS.GUST_WARNING),
    'Expected triggerGust() GUST_WARNING to be delivered on next update() frame',
  );
  const frame2 = engine.update(1 / 60, null, PHYSICS_DEFAULTS);
  assert.equal(
    frame2.events.some((e) => e.type === EVENTS.GUST_WARNING),
    false,
    'Expected GUST_WARNING to clear on subsequent frame',
  );

  // Verify POINT_SCORED includes matchOver: false on 1st point and matchOver: true on winning point (winScore: 2)
  const pointEvents = [];
  for (let i = 0; i < 1600 && pointEvents.length < 2; i++) {
    const s = engine.stepFixed(
      FIXED_DT,
      { p1: neutralCmd({ isHuman: true, moveX: -1 }), p2: neutralCmd() },
      PHYSICS_DEFAULTS,
    );
    for (const ev of s.events) {
      if (ev.type === EVENTS.POINT_SCORED) {
        pointEvents.push(ev);
      }
    }
  }
  assert.equal(pointEvents.length, 2, 'Expected 2 points scored against out-of-position P1');
  assert.equal(pointEvents[0].matchOver, false);
  assert.equal(pointEvents[1].matchOver, true);
});

test('RallyEngine: ballOnMySide prevents Team 2 from reaching through net tape to bump ball at x = -0.28m', () => {
  const diPhysics = createDeterministicDiPhysics();
  diPhysics.stepBall3D = (b) => {
    b.pos.x = -0.28;
    b.pos.y = 1.6;
    b.pos.z = 0;
    b.vel.x = -2.0;
    b.vel.y = -0.5;
    b.vel.z = 0;
    return { landed: false, wallHit: null, netHit: null, crossedNet: false, speed: 2.1 };
  };

  const engine = createRallyEngine({
    physics: diPhysics,
    format: MATCH_FORMATS.ONE_V_ONE,
    servingTeam: 1,
  });

  // Move P2 right up against the net (x = 0.55) and mash primary button
  let p2BumpedThroughNet = false;
  for (let i = 0; i < 120; i++) {
    const snap = engine.stepFixed(
      FIXED_DT,
      {
        p1: neutralCmd({ isHuman: true, moveX: -1 }),
        p2: neutralCmd({ isHuman: true, moveX: -1, primaryHeld: true, primaryJustPressed: true }),
      },
      PHYSICS_DEFAULTS,
    );
    if (snap.events.some((e) => e.team === 2 && (e.type === EVENTS.BUMP || e.type === EVENTS.DIVE))) {
      p2BumpedThroughNet = true;
      break;
    }
  }
  assert.equal(p2BumpedThroughNet, false, 'Team 2 must never reach through the net tape to touch ball at x = -0.28m');
});

test('RallyEngine: resetMatch() clears pendingEdges, hit-stop clears accumulator, and non-finite FIXED_DT falls back safely', () => {
  // 1. Non-finite FIXED_DT fallback
  let stepCalls = 0;
  const badFixedPhysics = createDeterministicDiPhysics();
  badFixedPhysics.FIXED_DT = Number.POSITIVE_INFINITY;
  const origStep = badFixedPhysics.stepBall3D;
  badFixedPhysics.stepBall3D = (...args) => {
    stepCalls += 1;
    return origStep(...args);
  };
  const infEngine = createRallyEngine({ physics: badFixedPhysics, servingTeam: 2 });
  infEngine.update(1 / 60, null, PHYSICS_DEFAULTS);
  assert.equal(stepCalls, 2, 'Non-finite physics.FIXED_DT must fall back to canonical 1/120s FIXED_DT');

  // 2. resetMatch() clears pendingEdges so 0-step latched input causes no phantom SandDive
  const eng2 = createRallyEngine({ physics: createDeterministicDiPhysics(), servingTeam: 2 });
  eng2.update(
    0.001,
    { p1: neutralCmd({ isHuman: true, secondaryJustPressed: true, secondaryHeld: true }), p2: neutralCmd() },
    PHYSICS_DEFAULTS,
  );
  eng2.resetMatch();
  const afterReset = eng2.update(
    1 / 60,
    { p1: neutralCmd({ isHuman: true }), p2: neutralCmd() },
    PHYSICS_DEFAULTS,
  );
  const p1AfterReset = afterReset.players.find((p) => p.id === 'p1');
  assert.notEqual(p1AfterReset.animState, ANIM_STATES.SAND_DIVE, 'resetMatch() must clear latched pendingEdges');
  assert.equal(p1AfterReset.diveTimer, 0);

  // 3. Hit-stop clears accumulator so resume frame runs 2 substeps (1/60s), not 7 catch-up steps
  let stepCount = 0;
  const countedPhysics = createDeterministicDiPhysics();
  const origBallStep = countedPhysics.stepBall3D;
  countedPhysics.stepBall3D = (...args) => {
    stepCount += 1;
    return origBallStep(...args);
  };
  const hsEngine = createRallyEngine({ physics: countedPhysics, servingTeam: 2, rng: () => 0.5 });

  let triggeredHitStop = false;
  for (let frame = 0; frame < 360; frame++) {
    const cur = hsEngine.getSnapshot();
    const p1 = cur.players.find((p) => p.id === 'p1');
    const tx = cur.timingRing.active && cur.timingRing.team === 1 ? cur.timingRing.pos.x : cur.prediction.x;
    const tz = cur.timingRing.active && cur.timingRing.team === 1 ? cur.timingRing.pos.z : cur.prediction.z;
    const dx = tx - p1.pos.x;
    const dz = tz - p1.pos.z;
    const dist = Math.hypot(dx, dz);
    const moveX = dist > 0.12 ? dx / dist : 0;
    const moveZ = dist > 0.12 ? dz / dist : 0;
    const horizDist = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);

    let pPress = false;
    let pHeld = false;
    let dt = 1 / 60;
    if (cur.ball.pos.x <= 0.05 && cur.scoreboard.touchCount === 0 && horizDist <= 1.45 && cur.ball.pos.y <= 2.3) {
      pPress = true;
      pHeld = true;
    } else if (cur.ball.pos.x <= 0.05 && cur.scoreboard.touchCount === 1 && horizDist <= 1.45 && cur.ball.pos.y <= 2.8 && cur.ball.vel.y <= 0.8) {
      pPress = true;
      pHeld = true;
    } else if (cur.scoreboard.touchCount === 2 && cur.timingRing.active && cur.timingRing.team === 1 && cur.timingRing.inSweetSpot) {
      pPress = true;
      pHeld = true;
      dt = 0.05; // Large frame dt leaves leftover accumulator when Heat Spike triggers on step 0!
    }

    const snap = hsEngine.update(
      dt,
      { p1: neutralCmd({ isHuman: true, moveX, moveZ, aimX: 1, primaryHeld: pHeld, primaryJustPressed: pPress }), p2: neutralCmd() },
      PHYSICS_DEFAULTS,
    );
    if (snap.events.some((e) => e.type === EVENTS.HEAT_SPIKE)) {
      triggeredHitStop = true;
      assert.equal(snap.hitStopFrames, 2);
      // 2 frozen hit-stop updates
      const beforeHs = stepCount;
      hsEngine.update(1 / 60, null, PHYSICS_DEFAULTS);
      hsEngine.update(1 / 60, null, PHYSICS_DEFAULTS);
      assert.equal(stepCount, beforeHs, 'Hit-stop frames must execute 0 physics steps');
      // Resume update(1/60) must execute exactly 2 substeps (not 7 catch-up steps!)
      hsEngine.update(1 / 60, null, PHYSICS_DEFAULTS);
      assert.equal(stepCount - beforeHs, 2, `Expected 2 substeps on resume after hit-stop, got ${stepCount - beforeHs}`);
      break;
    }
  }
  assert.equal(triggeredHitStop, true, 'Expected Heat Spike hit-stop trigger');
});

test('RallyEngine (real physics3d.js): corner-aimed HEAT_SPIKE attacks score points reliably against all 3 AI styles', () => {
  for (const style of [AI_STYLES.WIND_LOBBER, AI_STYLES.NET_BLOCKER, AI_STYLES.SPIN_SLICER]) {
    const engine = createRallyEngine({
      format: MATCH_FORMATS.ONE_V_ONE,
      aiStyle: style,
      servingTeam: 2,
      rng: () => 0.5,
    });

    let pointsScored = 0;
    let aimDir = 1;

    for (let frame = 0; frame < 3600; frame++) {
      const cur = engine.getSnapshot();
      const p1 = cur.players.find((p) => p.id === 'p1');
      const p2 = cur.players.find((p) => p.id === 'p2');
      const d = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);

      let pPress = false;
      let pHeld = false;
      if (cur.ball.pos.x <= 0.05 && cur.scoreboard.touchCount === 0 && d <= 1.45 && cur.ball.pos.y <= 2.3) {
        pPress = true;
        pHeld = true;
      } else if (cur.ball.pos.x <= 0.05 && cur.scoreboard.touchCount === 1 && d <= 1.45 && cur.ball.pos.y <= 2.8 && cur.ball.vel.y <= 0.8) {
        pPress = true;
        pHeld = true;
      } else if (cur.scoreboard.touchCount === 2 && cur.timingRing.active && cur.timingRing.team === 1 && cur.timingRing.inSweetSpot) {
        pPress = true;
        pHeld = true;
        aimDir = p2.pos.z >= 0 ? -1 : 1;
      }

      const snap = engine.update(
        1 / 60,
        {
          p1: neutralCmd({
            isHuman: true,
            autoFootwork: true,
            aimX: 1,
            aimZ: aimDir,
            primaryJustPressed: pPress,
            primaryHeld: pHeld,
          }),
          p2: neutralCmd(),
        },
        PHYSICS_DEFAULTS,
      );
      assertAllFiniteSnapshot(snap);
      for (const ev of snap.events) {
        if (ev.type === EVENTS.POINT_SCORED) {
          pointsScored += 1;
        }
      }
      if (pointsScored >= 2) break;
    }

    assert.ok(
      pointsScored >= 2,
      `Expected >= 2 points scored against ${style} with corner Heat Spikes (no 0-0 stalemate), got ${pointsScored}`,
    );
  }
});

test('InputManager hardening: primitive-string getGamepads() returns 0 pads and Quick-Bind slot-4 capture does not leak into keysDown', () => {
  // 1. Primitive-string and non-object gamepad entries must report padsConnected === 0
  let rawReturn = 'bad';
  const padMgr = createInputManager(null, {
    getGamepads: () => rawReturn,
    storage: createMockStorage(),
    windowTarget: null,
  });
  assert.equal(padMgr.pollInputs(1 / 60).padsConnected, 0);
  rawReturn = ['bad', 42, true, null, undefined];
  assert.equal(padMgr.pollInputs(1 / 60).padsConnected, 0);
  padMgr.destroy();

  // 2. Completing Quick-Bind slot 4 via keyboard must NOT leak that held key onto the immediate next poll
  const win = createMockEventTarget();
  const storage = createMockStorage();
  const qbMgr = createInputManager(null, {
    windowTarget: win,
    storage,
    getGamepads: () => [],
  });

  let completed = false;
  qbMgr.startQuickBind(null, (res) => {
    completed = Boolean(res && res.completed);
  });

  win.dispatch('keydown', makeKeyEvent('KeyU'));
  win.dispatch('keydown', makeKeyEvent('KeyI'));
  win.dispatch('keydown', makeKeyEvent('KeyO'));
  // Capture final slot 3 (p2Secondary) with KeyP and DO NOT dispatch keyup yet!
  win.dispatch('keydown', makeKeyEvent('KeyP'));
  assert.equal(completed, true);

  // Immediate next poll while KeyP is still physically held must NOT fire phantom secondaryHeld
  const immediatePoll = qbMgr.pollInputs(1 / 60);
  assert.equal(immediatePoll.p2.secondaryHeld, false, 'Quick-Bind confirmation key must not leak into keysDown');
  assert.equal(immediatePoll.p2.secondaryJustPressed, false);

  // After releasing and pressing KeyP fresh, it activates normally
  win.dispatch('keyup', makeKeyEvent('KeyP'));
  win.dispatch('keydown', makeKeyEvent('KeyP'));
  const freshPoll = qbMgr.pollInputs(1 / 60);
  assert.equal(freshPoll.p2.secondaryHeld, true);
  assert.equal(freshPoll.p2.secondaryJustPressed, true);

  qbMgr.destroy();
});

// ============================================================================
// 4. M3 ITERATION 3 REGRESSION TESTS
// ============================================================================

test('RallyEngine: paused update() and stepFixed() drain pendingExternalEvents once (zero 60Hz replay storm)', () => {
  // Portrait startup scenario: constructor queues SERVE, then viewport resize immediately pauses engine
  const eng = createRallyEngine({ physics: createDeterministicDiPhysics(), servingTeam: 2 });
  eng.setPaused(true);

  const startupImm = eng.getSnapshot();
  assert.deepEqual(startupImm.events.map((e) => e.type), [EVENTS.SERVE]);

  const pausedFrame1 = eng.update(1 / 60, null, PHYSICS_DEFAULTS);
  assert.deepEqual(
    pausedFrame1.events.map((e) => e.type),
    [EVENTS.SERVE],
    'Paused frame 1 must deliver queued startup SERVE event once',
  );

  const pausedFrame2 = eng.update(1 / 60, null, PHYSICS_DEFAULTS);
  assert.deepEqual(pausedFrame2.events, [], 'Paused frame 2 must return empty events (no replay)');

  const pausedFrame3 = eng.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
  assert.deepEqual(pausedFrame3.events, [], 'Paused stepFixed frame 3 must return empty events');

  // triggerGust() while paused: visible immediately in getSnapshot(), delivered once on paused frame 1, [] on frame 2+
  eng.triggerGust(-1);
  assert.deepEqual(
    eng.getSnapshot().events.map((e) => e.type),
    [EVENTS.GUST_WARNING],
    'triggerGust() while paused must appear immediately in getSnapshot()',
  );

  const gustFrame1 = eng.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
  assert.deepEqual(
    gustFrame1.events.map((e) => e.type),
    [EVENTS.GUST_WARNING],
    'Paused stepFixed frame 1 must deliver GUST_WARNING once',
  );

  const gustFrame2 = eng.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
  assert.deepEqual(gustFrame2.events, [], 'Paused stepFixed frame 2 must return empty events');

  const gustFrame3 = eng.update(1 / 60, null, PHYSICS_DEFAULTS);
  assert.deepEqual(gustFrame3.events, [], 'Paused update frame 3 must return empty events');
});

test('RallyEngine (real physics3d.js): 2v2 AI partner sets Touch 2 and yields Touch 3 to P1 across all 3 AI styles', () => {
  for (const style of [AI_STYLES.WIND_LOBBER, AI_STYLES.NET_BLOCKER, AI_STYLES.SPIN_SLICER]) {
    const engine = createRallyEngine({
      format: MATCH_FORMATS.TWO_V_TWO,
      aiStyle: style,
      servingTeam: 2,
      rng: () => 0.5,
    });

    let pointsScored = 0;
    let p1Touch3Count = 0;
    let partnerTouch3Count = 0;
    let partnerSetCount = 0;
    let aimDir = 1;

    for (let step = 0; step < 3600; step++) {
      const cur = engine.getSnapshot();
      const p1 = cur.players.find((p) => p.id === 'p1');
      const opps = cur.players.filter((p) => p.team === 2);
      const d = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);

      let pPress = false;
      let pHeld = false;
      if (cur.ball.pos.x <= 0.05 && cur.scoreboard.touchCount === 0 && d <= 1.45 && cur.ball.pos.y <= 2.3) {
        pPress = true;
        pHeld = true;
      } else if (cur.scoreboard.touchCount === 2 && cur.timingRing.active && cur.timingRing.team === 1 && cur.timingRing.inSweetSpot) {
        pPress = true;
        pHeld = true;
        const dNeg = Math.min(...opps.map((o) => Math.abs(-3.5 - o.pos.z)));
        const dPos = Math.min(...opps.map((o) => Math.abs(3.5 - o.pos.z)));
        aimDir = dPos >= dNeg ? 1 : -1;
      }

      const snap = engine.stepFixed(
        FIXED_DT,
        {
          p1: neutralCmd({
            isHuman: true,
            autoFootwork: true,
            aimX: 1,
            aimZ: aimDir,
            primaryJustPressed: pPress,
            primaryHeld: pHeld,
          }),
          p2: neutralCmd(),
        },
        PHYSICS_DEFAULTS,
      );
      assertAllFiniteSnapshot(snap);

      for (const ev of snap.events) {
        if (ev.type === EVENTS.SET && ev.playerId === 'p1_partner') {
          partnerSetCount += 1;
        }
        if (
          ev.team === 1 &&
          (ev.type === EVENTS.HEAT_SPIKE || ev.type === EVENTS.SPIKE || ev.type === EVENTS.POKEY_CUT)
        ) {
          if (ev.playerId === 'p1') p1Touch3Count += 1;
          if (ev.playerId === 'p1_partner') partnerTouch3Count += 1;
        }
        if (ev.type === EVENTS.POINT_SCORED) {
          pointsScored += 1;
        }
      }
      if (pointsScored >= 2 && p1Touch3Count >= 2 && partnerSetCount >= 1) {
        break;
      }
    }

    assert.ok(partnerSetCount >= 1, `Expected p1_partner to set Touch 2 in 2v2 ${style}`);
    assert.ok(p1Touch3Count >= 2, `Expected human p1 to execute Touch 3 in 2v2 ${style}, got ${p1Touch3Count}`);
    assert.equal(partnerTouch3Count, 0, `p1_partner must yield Touch 3 to human p1 in 2v2 ${style}, stole ${partnerTouch3Count}`);
    assert.ok(pointsScored >= 2, `Expected >= 2 points scored in 2v2 ${style} (no stalemate), got ${pointsScored}`);
  }
});

test('RallyEngine (real physics3d.js): TOUCH auto-footwork (R1 repro & NET_BLOCKER) scores without stalemate and low-contact HEAT_SPIKE lands on-court', async () => {
  const realPhysics = await import('../../src/physics3d.js');

  // 1. Exact Iteration 1 repro: 1v1 WIND_LOBBER, servingTeam 2, rng () => 0.5, pure TOUCH autoFootwork
  const r1Engine = createRallyEngine({
    format: MATCH_FORMATS.ONE_V_ONE,
    aiStyle: AI_STYLES.WIND_LOBBER,
    servingTeam: 2,
    rng: () => 0.5,
  });
  let r1Points = 0;
  let r1NetHits = 0;
  for (let i = 0; i < 3600; i++) {
    const snap = r1Engine.stepFixed(
      FIXED_DT,
      { p1: neutralCmd({ isHuman: true, autoFootwork: true }), p2: neutralCmd() },
      PHYSICS_DEFAULTS,
    );
    assertAllFiniteSnapshot(snap);
    for (const ev of snap.events) {
      if (ev.type === EVENTS.POINT_SCORED) r1Points += 1;
      if (ev.type === EVENTS.NET_TAPE_HIT || ev.type === EVENTS.NET_MESH_HIT) r1NetHits += 1;
    }
  }
  assert.equal(r1NetHits, 0, 'Expected zero net hits in R1 TOUCH auto-footwork repro');
  assert.ok(r1Points >= 2, `Expected >= 2 points in R1 TOUCH auto-footwork repro (no 0-0 stalemate), got ${r1Points}`);

  // 2. Active TOUCH auto-footwork vs NET_BLOCKER: Stuff-Blocks genuinely score points (no infinite loop!)
  const blockerEngine = createRallyEngine({
    format: MATCH_FORMATS.ONE_V_ONE,
    aiStyle: AI_STYLES.NET_BLOCKER,
    servingTeam: 2,
    rng: () => 0.5,
  });
  let blockerPoints = 0;
  let blockerStuffs = 0;
  for (let i = 0; i < 3600; i++) {
    const tap = i % 40 === 0;
    const snap = blockerEngine.stepFixed(
      FIXED_DT,
      {
        p1: neutralCmd({ isHuman: true, autoFootwork: true, primaryJustPressed: tap, primaryHeld: tap }),
        p2: neutralCmd(),
      },
      PHYSICS_DEFAULTS,
    );
    assertAllFiniteSnapshot(snap);
    for (const ev of snap.events) {
      if (ev.type === EVENTS.STUFF_BLOCK) blockerStuffs += 1;
      if (ev.type === EVENTS.POINT_SCORED) blockerPoints += 1;
    }
    if (blockerPoints >= 2 && blockerStuffs >= 2) break;
  }
  assert.ok(blockerStuffs >= 2, `Expected NET_BLOCKER Stuff-Blocks, got ${blockerStuffs}`);
  assert.ok(blockerPoints >= 2, `Expected NET_BLOCKER Stuff-Blocks to score points (no 0-0 loop), got ${blockerPoints}`);

  // 3. Low-contact HEAT_SPIKE at x = -1.26, y = 1.94 (calm & -5.5 headwind) lands inside court without back-wall moonshot
  for (const windX of [0, -5.5]) {
    let holdBall = false;
    let released = false;
    const wrappedPhysics = {
      ...realPhysics,
      updateWind3D(w, dt) {
        w.time += dt;
        w.windVec3.x = windX;
        w.windVec3.y = 0;
        w.windVec3.z = 0;
        w.speed = Math.abs(windX);
        return { phaseChanged: false, phase: w.phase, windVec3: w.windVec3 };
      },
      stepBall3D(b, w, cfg, dt, isSim) {
        if (holdBall && !released) {
          b.pos.x = -1.26;
          b.pos.y = 1.94;
          b.pos.z = 0;
          b.vel.x = 0;
          b.vel.y = -0.2;
          b.vel.z = 0;
          return { landed: false, wallHit: null, netHit: null, crossedNet: false, speed: 0.2 };
        }
        return realPhysics.stepBall3D(b, w, cfg, dt, isSim);
      },
    };
    const eng = createRallyEngine({
      physics: wrappedPhysics,
      format: MATCH_FORMATS.ONE_V_ONE,
      aiStyle: AI_STYLES.WIND_LOBBER,
      servingTeam: 2,
      rng: () => 0.5,
    });
    let wallHit = false;
    let netHit = false;
    let landX = null;
    for (let i = 0; i < 600; i++) {
      const cur = eng.getSnapshot();
      const p1 = cur.players.find((p) => p.id === 'p1');
      let moveX = 0;
      let pPress = false;
      let pHeld = false;
      if (!released) {
        if (cur.scoreboard.touchCount < 2) {
          moveX = Math.sign(cur.prediction.x - p1.pos.x);
          const d = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);
          if (cur.ball.pos.x < 0 && d < 1.4 && cur.ball.pos.y < 2.6) {
            pPress = true;
            pHeld = true;
          }
        } else {
          holdBall = true;
          moveX = Math.sign(-1.26 - p1.pos.x);
          if (Math.abs(-1.26 - p1.pos.x) < 0.35 && p1.strikeCooldown <= 0) {
            pPress = true;
            pHeld = true;
          }
        }
      }
      const snap = eng.stepFixed(
        FIXED_DT,
        {
          p1: neutralCmd({ isHuman: true, moveX, aimX: 1, aimZ: 0, primaryJustPressed: pPress, primaryHeld: pHeld }),
          // Move P2 out of the way so we observe true landing point
          p2: neutralCmd({ isHuman: true, moveX: 1, moveZ: 1 }),
        },
        PHYSICS_DEFAULTS,
      );
      if (!released && snap.events.some((e) => e.type === EVENTS.HEAT_SPIKE)) {
        released = true;
      } else if (released) {
        if (snap.events.some((e) => e.type === EVENTS.WALL_BOUNCE)) wallHit = true;
        if (snap.events.some((e) => e.type === EVENTS.NET_TAPE_HIT || e.type === EVENTS.NET_MESH_HIT)) netHit = true;
        if (snap.events.some((e) => e.type === EVENTS.SAND_IMPACT)) {
          landX = snap.ball.pos.x;
          break;
        }
      }
    }
    assert.equal(released, true, `Expected low-contact HEAT_SPIKE release under windX=${windX}`);
    assert.equal(netHit, false, `Expected zero net hit for low-contact HEAT_SPIKE under windX=${windX}`);
    assert.equal(wallHit, false, `Expected zero back-wall moonshot under windX=${windX}`);
    assert.ok(landX !== null && landX > 0 && landX < 10.0, `Expected on-court landing < 10.0m under windX=${windX}, got ${landX}`);
  }
});

test('RallyEngine (real physics3d.js): low-contact POKEY_CUT clears jumping NetBlock under Heavy Gale gustScale=2.0', async () => {
  const realPhysics = await import('../../src/physics3d.js');

  for (const [startX, startY, windX, gustScale] of [
    [-1.25, 2.2, -12.4, 2.0],
    [-0.95, 1.8, 0, 1.0],
    [-0.95, 1.8, -12.4, 2.0],
  ]) {
    let holdBall = false;
    let released = false;
    const wrappedPhysics = {
      ...realPhysics,
      updateWind3D(w, dt) {
        w.time += dt;
        w.windVec3.x = windX;
        w.windVec3.y = 0;
        w.windVec3.z = 0;
        w.speed = Math.abs(windX);
        return { phaseChanged: false, phase: w.phase, windVec3: w.windVec3 };
      },
      stepBall3D(b, w, cfg, dt, isSim) {
        if (holdBall && !released) {
          b.pos.x = startX;
          b.pos.y = startY;
          b.pos.z = 0;
          b.vel.x = 0;
          b.vel.y = -0.2;
          b.vel.z = 0;
          return { landed: false, wallHit: null, netHit: null, crossedNet: false, speed: 0.2 };
        }
        return realPhysics.stepBall3D(b, w, cfg, dt, isSim);
      },
    };
    const cfg = { ...PHYSICS_DEFAULTS, gustScale };
    const engine = createRallyEngine({
      physics: wrappedPhysics,
      format: MATCH_FORMATS.ONE_V_ONE,
      aiStyle: AI_STYLES.NET_BLOCKER,
      servingTeam: 2,
      rng: () => 0.5,
    });

    let stuffed = false;
    let crossed = false;
    let yAtNet = null;
    for (let i = 0; i < 600; i++) {
      const cur = engine.getSnapshot();
      const p1 = cur.players.find((p) => p.id === 'p1');
      const p2 = cur.players.find((p) => p.id === 'p2');
      let moveX = 0;
      let pPress = false;
      let pHeld = false;
      let sPress = false;
      let sHeld = false;

      if (!released) {
        if (cur.scoreboard.touchCount < 2) {
          moveX = Math.sign(cur.prediction.x - p1.pos.x);
          const d = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);
          if (cur.ball.pos.x < 0 && d < 1.4 && cur.ball.pos.y < 2.6) {
            pPress = true;
            pHeld = true;
          }
        } else {
          holdBall = true;
          moveX = Math.sign(startX - p1.pos.x);
          if (Math.abs(startX - p1.pos.x) < 0.35 && p1.strikeCooldown <= 0 && Math.abs(p2.pos.x) <= 1.5 && p2.blockTimer > 0.2) {
            sPress = true;
            sHeld = true;
          }
        }
      }

      const prevX = cur.ball.pos.x;
      const prevY = cur.ball.pos.y;
      const snap = engine.stepFixed(
        FIXED_DT,
        {
          p1: neutralCmd({
            isHuman: true,
            moveX,
            aimX: -0.8,
            aimZ: 0,
            primaryJustPressed: pPress,
            primaryHeld: pHeld,
            secondaryJustPressed: sPress,
            secondaryHeld: sHeld,
          }),
          p2: neutralCmd(),
        },
        cfg,
      );

      if (!released && snap.events.some((e) => e.type === EVENTS.POKEY_CUT)) {
        released = true;
      } else if (released) {
        if (snap.events.some((e) => e.type === EVENTS.STUFF_BLOCK)) {
          stuffed = true;
          break;
        }
        if (prevX < 0 && snap.ball.pos.x >= 0) {
          crossed = true;
          yAtNet = prevY + ((0 - prevX) / (snap.ball.pos.x - prevX)) * (snap.ball.pos.y - prevY);
          break;
        }
      }
    }

    assert.equal(released, true, `Expected POKEY_CUT release at (${startX}, ${startY}) wind=${windX}`);
    assert.equal(stuffed, false, `Expected low-contact POKEY_CUT at (${startX}, ${startY}) wind=${windX} not to be stuffed`);
    assert.equal(crossed, true, `Expected low-contact POKEY_CUT at (${startX}, ${startY}) wind=${windX} to cross net`);
    assert.ok(yAtNet > 3.35, `Expected POKEY_CUT yAtNet > 3.35m at (${startX}, ${startY}) wind=${windX}, got ${yAtNet}`);
  }
});

test('Iteration 3 polish: setFormat() resets hit-stop & accumulator, getSnapshot().events deep-clones nested Vec3, and inputManager ignores OS key-repeat after Quick-Bind slot 3', () => {
  // 1. setFormat() mid-hit-stop resets hitStopFrames = 0 & accumulator = 0
  let stepCount = 0;
  const countedPhysics = createDeterministicDiPhysics();
  const origStep = countedPhysics.stepBall3D;
  countedPhysics.stepBall3D = (...args) => {
    stepCount += 1;
    return origStep(...args);
  };
  const eng = createRallyEngine({ physics: countedPhysics, servingTeam: 2, rng: () => 0.5 });

  let triggeredHitStop = false;
  for (let frame = 0; frame < 360; frame++) {
    const cur = eng.getSnapshot();
    const p1 = cur.players.find((p) => p.id === 'p1');
    const tx = cur.timingRing.active && cur.timingRing.team === 1 ? cur.timingRing.pos.x : cur.prediction.x;
    const tz = cur.timingRing.active && cur.timingRing.team === 1 ? cur.timingRing.pos.z : cur.prediction.z;
    const dx = tx - p1.pos.x;
    const dz = tz - p1.pos.z;
    const dist = Math.hypot(dx, dz);
    const moveX = dist > 0.12 ? dx / dist : 0;
    const moveZ = dist > 0.12 ? dz / dist : 0;
    const horizDist = Math.hypot(cur.ball.pos.x - p1.pos.x, cur.ball.pos.z - p1.pos.z);

    let pPress = false;
    let pHeld = false;
    if (cur.ball.pos.x <= 0.05 && cur.scoreboard.touchCount === 0 && horizDist <= 1.45 && cur.ball.pos.y <= 2.3) {
      pPress = true;
      pHeld = true;
    } else if (cur.ball.pos.x <= 0.05 && cur.scoreboard.touchCount === 1 && horizDist <= 1.45 && cur.ball.pos.y <= 2.8 && cur.ball.vel.y <= 0.8) {
      pPress = true;
      pHeld = true;
    } else if (cur.scoreboard.touchCount === 2 && cur.timingRing.active && cur.timingRing.team === 1 && cur.timingRing.inSweetSpot) {
      pPress = true;
      pHeld = true;
    }

    const snap = eng.update(
      1 / 60,
      { p1: neutralCmd({ isHuman: true, moveX, moveZ, aimX: 1, primaryHeld: pHeld, primaryJustPressed: pPress }), p2: neutralCmd() },
      PHYSICS_DEFAULTS,
    );
    if (snap.hitStopFrames === 2) {
      triggeredHitStop = true;
      eng.setFormat(MATCH_FORMATS.TWO_V_TWO);
      assert.equal(eng.getSnapshot().hitStopFrames, 0, 'setFormat() mid-hit-stop must reset hitStopFrames to 0');
      const before = stepCount;
      eng.update(1 / 60, null, PHYSICS_DEFAULTS);
      assert.equal(stepCount - before, 2, 'New format serve must step immediately (2 substeps at 1/60s) without hit-stop freeze');
      break;
    }
  }
  assert.equal(triggeredHitStop, true, 'Expected Heat Spike hit-stop before setFormat()');

  // 2. getSnapshot().events deep-clones nested Vec3 objects (pos, windVec3, gustTargetVec3)
  const cloneEng = createRallyEngine({ physics: createDeterministicDiPhysics(), servingTeam: 2 });
  cloneEng.triggerGust(1);
  const s1 = cloneEng.getSnapshot();
  const serveEv1 = s1.events.find((e) => e.type === EVENTS.SERVE);
  const gustEv1 = s1.events.find((e) => e.type === EVENTS.GUST_WARNING);
  assert.ok(serveEv1 && serveEv1.pos);
  assert.ok(gustEv1 && gustEv1.windVec3 && gustEv1.gustTargetVec3);
  const origServeX = serveEv1.pos.x;
  const origWindX = gustEv1.windVec3.x;
  const origTargetX = gustEv1.gustTargetVec3.x;
  serveEv1.pos.x = 99999;
  gustEv1.windVec3.x = 88888;
  gustEv1.gustTargetVec3.x = 77777;

  const s2 = cloneEng.getSnapshot();
  assert.equal(s2.events.find((e) => e.type === EVENTS.SERVE).pos.x, origServeX);
  assert.equal(s2.events.find((e) => e.type === EVENTS.GUST_WARNING).windVec3.x, origWindX);
  assert.equal(s2.events.find((e) => e.type === EVENTS.GUST_WARNING).gustTargetVec3.x, origTargetX);

  // 3. InputManager ignores OS e.repeat = true after Quick-Bind slot-3 capture
  const win = createMockEventTarget();
  const mgr = createInputManager(null, { windowTarget: win, storage: createMockStorage(), getGamepads: () => [] });
  mgr.startQuickBind();
  win.dispatch('keydown', makeKeyEvent('KeyU'));
  win.dispatch('keydown', makeKeyEvent('KeyI'));
  win.dispatch('keydown', makeKeyEvent('KeyO'));
  win.dispatch('keydown', makeKeyEvent('KeyP')); // Completes slot 3 (p2Secondary)

  // Simulate OS key-repeat while user is still holding KeyP before keyup
  win.dispatch('keydown', makeKeyEvent('KeyP', { repeat: true }));
  const afterRepeat = mgr.pollInputs(1 / 60);
  assert.equal(afterRepeat.p2.secondaryHeld, false, 'OS key-repeat of Quick-Bind slot-3 key must not leak into keysDown');
  assert.equal(afterRepeat.p2.secondaryJustPressed, false);

  // After keyup + fresh keydown (repeat: false), KeyP works normally
  win.dispatch('keyup', makeKeyEvent('KeyP'));
  win.dispatch('keydown', makeKeyEvent('KeyP', { repeat: false }));
  const afterFresh = mgr.pollInputs(1 / 60);
  assert.equal(afterFresh.p2.secondaryHeld, true);
  assert.equal(afterFresh.p2.secondaryJustPressed, true);
  mgr.destroy();
});

test('RallyEngine (M5 BUG-1 regression): setFormat() during set-win POINT_PAUSE resets set score & winner without duplicate set award', () => {
  // Sub-case A: Team 2 wins Set 1 (2-0) in 1v1, toggle to 2v2 during POINT_PAUSE, then score 1 more point
  const engine = createRallyEngine({
    format: MATCH_FORMATS.ONE_V_ONE,
    aiStyle: AI_STYLES.WIND_LOBBER,
    winScore: 2,
    servingTeam: 2,
    rng: () => 0.5,
  });

  let setWinSnap = null;
  for (let i = 0; i < 1200; i++) {
    const snap = engine.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
    if (snap.scoreboard.winner !== null && snap.scoreboard.phase === 'POINT_PAUSE') {
      setWinSnap = snap;
      break;
    }
  }

  assert.ok(setWinSnap !== null, 'Expected engine to reach set-win POINT_PAUSE');
  assert.equal(setWinSnap.scoreboard.winner, 2);
  assert.equal(setWinSnap.scoreboard.setsP1 + setWinSnap.scoreboard.setsP2, 1);
  assert.equal(setWinSnap.scoreboard.setsP2, 1);

  // Switch format during POINT_PAUSE window
  engine.setFormat(MATCH_FORMATS.TWO_V_TWO);
  const afterSwitch = engine.getSnapshot();
  assert.equal(afterSwitch.scoreboard.scoreP1, 0, 'Completed set scoreP1 must reset to 0 on setFormat during set-win POINT_PAUSE');
  assert.equal(afterSwitch.scoreboard.scoreP2, 0, 'Completed set scoreP2 must reset to 0 on setFormat during set-win POINT_PAUSE');
  assert.equal(afterSwitch.scoreboard.winner, null, 'scoreboard.winner must clear to null on setFormat during set-win POINT_PAUSE');
  assert.equal(afterSwitch.scoreboard.setsP1, 0);
  assert.equal(afterSwitch.scoreboard.setsP2, 1, 'Completed set win counter must be preserved');
  assert.equal(afterSwitch.scoreboard.phase, 'RALLY');
  assert.equal(afterSwitch.players.length, 4);

  // Score 1 more point (same team scores or partner returns) — sets counter must NOT erroneously double-increment
  let nextPointSnap = null;
  for (let i = 0; i < 1200; i++) {
    const snap = engine.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
    if (snap.events.some((e) => e.type === EVENTS.POINT_SCORED)) {
      nextPointSnap = snap;
      break;
    }
  }
  assert.ok(nextPointSnap !== null, 'Expected a point to be scored after format switch');
  assert.equal(nextPointSnap.scoreboard.setsP1 + nextPointSnap.scoreboard.setsP2, 1, 'Single point in new set must not award duplicate set');
  assert.equal(nextPointSnap.scoreboard.winner, null, 'Winner must remain null after a single point (0-1 or 1-0)');
  assert.equal(nextPointSnap.scoreboard.scoreP1 + nextPointSnap.scoreboard.scoreP2, 1);

  // Sub-case B: Trailing team scores the very next point after Team 1 wins Set 1 in 2v2 -> toggle to 1v1
  const baseDi = createDeterministicDiPhysics();
  let forceSandSide = 1; // +X -> Team 1 wins point; -X -> Team 2 wins point
  const diPhysics = {
    ...baseDi,
    stepBall3D(ballState) {
      ballState.pos.x = forceSandSide * 4.0;
      ballState.pos.y = BALL_SPEC.RADIUS * 0.5;
      ballState.pos.z = 0;
      return { landed: true, wallHit: null, netHit: null, crossedNet: false, speed: 5 };
    },
  };
  const engB = createRallyEngine({
    physics: diPhysics,
    format: MATCH_FORMATS.TWO_V_TWO,
    winScore: 2,
    servingTeam: 1,
    rng: () => 0.5,
  });
  // Point 1 for Team 1
  engB.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
  // Expire POINT_PAUSE
  for (let i = 0; i < 200; i++) {
    if (engB.getSnapshot().scoreboard.phase === 'RALLY') break;
    engB.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
  }
  // Point 2 for Team 1 -> wins Set 1 (2-0), enters POINT_PAUSE with winner === 1
  const winB = engB.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
  assert.equal(winB.scoreboard.winner, 1);
  assert.equal(winB.scoreboard.setsP1, 1);
  assert.equal(winB.scoreboard.phase, 'POINT_PAUSE');

  // Switch 2v2 -> 1v1 during POINT_PAUSE
  engB.setFormat(MATCH_FORMATS.ONE_V_ONE);
  const afterB = engB.getSnapshot();
  assert.equal(afterB.scoreboard.scoreP1, 0);
  assert.equal(afterB.scoreboard.scoreP2, 0);
  assert.equal(afterB.scoreboard.winner, null);
  assert.equal(afterB.scoreboard.setsP1, 1);
  assert.equal(afterB.scoreboard.setsP2, 0);
  assert.equal(afterB.scoreboard.phase, 'RALLY');
  assert.equal(afterB.players.length, 2);

  // Trailing team (Team 2) scores the next point
  forceSandSide = -1;
  const trailingPoint = engB.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
  assert.equal(trailingPoint.scoreboard.scoreP1, 0);
  assert.equal(trailingPoint.scoreboard.scoreP2, 1);
  assert.equal(trailingPoint.scoreboard.setsP1, 1, 'Team 1 must NOT get duplicate set win when Team 2 scores');
  assert.equal(trailingPoint.scoreboard.setsP2, 0);
  assert.equal(trailingPoint.scoreboard.winner, null);
  assertAllFiniteSnapshot(trailingPoint);
});

test('RallyEngine (M5 BUG-2 regression): extended deuce sets award win to leading team (11-13, 12-14, 2-4, 13-11) and never end on 1-point lead', () => {
  function createPointDriver(winScore, initialFormat = MATCH_FORMATS.ONE_V_ONE) {
    const baseDi = createDeterministicDiPhysics();
    let forceSandSide = 1; // +X -> Team 1 wins point; -X -> Team 2 wins point
    const diPhysics = {
      ...baseDi,
      stepBall3D(ballState) {
        ballState.pos.x = forceSandSide * 4.0;
        ballState.pos.y = BALL_SPEC.RADIUS * 0.5;
        ballState.pos.z = 0;
        return { landed: true, wallHit: null, netHit: null, crossedNet: false, speed: 5 };
      },
    };
    const engine = createRallyEngine({
      physics: diPhysics,
      format: initialFormat,
      winScore,
      servingTeam: 1,
      rng: () => 0.5,
    });

    function expirePointPause() {
      for (let i = 0; i < 200; i++) {
        if (engine.getSnapshot().scoreboard.phase === 'RALLY') {
          return;
        }
        engine.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
      }
      assert.fail('Expected POINT_PAUSE to expire back to RALLY');
    }

    function scorePoint(team) {
      if (engine.getSnapshot().scoreboard.phase === 'POINT_PAUSE') {
        expirePointPause();
      }
      forceSandSide = team === 1 ? 1 : -1;
      const snap = engine.stepFixed(FIXED_DT, null, PHYSICS_DEFAULTS);
      assertAllFiniteSnapshot(snap);
      return snap;
    }

    return { engine, scorePoint, expirePointPause };
  }

  // Case 1: Team 2 wins extended deuce 11-13 (winScore: 11); also verify 11-12 does NOT end set
  {
    const { scorePoint } = createPointDriver(11);
    // Alternate to 11-11
    for (let i = 0; i < 11; i++) {
      scorePoint(1);
      scorePoint(2);
    }
    // 11-12: 1-point lead at deuce must NOT prematurely end the set
    const at11_12 = scorePoint(2);
    assert.equal(at11_12.scoreboard.scoreP1, 11);
    assert.equal(at11_12.scoreboard.scoreP2, 12);
    assert.equal(at11_12.scoreboard.winner, null, '11-12 (1-point lead) must not end the set');
    assert.equal(at11_12.scoreboard.setsP1, 0);
    assert.equal(at11_12.scoreboard.setsP2, 0);
    const ev11_12 = at11_12.events.find((e) => e.type === EVENTS.POINT_SCORED);
    assert.equal(ev11_12.matchOver, false);

    // 11-13: Team 2 wins extended deuce by 2
    const at11_13 = scorePoint(2);
    assert.equal(at11_13.scoreboard.scoreP1, 11);
    assert.equal(at11_13.scoreboard.scoreP2, 13);
    assert.equal(at11_13.scoreboard.winner, 2, 'Team 2 must win extended deuce 11-13');
    assert.equal(at11_13.scoreboard.setsP1, 0, 'Losing Team 1 must NOT be awarded a set on 11-13');
    assert.equal(at11_13.scoreboard.setsP2, 1);
    assert.equal(at11_13.scoreboard.bannerText, 'TEAM 2 WINS SET! (13-11)');
    const ev11_13 = at11_13.events.find((e) => e.type === EVENTS.POINT_SCORED);
    assert.equal(ev11_13.matchOver, true);
  }

  // Case 2A: Team 2 wins extended deuce 12-14 (winScore: 11) + setFormat('2v2') during POINT_PAUSE
  {
    const { engine, scorePoint } = createPointDriver(11, MATCH_FORMATS.ONE_V_ONE);
    for (let i = 0; i < 12; i++) {
      scorePoint(1);
      scorePoint(2);
    }
    const at12_13 = scorePoint(2);
    assert.equal(at12_13.scoreboard.winner, null);
    assert.equal(at12_13.scoreboard.setsP1, 0);
    assert.equal(at12_13.scoreboard.setsP2, 0);

    const at12_14 = scorePoint(2);
    assert.equal(at12_14.scoreboard.scoreP1, 12);
    assert.equal(at12_14.scoreboard.scoreP2, 14);
    assert.equal(at12_14.scoreboard.winner, 2);
    assert.equal(at12_14.scoreboard.setsP1, 0);
    assert.equal(at12_14.scoreboard.setsP2, 1);
    assert.equal(at12_14.scoreboard.bannerText, 'TEAM 2 WINS SET! (14-12)');
    assert.equal(at12_14.scoreboard.phase, 'POINT_PAUSE');

    engine.setFormat(MATCH_FORMATS.TWO_V_TWO);
    const afterSwitch = engine.getSnapshot();
    assert.equal(afterSwitch.scoreboard.scoreP1, 0);
    assert.equal(afterSwitch.scoreboard.scoreP2, 0);
    assert.equal(afterSwitch.scoreboard.winner, null);
    assert.equal(afterSwitch.scoreboard.setsP1, 0);
    assert.equal(afterSwitch.scoreboard.setsP2, 1);
    assert.equal(afterSwitch.scoreboard.phase, 'RALLY');
    assert.equal(afterSwitch.players.length, 4);
  }

  // Case 2B: Team 2 wins extended deuce 2-4 (winScore: 2) + setFormat('2v2') during POINT_PAUSE
  {
    const { engine, scorePoint } = createPointDriver(2, MATCH_FORMATS.ONE_V_ONE);
    scorePoint(1);
    scorePoint(2);
    scorePoint(1);
    scorePoint(2); // 2-2
    const at2_3 = scorePoint(2);
    assert.equal(at2_3.scoreboard.winner, null);
    assert.equal(at2_3.scoreboard.setsP1, 0);
    assert.equal(at2_3.scoreboard.setsP2, 0);

    const at2_4 = scorePoint(2);
    assert.equal(at2_4.scoreboard.scoreP1, 2);
    assert.equal(at2_4.scoreboard.scoreP2, 4);
    assert.equal(at2_4.scoreboard.winner, 2);
    assert.equal(at2_4.scoreboard.setsP1, 0);
    assert.equal(at2_4.scoreboard.setsP2, 1);
    assert.equal(at2_4.scoreboard.bannerText, 'TEAM 2 WINS SET! (4-2)');
    assert.equal(at2_4.scoreboard.phase, 'POINT_PAUSE');

    engine.setFormat(MATCH_FORMATS.TWO_V_TWO);
    const afterSwitch = engine.getSnapshot();
    assert.equal(afterSwitch.scoreboard.scoreP1, 0);
    assert.equal(afterSwitch.scoreboard.scoreP2, 0);
    assert.equal(afterSwitch.scoreboard.winner, null);
    assert.equal(afterSwitch.scoreboard.setsP1, 0);
    assert.equal(afterSwitch.scoreboard.setsP2, 1);
    assert.equal(afterSwitch.scoreboard.phase, 'RALLY');
    assert.equal(afterSwitch.players.length, 4);
  }

  // Case 3: Team 1 wins extended deuce 13-11 (winScore: 11)
  {
    const { scorePoint } = createPointDriver(11);
    for (let i = 0; i < 11; i++) {
      scorePoint(2);
      scorePoint(1);
    }
    const at12_11 = scorePoint(1);
    assert.equal(at12_11.scoreboard.scoreP1, 12);
    assert.equal(at12_11.scoreboard.scoreP2, 11);
    assert.equal(at12_11.scoreboard.winner, null, '12-11 (1-point lead) must not end the set');
    assert.equal(at12_11.scoreboard.setsP1, 0);
    assert.equal(at12_11.scoreboard.setsP2, 0);

    const at13_11 = scorePoint(1);
    assert.equal(at13_11.scoreboard.scoreP1, 13);
    assert.equal(at13_11.scoreboard.scoreP2, 11);
    assert.equal(at13_11.scoreboard.winner, 1);
    assert.equal(at13_11.scoreboard.setsP1, 1);
    assert.equal(at13_11.scoreboard.setsP2, 0);
    assert.equal(at13_11.scoreboard.bannerText, 'TEAM 1 WINS SET! (13-11)');
    const ev13_11 = at13_11.events.find((e) => e.type === EVENTS.POINT_SCORED);
    assert.equal(ev13_11.matchOver, true);
  }
});




