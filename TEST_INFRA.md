# TEST_INFRA.md — SUMMER HEAT 3D Opaque-Box E2E Test Infrastructure

**Target Branch**: `feat/summer-heat-3d`  
**Specification Sources**: `.agents/teamwork/ORIGINAL_REQUEST.md`, `PROJECT.md`, `AGENTS.md`, `src/contracts.js`  
**Runtime Tooling**: Node.js `v22.23.5` (`node --test`, zero npm dependencies), Python `3.12.16`, Python Playwright `1.65.2` (bundled Chromium + FFmpeg, SwiftShader WebGL2), Pillow (`PIL.Image`), `python3 -m http.server`

---

## 1. Opaque-Box Testing Methodology

The E2E suite is engineered **independently of M1–M4 implementation internals** strictly from the user requirements (`ORIGINAL_REQUEST.md`), architectural invariants (`AGENTS.md`), and frozen interface contracts (`src/contracts.js`). Every test interacts only through documented public module exports, browser DOM controls, real keyboard/pointer events, `localStorage`, Cache Storage, and the read-only telemetry accessor `window.__SUMMER_HEAT_DEBUG__`.

Four complementary test-design disciplines structure the suite:

1. **Tier 1 — Category-Partition Feature Coverage (`tests/e2e/tier1_features.test.mjs`)**
   - Partitions every major feature domain into valid equivalence classes and verifies `>= 5` isolated happy-path scenarios per feature area (33+ tests across 6 domains: M0/Static DAG/PWA/Classic 2D, 3D Aerodynamics & Wind, Articulated Athlete Rigs, 3-Touch Rally Loop & AI FSM, Stadia/Keyboard/Touch Input & Quick-Bind, and Muted-by-Default Procedural Web Audio).
   - Pure modules (`contracts.js`, `physics3d.js`, `rallyEngine.js`) and Three.js r170 rig geometry (`playerRigs.js` + `vendor/three.module.min.js`) run directly in Node 22 with **zero mocks**.
   - Only thin browser-API boundary shims (`tests/e2e/_helpers/browserShims.mjs`) are used for `inputManager.js` (DOM `EventTarget`, `localStorage`, `navigator.getGamepads`) and `audioSynth.js` (`AudioContext` spy to verify strict lazy instantiation after explicit user gesture).

2. **Tier 2 — Boundary Value Analysis & Corner Cases (`tests/e2e/tier2_boundaries.test.mjs`)**
   - Targets numeric limits, domain transitions, error resilience, and invariant preservation (`>= 5` boundary tests per feature area, 28+ tests across 5 domains):
     - Sky lob `> 1.50 s` exceeding `MAX_PREDICT_STEPS = 180` (analytic quadratic tail + arena clamp + non-mutation).
     - `gustScale = 0` vs `gustScale = 2.0`, `vRel = 0` (zero drag & zero Magnus), high-speed corner triple-impact & `MAX_OMEGA = 24.0` clamping, net-tape grazing & net-post edge, exact sand impact `y <= 0.22`, zero-length vectors & `NaN`/`Infinity` finite guards.
     - 4th-touch fault enforcement, `rawDt = 10 s` background-tab clamp (`<= 0.05 s`), Timing Ring early/sweet-spot/late edges, court/net-line player clamping, pause freeze invariant, mid-rally format switch & reset during active hit-stop/gust.
     - Unknown/null `animState`, degenerate `dt`, extreme/zero-length IK targets, rapid state thrashing, idempotent `disposePlayerRig`.
     - `3 s` Quick-Bind timeout without input, corrupt/throwing `localStorage`, extreme Physics Lab config clamping, `0.159` vs `0.161` Stadia deadzone boundary, opposing simultaneous keys, `cancelQuickBind()`, muted no-ops, unavailable Web Audio API, and rejected `AudioContext.resume()`.

