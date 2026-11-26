/**
 * SUMMER HEAT 3D — Muted-by-Default Procedural Web Audio Synthesizer
 *
 * Strictly obeys AGENTS.md DAG: imports ONLY ./contracts.js.
 * Zero AudioContext creation until an explicit user gesture enables audio.
 * Zero exceptions in headless/Node environments lacking Web Audio APIs.
 */

import { EVENTS, WIND_PHASES, clamp } from './contracts.js';

function getClockMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function safeSetTarget(param, value, startTime, timeConstant) {
  if (!param || !Number.isFinite(value)) {
    return;
  }
  if (typeof param.setTargetAtTime === 'function') {
    try {
      param.setTargetAtTime(value, startTime, timeConstant);
      return;
    } catch {
      // Fallback to direct assignment below
    }
  }
  try {
    param.value = value;
  } catch {
    // Ignore closed-context assignment errors
  }
}

function safeRamp(param, endValue, endTime, exponential = false) {
  if (!param || !Number.isFinite(endValue)) {
    return;
  }
  if (exponential && endValue > 0 && typeof param.exponentialRampToValueAtTime === 'function') {
    try {
      param.exponentialRampToValueAtTime(endValue, endTime);
      return;
    } catch {
      // Fallback below
    }
  }
  if (typeof param.linearRampToValueAtTime === 'function') {
    try {
      param.linearRampToValueAtTime(endValue, endTime);
      return;
    } catch {
      // Fallback below
    }
  }
  try {
    param.value = endValue;
  } catch {
    // Ignore closed-context assignment errors
  }
}

function safeSetValueAtTime(param, value, time) {
  if (!param || !Number.isFinite(value)) {
    return;
  }
  if (typeof param.setValueAtTime === 'function') {
    try {
      param.setValueAtTime(value, time);
      return;
    } catch {
      // Fallback below
    }
  }
  try {
    param.value = value;
  } catch {
    // Ignore closed-context assignment errors
  }
}

function createProceduralNoiseBuffer(audioCtx) {
  const sampleRate = Number.isFinite(audioCtx.sampleRate) && audioCtx.sampleRate > 0 ? audioCtx.sampleRate : 44100;
  const length = Math.max(1, Math.floor(sampleRate * 2));
  const buffer = audioCtx.createBuffer(1, length, sampleRate);
  const channel = buffer.getChannelData(0);

  // Deterministic LCG + 3-pole warm pink/white blend for organic surf & gale noise
  let seed = 0x51a7c3d1;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const white = (seed / 0xffffffff) * 2 - 1;
    b0 = 0.997 * b0 + white * 0.029;
    b1 = 0.985 * b1 + white * 0.032;
    b2 = 0.950 * b2 + white * 0.048;
    const pink = (b0 + b1 + b2 + white * 0.22) * 0.72;
    channel[i] = clamp(pink, -1, 1, 0);
  }
  return buffer;
}

function extractWindTelemetry(windState) {
  if (!windState || typeof windState !== 'object') {
    return { speed: 0, phase: WIND_PHASES.BREEZE };
  }
  let speed = 0;
  if (typeof windState.speed === 'number' && Number.isFinite(windState.speed)) {
    speed = Math.max(0, windState.speed);
  } else if (windState.windVec3 && typeof windState.windVec3 === 'object') {
    const vx = Number.isFinite(windState.windVec3.x) ? windState.windVec3.x : 0;
    const vy = Number.isFinite(windState.windVec3.y) ? windState.windVec3.y : 0;
    const vz = Number.isFinite(windState.windVec3.z) ? windState.windVec3.z : 0;
    speed = Math.hypot(vx, vy, vz);
  }

  let phase = WIND_PHASES.BREEZE;
  if (
    windState.phase === WIND_PHASES.GUST ||
    windState.phase === WIND_PHASES.WARNING ||
    windState.phase === WIND_PHASES.BREEZE
  ) {
    phase = windState.phase;
  }

  return { speed, phase };
}

