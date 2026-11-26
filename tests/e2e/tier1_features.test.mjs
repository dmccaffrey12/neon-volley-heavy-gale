/**
 * Tier 1 — Category-Partition Feature Coverage (Opaque-Box E2E Suite)
 *
 * Covers Areas A-F (34 tests total, >= 5 per major feature area) strictly
 * derived from ORIGINAL_REQUEST.md, PROJECT.md, AGENTS.md, and src/contracts.js.
 *
 * Zero mocks of game/physics/rig/Three.js modules. Target M1-M4 modules are
 * dynamically imported in each describe's before() hook WITHOUT swallowing
 * ERR_MODULE_NOT_FOUND so missing modules fail loudly (never silently skipped).
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Contracts from '../../src/contracts.js';
import * as THREE from '../../vendor/three.module.min.js';
import {
  installInputShims,
  installAudioContextSpy,
  createMockGamepad,
  readScores,
  readTimingRing,
  readTouchCount,
  extractEventTypes,
  makeIdleInputs,
  makePlayerCmd,
  assertFiniteVec3,
  createBotController,
} from './_helpers/browserShims.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const {
  FIXED_DT,
  MAX_PREDICT_STEPS,
  COORDINATE_SYSTEM,
  COURT,
  BALL_SPEC,
  PHYSICS_DEFAULTS,
  PHYSICS_LIMITS,
  STORAGE_KEYS,
  INPUT_MODES,
  CAMERA_MODES,
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
  createPlayerState,
  createDefaultBindings,
} = Contracts;

function assertDeepFrozen(obj, label) {
  assert.ok(Object.isFrozen(obj), `${label} must be frozen`);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === 'object') {
      assertDeepFrozen(val, `${label}.${key}`);
    }
  }
}

function stripJsComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

function extractModuleSpecifiers(code) {
  const clean = stripJsComments(code);
  const specifiers = [];
  const re = /(?:^|[;\n])\s*(?:import|export)\s*(?:(?:\*\s+as\s+[\w$]+|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*)?['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(clean)) !== null) {
    specifiers.push(m[1]);
  }
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(clean)) !== null) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

function findExternalUrls(text) {
  // Strip inline SVG XML namespace declarations (standard non-network identifier in SVG data URIs)
  const sanitized = text.replace(/https?:\/\/www\.w3\.org\/2000\/svg/g, '');
  const matches = sanitized.match(/https?:\/\/[^\s'"`<>)]+/gi) || [];
  return matches;
}

/* ========================================================================== *
 * AREA A — M0 Contracts, Static DAG, Offline PWA & Classic 2D Hygiene
 * ========================================================================== */
