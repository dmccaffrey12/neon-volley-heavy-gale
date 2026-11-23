/**
 * Minimal browser-API boundary shims & read-only snapshot normalizers for
 * SUMMER HEAT 3D Opaque-Box E2E Tests (Tiers 1-3).
 *
 * Strictly zero mocks of game/physics/rig/Three.js modules.
 * Only stubs thin browser-environment globals (`window`, `document`, `canvas`,
 * `localStorage`, `navigator.getGamepads`, `AudioContext`) when running
 * `inputManager.js` or `audioSynth.js` in Node 22.
 */

import assert from 'node:assert/strict';

/**
 * Safely define a property on a target object and return its original descriptor
 * so `restore()` can put globalThis back into its exact prior state (handling
 * Node 22 getter-only properties like `globalThis.navigator`).
 */
function overrideGlobal(key, descriptor) {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, key);
  const prevDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(globalThis, key) : undefined;
  Object.defineProperty(globalThis, key, {
    configurable: true,
    ...descriptor,
  });
  return () => {
    if (hadOwn && prevDescriptor) {
      Object.defineProperty(globalThis, key, prevDescriptor);
    } else {
      delete globalThis[key];
    }
  };
}

/**
 * Create an in-memory Storage implementation (or a throwing one for error tests).
 */
export function createMemoryStorage(initial = {}, { throwOnRead = false, throwOnWrite = false } = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [String(k), String(v)]));

  return {
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(k) {
      if (throwOnRead) {
        const err = new Error('SecurityError: storage read blocked');
        err.name = 'SecurityError';
        throw err;
      }
      const key = String(k);
      return store.has(key) ? store.get(key) : null;
    },
    setItem(k, v) {
      if (throwOnWrite) {
        const err = new Error('QuotaExceededError: storage write blocked');
        err.name = 'QuotaExceededError';
        throw err;
      }
      store.set(String(k), String(v));
    },
    removeItem(k) {
      if (throwOnWrite) {
        const err = new Error('SecurityError: storage remove blocked');
        err.name = 'SecurityError';
        throw err;
      }
      store.delete(String(k));
    },
    clear() {
      if (throwOnWrite) {
        const err = new Error('SecurityError: storage clear blocked');
        err.name = 'SecurityError';
        throw err;
      }
      store.clear();
    },
    _dump() {
      return Object.fromEntries(store.entries());
    },
  };
}

/**
 * Build a synthetic standard-mapping Stadia gamepad snapshot.
 */
export function createMockGamepad({
  index = 0,
  id = 'Stadia Controller rev. A (STANDARD GAMEPAD)',
  connected = true,
  axes = [0, 0, 0, 0],
  pressedButtons = [],
  buttonValues = {},
} = {}) {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const val =
      typeof buttonValues[i] === 'number'
        ? buttonValues[i]
        : pressedButtons.includes(i)
          ? 1
          : 0;
    return {
      pressed: val > 0.5 || pressedButtons.includes(i),
      touched: val > 0,
      value: val,
    };
  });
  return {
    id,
    index,
    connected,
    mapping: 'standard',
    timestamp: Date.now(),
    axes: axes.slice(),
    buttons,
  };
}

/**
 * Install minimal EventTarget-based DOM/Gamepad/localStorage shims for `inputManager.js`.
 */