3. **Tier 3 — Cross-Feature Pairwise Combinatorial Testing (`tests/e2e/tier3_pairwise.test.mjs`)**
   - Exercises multi-module interactions and covering arrays across feature boundaries (9 pairwise suites):
     - `T3-P1`: Heavy Gale (`GUST`, `gustScale = 2.0`) × Heat Spike (`FLAME` topspin) × `predictLandingPoint3D`.
     - `T3-P2`: `2v2` AI partner × 3-touch loop × `NET_BLOCKER` opponent (`Stuff-Block` vs `Pokey`).
     - `T3-P3`: `sanitizePhysicsConfig` × `physics3d` & `rallyEngine` (custom `gravity` trajectory/hang-time & `gameSpeed` simulation pacing; live browser `STORAGE_KEYS.PHYSICS` reload persistence & Classic 2D `neon_volley_heavy_gale_physics_v1` isolation verified in Tier 4 `T4-S5`).
     - `T3-P4`: Full 9-row pairwise covering array of Input Mode (`1PAD`/`2PAD`/`TOUCH`) × Format (`1v1`/`2v2`) × AI Style (`WIND_LOBBER`/`NET_BLOCKER`/`SPIN_SLICER`) × `playerRigs` IK update pipeline (covering 100% of all 9 `(mode, aiStyle)` pairs plus all `(mode, format)` and `(format, aiStyle)` pairs).
     - `T3-P5`: Quick-Bind calibration × `STORAGE_KEYS.BINDINGS` persistence across re-instantiation × `rallyEngine` strike execution.
     - `T3-P6`: `TOUCH` Auto-Footwork × 3-touch loop × `predictLandingPoint3D` guidance.
     - `T3-P7`: `SPIN_SLICER` AI × Backspin `POKEY_CUT` × spin-reactive outer arcade wall vertical kick (`±X`).
     - `T3-P8`: `WIND_LOBBER` AI × Sky Lob (`> 1.5 s`) × analytic landing tail × `audioSynth` ambience & event dispatch.
     - `T3-P9`: `rallyEngine.setPaused()` × `inputManager` `STORAGE_KEYS.BINDINGS` destroy/re-instantiation persistence × `playerRigs` pause-freeze invariance & resume recovery (live WebGL Broadcast ↔ Split camera toggle, `STORAGE_KEYS.SETTINGS` reload persistence, and `390x844` Portrait Auto-Pause overlay verified in Tier 4 `T4-S3` / `T4-S8`).

4. **Tier 4 — Real-World Application & `@verifier` Browser/Offline QA (`tests/e2e/tier4_browser_e2e.py`)**
   - Serves the repository over HTTP via `python3 -m http.server <port> --bind 127.0.0.1` (default port `8080`, configurable via `--port`, guaranteed teardown in `finally:`).
   - Launches Chromium via Python Playwright `1.65.2` with SwiftShader Vulkan ANGLE WebGL2 flags:
     `["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]`.
   - Enforces **strictly zero** `console.error`, zero WebGL warnings/errors, zero `pageerror` exceptions, zero `requestfailed` events, and zero external/CDN network requests (every HTTP(S) request must target `127.0.0.1:<port>`).
   - **Never calls `gl.readPixels()`** (which emits a SwiftShader performance warning); verifies visual rendering and live motion using `page.screenshot()` + Pillow (`PIL.Image`) pixel variance and frame-delta statistics, plus non-invasive read-only `window.__SUMMER_HEAT_DEBUG__` polling + `requestAnimationFrame` event collection.
   - Always closes browser contexts (`ctx.close()`) before inspecting `.webm` video artifacts so Playwright flushes video buffers cleanly.

---

## 2. Feature Inventory Coverage Matrix (F01–F18)

Every feature in `PROJECT.md § Feature Inventory` is mapped across Tiers 1–4 with zero gaps:

