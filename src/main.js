/**
 * SUMMER HEAT 3D — Application Shell & Runtime Orchestrator
 *
 * Strictly obeys AGENTS.md DAG:
 * imports contracts.js, physics3d.js, courtScene.js, inputManager.js, rallyEngine.js, audioSynth.js.
 */

import {
  PHYSICS_DEFAULTS,
  PHYSICS_LIMITS,
  STORAGE_KEYS,
  INPUT_MODES,
  CAMERA_MODES,
  AI_STYLES,
  MATCH_FORMATS,
  WIND_PHASES,
  EVENTS,
  sanitizePhysicsConfig,
  createDefaultBindings,
} from './contracts.js';
import { FIXED_DT } from './physics3d.js';
import { createCourtScene } from './courtScene.js';
import { createInputManager } from './inputManager.js';
import { createRallyEngine } from './rallyEngine.js';
import { createAudioSynth } from './audioSynth.js';

const CAMERA_LABELS = Object.freeze({
  [CAMERA_MODES.BROADCAST]: 'Broadcast 3/4',
  [CAMERA_MODES.SPLIT_SCREEN]: '2P Split-Screen',
});

const CONTROLS_HINTS = Object.freeze({
  [INPUT_MODES.ONE_PAD_SPLIT]:
    '1-PAD SPLIT: P1 Left Stick/D-Pad + LB/LT (Strike) | P2 Right Stick + RB/RT/A (Strike)',
  [INPUT_MODES.TWO_PAD_KEYBOARD]:
    '2-PAD / KB: P1 WASD + Space (Strike) + Shift/E (Dive/Pokey/Block) | P2 Arrows + Enter + RShift',
  [INPUT_MODES.TOUCH_AUTO]:
    'TOUCH AUTO-FOOTWORK: Drag to aim, Tap/Hold to charge Bump/Set/Heat Spike, Double-Tap to Dive/Pokey',
});

function readStorageJson(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') {
    return null;
  }
  try {
    const raw = storage.getItem(key);
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStorageJson(storage, key, value) {
  if (!storage || typeof storage.setItem !== 'function') {
    return;
  }
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

function loadPhysicsConfig(storage) {
  const parsed = readStorageJson(storage, STORAGE_KEYS.PHYSICS);
  return sanitizePhysicsConfig(parsed);
}

function loadBindings(storage) {
  const parsed = readStorageJson(storage, STORAGE_KEYS.BINDINGS);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return {
      ...createDefaultBindings(),
      ...parsed,
    };
  }
  return createDefaultBindings();
}

function pickAllowed(value, enumObj, fallback) {
  const allowed = Object.values(enumObj);
  return allowed.includes(value) ? value : fallback;
}

function loadSettings(storage) {
  const parsed = readStorageJson(storage, STORAGE_KEYS.SETTINGS);
  const src = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return {
    cameraMode: pickAllowed(src.cameraMode, CAMERA_MODES, CAMERA_MODES.BROADCAST),
    format: pickAllowed(src.format, MATCH_FORMATS, MATCH_FORMATS.ONE_V_ONE),
    aiStyle: pickAllowed(src.aiStyle, AI_STYLES, AI_STYLES.WIND_LOBBER),
    inputMode: pickAllowed(src.inputMode, INPUT_MODES, INPUT_MODES.TWO_PAD_KEYBOARD),
  };
}

function formatSliderValue(key, value) {
  if (key === 'gravity') {
    return value.toFixed(1);
  }
  if (key === 'kDrag' || key === 'kMagnus') {
    return value.toFixed(3);
  }
  return `${value.toFixed(2)}x`;
}

function extractEventType(ev) {
  if (typeof ev === 'string') {
    return ev;
  }
  if (ev && typeof ev === 'object' && typeof ev.type === 'string') {
    return ev.type;
  }
  return null;
}

function computeWindArrow(wind) {
  const vec = wind && wind.windVec3 ? wind.windVec3 : null;
  const vx = vec && Number.isFinite(vec.x) ? vec.x : 0;
  const vz = vec && Number.isFinite(vec.z) ? vec.z : 0;
  if (Math.hypot(vx, vz) < 0.25) {
    return '·';
  }
  if (Math.abs(vx) >= Math.abs(vz)) {
    return vx >= 0 ? '→' : '←';
  }
  return vz >= 0 ? '↓' : '↑';
}

function computeWindSpeed(scoreboard, wind) {
  if (scoreboard && Number.isFinite(scoreboard.windSpeedMs)) {
    return Math.max(0, scoreboard.windSpeedMs);
  }
  if (wind && Number.isFinite(wind.speed)) {
    return Math.max(0, wind.speed);
  }
  if (wind && wind.windVec3) {
    const vx = Number.isFinite(wind.windVec3.x) ? wind.windVec3.x : 0;
    const vy = Number.isFinite(wind.windVec3.y) ? wind.windVec3.y : 0;
    const vz = Number.isFinite(wind.windVec3.z) ? wind.windVec3.z : 0;
    return Math.hypot(vx, vy, vz);
  }
  return 0;
}

function extractTeamHeat(scoreboard, players, team) {
  if (scoreboard) {
    const sbKey = team === 1 ? 'heatT1' : 'heatT2';
    if (Number.isFinite(scoreboard[sbKey])) {
      return Math.max(0, Math.min(1, scoreboard[sbKey]));
    }
  }
  if (Array.isArray(players)) {
    let maxHeat = 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p && p.team === team && Number.isFinite(p.heatMeter)) {
        if (p.heatMeter > maxHeat) {
          maxHeat = p.heatMeter;
        }
      }
    }
    return Math.max(0, Math.min(1, maxHeat));
  }
  return 0;
}

