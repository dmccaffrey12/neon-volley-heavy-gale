# Project: SUMMER HEAT 3D — Arcade Beach Volleyball PWA

**Target Branch**: `feat/summer-heat-3d`  
**Repository**: `/home/antigravity/dmccaffrey12/neon-volley-heavy-gale`  
**Original Request**: `.agents/teamwork/ORIGINAL_REQUEST.md`  
**Runtime Policy**: Zero-build, zero-CDN, offline-first ES2022+ PWA served via `python3 -m http.server 8080 --bind 127.0.0.1`

---

## Architecture

### Dependency DAG (Strictly Acyclic — Zero Circular Imports)
```
src/contracts.js          (imports NOTHING — frozen constants, schemas, spin math helpers)
├── src/physics3d.js      (imports ONLY ./contracts.js — pure deterministic 120Hz 3D physics, no DOM/Three)
├── src/inputManager.js   (imports ONLY ./contracts.js — Stadia 1-PAD, 2-PAD/KB, Touch, 3s Quick-Bind)
├── src/audioSynth.js     (imports ONLY ./contracts.js — muted-by-default procedural Web Audio synth)
├── src/playerRigs.js     (imports ONLY ../vendor/three.module.min.js, ./contracts.js — articulated IK rigs)
│   └── src/courtScene.js (imports ONLY ../vendor/three.module.min.js, ./contracts.js, ./playerRigs.js)
├── src/rallyEngine.js    (imports ONLY ./contracts.js, ./physics3d.js — 3-touch loop + AI FSM, no DOM/Three)
└── src/main.js           (wires all modules, DOM HUD, Physics Lab, Wake Lock, Portrait Auto-Pause, SW)
```

### Dual Track Execution
1. **Implementation Track**:
   - **M0 (Prerequisite Scaffolding & Contract Freeze)**: Branch `feat/summer-heat-3d`, archive v1 into `./classic-2d/` (strip nested SW registration), vendor `three@0.170.0` single-file `./vendor/three.module.min.js`, freeze `AGENTS.md` and `./src/contracts.js`.
   - **M1–M4 (4 Parallel Non-Overlapping Module Milestones)**:
     - **M1 (`Worker-Physics`)**: `./src/physics3d.js` ONLY
     - **M2 (`Worker-Visuals`)**: `./src/courtScene.js`, `./src/playerRigs.js` ONLY
     - **M3 (`Worker-Gameplay`)**: `./src/rallyEngine.js`, `./src/inputManager.js` ONLY
     - **M4 (`Worker-AppShell`)**: `./src/main.js`, `./src/audioSynth.js`, `./index.html`, `./sw.js`, `./manifest.json` ONLY
   - **M5 (Final Milestone — Phase 1 E2E Tiers 1–4 + `@verifier` Browser/Offline QA; Phase 2 Tier 5 Adversarial Coverage Hardening)**: Runs full E2E suite, plays complete 3-touch `Bump -> Set -> Heat Spike` point in `Broadcast 3/4` and `2P Split-Screen` at `1280x720` and `844x390`, verifies `[Play Classic 2D]`, verifies `summer-heat-3d-v2` Cache Storage + offline reload with 0 console/WebGL errors, outputs screenshots & `.webm` recordings, then hardens coverage adversarially (Tier 5).
2. **E2E Testing Track** (Parallel with M1–M4 after M0):
   - Builds `TEST_INFRA.md`, opaque-box requirement-driven E2E test suite across Tiers 1–4 in `./tests/e2e/`, and publishes `TEST_READY.md`.

---

## Code Layout

