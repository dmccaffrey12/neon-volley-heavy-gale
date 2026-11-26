/**
 * SUMMER HEAT 3D — Multi-Modal Input Manager & 3-Second Quick-Bind Calibration
 *
 * Strictly acyclic dependency: imports ONLY ./contracts.js.
 * Headless-safe (zero top-level DOM/window assumptions) with DI options for Node tests.
 * Supports:
 *   - '1PAD'  (Stadia Single-Controller Split on pads[0] + keyboard + touch)
 *   - '2PAD'  (Dual Gamepad pads[0]/pads[1] + keyboard + touch)
 *   - 'TOUCH' (Auto-Footwork split-court multi-touch + mouse drag fallback + keyboard)
 *   - 3-second Quick-Bind calibration modal (4 slots, stale-held protection, localStorage)
 */

import {
  clamp,
  INPUT_MODES,
  STORAGE_KEYS,
  createDefaultBindings,
} from './contracts.js';

const VALID_MODES = new Set(Object.values(INPUT_MODES));

const PREVENT_DEFAULT_CODES = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  'NumpadEnter',
]);

const ANALOG_TRIGGER_THRESHOLD = 0.35;
const QUICK_BIND_SLOT_DURATION = 3.0;

const QUICK_BIND_SLOTS = Object.freeze([
  Object.freeze({ slotKey: 'p1Primary', label: 'P1 Primary', player: 1, action: 'primary' }),
  Object.freeze({ slotKey: 'p1Secondary', label: 'P1 Dive / Block / Pokey', player: 1, action: 'secondary' }),
  Object.freeze({ slotKey: 'p2Primary', label: 'P2 Primary', player: 2, action: 'primary' }),
  Object.freeze({ slotKey: 'p2Secondary', label: 'P2 Dive / Block / Pokey', player: 2, action: 'secondary' }),
]);

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function sanitizeIntIndex(val, fallback) {
  return Number.isInteger(val) && val >= 0 ? val : fallback;
}

function sanitizeButtonArray(arr, fallback) {
  if (!Array.isArray(arr)) {
    return [...fallback];
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const n = arr[i];
    if (Number.isInteger(n) && n >= 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.length > 0 ? out : [...fallback];
}

function sanitizeKeyCode(val, fallback) {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
}

function sanitizeKeyArray(arr, fallback) {
  if (!Array.isArray(arr)) {
    return [...fallback];
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] === 'string') {
      const trimmed = arr[i].trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
  }
  return out.length > 0 ? out : [...fallback];
}

function sanitizeQuickBindDescriptor(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (raw.type === 'key' && typeof raw.code === 'string') {
    const code = raw.code.trim();
    if (code.length > 0) {
      return { type: 'key', code };
    }
    return null;
  }
  if (raw.type === 'gamepad' && Number.isInteger(raw.buttonIndex) && raw.buttonIndex >= 0) {
    const padIndex = Number.isInteger(raw.padIndex) && raw.padIndex >= 0 ? raw.padIndex : 0;
    return { type: 'gamepad', padIndex, buttonIndex: raw.buttonIndex };
  }
  return null;
}

function sanitizePadConfig(raw, def, includeDpad) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {
    padIndex: sanitizeIntIndex(src.padIndex, def.padIndex),
    axisX: sanitizeIntIndex(src.axisX, def.axisX),
    axisY: sanitizeIntIndex(src.axisY, def.axisY),
  };
  if (includeDpad) {
    out.dpadLeft = sanitizeIntIndex(src.dpadLeft, def.dpadLeft);
    out.dpadRight = sanitizeIntIndex(src.dpadRight, def.dpadRight);
    out.dpadUp = sanitizeIntIndex(src.dpadUp, def.dpadUp);
    out.dpadDown = sanitizeIntIndex(src.dpadDown, def.dpadDown);
  }
  out.primaryButtons = sanitizeButtonArray(src.primaryButtons, def.primaryButtons);
  out.secondaryButtons = sanitizeButtonArray(src.secondaryButtons, def.secondaryButtons);
  return out;
}

function sanitizeKeyboardPlayer(raw, def) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    left: sanitizeKeyCode(src.left, def.left),
    right: sanitizeKeyCode(src.right, def.right),
    up: sanitizeKeyCode(src.up, def.up),
    down: sanitizeKeyCode(src.down, def.down),
    primary: sanitizeKeyArray(src.primary, def.primary),
    secondary: sanitizeKeyArray(src.secondary, def.secondary),
  };
}