/**
 * Create a muted-by-default procedural Web Audio synthesizer.
 *
 * @param {{ AudioContextCtor?: typeof AudioContext | null }} [options]
 */
export function createAudioSynth(options = {}) {
  const AudioContextCtor =
    options && options.AudioContextCtor !== undefined
      ? options.AudioContextCtor
      : (globalThis.AudioContext || globalThis.webkitAudioContext || null);

  let ctx = null;
  let enabled = false;
  let disposed = false;

  let masterGain = null;
  let noiseBuffer = null;

  let surfSource = null;
  let surfFilter = null;
  let surfGain = null;
  let surfLfo = null;
  let surfLfoGain = null;

  let windSource = null;
  let windFilter = null;
  let windGain = null;

  let lastChargeSweepMs = -Infinity;
  let lastAmbience = { speed: 0, phase: WIND_PHASES.BREEZE };

  function now() {
    if (!ctx || typeof ctx.currentTime !== 'number' || !Number.isFinite(ctx.currentTime)) {
      return 0;
    }
    return Math.max(0, ctx.currentTime);
  }

  function cleanupGraph() {
    const stoppable = [surfSource, surfLfo, windSource];
    for (let i = 0; i < stoppable.length; i++) {
      const node = stoppable[i];
      if (node && typeof node.stop === 'function') {
        try {
          node.stop();
        } catch {
          // Ignore already-stopped source errors
        }
      }
    }

    const disconnectable = [
      surfSource,
      surfFilter,
      surfGain,
      surfLfo,
      surfLfoGain,
      windSource,
      windFilter,
      windGain,
      masterGain,
    ];
    for (let i = 0; i < disconnectable.length; i++) {
      const node = disconnectable[i];
      if (node && typeof node.disconnect === 'function') {
        try {
          node.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      }
    }

    if (ctx && typeof ctx.close === 'function') {
      try {
        Promise.resolve(ctx.close()).catch(() => {});
      } catch {
        // Ignore close errors
      }
    }

    ctx = null;
    masterGain = null;
    noiseBuffer = null;
    surfSource = null;
    surfFilter = null;
    surfGain = null;
    surfLfo = null;
    surfLfoGain = null;
    windSource = null;
    windFilter = null;
    windGain = null;
  }

  function ensureGraph() {
    if (disposed || !AudioContextCtor) {
      return false;
    }
    if (ctx) {
      if (ctx.state === 'closed') {
        cleanupGraph();
      } else {
        return true;
      }
    }

    try {
      ctx = new AudioContextCtor();
      masterGain = ctx.createGain();
      safeSetValueAtTime(masterGain.gain, 0, now());
      masterGain.connect(ctx.destination);

      noiseBuffer = createProceduralNoiseBuffer(ctx);

      // 1. Ocean Surf Bed (lowpass filtered noise + slow 0.15Hz wave swell LFO)
      surfSource = ctx.createBufferSource();
      surfSource.buffer = noiseBuffer;
      surfSource.loop = true;

      surfFilter = ctx.createBiquadFilter();
      surfFilter.type = 'lowpass';
      safeSetValueAtTime(surfFilter.frequency, 320, now());
      safeSetValueAtTime(surfFilter.Q, 0.85, now());

      surfGain = ctx.createGain();
      safeSetValueAtTime(surfGain.gain, 0.09, now());

      surfSource.connect(surfFilter);
      surfFilter.connect(surfGain);
      surfGain.connect(masterGain);

      surfLfo = ctx.createOscillator();
      surfLfo.type = 'sine';
      safeSetValueAtTime(surfLfo.frequency, 0.15, now());

      surfLfoGain = ctx.createGain();
      safeSetValueAtTime(surfLfoGain.gain, 85, now());

      surfLfo.connect(surfLfoGain);
      surfLfoGain.connect(surfFilter.frequency);

      surfSource.start();
      surfLfo.start();

      // 2. Heavy Gale Wind Bed (bandpass noise modulated by wind speed & phase)
      windSource = ctx.createBufferSource();
      windSource.buffer = noiseBuffer;
      windSource.loop = true;

      windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      safeSetValueAtTime(windFilter.frequency, 240, now());
      safeSetValueAtTime(windFilter.Q, 2.8, now());

      windGain = ctx.createGain();
      safeSetValueAtTime(windGain.gain, 0.02, now());

      windSource.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(masterGain);

      windSource.start();
      return true;
    } catch {
      cleanupGraph();
      return false;
    }
  }

  function applyAmbience(speed, phase) {
    if (!enabled || !ctx || ctx.state === 'closed' || disposed || !windFilter || !windGain || !surfFilter || !surfGain) {
      return;
    }

    const t = now();
    const norm = clamp(speed / 12, 0, 1, 0);

    let windFreq = 220 + norm * 320;
    let windVol = 0.02 + norm * 0.06;
    let surfFreq = 270 + norm * 90;
    let surfVol = 0.08 + norm * 0.04;

    if (phase === WIND_PHASES.WARNING) {
      windFreq = 460 + norm * 280;
      windVol = 0.07 + norm * 0.08;
      surfFreq = 320 + norm * 80;
      surfVol = 0.10 + norm * 0.04;
    } else if (phase === WIND_PHASES.GUST) {
      windFreq = 640 + norm * 340;
      windVol = 0.12 + norm * 0.12;
      surfFreq = 360 + norm * 60;
      surfVol = 0.12 + norm * 0.05;
    }

    safeSetTarget(windFilter.frequency, windFreq, t, 0.12);
    safeSetTarget(windGain.gain, windVol, t, 0.12);
    safeSetTarget(surfFilter.frequency, surfFreq, t, 0.18);
    safeSetTarget(surfGain.gain, surfVol, t, 0.18);
  }

  function playTone({
    type = 'sine',
    startFreq = 440,
    endFreq = 220,
    duration = 0.12,
    gainPeak = 0.2,
    delay = 0,
    filterFreq = null,
    exponential = true,
  }) {
    if (!enabled || !ctx || ctx.state === 'closed' || !masterGain || disposed) {
      return;
    }
    const t0 = now() + Math.max(0, delay);
    const dur = Math.max(0.02, duration);

    try {
      const osc = ctx.createOscillator();
      osc.type = type;
      safeSetValueAtTime(osc.frequency, Math.max(20, startFreq), t0);
      safeRamp(osc.frequency, Math.max(20, endFreq), t0 + dur, exponential);

      const gain = ctx.createGain();
      safeSetValueAtTime(gain.gain, 0.0001, t0);
      safeRamp(gain.gain, Math.max(0.001, gainPeak), t0 + Math.min(0.012, dur * 0.2), false);
      safeRamp(gain.gain, 0.0001, t0 + dur, true);

      if (filterFreq && Number.isFinite(filterFreq)) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        safeSetValueAtTime(filter.frequency, filterFreq, t0);
        osc.connect(filter);
        filter.connect(gain);
      } else {
        osc.connect(gain);
      }

      gain.connect(masterGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch {
      // Ignore closed/restricted AudioContext synthesis failures
    }
  }

  function playNoiseBurst({
    filterType = 'bandpass',
    startFreq = 1200,
    endFreq = 500,
    q = 1.6,
    duration = 0.14,
    gainPeak = 0.22,
    delay = 0,
  }) {
    if (!enabled || !ctx || ctx.state === 'closed' || !masterGain || !noiseBuffer || disposed) {
      return;
    }
    const t0 = now() + Math.max(0, delay);
    const dur = Math.max(0.02, duration);

    try {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = filterType;
      safeSetValueAtTime(filter.frequency, Math.max(40, startFreq), t0);
      safeRamp(filter.frequency, Math.max(40, endFreq), t0 + dur, true);
      safeSetValueAtTime(filter.Q, Math.max(0.2, q), t0);

      const gain = ctx.createGain();
      safeSetValueAtTime(gain.gain, 0.0001, t0);
      safeRamp(gain.gain, Math.max(0.001, gainPeak), t0 + Math.min(0.01, dur * 0.18), false);
      safeRamp(gain.gain, 0.0001, t0 + dur, true);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(masterGain);

      src.start(t0);
      src.stop(t0 + dur + 0.02);
    } catch {
      // Ignore closed/restricted AudioContext synthesis failures
    }
  }

  function playHeatSpikeBoom(intensity = 1) {
    const scale = clamp(intensity, 0.4, 1.4, 1);
    // Sub-bass sine drop (145 Hz -> 36 Hz)
    playTone({
      type: 'sine',
      startFreq: 145,
      endFreq: 36,
      duration: 0.34,
      gainPeak: 0.52 * scale,
    });
    // Punchy mid sawtooth crunch through lowpass
    playTone({
      type: 'sawtooth',
      startFreq: 245,
      endFreq: 56,
      duration: 0.19,
      gainPeak: 0.26 * scale,
      filterFreq: 1150,
    });
    // Filtered crack burst
    playNoiseBurst({
      filterType: 'bandpass',
      startFreq: 1900,
      endFreq: 520,
      q: 1.4,
      duration: 0.15,
      gainPeak: 0.30 * scale,
    });
    // Solar flare harmonic accent
    playTone({
      type: 'triangle',
      startFreq: 880,
      endFreq: 1320,
      duration: 0.14,
      gainPeak: 0.11 * scale,
      delay: 0.015,
    });
  }

  function playChargeSweep(ratio) {
    if (!enabled || !ctx || disposed) {
      return;
    }
    const nowMs = getClockMs();
    if (nowMs - lastChargeSweepMs < 40) {
      return;
    }
    lastChargeSweepMs = nowMs;

    const r = clamp(ratio, 0, 1, 0);
    const startFreq = 260 + r * 620;
    const endFreq = Math.min(960, startFreq + 60);
    playTone({
      type: 'triangle',
      startFreq,
      endFreq,
      duration: 0.055,
      gainPeak: 0.06 + r * 0.08,
    });
  }

  function playRefereeWhistle(kind = 'point') {
    if (!enabled || !ctx || ctx.state === 'closed' || !masterGain || disposed) {
      return;
    }

    let blasts;
    if (kind === 'serve') {
      blasts = [{ delay: 0, dur: 0.16 }];
    } else if (kind === 'match') {
      blasts = [
        { delay: 0, dur: 0.13 },
        { delay: 0.18, dur: 0.13 },
        { delay: 0.36, dur: 0.32 },
      ];
    } else {
      blasts = [
        { delay: 0, dur: 0.12 },
        { delay: 0.17, dur: 0.24 },
      ];
    }

    const baseTime = now();
    for (let i = 0; i < blasts.length; i++) {
      const blast = blasts[i];
      const t0 = baseTime + blast.delay;
      const dur = blast.dur;

      try {
        const oscA = ctx.createOscillator();
        const oscB = ctx.createOscillator();
        oscA.type = 'sine';
        oscB.type = 'triangle';
        safeSetValueAtTime(oscA.frequency, 2680, t0);
        safeSetValueAtTime(oscB.frequency, 2840, t0);

        // Pea-trill ~36Hz LFO modulating pitch & amplitude shimmer
        const trillLfo = ctx.createOscillator();
        trillLfo.type = 'sine';
        safeSetValueAtTime(trillLfo.frequency, 36, t0);

        const trillPitchGain = ctx.createGain();
        safeSetValueAtTime(trillPitchGain.gain, 55, t0);

        trillLfo.connect(trillPitchGain);
        trillPitchGain.connect(oscA.frequency);
        trillPitchGain.connect(oscB.frequency);

        const envGain = ctx.createGain();
        safeSetValueAtTime(envGain.gain, 0.0001, t0);
        safeRamp(envGain.gain, 0.14, t0 + 0.012, false);
        safeRamp(envGain.gain, 0.12, t0 + Math.max(0.02, dur - 0.025), false);
        safeRamp(envGain.gain, 0.0001, t0 + dur, true);

        oscA.connect(envGain);
        oscB.connect(envGain);
        envGain.connect(masterGain);

        oscA.start(t0);
        oscB.start(t0);
        trillLfo.start(t0);

        oscA.stop(t0 + dur + 0.02);
        oscB.stop(t0 + dur + 0.02);
        trillLfo.stop(t0 + dur + 0.02);
      } catch {
        // Ignore closed/restricted AudioContext whistle failures
      }
    }
  }

  function playScoreFanfare() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < notes.length; i++) {
      playTone({
        type: 'triangle',
        startFreq: notes[i],
        endFreq: notes[i] * 1.01,
        duration: 0.18,
        gainPeak: 0.12,
        delay: 0.06 + i * 0.065,
      });
    }
  }

  function setEnabled(nextEnabled) {
    if (disposed) {
      return false;
    }
    const want = Boolean(nextEnabled);
    if (want) {
      if (!ensureGraph()) {
        enabled = false;
        return false;
      }
      enabled = true;
      if (
        ctx &&
        (ctx.state === 'suspended' || ctx.state === 'interrupted') &&
        typeof ctx.resume === 'function'
      ) {
        try {
          Promise.resolve(ctx.resume()).catch(() => {});
        } catch {
          // Ignore resume errors in restricted contexts
        }
      }
      if (masterGain) {
        safeSetTarget(masterGain.gain, 0.55, now(), 0.04);
      }
      applyAmbience(lastAmbience.speed, lastAmbience.phase);
      return true;
    }

    enabled = false;
    if (ctx && masterGain) {
      safeSetTarget(masterGain.gain, 0, now(), 0.03);
    }
    return false;
  }

  function toggle() {
    return setEnabled(!enabled);
  }

  function isEnabled() {
    return enabled;
  }

  function updateAmbience(windState) {
    lastAmbience = extractWindTelemetry(windState);
    if (!enabled || !ctx || disposed) {
      return;
    }
    applyAmbience(lastAmbience.speed, lastAmbience.phase);
  }

  function handleEvents(events) {
    if (!enabled || !ctx || disposed || !Array.isArray(events)) {
      return;
    }

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev) {
        continue;
      }
      const type = typeof ev === 'string' ? ev : ev.type;
      const intensity =
        typeof ev === 'object' && ev !== null && Number.isFinite(ev.intensity)
          ? clamp(ev.intensity, 0.25, 1.5, 1)
          : 1;

      switch (type) {
        case EVENTS.SERVE:
          playTone({ type: 'triangle', startFreq: 190, endFreq: 72, duration: 0.13, gainPeak: 0.22 * intensity });
          playRefereeWhistle('serve');
          break;
        case EVENTS.BUMP:
          playTone({ type: 'sine', startFreq: 215, endFreq: 112, duration: 0.10, gainPeak: 0.20 * intensity });
          break;
        case EVENTS.DIVE:
          playNoiseBurst({
            filterType: 'bandpass',
            startFreq: 950,
            endFreq: 360,
            q: 1.2,
            duration: 0.22,
            gainPeak: 0.22 * intensity,
          });
          playTone({ type: 'sine', startFreq: 160, endFreq: 68, duration: 0.13, gainPeak: 0.18 * intensity });
          break;
        case EVENTS.SET:
          playTone({ type: 'sine', startFreq: 380, endFreq: 550, duration: 0.085, gainPeak: 0.16 * intensity });
          break;
        case EVENTS.SPIKE:
          playTone({ type: 'triangle', startFreq: 170, endFreq: 58, duration: 0.16, gainPeak: 0.30 * intensity });
          playNoiseBurst({
            filterType: 'bandpass',
            startFreq: 1450,
            endFreq: 620,
            q: 1.5,
            duration: 0.08,
            gainPeak: 0.18 * intensity,
          });
          break;
        case EVENTS.HEAT_SPIKE:
          playHeatSpikeBoom(intensity);
          break;
        case EVENTS.POKEY_CUT:
          playTone({ type: 'triangle', startFreq: 540, endFreq: 860, duration: 0.09, gainPeak: 0.18 * intensity });
          playNoiseBurst({
            filterType: 'highpass',
            startFreq: 2200,
            endFreq: 1400,
            q: 1.1,
            duration: 0.06,
            gainPeak: 0.12 * intensity,
          });
          break;
        case EVENTS.NET_BLOCK:
          playTone({ type: 'triangle', startFreq: 245, endFreq: 96, duration: 0.12, gainPeak: 0.24 * intensity });
          break;
        case EVENTS.STUFF_BLOCK:
          playTone({
            type: 'sawtooth',
            startFreq: 155,
            endFreq: 44,
            duration: 0.21,
            gainPeak: 0.34 * intensity,
            filterFreq: 850,
          });
          playNoiseBurst({
            filterType: 'bandpass',
            startFreq: 1200,
            endFreq: 420,
            q: 1.5,
            duration: 0.11,
            gainPeak: 0.24 * intensity,
          });
          break;
        case EVENTS.WALL_BOUNCE:
          playTone({ type: 'sine', startFreq: 320, endFreq: 510, duration: 0.11, gainPeak: 0.18 * intensity });
          break;
        case EVENTS.NET_TAPE_HIT:
          playTone({ type: 'triangle', startFreq: 470, endFreq: 380, duration: 0.12, gainPeak: 0.16 * intensity });
          break;
        case EVENTS.NET_MESH_HIT:
          playNoiseBurst({
            filterType: 'bandpass',
            startFreq: 680,
            endFreq: 420,
            q: 1.8,
            duration: 0.10,
            gainPeak: 0.14 * intensity,
          });
          break;
        case EVENTS.SAND_IMPACT:
          playTone({ type: 'sine', startFreq: 112, endFreq: 40, duration: 0.14, gainPeak: 0.22 * intensity });
          playNoiseBurst({
            filterType: 'lowpass',
            startFreq: 540,
            endFreq: 220,
            q: 0.9,
            duration: 0.13,
            gainPeak: 0.16 * intensity,
          });
          break;
        case EVENTS.POINT_SCORED: {
          const isMatchOver = typeof ev === 'object' && ev !== null && Boolean(ev.matchOver);
          playRefereeWhistle(isMatchOver ? 'match' : 'point');
          playScoreFanfare();
          break;
        }
        case EVENTS.GUST_WARNING:
          playTone({ type: 'sine', startFreq: 340, endFreq: 680, duration: 0.26, gainPeak: 0.14 * intensity });
          playNoiseBurst({
            filterType: 'bandpass',
            startFreq: 420,
            endFreq: 860,
            q: 2.6,
            duration: 0.28,
            gainPeak: 0.12 * intensity,
          });
          break;
        case EVENTS.GUST_START:
          playNoiseBurst({
            filterType: 'bandpass',
            startFreq: 340,
            endFreq: 1120,
            q: 2.2,
            duration: 0.44,
            gainPeak: 0.22 * intensity,
          });
          break;
        case EVENTS.CHARGE_TICK: {
          const ratio =
            typeof ev === 'object' && ev !== null
              ? (Number.isFinite(ev.ratio) ? ev.ratio : (Number.isFinite(ev.chargeRatio) ? ev.chargeRatio : 0.5))
              : 0.5;
          playChargeSweep(ratio);
          break;
        }
        default:
          break;
      }
    }
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    enabled = false;
    cleanupGraph();
  }

  return {
    isEnabled,
    toggle,
    setEnabled,
    updateAmbience,
    handleEvents,
    playChargeSweep,
    playRefereeWhistle,
    dispose,
  };
}