export function installInputShims({
  storage = null,
  gamepads = [],
  rect = { left: 0, top: 0, width: 1280, height: 720 },
  omitGetGamepads = false,
} = {}) {
  const restores = [];

  const localStorageObj = storage || createMemoryStorage();
  let currentGamepads = Array.isArray(gamepads) ? gamepads : [];

  class ShimEventTarget extends EventTarget {
    constructor() {
      super();
      this._listenerCount = 0;
      this._listeners = new Map();
    }

    addEventListener(type, listener, options) {
      this._listenerCount += 1;
      if (!this._listeners.has(type)) {
        this._listeners.set(type, new Set());
      }
      this._listeners.get(type).add(listener);
      super.addEventListener(type, listener, options);
    }

    removeEventListener(type, listener, options) {
      if (this._listeners.has(type) && this._listeners.get(type).delete(listener)) {
        this._listenerCount = Math.max(0, this._listenerCount - 1);
      }
      super.removeEventListener(type, listener, options);
    }
  }

  const win = new ShimEventTarget();
  const doc = new ShimEventTarget();
  const canvas = new ShimEventTarget();

  const rectObj = {
    left: rect.left ?? 0,
    top: rect.top ?? 0,
    width: rect.width ?? 1280,
    height: rect.height ?? 720,
    right: (rect.left ?? 0) + (rect.width ?? 1280),
    bottom: (rect.top ?? 0) + (rect.height ?? 720),
    x: rect.left ?? 0,
    y: rect.top ?? 0,
  };

  canvas.width = rectObj.width;
  canvas.height = rectObj.height;
  canvas.clientWidth = rectObj.width;
  canvas.clientHeight = rectObj.height;
  canvas.style = {};
  canvas.getBoundingClientRect = () => ({ ...rectObj });
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  canvas.focus = () => {};
  canvas.contains = (el) => el === canvas;

  const nav = omitGetGamepads
    ? {}
    : {
        getGamepads() {
          return currentGamepads;
        },
      };

  win.innerWidth = rectObj.width;
  win.innerHeight = rectObj.height;
  win.devicePixelRatio = 1;
  win.localStorage = localStorageObj;
  win.navigator = nav;
  win.document = doc;
  win.performance = globalThis.performance;
  if ('AudioContext' in globalThis) {
    win.AudioContext = globalThis.AudioContext;
  }
  if ('webkitAudioContext' in globalThis) {
    win.webkitAudioContext = globalThis.webkitAudioContext;
  }

  doc.activeElement = canvas;
  doc.body = canvas;
  doc.documentElement = {
    clientWidth: rectObj.width,
    clientHeight: rectObj.height,
  };

  restores.push(overrideGlobal('window', { value: win, writable: true }));
  restores.push(overrideGlobal('document', { value: doc, writable: true }));
  restores.push(overrideGlobal('localStorage', { value: localStorageObj, writable: true }));
  restores.push(overrideGlobal('navigator', { value: nav, writable: true }));

  function setGamepads(nextPads) {
    currentGamepads = nextPads;
  }

  function makeSyntheticEvent(type, props = {}) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries(props)) {
      Object.defineProperty(ev, k, {
        value: v,
        enumerable: true,
        configurable: true,
      });
    }
    return ev;
  }

  function dispatchKey(type, code, extra = {}) {
    const key =
      extra.key ??
      (code === 'Space'
        ? ' '
        : code.startsWith('Key')
          ? code.slice(3).toLowerCase()
          : code);
    const props = {
      code,
      key,
      repeat: Boolean(extra.repeat),
      ctrlKey: Boolean(extra.ctrlKey),
      shiftKey: Boolean(extra.shiftKey),
      altKey: Boolean(extra.altKey),
      metaKey: Boolean(extra.metaKey),
      target: extra.target || canvas,
      ...extra,
    };
    win.dispatchEvent(makeSyntheticEvent(type, props));
    if (doc._listeners.has(type) && doc._listeners.get(type).size > 0 && !win._listeners.get(type)?.size) {
      doc.dispatchEvent(makeSyntheticEvent(type, props));
    }
  }

  function dispatchPointer(type, {
    clientX = rectObj.width * 0.5,
    clientY = rectObj.height * 0.5,
    pointerId = 1,
    pointerType = 'touch',
    button = 0,
    buttons = type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
  } = {}) {
    const props = {
      clientX,
      clientY,
      pageX: clientX,
      pageY: clientY,
      pointerId,
      pointerType,
      button,
      buttons,
      isPrimary: true,
      target: canvas,
    };
    canvas.dispatchEvent(makeSyntheticEvent(type, props));
    if (type === 'pointermove' || type === 'pointerup' || type === 'pointercancel') {
      // Also dispatch on window only if canvas had no listener for this type, or if window listens for release/move.
      if (win._listeners.has(type) && win._listeners.get(type).size > 0) {
        win.dispatchEvent(makeSyntheticEvent(type, props));
      }
    }

    // Mirror to TouchEvent if the implementation subscribes to touch* instead of pointer*.
    const touchMap = {
      pointerdown: 'touchstart',
      pointermove: 'touchmove',
      pointerup: 'touchend',
      pointercancel: 'touchcancel',
    };
    const touchType = touchMap[type];
    if (touchType && (canvas._listeners.get(touchType)?.size || win._listeners.get(touchType)?.size)) {
      const touchPoint = { identifier: pointerId, clientX, clientY, pageX: clientX, pageY: clientY, target: canvas };
      const touches = type === 'pointerup' || type === 'pointercancel' ? [] : [touchPoint];
      const touchProps = {
        touches,
        targetTouches: touches,
        changedTouches: [touchPoint],
        target: canvas,
      };
      if (canvas._listeners.get(touchType)?.size) {
        canvas.dispatchEvent(makeSyntheticEvent(touchType, touchProps));
      }
      if (win._listeners.get(touchType)?.size) {
        win.dispatchEvent(makeSyntheticEvent(touchType, touchProps));
      }
    }
  }

  function restore() {
    for (let i = restores.length - 1; i >= 0; i--) {
      restores[i]();
    }
  }

  return {
    window: win,
    document: doc,
    canvas,
    localStorage: localStorageObj,
    setGamepads,
    dispatchKey,
    dispatchPointer,
    restore,
  };
}

