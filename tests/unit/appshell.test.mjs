import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

import {
  EVENTS,
  WIND_PHASES,
  PHYSICS_DEFAULTS,
  PHYSICS_LIMITS,
  STORAGE_KEYS,
  CAMERA_MODES,
  INPUT_MODES,
  MATCH_FORMATS,
  AI_STYLES,
} from '../../src/contracts.js';
import { createAudioSynth } from '../../src/audioSynth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function createMockAudioContextClass() {
  const instances = [];

  class MockAudioParam {
    constructor(initial = 0) {
      this.value = initial;
      this.calls = [];
    }

    setValueAtTime(value, time) {
      this.value = value;
      this.calls.push({ op: 'setValueAtTime', value, time });
    }

    setTargetAtTime(value, time, timeConstant) {
      this.value = value;
      this.calls.push({ op: 'setTargetAtTime', value, time, timeConstant });
    }

    linearRampToValueAtTime(value, time) {
      this.value = value;
      this.calls.push({ op: 'linearRampToValueAtTime', value, time });
    }

    exponentialRampToValueAtTime(value, time) {
      this.value = value;
      this.calls.push({ op: 'exponentialRampToValueAtTime', value, time });
    }
  }

  class MockNode {
    constructor(kind) {
      this.kind = kind;
      this.connections = [];
      this.disconnected = false;
    }

    connect(dest) {
      this.connections.push(dest);
      return dest;
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  class MockGainNode extends MockNode {
    constructor() {
      super('gain');
      this.gain = new MockAudioParam(1);
    }
  }

  class MockBiquadFilterNode extends MockNode {
    constructor() {
      super('biquad');
      this.type = 'lowpass';
      this.frequency = new MockAudioParam(350);
      this.Q = new MockAudioParam(1);
    }
  }

  class MockOscillatorNode extends MockNode {
    constructor() {
      super('oscillator');
      this.type = 'sine';
      this.frequency = new MockAudioParam(440);
      this.started = false;
      this.stopped = false;
      this.startTime = null;
      this.stopTime = null;
    }

    start(t = 0) {
      this.started = true;
      this.startTime = t;
    }

    stop(t = 0) {
      this.stopped = true;
      this.stopTime = t;
    }
  }

  class MockBufferSourceNode extends MockNode {
    constructor() {
      super('bufferSource');
      this.buffer = null;
      this.loop = false;
      this.started = false;
      this.stopped = false;
    }

    start(t = 0) {
      this.started = true;
      this.startTime = t;
    }

    stop(t = 0) {
      this.stopped = true;
      this.stopTime = t;
    }
  }

  class MockAudioContext {
    constructor() {
      this.state = 'suspended';
      this.sampleRate = 44100;
      this.currentTime = 1.0;
      this.destination = new MockNode('destination');
      this.resumeCount = 0;
      this.closeCount = 0;
      this.gains = [];
      this.filters = [];
      this.oscillators = [];
      this.bufferSources = [];
      this.buffers = [];
      instances.push(this);
    }

    createGain() {
      const node = new MockGainNode();
      this.gains.push(node);
      return node;
    }

    createBiquadFilter() {
      const node = new MockBiquadFilterNode();
      this.filters.push(node);
      return node;
    }

    createOscillator() {
      const node = new MockOscillatorNode();
      this.oscillators.push(node);
      return node;
    }

    createBufferSource() {
      const node = new MockBufferSourceNode();
      this.bufferSources.push(node);
      return node;
    }

    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      const buf = {
        numberOfChannels: channels,
        length,
        sampleRate,
        getChannelData: () => data,
      };
      this.buffers.push(buf);
      return buf;
    }

    resume() {
      this.resumeCount += 1;
      this.state = 'running';
      return Promise.resolve();
    }

    close() {
      this.closeCount += 1;
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  return { MockAudioContext, instances };
}

describe('audioSynth.js — muted default, lazy init, headless safety & procedural synthesis', () => {
  it('starts muted and never constructs AudioContext before explicit user gesture', () => {
    const { MockAudioContext, instances } = createMockAudioContextClass();
    const synth = createAudioSynth({ AudioContextCtor: MockAudioContext });

    assert.equal(synth.isEnabled(), false);

    synth.updateAmbience({ speed: 8, phase: WIND_PHASES.GUST, windVec3: { x: 8, y: 0, z: 0 } });
    synth.handleEvents([EVENTS.HEAT_SPIKE, { type: EVENTS.POINT_SCORED }, EVENTS.SERVE]);
    synth.playChargeSweep(0.8);
    synth.playRefereeWhistle('point');

    assert.equal(instances.length, 0, 'AudioContext must not be constructed while muted');
    assert.equal(synth.isEnabled(), false);

    synth.dispose();
  });

  it('handles missing AudioContext cleanly in headless/Node environments without throwing', () => {
    const synth = createAudioSynth({ AudioContextCtor: null });

    assert.equal(synth.isEnabled(), false);
    assert.equal(synth.toggle(), false);
    assert.equal(synth.setEnabled(true), false);
    assert.equal(synth.isEnabled(), false);

    assert.doesNotThrow(() => {
      synth.updateAmbience({ speed: 5, phase: WIND_PHASES.WARNING });
      synth.handleEvents(Object.values(EVENTS));
      synth.playChargeSweep(0.5);
      synth.playRefereeWhistle('match');
      synth.setEnabled(false);
      synth.dispose();
      synth.dispose();
    });
  });

  it('lazily constructs surf + gale graph on enable, resumes suspended context, and modulates wind ambience', () => {
    const { MockAudioContext, instances } = createMockAudioContextClass();
    const synth = createAudioSynth({ AudioContextCtor: MockAudioContext });

    const enabledNow = synth.toggle();
    assert.equal(enabledNow, true);
    assert.equal(synth.isEnabled(), true);
    assert.equal(instances.length, 1);

    const ctx = instances[0];
    assert.equal(ctx.resumeCount, 1);
    assert.equal(ctx.buffers.length, 1);
    assert.equal(ctx.buffers[0].length, 44100 * 2);

    const surfFilter = ctx.filters.find((f) => f.type === 'lowpass');
    const windFilter = ctx.filters.find((f) => f.type === 'bandpass');
    assert.ok(surfFilter, 'lowpass ocean surf filter should be created');
    assert.ok(windFilter, 'bandpass gale wind filter should be created');
    assert.equal(ctx.bufferSources.filter((s) => s.loop && s.started).length, 2);

    // Modulate BREEZE -> WARNING -> GUST
    synth.updateAmbience({ speed: 1.5, phase: WIND_PHASES.BREEZE });
    const breezeFreq = windFilter.frequency.value;

    synth.updateAmbience({ speed: 6.0, phase: WIND_PHASES.WARNING });
    const warningFreq = windFilter.frequency.value;

    synth.updateAmbience({ windVec3: { x: 10, y: 0, z: 3 }, phase: WIND_PHASES.GUST });
    const gustFreq = windFilter.frequency.value;

    assert.ok(warningFreq > breezeFreq, 'WARNING wind cutoff should exceed BREEZE');
    assert.ok(gustFreq > warningFreq, 'GUST wind cutoff should exceed WARNING');

    // Guard null/invalid windState
    assert.doesNotThrow(() => {
      synth.updateAmbience(null);
      synth.updateAmbience({ speed: Number.NaN, phase: 'UNKNOWN' });
    });

    // Disabling ramps master gain to 0 cleanly
    assert.equal(synth.setEnabled(false), false);
    assert.equal(synth.isEnabled(), false);
    const masterGain = ctx.gains[0];
    const lastMasterCall = masterGain.gain.calls.at(-1);
    assert.equal(lastMasterCall.value, 0);

    // Dispose stops persistent sources, closes context, and is idempotent
    synth.dispose();
    assert.equal(ctx.closeCount, 1);
    assert.equal(ctx.bufferSources.every((s) => s.stopped), true);
    synth.dispose();
    assert.equal(ctx.closeCount, 1);
  });

  it('synthesizes all 17 contract EVENTS (string and object forms), charge sweep, and referee whistle kinds', () => {
    const { MockAudioContext, instances } = createMockAudioContextClass();
    const synth = createAudioSynth({ AudioContextCtor: MockAudioContext });
    synth.setEnabled(true);
    const ctx = instances[0];

    const allEvents = Object.values(EVENTS);
    assert.equal(allEvents.length, 17);

    // Pass string events
    const oscBeforeStrings = ctx.oscillators.length;
    const bufBeforeStrings = ctx.bufferSources.length;
    synth.handleEvents(allEvents);
    assert.ok(ctx.oscillators.length > oscBeforeStrings + 10, 'string events should synthesize tones');
    assert.ok(ctx.bufferSources.length > bufBeforeStrings + 4, 'string events should synthesize noise bursts');

    // Pass object events
    const objectEvents = allEvents.map((type) => ({
      type,
      intensity: 1.1,
      ratio: 0.75,
      matchOver: type === EVENTS.POINT_SCORED,
    }));
    const oscBeforeObjs = ctx.oscillators.length;
    synth.handleEvents(objectEvents);
    assert.ok(ctx.oscillators.length > oscBeforeObjs + 10, 'object events should synthesize tones');

    // Non-array events safely ignored
    assert.doesNotThrow(() => {
      synth.handleEvents(null);
      synth.handleEvents('HEAT_SPIKE');
    });

    // Referee whistle kinds: serve (1 blast * 3 oscs), point (2 * 3), match (3 * 3)
    const beforeServe = ctx.oscillators.length;
    synth.playRefereeWhistle('serve');
    assert.equal(ctx.oscillators.length - beforeServe, 3);

    const beforePoint = ctx.oscillators.length;
    synth.playRefereeWhistle('point');
    assert.equal(ctx.oscillators.length - beforePoint, 6);

    const beforeMatch = ctx.oscillators.length;
    synth.playRefereeWhistle('match');
    assert.equal(ctx.oscillators.length - beforeMatch, 9);

    // Charge sweep produces tone (first call after rate-limit window) and tolerates out-of-range inputs
    assert.doesNotThrow(() => {
      synth.playChargeSweep(0.0);
      synth.playChargeSweep(1.5);
      synth.playChargeSweep(Number.NaN);
    });

    synth.dispose();
  });
});

describe('manifest.json — PWA metadata & verbatim v1 SVG icon parity', () => {
  it('validates manifest fields, zero external URLs, and exact icon parity with classic-2d/manifest.json', () => {
    const rootRaw = fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8');
    const classicRaw = fs.readFileSync(path.join(REPO_ROOT, 'classic-2d', 'manifest.json'), 'utf8');

    const rootManifest = JSON.parse(rootRaw);
    const classicManifest = JSON.parse(classicRaw);

    assert.equal(rootManifest.name, 'SUMMER HEAT 3D');
    assert.equal(rootManifest.short_name, 'SummerHeat3D');
    assert.equal(rootManifest.start_url, './index.html');
    assert.equal(rootManifest.scope, './');
    assert.equal(rootManifest.display, 'fullscreen');
    assert.equal(rootManifest.orientation, 'landscape');
    assert.equal(rootManifest.background_color, '#120b24');
    assert.equal(rootManifest.theme_color, '#ff6a2b');

    assert.ok(Array.isArray(rootManifest.icons) && rootManifest.icons.length >= 1);
    assert.deepStrictEqual(rootManifest.icons[0], classicManifest.icons[0]);
    assert.equal(rootManifest.icons[0].src, classicManifest.icons[0].src);
    assert.equal(rootManifest.icons[0].sizes, '128x128');
    assert.equal(rootManifest.icons[0].type, 'image/svg+xml');
    assert.equal(rootManifest.icons[0].purpose, 'any maskable');

    // Ensure zero external network URLs (SVG xmlns inside data URI is an XML namespace, not a network URL)
    const withoutSvgXmlns = rootRaw.replaceAll("xmlns='http://www.w3.org/2000/svg'", '');
    assert.equal(/https?:\/\//i.test(withoutSvgXmlns), false, 'manifest.json must not contain external URLs');
  });
});

describe('sw.js — Stale-While-Revalidate cache lifecycle & offline fallbacks', () => {
  function loadSwSandbox({ initialCaches = {}, fetchImpl }) {
    const cacheMap = new Map();
    for (const [name, entries] of Object.entries(initialCaches)) {
      cacheMap.set(name, new Map(Object.entries(entries)));
    }

    const listeners = new Map();
    let skipWaitingCalls = 0;
    let clientsClaimCalls = 0;

    function normalizeKey(req) {
      const rawUrl = typeof req === 'string' ? req : req.url;
      if (rawUrl.startsWith('./')) {
        return rawUrl;
      }
      try {
        const u = new URL(rawUrl, 'http://127.0.0.1:8080/');
        if (u.pathname === '/') {
          return './';
        }
        return `.${u.pathname}`;
      } catch {
        return rawUrl;
      }
    }

    const cachesMock = {
      open: async (name) => {
        if (!cacheMap.has(name)) {
          cacheMap.set(name, new Map());
        }
        const bucket = cacheMap.get(name);
        return {
          addAll: async (urls) => {
            for (const u of urls) {
              bucket.set(u, new Response(`cached:${u}`, { status: 200 }));
            }
          },
          put: async (req, resp) => {
            bucket.set(normalizeKey(req), resp);
          },
        };
      },
      keys: async () => Array.from(cacheMap.keys()),
      delete: async (name) => cacheMap.delete(name),
      match: async (req) => {
        const key = normalizeKey(req);
        for (const bucket of cacheMap.values()) {
          if (bucket.has(key)) {
            return bucket.get(key);
          }
        }
        return undefined;
      },
    };

    const selfMock = {
      location: new URL('http://127.0.0.1:8080/sw.js'),
      addEventListener: (name, fn) => listeners.set(name, fn),
      skipWaiting: async () => {
        skipWaitingCalls += 1;
      },
      clients: {
        claim: async () => {
          clientsClaimCalls += 1;
        },
      },
    };

    const swSource = fs.readFileSync(path.join(REPO_ROOT, 'sw.js'), 'utf8');
    const context = vm.createContext({
      self: selfMock,
      caches: cachesMock,
      fetch: fetchImpl || (async () => new Response('network', { status: 200 })),
      URL,
      Response,
      Promise,
    });
    vm.runInContext(swSource, context, { filename: 'sw.js' });

    return {
      listeners,
      cacheMap,
      getSkipWaitingCalls: () => skipWaitingCalls,
      getClientsClaimCalls: () => clientsClaimCalls,
    };
  }

  it('installs summer-heat-3d-v2 with all 16 exact precache URLs and skips waiting', async () => {
    const sb = loadSwSandbox({});
    const waited = [];
    sb.listeners.get('install')({
      waitUntil: (p) => waited.push(p),
    });
    await Promise.all(waited);

    assert.equal(sb.getSkipWaitingCalls(), 1);
    assert.ok(sb.cacheMap.has('summer-heat-3d-v2'));

    const expectedUrls = [
      './',
      './index.html',
      './manifest.json',
      './vendor/three.module.min.js',
      './src/contracts.js',
      './src/physics3d.js',
      './src/playerRigs.js',
      './src/courtScene.js',
      './src/inputManager.js',
      './src/rallyEngine.js',
      './src/audioSynth.js',
      './src/main.js',
      './classic-2d/',
      './classic-2d/index.html',
      './classic-2d/game.js',
      './classic-2d/manifest.json',
    ];
    const cachedKeys = Array.from(sb.cacheMap.get('summer-heat-3d-v2').keys());
    assert.deepStrictEqual(cachedKeys, expectedUrls);
  });

  it('activates by deleting neon-volley-heavy-gale-v1 and stale caches while preserving v2 and claiming clients', async () => {
    const sb = loadSwSandbox({
      initialCaches: {
        'neon-volley-heavy-gale-v1': { './': new Response('old') },
        'summer-heat-3d-v2': { './': new Response('v2') },
        'stale-other-cache': { './': new Response('stale') },
      },
    });
    const waited = [];
    sb.listeners.get('activate')({
      waitUntil: (p) => waited.push(p),
    });
    await Promise.all(waited);

    assert.equal(sb.getClientsClaimCalls(), 1);
    assert.deepStrictEqual(Array.from(sb.cacheMap.keys()), ['summer-heat-3d-v2']);
  });

  it('serves Stale-While-Revalidate on cache hit, updates cache in background, and falls back offline on navigation miss', async () => {
    let networkCalls = 0;
    const sb = loadSwSandbox({
      initialCaches: {
        'summer-heat-3d-v2': {
          './index.html': new Response('stale-index', { status: 200 }),
          './classic-2d/index.html': new Response('stale-classic', { status: 200 }),
        },
      },
      fetchImpl: async (req) => {
        networkCalls += 1;
        if (req.url.includes('offline-fail')) {
          throw new Error('Network offline');
        }
        return new Response(`fresh:${req.url}`, { status: 200 });
      },
    });

    // 1. Cache HIT -> returns stale immediately AND updates cache via waitUntil
    let responded = null;
    const bgWaits = [];
    sb.listeners.get('fetch')({
      request: { method: 'GET', url: 'http://127.0.0.1:8080/index.html', mode: 'navigate' },
      respondWith: (p) => { responded = p; },
      waitUntil: (p) => bgWaits.push(p),
    });
    const hitResp = await responded;
    assert.equal(await hitResp.text(), 'stale-index');
    await Promise.all(bgWaits);
    assert.equal(networkCalls, 1);
    assert.equal(await sb.cacheMap.get('summer-heat-3d-v2').get('./index.html').text(), 'fresh:http://127.0.0.1:8080/index.html');

    // 2. Cache MISS while online -> fetches network & caches it
    responded = null;
    sb.listeners.get('fetch')({
      request: { method: 'GET', url: 'http://127.0.0.1:8080/src/contracts.js', mode: 'cors' },
      respondWith: (p) => { responded = p; },
      waitUntil: () => {},
    });
    const missOnlineResp = await responded;
    assert.equal(await missOnlineResp.text(), 'fresh:http://127.0.0.1:8080/src/contracts.js');
    // Let cache.put microtask settle
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(sb.cacheMap.get('summer-heat-3d-v2').has('./src/contracts.js'));

    // 3. Cache MISS while offline on root navigation -> falls back to ./index.html
    responded = null;
    sb.listeners.get('fetch')({
      request: { method: 'GET', url: 'http://127.0.0.1:8080/offline-fail', mode: 'navigate' },
      respondWith: (p) => { responded = p; },
      waitUntil: () => {},
    });
    const fallbackRoot = await responded;
    assert.equal(fallbackRoot.status, 200);

    // 4. Cache MISS while offline on /classic-2d/ navigation -> falls back to ./classic-2d/index.html
    responded = null;
    sb.listeners.get('fetch')({
      request: { method: 'GET', url: 'http://127.0.0.1:8080/classic-2d/offline-fail', mode: 'navigate' },
      respondWith: (p) => { responded = p; },
      waitUntil: () => {},
    });
    const fallbackClassic = await responded;
    assert.equal(await fallbackClassic.text(), 'stale-classic');

    // 5. Non-GET and cross-origin requests are ignored (respondWith NOT invoked)
    let ignoredCalled = false;
    sb.listeners.get('fetch')({
      request: { method: 'POST', url: 'http://127.0.0.1:8080/index.html' },
      respondWith: () => { ignoredCalled = true; },
    });
    sb.listeners.get('fetch')({
      request: { method: 'GET', url: 'https://external.example.com/script.js' },
      respondWith: () => { ignoredCalled = true; },
    });
    assert.equal(ignoredCalled, false);
  });
});

describe('index.html & src/main.js — DOM contracts, DAG hygiene & zero-CDN compliance', () => {
  const indexHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  const mainJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main.js'), 'utf8');
  const audioJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'audioSynth.js'), 'utf8');
  const swJs = fs.readFileSync(path.join(REPO_ROOT, 'sw.js'), 'utf8');

  it('contains zero external http(s):// URLs or CDN links across M4 runtime files', () => {
    for (const [name, content] of [
      ['index.html', indexHtml],
      ['src/main.js', mainJs],
      ['src/audioSynth.js', audioJs],
      ['sw.js', swJs],
    ]) {
      assert.equal(/https?:\/\//i.test(content), false, `${name} must contain zero external http(s):// URLs`);
    }
  });

  it('includes module script entry, manifest link, Classic 2D switcher, responsive @media, and all required IDs/data-testids', () => {
    assert.match(indexHtml, /<link\s+rel="manifest"\s+href="\.\/manifest\.json">/);
    assert.match(indexHtml, /<script\s+type="module"\s+src="\.\/src\/main\.js"><\/script>/);
    assert.match(indexHtml, /@media\s*\(max-width:/);
    assert.match(indexHtml, /href="\.\/classic-2d\/index\.html"[^>]*>\[Play Classic 2D\]<\/a>/);

    const requiredIds = [
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
    for (const id of requiredIds) {
      assert.ok(indexHtml.includes(`id="${id}"`), `Missing required element id="${id}"`);
    }

    const requiredTestIds = [
      'game-canvas',
      'score-t1',
      'score-t2',
      'touch-indicator',
      'heat-bar-t1',
      'heat-bar-t2',
      'wind-readout',
      'camera-toggle',
      'format-toggle',
      'ai-style-select',
      'mode-1pad',
      'mode-2pad',
      'mode-touch',
      'quick-bind-btn',
      'audio-toggle',
      'physics-lab-btn',
      'classic-2d-link',
      'reset-match-btn',
      'rally-banner',
      'controls-hint',
      'physics-drawer',
      'close-drawer-btn',
      'slider-gravity',
      'slider-drag',
      'slider-magnus',
      'slider-gust',
      'slider-speed',
      'reset-physics-btn',
      'force-gust-btn',
      'quick-bind-modal',
      'quick-bind-prompt',
      'quick-bind-countdown',
      'quick-bind-cancel',
      'quick-bind-reset',
      'portrait-overlay',
    ];
    for (const testId of requiredTestIds) {
      assert.ok(indexHtml.includes(`data-testid="${testId}"`), `Missing required data-testid="${testId}"`);
    }

    // Verify SI slider bounds match PHYSICS_LIMITS and PHYSICS_DEFAULTS
    const sliderExpectations = [
      ['sliderGravity', 'gravity'],
      ['sliderDrag', 'kDrag'],
      ['sliderMagnus', 'kMagnus'],
      ['sliderGust', 'gustScale'],
      ['sliderSpeed', 'gameSpeed'],
    ];
    for (const [id, key] of sliderExpectations) {
      const [min, max, step] = PHYSICS_LIMITS[key];
      const def = PHYSICS_DEFAULTS[key];
      const tagMatch = indexHtml.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
      assert.ok(tagMatch, `Expected <input> for ${id}`);
      const tag = tagMatch[0];
      assert.equal(Number(tag.match(/min="([^"]+)"/)[1]), min);
      assert.equal(Number(tag.match(/max="([^"]+)"/)[1]), max);
      assert.equal(Number(tag.match(/step="([^"]+)"/)[1]), step);
      assert.equal(Number(tag.match(/value="([^"]+)"/)[1]), def);
    }
  });

  it('obeys acyclic DAG imports, isolates v2 storage, guards Wake Lock & SW, and exposes read-only debug telemetry', () => {
    const audioImports = [...audioJs.matchAll(/import\s+[^'"]+from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepStrictEqual(audioImports, ['./contracts.js']);

    const mainImports = [...mainJs.matchAll(/import\s+[^'"]+from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepStrictEqual(mainImports.sort(), [
      './audioSynth.js',
      './contracts.js',
      './courtScene.js',
      './inputManager.js',
      './physics3d.js',
      './rallyEngine.js',
    ]);

    assert.equal(mainJs.includes('neon_volley_heavy_gale_physics_v1'), false, 'must never touch v1 storage key');
    assert.ok(mainJs.includes('STORAGE_KEYS.PHYSICS'));
    assert.ok(mainJs.includes('STORAGE_KEYS.BINDINGS'));
    assert.ok(mainJs.includes('STORAGE_KEYS.SETTINGS'));
    assert.ok(mainJs.includes('__SUMMER_HEAT_DEBUG__'));
    assert.ok(mainJs.includes("register('./sw.js')"));
    assert.ok(mainJs.includes("request('screen')"));
    assert.ok(mainJs.includes('visibilitychange'));
  });
});

describe('src/main.js — live initApp() wiring, HUD sync, storage preservation, Wake Lock & Portrait Auto-Pause', () => {
  // Stub any M1-M3 sibling modules ONLY if they do not exist on disk yet
  const stubbedSpecifiers = new Map([
    ['./physics3d.js', 'export const FIXED_DT = 1 / 120;'],
    ['./courtScene.js', 'export function createCourtScene() { return {}; }'],
    ['./inputManager.js', 'export function createInputManager() { return {}; }'],
    ['./rallyEngine.js', 'export function createRallyEngine() { return {}; }'],
  ]);

  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        stubbedSpecifiers.has(specifier) &&
        context.parentURL &&
        context.parentURL.endsWith('/src/main.js')
      ) {
        const candidatePath = path.resolve(REPO_ROOT, 'src', specifier);
        if (!fs.existsSync(candidatePath)) {
          return {
            url: `summer-heat-stub:${specifier}`,
            shortCircuit: true,
          };
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith('summer-heat-stub:')) {
        const key = url.slice('summer-heat-stub:'.length);
        return {
          format: 'module',
          source: stubbedSpecifiers.get(key),
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });

  after(() => {
    hook.deregister();
  });

  function createMockDom() {
    const elements = new Map();
    const makeEl = (id) => {
      const listeners = new Map();
      const classes = new Set();
      const attrs = new Map();
      const el = {
        id,
        textContent: '',
        value: '',
        hidden: false,
        style: {},
        classList: {
          toggle: (cls, force) => {
            const on = force !== undefined ? Boolean(force) : !classes.has(cls);
            if (on) classes.add(cls);
            else classes.delete(cls);
          },
          contains: (cls) => classes.has(cls),
        },
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => attrs.get(k) ?? null,
        addEventListener: (ev, fn) => {
          if (!listeners.has(ev)) listeners.set(ev, []);
          listeners.get(ev).push(fn);
        },
        removeEventListener: (ev, fn) => {
          const list = listeners.get(ev);
          if (!list) return;
          const idx = list.indexOf(fn);
          if (idx >= 0) list.splice(idx, 1);
        },
        dispatch: (ev, eventObj = {}) => {
          const list = listeners.get(ev) || [];
          for (const fn of [...list]) {
            fn({ target: el, ...eventObj });
          }
        },
      };
      elements.set(id, el);
      return el;
    };

    const ids = [
      'gameCanvas', 'scoreT1', 'scoreT2', 'touchIndicator', 'heatBarT1', 'heatBarT2',
      'windReadout', 'rallyBanner', 'controlsHint', 'cameraToggleBtn', 'formatToggleBtn',
      'aiStyleSelect', 'mode1PadBtn', 'mode2PadBtn', 'modeTouchBtn', 'quickBindBtn',
      'audioToggleBtn', 'physicsLabBtn', 'resetMatchBtn', 'physicsDrawer', 'closeDrawerBtn',
      'resetPhysicsBtn', 'forceGustBtn', 'sliderGravity', 'sliderDrag', 'sliderMagnus',
      'sliderGust', 'sliderSpeed', 'valGravity', 'valDrag', 'valMagnus', 'valGust', 'valSpeed',
      'quickBindModal', 'quickBindPrompt', 'quickBindCountdown', 'quickBindCancelBtn',
      'quickBindResetBtn', 'portraitOverlay',
    ];
    for (const id of ids) makeEl(id);

    const docListeners = new Map();
    const doc = {
      readyState: 'complete',
      visibilityState: 'visible',
      getElementById: (id) => elements.get(id) || null,
      addEventListener: (ev, fn) => {
        if (!docListeners.has(ev)) docListeners.set(ev, []);
        docListeners.get(ev).push(fn);
      },
      removeEventListener: (ev, fn) => {
        const list = docListeners.get(ev) || [];
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      },
      dispatch: (ev) => {
        for (const fn of [...(docListeners.get(ev) || [])]) fn({});
      },
    };

    const winListeners = new Map();
    const win = {
      innerWidth: 1280,
      innerHeight: 720,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      addEventListener: (ev, fn) => {
        if (!winListeners.has(ev)) winListeners.set(ev, []);
        winListeners.get(ev).push(fn);
      },
      removeEventListener: (ev, fn) => {
        const list = winListeners.get(ev) || [];
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      },
      dispatch: (ev) => {
        for (const fn of [...(winListeners.get(ev) || [])]) fn({});
      },
    };

    return { elements, doc, win };
  }

  it('wires HUD controls, preserves non-slider physics keys, handles Portrait Auto-Pause, Quick-Bind, Wake Lock & debug hook', async () => {
    globalThis.__SUMMER_HEAT_NO_AUTO_INIT__ = true;
    const mainModuleUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'main.js')).href;
    const { initApp } = await import(mainModuleUrl);

    const { elements, doc, win } = createMockDom();
    const store = new Map([
      [STORAGE_KEYS.PHYSICS, JSON.stringify({ gravity: 13.0, eWall: 0.91 })],
    ]);
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    };

    let swRegistered = null;
    let wakeLockCalls = 0;
    const nav = {
      serviceWorker: {
        register: (url) => {
          swRegistered = url;
          return Promise.resolve();
        },
      },
      wakeLock: {
        request: () => {
          wakeLockCalls += 1;
          return Promise.reject(Object.assign(new Error('NotAllowed'), { name: 'NotAllowedError' }));
        },
      },
    };

    const resizeLog = [];
    const renderLog = [];
    const punchLog = [];
    let currentPaused = false;
    let currentFormat = MATCH_FORMATS.ONE_V_ONE;
    let currentAi = AI_STYLES.WIND_LOBBER;
    let gustTriggers = 0;
    let currentMode = INPUT_MODES.TWO_PAD_KEYBOARD;
    let quickBindCallbacks = null;

    const snapshot = {
      ball: { pos: { x: 0, y: 2, z: 0 } },
      wind: { speed: 9.4, phase: WIND_PHASES.GUST, windVec3: { x: 9.4, y: 0, z: 0 } },
      players: [{ team: 1, isHuman: true, heatMeter: 1.0, chargeRatio: 0.5 }],
      scoreboard: {
        scoreT1: 4,
        scoreT2: 2,
        touchCount: 2,
        activeTeam: 1,
        heatT1: 1.0,
        heatT2: 0.35,
        windPhase: WIND_PHASES.GUST,
        windSpeedMs: 9.4,
        bannerText: 'HEAT SPIKE!',
        bannerTimer: 1.2,
      },
      cameraPunch: 0.9,
      events: [{ type: EVENTS.HEAT_SPIKE }],
    };

    const { MockAudioContext } = createMockAudioContextClass();

    const app = initApp({
      window: win,
      document: doc,
      navigator: nav,
      storage,
      createCourtScene: () => ({
        syncState: () => {},
        render: (mode) => renderLog.push(mode),
        resize: (w, h) => resizeLog.push([w, h]),
        triggerCameraPunch: (val) => punchLog.push(val),
        dispose: () => {},
      }),
      createInputManager: () => ({
        setMode: (m) => { currentMode = m; },
        getMode: () => currentMode,
        pollInputs: () => ({ mode: currentMode }),
        getBindings: () => ({ deadzone: 0.16 }),
        setBindings: () => {},
        resetBindings: () => {},
        startQuickBind: (onUpdate, onDone) => { quickBindCallbacks = { onUpdate, onDone }; },
        cancelQuickBind: () => {},
        destroy: () => {},
      }),
      createRallyEngine: () => ({
        update: () => snapshot.events,
        getSnapshot: () => snapshot,
        setFormat: (f) => { currentFormat = f; },
        setAiStyle: (s) => { currentAi = s; },
        triggerGust: () => { gustTriggers += 1; },
        resetMatch: () => {},
        setPaused: (p) => { currentPaused = Boolean(p); },
      }),
      createAudioSynth: () => createAudioSynth({ AudioContextCtor: MockAudioContext }),
    });

    assert.equal(swRegistered, './sw.js');
    assert.ok(Object.isFrozen(win.__SUMMER_HEAT_DEBUG__));
    assert.equal(win.__SUMMER_HEAT_DEBUG__.getCameraMode(), CAMERA_MODES.BROADCAST);
    assert.equal(win.__SUMMER_HEAT_DEBUG__.getInputMode(), INPUT_MODES.TWO_PAD_KEYBOARD);
    assert.equal(win.__SUMMER_HEAT_DEBUG__.getAudioEnabled(), false);
    assert.equal(win.__SUMMER_HEAT_DEBUG__.isPaused(), false);
    assert.equal(win.__SUMMER_HEAT_DEBUG__.getPhysicsConfig().gravity, 13.0);
    assert.equal(win.__SUMMER_HEAT_DEBUG__.getPhysicsConfig().eWall, 0.91);

    // Step one frame -> HUD, camera punch, and render update
    app.stepFrame(16.67);
    assert.equal(elements.get('scoreT1').textContent, '4');
    assert.equal(elements.get('scoreT2').textContent, '2');
    assert.equal(elements.get('touchIndicator').textContent, 'T1 · TOUCH 2/3');
    assert.equal(elements.get('heatBarT1').style.width, '100%');
    assert.equal(elements.get('heatBarT1').classList.contains('heat-max'), true);
    assert.match(elements.get('windReadout').textContent, /9\.4 m\/s · GUST/);
    assert.equal(elements.get('rallyBanner').hidden, false);
    assert.equal(punchLog.length, 1);
    assert.equal(renderLog.at(-1), CAMERA_MODES.BROADCAST);

    // Camera toggle -> Split Screen
    elements.get('cameraToggleBtn').dispatch('click');
    assert.equal(win.__SUMMER_HEAT_DEBUG__.getCameraMode(), CAMERA_MODES.SPLIT_SCREEN);
    assert.equal(elements.get('cameraToggleBtn').textContent, '2P Split-Screen');

    // Format toggle & AI select & Force Gust
    elements.get('formatToggleBtn').dispatch('click');
    assert.equal(currentFormat, MATCH_FORMATS.TWO_V_TWO);
    elements.get('aiStyleSelect').value = AI_STYLES.SPIN_SLICER;
    elements.get('aiStyleSelect').dispatch('change');
    assert.equal(currentAi, AI_STYLES.SPIN_SLICER);
    elements.get('forceGustBtn').dispatch('click');
    assert.equal(gustTriggers, 1);

    // Slider input preserves non-slider field eWall (0.91)
    elements.get('sliderGravity').value = '15.4';
    elements.get('sliderGravity').dispatch('input');
    const savedPhys = JSON.parse(store.get(STORAGE_KEYS.PHYSICS));
    assert.equal(savedPhys.gravity, 15.4);
    assert.equal(savedPhys.eWall, 0.91);

    // Audio toggle enables sound lazily on gesture
    elements.get('audioToggleBtn').dispatch('click');
    assert.equal(win.__SUMMER_HEAT_DEBUG__.getAudioEnabled(), true);
    assert.equal(elements.get('audioToggleBtn').textContent, '[🔊 SOUND: ON]');

    // Wake Lock attempt on pointerdown (silently ignores NotAllowedError) + re-acquire on visibilitychange
    win.dispatch('pointerdown');
    assert.equal(wakeLockCalls, 1);
    doc.dispatch('visibilitychange');
    assert.equal(wakeLockCalls, 2);

    // Portrait Auto-Pause (390x844 -> paused; 844x390 -> resumed)
    win.innerWidth = 390;
    win.innerHeight = 844;
    win.dispatch('resize');
    assert.equal(currentPaused, true);
    assert.equal(win.__SUMMER_HEAT_DEBUG__.isPaused(), true);
    assert.equal(elements.get('portraitOverlay').hidden, false);

    win.innerWidth = 844;
    win.innerHeight = 390;
    win.dispatch('resize');
    assert.equal(currentPaused, false);
    assert.equal(elements.get('portraitOverlay').hidden, true);
    assert.deepStrictEqual(resizeLog.at(-1), [844, 390]);

    // Quick-Bind pauses and resumes on done
    elements.get('quickBindBtn').dispatch('click');
    assert.equal(currentPaused, true);
    assert.equal(elements.get('quickBindModal').hidden, false);
    quickBindCallbacks.onUpdate({ label: 'Press P1 Primary', remaining: 2.4 });
    assert.equal(elements.get('quickBindPrompt').textContent, 'Press P1 Primary');
    assert.equal(elements.get('quickBindCountdown').textContent, '2.4s');
    quickBindCallbacks.onDone();
    assert.equal(currentPaused, false);
    assert.equal(elements.get('quickBindModal').hidden, true);

    app.destroy();
  });
});