```
/home/antigravity/dmccaffrey12/neon-volley-heavy-gale/
├── AGENTS.md                       # M0: Binding architecture, ownership, offline & QA rules
├── PROJECT.md                      # Living project index (owned by Project Orchestrator)
├── TEST_INFRA.md                   # E2E Track: test methodology & feature matrix
├── TEST_READY.md                   # E2E Track: completion signal & runner command
├── index.html                      # M4 (Worker-AppShell): 3D PWA shell, HUD, Physics Lab, Quick-Bind, Portrait Overlay
├── manifest.json                   # M4 (Worker-AppShell): PWA manifest preserving v1 SVG icon (fullscreen + landscape)
├── sw.js                           # M4 (Worker-AppShell): SWR Service Worker (summer-heat-3d-v2)
├── README.md                       # Preserved v1 README (untouched by M1-M4)
├── vendor/
│   └── three.module.min.js         # M0: Vendored Three.js r170 (three@0.170.0) self-contained ESM
├── classic-2d/                     # M0: Preserved v1 2D game (NO classic-2d/sw.js!)
│   ├── index.html                  # v1 HTML with ./sw.js registration removed + [← Back to 3D] link
│   ├── game.js                     # Exact v1 2D engine
│   └── manifest.json               # Exact v1 manifest
├── src/
│   ├── contracts.js                # M0: Frozen shared constants, schemas, helpers (READ-ONLY after M0)
│   ├── physics3d.js                # M1 (Worker-Physics): 120Hz 3D aerodynamics, wind, walls, net, predictor
│   ├── playerRigs.js               # M2 (Worker-Visuals): Articulated 3D IK athlete rigs (7 anim states)
│   ├── courtScene.js               # M2 (Worker-Visuals): Sunset stadium, shadows, waves, palms, reticle, ribbon, LED, cameras
│   ├── inputManager.js             # M3 (Worker-Gameplay): Stadia 1-PAD, 2-PAD/KB, Touch Auto-Footwork, 3s Quick-Bind
│   ├── rallyEngine.js              # M3 (Worker-Gameplay): 3-touch loop (1v1/2v2), Heat Spike/Pokey/Block, 3-style AI FSM
│   ├── audioSynth.js               # M4 (Worker-AppShell): Muted-by-default Web Audio synth
│   └── main.js                     # M4 (Worker-AppShell): App wiring, HUD, Physics Lab, Wake Lock, Portrait Auto-Pause
├── tests/
│   ├── unit/                       # Module unit tests (Node 22 `node --test`, zero external deps)
│   └── e2e/                        # E2E Testing Track (Python Playwright + Node opaque-box suite, Tiers 1-4 + Tier 5)
└── qa-artifacts/                   # M5 (@verifier): Screenshots (1280x720, 844x390, Broadcast, Split, Classic 2D) & .webm recordings
```

> **Note on root `game.js`**: During M0, v1 `index.html`, `game.js`, and `manifest.json` are copied to `./classic-2d/`. Once archived, root `./game.js` is superseded by `./src/*.js` and removed in M0 so the root directory stays clean.

---

## Feature Inventory