/**
 * Create a lightweight AudioParam spy verifying all scheduled values are finite.
 */
function createAudioParamSpy(initialValue = 0, tracker = null) {
  let current = initialValue;
  const record = (method, val, time) => {
    if (tracker) {
      tracker.paramCalls.push({ method, val, time });
    }
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      tracker?.nonFiniteParams.push({ method, val, time });
    }
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      tracker?.nonFiniteParams.push({ method: `${method}.time`, val, time });
    }
  };

  return {
    get value() {
      return current;
    },
    set value(v) {
      record('set.value', v, 0);
      current = v;
    },
    setValueAtTime(val, time = 0) {
      record('setValueAtTime', val, time);
      current = val;
      return this;
    },
    linearRampToValueAtTime(val, time = 0) {
      record('linearRampToValueAtTime', val, time);
      current = val;
      return this;
    },
    exponentialRampToValueAtTime(val, time = 0) {
      record('exponentialRampToValueAtTime', val, time);
      if (typeof val === 'number' && Number.isFinite(val) && val <= 0) {
        tracker?.nonFiniteParams.push({ method: 'exponentialRampToValueAtTime.nonPositive', val, time });
      }
      current = val;
      return this;
    },
    setTargetAtTime(target, startTime = 0, timeConstant = 0.01) {
      record('setTargetAtTime', target, startTime);
      if (typeof timeConstant !== 'number' || !Number.isFinite(timeConstant) || timeConstant < 0) {
        tracker?.nonFiniteParams.push({ method: 'setTargetAtTime.tc', val: timeConstant, time: startTime });
      }
      current = target;
      return this;
    },
    setValueCurveAtTime(values, startTime = 0, duration = 0.1) {
      record('setValueCurveAtTime', duration, startTime);
      if (typeof duration === 'number' && Number.isFinite(duration) && duration <= 0) {
        tracker?.nonFiniteParams.push({ method: 'setValueCurveAtTime.duration', val: duration, time: startTime });
      }
      if (!values || typeof values.length !== 'number') {
        tracker?.nonFiniteParams.push({ method: 'setValueCurveAtTime.values', val: values, time: startTime });
      } else {
        for (let i = 0; i < values.length; i++) {
          const v = values[i];
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            tracker?.nonFiniteParams.push({ method: `setValueCurveAtTime.values[${i}]`, val: v, time: startTime });
            break;
          }
        }
      }
      return this;
    },
    cancelScheduledValues(time = 0) {
      record('cancelScheduledValues', 0, time);
      return this;
    },
  };
}

/**
 * Install an AudioContext / webkitAudioContext spy on globalThis (and window if present).
 */
