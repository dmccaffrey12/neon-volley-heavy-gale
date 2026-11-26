# AGENTS.md — SUMMER HEAT 3D Engineering Rules & Contracts

This file defines the binding architectural invariants, exclusive file ownership boundaries, coordinate & physics conventions, PWA cache rules, and verification commands for **SUMMER HEAT 3D** on branch `feat/summer-heat-3d`. Every implementation worker, test author, reviewer, and verifier MUST obey these rules strictly.

---

## 1. Branch & Exclusive File Ownership

All implementation work occurs on branch **`feat/summer-heat-3d`** (branched from `main` at `dd038f8`). Workers MUST NOT edit, create, or delete any file outside their assigned ownership scope.

| Role | Exclusive Writable Files |
| :--- | :--- |
| **Worker-Physics** | `./src/physics3d.js`, `./tests/unit/physics3d.test.mjs` |
| **Worker-Visuals** | `./src/courtScene.js`, `./src/playerRigs.js`, `./tests/unit/visuals.test.mjs` |
| **Worker-Gameplay** | `./src/rallyEngine.js`, `./src/inputManager.js`, `./tests/unit/gameplay.test.mjs` |
| **Worker-AppShell** | `./src/main.js`, `./src/audioSynth.js`, `./index.html`, `./sw.js`, `./manifest.json`, `./tests/unit/appshell.test.mjs` |

### Frozen Read-Only Files (DO NOT MODIFY after M0)
- `./AGENTS.md`
- `./src/contracts.js`
- `./vendor/three.module.min.js`
- `./classic-2d/index.html`, `./classic-2d/game.js`, `./classic-2d/manifest.json`
- `./README.md` (untouched by M1–M4)

---

## 2. Zero-Build, Zero-CDN, Offline-First PWA Invariants

1. **Zero Build Tools**: Pure browser-native ES2022+ modules (`<script type="module">`). FORBIDDEN: bundlers (Webpack/Vite/Rollup/esbuild), TypeScript compilation, or npm runtime dependencies (`node_modules`).
2. **Zero External Network Requests**: FORBIDDEN: CDN scripts, Google Fonts, remote CSS, external images/textures/HDRIs/models, or remote audio files. Every asset is procedural or vendored locally.
3. **Offline Vendored Three.js**: Pinned to **`three@0.170.0`** (`THREE.REVISION === '170'`), self-contained single-file ESM bundle at `./vendor/three.module.min.js` with zero relative imports (no `three.core.js` split).
   - Every Three.js import inside `./src/*.js` MUST use the exact relative specifier:
     ```js
     import * as THREE from '../vendor/three.module.min.js';
     ```
   - FORBIDDEN: bare `'three'` specifiers, CDN URLs, or import maps referencing external hosts.

---

## 3. Strictly Acyclic Module Dependency DAG

Circular imports are strictly FORBIDDEN. Each module may import ONLY the dependencies listed below:

```text
src/contracts.js          -> imports NOTHING (zero dependencies; frozen constants, schemas, helpers)
src/physics3d.js          -> imports ONLY ./contracts.js (NO DOM, NO Three.js — pure deterministic math)
src/inputManager.js       -> imports ONLY ./contracts.js
src/audioSynth.js         -> imports ONLY ./contracts.js (muted by default; lazy AudioContext after gesture)
src/playerRigs.js         -> imports ONLY ../vendor/three.module.min.js, ./contracts.js
src/courtScene.js         -> imports ONLY ../vendor/three.module.min.js, ./contracts.js, ./playerRigs.js
src/rallyEngine.js        -> imports ONLY ./contracts.js, ./physics3d.js (NO DOM, NO Three.js)
src/main.js               -> imports ./contracts.js, ./physics3d.js, ./courtScene.js, ./inputManager.js, ./rallyEngine.js, ./audioSynth.js
```

---

## 4. Determinism, Stability & Rendering Invariants

