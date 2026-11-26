# 🏐 SUMMER HEAT 3D (Neon Volley: Heavy Gale)

**A Zero-Build, Zero-CDN, Offline-First 3D Arcade Beach Volleyball PWA**

Built with pure browser-native ES2022+ modules, a vendored single-file Three.js (`r170`), procedural Web Audio synthesis, and deterministic 120Hz 3D aerodynamics—designed to play smoothly in **100% offline Airplane Mode** on desktop, mobile, or a shared single-controller tray-table setup. Includes the original 2D game archived under `./classic-2d/` via the in-app **`[Play Classic 2D]`** switcher.

---

## ✨ Key Features

### 1. 120Hz 3D "Heavy Gale" Aerodynamics & Magnus Curve (`src/physics3d.js`)
Runs on a fixed `FIXED_DT = 1/120` s simulation step in right-handed SI meters (`16 m × 8 m` sand court inside `23 m × 13 m × 14 m` spin-reactive arcade walls):
- **Oscillating 3D Crosswinds & 4-Second Gale Surges (`windVec3`)**: Dynamic breeze with visual warning phase before 4-second Heavy Gale surges.
- **Quadratic Air Drag & 3D Magnus Force**:
  - Relative air velocity: $\vec{v}_{\text{rel}} = \vec{v} - \vec{w}$
  - Drag: $\vec{a}_{\text{drag}} = -k_{\text{drag}} |\vec{v}_{\text{rel}}| \vec{v}_{\text{rel}}$ (`kDrag = 0.032`)
  - 3D Magnus curve: $\vec{a}_{\text{magnus}} = k_{\text{magnus}} (\vec{\omega} \times \vec{v}_{\text{rel}})$ (`kMagnus = 0.028`, $|\vec{\omega}| \le 24\text{ rad/s}$) for diving topspin spikes, floating backspin pokeys/cuts, and lateral sidespin hooks.
- **Spin-Reactive Outer Stadium Arcade Walls & Rounded Net Tape**: Balls remain live off the outer walls and ceiling until sand impact (`y <= 0.22 m`), applying a spin-reactive vertical kick (`kWallSpin * (inwardNormal × omega)`), with anti-tunneling cylindrical net-tape and post deflection (`NET_HEIGHT = 2.38 m`).
- **180-Step Lookahead Landing Predictor**: Pure non-mutating `predictLandingPoint3D(ballState, windState, physicsConfig)` simulates up to 180 fixed steps (`1.50 s`, plus an analytic ballistic tail for high sky lobs) to drive the pulsing 3D sand landing reticle, AI footwork, and `TOUCH AUTO-FOOTWORK`.

### 2. True Summer Heat 3-Touch Arcade Loop (`src/rallyEngine.js`)
Play **1v1** or **2v2** (with an AI partner) against a 3-style Solo AI FSM (**`Wind Lobber`**, **`Net Blocker`**, **`Spin Slicer`**):
- **Touch 1 — Bump / Dig & Sand Dive**: Pops the ball toward the setter zone and charges the team **`heatMeter`** (`0–100%`).
- **Touch 2 — Overhead Set**: Lofts the ball near the net and spawns a **shrinking 3D Timing Ring** at the apex.
- **Touch 3 — Heat Spike / Pokey-Cut vs. Stuff-Block**:
  - Hitting the sweet spot with a charged meter unleashes a **Heat Spike** (2-frame hit-stop, camera punch, fiery flame spin ribbon, sharp topspin dive).
  - Read a jumping **Stuff-Blocker** and angle a floating **Backspin Pokey / Cut** (cyan ribbon) over the block.

### 3. Coastal Sunset 3D Stadium & Articulated IK Athletes (`src/courtScene.js`, `src/playerRigs.js`)
- Procedural Three.js `r170` coastal sunset stadium with `1024×1024` `PCFSoftShadowMap`, animated ocean waves, swaying palm trees, `windVec3`-driven net-post wind streamers, diegetic stadium LED scoreboard, ball drop-shadow, pulsing 3D landing reticle, shrinking 3D Timing Ring, and fiery/cyan 3D spin ribbons.
- Toggle live between **`Broadcast 3/4`** and **`2P Split-Screen`** cameras.
- Hierarchical capsule/sphere 3D athlete rigs with procedural Inverse Kinematics and spring squash-and-stretch across all 7 states: `Idle`, `Sprint`, `UnderhandBump`, `OverheadSet`, `JumpHeatSpike`, `NetBlock`, and `SandDive`.

---

## 🎮 Controls & Quick-Bind Calibration (`src/inputManager.js`)

