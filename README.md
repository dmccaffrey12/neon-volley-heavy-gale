# 🏐 NEON VOLLEY: HEAVY GALE

**A Zero-Dependency, Offline-First 2-Player Synthwave Beach Ball PWA**

Designed for two players sharing an airplane tray table in 100% offline **Airplane Mode**. Built with vanilla HTML5 `<canvas>`, CSS3, Web Audio API, and modern ES6+ JavaScript—with zero external libraries, fonts, images, or build steps.

---

## ✨ Key Features

### 1. "Heavy Gale" Aerodynamics & 2D Magnus Physics
Uses Semi-Implicit Euler integration ($\Delta t \le 0.033\text{s}$) with configurable constants initialized to the **Heavy Gale** preset:
- **Gravity**: $g = 340\text{ px/s}^2$
- **Quadratic Air Drag**: $k_{\text{drag}} = 0.0036$
- **2D Magnus Spin Coefficient**: $k_{\text{magnus}} = 0.0060$
- **Neon Wall & Rounded Net Restitution**: $e_{\text{wall}} = 0.78$, $e_{\text{net}} = 0.72$
- **Dynamic Wind & Gust Waves**:
  - Gentle baseline breeze ($\pm 30\text{ px/s}$) interrupted every $8\text{–}12\text{s}$ by a 4-second **Heavy Gale Gust** ($w_x = \pm 85\text{ to }100\text{ px/s}$), preceded by a 1-second visual wind-streak warning.
- **Per-Frame Drag + Magnus Lift/Dive**:
  - Relative air velocity: $\vec{v}_{\text{rel}} = (v_x - w_x,\; v_y)$, speed $v_{\text{rel}} = \operatorname{hypot}(v_{\text{rel},x},\; v_{\text{rel},y})$
  - Angular velocity $\omega \in [-1.5, 1.5]$ ($\omega \gets 0.994\omega$ per frame):
    $$a_x = -k_{\text{drag}} \cdot v_{\text{rel}} \cdot v_{\text{rel},x} - k_{\text{magnus}} \cdot (\omega \cdot 120) \cdot v_{\text{rel},y}$$
    $$a_y = g - k_{\text{drag}} \cdot v_{\text{rel}} \cdot v_{\text{rel},y} + k_{\text{magnus}} \cdot (\omega \cdot 120) \cdot v_{\text{rel},x}$$
  - **Topspin** pulls the ball sharply downward ($+y$) into a dive; **Backspin** generates upward aerodynamic lift ($-y$) so the ball floats and hangs.

### 2. Glowing Arcade Wall Rebounds (Zero Out-of-Bounds)
- Left, right, and top screen boundaries act as active neon rebound walls—the ball stays live until it touches the sand floor (`groundY`).
- **Spin-Wall Kick**: Rebounding off the left or right vertical wall reflects $v_x \gets -v_x \cdot e_{\text{wall}}$ and applies a vertical spin kick:
  $$v_y \gets v_y + (\text{wallSign} \cdot \omega \cdot 140)$$
  Topspin drives bank sharply downward toward the sand, while backspin cuts pop high upward for defensive saves.
- **Rounded Net Capsule**: Center net collisions resolve against a rounded top tape so balls clipping the tape deflect or roll over naturally.

### 3. 90–120 Step Forward-Simulation Landing Predictor
- Every frame, the engine clones the active ball state `{ x, y, vx, vy, omega }` and runs a fast-forward simulation loop ($dt = 0.016\text{s}$) through the exact drag, wind, Magnus, net, and spin-wall rebound equations until `simBall.y >= groundY`.
- Renders a subtle trajectory lookahead arc and a pulsing neon target reticle on the sand at `predictedLandingX`, and drives `TOUCH AUTO-RUN` / AI footwork.