| ID | Feature Summary | Tier 1 (Features) | Tier 2 (Boundaries) | Tier 3 (Pairwise) | Tier 4 (Browser / `@verifier`) |
|----|-----------------|-------------------|---------------------|-------------------|--------------------------------|
| **F01** | Branch, Classic 2D archive, Three.js r170, `AGENTS.md`, `contracts.js` | `T1-A1`..`T1-A5` | `T2-A6`, `T2-D2`, `T2-D3` | `T3-P3` | `T4-S7`, `T4-S9` |
| **F02** | 120Hz Fixed-Timestep Integrator (`FIXED_DT = 1/120`) | `T1-B1` | `T2-A6`, `T2-B2` | `T3-P1`, `T3-P4` | `T4-S2` |
| **F03** | Heavy Gale 3D Crosswinds & 4s Surges | `T1-B2` | `T2-A2`, `T2-A3` | `T3-P1`, `T3-P8` | `T4-S2`, `T4-S5` |
| **F04** | Quadratic Air Drag & 3D Magnus Curve (`omega × vRel`) | `T1-B3`, `T1-B4` | `T2-A3`, `T2-A6` | `T3-P1`, `T3-P7` | `T4-S2` |
| **F05** | Spin-Reactive Outer Arcade Walls & Rounded Net Tape | `T1-B5`, `T1-B6` | `T2-A4`, `T2-A5`, `T2-A7` | `T3-P7` | `T4-S2` |
| **F06** | `predictLandingPoint3D` (180-Step Lookahead + Analytic Tail) | `T1-B7` | `T2-A1`, `T2-A6` | `T3-P1`, `T3-P6`, `T3-P8` | `T4-S2`, `T4-S3` |
| **F07** | Coastal Sunset Three.js Stadium | `T1-A2`, `T1-A3` | — | — | `T4-S1`, `T4-S2`, `T4-S4` |
| **F08** | Wind Streamer, Drop-Shadow, Reticle, Timing Ring & Spin Ribbon | `T1-D2` | `T2-B3` | `T3-P1` | `T4-S1`, `T4-S2`, `T4-S3` |
| **F09** | Diegetic LED Scoreboard & Camera Modes (`BROADCAST` / `SPLIT`) | `T1-A1` | — | — | `T4-S2`, `T4-S3`, `T4-S4` |
| **F10** | Articulated 3D Athlete Rigs with IK & Squash-Stretch (7 States) | `T1-C1`..`T1-C5` | `T2-C1`..`T2-C5` | `T3-P4`, `T3-P9` | `T4-S1`, `T4-S2` |
| **F11** | True Summer Heat 3-Touch Loop (`Bump -> Set -> Heat Spike/Pokey/Block`) | `T1-D1`..`T1-D6` | `T2-B1`..`T2-B6` | `T3-P1`, `T3-P2`, `T3-P6`, `T3-P9` | `T4-S2`, `T4-S3` |
| **F12** | 3-Style Solo AI Opponent FSM & 2v2 AI Partner | `T1-D4`, `T1-D5` | `T2-B6` | `T3-P2`, `T3-P4`, `T3-P7`, `T3-P8` | `T4-S5` |
| **F13** | Harvested Stadia Input Modes (`1PAD`/`2PAD`/`TOUCH`) & 3s Quick-Bind | `T1-E1`..`T1-E6` | `T2-D1`..`T2-D5` | `T3-P4`, `T3-P5`, `T3-P6`, `T3-P9` | `T4-S5`, `T4-S6` |
| **F14** | Main Wiring, HUD, Physics Lab Drawer (`localStorage`) & Classic 2D Switcher | `T1-A1`, `T1-A5` | `T2-D2`, `T2-D3` | `T3-P3` | `T4-S4`, `T4-S5`, `T4-S7` |
| **F15** | Screen Wake Lock & Portrait Auto-Pause Overlay (`390x844`) | — | — | `T3-P9` | `T4-S8` (+ Wake Lock zero-error check across all scenarios) |
| **F16** | Muted-by-Default Procedural Web Audio Synth | `T1-F1`..`T1-F5` | `T2-E1`..`T2-E5` | `T3-P8` | `T4-S5` |
| **F17** | PWA `manifest.json` (v1 SVG icon) & SWR `sw.js` (`summer-heat-3d-v2`) | `T1-A4`, `T1-A5` | — | — | `T4-S7`, `T4-S9` |
| **F18** | Opaque-Box E2E Suite (Tiers 1–4) & `@verifier` Browser/Offline QA | All Tier 1 | All Tier 2 | All Tier 3 | `T4-S1`..`T4-S9` + PNG/`.webm` artifacts |

---

## 3. Directory Layout & Unified Runner Architecture