1. **Fixed-Timestep 120Hz Simulation**:
   - Physics runs strictly at `FIXED_DT = 1 / 120` seconds (`src/contracts.js`).
   - `rallyEngine.update(rawDt, inputs, physicsConfig)` owns the fixed-timestep accumulator and 2-frame Heat Spike hit-stop, clamping incoming frame deltas to `rawDt <= 0.05` so background tabs never trigger a spiral of death or floor tunneling.
   - `rallyEngine.stepFixed(dt, inputs, physicsConfig)` is exposed for deterministic single-step unit/integration tests.
2. **Pure Non-Mutating Lookahead Predictor**:
   - `predictLandingPoint3D(ballState, windState, physicsConfig, maxSteps = MAX_PREDICT_STEPS)` MUST NOT mutate `ballState` or `windState`.
   - It runs up to `MAX_PREDICT_STEPS = 180` exact `FIXED_DT` steps (1.50 s); if the ball is still airborne (`y > ball.radius`) after 180 steps (e.g., high Sky Lob), it appends an analytic quadratic ballistic tail to `y = ball.radius` (clamped inside arena walls) with `landedWithinSteps: false`.
3. **Finite Numeric Guards**:
   - Guard all positions, velocities, angular velocities (`omega`), quaternions, IK targets, and camera matrices against `NaN`, `±Infinity`, and zero-length vector division (`len < 1e-8`).
   - Clamp `omega` magnitude to `BALL_SPEC.MAX_OMEGA` (`24.0 rad/s`).
4. **WebGL & Three.js Resource Discipline**:
   - Cap pixel ratio: `renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))`.
   - Zero per-frame Three.js `Geometry` or `Material` allocations inside `syncState()` or `render()`; pre-allocate buffers/meshes/pools and dispose cleanly in `dispose()`.
   - Keep shadow map dimensions SwiftShader-friendly (e.g., `1024x1024` `PCFSoftShadowMap`; avoid `4096x4096`).
   - Reset `renderer.setScissorTest(false)` when rendering `BROADCAST` mode after `SPLIT` mode.
5. **Runtime Error Hygiene**:
   - Zero console errors, zero uncaught promise rejections, and zero WebGL errors/warnings at `1280x720`, `844x390`, and portrait `390x844`.
   - Wrap `navigator.wakeLock.request('screen')` in `try/catch` (silently ignoring `NotAllowedError` or unsupported browsers) and re-acquire on `visibilitychange`.
   - Wrap all `localStorage` reads/writes in `try/catch` and sanitize loaded JSON via `sanitizePhysicsConfig()` / defaults so missing or corrupt storage never throws.
   - Audio starts muted (`isEnabled() === false`); do NOT construct or resume `AudioContext` before an explicit user gesture.

---

## 5. Coordinate System, Spin Math & Cross-Module Contracts

### 5.1 Right-Handed 3D Coordinate System (SI Meters)
- **`+X`**: Team 2 (right court) | **`-X`**: Team 1 (left court)
- **`+Y`**: Up (sand plane at `Y = 0`)
- **`+Z`**: Near sideline (toward Broadcast 3/4 camera) | **`-Z`**: Far sideline (ocean / sunset horizon)
- **Court lines**: `X ∈ [-8, +8]`, `Z ∈ [-4, +4]` (`16 m × 8 m`)
- **Outer stadium arcade walls**: `X = ±11.5`, `Z = ±6.5`, `CEILING_Y = 14.0` (balls stay live off walls/ceiling until sand impact `y <= BALL_SPEC.RADIUS`)
- **Net**: `X = 0`, `Z ∈ [-4.5, +4.5]`, `NET_HEIGHT = 2.38`, `NET_TAPE_RADIUS = 0.08`, `NET_POST_RADIUS = 0.09`