describe('Tier 1 — Area A: M0 Contracts, Static DAG, Offline PWA & Classic 2D Hygiene', () => {
  it('T1-A1: Frozen contracts & state factories uphold schema and v2 storage isolation', () => {
    assert.equal(FIXED_DT, 1 / 120);
    assert.equal(MAX_PREDICT_STEPS, 180);

    const frozenExports = {
      COORDINATE_SYSTEM,
      COURT,
      BALL_SPEC,
      PHYSICS_DEFAULTS,
      PHYSICS_LIMITS,
      STORAGE_KEYS,
      INPUT_MODES,
      CAMERA_MODES,
      AI_STYLES,
      MATCH_FORMATS,
      ANIM_STATES,
      WIND_PHASES,
      TRAIL_MODES,
      SHOT_TYPES,
      EVENTS,
    };
    for (const [name, obj] of Object.entries(frozenExports)) {
      assertDeepFrozen(obj, name);
    }

    assert.equal(Object.keys(ANIM_STATES).length, 7);
    assert.equal(Object.keys(EVENTS).length, 17);
    for (const [k, v] of Object.entries(EVENTS)) {
      assert.equal(v, k, `EVENTS.${k} must equal its key`);
    }

    for (const keyVal of Object.values(STORAGE_KEYS)) {
      assert.notEqual(keyVal, 'neon_volley_heavy_gale_physics_v1');
      assert.ok(keyVal.startsWith('summer_heat_3d_'), `v2 storage key must be namespaced: ${keyVal}`);
    }

    // Factories return fresh mutable objects with deep-copied Vec3s
    const srcPos = { x: -2, y: 3, z: 1 };
    const b1 = createBallState({ pos: srcPos });
    const b2 = createBallState({ pos: srcPos });
    assert.notEqual(b1, b2);
    assert.notEqual(b1.pos, srcPos);
    assert.notEqual(b1.pos, b2.pos);
    srcPos.x = 99;
    assert.equal(b1.pos.x, -2);
    assert.equal(b1.radius, BALL_SPEC.RADIUS);

    const w1 = createWindState();
    const w2 = createWindState();
    assert.notEqual(w1.windVec3, w2.windVec3);
    assert.equal(w1.phase, WIND_PHASES.BREEZE);

    const p1 = createPlayerState({ id: 'p1', team: 1, targetBallPos: { x: 1, y: 2, z: 3 } });
    const p2 = createPlayerState({ id: 'p2', team: 2 });
    assert.notEqual(p1.pos, p2.pos);
    assert.equal(p1.animState, ANIM_STATES.IDLE);
    assert.equal(p2.team, 2);

    const bind1 = createDefaultBindings();
    const bind2 = createDefaultBindings();
    assert.notEqual(bind1, bind2);
    assert.equal(bind1.deadzone, 0.16);
    assert.deepEqual(bind1.onePadSplit.p1.primaryButtons, [4, 6]);
    assert.deepEqual(bind1.onePadSplit.p2.primaryButtons, [5, 7, 0]);
    bind1.onePadSplit.p1.primaryButtons.push(99);
    assert.deepEqual(bind2.onePadSplit.p1.primaryButtons, [4, 6]);
  });

  it('T1-A2: Self-contained vendored Three.js r170 bundle loads cleanly in Node ESM', () => {
    assert.equal(THREE.REVISION, '170');
    const requiredClasses = [
      'Scene',
      'Group',
      'Mesh',
      'PerspectiveCamera',
      'WebGLRenderer',
      'CapsuleGeometry',
      'SphereGeometry',
      'Vector3',
      'Quaternion',
      'Color',
    ];
    for (const cls of requiredClasses) {
      assert.equal(typeof THREE[cls], 'function', `THREE.${cls} must be exported`);
    }

    const vendorPath = path.join(REPO_ROOT, 'vendor/three.module.min.js');
    const src = fs.readFileSync(vendorPath, 'utf8');
    assert.equal(extractModuleSpecifiers(src).length, 0, 'vendor/three.module.min.js must have zero relative/external imports');
    assert.ok(!src.includes('three.core.js'), 'vendor/three.module.min.js must not reference split three.core.js');
  });

  it('T1-A3: Zero-CDN policy & strictly acyclic module dependency DAG across src/*.js & index.html', () => {
    const allowedDeps = {
      'contracts.js': new Set([]),
      'physics3d.js': new Set(['./contracts.js']),
      'inputManager.js': new Set(['./contracts.js']),
      'audioSynth.js': new Set(['./contracts.js']),
      'playerRigs.js': new Set(['../vendor/three.module.min.js', './contracts.js']),
      'courtScene.js': new Set(['../vendor/three.module.min.js', './contracts.js', './playerRigs.js']),
      'rallyEngine.js': new Set(['./contracts.js', './physics3d.js']),
      'main.js': new Set([
        './contracts.js',
        './physics3d.js',
        './courtScene.js',
        './inputManager.js',
        './rallyEngine.js',
        './audioSynth.js',
      ]),
    };

    const graph = new Map();

    for (const [fileName, allowed] of Object.entries(allowedDeps)) {
      const fullPath = path.join(REPO_ROOT, 'src', fileName);
      assert.ok(fs.existsSync(fullPath), `Missing required module: src/${fileName}`);
      const content = fs.readFileSync(fullPath, 'utf8');

      // Zero CDN / external URLs
      const externalUrls = findExternalUrls(content);
      assert.deepEqual(externalUrls, [], `src/${fileName} must contain zero external URLs`);

      // Dependency DAG check
      const specs = extractModuleSpecifiers(content);
      graph.set(fileName, []);
      for (const spec of specs) {
        assert.notEqual(spec, 'three', `src/${fileName} must not use bare 'three' specifier`);
        assert.ok(
          allowed.has(spec),
          `DAG violation in src/${fileName}: disallowed import '${spec}' (allowed: ${Array.from(allowed).join(', ') || 'none'})`,
        );
        if (spec.startsWith('./') && spec.endsWith('.js')) {
          graph.get(fileName).push(spec.slice(2));
        }
      }
    }

    // Explicit DFS cycle verification
    const visiting = new Set();
    const visited = new Set();
    function dfs(node) {
      if (visiting.has(node)) assert.fail(`Circular dependency detected involving src/${node}`);
      if (visited.has(node)) return;
      visiting.add(node);
      for (const dep of graph.get(node) || []) {
        dfs(dep);
      }
      visiting.delete(node);
      visited.add(node);
    }
    for (const node of graph.keys()) {
      dfs(node);
    }

    // Verify index.html uses ES module entry and zero external URLs (attribute-order independent)
    const indexHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    assert.deepEqual(findExternalUrls(indexHtml), [], 'index.html must contain zero external URLs');
    const scriptTags = indexHtml.match(/<script\b[^>]*>/gi) || [];
    const hasMainModuleScript = scriptTags.some(
      (tag) => /\btype\s*=\s*["']module["']/i.test(tag) && /\bsrc\s*=\s*["']\.\/src\/main\.js["']/i.test(tag),
    );
    assert.ok(hasMainModuleScript, 'index.html must load ./src/main.js as type="module"');
  });

  it('T1-A4: manifest.json preserves exact v1 inline SVG icon, fullscreen display & landscape orientation', () => {
    const rootManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
    const classicManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'classic-2d/manifest.json'), 'utf8'));

    assert.equal(rootManifest.display, 'fullscreen');
    assert.equal(rootManifest.orientation, 'landscape');
    assert.ok(Array.isArray(rootManifest.icons) && rootManifest.icons.length >= 1, 'manifest.json must include icons array');

    const v1Icon = classicManifest.icons[0];
    const matchingIcon = rootManifest.icons.find((ic) => ic.src === v1Icon.src);
    assert.ok(matchingIcon, 'manifest.json must preserve exact v1 inline SVG data-URI icon');
    assert.equal(matchingIcon.sizes, '128x128');
    assert.equal(matchingIcon.type, 'image/svg+xml');
    assert.equal(matchingIcon.purpose, 'any maskable');
    assert.deepEqual(findExternalUrls(JSON.stringify(rootManifest)), [], 'manifest.json must have zero external URLs');
  });

  it('T1-A5: sw.js summer-heat-3d-v2 pre-cache & v1 purge + classic-2d SW isolation static contract', () => {
    const swText = fs.readFileSync(path.join(REPO_ROOT, 'sw.js'), 'utf8');

    assert.ok(swText.includes('summer-heat-3d-v2'), 'sw.js must define cache summer-heat-3d-v2');
    assert.match(swText, /clients\.claim\s*\(/, 'sw.js activate handler must call self.clients.claim()');
    assert.match(swText, /caches\.delete\s*\(/, 'sw.js activate handler must purge older caches');
    assert.match(swText, /activate/, 'sw.js must listen for activate event');
    assert.match(swText, /fetch/, 'sw.js must listen for fetch event');

    const requiredPrecacheAssets = [
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
    for (const asset of requiredPrecacheAssets) {
      assert.ok(
        swText.includes(`'${asset}'`) || swText.includes(`"${asset}"`),
        `sw.js must pre-cache '${asset}'`,
      );
    }

    // Classic 2D archive isolation
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'classic-2d/sw.js')), false, 'classic-2d/sw.js MUST NOT exist');
    const classicHtml = fs.readFileSync(path.join(REPO_ROOT, 'classic-2d/index.html'), 'utf8');
    assert.ok(!/serviceWorker/i.test(classicHtml), 'classic-2d/index.html must NOT register a service worker');
    assert.match(classicHtml, /id=["']backTo3dLink["']/i, 'classic-2d/index.html must expose #backTo3dLink');
    assert.match(classicHtml, /href=["']\.\.\/index\.html["']/i, 'classic-2d/index.html must link back to ../index.html');
  });
});

/* ========================================================================== *
 * AREA B — 3D Aerodynamics, Heavy Gale Wind, Walls/Net & Predictor (physics3d)
 * ========================================================================== */
describe('Tier 1 — Area B: 3D Aerodynamics, Heavy Gale Wind, Walls/Net & Predictor (src/physics3d.js)', () => {
  let physics;

  before(async () => {
    physics = await import('../../src/physics3d.js');
  });

  it('T1-B1: 120Hz deterministic fixed-step integration produces bit-identical trajectories', () => {
    assert.equal(physics.FIXED_DT, FIXED_DT);

    const initBall = () =>
      createBallState({
        pos: { x: -3, y: 3.0, z: 0 },
        vel: { x: 8, y: 5, z: 1 },
        omega: { x: 0, y: 2, z: -10 },
      });
    const b1 = initBall();
    const b2 = initBall();
    const w1 = createWindState({ windVec3: { x: 1.2, y: 0, z: -0.4 } });
    const w2 = createWindState({ windVec3: { x: 1.2, y: 0, z: -0.4 } });

    const initialOmegaMag = Math.hypot(b1.omega.x, b1.omega.y, b1.omega.z);

    for (let i = 0; i < 120; i++) {
      physics.stepBall3D(b1, w1, PHYSICS_DEFAULTS, FIXED_DT, false);
      physics.stepBall3D(b2, w2, PHYSICS_DEFAULTS, FIXED_DT, false);
    }

    assert.deepStrictEqual(b1, b2, 'Identical 120Hz runs must match bit-for-bit');
    assertFiniteVec3(b1.pos, 'ball.pos');
    assertFiniteVec3(b1.vel, 'ball.vel');
    assertFiniteVec3(b1.omega, 'ball.omega');
    assertFiniteVec3(b1.spinAngle, 'ball.spinAngle');

    const spinMag = Math.hypot(b1.spinAngle.x, b1.spinAngle.y, b1.spinAngle.z);
    assert.ok(spinMag > 0.1, 'ball.spinAngle must advance during spinning flight');

    const finalOmegaMag = Math.hypot(b1.omega.x, b1.omega.y, b1.omega.z);
    assert.ok(finalOmegaMag < initialOmegaMag, 'ball.omega magnitude must decay gently over 120 steps');
    assert.ok(finalOmegaMag > 0, 'ball.omega must remain non-zero after 1s');
  });

  it('T1-B2: Heavy Gale 3D wind cycles BREEZE -> WARNING -> GUST -> BREEZE and obeys triggerGaleSurge', () => {
    // Measure real 3.0s normal BREEZE peak speed first
    const wBreeze = createWindState();
    let peakBreezeSpeed = 0;
    for (let i = 0; i < Math.ceil(3.0 / FIXED_DT); i++) {
      const bRes = physics.updateWind3D(wBreeze, FIXED_DT, PHYSICS_DEFAULTS);
      assert.equal(bRes.phase, WIND_PHASES.BREEZE);
      assertFiniteVec3(bRes.windVec3, 'breeze windVec3');
      peakBreezeSpeed = Math.max(peakBreezeSpeed, wBreeze.speed);
    }

    const wind = createWindState();
    const breezeRes = physics.updateWind3D(wind, FIXED_DT, PHYSICS_DEFAULTS);
    assert.equal(breezeRes.phase, WIND_PHASES.BREEZE);
    assertFiniteVec3(breezeRes.windVec3, 'breeze windVec3');

    physics.triggerGaleSurge(wind, 1);
    assert.equal(wind.phase, WIND_PHASES.WARNING, 'triggerGaleSurge must enter WARNING phase');

    let enteredGust = false;
    let maxGustSpeed = 0;
    let gustPositiveXSeen = false;
    let returnedToBreeze = false;
    let phaseChangedSeen = false;

    // Advance 6.5 seconds (1s WARNING + 4s GUST + margin back to BREEZE)
    for (let i = 0; i < Math.ceil(6.5 / FIXED_DT); i++) {
      const res = physics.updateWind3D(wind, FIXED_DT, PHYSICS_DEFAULTS);
      assertFiniteVec3(res.windVec3, 'windVec3');
      if (res.phaseChanged) phaseChangedSeen = true;
      if (res.phase === WIND_PHASES.GUST) {
        enteredGust = true;
        maxGustSpeed = Math.max(maxGustSpeed, wind.speed);
        if (wind.windVec3.x > 0.5) gustPositiveXSeen = true;
      } else if (enteredGust && res.phase === WIND_PHASES.BREEZE) {
        returnedToBreeze = true;
        break;
      }
    }

    assert.ok(phaseChangedSeen, 'updateWind3D must signal phaseChanged on phase transitions');
    assert.ok(enteredGust, 'wind must transition from WARNING into GUST');
    assert.ok(returnedToBreeze, 'wind must return from GUST back to BREEZE');
    assert.ok(gustPositiveXSeen, 'triggerGaleSurge(+1) must push windVec3.x > 0 during GUST');
    assert.ok(
      maxGustSpeed > peakBreezeSpeed + 1.5,
      `GUST speed (${maxGustSpeed.toFixed(2)}) must significantly exceed 3.0s peak breeze (${peakBreezeSpeed.toFixed(2)})`,
    );

    // Negative direction surge check
    const windNeg = createWindState();
    physics.triggerGaleSurge(windNeg, -1);
    let gustNegXSeen = false;
    for (let i = 0; i < Math.ceil(3.0 / FIXED_DT); i++) {
      const res = physics.updateWind3D(windNeg, FIXED_DT, PHYSICS_DEFAULTS);
      if (res.phase === WIND_PHASES.GUST && windNeg.windVec3.x < -0.5) {
        gustNegXSeen = true;
        break;
      }
    }
    assert.ok(gustNegXSeen, 'triggerGaleSurge(-1) must push windVec3.x < 0 during GUST');
  });

  it('T1-B3: Quadratic air drag opposes vRel (faster slowdown with kDrag > 0 and headwind > tailwind)', () => {
    const cfgDrag = { ...PHYSICS_DEFAULTS, gravity: PHYSICS_DEFAULTS.gravity, kMagnus: 0, kDrag: 0.032 };
    const cfgNoDrag = { ...PHYSICS_DEFAULTS, gravity: PHYSICS_DEFAULTS.gravity, kMagnus: 0, kDrag: 0 };

    const bDrag = createBallState({ pos: { x: -4, y: 4, z: 0 }, vel: { x: 16, y: 0, z: 0 } });
    const bNoDrag = createBallState({ pos: { x: -4, y: 4, z: 0 }, vel: { x: 16, y: 0, z: 0 } });
    const calm = createWindState({ windVec3: { x: 0, y: 0, z: 0 } });

    for (let i = 0; i < 30; i++) {
      physics.stepBall3D(bDrag, calm, cfgDrag, FIXED_DT, true);
      physics.stepBall3D(bNoDrag, calm, cfgNoDrag, FIXED_DT, true);
    }
    assert.ok(bDrag.vel.x < bNoDrag.vel.x - 0.5, 'Quadratic drag must decelerate fast ball relative to kDrag=0');

    const bHead = createBallState({ pos: { x: -4, y: 4, z: 0 }, vel: { x: 14, y: 0, z: 0 } });
    const bTail = createBallState({ pos: { x: -4, y: 4, z: 0 }, vel: { x: 14, y: 0, z: 0 } });
    const headWind = createWindState({ windVec3: { x: -6, y: 0, z: 0 } });
    const tailWind = createWindState({ windVec3: { x: 6, y: 0, z: 0 } });

    for (let i = 0; i < 30; i++) {
      physics.stepBall3D(bHead, headWind, cfgDrag, FIXED_DT, true);
      physics.stepBall3D(bTail, tailWind, cfgDrag, FIXED_DT, true);
    }
    assert.ok(
      bHead.vel.x < bTail.vel.x - 0.5,
      `Headwind final vx (${bHead.vel.x.toFixed(2)}) must be strictly slower than tailwind (${bTail.vel.x.toFixed(2)})`,
    );
  });

  it('T1-B4: 3D Magnus symmetry — topspin dives (-Y) and backspin floats (+Y) in BOTH +X and -X, sidespin curves Z', () => {
    const calm = createWindState({ windVec3: { x: 0, y: 0, z: 0 } });
    const cfg = { ...PHYSICS_DEFAULTS, kMagnus: 0.028 };

    for (const dirX of [1, -1]) {
      const startX = dirX > 0 ? -5 : 5;
      const vx = dirX * 12;

      const bNeutral = createBallState({ pos: { x: startX, y: 4, z: 0 }, vel: { x: vx, y: 3, z: 0 }, omega: { x: 0, y: 0, z: 0 } });
      const bTop = createBallState({
        pos: { x: startX, y: 4, z: 0 },
        vel: { x: vx, y: 3, z: 0 },
        omega: computeSpinOmega(dirX, 0, 16, 0),
      });
      const bBack = createBallState({
        pos: { x: startX, y: 4, z: 0 },
        vel: { x: vx, y: 3, z: 0 },
        omega: computeSpinOmega(dirX, 0, -16, 0),
      });

      for (let i = 0; i < 55; i++) {
        physics.stepBall3D(bNeutral, calm, cfg, FIXED_DT, true);
        physics.stepBall3D(bTop, calm, cfg, FIXED_DT, true);
        physics.stepBall3D(bBack, calm, cfg, FIXED_DT, true);
      }

      assert.ok(
        bTop.pos.y < bNeutral.pos.y - 0.1,
        `Topspin must dive lower than neutral in dirX=${dirX} (top=${bTop.pos.y.toFixed(3)}, neutral=${bNeutral.pos.y.toFixed(3)})`,
      );
      assert.ok(
        bBack.pos.y > bNeutral.pos.y + 0.1,
        `Backspin must float higher than neutral in dirX=${dirX} (back=${bBack.pos.y.toFixed(3)}, neutral=${bNeutral.pos.y.toFixed(3)})`,
      );
    }

    // Signed sidespin lateral hook in Z: omega = (0, +16, 0) x (+12, 3, 0) => (0, 0, -192) (-Z), and -16 => (+Z)
    const bNoSide = createBallState({ pos: { x: -5, y: 4, z: 0 }, vel: { x: 12, y: 3, z: 0 }, omega: { x: 0, y: 0, z: 0 } });
    const bSidePos = createBallState({
      pos: { x: -5, y: 4, z: 0 },
      vel: { x: 12, y: 3, z: 0 },
      omega: computeSpinOmega(1, 0, 0, 16),
    });
    const bSideNeg = createBallState({
      pos: { x: -5, y: 4, z: 0 },
      vel: { x: 12, y: 3, z: 0 },
      omega: computeSpinOmega(1, 0, 0, -16),
    });
    for (let i = 0; i < 55; i++) {
      physics.stepBall3D(bNoSide, calm, cfg, FIXED_DT, true);
      physics.stepBall3D(bSidePos, calm, cfg, FIXED_DT, true);
      physics.stepBall3D(bSideNeg, calm, cfg, FIXED_DT, true);
    }
    assert.ok(
      bSidePos.pos.z < bNoSide.pos.z - 0.1,
      `Sidespin +16 must curve toward -Z (posZ=${bSidePos.pos.z.toFixed(3)}, noSideZ=${bNoSide.pos.z.toFixed(3)})`,
    );
    assert.ok(
      bSideNeg.pos.z > bNoSide.pos.z + 0.1,
      `Sidespin -16 must curve toward +Z (negZ=${bSideNeg.pos.z.toFixed(3)}, noSideZ=${bNoSide.pos.z.toFixed(3)})`,
    );
  });

  it('T1-B5: Spin-reactive outer stadium arcade walls keep ball live and kick topspin down / backspin up on BOTH ±X walls', () => {
    const calm = createWindState();
    const cfg = { ...PHYSICS_DEFAULTS, gravity: PHYSICS_DEFAULTS.gravity, kDrag: 0, kMagnus: 0 };

    // Test both Right (+X) and Left (-X) walls symmetrically
    for (const wallSign of [1, -1]) {
      const startX = wallSign * (COURT.ARENA_HALF_X - BALL_SPEC.RADIUS - 0.04);
      const vx = wallSign * 14;

      const bNeutral = createBallState({ pos: { x: startX, y: 4, z: 0 }, vel: { x: vx, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 } });
      const bTop = createBallState({
        pos: { x: startX, y: 4, z: 0 },
        vel: { x: vx, y: 0, z: 0 },
        omega: computeSpinOmega(wallSign, 0, 18, 0),
      });
      const bBack = createBallState({
        pos: { x: startX, y: 4, z: 0 },
        vel: { x: vx, y: 0, z: 0 },
        omega: computeSpinOmega(wallSign, 0, -18, 0),
      });

      const rN = physics.stepBall3D(bNeutral, calm, cfg, FIXED_DT, true);
      const rT = physics.stepBall3D(bTop, calm, cfg, FIXED_DT, true);
      const rB = physics.stepBall3D(bBack, calm, cfg, FIXED_DT, true);

      assert.ok(rN.wallHit && rT.wallHit && rB.wallHit, `wallHit must be truthy on wallSign=${wallSign}`);
      assert.equal(rN.landed, false, 'Outer wall hit must keep ball live (landed === false)');
      assert.equal(Math.sign(bNeutral.vel.x), -wallSign, 'Normal X velocity must reverse inward');
      assert.ok(
        Math.abs(Math.abs(bNeutral.vel.x) - Math.abs(vx) * cfg.eWall) < 0.25,
        'Wall restitution must reflect speed near eWall',
      );
      assert.ok(
        bTop.vel.y < bNeutral.vel.y - 0.5,
        `Topspin must kick vel.y downward on wallSign=${wallSign} (top=${bTop.vel.y.toFixed(3)}, neutral=${bNeutral.vel.y.toFixed(3)})`,
      );
      assert.ok(
        bBack.vel.y > bNeutral.vel.y + 0.5,
        `Backspin must kick vel.y upward on wallSign=${wallSign} (back=${bBack.vel.y.toFixed(3)}, neutral=${bNeutral.vel.y.toFixed(3)})`,
      );
    }

    // Near/Far Z walls and Ceiling
    const bZ = createBallState({ pos: { x: 0, y: 4, z: COURT.ARENA_HALF_Z - BALL_SPEC.RADIUS - 0.03 }, vel: { x: 0, y: 0, z: 12 } });
    const rZ = physics.stepBall3D(bZ, calm, cfg, FIXED_DT, true);
    assert.ok(rZ.wallHit, 'Near Z wall (+6.5) must report wallHit');
    assert.equal(rZ.landed, false);
    assert.ok(bZ.vel.z < 0, 'Z wall must reflect vel.z inward');

    const bCeil = createBallState({ pos: { x: 0, y: COURT.CEILING_Y - BALL_SPEC.RADIUS - 0.03, z: 0 }, vel: { x: 0, y: 12, z: 0 } });
    const rCeil = physics.stepBall3D(bCeil, calm, cfg, FIXED_DT, true);
    assert.ok(rCeil.wallHit, 'Ceiling (14.0) must report wallHit');
    assert.equal(rCeil.landed, false);
    assert.ok(bCeil.vel.y < 0, 'Ceiling must reflect vel.y downward');
  });

  it('T1-B6: Rounded net tape deflection, damped lower net mesh rebound, and clean crossing', () => {
    const calm = createWindState();

    // 1. Clipping top of rounded net tape (should deflect upward/radially)
    const bTape = createBallState({
      pos: { x: -0.35, y: COURT.NET_HEIGHT + 0.12, z: 0 },
      vel: { x: 10, y: -0.5, z: 0 },
    });
    let tapeHit = false;
    for (let i = 0; i < 15; i++) {
      const r = physics.stepBall3D(bTape, calm, PHYSICS_DEFAULTS, FIXED_DT, true);
      if (r.netHit) {
        tapeHit = true;
        break;
      }
    }
    assert.ok(tapeHit, 'Ball hitting rounded net tape at y~2.38 must register netHit');
    assert.ok(bTape.vel.y > 0, 'Clipping top of rounded cylinder net tape should impart upward deflection');

    // 2. Lower net mesh rebound
    const bMesh = createBallState({
      pos: { x: -0.35, y: 1.2, z: 0 },
      vel: { x: 10, y: 0, z: 0 },
    });
    let meshHit = false;
    for (let i = 0; i < 15; i++) {
      const r = physics.stepBall3D(bMesh, calm, PHYSICS_DEFAULTS, FIXED_DT, true);
      if (r.netHit) {
        meshHit = true;
        break;
      }
    }
    assert.ok(meshHit, 'Ball hitting lower net mesh (y=1.2) must register netHit');
    assert.ok(bMesh.vel.x < 0, 'Lower net mesh must reflect vel.x back to Team 1 side');
    assert.ok(Math.abs(bMesh.vel.x) < 6.0, 'Lower net mesh must damp horizontal rebound speed via eNetMesh');

    // 3. Clean high crossing
    const bClear = createBallState({
      pos: { x: -0.4, y: 3.4, z: 0 },
      vel: { x: 10, y: 1.5, z: 0 },
    });
    let crossed = false;
    let anyNetHit = false;
    for (let i = 0; i < 20; i++) {
      const r = physics.stepBall3D(bClear, calm, PHYSICS_DEFAULTS, FIXED_DT, true);
      if (r.netHit) anyNetHit = true;
      if (r.crossedNet) crossed = true;
    }
    assert.equal(anyNetHit, false, 'High ball at y=3.4 must clear the net cleanly');
    assert.equal(crossed, true, 'High ball crossing X=0 must set crossedNet: true');
  });

  it('T1-B7: predictLandingPoint3D is strictly pure (non-mutating) and accurate within 0.05m / 0.02s', () => {
    const ball = createBallState({
      pos: { x: -4.0, y: 2.8, z: 0.5 },
      vel: { x: 7.0, y: 4.5, z: -0.5 },
      omega: { x: 0, y: 1.0, z: -8.0 },
    });
    const wind = createWindState({
      phase: WIND_PHASES.GUST,
      timer: 3.0,
      windVec3: { x: -2.2, y: 0, z: 1.1 },
      gustTargetVec3: { x: -2.2, y: 0, z: 1.1 },
      speed: Math.hypot(-2.2, 1.1),
    });

    const ballBefore = structuredClone(ball);
    const windBefore = structuredClone(wind);

    const pred = physics.predictLandingPoint3D(ball, wind, PHYSICS_DEFAULTS, MAX_PREDICT_STEPS);

    // Strict purity assertion
    assert.deepStrictEqual(ball, ballBefore, 'predictLandingPoint3D MUST NOT mutate ballState');
    assert.deepStrictEqual(wind, windBefore, 'predictLandingPoint3D MUST NOT mutate windState');

    assert.equal(pred.landedWithinSteps, true, 'Mid-height arc must land within 180 steps');
    assert.ok(pred.steps > 0 && pred.steps <= MAX_PREDICT_STEPS);
    assert.ok(Array.isArray(pred.trajectory) && pred.trajectory.length > 0, 'trajectory must be non-empty');
    for (const pt of pred.trajectory) {
      assertFiniteVec3(pt, 'trajectory point');
    }

    // Run actual simulation using stepBall3D until sand impact (keep wind constant or synced identically)
    const simBall = structuredClone(ballBefore);
    const simWind = structuredClone(windBefore);
    let actualSteps = 0;
    let landed = false;
    for (let i = 1; i <= MAX_PREDICT_STEPS + 60; i++) {
      const res = physics.stepBall3D(simBall, simWind, PHYSICS_DEFAULTS, FIXED_DT, true);
      actualSteps = i;
      if (res.landed) {
        landed = true;
        break;
      }
    }
    assert.ok(landed, 'Actual trajectory must hit sand');

    const actualHang = actualSteps * FIXED_DT;
    const distErr = Math.hypot(pred.x - simBall.pos.x, pred.z - simBall.pos.z);
    const timeErr = Math.abs(pred.hangTime - actualHang);

    assert.ok(distErr <= 0.05, `Predicted (x,z) error ${distErr.toFixed(4)}m exceeded 0.05m tolerance`);
    assert.ok(timeErr <= 0.02, `Predicted hangTime error ${timeErr.toFixed(4)}s exceeded 0.02s tolerance`);
  });
});

/* ========================================================================== *
 * AREA C — Articulated 3D Athlete Rigs (src/playerRigs.js + Three.js r170)
 * ========================================================================== */
describe('Tier 1 — Area C: Articulated 3D Athlete Rigs (src/playerRigs.js + Three.js r170)', () => {
  let rigs;

  before(async () => {
    rigs = await import('../../src/playerRigs.js');
  });

  function collectRigSignature(root) {
    root.updateMatrixWorld(true);
    const values = [];
    root.traverse((obj) => {
      for (const n of [
        obj.position.x,
        obj.position.y,
        obj.position.z,
        obj.rotation.x,
        obj.rotation.y,
        obj.rotation.z,
        obj.scale.x,
        obj.scale.y,
        obj.scale.z,
      ]) {
        assert.ok(Number.isFinite(n), `Non-finite transform on ${obj.name || obj.type}`);
      }
      for (const m of obj.matrixWorld.elements) {
        assert.ok(Number.isFinite(m), `Non-finite matrixWorld element on ${obj.name || obj.type}`);
      }
      const wp = new THREE.Vector3();
      obj.getWorldPosition(wp);
      values.push(wp.x, wp.y, wp.z, obj.rotation.x, obj.rotation.y, obj.rotation.z);
    });
    return values;
  }

  function signatureDiff(a, b) {
    const len = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Math.abs(a[i] - b[i]);
    return sum;
  }

  it('T1-C1: createPlayerRig builds articulated THREE.Group hierarchy with team differentiation', () => {
    const r1 = rigs.createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const r2 = rigs.createPlayerRig({ id: 'p2', team: 2, role: 'PARTNER' });

    for (const [rig, expected] of [
      [r1, { id: 'p1', team: 1, role: 'PRIMARY' }],
      [r2, { id: 'p2', team: 2, role: 'PARTNER' }],
    ]) {
      assert.equal(rig.id, expected.id);
      assert.equal(rig.team, expected.team);
      assert.equal(rig.role, expected.role);
      assert.ok(rig.root instanceof THREE.Group, 'rig.root must be a THREE.Group');
      assert.ok(rig.joints && typeof rig.joints === 'object', 'rig.joints must exist');
      assert.ok(rig.spring && typeof rig.spring === 'object', 'rig.spring must exist');
      assert.ok(rig.materials && typeof rig.materials === 'object', 'rig.materials must exist');

      let meshCount = 0;
      rig.root.traverse((o) => {
        if (o.isMesh) meshCount += 1;
      });
      assert.ok(meshCount >= 5, `Articulated rig must have multiple limb/torso meshes, got ${meshCount}`);
    }

    // Collect distinct hex colors across each team's meshes
    const getColors = (root) => {
      const colors = new Set();
      root.traverse((o) => {
        if (o.isMesh && o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (m.color && typeof m.color.getHex === 'function') {
              colors.add(m.color.getHex());
            }
          }
        }
      });
      return colors;
    };

    const c1 = getColors(r1.root);
    const c2 = getColors(r2.root);
    const identicalSets = c1.size === c2.size && Array.from(c1).every((hex) => c2.has(hex));
    assert.equal(identicalSets, false, 'Team 1 and Team 2 rigs must have distinct visual colors');

    rigs.disposePlayerRig(r1);
    rigs.disposePlayerRig(r2);
  });

  it('T1-C2: All 7 ANIM_STATES produce strictly finite transforms and measurably distinct poses', () => {
    const rig = rigs.createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const ball = createBallState({ pos: { x: -2.2, y: 2.3, z: 0.2 } });
    const signatures = {};

    for (const state of Object.values(ANIM_STATES)) {
      const player = createPlayerState({
        id: 'p1',
        team: 1,
        pos: { x: -3.0, y: state === ANIM_STATES.JUMP_HEAT_SPIKE || state === ANIM_STATES.NET_BLOCK ? 0.9 : 0, z: 0 },
        vel: { x: state === ANIM_STATES.SPRINT ? 5.0 : 0, y: 0, z: 0 },
        animState: state,
        animTime: 0.25,
        animProgress: 0.5,
        isAirborne: state === ANIM_STATES.JUMP_HEAT_SPIKE || state === ANIM_STATES.NET_BLOCK,
        targetBallPos: { ...ball.pos },
      });

      for (let i = 0; i < 15; i++) {
        player.animTime += 1 / 60;
        rigs.updatePlayerRig(rig, player, ball, 1 / 60);
      }
      signatures[state] = collectRigSignature(rig.root);
    }

    assert.ok(
      signatureDiff(signatures[ANIM_STATES.JUMP_HEAT_SPIKE], signatures[ANIM_STATES.UNDERHAND_BUMP]) > 0.2,
      'JumpHeatSpike and UnderhandBump must produce measurably different limb poses',
    );
    assert.ok(
      signatureDiff(signatures[ANIM_STATES.SAND_DIVE], signatures[ANIM_STATES.IDLE]) > 0.2,
      'SandDive and Idle must produce measurably different torso/limb poses',
    );
    assert.ok(
      signatureDiff(signatures[ANIM_STATES.OVERHEAD_SET], signatures[ANIM_STATES.NET_BLOCK]) > 0.05,
      'OverheadSet and NetBlock must be distinct articulated poses',
    );

    rigs.disposePlayerRig(rig);
  });

  it('T1-C3: Rig tracks playerState.pos, facingYaw, and 2-bone IK targetBallPos', () => {
    const rig = rigs.createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const player = createPlayerState({
      id: 'p1',
      team: 1,
      pos: { x: -3.5, y: 0, z: 1.2 },
      facingYaw: Math.PI / 3,
      animState: ANIM_STATES.OVERHEAD_SET,
      targetBallPos: { x: -2.8, y: 2.2, z: 1.2 },
    });
    const ball = createBallState({ pos: { x: -2.8, y: 2.2, z: 1.2 } });

    for (let i = 0; i < 20; i++) {
      rigs.updatePlayerRig(rig, player, ball, 1 / 60);
    }

    assert.ok(Math.abs(rig.root.position.x - player.pos.x) < 0.15, 'root.position.x must track playerState.pos.x');
    assert.ok(Math.abs(rig.root.position.z - player.pos.z) < 0.15, 'root.position.z must track playerState.pos.z');

    // Compare angular difference mod 2π
    const yawDiff = Math.abs(Math.atan2(Math.sin(rig.root.rotation.y - player.facingYaw), Math.cos(rig.root.rotation.y - player.facingYaw)));
    assert.ok(yawDiff < 0.35, `root.rotation.y should approach facingYaw (diff=${yawDiff.toFixed(3)})`);

    const sigHigh = collectRigSignature(rig.root);

    // Move targetBallPos to low underhand target and verify IK responds cleanly
    player.animState = ANIM_STATES.UNDERHAND_BUMP;
    player.targetBallPos = { x: -2.5, y: 0.9, z: 0.4 };
    ball.pos = { x: -2.5, y: 0.9, z: 0.4 };
    for (let i = 0; i < 20; i++) {
      rigs.updatePlayerRig(rig, player, ball, 1 / 60);
    }
    const sigLow = collectRigSignature(rig.root);
    assert.ok(signatureDiff(sigHigh, sigLow) > 0.1, 'IK limb transforms must adapt to targetBallPos changes');

    rigs.disposePlayerRig(rig);
  });

  it('T1-C4: Spring squash-and-stretch responds to jump takeoff and landing then relaxes toward rest scales', () => {
    const rig = rigs.createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const ball = createBallState({ pos: { x: -2, y: 3, z: 0 } });
    const player = createPlayerState({ id: 'p1', team: 1, pos: { x: -3, y: 0, z: 0 }, animState: ANIM_STATES.IDLE });

    for (let i = 0; i < 15; i++) rigs.updatePlayerRig(rig, player, ball, 1 / 60);

    // Record idle rest scales so static non-unit limb proportions never mask real spring deformation
    const restScales = new Map();
    rig.root.traverse((o) => {
      restScales.set(o.uuid, [o.scale.x, o.scale.y, o.scale.z]);
    });

    let maxDeltaFromRest = 0;
    const recordDeviation = () => {
      for (const s of [rig.root.scale.x, rig.root.scale.y, rig.root.scale.z]) {
        assert.ok(Number.isFinite(s) && s > 0.2 && s < 3.0, `Root scale must stay bounded in (0.2, 3.0), got ${s}`);
      }
      rig.root.traverse((o) => {
        for (const s of [o.scale.x, o.scale.y, o.scale.z]) {
          assert.ok(Number.isFinite(s) && s > 0 && s < 4.0, `Descendant scale must stay finite in (0, 4.0), got ${s}`);
        }
        const rest = restScales.get(o.uuid);
        if (rest) {
          const dev =
            Math.abs(o.scale.x - rest[0]) +
            Math.abs(o.scale.y - rest[1]) +
            Math.abs(o.scale.z - rest[2]);
          if (dev > maxDeltaFromRest) maxDeltaFromRest = dev;
        }
      });
    };

    // Jump takeoff
    player.animState = ANIM_STATES.JUMP_HEAT_SPIKE;
    player.isAirborne = true;
    player.pos.y = 0.8;
    player.vel.y = 6.0;
    for (let i = 0; i < 12; i++) {
      rigs.updatePlayerRig(rig, player, ball, 1 / 60);
      recordDeviation();
    }

    // Landing impact + spring relaxation
    player.animState = ANIM_STATES.IDLE;
    player.isAirborne = false;
    player.pos.y = 0;
    player.vel.y = 0;
    for (let i = 0; i < 60; i++) {
      rigs.updatePlayerRig(rig, player, ball, 1 / 60);
      recordDeviation();
    }

    assert.ok(
      maxDeltaFromRest > 0.05,
      `Spring squash-and-stretch must visibly deform relative to idle rest scales (maxDelta=${maxDeltaFromRest.toFixed(4)})`,
    );

    let maxFinalRestErr = 0;
    rig.root.traverse((o) => {
      const rest = restScales.get(o.uuid);
      if (rest) {
        const err =
          Math.abs(o.scale.x - rest[0]) +
          Math.abs(o.scale.y - rest[1]) +
          Math.abs(o.scale.z - rest[2]);
        if (err > maxFinalRestErr) maxFinalRestErr = err;
      }
    });
    assert.ok(
      maxFinalRestErr < 0.15,
      `Rig scales must relax back within < 0.15 of idle rest scales after landing (err=${maxFinalRestErr.toFixed(4)})`,
    );

    rigs.disposePlayerRig(rig);
  });

  it('T1-C5: disposePlayerRig cleanly disposes all geometries and materials', () => {
    const rig = rigs.createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    let geoDisposed = 0;
    let matDisposed = 0;
    const seenGeo = new Set();
    const seenMat = new Set();

    rig.root.traverse((o) => {
      if (o.geometry && !seenGeo.has(o.geometry)) {
        seenGeo.add(o.geometry);
        const orig = o.geometry.dispose.bind(o.geometry);
        o.geometry.dispose = () => {
          geoDisposed += 1;
          return orig();
        };
      }
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m && !seenMat.has(m)) {
            seenMat.add(m);
            const orig = m.dispose.bind(m);
            m.dispose = () => {
              matDisposed += 1;
              return orig();
            };
          }
        }
      }
    });

    assert.doesNotThrow(() => rigs.disposePlayerRig(rig));
    assert.ok(geoDisposed > 0, 'disposePlayerRig must dispose geometries');
    assert.ok(matDisposed > 0, 'disposePlayerRig must dispose materials');
  });
});