function sanitizeBindings(raw) {
  const defaults = createDefaultBindings();
  if (!isPlainObject(raw)) {
    return defaults;
  }

  const onePadSrc = isPlainObject(raw.onePadSplit) ? raw.onePadSplit : {};
  const twoPadSrc = isPlainObject(raw.twoPad) ? raw.twoPad : {};
  const kbSrc = isPlainObject(raw.keyboard) ? raw.keyboard : {};
  const qbSrc = isPlainObject(raw.quickBindSlots) ? raw.quickBindSlots : {};

  return {
    deadzone: clamp(raw.deadzone, 0.02, 0.6, defaults.deadzone),
    onePadSplit: {
      p1: sanitizePadConfig(onePadSrc.p1, defaults.onePadSplit.p1, true),
      p2: sanitizePadConfig(onePadSrc.p2, defaults.onePadSplit.p2, false),
    },
    twoPad: {
      p1: sanitizePadConfig(twoPadSrc.p1, defaults.twoPad.p1, true),
      p2: sanitizePadConfig(twoPadSrc.p2, defaults.twoPad.p2, true),
    },
    keyboard: {
      p1: sanitizeKeyboardPlayer(kbSrc.p1, defaults.keyboard.p1),
      p2: sanitizeKeyboardPlayer(kbSrc.p2, defaults.keyboard.p2),
    },
    quickBindSlots: {
      p1Primary: sanitizeQuickBindDescriptor(qbSrc.p1Primary),
      p1Secondary: sanitizeQuickBindDescriptor(qbSrc.p1Secondary),
      p2Primary: sanitizeQuickBindDescriptor(qbSrc.p2Primary),
      p2Secondary: sanitizeQuickBindDescriptor(qbSrc.p2Secondary),
    },
  };
}

function deepCloneBindings(b) {
  return sanitizeBindings(b);
}

function getDefaultStorage() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

function loadBindingsFromStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function') {
    return createDefaultBindings();
  }
  try {
    const raw = storage.getItem(STORAGE_KEYS.BINDINGS);
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return createDefaultBindings();
    }
    const parsed = JSON.parse(raw);
    return sanitizeBindings(parsed);
  } catch {
    return createDefaultBindings();
  }
}

function saveBindingsToStorage(storage, bindings) {
  if (!storage || typeof storage.setItem !== 'function') {
    return;
  }
  try {
    storage.setItem(STORAGE_KEYS.BINDINGS, JSON.stringify(bindings));
  } catch {
    // Ignore storage quota or SecurityError in sandboxed contexts
  }
}

function defaultGetGamepads() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
      return navigator.getGamepads();
    }
  } catch {
    return [];
  }
  return [];
}

function readGamepadsSafe(getGamepadsFn) {
  try {
    const rawList = typeof getGamepadsFn === 'function' ? getGamepadsFn() : [];
    if (!rawList || typeof rawList !== 'object' || typeof rawList.length !== 'number') {
      return [];
    }
    const len =
      Number.isFinite(rawList.length) && rawList.length > 0
        ? Math.min(Math.floor(rawList.length), 32)
        : 0;
    const out = [];
    for (let i = 0; i < len; i++) {
      const pad = rawList[i];
      out.push(pad && typeof pad === 'object' && pad.connected !== false ? pad : null);
    }
    return out;
  } catch {
    return [];
  }
}

function isButtonPressed(pad, buttonIndex, suppressedSet = null) {
  if (suppressedSet && suppressedSet.has(buttonIndex)) {
    return false;
  }
  if (!pad || !pad.buttons || !Number.isInteger(buttonIndex) || buttonIndex < 0) {
    return false;
  }
  const btn = pad.buttons[buttonIndex];
  if (!btn || typeof btn !== 'object') {
    return false;
  }
  if (btn.pressed) {
    return true;
  }
  return (
    typeof btn.value === 'number' &&
    Number.isFinite(btn.value) &&
    btn.value > ANALOG_TRIGGER_THRESHOLD
  );
}

function isAnyButtonPressed(pad, indices, suppressedSet = null) {
  if (!pad || !Array.isArray(indices)) {
    return false;
  }
  for (let i = 0; i < indices.length; i++) {
    if (isButtonPressed(pad, indices[i], suppressedSet)) {
      return true;
    }
  }
  return false;
}