Every Survey feature is assigned to a milestone (zero unassigned):

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F01 | Branch, Classic 2D Archive, Vendored Three.js, `AGENTS.md`, `contracts.js` | Create `feat/summer-heat-3d`, archive v1 to `./classic-2d/` (strip nested SW registration, add `[← Back to 3D]`), vendor `three@0.170.0` to `./vendor/three.module.min.js`, author `AGENTS.md` and `./src/contracts.js` | M0 | `ORIGINAL_REQUEST.md:4,22`, Survey 1/2/3 |
| F02 | 120Hz Fixed-Timestep Integrator | Deterministic Semi-Implicit Euler at `FIXED_DT = 1/120` with finite guards | M1 | `ORIGINAL_REQUEST.md:7`, Survey 2 |
| F03 | Heavy Gale 3D Crosswinds & 4s Surges | Oscillating 3D `windVec3` baseline breeze (8–12s) -> 1s `WARNING` -> 4s `GUST` surge + manual `triggerGaleSurge()` | M1 | `ORIGINAL_REQUEST.md:7`, Survey 1/2 |
| F04 | Quadratic Air Drag & 3D Magnus Curve | `vRel = v - windVec3`, quadratic drag, `k_magnus * (omegaVec3 x vRel)` for diving topspin spikes, floating backspin pokeys/cuts, and sidespin hook | M1 | `ORIGINAL_REQUEST.md:7`, Survey 2 |
| F05 | Spin-Reactive Outer Arcade Walls & Rounded Net Tape | Live outer walls (`±ARENA_HALF_X`, `±ARENA_HALF_Z`, `CEILING_Y`) with `kWallSpin*(inwardNormal x omega)` kick (live until `y <= ballRadius`); rounded cylinder net tape + mesh/posts | M1 | `ORIGINAL_REQUEST.md:8`, Survey 2 |
| F06 | `predictLandingPoint3D` (180-Step Lookahead) | Up to 180 fast-forward `FIXED_DT` steps (non-mutating) returning exact `{ x, z, hangTime, landedWithinSteps, steps, trajectory }` with analytic tail fallback for >1.5s lobs | M1 | `ORIGINAL_REQUEST.md:9`, Survey 2 |
| F07 | Coastal Sunset Three.js Stadium | Sunset sky/sun, warm directional `PCFSoftShadowMap`, animated ocean waves, swaying palms, sand court markings, glowing translucent outer arcade walls, net + posts | M2 | `ORIGINAL_REQUEST.md:12`, Survey 2 |
| F08 | Wind Streamer, Drop-Shadow, Landing Reticle, Timing Ring & Spin Ribbon | Net-post streamer driven by `windVec3`, crisp drop-shadow + pulsing 3D landing reticle at `predictLandingPoint3D`, shrinking 3D Timing Ring at Set apex, fiery/cyan 3D ball spin ribbon | M2 | `ORIGINAL_REQUEST.md:12,16`, Survey 2 |
| F09 | Diegetic Stadium LED Scoreboard & Camera Modes | 3D stadium LED board (`CanvasTexture`) + `Broadcast 3/4` single camera & `2P Split-Screen` dual scissor/viewport cameras + Heat Spike camera punch | M2 | `ORIGINAL_REQUEST.md:20,26`, Survey 2 |
| F10 | Articulated 3D Athlete Rigs with IK & Squash-Stretch | Hierarchical capsule/sphere limbs, 2-bone procedural IK, spring squash-and-stretch animating all 7 states (`Idle`, `Sprint`, `UnderhandBump`, `OverheadSet`, `JumpHeatSpike`, `NetBlock`, `SandDive`) | M2 | `ORIGINAL_REQUEST.md:13`, Survey 2 |
| F11 | True Summer Heat 3-Touch Loop (1v1 & 2v2) | Touch 1 (`Bump/Dig` + `SandDive` -> setter zone + charges `heatMeter` 0–100%); Touch 2 (`Set` -> net loft + shrinking 3D Timing Ring); Touch 3 (`Attack` vs `NetBlock` -> full-meter **Heat Spike** with 2-frame hit-stop, camera punch, flame trail, topspin dive OR **Backspin Pokey/Cut** over **Stuff-Blocker**) | M3 | `ORIGINAL_REQUEST.md:16`, Survey 2 |
| F12 | 3-Style Solo AI Opponent FSM & 2v2 AI Partner | Solo AI opponent FSM (`Wind Lobber`, `Net Blocker`, `Spin Slicer`) + 2v2 AI partner supporting 3-touch chain | M3 | `ORIGINAL_REQUEST.md:16`, Survey 2 |
| F13 | Harvested Stadia Input Modes & 3s Quick-Bind Modal | 3 HUD-selectable modes (`1-PAD SPLIT Stadia`, `2-PAD / KEYBOARD`, `TOUCH AUTO-FOOTWORK`) porting exact v1 Stadia indices (`axes[0..3]`, `buttons[0,4,5,6,7,12..15]`, dz `0.16`) + keyboard fallback + 3-second Quick-Bind calibration modal saved to `localStorage` | M3 | `ORIGINAL_REQUEST.md:17`, Survey 1/2 |
| F14 | Main Wiring, HUD, Physics Lab Drawer & Classic 2D Switcher | Wire all modules in `main.js`; camera toggle (`Broadcast 3/4` vs `2P Split-Screen`), format (`1v1`/`2v2`), AI style, mode selector, `⚙️ Physics Lab` live slider drawer (`localStorage`), `[Play Classic 2D]` switcher | M4 | `ORIGINAL_REQUEST.md:20`, Survey 2 |
| F15 | Screen Wake Lock & Portrait Auto-Pause Overlay | `navigator.wakeLock.request('screen')` (guarded `try/catch`, re-acquired on `visibilitychange`) + portrait auto-pause overlay (`innerHeight > innerWidth`) | M4 | `ORIGINAL_REQUEST.md:20`, Survey 2/3 |
| F16 | Muted-by-Default Procedural Web Audio Synth | `audioSynth.js` starts muted; ocean surf bed, wind modulation, Heat Spike bass boom, charge sweep, referee whistle, strike/wall/block SFX | M4 | `ORIGINAL_REQUEST.md:21`, Survey 1/2 |
| F17 | PWA Manifest & Stale-While-Revalidate SW (`summer-heat-3d-v2`) | Preserve v1 SVG icon (`fullscreen` + `landscape`); SWR under `summer-heat-3d-v2`, delete all older caches (`neon-volley-heavy-gale-v1`) on `activate`, pre-cache `./`, `./index.html`, `./manifest.json`, `./vendor/three.module.min.js`, all `./src/*.js`, `./classic-2d/*` | M4 | `ORIGINAL_REQUEST.md:22`, Survey 1/2/3 |
| F18 | Opaque-Box E2E Test Suite (Tiers 1–4) & `@verifier` Browser/Offline QA | Independent requirement-driven E2E suite (`TEST_INFRA.md`, `TEST_READY.md`) + `python3 -m http.server 8080` Playwright QA at `1280x720` & `844x390` playing full 3-touch `Bump -> Set -> Heat Spike` point in `Broadcast 3/4` & `2P Split-Screen`, clicking `[Play Classic 2D]`, confirming `summer-heat-3d-v2` Cache Storage & 0 console/WebGL errors, saving screenshots & `.webm` recordings + Tier 5 adversarial hardening | E2E Track & M5 | `ORIGINAL_REQUEST.md:24-26`, Survey 3 |