/* ========================================================================== *
 * AREA D — 3-Touch Rally Loop, Heat Spike/Pokey/Block & AI FSM (rallyEngine)
 * ========================================================================== */
describe('Tier 1 — Area D: 3-Touch Rally Loop, Heat Spike/Pokey/Block & AI FSM (src/rallyEngine.js)', () => {
  let rallyMod;

  before(async () => {
    rallyMod = await import('../../src/rallyEngine.js');
  });

  it('T1-D1: Full 3-touch Bump -> Set -> Heat Spike via genuine PlayerInputCmd triggers FLAME, topspin, hit-stop & cameraPunch', () => {
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.WIND_LOBBER });
    const bot = createBotController({ team: 1 });

    let maxTouchSeen = 0;
    let maxHeatMeter = 0;
    let sawBumpOrDive = false;
    let sawSet = false;
    let sawHeatSpike = false;
    let sawFlameTrail = false;
    let sawTopspinOnSpike = false;
    let maxHitStop = 0;
    let maxCameraPunch = 0;

    // Run up to 24 seconds of simulated 120Hz rallies so meter can charge and unleash a full Heat Spike
    for (let step = 0; step < 120 * 24; step++) {
      const snap = engine.getSnapshot();
      const { cmd } = bot.step(snap);
      const inputs = makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: cmd });
      engine.stepFixed(FIXED_DT, inputs, PHYSICS_DEFAULTS);

      const next = engine.getSnapshot();
      const evTypes = extractEventTypes(next.events);
      const p1 = next.players.find((p) => p.team === 1 && p.role === 'PRIMARY');
      const touches = readTouchCount(next, 1);

      if (touches > maxTouchSeen) maxTouchSeen = touches;
      if (p1 && p1.heatMeter > maxHeatMeter) maxHeatMeter = p1.heatMeter;

      if (evTypes.includes(EVENTS.BUMP) || evTypes.includes(EVENTS.DIVE) || p1?.animState === ANIM_STATES.UNDERHAND_BUMP) {
        sawBumpOrDive = true;
      }
      if (evTypes.includes(EVENTS.SET) || p1?.animState === ANIM_STATES.OVERHEAD_SET || readTimingRing(next).active) {
        sawSet = true;
      }
      if (next.hitStopFrames > maxHitStop) maxHitStop = next.hitStopFrames;
      if (next.cameraPunch > maxCameraPunch) maxCameraPunch = next.cameraPunch;

      if (evTypes.includes(EVENTS.HEAT_SPIKE) || next.ball.shotType === SHOT_TYPES.HEAT_SPIKE) {
        sawHeatSpike = true;
        if (next.ball.trailMode === TRAIL_MODES.FLAME) sawFlameTrail = true;
        // For +X attack from Team 1, topspin gives omega.z < 0 -> (omega x v).y < 0 (downward dive)
        const v = next.ball.vel;
        const w = next.ball.omega;
        const magnusY = w.z * v.x - w.x * v.z;
        if (magnusY < -0.5) sawTopspinOnSpike = true;
      }

      if (sawBumpOrDive && sawSet && sawHeatSpike && sawFlameTrail && maxHitStop >= 2 && maxCameraPunch > 0) {
        break;
      }
    }

    assert.ok(sawBumpOrDive, 'Must execute Touch 1 Bump/Dive');
    assert.ok(sawSet, 'Must execute Touch 2 Set');
    assert.ok(maxTouchSeen >= 2 || (sawBumpOrDive && sawSet && sawHeatSpike), 'Must progress through 3-touch rally chain');
    assert.ok(maxHeatMeter > 0, `heatMeter must charge during Bump/Set (max=${maxHeatMeter})`);
    assert.ok(sawHeatSpike, 'Must unleash Touch 3 HEAT_SPIKE with charged heatMeter and sweet-spot timing');
    assert.ok(sawFlameTrail, 'Heat Spike must activate TRAIL_MODES.FLAME');
    assert.ok(sawTopspinOnSpike, 'Heat Spike must impart downward-diving topspin (omega x v).y < 0');
    assert.ok(maxHitStop >= 2, `Heat Spike must trigger >= 2-frame hit-stop (got ${maxHitStop})`);
    assert.ok(maxCameraPunch > 0, `Heat Spike must trigger cameraPunch > 0 (got ${maxCameraPunch})`);
  });

  it('T1-D2: Touch 2 Set spawns shrinking 3D Timing Ring near net on attacking side', () => {
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.WIND_LOBBER });
    const bot = createBotController({ team: 1, lateAttack: true });

    let ringActivated = false;
    const progressSamples = [];
    const radiusSamples = [];
    let ringOnTeam1Side = false;

    for (let step = 0; step < 120 * 14; step++) {
      const snap = engine.getSnapshot();
      const { cmd } = bot.step(snap);
      engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: cmd }), PHYSICS_DEFAULTS);

      const next = engine.getSnapshot();
      const ring = readTimingRing(next);
      if (ring.active) {
        ringActivated = true;
        progressSamples.push(ring.progress);
        radiusSamples.push(ring.radius);
        if (ring.pos && ring.pos.x <= 0.6) ringOnTeam1Side = true;
        if (progressSamples.length >= 25) break;
      }
    }

    assert.ok(ringActivated, 'Touch 2 Set must activate snapshot.timingRing');
    assert.ok(ringOnTeam1Side, 'Timing ring must track Set apex near Team 1 net zone (pos.x <= 0.6)');
    assert.ok(progressSamples.length >= 10, `Expected >= 10 active Timing Ring samples, got ${progressSamples.length}`);

    const firstP = progressSamples[0];
    const lastP = progressSamples[progressSamples.length - 1];
    const firstR = radiusSamples[0];
    const lastR = radiusSamples[radiusSamples.length - 1];
    assert.ok(lastP > firstP + 0.02, `Timing Ring progress must increase monotonically (${firstP} -> ${lastP})`);
    assert.ok(lastR < firstR - 0.02, `Timing Ring radius must strictly shrink over time (${firstR} -> ${lastR})`);
  });

  it('T1-D3: Touch 3 Backspin Pokey/Cut (CYAN) and NetBlock / Stuff-Block interception', () => {
    // Part 1: Secondary action on Touch 3 -> POKEY_CUT with CYAN trail & upward backspin Magnus
    const enginePokey = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.WIND_LOBBER });
    const pokeyBot = createBotController({ team: 1, useSecondaryOnTouch3: true });

    let sawPokey = false;
    let sawCyanTrail = false;
    let sawBackspinLift = false;

    for (let step = 0; step < 120 * 18; step++) {
      const snap = enginePokey.getSnapshot();
      const { cmd } = pokeyBot.step(snap);
      enginePokey.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: cmd }), PHYSICS_DEFAULTS);
      const next = enginePokey.getSnapshot();
      const evTypes = extractEventTypes(next.events);
      if (evTypes.includes(EVENTS.POKEY_CUT) || next.ball.shotType === SHOT_TYPES.POKEY_CUT) {
        sawPokey = true;
        if (next.ball.trailMode === TRAIL_MODES.CYAN) sawCyanTrail = true;
        const v = next.ball.vel;
        const w = next.ball.omega;
        const magnusY = w.z * v.x - w.x * v.z;
        if (magnusY > 0.1) sawBackspinLift = true;
        break;
      }
    }

    assert.ok(sawPokey, 'Secondary Touch 3 action must trigger POKEY_CUT');
    assert.ok(sawCyanTrail, 'POKEY_CUT must set TRAIL_MODES.CYAN');
    assert.ok(sawBackspinLift, 'POKEY_CUT must impart floating backspin ((omega x v).y > 0)');

    // Part 2: NetBlock / Stuff-Block against NET_BLOCKER AI (or human P2 blocking at net)
    const engineBlock = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, aiStyle: AI_STYLES.NET_BLOCKER });
    const p1Bot = createBotController({ team: 1 });
    const p2Blocker = createBotController({ team: 2, blockAtNet: true });

    let sawNetBlock = false;
    let sawStuffOrBlock = false;

    for (let step = 0; step < 120 * 18; step++) {
      const snap = engineBlock.getSnapshot();
      const { cmd: p1Cmd } = p1Bot.step(snap);
      const { cmd: p2Cmd } = p2Blocker.step(snap, { forceServe: false });
      engineBlock.stepFixed(
        FIXED_DT,
        makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: p1Cmd, p2Overrides: p2Cmd }),
        PHYSICS_DEFAULTS,
      );
      const next = engineBlock.getSnapshot();
      const evTypes = extractEventTypes(next.events);
      const p2 = next.players.find((p) => p.team === 2);
      if (p2?.animState === ANIM_STATES.NET_BLOCK || evTypes.includes(EVENTS.NET_BLOCK)) {
        sawNetBlock = true;
      }
      if (evTypes.includes(EVENTS.STUFF_BLOCK) || next.ball.shotType === SHOT_TYPES.BLOCK_STUFF) {
        sawStuffOrBlock = true;
        break;
      }
    }

    assert.ok(sawNetBlock, 'Defender at net must enter ANIM_STATES.NET_BLOCK / emit EVENTS.NET_BLOCK');
    assert.ok(sawStuffOrBlock, 'Net blocker must intercept attack with EVENTS.STUFF_BLOCK / SHOT_TYPES.BLOCK_STUFF');
  });

  it('T1-D4: 1v1 (2 players) vs 2v2 (4 players) format & Team 1 AI partner 3-touch support', () => {
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE });
    const snap1 = engine.getSnapshot();
    assert.equal(snap1.players.length, 2, '1v1 must have exactly 2 players');

    engine.setFormat(MATCH_FORMATS.TWO_V_TWO);
    const snap2 = engine.getSnapshot();
    assert.equal(snap2.players.length, 4, '2v2 must have exactly 4 players');

    const team1Players = snap2.players.filter((p) => p.team === 1);
    const team2Players = snap2.players.filter((p) => p.team === 2);
    assert.equal(team1Players.length, 2);
    assert.equal(team2Players.length, 2);
    assert.ok(team1Players.some((p) => p.role === 'PRIMARY') && team1Players.some((p) => p.role === 'PARTNER'));
    assert.ok(team2Players.some((p) => p.role === 'PRIMARY') && team2Players.some((p) => p.role === 'PARTNER'));

    const partnerStart = structuredClone(team1Players.find((p) => p.role === 'PARTNER').pos);
    const bot = createBotController({ team: 1 });
    let partnerMoved = false;

    for (let step = 0; step < 120 * 10; step++) {
      const snap = engine.getSnapshot();
      const { cmd } = bot.step(snap);
      engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: cmd }), PHYSICS_DEFAULTS);
      const partner = engine.getSnapshot().players.find((p) => p.team === 1 && p.role === 'PARTNER');
      if (Math.hypot(partner.pos.x - partnerStart.x, partner.pos.z - partnerStart.z) > 0.35) {
        partnerMoved = true;
        break;
      }
    }

    assert.ok(partnerMoved, 'In 2v2, Team 1 AI partner must actively move to participate in the 3-touch rally');
  });

  it('T1-D5: 3-Style Solo AI Opponent FSM (WIND_LOBBER, NET_BLOCKER, SPIN_SLICER) returns rallies with valid states', () => {
    const validAnims = new Set(Object.values(ANIM_STATES));
    const stats = {};

    for (const style of Object.values(AI_STYLES)) {
      const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE, aiStyle: style });
      engine.setAiStyle(style);
      const bot = createBotController({ team: 1 });

      let maxBallYAfterAiHit = 0;
      let maxOmegaAfterAiHit = 0;
      let minAiNetDist = Infinity;
      let aiTouchedBall = false;
      let aiNetBlockSeen = false;

      for (let step = 0; step < 120 * 16; step++) {
        const snap = engine.getSnapshot();
        const { cmd } = bot.step(snap);
        engine.stepFixed(FIXED_DT, makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, { p1Overrides: cmd }), PHYSICS_DEFAULTS);

        const next = engine.getSnapshot();
        const ai = next.players.find((p) => p.team === 2);
        assert.ok(validAnims.has(ai.animState), `Invalid AI animState ${ai.animState} in ${style}`);
        assertFiniteVec3(ai.pos, `${style}.ai.pos`);

        minAiNetDist = Math.min(minAiNetDist, Math.abs(ai.pos.x));
        if (ai.animState === ANIM_STATES.NET_BLOCK) aiNetBlockSeen = true;
        if (next.ball.lastHitTeam === 2 && next.ball.active) {
          aiTouchedBall = true;
          maxBallYAfterAiHit = Math.max(maxBallYAfterAiHit, next.ball.pos.y);
          const wMag = Math.hypot(next.ball.omega.x, next.ball.omega.y, next.ball.omega.z);
          maxOmegaAfterAiHit = Math.max(maxOmegaAfterAiHit, wMag);
        }
      }

      assert.ok(aiTouchedBall, `${style} AI must track and return incoming rallies`);
      stats[style] = { maxBallYAfterAiHit, maxOmegaAfterAiHit, minAiNetDist, aiNetBlockSeen };
    }

    assert.ok(
      stats[AI_STYLES.WIND_LOBBER].maxBallYAfterAiHit > 3.2,
      `WIND_LOBBER should send high-arc lobs (maxY=${stats[AI_STYLES.WIND_LOBBER].maxBallYAfterAiHit.toFixed(2)})`,
    );
    assert.ok(
      stats[AI_STYLES.NET_BLOCKER].minAiNetDist < 2.2 || stats[AI_STYLES.NET_BLOCKER].aiNetBlockSeen,
      `NET_BLOCKER should contest near net (minDist=${stats[AI_STYLES.NET_BLOCKER].minAiNetDist.toFixed(2)})`,
    );
    assert.ok(
      stats[AI_STYLES.SPIN_SLICER].maxOmegaAfterAiHit > 1.0,
      `SPIN_SLICER must impart non-trivial spin (maxOmega=${stats[AI_STYLES.SPIN_SLICER].maxOmegaAfterAiHit.toFixed(2)})`,
    );
  });

  it('T1-D6: Sand impact scoring, serve rotation, and resetMatch() zeroing', () => {
    const engine = rallyMod.createRallyEngine({ format: MATCH_FORMATS.ONE_V_ONE });
    const startScores = readScores(engine.getSnapshot());
    assert.equal(startScores.team1, 0);
    assert.equal(startScores.team2, 0);

    // Trigger serve from P1 then stand idle so a point is cleanly scored on sand impact
    let sawSandImpact = false;
    let sawPointScored = false;
    let scored = false;

    for (let step = 0; step < 120 * 15; step++) {
      const triggerServe = step === 2;
      const inputs = makeIdleInputs(INPUT_MODES.TWO_PAD_KEYBOARD, {
        p1Overrides: {
          primaryHeld: triggerServe,
          primaryJustPressed: triggerServe,
          primaryJustReleased: step === 3,
        },
        p2Overrides: { isHuman: true }, // Keep P2 idle so P1 serve lands on Team 2 sand (or vice versa)
      });
      engine.stepFixed(FIXED_DT, inputs, PHYSICS_DEFAULTS);
      const snap = engine.getSnapshot();
      const evTypes = extractEventTypes(snap.events);
      if (evTypes.includes(EVENTS.SAND_IMPACT)) sawSandImpact = true;
      if (evTypes.includes(EVENTS.POINT_SCORED)) sawPointScored = true;
      const sc = readScores(snap);
      if (sc.team1 + sc.team2 > 0) {
        scored = true;
        break;
      }
    }

    assert.ok(sawSandImpact, 'Ball hitting sand must emit EVENTS.SAND_IMPACT');
    assert.ok(sawPointScored, 'Point end must emit EVENTS.POINT_SCORED');
    assert.ok(scored, 'Scoreboard must increment when ball hits sand');

    engine.resetMatch();
    const afterReset = engine.getSnapshot();
    const resetScores = readScores(afterReset);
    assert.equal(resetScores.team1, 0, 'resetMatch() must zero Team 1 score');
    assert.equal(resetScores.team2, 0, 'resetMatch() must zero Team 2 score');
    for (const p of afterReset.players) {
      assert.equal(p.heatMeter, 0, 'resetMatch() must zero player heatMeter');
    }
  });
});