function applyDeadzone(val, dz) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    return 0;
  }
  if (Math.abs(val) < dz) {
    return 0;
  }
  return clamp(val, -1, 1, 0);
}

function normalizePair(x, z) {
  const fx = typeof x === 'number' && Number.isFinite(x) ? x : 0;
  const fz = typeof z === 'number' && Number.isFinite(z) ? z : 0;
  const len = Math.hypot(fx, fz);
  if (len < 1e-8) {
    return [0, 0];
  }
  if (len > 1) {
    return [fx / len, fz / len];
  }
  return [fx, fz];
}

function isFormTarget(target) {
  if (!target || typeof target !== 'object') {
    return false;
  }
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.isContentEditable);
}

function getCanvasMetrics(canvas) {
  if (canvas && typeof canvas.getBoundingClientRect === 'function') {
    try {
      const rect = canvas.getBoundingClientRect();
      if (
        rect &&
        Number.isFinite(rect.width) &&
        rect.width > 0 &&
        Number.isFinite(rect.height) &&
        rect.height > 0
      ) {
        return {
          left: Number.isFinite(rect.left) ? rect.left : 0,
          top: Number.isFinite(rect.top) ? rect.top : 0,
          width: rect.width,
          height: rect.height,
        };
      }
    } catch {
      // Fallback below
    }
  }
  const width = canvas && Number.isFinite(canvas.width) && canvas.width > 0 ? canvas.width : 844;
  const height = canvas && Number.isFinite(canvas.height) && canvas.height > 0 ? canvas.height : 390;
  return { left: 0, top: 0, width, height };
}

function createNeutralCommand(autoFootwork) {
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
    autoFootwork: Boolean(autoFootwork),
  };
}