export function installAudioContextSpy({ rejectResume = false, unavailable = false, initialState = 'suspended' } = {}) {
  const spy = {
    constructorCallCount: 0,
    resumeCalls: 0,
    suspendCalls: 0,
    closeCalls: 0,
    createdNodes: [],
    paramCalls: [],
    nonFiniteParams: [],
    state: initialState,
    instances: [],
  };

  class SpyAudioNode {
    constructor(kind) {
      this.kind = kind;
      this.connectedTo = [];
      this.disconnected = false;
      spy.createdNodes.push(kind);
    }

    connect(dest) {
      this.connectedTo.push(dest);
      return dest;
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  class SpyAudioContext {
    constructor() {
      spy.constructorCallCount += 1;
      this.sampleRate = 44100;
      this.currentTime = 0.05;
      this.state = initialState;
      this.destination = new SpyAudioNode('destination');
      spy.state = this.state;
      spy.instances.push(this);
    }

    createOscillator() {
      const node = new SpyAudioNode('oscillator');
      node.type = 'sine';
      node.frequency = createAudioParamSpy(440, spy);
      node.detune = createAudioParamSpy(0, spy);
      node.started = false;
      node.stopped = false;
      node.onended = null;
      node.start = () => {
        node.started = true;
      };
      node.stop = () => {
        node.stopped = true;
      };
      return node;
    }

    createGain() {
      const node = new SpyAudioNode('gain');
      node.gain = createAudioParamSpy(1, spy);
      return node;
    }

    createBiquadFilter() {
      const node = new SpyAudioNode('biquadFilter');
      node.type = 'lowpass';
      node.frequency = createAudioParamSpy(350, spy);
      node.Q = createAudioParamSpy(1, spy);
      node.gain = createAudioParamSpy(0, spy);
      node.detune = createAudioParamSpy(0, spy);
      return node;
    }

    createBufferSource() {
      const node = new SpyAudioNode('bufferSource');
      node.buffer = null;
      node.loop = false;
      node.loopStart = 0;
      node.loopEnd = 0;
      node.playbackRate = createAudioParamSpy(1, spy);
      node.detune = createAudioParamSpy(0, spy);
      node.started = false;
      node.stopped = false;
      node.onended = null;
      node.start = () => {
        node.started = true;
      };
      node.stop = () => {
        node.stopped = true;
      };
      return node;
    }

    createBuffer(numberOfChannels, length, sampleRate) {
      const chCount = Math.max(1, Number(numberOfChannels) || 1);
      const len = Math.max(1, Number(length) || 1);
      const sr = Math.max(8000, Number(sampleRate) || 44100);
      const channels = Array.from({ length: chCount }, () => new Float32Array(len));
      spy.createdNodes.push('audioBuffer');
      return {
        numberOfChannels: chCount,
        length: len,
        sampleRate: sr,
        duration: len / sr,
        getChannelData(ch) {
          return channels[ch] || channels[0];
        },
      };
    }

    createDynamicsCompressor() {
      const node = new SpyAudioNode('dynamicsCompressor');
      node.threshold = createAudioParamSpy(-24, spy);
      node.knee = createAudioParamSpy(30, spy);
      node.ratio = createAudioParamSpy(12, spy);
      node.attack = createAudioParamSpy(0.003, spy);
      node.release = createAudioParamSpy(0.25, spy);
      return node;
    }

    createStereoPanner() {
      const node = new SpyAudioNode('stereoPanner');
      node.pan = createAudioParamSpy(0, spy);
      return node;
    }

    createWaveShaper() {
      const node = new SpyAudioNode('waveShaper');
      node.curve = null;
      node.oversample = 'none';
      return node;
    }

    resume() {
      spy.resumeCalls += 1;
      if (rejectResume) {
        const err = new Error('NotAllowedError: AudioContext resume rejected');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      this.state = 'running';
      spy.state = 'running';
      return Promise.resolve();
    }

    suspend() {
      spy.suspendCalls += 1;
      this.state = 'suspended';
      spy.state = 'suspended';
      return Promise.resolve();
    }

    close() {
      spy.closeCalls += 1;
      this.state = 'closed';
      spy.state = 'closed';
      return Promise.resolve();
    }
  }

  const restores = [];
  const ctorValue = unavailable ? undefined : SpyAudioContext;

  restores.push(overrideGlobal('AudioContext', { value: ctorValue, writable: true }));
  restores.push(overrideGlobal('webkitAudioContext', { value: ctorValue, writable: true }));

  const hasWindow = typeof globalThis.window === 'object' && globalThis.window !== null;
  let prevWinAC;
  let prevWinWebkitAC;
  let hadWinAC = false;
  let hadWinWebkitAC = false;

  if (hasWindow) {
    hadWinAC = 'AudioContext' in globalThis.window;
    hadWinWebkitAC = 'webkitAudioContext' in globalThis.window;
    prevWinAC = globalThis.window.AudioContext;
    prevWinWebkitAC = globalThis.window.webkitAudioContext;
    globalThis.window.AudioContext = ctorValue;
    globalThis.window.webkitAudioContext = ctorValue;
  } else {
    restores.push(
      overrideGlobal('window', {
        value: { AudioContext: ctorValue, webkitAudioContext: ctorValue },
        writable: true,
      }),
    );
  }

  function restore() {
    if (hasWindow && typeof globalThis.window === 'object' && globalThis.window !== null) {
      if (hadWinAC) globalThis.window.AudioContext = prevWinAC;
      else delete globalThis.window.AudioContext;
      if (hadWinWebkitAC) globalThis.window.webkitAudioContext = prevWinWebkitAC;
      else delete globalThis.window.webkitAudioContext;
    }
    for (let i = restores.length - 1; i >= 0; i--) {
      restores[i]();
    }
  }

  return { spy, restore };
}

/**
 * Read-only normalizer for `snapshot.scoreboard`.
 * Accepts plausible team-score key names (`scoreT1/scoreT2`, `scoreP1/scoreP2`,
 * `team1Score/team2Score`, `p1Score/p2Score`, `team1/team2`, `p1/p2`, `t1/t2`,
 * `left/right`, `scores[0]/[1]`, or nested `score`), while strictly asserting
 * both values are finite non-negative integers and guarding against cycles.
 */
export function readScores(snapshot, _seen = new Set()) {
  assert.ok(snapshot && typeof snapshot === 'object', 'snapshot must be an object');
  const sb = snapshot.scoreboard ?? snapshot;
  assert.ok(sb && typeof sb === 'object', 'snapshot.scoreboard must be an object');

  const keyPairs = [
    ['scoreT1', 'scoreT2'],
    ['scoreP1', 'scoreP2'],
    ['team1Score', 'team2Score'],
    ['p1Score', 'p2Score'],
    ['team1', 'team2'],
    ['p1', 'p2'],
    ['t1', 't2'],
    ['left', 'right'],
  ];

  let t1;
  let t2;
  let found = false;

  for (const [k1, k2] of keyPairs) {
    if (typeof sb[k1] === 'number' && typeof sb[k2] === 'number') {
      t1 = sb[k1];
      t2 = sb[k2];
      found = true;
      break;
    }
  }

  if (!found) {
    if (Array.isArray(sb.scores) && sb.scores.length >= 2) {
      t1 = sb.scores[0];
      t2 = sb.scores[1];
      found = true;
    } else if (sb.score && typeof sb.score === 'object') {
      assert.ok(!_seen.has(sb.score) && _seen.size < 4, 'Circular or excessively nested scoreboard.score');
      _seen.add(sb.score);
      return readScores({ scoreboard: sb.score }, _seen);
    } else {
      assert.fail(`Unable to read team scores from scoreboard keys: ${Object.keys(sb).join(', ')}`);
    }
  }

  assert.ok(typeof t1 === 'number' && Number.isInteger(t1) && t1 >= 0, `team1 score must be a non-negative integer, got ${t1}`);
  assert.ok(typeof t2 === 'number' && Number.isInteger(t2) && t2 >= 0, `team2 score must be a non-negative integer, got ${t2}`);

  return { team1: t1, team2: t2 };
}

/**
 * Read-only normalizer for `snapshot.timingRing`.
 * Strictly validates that any defined numeric fields are finite numbers and `pos` is a finite Vec3.
 */
export function readTimingRing(snapshot) {
  assert.ok(snapshot && typeof snapshot === 'object', 'snapshot must be an object');
  const ring = snapshot.timingRing;
  if (ring === null || ring === undefined) {
    return { active: false, progress: 0, radius: 0, pos: null, inSweetSpot: false };
  }
  assert.ok(typeof ring === 'object', 'snapshot.timingRing must be an object when present');

  for (const field of ['progress', 'ratio', 'scale', 'radius', 'currentRadius']) {
    if (ring[field] !== undefined) {
      assert.ok(
        typeof ring[field] === 'number' && Number.isFinite(ring[field]),
        `timingRing.${field} must be a finite number, got ${ring[field]}`,
      );
    }
  }

  const active = Boolean(ring.active ?? ring.visible ?? false);
  const progress =
    ring.progress !== undefined
      ? ring.progress
      : ring.ratio !== undefined
        ? ring.ratio
        : ring.scale !== undefined
          ? ring.scale
          : 0;
  const radius =
    ring.radius !== undefined
      ? ring.radius
      : ring.currentRadius !== undefined
        ? ring.currentRadius
        : progress;

  const pos = ring.pos !== undefined ? ring.pos : ring.position ?? null;
  if (pos !== null) {
    assertFiniteVec3(pos, 'timingRing.pos');
  }

  const inSweetSpot = Boolean(
    ring.inSweetSpot ?? ring.sweetSpot ?? ring.isSweetSpot ?? false,
  );
  return { active, progress, radius, pos, inSweetSpot };
}

function assertValidTouch(val, label) {
  assert.ok(
    typeof val === 'number' && Number.isInteger(val) && val >= 0,
    `${label} must be a non-negative integer, got ${val}`,
  );
  return val;
}

/**
 * Read-only normalizer for active team touch count (`0..3`).
 * Strictly validates integer touch counts >= 0 and prioritizes `scoreboard.activeTeam`.
 */
export function readTouchCount(snapshot, team = 1) {
  assert.ok(snapshot && typeof snapshot === 'object', 'snapshot must be an object');
  assert.ok(snapshot.scoreboard && typeof snapshot.scoreboard === 'object', 'snapshot.scoreboard must be an object');
  const sb = snapshot.scoreboard;
  const rally = snapshot.rally && typeof snapshot.rally === 'object' ? snapshot.rally : {};

  if (team === 1) {
    if (sb.team1Touches !== undefined) return assertValidTouch(sb.team1Touches, 'scoreboard.team1Touches');
    if (sb.p1Touches !== undefined) return assertValidTouch(sb.p1Touches, 'scoreboard.p1Touches');
  } else if (team === 2) {
    if (sb.team2Touches !== undefined) return assertValidTouch(sb.team2Touches, 'scoreboard.team2Touches');
    if (sb.p2Touches !== undefined) return assertValidTouch(sb.p2Touches, 'scoreboard.p2Touches');
  }

  if (Array.isArray(sb.touches) && sb.touches[team - 1] !== undefined) {
    return assertValidTouch(sb.touches[team - 1], `scoreboard.touches[${team - 1}]`);
  }
  if (sb.touches && typeof sb.touches === 'object' && !Array.isArray(sb.touches)) {
    const k =
      team === 1
        ? (sb.touches.team1 ?? sb.touches.p1 ?? sb.touches[1])
        : (sb.touches.team2 ?? sb.touches.p2 ?? sb.touches[2]);
    if (k !== undefined) return assertValidTouch(k, `scoreboard.touches[team=${team}]`);
  }

  const activeTeam =
    sb.activeTeam ??
    sb.touchTeam ??
    sb.possessionTeam ??
    rally.touchTeam ??
    snapshot.touchTeam ??
    snapshot.ball?.lastHitTeam;
  const genericCount =
    sb.touchCount !== undefined
      ? sb.touchCount
      : sb.touches !== undefined && typeof sb.touches !== 'object'
        ? sb.touches
        : rally.touchCount !== undefined
          ? rally.touchCount
          : snapshot.touchCount;

  if (genericCount !== undefined) {
    const valid = assertValidTouch(genericCount, 'touchCount');
    if (activeTeam === team || activeTeam === undefined) {
      return valid;
    }
    return 0;
  }
  return 0;
}

/**
 * Extract normalized uppercase event type strings from `snapshot.events`.
 * Strictly fails on non-Array inputs or malformed event entries.
 */
export function extractEventTypes(events) {
  assert.ok(Array.isArray(events), 'snapshot.events must be an Array');
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (typeof ev === 'string' && ev.length > 0) {
      out.push(ev);
    } else if (ev && typeof ev === 'object' && typeof ev.type === 'string' && ev.type.length > 0) {
      out.push(ev.type);
    } else {
      assert.fail(`Malformed event entry at events[${i}]: ${JSON.stringify(ev)}`);
    }
  }
  return out;
}

/**
 * Build a strictly valid `PlayerInputCmd` conforming to PROJECT.md / AGENTS.md.
 */
export function makePlayerCmd(overrides = {}) {
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
    isHuman: true,
    autoFootwork: false,
    ...overrides,
  };
}

/**
 * Build an idle `pollInputs()` envelope `{ mode, padsConnected, p1, p2 }`.
 */
export function makeIdleInputs(mode = '2PAD', { p1Overrides = {}, p2Overrides = {}, padsConnected = 0 } = {}) {
  return {
    mode,
    padsConnected,
    p1: makePlayerCmd({ isHuman: true, autoFootwork: mode === 'TOUCH', ...p1Overrides }),
    p2: makePlayerCmd({ isHuman: false, autoFootwork: false, ...p2Overrides }),
  };
}

/**
 * Assert a 3D vector object has strictly finite numeric `{ x, y, z }` fields.
 */
export function assertFiniteVec3(v, label = 'vec3') {
  assert.ok(v && typeof v === 'object', `${label} must be an object`);
  assert.ok(typeof v.x === 'number' && Number.isFinite(v.x), `${label}.x must be finite, got ${v.x}`);
  assert.ok(typeof v.y === 'number' && Number.isFinite(v.y), `${label}.y must be finite, got ${v.y}`);
  assert.ok(typeof v.z === 'number' && Number.isFinite(v.z), `${label}.z must be finite, got ${v.z}`);
}

/**
 * Closed-loop opaque-box player steering helper for driving Team 1 (or Team 2)
 * purely via genuine `PlayerInputCmd`s guided by read-only `getSnapshot()`.
 * Supports both instant-press (`primaryJustPressed`) and tap-release (`primaryJustReleased`)
 * strike semantics via a clean 2-step tap pulse.
 */
export function createBotController({
  team = 1,
  useSecondaryOnTouch3 = false,
  earlyAttack = false,
  lateAttack = false,
  autoFootwork = false,
  blockAtNet = false,
} = {}) {
  let primaryPulseTicks = 0;
  let secondaryPulseTicks = 0;
  let cooldownTicks = 0;
  let prevPrimaryHeld = false;
  let prevSecondaryHeld = false;
  let prevTouchCount = 0;
  let ringTicksSeen = 0;
  let strikeIntent = null;

  function step(snapshot, { forceServe = true } = {}) {
    const players = snapshot.players || [];
    const me =
      players.find((p) => p.team === team && p.role === 'PRIMARY') ||
      players.find((p) => p.team === team);
    const ball = snapshot.ball;
    const pred = snapshot.prediction;
    const ring = readTimingRing(snapshot);
    const touches = readTouchCount(snapshot, team);

    if (touches !== prevTouchCount) {
      prevTouchCount = touches;
      if (touches < 2) ringTicksSeen = 0;
    }
    if (ring.active) {
      ringTicksSeen += 1;
    } else {
      ringTicksSeen = 0;
    }

    if (cooldownTicks > 0) cooldownTicks -= 1;

    const mySideSign = team === 1 ? -1 : 1;
    const mySideX = (x) => (team === 1 ? x <= 0.35 : x >= -0.35);
    const ballSpeed = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);

    let tx = team === 1 ? -3.6 : 3.6;
    let tz = 0;
    let aimX = -mySideSign;
    let aimZ = 0;

    if (blockAtNet) {
      tx = team === 1 ? -0.55 : 0.55;
      tz = Math.max(-3.6, Math.min(3.6, ball.pos.z));
    } else if (ring.active && mySideX(ball.pos.x)) {
      const rx = ring.pos ? ring.pos.x : ball.pos.x;
      const rz = ring.pos ? ring.pos.z : ball.pos.z;
      tx = team === 1 ? Math.max(-7.5, Math.min(-0.45, rx)) : Math.min(7.5, Math.max(0.45, rx));
      tz = Math.max(-3.8, Math.min(3.8, rz));
    } else if (pred && mySideX(pred.x)) {
      tx = team === 1 ? Math.max(-7.6, Math.min(-0.45, pred.x)) : Math.min(7.6, Math.max(0.45, pred.x));
      tz = Math.max(-3.8, Math.min(3.8, pred.z));
    } else if (mySideX(ball.pos.x)) {
      tx = team === 1 ? Math.max(-7.6, Math.min(-0.45, ball.pos.x)) : Math.min(7.6, Math.max(0.45, ball.pos.x));
      tz = Math.max(-3.8, Math.min(3.8, ball.pos.z));
    }

    let moveX = 0;
    let moveZ = 0;
    if (!autoFootwork && me) {
      const dx = tx - me.pos.x;
      const dz = tz - me.pos.z;
      if (Math.abs(dx) > 0.15) moveX = Math.max(-1, Math.min(1, dx * 1.8));
      if (Math.abs(dz) > 0.15) moveZ = Math.max(-1, Math.min(1, dz * 1.8));
    }

    // Determine whether to start a tap pulse
    if (primaryPulseTicks === 0 && secondaryPulseTicks === 0 && cooldownTicks === 0 && me) {
      const hdist = Math.hypot(ball.pos.x - me.pos.x, ball.pos.z - me.pos.z);

      if (blockAtNet) {
        const nearNet = Math.abs(ball.pos.x) < 1.8 && ball.pos.y > 1.8 && ball.pos.y < 3.8;
        const comingTowardMe = team === 1 ? ball.vel.x < -1.0 : ball.vel.x > 1.0;
        if (nearNet && comingTowardMe && hdist < 2.6) {
          secondaryPulseTicks = 4;
          cooldownTicks = 30;
        }
      } else if (forceServe && (!ball.active || (ballSpeed < 0.25 && mySideX(ball.pos.x) && hdist < 3.0))) {
        primaryPulseTicks = 3;
        cooldownTicks = 24;
        strikeIntent = 'serve';
      } else if (mySideX(ball.pos.x)) {
        const isThirdTouch = ring.active || touches >= 2;
        if (isThirdTouch) {
          let triggerAttack = false;
          if (earlyAttack) {
            triggerAttack = ringTicksSeen >= 1 && hdist < 3.2;
          } else if (lateAttack) {
            triggerAttack = !ring.active && ball.pos.y < 1.9 && ball.vel.y < -1.0 && hdist < 2.6;
          } else {
            const sweet =
              ring.inSweetSpot ||
              (ring.active && ring.progress >= 0.5 && ring.progress <= 0.92) ||
              (ball.pos.y >= 1.9 && ball.pos.y <= 3.6 && Math.abs(ball.vel.y) < 3.5);
            triggerAttack = sweet && hdist < 2.8;
          }

          if (triggerAttack) {
            if (useSecondaryOnTouch3) {
              secondaryPulseTicks = 3;
            } else {
              primaryPulseTicks = 3;
            }
            cooldownTicks = 22;
            strikeIntent = useSecondaryOnTouch3 ? 'pokey' : 'attack';
          }
        } else if (hdist < 2.35 && ball.pos.y <= 2.95 && ball.vel.y <= 2.5) {
          primaryPulseTicks = 3;
          cooldownTicks = 20;
          strikeIntent = touches === 0 ? 'bump' : 'set';
        }
      }
    }

    const primaryHeld = primaryPulseTicks > 0;
    const secondaryHeld = secondaryPulseTicks > 0;

    if (primaryPulseTicks > 0) primaryPulseTicks -= 1;
    if (secondaryPulseTicks > 0) secondaryPulseTicks -= 1;

    const cmd = makePlayerCmd({
      moveX,
      moveZ,
      aimX,
      aimZ,
      primaryHeld,
      primaryJustPressed: primaryHeld && !prevPrimaryHeld,
      primaryJustReleased: !primaryHeld && prevPrimaryHeld,
      secondaryHeld,
      secondaryJustPressed: secondaryHeld && !prevSecondaryHeld,
      secondaryJustReleased: !secondaryHeld && prevSecondaryHeld,
      isHuman: true,
      autoFootwork,
    });

    prevPrimaryHeld = primaryHeld;
    prevSecondaryHeld = secondaryHeld;

    return { cmd, strikeIntent };
  }

  return { step };
}