```text
tests/e2e/
├── run_all.sh                   # Unified CLI runner (--tier 1|2|3|4|all, --port, --artifacts-dir)
├── _helpers/
│   └── browserShims.mjs         # Minimal EventTarget/localStorage/Gamepad/AudioContext shims & snapshot normalizers
├── tier1_features.test.mjs      # Tier 1: Category-partition feature tests (Node 22 node:test)
├── tier2_boundaries.test.mjs    # Tier 2: Boundary value & corner-case tests (Node 22 node:test)
├── tier3_pairwise.test.mjs      # Tier 3: Cross-feature pairwise combinatorial tests (Node 22 node:test)
└── tier4_browser_e2e.py         # Tier 4: Playwright SwiftShader WebGL2, 3-touch gameplay, Classic 2D & Offline QA
```

### Invocation Commands

- **Run full 4-tier E2E suite sequentially (M5 canonical command)**:
  ```bash
  ./tests/e2e/run_all.sh --tier all --port 8080 --artifacts-dir ./qa-artifacts
  ```
- **Run individual tiers**:
  ```bash
  ./tests/e2e/run_all.sh --tier 1
  ./tests/e2e/run_all.sh --tier 2
  ./tests/e2e/run_all.sh --tier 3
  ./tests/e2e/run_all.sh --tier 4 --port 8080 --artifacts-dir ./qa-artifacts
  ```
- **Direct syntax validation (parallel-safe before M1–M4 finish)**:
  ```bash
  for f in tests/e2e/_helpers/*.mjs tests/e2e/*.mjs; do
    node --input-type=module --check < "$f" || exit 1
  done
  PYTHONPYCACHEPREFIX=/tmp/e2e_pycache python3 -m py_compile tests/e2e/tier4_browser_e2e.py
  bash -n tests/e2e/run_all.sh
  ```

---

## 4. Opaque-Box Resilience & Anti-Cheating Guarantees

1. **Zero State-Mutating Cheats**: Tier 4 gameplay (`T4-S2` Broadcast and `T4-S3` Split-Screen) drives a genuine closed-loop keyboard controller (`KeyA`/`KeyD`/`KeyW`/`KeyS` + `Space`) guided solely by read-only `window.__SUMMER_HEAT_DEBUG__.getSnapshot()`, blurring HUD focus onto `<canvas>` before keyboard input and releasing all held keys in `finally:`.
2. **Resilient Semantic Locators**: Because M4 HUD markup is authored in parallel against frozen contracts, Tier 4 locates controls by semantic accessible text/role with `data-testid`/`id`/`aria-label` fallbacks and Physics Lab sliders by their unique `PHYSICS_LIMITS` `(min, max)` attribute pairs, asserting every resulting behavioral transition via `window.__SUMMER_HEAT_DEBUG__` and `localStorage` rather than brittle CSS classes.
3. **Strict Frozen Schema Validation + Safe Sub-Field Normalization**: Frozen structures (`ball`, `wind`, `players[]`, `prediction`, `EVENTS`, `ANIM_STATES`, `TRAIL_MODES`, `SHOT_TYPES`, `STORAGE_KEYS`) are asserted strictly; partially open sub-objects (`scoreboard`, `timingRing`) use a small read-only normalizer in `_helpers/browserShims.mjs` and `tier4_browser_e2e.py` so valid key naming (`team1`/`p1`/`left` or `active`/`visible`) never causes false failures while still enforcing numeric finiteness, monotonic ring shrink, and score increments.
4. **No Silent Skips**: Tiers 1–3 never swallow missing-module errors or pass vacuously; running Tiers 1–3 before M1–M4 are implemented will fail loudly on missing modules, and running them in M5 exercises the complete integrated codebase end-to-end.
5. **Pre-Cached 16-Asset Service Worker Audit**: `T4-S9` seeds a dummy `'neon-volley-heavy-gale-v1'` cache before load, confirms activation purges it leaving exclusively `'summer-heat-3d-v2'`, verifies all 16 pre-cached URLs (`./`, `./index.html`, `./manifest.json`, `./vendor/three.module.min.js`, all 8 `./src/*.js`, and `./classic-2d/{,index.html,game.js,manifest.json}`), waits for `navigator.serviceWorker.controller`, and tests offline reload of both the 3D app and `./classic-2d/` with zero errors.