### 5.2 Magnus Force & Spin-Reactive Wall Sign Convention
- Relative air velocity: `vRel = v - windVec3`.
- Quadratic drag: `a_drag = -kDrag * |vRel| * vRel`.
- 3D Magnus acceleration: `a_magnus = kMagnus * (omega × vRel)`.
- Topspin axis for horizontal flight unit vector `dirXZ = (nx, 0, nz)`: `up × dirXZ = (nz, 0, -nx)`.
- `computeSpinOmega(dirX, dirZ, topspinRadS, sidespinRadS)` returns `{ x: nz * topspinRadS, y: sidespinRadS, z: -nx * topspinRadS }` (proportionally capped at `BALL_SPEC.MAX_OMEGA`):
  - **Topspin (`topspinRadS > 0`)**: `+X` shot gives `omega = (0, 0, -w)`, `-X` shot gives `omega = (0, 0, +w)` -> `omega × vRel` points downward (`-Y` dive) symmetrically in both directions.
  - **Backspin (`topspinRadS < 0`)**: `omega × vRel` points upward (`+Y` float/lift).
  - **Sidespin (`sidespinRadS ≠ 0`)**: `omega.y = sidespinRadS` curves laterally along `Z`/`X`.
- **Spin-reactive vertical wall kick**: `v_kick = kWallSpin * (inwardNormal × omega)`:
  - Right wall (`inwardNormal = (-1, 0, 0)`) + P1 topspin `(0, 0, -w)` -> `(0, -w, 0)` (banks downward toward sand).
  - Left wall (`inwardNormal = (+1, 0, 0)`) + P2 topspin `(0, 0, +w)` -> `(0, -w, 0)` (banks downward toward sand).
  - Backspin pops upward (`+Y`) on both left and right walls.

### 5.3 Frozen Cross-Module API Summary
- **`./src/contracts.js`**: Exports frozen constants (`FIXED_DT`, `MAX_PREDICT_STEPS`, `COORDINATE_SYSTEM`, `COURT`, `BALL_SPEC`, `PHYSICS_DEFAULTS`, `PHYSICS_LIMITS`, `STORAGE_KEYS`, `INPUT_MODES`, `CAMERA_MODES`, `AI_STYLES`, `MATCH_FORMATS`, `ANIM_STATES`, `WIND_PHASES`, `TRAIL_MODES`, `SHOT_TYPES`, `EVENTS`) and helpers (`clamp`, `createVec3`, `computeSpinOmega`, `createBallState`, `createWindState`, `createPlayerState`, `createDefaultBindings`, `sanitizePhysicsConfig`).
- **`./src/physics3d.js`**: Exports `FIXED_DT`, `updateWind3D(windState, dt, physicsConfig)`, `triggerGaleSurge(windState, dirSignX)`, `stepBall3D(ballState, windState, physicsConfig, dt, isSimulation)`, `predictLandingPoint3D(ballState, windState, physicsConfig, maxSteps)`.
- **`./src/playerRigs.js`**: Exports `createPlayerRig({ id, team, role })`, `updatePlayerRig(rig, playerState, ballState, dt)`, `disposePlayerRig(rig)` supporting all 7 `ANIM_STATES`.
- **`./src/courtScene.js`**: Exports `createCourtScene(canvas, options)` -> `{ syncState(snapshot, dt), render(cameraMode), resize(width, height), triggerCameraPunch(intensity), dispose() }`.
- **`./src/inputManager.js`**: Exports `createInputManager(canvas, options)` -> `{ setMode, getMode, pollInputs(dt), getBindings, setBindings, resetBindings, startQuickBind(onUpdate, onDone), cancelQuickBind, destroy }`.
- **`./src/rallyEngine.js`**: Exports `createRallyEngine(options)` -> `{ update(rawDt, inputs, physicsConfig), stepFixed(dt, inputs, physicsConfig), getSnapshot(), setFormat, setAiStyle, triggerGust, resetMatch, setPaused }` (supports optional `options.physics` DI override for isolated unit testing).
- **`./src/audioSynth.js`**: Exports `createAudioSynth()` -> `{ isEnabled, toggle, setEnabled, updateAmbience(windState), handleEvents(events), playChargeSweep(ratio), playRefereeWhistle(kind), dispose }`.
- **`./src/main.js`**: Wires all modules, HUD controls (with stable `id`/`data-testid` attributes), Physics Lab drawer, Quick-Bind modal, Wake Lock, Portrait Auto-Pause, SW registration, and read-only telemetry hook `window.__SUMMER_HEAT_DEBUG__` (`getSnapshot`, `getCameraMode`, `getInputMode`, `isPaused`, `getPhysicsConfig`, `getAudioEnabled`).