function isQuickBindSlotActive(slotDescriptor, keysDown, pads, suppressedPadButtons = null) {
  if (!slotDescriptor) {
    return false;
  }
  if (slotDescriptor.type === 'key') {
    return keysDown.has(slotDescriptor.code);
  }
  if (slotDescriptor.type === 'gamepad') {
    const idx = slotDescriptor.padIndex;
    if (Number.isInteger(idx) && idx >= 0) {
      const suppressed = suppressedPadButtons ? suppressedPadButtons.get(idx) || null : null;
      return isButtonPressed(pads[idx], slotDescriptor.buttonIndex, suppressed);
    }
    for (let i = 0; i < pads.length; i++) {
      const suppressed = suppressedPadButtons ? suppressedPadButtons.get(i) || null : null;
      if (isButtonPressed(pads[i], slotDescriptor.buttonIndex, suppressed)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Create a multi-modal input manager for SUMMER HEAT 3D.
 *
 * @param {HTMLCanvasElement|null} [canvas=null]
 * @param {object} [options={}]
 * @param {string} [options.initialMode]
 * @param {Function} [options.getGamepads]
 * @param {Storage|null} [options.storage]
 * @param {EventTarget|null} [options.windowTarget]
 */
export function createInputManager(canvas = null, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const storage = 'storage' in opts ? opts.storage : getDefaultStorage();
  const getGamepadsFn = typeof opts.getGamepads === 'function' ? opts.getGamepads : defaultGetGamepads;
  const windowTarget =
    'windowTarget' in opts
      ? opts.windowTarget
      : typeof window !== 'undefined'
        ? window
        : null;

  const initialModeCandidate = opts.initialMode ?? opts.mode;
  let mode = VALID_MODES.has(initialModeCandidate)
    ? initialModeCandidate
    : INPUT_MODES.ONE_PAD_SPLIT;
  let bindings =
    'bindings' in opts && isPlainObject(opts.bindings)
      ? sanitizeBindings(opts.bindings)
      : loadBindingsFromStorage(storage);
  let destroyed = false;

  const keysDown = new Set();
  const activeTouches = new Map();
  const suppressedPadButtons = new Map();
  let touchSeq = 0;

  const prevState = {
    p1: { primaryHeld: false, secondaryHeld: false },
    p2: { primaryHeld: false, secondaryHeld: false },
  };

  const quickBind = {
    active: false,
    slotIndex: 0,
    remainingSec: QUICK_BIND_SLOT_DURATION,
    draftBindings: null,
    baselineKeys: new Set(),
    baselinePadButtons: new Map(),
    results: [],
    lastResult: null,
    onUpdate: null,
    onDone: null,
  };

  function cloneResults(results) {
    return results.map((r) => ({
      slotKey: r.slotKey,
      label: r.label,
      captured: r.captured ? { ...r.captured } : null,
      timedOut: Boolean(r.timedOut),
    }));
  }

  function buildQuickBindStatus() {
    const slot = quickBind.slotIndex < QUICK_BIND_SLOTS.length
      ? QUICK_BIND_SLOTS[quickBind.slotIndex]
      : null;
    const rem = clamp(quickBind.remainingSec, 0, QUICK_BIND_SLOT_DURATION, 0);
    return {
      active: quickBind.active,
      slotIndex: quickBind.slotIndex,
      totalSlots: QUICK_BIND_SLOTS.length,
      slotKey: slot ? slot.slotKey : null,
      label: slot ? slot.label : '',
      remainingSec: rem,
      durationSec: QUICK_BIND_SLOT_DURATION,
      progress: clamp(rem / QUICK_BIND_SLOT_DURATION, 0, 1, 0),
      lastResult: quickBind.lastResult
        ? {
            slotKey: quickBind.lastResult.slotKey,
            label: quickBind.lastResult.label,
            captured: quickBind.lastResult.captured ? { ...quickBind.lastResult.captured } : null,
            timedOut: Boolean(quickBind.lastResult.timedOut),
          }
        : null,
      results: cloneResults(quickBind.results),
    };
  }

  function emitQuickBindUpdate() {
    if (typeof quickBind.onUpdate === 'function') {
      quickBind.onUpdate(buildQuickBindStatus());
    }
  }

  function captureQuickBindBaseline(pads, extraKeyCode = null) {
    const nextBaselineKeys = new Set(quickBind.baselineKeys);
    for (const k of keysDown) {
      nextBaselineKeys.add(k);
    }
    if (typeof extraKeyCode === 'string' && extraKeyCode.length > 0) {
      nextBaselineKeys.add(extraKeyCode);
    }
    quickBind.baselineKeys = nextBaselineKeys;
    quickBind.baselinePadButtons = new Map();
    for (let padIdx = 0; padIdx < pads.length; padIdx++) {
      const pad = pads[padIdx];
      if (!pad || !pad.buttons) {
        continue;
      }
      const heldSet = new Set();
      for (let btnIdx = 0; btnIdx < pad.buttons.length; btnIdx++) {
        if (isButtonPressed(pad, btnIdx)) {
          heldSet.add(btnIdx);
        }
      }
      if (heldSet.size > 0) {
        quickBind.baselinePadButtons.set(padIdx, heldSet);
      }
    }
  }

  function captureSuppressedPadButtons(pads) {
    for (let padIdx = 0; padIdx < pads.length; padIdx++) {
      const pad = pads[padIdx];
      if (!pad || !pad.buttons) {
        continue;
      }
      let heldSet = suppressedPadButtons.get(padIdx);
      for (let btnIdx = 0; btnIdx < pad.buttons.length; btnIdx++) {
        if (isButtonPressed(pad, btnIdx)) {
          if (!heldSet) {
            heldSet = new Set();
            suppressedPadButtons.set(padIdx, heldSet);
          }
          heldSet.add(btnIdx);
        }
      }
    }
  }

  function pruneSuppressedPadButtons(pads) {
    if (suppressedPadButtons.size === 0) {
      return;
    }
    for (const [padIdx, btnSet] of suppressedPadButtons.entries()) {
      const pad = pads[padIdx];
      for (const btnIdx of Array.from(btnSet)) {
        if (!isButtonPressed(pad, btnIdx)) {
          btnSet.delete(btnIdx);
        }
      }
      if (btnSet.size === 0) {
        suppressedPadButtons.delete(padIdx);
      }
    }
  }

  function advanceQuickBindSlot(captured, timedOut, pads) {
    if (!quickBind.active || quickBind.slotIndex >= QUICK_BIND_SLOTS.length) {
      return;
    }
    const slot = QUICK_BIND_SLOTS[quickBind.slotIndex];
    if (captured !== null && quickBind.draftBindings) {
      quickBind.draftBindings.quickBindSlots[slot.slotKey] = sanitizeQuickBindDescriptor(captured);
    }

    const entry = {
      slotKey: slot.slotKey,
      label: slot.label,
      captured: captured ? { ...captured } : null,
      timedOut: Boolean(timedOut),
    };
    quickBind.lastResult = entry;
    quickBind.results.push(entry);
    quickBind.slotIndex += 1;

    if (quickBind.slotIndex >= QUICK_BIND_SLOTS.length) {
      const committed = setBindings(quickBind.draftBindings);
      const doneCb = quickBind.onDone;
      const finalResults = cloneResults(quickBind.results);
      captureSuppressedPadButtons(pads);
      activeTouches.clear();
      quickBind.active = false;
      quickBind.remainingSec = 0;
      quickBind.draftBindings = null;
      quickBind.baselineKeys.clear();
      quickBind.baselinePadButtons.clear();
      emitQuickBindUpdate();
      quickBind.onUpdate = null;
      quickBind.onDone = null;
      if (typeof doneCb === 'function') {
        doneCb({
          completed: true,
          cancelled: false,
          bindings: committed,
          results: finalResults,
        });
      }
      return;
    }

    quickBind.remainingSec = QUICK_BIND_SLOT_DURATION;
    captureQuickBindBaseline(pads, captured && captured.type === 'key' ? captured.code : null);
    emitQuickBindUpdate();
  }

  function stepQuickBind(dt, pads) {
    // 1. Release-prune baseline gamepad buttons that are no longer held
    for (const [padIdx, btnSet] of quickBind.baselinePadButtons.entries()) {
      const pad = pads[padIdx];
      for (const btnIdx of Array.from(btnSet)) {
        if (!isButtonPressed(pad, btnIdx)) {
          btnSet.delete(btnIdx);
        }
      }
      if (btnSet.size === 0) {
        quickBind.baselinePadButtons.delete(padIdx);
      }
    }

    // 2. Scan for any newly pressed gamepad button not in baseline
    for (let padIdx = 0; padIdx < pads.length; padIdx++) {
      const pad = pads[padIdx];
      if (!pad || !pad.buttons) {
        continue;
      }
      const baselineSet = quickBind.baselinePadButtons.get(padIdx);
      for (let btnIdx = 0; btnIdx < pad.buttons.length; btnIdx++) {
        if (isButtonPressed(pad, btnIdx) && (!baselineSet || !baselineSet.has(btnIdx))) {
          advanceQuickBindSlot({ type: 'gamepad', padIndex: padIdx, buttonIndex: btnIdx }, false, pads);
          return;
        }
      }
    }

    // 3. Advance countdown deterministically via dt
    const safeDt = clamp(dt, 0, 1.0, 0);
    quickBind.remainingSec = Math.max(0, quickBind.remainingSec - safeDt);
    if (quickBind.remainingSec <= 1e-9) {
      advanceQuickBindSlot(null, true, pads);
    } else {
      emitQuickBindUpdate();
    }
  }

  function startQuickBind(onUpdate, onDone) {
    if (destroyed) {
      return;
    }
    const pads = readGamepadsSafe(getGamepadsFn);
    activeTouches.clear();
    suppressedPadButtons.clear();
    quickBind.active = true;
    quickBind.slotIndex = 0;
    quickBind.remainingSec = QUICK_BIND_SLOT_DURATION;
    quickBind.draftBindings = deepCloneBindings(bindings);
    quickBind.results = [];
    quickBind.lastResult = null;
    quickBind.onUpdate = typeof onUpdate === 'function' ? onUpdate : null;
    quickBind.onDone = typeof onDone === 'function' ? onDone : null;
    prevState.p1.primaryHeld = false;
    prevState.p1.secondaryHeld = false;
    prevState.p2.primaryHeld = false;
    prevState.p2.secondaryHeld = false;
    quickBind.baselineKeys.clear();
    captureQuickBindBaseline(pads);
    emitQuickBindUpdate();
  }

  function cancelQuickBind() {
    if (!quickBind.active) {
      return;
    }
    const doneCb = quickBind.onDone;
    const partialResults = cloneResults(quickBind.results);
    captureSuppressedPadButtons(readGamepadsSafe(getGamepadsFn));
    activeTouches.clear();
    quickBind.active = false;
    quickBind.draftBindings = null;
    quickBind.baselineKeys.clear();
    quickBind.baselinePadButtons.clear();
    emitQuickBindUpdate();
    quickBind.onUpdate = null;
    quickBind.onDone = null;
    if (typeof doneCb === 'function') {
      doneCb({
        completed: false,
        cancelled: true,
        bindings: getBindings(),
        results: partialResults,
      });
    }
  }

  // ---- Event Listeners ----

  function onKeyDown(e) {
    if (destroyed || !e) {
      return;
    }
    const code = typeof e.code === 'string' ? e.code : '';
    if (quickBind.active) {
      if (typeof e.preventDefault === 'function') {
        e.preventDefault();
      }
      if (code === 'Escape') {
        cancelQuickBind();
        return;
      }
      if (e.repeat || !code || quickBind.baselineKeys.has(code)) {
        return;
      }
      advanceQuickBindSlot({ type: 'key', code }, false, readGamepadsSafe(getGamepadsFn));
      return;
    }

    if (isFormTarget(e.target)) {
      return;
    }

    if (PREVENT_DEFAULT_CODES.has(code) && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    if (e.repeat) {
      return;
    }
    if (code) {
      keysDown.add(code);
    }
  }

  function onKeyUp(e) {
    if (destroyed || !e) {
      return;
    }
    const code = typeof e.code === 'string' ? e.code : '';
    if (code) {
      keysDown.delete(code);
      quickBind.baselineKeys.delete(code);
    }
  }

  function onBlur() {
    keysDown.clear();
    activeTouches.clear();
    quickBind.baselineKeys.clear();
  }

  function registerPointerStart(id, clientX, clientY) {
    const metrics = getCanvasMetrics(canvas);
    const localX = (Number.isFinite(clientX) ? clientX : 0) - metrics.left;
    const localY = (Number.isFinite(clientY) ? clientY : 0) - metrics.top;
    const side = localX < metrics.width * 0.5 ? 1 : 2;
    touchSeq += 1;
    activeTouches.set(id, {
      id,
      side,
      startX: localX,
      startY: localY,
      curX: localX,
      curY: localY,
      seq: touchSeq,
    });
  }

  function updatePointerMove(id, clientX, clientY) {
    const entry = activeTouches.get(id);
    if (!entry) {
      return;
    }
    const metrics = getCanvasMetrics(canvas);
    entry.curX = (Number.isFinite(clientX) ? clientX : 0) - metrics.left;
    entry.curY = (Number.isFinite(clientY) ? clientY : 0) - metrics.top;
  }

  function onTouchStart(e) {
    if (destroyed || !e || quickBind.active) {
      return;
    }
    if (typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    const list = e.changedTouches || [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t !== null && t !== undefined) {
        registerPointerStart(t.identifier, t.clientX, t.clientY);
      }
    }
  }

  function onTouchMove(e) {
    if (destroyed || !e) {
      return;
    }
    if (typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    const list = e.changedTouches || [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t !== null && t !== undefined) {
        updatePointerMove(t.identifier, t.clientX, t.clientY);
      }
    }
  }

  function onTouchEnd(e) {
    if (destroyed || !e) {
      return;
    }
    if (typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    const list = e.changedTouches || [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t !== null && t !== undefined) {
        activeTouches.delete(t.identifier);
      }
    }
  }

  function onTouchCancel(e) {
    onTouchEnd(e);
  }

  function onMouseDown(e) {
    if (destroyed || !e || quickBind.active) {
      return;
    }
    if (typeof e.button === 'number' && e.button !== 0) {
      return;
    }
    registerPointerStart('mouse', e.clientX, e.clientY);
  }

  function onMouseMove(e) {
    if (destroyed || !e || !activeTouches.has('mouse')) {
      return;
    }
    updatePointerMove('mouse', e.clientX, e.clientY);
  }

  function onMouseUp() {
    if (destroyed) {
      return;
    }
    activeTouches.delete('mouse');
  }

  // Attach listeners safely if targets exist
  if (windowTarget && typeof windowTarget.addEventListener === 'function') {
    windowTarget.addEventListener('keydown', onKeyDown);
    windowTarget.addEventListener('keyup', onKeyUp);
    windowTarget.addEventListener('blur', onBlur);
    windowTarget.addEventListener('mousemove', onMouseMove);
    windowTarget.addEventListener('mouseup', onMouseUp);
  }

  if (canvas && typeof canvas.addEventListener === 'function') {
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchCancel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
  }

  // ---- Polling Helpers ----

  function buildPlayerCommand(playerKey, pads, metrics, dragRadius) {
    const side = playerKey === 'p1' ? 1 : 2;
    const autoFootwork = mode === INPUT_MODES.TOUCH_AUTO;
    const kb = bindings.keyboard[playerKey];
    const dz = bindings.deadzone;

    let moveX = 0;
    let moveZ = 0;
    let aimX = 0;
    let aimZ = 0;
    let primaryHeld = false;
    let secondaryHeld = false;
    let isHuman = false;

    // 1. Keyboard (active across ALL 3 modes)
    const kx = (keysDown.has(kb.right) ? 1 : 0) - (keysDown.has(kb.left) ? 1 : 0);
    const kz = (keysDown.has(kb.down) ? 1 : 0) - (keysDown.has(kb.up) ? 1 : 0);
    let kPrimary = false;
    for (let i = 0; i < kb.primary.length; i++) {
      if (keysDown.has(kb.primary[i])) {
        kPrimary = true;
        break;
      }
    }
    let kSecondary = false;
    for (let i = 0; i < kb.secondary.length; i++) {
      if (keysDown.has(kb.secondary[i])) {
        kSecondary = true;
        break;
      }
    }

    if (kx !== 0 || kz !== 0 || kPrimary || kSecondary) {
      moveX = kx;
      moveZ = kz;
      aimX = kx;
      aimZ = kz;
      if (kPrimary) primaryHeld = true;
      if (kSecondary) secondaryHeld = true;
      isHuman = true;
    }

    // 2. Gamepad (1PAD or 2PAD)
    if (mode === INPUT_MODES.ONE_PAD_SPLIT || mode === INPUT_MODES.TWO_PAD_KEYBOARD) {
      const padCfg =
        mode === INPUT_MODES.ONE_PAD_SPLIT
          ? bindings.onePadSplit[playerKey]
          : bindings.twoPad[playerKey];
      const pad = pads[padCfg.padIndex] || null;
      if (pad) {
        const suppressedSet = suppressedPadButtons.get(padCfg.padIndex) || null;
        const axes = pad.axes || [];
        let gx = applyDeadzone(axes[padCfg.axisX], dz);
        let gz = applyDeadzone(axes[padCfg.axisY], dz);

        if (typeof padCfg.dpadLeft === 'number') {
          const dpadX =
            (isButtonPressed(pad, padCfg.dpadRight, suppressedSet) ? 1 : 0) -
            (isButtonPressed(pad, padCfg.dpadLeft, suppressedSet) ? 1 : 0);
          const dpadZ =
            (isButtonPressed(pad, padCfg.dpadDown, suppressedSet) ? 1 : 0) -
            (isButtonPressed(pad, padCfg.dpadUp, suppressedSet) ? 1 : 0);
          if (dpadX !== 0) gx = dpadX;
          if (dpadZ !== 0) gz = dpadZ;
        }

        const gPrimary = isAnyButtonPressed(pad, padCfg.primaryButtons, suppressedSet);
        const gSecondary = isAnyButtonPressed(pad, padCfg.secondaryButtons, suppressedSet);

        if (gx !== 0 || gz !== 0 || gPrimary || gSecondary) {
          if (gx !== 0 || gz !== 0) {
            moveX = gx;
            moveZ = gz;
            aimX = gx;
            aimZ = gz;
          }
          if (gPrimary) primaryHeld = true;
          if (gSecondary) secondaryHeld = true;
          isHuman = true;
        }
      }
    }

    // 3. Quick-Bind custom slots (active across ALL 3 modes)
    const primarySlot = bindings.quickBindSlots[playerKey === 'p1' ? 'p1Primary' : 'p2Primary'];
    const secondarySlot = bindings.quickBindSlots[playerKey === 'p1' ? 'p1Secondary' : 'p2Secondary'];
    if (isQuickBindSlotActive(primarySlot, keysDown, pads, suppressedPadButtons)) {
      primaryHeld = true;
      isHuman = true;
    }
    if (isQuickBindSlotActive(secondarySlot, keysDown, pads, suppressedPadButtons)) {
      secondaryHeld = true;
      isHuman = true;
    }

    // 4. Touch / Mouse drag entries on this court half
    let sideTouches = null;
    if (activeTouches.size > 0) {
      for (const entry of activeTouches.values()) {
        if (entry.side === side) {
          if (!sideTouches) sideTouches = [];
          sideTouches.push(entry);
        }
      }
    }

    if (sideTouches && sideTouches.length > 0) {
      sideTouches.sort((a, b) => a.seq - b.seq);
      const first = sideTouches[0];
      const tAimX = clamp((first.curX - first.startX) / dragRadius, -1, 1, 0);
      const tAimZ = clamp((first.curY - first.startY) / dragRadius, -1, 1, 0);
      aimX = tAimX;
      aimZ = tAimZ;
      primaryHeld = true;
      isHuman = true;
      if (sideTouches.length >= 2) {
        secondaryHeld = true;
      }
    }

    // 5. Diagonal vector normalization & finite guards
    const [normMoveX, normMoveZ] = normalizePair(moveX, moveZ);
    const [normAimX, normAimZ] = normalizePair(aimX, aimZ);

    // 6. Edge detection
    const prev = prevState[playerKey];
    const primaryJustPressed = primaryHeld && !prev.primaryHeld;
    const primaryJustReleased = !primaryHeld && prev.primaryHeld;
    const secondaryJustPressed = secondaryHeld && !prev.secondaryHeld;
    const secondaryJustReleased = !secondaryHeld && prev.secondaryHeld;
    prev.primaryHeld = primaryHeld;
    prev.secondaryHeld = secondaryHeld;

    return {
      moveX: normMoveX,
      moveZ: normMoveZ,
      aimX: normAimX,
      aimZ: normAimZ,
      primaryHeld,
      primaryJustPressed,
      primaryJustReleased,
      secondaryHeld,
      secondaryJustPressed,
      secondaryJustReleased,
      isHuman,
      autoFootwork,
    };
  }

  function pollInputs(dt = 0) {
    const pads = readGamepadsSafe(getGamepadsFn);
    let padsConnected = 0;
    for (let i = 0; i < pads.length; i++) {
      if (pads[i]) {
        padsConnected += 1;
      }
    }

    if (quickBind.active) {
      stepQuickBind(dt, pads);
      const autoFootwork = mode === INPUT_MODES.TOUCH_AUTO;
      prevState.p1.primaryHeld = false;
      prevState.p1.secondaryHeld = false;
      prevState.p2.primaryHeld = false;
      prevState.p2.secondaryHeld = false;
      return {
        mode,
        padsConnected,
        p1: createNeutralCommand(autoFootwork),
        p2: createNeutralCommand(autoFootwork),
      };
    }

    pruneSuppressedPadButtons(pads);

    const metrics = getCanvasMetrics(canvas);
    const dragRadius = Math.max(28, Math.min(metrics.width, metrics.height) * 0.092);

    return {
      mode,
      padsConnected,
      p1: buildPlayerCommand('p1', pads, metrics, dragRadius),
      p2: buildPlayerCommand('p2', pads, metrics, dragRadius),
    };
  }

  function setMode(nextMode) {
    if (VALID_MODES.has(nextMode)) {
      mode = nextMode;
    }
    return mode;
  }

  function getMode() {
    return mode;
  }

  function getBindings() {
    return deepCloneBindings(bindings);
  }

  function setBindings(nextBindings) {
    bindings = sanitizeBindings(nextBindings);
    saveBindingsToStorage(storage, bindings);
    return deepCloneBindings(bindings);
  }

  function resetBindings() {
    bindings = createDefaultBindings();
    saveBindingsToStorage(storage, bindings);
    return deepCloneBindings(bindings);
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;

    if (quickBind.active) {
      cancelQuickBind();
    }

    keysDown.clear();
    activeTouches.clear();
    suppressedPadButtons.clear();

    if (windowTarget && typeof windowTarget.removeEventListener === 'function') {
      windowTarget.removeEventListener('keydown', onKeyDown);
      windowTarget.removeEventListener('keyup', onKeyUp);
      windowTarget.removeEventListener('blur', onBlur);
      windowTarget.removeEventListener('mousemove', onMouseMove);
      windowTarget.removeEventListener('mouseup', onMouseUp);
    }

    if (canvas && typeof canvas.removeEventListener === 'function') {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchCancel);
      canvas.removeEventListener('mousedown', onMouseDown);
    }
  }

  return {
    setMode,
    getMode,
    pollInputs,
    getBindings,
    setBindings,
    resetBindings,
    startQuickBind,
    cancelQuickBind,
    destroy,
  };
}