---

## Milestones

| # | Name | Scope (Exclusive Ownership) | Dependencies | Status | Sub-Orch Conv ID |
|---|------|-----------------------------|--------------|--------|------------------|
| M0 | Scaffolding & Contract Freeze | `feat/summer-heat-3d`, `AGENTS.md`, `./src/contracts.js`, `./vendor/three.module.min.js`, `./classic-2d/*` (remove root `./game.js`) | none | DONE | b41f703d4d9dd069fa2a6b98d3af9443 |
| M1 | Worker-Physics | `./src/physics3d.js` ONLY (+ unit tests in `./tests/unit/physics3d.test.mjs`) | M0 | DONE | 530422216ddba30ebca5b520e6dab29c |
| M2 | Worker-Visuals | `./src/courtScene.js`, `./src/playerRigs.js` ONLY (+ unit tests in `./tests/unit/visuals.test.mjs`) | M0 | DONE | d01462ed0c317a1152a4b602eb240cbf |
| M3 | Worker-Gameplay | `./src/rallyEngine.js`, `./src/inputManager.js` ONLY (+ unit tests in `./tests/unit/gameplay.test.mjs`) | M0 (integrates `./src/physics3d.js` contract) | DONE | 721f70488622f542288ace8df5234168 |
| M4 | Worker-AppShell | `./src/main.js`, `./src/audioSynth.js`, `./index.html`, `./sw.js`, `./manifest.json` ONLY (+ unit tests in `./tests/unit/appshell.test.mjs`) | M0 (wires M1–M3 contracts) | DONE | c2ddcedcf520ddd625530ae22d43eb16 |
| E2E | E2E Testing Track | `TEST_INFRA.md`, `./tests/e2e/*` (Tiers 1–4), `TEST_READY.md` | M0 | DONE | b43468cd071e9f8be999244faec042af |
| M5 | Final Milestone (`@verifier` + Tiers 1–4 + Tier 5) | Phase 1: 100% E2E Tiers 1–4 + `@verifier` Browser/Offline QA (`1280x720`, `844x390`, screenshots & `.webm` recordings in `./qa-artifacts/`); Phase 2: Tier 5 Adversarial Coverage Hardening + Whole-Project Forensic Audit | M1, M2, M3, M4, E2E | IN_PROGRESS (Phase 1 DONE; Phase 2 Tier 5) | 34555c1e50fb1ffddc30e41ecc93b3c7 |

---

## Interface Contracts

### Coordinate System & Spin Math (Right-Handed Three.js SI Meters)
- `+X`: Team 2 (right court), `-X`: Team 1 (left court), `+Y`: UP (sand at `Y = 0`), `+Z`: near sideline (toward Broadcast camera), `-Z`: far sideline (ocean/sunset horizon).
- Net plane at `X = 0`, `Z ∈ [-4.5, +4.5]`, `NET_HEIGHT = 2.38`, `NET_TAPE_RADIUS = 0.08`.
- Arena walls: `X = ±11.5`, `Z = ±6.5`, `CEILING_Y = 14.0`. Court lines: `X ∈ [-8, +8]`, `Z ∈ [-4, +4]`.
- **Magnus acceleration**: `a_magnus = kMagnus * (omegaVec3 × vRel)` where `vRel = v - windVec3`.
  - Topspin axis for horizontal flight direction `dirXZ = (dirX, 0, dirZ)`: `up × dirXZ = (dirZ, 0, -dirX)`.
  - `computeSpinOmega(dirX, dirZ, topspinRadS, sidespinRadS)` returns `{ x: dirZ * topspinRadS, y: sidespinRadS, z: -dirX * topspinRadS }` (with normalized horizontal `dirXZ`).
  - Topspin (`topspinRadS > 0`) dives downward (`-Y`); backspin (`topspinRadS < 0`) floats upward (`+Y`); sidespin (`sidespinRadS != 0`) hooks laterally along `Z`/`X`.