Switch modes live from the HUD:
1. **`1-PAD SPLIT` (Stadia Single-Controller Mode)**:
   - **Team 1 (Left Court)**: Left Stick (`axes[0]`/`axes[1]`) or D-Pad moves; `L1`/`L2` (`buttons[4]`/`[6]`) strikes/charges.
   - **Team 2 (Right Court)**: Right Stick (`axes[2]`/`axes[3]`) moves; `R1`/`R2`/`A` (`buttons[5]`/`[7]`/`[0]`) strikes/charges.
2. **`2-PAD / KEYBOARD`**:
   - **Team 1**: `Gamepad[0]` or `WASD` + `Space` (Strike/Jump) + `Shift` (Dive/Block)
   - **Team 2**: `Gamepad[1]` or `Arrow Keys` + `Enter` (Strike/Jump) + `/` (Dive/Block)
3. **`TOUCH AUTO-FOOTWORK`**:
   - Automatic footwork toward the predicted sand landing point; touch-hold, drag to shape spin, and release on your court half to strike.
4. **3-Second Quick-Bind Modal**: Re-map controller/keyboard bindings in seconds, persisted to isolated v2 `localStorage` (`summer_heat_3d_bindings_v2`).

---

## ⚙️ App Shell, Audio, Physics Lab & Classic 2D (`src/main.js`, `src/audioSynth.js`)
- **Muted-by-Default Procedural Web Audio**: Ocean surf ambience, Heat Spike bass boom, charge pitch sweeps, and referee whistle (`AudioContext` initializes lazily only after an explicit gesture).
- **`⚙️ Physics Lab` Drawer**: Live sliders for `Gravity`, `Air Drag`, `Magnus Spin`, `Gust Scale`, and `Game Speed`, plus `Trigger Gust` and `Reset Defaults`, saved to `summer_heat_3d_physics_v2`.
- **PWA Polish**: Screen Wake Lock (with `visibilitychange` re-acquisition), Portrait Auto-Pause overlay, **`[Play Classic 2D]`** switcher to `./classic-2d/`, and Stale-While-Revalidate Service Worker (`summer-heat-3d-v2`) that pre-caches all 16 app + Classic 2D assets and cleans up legacy v1 caches on activation.

---

## 🚀 Running Locally

```bash
# Serve from the repo root (zero build step required)
python3 -m http.server 8080
```

Open `http://localhost:8080` in any modern browser. Once loaded, `sw.js` caches the full 3D app and `./classic-2d/` under `summer-heat-3d-v2` for offline play.

---

## 🧪 Running Verification & Tests

```bash
# 1. ESM syntax checks (Node 22+)
for f in src/*.js; do node --input-type=module --check < "$f" || exit 1; done
node --check sw.js && node --check classic-2d/game.js

# 2. Unit tests (94 tests)
node --test tests/unit/*.test.mjs

# 3. Full 5-tier E2E & Playwright/SwiftShader Browser/Offline QA suite (107 tests)
bash tests/e2e/run_all.sh
```

---

## 📁 Repository Structure

```text
neon-volley-heavy-gale/
├── index.html                  # Fullscreen 3D viewport, responsive HUD, Physics Lab & Quick-Bind modal
├── manifest.json               # Fullscreen landscape PWA manifest (preserved v1 inline SVG icon)
├── sw.js                       # Stale-While-Revalidate Service Worker (summer-heat-3d-v2)
├── vendor/
│   └── three.module.min.js     # Vendored offline Three.js r170 single-file ESM bundle
├── src/
│   ├── contracts.js            # Deep-frozen shared constants, state factories & sanitizers
│   ├── physics3d.js            # 120Hz 3D Heavy Gale, Magnus, walls, net & 180-step predictor
│   ├── playerRigs.js           # Articulated 3D IK athlete rigs (7 animation states)
│   ├── courtScene.js           # Sunset stadium, waves, palms, reticle, spin ribbon & dual cameras
│   ├── rallyEngine.js          # 3-touch loop (1v1/2v2), Heat Spike, Timing Ring & 3-style AI FSM
│   ├── inputManager.js         # 1-PAD SPLIT Stadia, 2-PAD/Keyboard, Touch Auto-Footwork & Quick-Bind
│   ├── audioSynth.js           # Muted-by-default procedural Web Audio synthesizer
│   └── main.js                 # App shell wiring, HUD, Physics Lab, Wake Lock & Portrait Auto-Pause
├── classic-2d/                 # Archived v1 2D Neon Volley (accessible via [Play Classic 2D])
├── tests/
│   ├── unit/                   # Node 22 unit test suites (contracts, physics, visuals, gameplay, appshell)
│   └── e2e/                    # Tiers 1–5 E2E & Playwright WebGL2/SW offline QA suite
└── AGENTS.md                   # Engineering invariants & module dependency rules
```