function resolveDefaultStorage(win) {
  try {
    return win ? win.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Initialize SUMMER HEAT 3D app shell, DOM bindings, audio, Wake Lock, SW, and RAF loop.
 *
 * @param {object} [overrides] Optional dependency overrides for deterministic testing.
 */
export function initApp(overrides = {}) {
  const win = overrides.window || globalThis.window;
  const doc = overrides.document || globalThis.document;
  const nav = overrides.navigator || (win ? win.navigator : globalThis.navigator);
  const storage = overrides.storage !== undefined ? overrides.storage : resolveDefaultStorage(win);

  if (!win || !doc) {
    return null;
  }

  const canvas = doc.getElementById('gameCanvas');
  if (!canvas) {
    return null;
  }

  // DOM References
  const elScoreT1 = doc.getElementById('scoreT1');
  const elScoreT2 = doc.getElementById('scoreT2');
  const elTouchIndicator = doc.getElementById('touchIndicator');
  const elHeatBarT1 = doc.getElementById('heatBarT1');
  const elHeatBarT2 = doc.getElementById('heatBarT2');
  const elWindReadout = doc.getElementById('windReadout');
  const elRallyBanner = doc.getElementById('rallyBanner');
  const elControlsHint = doc.getElementById('controlsHint');

  const btnCameraToggle = doc.getElementById('cameraToggleBtn');
  const btnFormatToggle = doc.getElementById('formatToggleBtn');
  const selAiStyle = doc.getElementById('aiStyleSelect');
  const btnMode1Pad = doc.getElementById('mode1PadBtn');
  const btnMode2Pad = doc.getElementById('mode2PadBtn');
  const btnModeTouch = doc.getElementById('modeTouchBtn');
  const btnQuickBind = doc.getElementById('quickBindBtn');
  const btnAudioToggle = doc.getElementById('audioToggleBtn');
  const btnPhysicsLab = doc.getElementById('physicsLabBtn');
  const btnResetMatch = doc.getElementById('resetMatchBtn');

  const elPhysicsDrawer = doc.getElementById('physicsDrawer');
  const btnCloseDrawer = doc.getElementById('closeDrawerBtn');
  const btnResetPhysics = doc.getElementById('resetPhysicsBtn');
  const btnForceGust = doc.getElementById('forceGustBtn');

  const sliderConfigs = [
    { key: 'gravity', input: doc.getElementById('sliderGravity'), valEl: doc.getElementById('valGravity') },
    { key: 'kDrag', input: doc.getElementById('sliderDrag'), valEl: doc.getElementById('valDrag') },
    { key: 'kMagnus', input: doc.getElementById('sliderMagnus'), valEl: doc.getElementById('valMagnus') },
    { key: 'gustScale', input: doc.getElementById('sliderGust'), valEl: doc.getElementById('valGust') },
    { key: 'gameSpeed', input: doc.getElementById('sliderSpeed'), valEl: doc.getElementById('valSpeed') },
  ];

  const elQuickBindModal = doc.getElementById('quickBindModal');
  const elQuickBindPrompt = doc.getElementById('quickBindPrompt');
  const elQuickBindCountdown = doc.getElementById('quickBindCountdown');
  const btnQuickBindCancel = doc.getElementById('quickBindCancelBtn');
  const btnQuickBindReset = doc.getElementById('quickBindResetBtn');

  const elPortraitOverlay = doc.getElementById('portraitOverlay');

  // Persisted State
  let physicsConfig = loadPhysicsConfig(storage);
  const initialBindings = loadBindings(storage);
  const settings = loadSettings(storage);

  let cameraMode = settings.cameraMode;
  let format = settings.format;
  let aiStyle = settings.aiStyle;
  let inputMode = settings.inputMode;

  let portraitPaused = false;
  let quickBindPaused = false;
  let drawerOpen = false;
  let wakeLockSentinel = null;
  let wakeLockRequested = false;
  let lastCameraPunch = 0;
  let rafId = null;
  let lastFrameMs = null;
  let destroyed = false;

  // Instantiate Subsystems (with optional test DI factories)
  const sceneFactory = overrides.createCourtScene || createCourtScene;
  const inputFactory = overrides.createInputManager || createInputManager;
  const engineFactory = overrides.createRallyEngine || createRallyEngine;
  const audioFactory = overrides.createAudioSynth || createAudioSynth;

  const courtScene = sceneFactory(canvas, { format, cameraMode });
  const inputManager = inputFactory(canvas, { mode: inputMode, bindings: initialBindings });
  const rallyEngine = engineFactory({ format, aiStyle });
  const audioSynth = audioFactory();

  if (typeof inputManager.setBindings === 'function') {
    inputManager.setBindings(initialBindings);
  }
  if (typeof inputManager.setMode === 'function') {
    inputManager.setMode(inputMode);
  }
  if (typeof rallyEngine.setFormat === 'function') {
    rallyEngine.setFormat(format);
  }
  if (typeof rallyEngine.setAiStyle === 'function') {
    rallyEngine.setAiStyle(aiStyle);
  }

  function persistSettings() {
    writeStorageJson(storage, STORAGE_KEYS.SETTINGS, {
      cameraMode,
      format,
      aiStyle,
      inputMode,
    });
  }

  function persistPhysics() {
    writeStorageJson(storage, STORAGE_KEYS.PHYSICS, physicsConfig);
  }

  function persistBindings() {
    if (typeof inputManager.getBindings === 'function') {
      writeStorageJson(storage, STORAGE_KEYS.BINDINGS, inputManager.getBindings());
    }
  }

  function isPaused() {
    return Boolean(portraitPaused || quickBindPaused);
  }

  function syncPauseState() {
    if (typeof rallyEngine.setPaused === 'function') {
      rallyEngine.setPaused(isPaused());
    }
  }

  function syncCameraButton() {
    if (btnCameraToggle) {
      btnCameraToggle.textContent = CAMERA_LABELS[cameraMode] || CAMERA_LABELS[CAMERA_MODES.BROADCAST];
    }
  }

  function syncFormatButton() {
    if (btnFormatToggle) {
      btnFormatToggle.textContent = format;
    }
  }

  function syncAiSelect() {
    if (selAiStyle) {
      selAiStyle.value = aiStyle;
    }
  }

  function syncInputModeUI() {
    const activeMode = typeof inputManager.getMode === 'function' ? inputManager.getMode() : inputMode;
    inputMode = pickAllowed(activeMode, INPUT_MODES, inputMode);

    const buttons = [
      { el: btnMode1Pad, mode: INPUT_MODES.ONE_PAD_SPLIT },
      { el: btnMode2Pad, mode: INPUT_MODES.TWO_PAD_KEYBOARD },
      { el: btnModeTouch, mode: INPUT_MODES.TOUCH_AUTO },
    ];
    for (let i = 0; i < buttons.length; i++) {
      const item = buttons[i];
      if (!item.el) {
        continue;
      }
      const active = item.mode === inputMode;
      item.el.classList.toggle('active', active);
      item.el.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    if (elControlsHint) {
      elControlsHint.textContent = CONTROLS_HINTS[inputMode] || CONTROLS_HINTS[INPUT_MODES.TWO_PAD_KEYBOARD];
    }
  }

  function syncAudioButton() {
    if (!btnAudioToggle) {
      return;
    }
    const on = Boolean(audioSynth.isEnabled());
    btnAudioToggle.textContent = on ? '[🔊 SOUND: ON]' : '[🔇 SOUND: OFF]';
    btnAudioToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    btnAudioToggle.classList.toggle('active', on);
  }

  function syncPhysicsSliders() {
    for (let i = 0; i < sliderConfigs.length; i++) {
      const { key, input, valEl } = sliderConfigs[i];
      const limit = PHYSICS_LIMITS[key];
      const currentVal = physicsConfig[key];
      if (input) {
        if (Array.isArray(limit) && limit.length >= 3) {
          input.min = String(limit[0]);
          input.max = String(limit[1]);
          input.step = String(limit[2]);
        }
        input.value = String(currentVal);
      }
      if (valEl) {
        valEl.textContent = formatSliderValue(key, currentVal);
      }
    }
  }

  function setDrawerOpen(nextOpen) {
    drawerOpen = Boolean(nextOpen);
    if (elPhysicsDrawer) {
      elPhysicsDrawer.classList.toggle('open', drawerOpen);
      elPhysicsDrawer.setAttribute('aria-hidden', drawerOpen ? 'false' : 'true');
    }
    if (btnPhysicsLab) {
      btnPhysicsLab.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
      btnPhysicsLab.classList.toggle('active', drawerOpen);
    }
  }

  function closeQuickBindModal() {
    quickBindPaused = false;
    if (elQuickBindModal) {
      elQuickBindModal.hidden = true;
    }
    syncPauseState();
  }

  function syncHudFromSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return;
    }
    const sb = snapshot.scoreboard || {};
    const wind = snapshot.wind || {};
    const players = Array.isArray(snapshot.players) ? snapshot.players : [];

    const scoreT1 = Number.isFinite(sb.scoreT1) ? sb.scoreT1 : (Number.isFinite(sb.p1) ? sb.p1 : 0);
    const scoreT2 = Number.isFinite(sb.scoreT2) ? sb.scoreT2 : (Number.isFinite(sb.p2) ? sb.p2 : 0);
    if (elScoreT1) {
      elScoreT1.textContent = String(scoreT1);
    }
    if (elScoreT2) {
      elScoreT2.textContent = String(scoreT2);
    }

    const activeTeam = sb.activeTeam === 2 ? 2 : 1;
    const touchCount = Number.isFinite(sb.touchCount) ? Math.max(0, Math.min(3, Math.floor(sb.touchCount))) : 0;
    if (elTouchIndicator) {
      elTouchIndicator.textContent = `T${activeTeam} · TOUCH ${touchCount}/3`;
    }

    const heatT1 = extractTeamHeat(sb, players, 1);
    const heatT2 = extractTeamHeat(sb, players, 2);
    if (elHeatBarT1) {
      elHeatBarT1.style.width = `${Math.round(heatT1 * 100)}%`;
      elHeatBarT1.classList.toggle('heat-max', heatT1 >= 0.999);
    }
    if (elHeatBarT2) {
      elHeatBarT2.style.width = `${Math.round(heatT2 * 100)}%`;
      elHeatBarT2.classList.toggle('heat-max', heatT2 >= 0.999);
    }

    const windSpeed = computeWindSpeed(sb, wind);
    const windPhase =
      sb.windPhase === WIND_PHASES.GUST ||
      sb.windPhase === WIND_PHASES.WARNING ||
      sb.windPhase === WIND_PHASES.BREEZE
        ? sb.windPhase
        : (wind.phase === WIND_PHASES.GUST || wind.phase === WIND_PHASES.WARNING ? wind.phase : WIND_PHASES.BREEZE);

    if (elWindReadout) {
      const arrow = computeWindArrow(wind);
      elWindReadout.textContent = `WIND ${arrow} ${windSpeed.toFixed(1)} m/s · ${windPhase}`;
      elWindReadout.classList.toggle('phase-warning', windPhase === WIND_PHASES.WARNING);
      elWindReadout.classList.toggle('phase-gust', windPhase === WIND_PHASES.GUST);
    }

    if (elRallyBanner) {
      const text = typeof sb.bannerText === 'string' ? sb.bannerText.trim() : '';
      const activeTimer = sb.bannerTimer === undefined || sb.bannerTimer > 0;
      if (text.length > 0 && activeTimer) {
        elRallyBanner.textContent = text;
        elRallyBanner.hidden = false;
      } else {
        elRallyBanner.textContent = '';
        elRallyBanner.hidden = true;
      }
    }
  }

  // Screen Wake Lock (guarded, re-acquired on visibilitychange)
  async function requestWakeLock() {
    if (destroyed) {
      return;
    }
    wakeLockRequested = true;
    if (!nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') {
      return;
    }
    if (doc.visibilityState === 'hidden') {
      return;
    }
    try {
      const sentinel = await nav.wakeLock.request('screen');
      if (destroyed) {
        if (sentinel && typeof sentinel.release === 'function') {
          try {
            Promise.resolve(sentinel.release()).catch(() => {});
          } catch {
            // Ignore release errors
          }
        }
        return;
      }
      wakeLockSentinel = sentinel;
      if (sentinel && typeof sentinel.addEventListener === 'function') {
        sentinel.addEventListener('release', () => {
          if (wakeLockSentinel === sentinel) {
            wakeLockSentinel = null;
          }
        });
      }
    } catch {
      // Silently ignore NotAllowedError or unsupported browser errors
    }
  }

  function handleFirstUserGesture() {
    if (!destroyed && !wakeLockRequested) {
      requestWakeLock();
    }
  }

  function handleVisibilityChange() {
    if (!destroyed && doc.visibilityState === 'visible' && wakeLockRequested && !wakeLockSentinel) {
      requestWakeLock();
    }
  }

  // Orientation / Portrait Auto-Pause & Resize
  function handleViewportResize() {
    const width = Math.max(1, win.innerWidth || 1280);
    const height = Math.max(1, win.innerHeight || 720);
    portraitPaused = height > width;

    if (elPortraitOverlay) {
      elPortraitOverlay.hidden = !portraitPaused;
      elPortraitOverlay.classList.toggle('visible', portraitPaused);
    }

    syncPauseState();
    if (typeof courtScene.resize === 'function') {
      courtScene.resize(width, height);
    }
  }

  // Wire HUD Controls
  const cleanupListeners = [];
  function on(target, eventName, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') {
      return;
    }
    target.addEventListener(eventName, handler, options);
    cleanupListeners.push(() => target.removeEventListener(eventName, handler, options));
  }

  on(btnCameraToggle, 'click', () => {
    cameraMode =
      cameraMode === CAMERA_MODES.BROADCAST ? CAMERA_MODES.SPLIT_SCREEN : CAMERA_MODES.BROADCAST;
    syncCameraButton();
    persistSettings();
  });

  on(btnFormatToggle, 'click', () => {
    format = format === MATCH_FORMATS.ONE_V_ONE ? MATCH_FORMATS.TWO_V_TWO : MATCH_FORMATS.ONE_V_ONE;
    if (typeof rallyEngine.setFormat === 'function') {
      rallyEngine.setFormat(format);
    }
    syncFormatButton();
    persistSettings();
  });

  on(selAiStyle, 'change', (event) => {
    aiStyle = pickAllowed(event.target.value, AI_STYLES, AI_STYLES.WIND_LOBBER);
    if (typeof rallyEngine.setAiStyle === 'function') {
      rallyEngine.setAiStyle(aiStyle);
    }
    syncAiSelect();
    persistSettings();
  });

  function selectInputMode(nextMode) {
    inputMode = pickAllowed(nextMode, INPUT_MODES, INPUT_MODES.TWO_PAD_KEYBOARD);
    if (typeof inputManager.setMode === 'function') {
      inputManager.setMode(inputMode);
    }
    syncInputModeUI();
    persistSettings();
  }

  on(btnMode1Pad, 'click', () => selectInputMode(INPUT_MODES.ONE_PAD_SPLIT));
  on(btnMode2Pad, 'click', () => selectInputMode(INPUT_MODES.TWO_PAD_KEYBOARD));
  on(btnModeTouch, 'click', () => selectInputMode(INPUT_MODES.TOUCH_AUTO));

  on(btnAudioToggle, 'click', () => {
    audioSynth.toggle();
    syncAudioButton();
  });

  on(btnPhysicsLab, 'click', () => {
    setDrawerOpen(!drawerOpen);
  });

  on(btnCloseDrawer, 'click', () => {
    setDrawerOpen(false);
  });

  for (let i = 0; i < sliderConfigs.length; i++) {
    const { key, input, valEl } = sliderConfigs[i];
    on(input, 'input', (event) => {
      physicsConfig = sanitizePhysicsConfig({
        ...physicsConfig,
        [key]: event.target.value,
      });
      if (valEl) {
        valEl.textContent = formatSliderValue(key, physicsConfig[key]);
      }
      persistPhysics();
    });
  }

  on(btnResetPhysics, 'click', () => {
    physicsConfig = sanitizePhysicsConfig(PHYSICS_DEFAULTS);
    syncPhysicsSliders();
    persistPhysics();
  });

  on(btnForceGust, 'click', () => {
    if (typeof rallyEngine.triggerGust === 'function') {
      rallyEngine.triggerGust();
    }
  });

  on(btnResetMatch, 'click', () => {
    if (typeof rallyEngine.resetMatch === 'function') {
      rallyEngine.resetMatch();
    }
  });

  on(btnQuickBind, 'click', () => {
    quickBindPaused = true;
    syncPauseState();
    if (elQuickBindModal) {
      elQuickBindModal.hidden = false;
    }
    if (elQuickBindPrompt) {
      elQuickBindPrompt.textContent = 'Press button or key to bind...';
    }
    if (elQuickBindCountdown) {
      elQuickBindCountdown.textContent = '3.0s';
    }

    if (typeof inputManager.startQuickBind === 'function') {
      inputManager.startQuickBind(
        (status) => {
          if (elQuickBindPrompt) {
            const promptText =
              status?.label ?? status?.prompt ?? status?.slotKey ?? 'Press button or key...';
            elQuickBindPrompt.textContent = String(promptText);
          }
          if (elQuickBindCountdown) {
            const rawSec = Number.isFinite(status?.remaining)
              ? status.remaining
              : (Number.isFinite(status?.remainingSec)
                  ? status.remainingSec
                  : (Number.isFinite(status?.countdown) ? status.countdown : 3.0));
            elQuickBindCountdown.textContent = `${Math.max(0, rawSec).toFixed(1)}s`;
          }
        },
        () => {
          persistBindings();
          closeQuickBindModal();
        },
      );
    }
  });

  on(btnQuickBindCancel, 'click', () => {
    if (typeof inputManager.cancelQuickBind === 'function') {
      inputManager.cancelQuickBind();
    }
    closeQuickBindModal();
  });

  on(btnQuickBindReset, 'click', () => {
    if (typeof inputManager.cancelQuickBind === 'function') {
      inputManager.cancelQuickBind();
    }
    if (typeof inputManager.resetBindings === 'function') {
      inputManager.resetBindings();
    }
    persistBindings();
    closeQuickBindModal();
  });

  // Global Lifecycle Listeners
  on(win, 'pointerdown', handleFirstUserGesture, { passive: true });
  on(win, 'keydown', handleFirstUserGesture, { passive: true });
  on(win, 'click', handleFirstUserGesture, { passive: true });
  on(doc, 'visibilitychange', handleVisibilityChange);
  on(win, 'resize', handleViewportResize);
  on(win, 'orientationchange', handleViewportResize);

  // Initial UI & Viewport Sync
  syncCameraButton();
  syncFormatButton();
  syncAiSelect();
  syncInputModeUI();
  syncAudioButton();
  syncPhysicsSliders();
  setDrawerOpen(false);
  handleViewportResize();

  // Register Service Worker (silently catching any error in unsupported/offline contexts)
  function registerServiceWorker() {
    if (nav && nav.serviceWorker && typeof nav.serviceWorker.register === 'function') {
      try {
        Promise.resolve(nav.serviceWorker.register('./sw.js')).catch(() => {});
      } catch {
        // Ignore registration errors
      }
    }
  }

  if (doc.readyState === 'complete') {
    registerServiceWorker();
  } else {
    on(win, 'load', registerServiceWorker, { once: true });
  }

  // Read-only Telemetry Hook (AGENTS.md § 5.3 — NEVER mutates game state)
  const debugApi = Object.freeze({
    getSnapshot: () => rallyEngine.getSnapshot(),
    getCameraMode: () => cameraMode,
    getInputMode: () => (typeof inputManager.getMode === 'function' ? inputManager.getMode() : inputMode),
    isPaused: () => isPaused(),
    getPhysicsConfig: () => ({ ...physicsConfig }),
    getAudioEnabled: () => Boolean(audioSynth.isEnabled()),
  });

  try {
    win.__SUMMER_HEAT_DEBUG__ = debugApi;
  } catch {
    // Ignore if window is non-extensible in synthetic test host
  }

  // Main Animation Loop
  function stepFrame(timestampMs) {
    if (destroyed) {
      return;
    }

    let rawDt = FIXED_DT;
    if (typeof timestampMs === 'number' && Number.isFinite(timestampMs)) {
      if (lastFrameMs !== null) {
        const deltaSec = (timestampMs - lastFrameMs) / 1000;
        if (Number.isFinite(deltaSec) && deltaSec > 0) {
          rawDt = Math.min(deltaSec, 0.05);
        }
      }
      lastFrameMs = timestampMs;
    }

    const inputs =
      !portraitPaused && typeof inputManager.pollInputs === 'function'
        ? inputManager.pollInputs(rawDt)
        : null;
    const frameEvents =
      typeof rallyEngine.update === 'function' ? rallyEngine.update(rawDt, inputs, physicsConfig) : [];
    const snapshot = typeof rallyEngine.getSnapshot === 'function' ? rallyEngine.getSnapshot() : null;

    const events =
      Array.isArray(frameEvents) && frameEvents.length > 0
        ? frameEvents
        : (Array.isArray(snapshot?.events) ? snapshot.events : []);

    if (events.length > 0) {
      audioSynth.handleEvents(events);
    }
    audioSynth.updateAmbience(snapshot?.wind);

    if (!isPaused() && Array.isArray(snapshot?.players)) {
      let maxCharge = 0;
      for (let i = 0; i < snapshot.players.length; i++) {
        const p = snapshot.players[i];
        if (p && p.isHuman && Number.isFinite(p.chargeRatio) && p.chargeRatio > maxCharge) {
          maxCharge = p.chargeRatio;
        }
      }
      if (maxCharge > 0.05) {
        audioSynth.playChargeSweep(maxCharge);
      }
    }

    if (!isPaused() && typeof courtScene.triggerCameraPunch === 'function') {
      let punchTriggered = false;
      for (let i = 0; i < events.length; i++) {
        const type = extractEventType(events[i]);
        if (type === EVENTS.HEAT_SPIKE || type === EVENTS.STUFF_BLOCK) {
          const strength =
            Number.isFinite(snapshot?.cameraPunch) && snapshot.cameraPunch > 0
              ? snapshot.cameraPunch
              : (type === EVENTS.HEAT_SPIKE ? 1.0 : 0.75);
          courtScene.triggerCameraPunch(strength);
          punchTriggered = true;
          break;
        }
      }
      const curPunch = Number.isFinite(snapshot?.cameraPunch) ? snapshot.cameraPunch : 0;
      if (!punchTriggered && curPunch > 0 && curPunch > lastCameraPunch + 0.01) {
        courtScene.triggerCameraPunch(curPunch);
      }
      lastCameraPunch = curPunch;
    }

    if (typeof courtScene.syncState === 'function') {
      courtScene.syncState(snapshot, rawDt);
    }
    if (typeof courtScene.render === 'function') {
      courtScene.render(cameraMode);
    }

    syncHudFromSnapshot(snapshot);

    if (typeof win.requestAnimationFrame === 'function') {
      rafId = win.requestAnimationFrame(stepFrame);
    }
  }

  if (typeof win.requestAnimationFrame === 'function') {
    rafId = win.requestAnimationFrame(stepFrame);
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    if (rafId !== null && typeof win.cancelAnimationFrame === 'function') {
      win.cancelAnimationFrame(rafId);
      rafId = null;
    }
    for (let i = 0; i < cleanupListeners.length; i++) {
      cleanupListeners[i]();
    }
    cleanupListeners.length = 0;
    if (wakeLockSentinel && typeof wakeLockSentinel.release === 'function') {
      try {
        Promise.resolve(wakeLockSentinel.release()).catch(() => {});
      } catch {
        // Ignore release errors
      }
      wakeLockSentinel = null;
    }
    audioSynth.dispose();
    if (typeof inputManager.destroy === 'function') {
      inputManager.destroy();
    }
    if (typeof courtScene.dispose === 'function') {
      courtScene.dispose();
    }
  }

  return {
    debugApi,
    stepFrame,
    destroy,
  };
}

// Auto-bootstrap in browser runtime
if (
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  !globalThis.__SUMMER_HEAT_NO_AUTO_INIT__
) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initApp();
    }, { once: true });
  } else {
    initApp();
  }
}