- **Spin-reactive outer stadium wall kick**: `v_kick = kWallSpin * (inwardNormal × omega)`. Topspin banks downward (`-Y`), backspin pops upward (`+Y`) symmetrically on left and right walls.

### `./src/contracts.js` Exact Exports (Frozen in M0)
- `FIXED_DT = 1 / 120`, `MAX_PREDICT_STEPS = 180`
- `COORDINATE_SYSTEM`, `COURT`, `BALL_SPEC`, `PHYSICS_DEFAULTS`, `PHYSICS_LIMITS`
- `STORAGE_KEYS = { PHYSICS: 'summer_heat_3d_physics_v2', BINDINGS: 'summer_heat_3d_bindings_v2', SETTINGS: 'summer_heat_3d_settings_v2' }`
- `INPUT_MODES = { ONE_PAD_SPLIT: '1PAD', TWO_PAD_KEYBOARD: '2PAD', TOUCH_AUTO: 'TOUCH' }`
- `CAMERA_MODES = { BROADCAST: 'BROADCAST', SPLIT_SCREEN: 'SPLIT' }`
- `AI_STYLES = { WIND_LOBBER: 'WIND_LOBBER', NET_BLOCKER: 'NET_BLOCKER', SPIN_SLICER: 'SPIN_SLICER' }`
- `MATCH_FORMATS = { ONE_V_ONE: '1v1', TWO_V_TWO: '2v2' }`
- `ANIM_STATES = { IDLE: 'Idle', SPRINT: 'Sprint', UNDERHAND_BUMP: 'UnderhandBump', OVERHEAD_SET: 'OverheadSet', JUMP_HEAT_SPIKE: 'JumpHeatSpike', NET_BLOCK: 'NetBlock', SAND_DIVE: 'SandDive' }`
- `WIND_PHASES = { BREEZE: 'BREEZE', WARNING: 'WARNING', GUST: 'GUST' }`
- `TRAIL_MODES = { NEUTRAL: 'NEUTRAL', FLAME: 'FLAME', CYAN: 'CYAN', LOB: 'LOB' }`
- `SHOT_TYPES = { SERVE: 'SERVE', BUMP: 'BUMP', DIVE_SAVE: 'DIVE_SAVE', SET: 'SET', SPIKE: 'SPIKE', HEAT_SPIKE: 'HEAT_SPIKE', POKEY_CUT: 'POKEY_CUT', BLOCK_STUFF: 'BLOCK_STUFF', LOB: 'LOB' }`
- `EVENTS = { SERVE, BUMP, DIVE, SET, SPIKE, HEAT_SPIKE, POKEY_CUT, NET_BLOCK, STUFF_BLOCK, WALL_BOUNCE, NET_TAPE_HIT, NET_MESH_HIT, SAND_IMPACT, POINT_SCORED, GUST_WARNING, GUST_START, CHARGE_TICK }`
- Helpers: `clamp(val, min, max, fallback)`, `createVec3(x, y, z)`, `computeSpinOmega(dirX, dirZ, topspinRadS, sidespinRadS)`, `createBallState(overrides)`, `createWindState(overrides)`, `createPlayerState(overrides)`, `createDefaultBindings()`, `sanitizePhysicsConfig(raw)`

### `physics3d.js` ↔ `rallyEngine.js` & `main.js`
- `export { FIXED_DT } from './contracts.js'`
- `export function updateWind3D(windState, dt, physicsConfig = PHYSICS_DEFAULTS)` -> `{ phaseChanged, phase, windVec3 }`
- `export function triggerGaleSurge(windState, dirSignX = null)` -> sets `WARNING` (1.0s) -> `GUST` (4.0s) with elevated 3D `gustTargetVec3`
- `export function stepBall3D(ballState, windState, physicsConfig = PHYSICS_DEFAULTS, dt = FIXED_DT, isSimulation = false)` -> `{ landed, wallHit, netHit, crossedNet, speed }`
- `export function predictLandingPoint3D(ballState, windState, physicsConfig = PHYSICS_DEFAULTS, maxSteps = MAX_PREDICT_STEPS)` -> `{ x, z, hangTime, landedWithinSteps, steps, trajectory }` (pure, non-mutating; runs up to 180 `FIXED_DT` steps + analytic quadratic tail if still airborne)