---

## 6. PWA, Service Worker & Classic 2D Hygiene

1. **Service Worker (`./sw.js`)**:
   - `CACHE_NAME = 'summer-heat-3d-v2'`.
   - Strategy: **Stale-While-Revalidate** for GET requests (return cached response immediately while revalidating in background; offline fallback to `./index.html` for navigations).
   - `activate` event MUST delete every cache key `!== 'summer-heat-3d-v2'` (including `'neon-volley-heavy-gale-v1'`) and call `self.clients.claim()`.
   - `install` event MUST pre-cache:
     - `'./'`, `'./index.html'`, `'./manifest.json'`
     - `'./vendor/three.module.min.js'`
     - All 8 ES modules: `'./src/contracts.js'`, `'./src/physics3d.js'`, `'./src/playerRigs.js'`, `'./src/courtScene.js'`, `'./src/inputManager.js'`, `'./src/rallyEngine.js'`, `'./src/audioSynth.js'`, `'./src/main.js'`
     - Classic 2D archive: `'./classic-2d/'`, `'./classic-2d/index.html'`, `'./classic-2d/game.js'`, `'./classic-2d/manifest.json'`
2. **Manifest (`./manifest.json`)**:
   - MUST preserve the exact v1 inline SVG data-URI icon (`128x128`, `type: "image/svg+xml"`, `purpose: "any maskable"`), `display: "fullscreen"`, and `orientation: "landscape"`.
3. **Storage & Classic 2D Isolation**:
   - v2 storage MUST use `STORAGE_KEYS` (`summer_heat_3d_physics_v2`, `summer_heat_3d_bindings_v2`, `summer_heat_3d_settings_v2`), never touching v1's `neon_volley_heavy_gale_physics_v1`.
   - `./classic-2d/sw.js` MUST NOT exist, and `./classic-2d/index.html` MUST NOT register a service worker (root `./sw.js` serves `./classic-2d/*` under `summer-heat-3d-v2`).

---

## 7. Verified Syntax, Lint, Unit & Browser QA Commands

1. **ESM Syntax Check (`./src/*.js`)** — **CRITICAL**: Because this zero-build repo has no `package.json` `"type": "module"`, NEVER run bare `node --check` on ESM `.js` files (it silently exits `0` on broken ESM). Always use:
   ```bash
   for f in src/*.js; do
     node --input-type=module --check < "$f" || exit 1
   done
   ```
2. **Classic Script & JSON Checks**:
   ```bash
   node --check sw.js && node --check classic-2d/game.js
   python3 -m json.tool manifest.json > /dev/null && python3 -m json.tool classic-2d/manifest.json > /dev/null
   ```
3. **ESLint Zero-Config Static Check** (run from repo root):
   ```bash
   eslint --no-config-lookup --rule 'no-undef: off' src/*.js sw.js
   ```
4. **Node 22 Unit Tests** (zero external dependencies):
   ```bash
   node --test tests/unit/*.test.mjs
   ```
5. **Playwright Headless WebGL2 & Offline QA**:
   - Serve via `python3 -m http.server 8080 --bind 127.0.0.1` (use an ephemeral port like `18081` for local worker smoke tests when not running `@verifier` on `8080`, and always terminate the server in a `finally:` block).
   - Launch Chromium with SwiftShader flags:
     `["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]`
   - Test viewports `1280x720`, `844x390`, and portrait `390x844`.
   - **Avoid `gl.readPixels()`** (triggers a SwiftShader performance warning in console); inspect visuals via `page.screenshot()` + `PIL.Image` and read state via `window.__SUMMER_HEAT_DEBUG__`.
   - Always call `ctx.close()` before exiting to flush `.webm` video recordings.