### 4. "Strafe, Charge, & Shape" Strike System + Headwind Guardrail
- **Magnetized Strike Strafe**: While holding charge, players continue strafing at $65\%$ speed and subtly magnetize toward the ball inside an $85\text{px}$ strike halo.
- **Charge Ring & Sweet Spot**: Holding strike fills a circular neon ring ($0.0 \to 1.0$ over $0.40\text{s}$). Releasing inside the **Sweet Spot** ($0.70\text{–}0.95$) triggers a 2-frame hit-stop pause, an expanding neon shockwave ring, and $+25\%$ velocity/spin.
- **Smart Headwind & Distance Guardrail**:
  $$v_{\text{launch}} = v_{\text{base}} + 0.35 \cdot |x_{\text{player}} - x_{\text{net}}| + 0.85 \cdot \max(0, \text{headwindAgainstShot})$$
- **Directional Spin Shaping (at release)**:
  | Input Tilt | Shot Type | Launch Angle | Spin ($\omega$) | Neon Ribbon Color |
  | :--- | :--- | :---: | :---: | :--- |
  | **Forward Tilt** | **Topspin Drive** | $28^\circ$ | High Forward Topspin | Orange (`#ff5500`) |
  | **Back / Down Tilt** | **Backspin Cut** | $44^\circ$ | High Reverse Backspin | Cyan (`#00f3ff`) |
  | **Upward / Neutral** | **Sky Lob** | $66^\circ$ | Light Backspin | Magenta (`#ff00aa`) |

---

## 🎮 Multi-Modal Controls (Live HUD Selector)

Switch on the fly using the top HUD pill:
1. **`1-PAD SPLIT` (Stadia Single-Controller Mode)**:
   - **Player 1 (Left Court)**: Left Stick X (`axes[0]`) or D-Pad Left/Right (`buttons[14]`/`[15]`) moves. Hold `L1` (`buttons[4]`) or `L2` (`buttons[6]`) to Charge; Left Stick direction at release shapes the shot.
   - **Player 2 (Right Court)**: Right Stick X (`axes[2]`) moves. Hold `R1` (`buttons[5]`), `R2` (`buttons[7]`), or `A` (`buttons[0]`) to Charge; Right Stick direction at release shapes the shot.
2. **`TOUCH AUTO-RUN`**:
   - Players automatically run toward `predictedLandingX` on their half of the court.
   - Multi-touch is partitioned by the center net (`touch.identifier` Map): touch and hold on your half to charge, drag thumb to aim/spin, and lift finger to strike.
3. **`2-PAD / KEYBOARD`**:
   - **Player 1**: `Gamepad[0]` or `WASD` + `Space`
   - **Player 2**: `Gamepad[1]` or `Arrow Keys` + `Enter`
   - *(Note: Any side without recent human input automatically engages smart auto-sparring so solo players can rally immediately).*

---

## ⚙️ Live Physics Lab & Web Audio Synthesizer
- **Web Audio Synth**: Muted by default (`[🔇 SOUND: OFF]`). Toggling `[🔊 SOUND: ON]` enables procedural `AudioContext` oscillators for synth bass strikes, wall-bounce chimes, charge pitch sweeps, and filtered white-noise wind gusts.
- **`⚙️ Physics Lab` Drawer**: Live sliders for `Gravity`, `Air Drag`, `Magnus Spin`, `Gust Intensity`, and `Game Speed`, plus `Reset to Heavy Gale` and `Trigger Gust` buttons, persisted automatically to `localStorage`.

---

## 🚀 Running Locally & Offline PWA Mode

```bash
# Serve the directory over HTTP
python -m http.server 8080
```

Then open `http://localhost:8080` in any modern browser. Once loaded, `sw.js` pre-caches `./`, `./index.html`, `./game.js`, and `./manifest.json` so the game works 100% offline.

---

## 📁 Repository Structure

```text
neon-volley-heavy-gale/
├── index.html      # Fullscreen landscape viewport, Synthwave HUD & Physics Lab drawer
├── game.js         # 60 FPS aerodynamic + 2D Magnus solver, 90-step predictor, renderer & synth audio
├── sw.js           # Cache-first Service Worker for 100% offline Airplane Mode operation
├── manifest.json   # Fullscreen landscape PWA configuration
└── README.md       # Documentation & physics reference
```
