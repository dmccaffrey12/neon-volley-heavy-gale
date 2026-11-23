# TEST_READY.md — SUMMER HEAT 3D Opaque-Box E2E Suite Ready Signal

**Status**: **READY** (Strict AND Gate **PASS** — 5/5 Verifiers Green in Iteration 4: Forensic Auditor `CLEAN`, Reviewer 1 `APPROVE`, Reviewer 2 `APPROVE`, Challenger 1 `APPROVE`, Challenger 2 `APPROVE`)  
**Target Branch**: `feat/summer-heat-3d`  
**Infrastructure Spec**: [`TEST_INFRA.md`](./TEST_INFRA.md)  
**Feature Coverage**: **100% (`F01`–`F18`)** across Tiers 1–4 (**80 total opaque-box tests**: 71 Node 22 tests + 9 Playwright SwiftShader WebGL2/Offline PWA scenarios)

---

## 1. Unified E2E Runner Commands (For M5 Final Milestone & `@verifier`)

### Run Complete 4-Tier E2E Suite Sequentially (Canonical M5 Command)
```bash
./tests/e2e/run_all.sh --tier all --port 8080 --artifacts-dir ./qa-artifacts
```
> **Operational Note for M5**: Run Tier 4 sequentially on port `8080` without other concurrent headless SwiftShader Chromium processes competing for CPU on the same VM. Tier 4 saves full native `1280x720` / `844x390` / `390x844` `.png` screenshots, aspect-preserving `640x360` / `640x296` VP9 `.webm` video recordings (flushed strictly after `ctx.close()`), and `e2e_summary.json` into `--artifacts-dir` (`./qa-artifacts`).

### Run Individual Tiers
```bash
# Tier 1 — Category-Partition Feature Coverage (34 tests across Areas A–F)
./tests/e2e/run_all.sh --tier 1

# Tier 2 — Boundary Value Analysis & Corner Cases (28 tests across Areas A–E)
./tests/e2e/run_all.sh --tier 2

# Tier 3 — Cross-Feature Pairwise Combinatorial Suite (9 pairwise suites T3-P1..T3-P9)
./tests/e2e/run_all.sh --tier 3

# Tier 4 — Headless SwiftShader WebGL2, 3-Touch Gameplay, Classic 2D & Offline Cache QA (9 scenarios T4-S1..T4-S9)
./tests/e2e/run_all.sh --tier 4 --port 8080 --artifacts-dir ./qa-artifacts
```

---

## 2. Suite Deliverables & Verified Inventory

| Deliverable | Path | Scope & Verified Count |
| :--- | :--- | :--- |
| **Test Infrastructure Spec** | [`TEST_INFRA.md`](./TEST_INFRA.md) | Opaque-box methodology, `F01–F18` traceability matrix, runner architecture, anti-cheat guarantees |
| **Unified CLI Runner** | [`tests/e2e/run_all.sh`](./tests/e2e/run_all.sh) | Executable (`chmod +x`), `--tier 1\|2\|3\|4\|all`, `--port`, `--artifacts-dir`, `--skip-video`, `--scenario`, `PYTHONDONTWRITEBYTECODE=1 python3 -B` |
| **Boundary Shims & Normalizers** | [`tests/e2e/_helpers/browserShims.mjs`](./tests/e2e/_helpers/browserShims.mjs) | Thin browser-API boundary shims ONLY (`EventTarget`, `localStorage`, `navigator.getGamepads`, `AudioContext` spy), strict read-only snapshot normalizers, `PlayerInputCmd` builders, closed-loop bot controller |
| **Tier 1 (Feature Coverage)** | [`tests/e2e/tier1_features.test.mjs`](./tests/e2e/tier1_features.test.mjs) | **34 tests** (`>= 5` per major feature area across Areas A–F; zero mocks of physics/rally/rigs/Three.js) |
| **Tier 2 (Boundary & Corner Cases)** | [`tests/e2e/tier2_boundaries.test.mjs`](./tests/e2e/tier2_boundaries.test.mjs) | **28 tests** (`>= 5` per major feature area across Areas A–E) |
| **Tier 3 (Pairwise Combinations)** | [`tests/e2e/tier3_pairwise.test.mjs`](./tests/e2e/tier3_pairwise.test.mjs) | **9 pairwise suites** (`T3-P1..T3-P9`, including full 9-row `InputMode × Format × AIStyle × playerRigs` covering array) |
| **Tier 4 (Browser & Offline QA)** | [`tests/e2e/tier4_browser_e2e.py`](./tests/e2e/tier4_browser_e2e.py) | **9 scenarios** (`T4-S1..T4-S9`): `1280x720`, `844x390`, `390x844`, genuine keyboard-driven 3-touch `Bump -> Set -> Heat Spike` point in both `Broadcast 3/4` & `2P Split-Screen`, Physics Lab persistence + Reset + Gust, Quick-Bind 3s, Audio mute toggle, `1v1`/`2v2`, 3 AI styles, `[Play Classic 2D]` + `#backTo3dLink`, `summer-heat-3d-v2` 16-asset cache + v1 purge + offline reload, zero console/page/WebGL/CDN errors, deterministic `/proc/{pid}` server-port ownership verification |

---

## 3. Verification & Integrity Summary

- **Node 22 Tiers 1–3**: **71/71 PASS, 0 FAIL, 0 SKIPPED** across 13 suites.
- **Mutation & Adversarial Rigor**: **15/15** surgical mutations KILLED (0 survived), **51/51** malformed snapshot/event inputs rejected, and **10/10 baseline + 5/5 heavy CPU-contention + slow-boot** `wait_for_port()` collision trials caught deterministically.
- **Tier 4 Browser & Offline QA**: All **9/9 scenarios (`T4-S1`..`T4-S9`)** verified PASS with full `.webm` video recording, native PNG screenshots, `16/16` pre-cached offline assets under `summer-heat-3d-v2`, zero `gl.readPixels()`, zero external CDN requests, zero console/page/WebGL errors, and zero repo `__pycache__` artifacts.
- **Forensic Audit**: **`CLEAN`** — zero state-mutating cheats, zero tautological/vacuous assertions, zero silent skips, and strict exclusive file ownership (`TEST_INFRA.md`, `TEST_READY.md`, `tests/e2e/*`).