/* ========================================================================== *
 * AREA E — Input Manager & 3-Second Quick-Bind (src/inputManager.js)
 * ========================================================================== */
describe('Tier 1 — Area E: Input Manager & 3s Quick-Bind (src/inputManager.js)', () => {
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

  function assertPlayerInputCmdSchema(cmd, label) {
    for (const numKey of ['moveX', 'moveZ', 'aimX', 'aimZ']) {
      assert.ok(typeof cmd[numKey] === 'number' && Number.isFinite(cmd[numKey]), `${label}.${numKey} must be finite number`);
    }
    for (const boolKey of [
      'primaryHeld',
      'primaryJustPressed',
      'primaryJustReleased',
      'secondaryHeld',
      'secondaryJustPressed',
      'secondaryJustReleased',
      'isHuman',
      'autoFootwork',
    ]) {
      assert.equal(typeof cmd[boolKey], 'boolean', `${label}.${boolKey} must be boolean`);
    }
  }

  it('T1-E1: Mode switching (1PAD, 2PAD, TOUCH) & strict PlayerInputCmd schema', () => {
    shims = installInputShims();
    activeManager = inputMod.createInputManager(shims.canvas);

    for (const mode of Object.values(INPUT_MODES)) {
      activeManager.setMode(mode);
      assert.equal(activeManager.getMode(), mode);
      const polled = activeManager.pollInputs(FIXED_DT);
      assert.equal(polled.mode, mode);
      assert.equal(typeof polled.padsConnected, 'number');
      assertPlayerInputCmdSchema(polled.p1, `${mode}.p1`);
      assertPlayerInputCmdSchema(polled.p2, `${mode}.p2`);
    }
  });

  it('T1-E2: Harvested Stadia 1-PAD SPLIT mappings (L/R sticks, L1/L2, R1/R2/A, D-pad & edge flags)', () => {
    shims = installInputShims();
    activeManager = inputMod.createInputManager(shims.canvas);
    activeManager.setMode(INPUT_MODES.ONE_PAD_SPLIT);

    // Frame 1: press sticks + L1 (btn 4) + R1 (btn 5)
    shims.setGamepads([
      createMockGamepad({
        index: 0,
        axes: [0.8, -0.6, -0.7, 0.5],
        pressedButtons: [4, 5],
      }),
    ]);
    const f1 = activeManager.pollInputs(FIXED_DT);
    assert.equal(f1.padsConnected, 1);
    assert.ok(f1.p1.moveX > 0.5, 'P1 L-Stick X=0.8 must produce moveX > 0.5');
    assert.ok(f1.p1.moveZ < -0.3, 'P1 L-Stick Y=-0.6 must produce moveZ < -0.3');
    assert.equal(f1.p1.primaryHeld, true);
    assert.equal(f1.p1.primaryJustPressed, true);
    assert.equal(f1.p1.primaryJustReleased, false);
    assert.ok(f1.p2.moveX < -0.4, 'P2 R-Stick X=-0.7 must produce moveX < -0.4');
    assert.equal(f1.p2.primaryHeld, true);
    assert.equal(f1.p2.primaryJustPressed, true);

    // Frame 2: keep held -> JustPressed must clear
    const f2 = activeManager.pollInputs(FIXED_DT);
    assert.equal(f2.p1.primaryHeld, true);
    assert.equal(f2.p1.primaryJustPressed, false);
    assert.equal(f2.p2.primaryHeld, true);
    assert.equal(f2.p2.primaryJustPressed, false);

    // Frame 3: release buttons & press D-pad Left (14) + A (0) for P2
    shims.setGamepads([
      createMockGamepad({
        index: 0,
        axes: [0, 0, 0, 0],
        pressedButtons: [14, 0],
      }),
    ]);
    const f3 = activeManager.pollInputs(FIXED_DT);
    assert.equal(f3.p1.primaryHeld, false);
    assert.equal(f3.p1.primaryJustReleased, true);
    assert.ok(f3.p1.moveX < -0.5, 'D-pad Left (button 14) must move P1 left');
    assert.equal(f3.p2.primaryHeld, true, 'Button 0 (A) must act as P2 primary in 1-PAD SPLIT');
  });

  it('T1-E3: 2-PAD / KEYBOARD dual pads and WASD/Space + Arrows/Enter keyboard fallback', () => {
    shims = installInputShims();
    activeManager = inputMod.createInputManager(shims.canvas);
    activeManager.setMode(INPUT_MODES.TWO_PAD_KEYBOARD);

    // Keyboard P1 & P2
    shims.dispatchKey('keydown', 'KeyD');
    shims.dispatchKey('keydown', 'Space');
    shims.dispatchKey('keydown', 'ArrowLeft');
    shims.dispatchKey('keydown', 'Enter');
    const k1 = activeManager.pollInputs(FIXED_DT);
    assert.ok(k1.p1.moveX > 0.5);
    assert.equal(k1.p1.primaryHeld, true);
    assert.equal(k1.p1.primaryJustPressed, true);
    assert.ok(k1.p2.moveX < -0.5);
    assert.equal(k1.p2.primaryHeld, true);
    assert.equal(k1.p2.primaryJustPressed, true);

    shims.dispatchKey('keyup', 'KeyD');
    shims.dispatchKey('keyup', 'Space');
    shims.dispatchKey('keyup', 'ArrowLeft');
    shims.dispatchKey('keyup', 'Enter');
    const k2 = activeManager.pollInputs(FIXED_DT);
    assert.equal(k2.p1.primaryHeld, false);
    assert.equal(k2.p1.primaryJustReleased, true);
    assert.equal(k2.p2.primaryHeld, false);
    assert.equal(k2.p2.primaryJustReleased, true);

    // Dual gamepads (padIndex 0 & 1)
    shims.setGamepads([
      createMockGamepad({ index: 0, axes: [-0.9, 0, 0, 0], pressedButtons: [0] }),
      createMockGamepad({ index: 1, axes: [0.9, 0, 0, 0], pressedButtons: [7] }),
    ]);
    const g1 = activeManager.pollInputs(FIXED_DT);
    assert.equal(g1.padsConnected, 2);
    assert.ok(g1.p1.moveX < -0.5);
    assert.equal(g1.p1.primaryHeld, true);
    assert.ok(g1.p2.moveX > 0.5);
    assert.equal(g1.p2.primaryHeld, true);
  });

  it('T1-E4: TOUCH AUTO-FOOTWORK mode sets autoFootwork=true and handles pointer tap/swipe', () => {
    shims = installInputShims();
    activeManager = inputMod.createInputManager(shims.canvas);
    activeManager.setMode(INPUT_MODES.TOUCH_AUTO);

    const idle = activeManager.pollInputs(FIXED_DT);
    assert.equal(idle.p1.autoFootwork, true, 'TOUCH mode must enable p1.autoFootwork');

    shims.dispatchPointer('pointerdown', { clientX: 300, clientY: 500 });
    const downPoll = activeManager.pollInputs(FIXED_DT);
    shims.dispatchPointer('pointermove', { clientX: 460, clientY: 260 });
    const movePoll = activeManager.pollInputs(FIXED_DT);
    shims.dispatchPointer('pointerup', { clientX: 460, clientY: 260 });
    const upPoll = activeManager.pollInputs(FIXED_DT);

    const anyTouchAction =
      downPoll.p1.primaryHeld ||
      downPoll.p1.primaryJustPressed ||
      movePoll.p1.primaryHeld ||
      upPoll.p1.primaryJustPressed ||
      upPoll.p1.primaryJustReleased ||
      upPoll.p1.secondaryJustPressed ||
      upPoll.p1.secondaryJustReleased;
    assert.ok(anyTouchAction, 'Touch tap/swipe on canvas must produce a primary or secondary action signal');
  });

  it('T1-E5: 3-second Quick-Bind calibration saves to STORAGE_KEYS.BINDINGS and persists across reload', () => {
    shims = installInputShims();
    activeManager = inputMod.createInputManager(shims.canvas);
    activeManager.setMode(INPUT_MODES.TWO_PAD_KEYBOARD);

    const updates = [];
    let donePayload = null;
    activeManager.startQuickBind(
      (info) => updates.push(info),
      (result) => {
        donePayload = result ?? true;
      },
    );

    // Feed 4 distinct keys across Quick-Bind slots (p1Primary, p1Secondary, p2Primary, p2Secondary)
    const keysToBind = ['KeyF', 'KeyG', 'KeyJ', 'KeyK'];
    for (const code of keysToBind) {
      shims.dispatchKey('keydown', code);
      activeManager.pollInputs(0.05);
      shims.dispatchKey('keyup', code);
      activeManager.pollInputs(0.05);
      if (donePayload !== null) break;
    }

    // If modal is still counting down a final step, advance timer cleanly up to 14s max
    for (let i = 0; i < 140 && donePayload === null; i++) {
      activeManager.pollInputs(0.1);
    }

    assert.ok(updates.length > 0, 'startQuickBind must invoke onUpdate callback');
    assert.notEqual(donePayload, null, 'startQuickBind must invoke onDone callback upon completion');

    const storedRaw = shims.localStorage.getItem(STORAGE_KEYS.BINDINGS);
    assert.ok(storedRaw && storedRaw.length > 2, 'Quick-Bind must persist bindings to STORAGE_KEYS.BINDINGS');
    const parsed = JSON.parse(storedRaw);
    assert.ok(parsed && typeof parsed === 'object');

    // Re-instantiate fresh inputManager against same storage and verify persistence
    const savedBindings = activeManager.getBindings();
    activeManager.destroy();
    activeManager = inputMod.createInputManager(shims.canvas);
    assert.deepEqual(activeManager.getBindings(), savedBindings, 'Fresh inputManager must restore persisted bindings');
  });

  it('T1-E6: setBindings, resetBindings restore defaults and destroy() removes DOM listeners', () => {
    shims = installInputShims();
    activeManager = inputMod.createInputManager(shims.canvas);
    activeManager.setMode(INPUT_MODES.TWO_PAD_KEYBOARD);

    const custom = createDefaultBindings();
    custom.keyboard.p1.primary = ['KeyF'];
    activeManager.setBindings(custom);
    assert.ok(activeManager.getBindings().keyboard.p1.primary.includes('KeyF'));

    activeManager.resetBindings();
    const defaults = createDefaultBindings();
    assert.deepEqual(activeManager.getBindings().keyboard.p1.primary, defaults.keyboard.p1.primary);

    activeManager.destroy();
    // Dispatching keys after destroy must not throw or re-trigger state
    assert.doesNotThrow(() => {
      shims.dispatchKey('keydown', 'Space');
      shims.dispatchKey('keyup', 'Space');
    });
    const afterDestroy = activeManager.pollInputs(FIXED_DT);
    assert.equal(afterDestroy.p1.primaryHeld, false, 'Destroyed inputManager must ignore subsequent keydown events');
    activeManager = null;
  });
});