### `playerRigs.js` ↔ `courtScene.js`
- `export function createPlayerRig({ id, team, role })` -> `{ root: THREE.Group, id, team, role, joints, spring, materials }`
- `export function updatePlayerRig(rig, playerState, ballState, dt)` -> updates position, yaw, 2-bone IK, spring squash-and-stretch, and all 7 `ANIM_STATES`
- `export function disposePlayerRig(rig)`

### `courtScene.js` ↔ `main.js`
- `export function createCourtScene(canvas, options = {})` -> `{ syncState(snapshot, dt), render(cameraMode), resize(width, height), triggerCameraPunch(intensity), dispose() }`

### `inputManager.js` ↔ `main.js`
- `export function createInputManager(canvas, options = {})` -> `{ setMode(mode), getMode(), pollInputs(dt), getBindings(), setBindings(b), resetBindings(), startQuickBind(onUpdate, onDone), cancelQuickBind(), destroy() }`
- `pollInputs(dt)` returns `{ mode, padsConnected, p1: PlayerInputCmd, p2: PlayerInputCmd }` where `PlayerInputCmd = { moveX, moveZ, aimX, aimZ, primaryHeld, primaryJustPressed, primaryJustReleased, secondaryHeld, secondaryJustPressed, secondaryJustReleased, isHuman, autoFootwork }`.

### `rallyEngine.js` ↔ `main.js`
- `export function createRallyEngine(options = {})` -> `{ update(rawDt, inputs, physicsConfig), stepFixed(dt, inputs, physicsConfig), getSnapshot(), setFormat(format), setAiStyle(style), triggerGust(), resetMatch(), setPaused(bool) }`
- `options.physics` optional DI override (defaults to imported `./physics3d.js`) so unit tests can run deterministically even in isolation.
- `getSnapshot()` returns `{ ball, wind, prediction, players, timingRing, scoreboard, cameraPunch, hitStopFrames, events }`.

### `audioSynth.js` ↔ `main.js`
- `export function createAudioSynth()` -> `{ isEnabled(), toggle(), setEnabled(bool), updateAmbience(windState), handleEvents(events), playChargeSweep(ratio), playRefereeWhistle(kind), dispose() }`. Muted by default.

### Testability Hook (Opaque-Box & Browser QA)
- `main.js` exposes a read-only telemetry accessor `window.__SUMMER_HEAT_DEBUG__` (returning live `getSnapshot()`, `getCameraMode()`, `getInputMode()`, `isPaused()`, `getPhysicsConfig()`, `getAudioEnabled()`, plus safe read-only state — NEVER cheating/mutating game rules!) AND ensures all HUD controls have stable `id` / `data-testid` attributes so Playwright E2E and `@verifier` can interact purely via genuine DOM clicks, keyboard events, and canvas/HUD inspection.

---

## Verified Build, Syntax, Unit & Browser QA Commands

1. **ESM Syntax Check (CRITICAL — never use bare `node --check` on ESM `.js`)**:
   ```bash
   for f in src/*.js; do node --input-type=module --check < "$f" || exit 1; done
   ```
2. **Classic Script & JSON Check**:
   ```bash
   node --check sw.js && node --check classic-2d/game.js
   python3 -m json.tool manifest.json > /dev/null && python3 -m json.tool classic-2d/manifest.json > /dev/null
   ```
3. **Node 22 Unit Tests (zero `package.json` needed)**:
   ```bash
   node --test tests/unit/*.test.mjs
   ```
4. **Browser QA / `@verifier` (Python Playwright 1.65.2 + SwiftShader WebGL2 + `.webm` recording)**:
   - Server: `python3 -m http.server 8080 --bind 127.0.0.1`
   - Chromium args: `["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]`
   - Viewports: `1280x720` and `844x390` (plus `390x844` for portrait auto-pause check)
   - Must call `ctx.close()` to flush `.webm` recordings; avoid `gl.readPixels()` to prevent SwiftShader perf warnings.
   - Standalone FFmpeg if needed: `/opt/ms-playwright/ffmpeg-1013/ffmpeg-linux`