/* ========================================================================== *
 * AREA F — Muted-by-Default Procedural Web Audio Synth (src/audioSynth.js)
 * ========================================================================== */
describe('Tier 1 — Area F: Muted-by-Default Procedural Web Audio Synth (src/audioSynth.js)', () => {
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

  it('T1-F1: Audio starts muted by default and performs ZERO AudioContext construction before gesture', () => {
    spyHandle = installAudioContextSpy();
    synth = audioMod.createAudioSynth();

    assert.equal(synth.isEnabled(), false, 'audioSynth must start muted (isEnabled() === false)');
    synth.updateAmbience(createWindState({ phase: WIND_PHASES.GUST, speed: 7.5 }));
    synth.handleEvents([{ type: EVENTS.HEAT_SPIKE }, { type: EVENTS.POINT_SCORED }]);
    assert.equal(spyHandle.spy.constructorCallCount, 0, 'AudioContext must NOT be constructed before user gesture');
  });

  it('T1-F2: Explicit toggle() and setEnabled() lazily construct AudioContext once and call resume()', () => {
    spyHandle = installAudioContextSpy({ initialState: 'suspended' });
    synth = audioMod.createAudioSynth();

    synth.toggle();
    assert.equal(synth.isEnabled(), true);
    assert.equal(spyHandle.spy.constructorCallCount, 1, 'First enable must construct AudioContext lazily');
    assert.ok(spyHandle.spy.resumeCalls >= 1, 'Enabling suspended AudioContext must call resume()');

    synth.toggle();
    assert.equal(synth.isEnabled(), false);

    synth.setEnabled(true);
    assert.equal(synth.isEnabled(), true);
    assert.equal(spyHandle.spy.constructorCallCount, 1, 'Re-enabling must reuse existing AudioContext');
  });

  it('T1-F3: updateAmbience modulates ocean/wind audio cleanly across BREEZE, WARNING, and GUST', () => {
    spyHandle = installAudioContextSpy();
    synth = audioMod.createAudioSynth();
    synth.setEnabled(true);

    const phases = [
      createWindState({ phase: WIND_PHASES.BREEZE, speed: 1.5, windVec3: { x: 1.5, y: 0, z: 0 } }),
      createWindState({ phase: WIND_PHASES.WARNING, speed: 3.2, windVec3: { x: 3.0, y: 0, z: 1.1 } }),
      createWindState({ phase: WIND_PHASES.GUST, speed: 8.5, windVec3: { x: 8.0, y: 0, z: -2.8 } }),
    ];

    for (const w of phases) {
      const beforeParams = spyHandle.spy.paramCalls.length;
      assert.doesNotThrow(() => synth.updateAmbience(w));
      assert.ok(
        spyHandle.spy.paramCalls.length > beforeParams,
        `updateAmbience(${w.phase}) must schedule AudioParam modulation calls`,
      );
    }
    assert.equal(spyHandle.spy.constructorCallCount, 1);
    assert.deepEqual(spyHandle.spy.nonFiniteParams, [], 'All scheduled AudioParam values must be finite');
  });

  it('T1-F4: handleEvents synthesizes SFX cleanly across all 17 frozen EVENTS', () => {
    spyHandle = installAudioContextSpy();
    synth = audioMod.createAudioSynth();
    synth.setEnabled(true);

    const nodesBefore = spyHandle.spy.createdNodes.length;
    const allEventObjects = Object.values(EVENTS).map((type) => ({ type, intensity: 1.0 }));
    assert.doesNotThrow(() => synth.handleEvents(allEventObjects));

    assert.ok(
      spyHandle.spy.createdNodes.length > nodesBefore,
      'Dispatching gameplay events (including HEAT_SPIKE) must synthesize Web Audio nodes',
    );
    assert.deepEqual(spyHandle.spy.nonFiniteParams, [], 'All event SFX AudioParam values must be finite');
  });

  it('T1-F5: playChargeSweep, playRefereeWhistle, and dispose() close AudioContext cleanly', () => {
    spyHandle = installAudioContextSpy();
    synth = audioMod.createAudioSynth();
    synth.setEnabled(true);

    const nodesBeforeSweep = spyHandle.spy.createdNodes.length;
    const paramsBeforeSweep = spyHandle.spy.paramCalls.length;
    assert.doesNotThrow(() => synth.playChargeSweep(0.25));
    assert.ok(spyHandle.spy.createdNodes.length > nodesBeforeSweep, 'playChargeSweep(0.25) must create audio nodes');
    assert.ok(spyHandle.spy.paramCalls.length > paramsBeforeSweep, 'playChargeSweep(0.25) must schedule AudioParams');
    assert.doesNotThrow(() => synth.playChargeSweep(1.0));

    const nodesBeforeServe = spyHandle.spy.createdNodes.length;
    const paramsBeforeServe = spyHandle.spy.paramCalls.length;
    assert.doesNotThrow(() => synth.playRefereeWhistle('serve'));
    assert.ok(spyHandle.spy.createdNodes.length > nodesBeforeServe, "playRefereeWhistle('serve') must create audio nodes");
    assert.ok(spyHandle.spy.paramCalls.length > paramsBeforeServe, "playRefereeWhistle('serve') must schedule AudioParams");

    const nodesBeforePoint = spyHandle.spy.createdNodes.length;
    const paramsBeforePoint = spyHandle.spy.paramCalls.length;
    assert.doesNotThrow(() => synth.playRefereeWhistle('point'));
    assert.ok(spyHandle.spy.createdNodes.length > nodesBeforePoint, "playRefereeWhistle('point') must create audio nodes");
    assert.ok(spyHandle.spy.paramCalls.length > paramsBeforePoint, "playRefereeWhistle('point') must schedule AudioParams");

    assert.deepEqual(spyHandle.spy.nonFiniteParams, []);

    synth.dispose();
    assert.equal(spyHandle.spy.closeCalls, 1, 'dispose() must close AudioContext');
    assert.equal(synth.isEnabled(), false, 'dispose() must leave isEnabled() === false');
    synth = null;
  });
});
