#!/usr/bin/env python3
"""
Tier 4 — Real-World Application & @verifier Browser/Offline QA (Opaque-Box E2E)

Serves the repository via `python3 -m http.server <port> --bind 127.0.0.1`,
launches headless Chromium with SwiftShader WebGL2 flags, enforces strictly
zero console/page/WebGL/CDN errors, NEVER calls `gl.readPixels()`, and runs
all 9 browser/PWA/gameplay scenarios (T4-S1 .. T4-S9), producing PNG screenshots,
.webm recordings, and a structured `e2e_summary.json` report.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import Browser, BrowserContext, Locator, Page, sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[2]

LAUNCH_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]

EXPECTED_PRECACHE_PATHS = [
    "/",
    "/index.html",
    "/manifest.json",
    "/vendor/three.module.min.js",
    "/src/contracts.js",
    "/src/physics3d.js",
    "/src/playerRigs.js",
    "/src/courtScene.js",
    "/src/inputManager.js",
    "/src/rallyEngine.js",
    "/src/audioSynth.js",
    "/src/main.js",
    "/classic-2d/",
    "/classic-2d/index.html",
    "/classic-2d/game.js",
    "/classic-2d/manifest.json",
]

ALL_SCENARIOS = [
    "T4-S1",
    "T4-S2",
    "T4-S3",
    "T4-S4",
    "T4-S5",
    "T4-S6",
    "T4-S7",
    "T4-S8",
    "T4-S9",
]


def is_port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex((host, port)) == 0


def _pid_owns_listening_port(pid: int, port: int) -> bool | None:
    """Return True if `pid` owns a TCP LISTEN socket on `port`, False if not, None if /proc is unavailable."""
    if not Path("/proc/self/fd").is_dir():
        return None

    fd_dir = Path(f"/proc/{pid}/fd")
    if not fd_dir.is_dir():
        return False

    pid_socket_inodes: set[str] = set()
    try:
        entries = list(fd_dir.iterdir())
    except OSError:
        return False

    for entry in entries:
        try:
            target = os.readlink(entry)
        except OSError:
            continue
        if target.startswith("socket:[") and target.endswith("]"):
            pid_socket_inodes.add(target[8:-1])

    if not pid_socket_inodes:
        return False

    target_suffix = f":{port:04X}"
    for candidates in (
        (Path(f"/proc/{pid}/net/tcp"), Path("/proc/net/tcp")),
        (Path(f"/proc/{pid}/net/tcp6"), Path("/proc/net/tcp6")),
    ):
        lines: list[str] | None = None
        for table_path in candidates:
            try:
                lines = table_path.read_text(encoding="utf-8", errors="ignore").splitlines()
                break
            except OSError:
                continue
        if not lines:
            continue
        for line in lines[1:]:
            cols = line.split()
            if len(cols) < 10:
                continue
            if (
                cols[3].upper() == "0A"
                and cols[1].upper().endswith(target_suffix)
                and cols[9] in pid_socket_inodes
            ):
                return True

    return False


def wait_for_port(
    host: str,
    port: int,
    timeout_s: float = 10.0,
    server_proc: subprocess.Popen[bytes] | None = None,
) -> None:
    def _check_proc_alive() -> None:
        if server_proc is not None and server_proc.poll() is not None:
            stderr_text = ""
            if server_proc.stderr is not None:
                try:
                    stderr_text = server_proc.stderr.read().decode("utf-8", errors="replace").strip()
                except Exception:
                    stderr_text = ""
            raise RuntimeError(
                f"HTTP server exited prematurely (code={server_proc.returncode}) on {host}:{port}"
                + (f": {stderr_text}" if stderr_text else "")
            )

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        _check_proc_alive()
        if server_proc is not None:
            owned = _pid_owns_listening_port(server_proc.pid, port)
            if owned is True:
                if is_port_in_use(host, port):
                    _check_proc_alive()
                    return
            elif owned is None:
                if is_port_in_use(host, port):
                    _check_proc_alive()
                    return
        elif is_port_in_use(host, port):
            return
        time.sleep(0.05)
    _check_proc_alive()
    raise RuntimeError(f"HTTP server failed to bind {host}:{port} within {timeout_s}s")


def safe_screenshot(
    page: Page,
    path: Path | str | None = None,
    timeout_ms: int = 60000,
) -> bytes:
    """SwiftShader-safe screenshot capture (never calls gl.readPixels())."""
    kwargs: dict[str, Any] = {
        "animations": "disabled",
        "timeout": timeout_ms,
    }
    if path is not None:
        kwargs["path"] = str(path)
    return page.screenshot(**kwargs)


class PageErrorMonitor:
    """Enforces zero console errors, zero WebGL warnings, zero pageerrors, zero CDN fetches."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.console_errors: list[str] = []
        self.webgl_warnings: list[str] = []
        self.page_errors: list[str] = []
        self.failed_requests: list[str] = []
        self.external_requests: list[str] = []

    def attach(self, page: Page) -> None:
        def on_console(msg: Any) -> None:
            text = msg.text or ""
            lower = text.lower()
            if msg.type == "error":
                self.console_errors.append(text)
            elif msg.type == "warning" and any(
                tok in lower for tok in ("webgl", "gl_", "three.webgl", "readpixels", "shader")
            ):
                self.webgl_warnings.append(text)

        def on_pageerror(err: Any) -> None:
            self.page_errors.append(str(err))

        def on_request(req: Any) -> None:
            url = req.url or ""
            if url.startswith(("http://", "https://")) and not url.startswith(self.base_url + "/") and url != self.base_url:
                self.external_requests.append(url)

        def on_requestfailed(req: Any) -> None:
            failure = req.failure or ""
            # Ignore browser-initiated aborts on intentional navigation transitions
            if "ERR_ABORTED" in str(failure):
                return
            self.failed_requests.append(f"{req.url} ({failure})")

        page.on("console", on_console)
        page.on("pageerror", on_pageerror)
        page.on("request", on_request)
        page.on("requestfailed", on_requestfailed)

    def assert_clean(self, context_label: str) -> None:
        problems: list[str] = []
        if self.console_errors:
            problems.append(f"console_errors={self.console_errors}")
        if self.webgl_warnings:
            problems.append(f"webgl_warnings={self.webgl_warnings}")
        if self.page_errors:
            problems.append(f"page_errors={self.page_errors}")
        if self.failed_requests:
            problems.append(f"failed_requests={self.failed_requests}")
        if self.external_requests:
            problems.append(f"external_cdn_requests={self.external_requests}")
        if problems:
            raise AssertionError(f"[{context_label}] Runtime hygiene violation: " + " | ".join(problems))


def analyze_image_bytes(png_bytes: bytes) -> dict[str, float]:
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    w, h = img.size
    stat = ImageStat.Stat(img)
    rgb_std = sum(stat.stddev) / 3.0
    mean_luma = sum(stat.mean) / 3.0
    # Sample colors (resize slightly for fast unique color count on large frames)
    sample = img.resize((min(w, 320), min(h, 180)))
    colors = sample.getcolors(maxcolors=65536)
    unique_colors = len(colors) if colors is not None else 65536

    left = img.crop((0, 0, w // 2, h))
    right = img.crop((w // 2, 0, w, h))
    left_std = sum(ImageStat.Stat(left).stddev) / 3.0
    right_std = sum(ImageStat.Stat(right).stddev) / 3.0
    left_colors = left.resize((160, 120)).getcolors(maxcolors=32768)
    right_colors = right.resize((160, 120)).getcolors(maxcolors=32768)

    return {
        "width": float(w),
        "height": float(h),
        "unique_colors": float(unique_colors),
        "rgb_std": float(rgb_std),
        "mean_luma": float(mean_luma),
        "left_half_std": float(left_std),
        "right_half_std": float(right_std),
        "left_half_unique": float(len(left_colors) if left_colors is not None else 32768),
        "right_half_unique": float(len(right_colors) if right_colors is not None else 32768),
    }


def mean_abs_diff_bytes(png_a: bytes, png_b: bytes) -> float:
    img_a = Image.open(io.BytesIO(png_a)).convert("RGB")
    img_b = Image.open(io.BytesIO(png_b)).convert("RGB")
    if img_a.size != img_b.size:
        img_b = img_b.resize(img_a.size)
    diff = ImageChops.difference(img_a, img_b)
    stat = ImageStat.Stat(diff)
    return float(sum(stat.mean) / 3.0)


def wait_for_debug_hook(page: Page, timeout_ms: int = 15000) -> None:
    page.wait_for_function(
        "() => Boolean(window.__SUMMER_HEAT_DEBUG__ && typeof window.__SUMMER_HEAT_DEBUG__.getSnapshot === 'function')",
        timeout=timeout_ms,
    )


def get_debug_state(page: Page) -> dict[str, Any]:
    return page.evaluate(
        """() => {
            const d = window.__SUMMER_HEAT_DEBUG__;
            return {
                snapshot: d.getSnapshot(),
                cameraMode: d.getCameraMode(),
                inputMode: d.getInputMode(),
                paused: d.isPaused(),
                physicsConfig: d.getPhysicsConfig(),
                audioEnabled: d.getAudioEnabled(),
            };
        }"""
    )


def _is_real_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def _extract_scores_from_obj(obj: dict[str, Any], depth: int = 0) -> tuple[int, int] | None:
    key_pairs = (
        ("scoreT1", "scoreT2"),
        ("scoreP1", "scoreP2"),
        ("team1Score", "team2Score"),
        ("p1Score", "p2Score"),
        ("team1", "team2"),
        ("p1", "p2"),
        ("t1", "t2"),
        ("left", "right"),
    )
    for k1, k2 in key_pairs:
        v1, v2 = obj.get(k1), obj.get(k2)
        if _is_real_number(v1) and _is_real_number(v2):
            return int(v1), int(v2)

    for nested_key in ("scores", "score"):
        nested = obj.get(nested_key)
        if isinstance(nested, list) and len(nested) >= 2 and _is_real_number(nested[0]) and _is_real_number(nested[1]):
            return int(nested[0]), int(nested[1])
        if isinstance(nested, dict) and depth < 2:
            res = _extract_scores_from_obj(nested, depth + 1)
            if res is not None:
                return res
    return None


def extract_scores(snapshot: dict[str, Any]) -> tuple[int, int]:
    sb = snapshot.get("scoreboard") or {}
    if isinstance(sb, dict):
        res = _extract_scores_from_obj(sb, depth=0)
        if res is not None:
            return res
    raise AssertionError(f"Unable to read scoreboard keys: {list(sb.keys()) if isinstance(sb, dict) else type(sb)}")


def extract_ring(snapshot: dict[str, Any]) -> dict[str, Any]:
    ring = snapshot.get("timingRing") or {}
    active = bool(ring.get("active", ring.get("visible", False)))
    progress = ring.get("progress", ring.get("ratio", ring.get("scale", 0.0)))
    radius = ring.get("radius", ring.get("currentRadius", progress))
    pos = ring.get("pos", ring.get("position"))
    in_sweet = bool(ring.get("inSweetSpot", ring.get("sweetSpot", ring.get("isSweetSpot", False))))
    return {
        "active": active,
        "progress": float(progress) if isinstance(progress, (int, float)) else 0.0,
        "radius": float(radius) if isinstance(radius, (int, float)) else 0.0,
        "pos": pos,
        "inSweetSpot": in_sweet,
    }


def blur_and_focus_canvas(page: Page) -> None:
    page.evaluate(
        """() => {
            if (document.activeElement && typeof document.activeElement.blur === 'function') {
                document.activeElement.blur();
            }
        }"""
    )
    canvas = page.locator("canvas").first
    if canvas.count() > 0:
        try:
            box = canvas.bounding_box()
            if box and box["width"] > 10 and box["height"] > 10:
                page.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
        except Exception:
            pass


def install_raf_telemetry_collector(page: Page) -> None:
    """
    Non-invasive READ-ONLY requestAnimationFrame telemetry recorder.
    NEVER mutates game state — only reads window.__SUMMER_HEAT_DEBUG__.getSnapshot()
    each rendered animation frame so transient 2-frame hit-stops and single-tick
    EVENTS are captured accurately under SwiftShader CPU pacing.
    """
    page.evaluate(
        """() => {
            if (window.__E2E_RAF_STOP__) {
                window.__E2E_RAF_STOP__();
            }
            const log = {
                frames: 0,
                sawTouch1: false,
                sawTouch2: false,
                sawTouch3: false,
                sawHeatSpike: false,
                sawFlameTrail: false,
                sawRingActive: false,
                maxHeatMeter: 0,
                maxHitStop: 0,
                maxCameraPunch: 0,
                eventsSeen: [],
            };
            window.__E2E_RAF_LOG__ = log;
            let running = true;
            window.__E2E_RAF_STOP__ = () => { running = false; };

            function readTouch1(snap) {
                const sb = snap.scoreboard || {};
                if (typeof sb.team1Touches === 'number') return sb.team1Touches;
                if (typeof sb.p1Touches === 'number') return sb.p1Touches;
                if (Array.isArray(sb.touches) && typeof sb.touches[0] === 'number') return sb.touches[0];
                if (sb.touches && typeof sb.touches === 'object') {
                    const v = sb.touches.team1 ?? sb.touches.p1 ?? sb.touches[1];
                    if (typeof v === 'number') return v;
                }
                const tc = sb.touchCount ?? snap.touchCount;
                const team = sb.activeTeam ?? sb.touchTeam ?? sb.possessionTeam ?? snap.activeTeam ?? snap.touchTeam ?? snap.ball?.lastHitTeam;
                if (typeof tc === 'number' && (team === 1 || team === undefined)) return tc;
                return 0;
            }

            function sample() {
                if (!running) return;
                try {
                    const dbg = window.__SUMMER_HEAT_DEBUG__;
                    if (dbg && typeof dbg.getSnapshot === 'function') {
                        const snap = dbg.getSnapshot();
                        if (snap) {
                            log.frames += 1;
                            const evs = Array.isArray(snap.events) ? snap.events : [];
                            for (const ev of evs) {
                                const t = typeof ev === 'string' ? ev : ev?.type;
                                if (t) {
                                    if (log.eventsSeen.length < 2000) log.eventsSeen.push(t);
                                    if (t === 'BUMP' || t === 'DIVE') log.sawTouch1 = true;
                                    if (t === 'SET') log.sawTouch2 = true;
                                    if (t === 'SPIKE' || t === 'HEAT_SPIKE' || t === 'POKEY_CUT') log.sawTouch3 = true;
                                    if (t === 'HEAT_SPIKE') log.sawHeatSpike = true;
                                }
                            }
                            const t1 = readTouch1(snap);
                            if (t1 >= 1) log.sawTouch1 = true;
                            if (t1 >= 2) log.sawTouch2 = true;
                            if (t1 >= 3) log.sawTouch3 = true;

                            const players = Array.isArray(snap.players) ? snap.players : [];
                            for (const p of players) {
                                if (p.team === 1) {
                                    if (typeof p.heatMeter === 'number' && p.heatMeter > log.maxHeatMeter) {
                                        log.maxHeatMeter = p.heatMeter;
                                    }
                                    if (p.animState === 'UnderhandBump' || p.animState === 'SandDive') log.sawTouch1 = true;
                                    if (p.animState === 'OverheadSet') log.sawTouch2 = true;
                                    if (p.animState === 'JumpHeatSpike') log.sawTouch3 = true;
                                }
                            }
                            if (snap.timingRing && (snap.timingRing.active || snap.timingRing.visible)) {
                                log.sawRingActive = true;
                                log.sawTouch2 = true;
                            }
                            if (snap.ball) {
                                if (snap.ball.shotType === 'HEAT_SPIKE') log.sawHeatSpike = true;
                                if (snap.ball.trailMode === 'FLAME') {
                                    log.sawFlameTrail = true;
                                    log.sawHeatSpike = true;
                                }
                            }
                            if (typeof snap.hitStopFrames === 'number' && snap.hitStopFrames > log.maxHitStop) {
                                log.maxHitStop = snap.hitStopFrames;
                            }
                            if (typeof snap.cameraPunch === 'number' && snap.cameraPunch > log.maxCameraPunch) {
                                log.maxCameraPunch = snap.cameraPunch;
                            }
                        }
                    }
                } catch (_err) {
                    // Read-only collector never throws into page
                }
                requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
        }"""
    )


def find_visible_control(
    root: Page | Locator,
    text_regex: str,
    attr_keywords: list[str],
    tags: tuple[str, ...] = ("button", "select", "a"),
) -> Locator | None:
    """Resilient opaque-box HUD locator matching semantic role/text first, then id/testid/aria-label."""
    pattern = re.compile(text_regex, re.IGNORECASE)
    for tag in tags:
        loc = root.locator(tag).filter(has_text=pattern)
        count = loc.count()
        for idx in range(count):
            cand = loc.nth(idx)
            try:
                if cand.is_visible():
                    return cand
            except Exception:
                continue

    for kw in attr_keywords:
        sel = f'[data-testid*="{kw}" i], [id*="{kw}" i], [aria-label*="{kw}" i]'
        loc = root.locator(sel)
        count = loc.count()
        for idx in range(count):
            cand = loc.nth(idx)
            try:
                if cand.is_visible():
                    return cand
            except Exception:
                continue
    return None


def _find_open_physics_drawer(page: Page) -> Locator | None:
    """Locate an open Physics Lab drawer container so drawer buttons are never shadowed by background HUD buttons."""
    sel = (
        'aside.open, aside[aria-hidden="false"], '
        '[data-testid*="physics-drawer" i], [id*="physicsDrawer" i], [aria-label*="physics" i]'
    )
    loc = page.locator(sel)
    count = loc.count()
    for idx in range(count):
        cand = loc.nth(idx)
        try:
            if cand.is_visible():
                return cand
        except Exception:
            continue
    return None


def switch_mode_control(
    page: Page,
    target_value: Any,
    getter_js: str,
    button_text_regex: str,
    attr_keywords: list[str],
    direct_option_regex: str | None = None,
    option_value: str | None = None,
    max_clicks: int = 6,
) -> Any:
    """Switch a HUD toggle, segmented button group, or <select> until debug getter equals target_value."""
    current = page.evaluate(getter_js)
    if current == target_value:
        return current

    opt_val = option_value if option_value is not None else str(target_value)
    opt_lower = opt_val.lower()

    # 1. Try direct segmented button matching option value (e.g. [data-mode="2PAD"] or explicit button)
    if direct_option_regex:
        direct_btn = find_visible_control(
            page,
            direct_option_regex,
            [opt_lower],
            tags=("button",),
        )
        if direct_btn is not None:
            direct_btn.click()
            page.wait_for_timeout(120)
            current = page.evaluate(getter_js)
            if current == target_value:
                return current

    # 2. Try attribute data-* buttons (e.g. data-mode / data-camera / data-ai / data-format)
    attr_vals = [opt_val] if opt_val == opt_lower else [opt_val, opt_lower]
    for attr in ("data-mode", "data-camera", "data-ai", "data-format", "data-value"):
        for val in attr_vals:
            btn = page.locator(f'button[{attr}="{val}"]')
            if btn.count() > 0 and btn.first.is_visible():
                btn.first.click()
                page.wait_for_timeout(120)
                current = page.evaluate(getter_js)
                if current == target_value:
                    return current

    # 3. Try <select> or cycling <button>
    ctrl = find_visible_control(page, button_text_regex, attr_keywords, tags=("select", "button"))
    if ctrl is None:
        raise AssertionError(
            f"Could not find HUD control for target={target_value} (regex={button_text_regex}, kw={attr_keywords})"
        )

    tag_name = ctrl.evaluate("el => el.tagName.toLowerCase()")
    if tag_name == "select":
        ctrl.select_option(value=opt_val)
        page.wait_for_timeout(120)
        current = page.evaluate(getter_js)
        return current

    for _ in range(max_clicks):
        ctrl.click()
        page.wait_for_timeout(120)
        current = page.evaluate(getter_js)
        if current == target_value:
            return current
    return current


def find_physics_slider(page: Page, min_val: float, max_val: float, kw_fallback: str) -> Locator:
    """Locate a Physics Lab <input type='range'> by its unique PHYSICS_LIMITS (min, max) pair."""
    sliders = page.locator('input[type="range"]')
    count = sliders.count()
    for i in range(count):
        s = sliders.nth(i)
        try:
            if not s.is_visible():
                continue
            s_min = float(s.get_attribute("min") or "nan")
            s_max = float(s.get_attribute("max") or "nan")
            if abs(s_min - min_val) < 1e-4 and abs(s_max - max_val) < 1e-4:
                return s
        except Exception:
            continue

    fallback = page.locator(f'input[type="range"][id*="{kw_fallback}" i], input[type="range"][data-testid*="{kw_fallback}" i]')
    if fallback.count() > 0:
        return fallback.first
    raise AssertionError(f"Could not locate Physics Lab slider for ({min_val}..{max_val}, {kw_fallback})")


def set_range_slider(slider: Locator, value: float) -> None:
    slider.evaluate(
        """(el, val) => {
            el.value = String(val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        value,
    )


def drive_three_touch_heat_spike_point(
    page: Page,
    timeout_s: float = 45.0,
    capture_spike_png: Path | None = None,
) -> dict[str, Any]:
    """
    Genuine closed-loop keyboard controller (ZERO state mutation).
    Reads window.__SUMMER_HEAT_DEBUG__.getSnapshot() and __E2E_RAF_LOG__ only,
    drives P1 solely via real page.keyboard.down/up events (KeyA/D/W/S + Space).
    """
    # Ensure keyboard input mode is active (2PAD) and focus is on canvas
    switch_mode_control(
        page,
        "2PAD",
        "() => window.__SUMMER_HEAT_DEBUG__.getInputMode()",
        r"1-?pad|2-?pad|keyboard|touch|input|mode",
        ["input", "mode"],
        direct_option_regex=r"2-?pad|keyboard",
    )
    blur_and_focus_canvas(page)
    install_raf_telemetry_collector(page)

    start_snap = page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getSnapshot()")
    s1, s2 = extract_scores(start_snap)
    start_total = s1 + s2

    held_keys: set[str] = set()
    captured_spike = False
    spike_grace_granted = False
    coasting_keys_cleared = False
    last_pulse_t = 0.0
    deadline = time.monotonic() + timeout_s

    def set_key(key: str, want_down: bool) -> None:
        if want_down and key not in held_keys:
            page.keyboard.down(key)
            held_keys.add(key)
        elif not want_down and key in held_keys:
            page.keyboard.up(key)
            held_keys.discard(key)

    def tap_space(min_hold_s: float = 0.14, max_hold_s: float = 0.75) -> None:
        page.keyboard.down("Space")
        held_keys.add("Space")
        start_frames = page.evaluate(
            "() => (window.__E2E_RAF_LOG__ && window.__E2E_RAF_LOG__.frames) || 0"
        )
        t_start = time.monotonic()
        while True:
            page.wait_for_timeout(75)
            elapsed = time.monotonic() - t_start
            cur_frames = page.evaluate(
                "() => (window.__E2E_RAF_LOG__ && window.__E2E_RAF_LOG__.frames) || 0"
            )
            if cur_frames >= start_frames + 1 and elapsed >= min_hold_s:
                break
            if elapsed >= max_hold_s:
                break
        page.keyboard.up("Space")
        held_keys.discard("Space")

    try:
        while time.monotonic() < deadline:
            data = page.evaluate(
                """() => ({
                    snap: window.__SUMMER_HEAT_DEBUG__.getSnapshot(),
                    log: window.__E2E_RAF_LOG__,
                })"""
            )
            snap = data["snap"]
            log = data["log"]
            players = snap.get("players") or []
            p1 = next((p for p in players if p.get("team") == 1 and p.get("role") == "PRIMARY"), None)
            if p1 is None and players:
                p1 = players[0]
            ball = snap["ball"]
            pred = snap.get("prediction") or {}
            ring = extract_ring(snap)

            cur_s1, cur_s2 = extract_scores(snap)
            score_incremented = (cur_s1 + cur_s2) > start_total

            if log["sawHeatSpike"] and capture_spike_png and not captured_spike:
                shot_t0 = time.monotonic()
                safe_screenshot(page, path=capture_spike_png)
                deadline += time.monotonic() - shot_t0
                captured_spike = True

            if log["sawTouch1"] and log["sawTouch2"] and (log["sawHeatSpike"] or log["sawTouch3"]) and score_incremented:
                if log["sawHeatSpike"]:
                    if capture_spike_png and not captured_spike:
                        safe_screenshot(page, path=capture_spike_png)
                        captured_spike = True
                    return {
                        **log,
                        "score_start": [s1, s2],
                        "score_end": [cur_s1, cur_s2],
                        "score_incremented": True,
                    }

            # Once Team 1 has executed the full 3-touch Bump -> Set -> Heat Spike, grant a dedicated
            # post-spike point-completion grace budget (so an AI DIVE -> SET -> LOB return can always
            # reach sand under SwiftShader) and release movement keys once while coasting at 300ms poll.
            if log["sawTouch1"] and log["sawTouch2"] and log["sawHeatSpike"]:
                if not spike_grace_granted:
                    deadline = max(deadline, time.monotonic() + 75.0)
                    spike_grace_granted = True
                if captured_spike or capture_spike_png is None:
                    if not coasting_keys_cleared:
                        for move_key in ("KeyA", "KeyD", "KeyW", "KeyS"):
                            set_key(move_key, False)
                        coasting_keys_cleared = True
                    page.wait_for_timeout(300)
                    continue

            if p1 is not None:
                px = float(p1["pos"]["x"])
                pz = float(p1["pos"]["z"])
                bx = float(ball["pos"]["x"])
                by = float(ball["pos"]["y"])
                bz = float(ball["pos"]["z"])
                vx = float(ball["vel"]["x"])
                vy = float(ball["vel"]["y"])
                vz = float(ball["vel"]["z"])
                bspeed = math.sqrt(vx * vx + vy * vy + vz * vz)

                # Determine target (tx, tz) on Team 1 side (-X)
                if ring["active"] and bx <= 0.6:
                    rpos = ring["pos"] or ball["pos"]
                    tx = max(-7.6, min(-0.45, float(rpos["x"])))
                    tz = max(-3.7, min(3.7, float(rpos["z"])))
                elif isinstance(pred.get("x"), (int, float)) and float(pred["x"]) < 0.0:
                    tx = max(-7.6, min(-0.45, float(pred["x"])))
                    tz = max(-3.7, min(3.7, float(pred.get("z", 0.0))))
                elif bx < 0.2:
                    tx = max(-7.6, min(-0.45, bx))
                    tz = max(-3.7, min(3.7, bz))
                else:
                    tx = -3.8
                    tz = 0.0

                set_key("KeyD", (tx - px) > 0.35)
                set_key("KeyA", (tx - px) < -0.35)
                set_key("KeyS", (tz - pz) > 0.35)
                set_key("KeyW", (tz - pz) < -0.35)

                now = time.monotonic()
                hdist = math.hypot(bx - px, bz - pz)

                if now - last_pulse_t >= 0.16:
                    # Serve trigger when ball is idle on Team 1 side
                    if (not ball.get("active", True)) or (bspeed < 0.25 and bx < 0.0):
                        tap_space()
                        last_pulse_t = time.monotonic()
                    elif ring["active"] and bx <= 0.6:
                        # Sweet-spot Touch 3 Heat Spike timing:
                        # Release KeyA & hold KeyD (aimForward >= 0 -> HEAT_SPIKE) and aim diagonally
                        # into the open sideline corner away from Team 2's defender.
                        sweet = (
                            ring["inSweetSpot"]
                            or (0.50 <= ring["progress"] <= 0.94)
                            or (2.0 <= by <= 3.7 and abs(vy) < 3.6)
                        )
                        if sweet and hdist < 1.85:
                            p2 = next((p for p in players if p.get("team") == 2), None)
                            p2_z = float(p2["pos"]["z"]) if p2 is not None else 0.0
                            aim_far_corner = p2_z >= 0.0
                            set_key("KeyA", False)
                            set_key("KeyD", True)
                            set_key("KeyW", aim_far_corner)
                            set_key("KeyS", not aim_far_corner)
                            tap_space()
                            last_pulse_t = time.monotonic()
                    elif bx < 0.25 and hdist < 2.4 and by < 2.95 and vy < 3.0:
                        tap_space()
                        last_pulse_t = time.monotonic()

            page.wait_for_timeout(130)

        # Final readout at timeout
        final_data = page.evaluate(
            """() => ({
                snap: window.__SUMMER_HEAT_DEBUG__.getSnapshot(),
                log: window.__E2E_RAF_LOG__,
            })"""
        )
        cur_s1, cur_s2 = extract_scores(final_data["snap"])
        if capture_spike_png and not captured_spike:
            safe_screenshot(page, path=capture_spike_png)
        return {
            **final_data["log"],
            "score_start": [s1, s2],
            "score_end": [cur_s1, cur_s2],
            "score_incremented": (cur_s1 + cur_s2) > start_total,
        }
    finally:
        for k in list(held_keys):
            try:
                page.keyboard.up(k)
            except Exception:
                pass
        held_keys.clear()
        try:
            page.evaluate("() => window.__E2E_RAF_STOP__ && window.__E2E_RAF_STOP__()")
        except Exception:
            pass


def create_context(
    browser: Browser,
    width: int,
    height: int,
    video_dir: Path | None = None,
) -> BrowserContext:
    kwargs: dict[str, Any] = {
        "viewport": {"width": width, "height": height},
        "device_scale_factor": 1,
    }
    if video_dir is not None:
        video_dir.mkdir(parents=True, exist_ok=True)
        if width > 640:
            vid_w = 640
            vid_h = max(2, int(round(height * (640.0 / width))) & ~1)
        else:
            vid_w = max(2, width & ~1)
            vid_h = max(2, height & ~1)
        kwargs["record_video_dir"] = str(video_dir)
        kwargs["record_video_size"] = {"width": vid_w, "height": vid_h}
    return browser.new_context(**kwargs)


def run_t4_s1(browser: Browser, base_url: str, artifacts_dir: Path) -> dict[str, Any]:
    """T4-S1: WebGL2 Render & Live Animation Proof (1280x720)."""
    ctx = create_context(browser, 1280, 720)
    try:
        page = ctx.new_page()
        mon = PageErrorMonitor(base_url)
        mon.attach(page)
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        wait_for_debug_hook(page)
        page.wait_for_timeout(500)

        canvas = page.locator("canvas").first
        box = canvas.bounding_box()
        assert box is not None and box["width"] >= 1200 and box["height"] >= 680, f"Canvas bbox unexpected: {box}"

        frame1 = safe_screenshot(page)
        page.wait_for_timeout(600)
        frame2 = safe_screenshot(page)

        stats1 = analyze_image_bytes(frame1)
        diff = mean_abs_diff_bytes(frame1, frame2)

        assert stats1["unique_colors"] > 100, f"Canvas appears blank/flat: unique_colors={stats1['unique_colors']}"
        assert stats1["rgb_std"] > 10.0, f"Canvas RGB std too low: {stats1['rgb_std']}"
        assert diff > 0.5, f"Canvas appears frozen (no live animation): mean_abs_diff={diff:.3f}"

        page.wait_for_timeout(150)
        mon.assert_clean("T4-S1")
        return {"stats": stats1, "frame_diff": diff}
    finally:
        ctx.close()


def run_t4_s2(browser: Browser, base_url: str, artifacts_dir: Path, skip_video: bool) -> dict[str, Any]:
    """T4-S2: Complete 3-Touch Bump -> Set -> Heat Spike Point in Broadcast 3/4 (1280x720 + .webm)."""
    video_dir = None if skip_video else artifacts_dir / "videos" / "broadcast"
    ctx = create_context(browser, 1280, 720, video_dir=video_dir)
    video_path: Path | None = None
    try:
        page = ctx.new_page()
        mon = PageErrorMonitor(base_url)
        mon.attach(page)
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        wait_for_debug_hook(page)

        cam = switch_mode_control(
            page,
            "BROADCAST",
            "() => window.__SUMMER_HEAT_DEBUG__.getCameraMode()",
            r"broadcast|split|cam",
            ["camera", "cam"],
            direct_option_regex=r"broadcast",
        )
        assert cam == "BROADCAST", f"Expected BROADCAST camera mode, got {cam}"

        spike_png = artifacts_dir / "broadcast_1280x720_spike.png"
        telemetry = drive_three_touch_heat_spike_point(page, timeout_s=120.0, capture_spike_png=spike_png)

        assert telemetry["sawTouch1"], f"T4-S2 did not observe Touch 1 Bump/Dive: {telemetry}"
        assert telemetry["sawTouch2"], f"T4-S2 did not observe Touch 2 Set / Timing Ring: {telemetry}"
        assert telemetry["sawTouch3"], f"T4-S2 did not observe Touch 3 Attack: {telemetry}"
        assert telemetry["maxHeatMeter"] > 0, f"T4-S2 heatMeter never rose above 0: {telemetry}"
        assert telemetry["sawHeatSpike"], f"T4-S2 did not observe full Heat Spike: {telemetry}"
        assert telemetry["score_incremented"], f"T4-S2 did not complete a point: {telemetry}"

        assert spike_png.exists() and spike_png.stat().st_size > 10_000, "broadcast_1280x720_spike.png missing or empty"
        page.wait_for_timeout(150)
        mon.assert_clean("T4-S2")
        if page.video is not None:
            video_path = Path(page.video.path())
        return {"telemetry": telemetry, "screenshot": str(spike_png)}
    finally:
        ctx.close()
        if not skip_video and video_path is not None:
            assert video_path.exists() and video_path.stat().st_size > 10_000, f"Broadcast video missing/empty: {video_path}"


def run_t4_s3(browser: Browser, base_url: str, artifacts_dir: Path, skip_video: bool) -> dict[str, Any]:
    """T4-S3: Complete 3-Touch Bump -> Set -> Heat Spike Point in 2P Split-Screen + Scissor Reset."""
    video_dir = None if skip_video else artifacts_dir / "videos" / "split"
    ctx = create_context(browser, 1280, 720, video_dir=video_dir)
    video_path: Path | None = None
    try:
        page = ctx.new_page()
        mon = PageErrorMonitor(base_url)
        mon.attach(page)
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        wait_for_debug_hook(page)

        cam = switch_mode_control(
            page,
            "SPLIT",
            "() => window.__SUMMER_HEAT_DEBUG__.getCameraMode()",
            r"broadcast|split|cam",
            ["camera", "cam"],
            direct_option_regex=r"split",
        )
        assert cam == "SPLIT", f"Expected SPLIT camera mode, got {cam}"
        page.wait_for_timeout(350)

        split_preview = safe_screenshot(page)
        split_stats = analyze_image_bytes(split_preview)
        assert split_stats["left_half_std"] > 8.0 and split_stats["left_half_unique"] > 40, (
            f"SPLIT left half viewport appears blank: {split_stats}"
        )
        assert split_stats["right_half_std"] > 8.0 and split_stats["right_half_unique"] > 40, (
            f"SPLIT right half viewport appears blank: {split_stats}"
        )

        spike_png = artifacts_dir / "split_1280x720_spike.png"
        telemetry = drive_three_touch_heat_spike_point(page, timeout_s=120.0, capture_spike_png=spike_png)

        assert telemetry["sawTouch1"], f"T4-S3 did not observe Touch 1: {telemetry}"
        assert telemetry["sawTouch2"], f"T4-S3 did not observe Touch 2: {telemetry}"
        assert telemetry["sawTouch3"], f"T4-S3 did not observe Touch 3: {telemetry}"
        assert telemetry["sawHeatSpike"], f"T4-S3 did not observe Heat Spike: {telemetry}"
        assert telemetry["score_incremented"], f"T4-S3 did not complete a point: {telemetry}"

        # Return to BROADCAST and confirm scissor test resets cleanly (full-width non-clipped render)
        cam_back = switch_mode_control(
            page,
            "BROADCAST",
            "() => window.__SUMMER_HEAT_DEBUG__.getCameraMode()",
            r"broadcast|split|cam",
            ["camera", "cam"],
            direct_option_regex=r"broadcast",
        )
        assert cam_back == "BROADCAST", f"Expected return to BROADCAST, got {cam_back}"
        page.wait_for_timeout(350)
        after_broadcast = safe_screenshot(page)
        after_stats = analyze_image_bytes(after_broadcast)
        assert after_stats["left_half_std"] > 8.0 and after_stats["right_half_std"] > 8.0, (
            f"BROADCAST after SPLIT appears scissor-clipped: {after_stats}"
        )
        assert mean_abs_diff_bytes(split_preview, after_broadcast) > 3.0, (
            "Switching SPLIT -> BROADCAST must visibly change camera layout"
        )

        assert spike_png.exists() and spike_png.stat().st_size > 10_000, "split_1280x720_spike.png missing or empty"
        page.wait_for_timeout(150)
        mon.assert_clean("T4-S3")
        if page.video is not None:
            video_path = Path(page.video.path())
        return {"telemetry": telemetry, "split_stats": split_stats, "screenshot": str(spike_png)}
    finally:
        ctx.close()
        if not skip_video and video_path is not None:
            assert video_path.exists() and video_path.stat().st_size > 10_000, f"Split video missing/empty: {video_path}"


def run_t4_s4(browser: Browser, base_url: str, artifacts_dir: Path, skip_video: bool) -> dict[str, Any]:
    """T4-S4: Mobile Landscape 844x390 HUD & Zero-Overflow Audit."""
    video_dir = None if skip_video else artifacts_dir / "videos" / "mobile"
    ctx = create_context(browser, 844, 390, video_dir=video_dir)
    video_path: Path | None = None
    try:
        page = ctx.new_page()
        mon = PageErrorMonitor(base_url)
        mon.attach(page)
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        wait_for_debug_hook(page)
        page.wait_for_timeout(450)

        dims = page.evaluate(
            """() => ({
                scrollWidth: document.documentElement.scrollWidth,
                scrollHeight: document.documentElement.scrollHeight,
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
            })"""
        )
        assert dims["scrollWidth"] <= 844, f"Mobile horizontal overflow: {dims}"
        assert dims["scrollHeight"] <= 390, f"Mobile vertical overflow: {dims}"

        # Audit all effectively visible HUD interactive controls lie within [0, 844] x [0, 390]
        hud_audit = page.evaluate(
            """() => {
                function isEffectivelyVisible(el) {
                    const ownStyle = window.getComputedStyle(el);
                    if (ownStyle.pointerEvents === 'none') return false;
                    let cur = el;
                    while (cur && cur.nodeType === 1) {
                        if (cur.hidden || cur.getAttribute('aria-hidden') === 'true' || cur.hasAttribute('inert')) {
                            return false;
                        }
                        const st = cur === el ? ownStyle : window.getComputedStyle(cur);
                        if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) {
                            return false;
                        }
                        if (cur === document.body) break;
                        cur = cur.parentElement;
                    }
                    return true;
                }

                const els = Array.from(document.querySelectorAll('button, a, select'));
                const checked = [];
                const violations = [];
                for (const el of els) {
                    if (!isEffectivelyVisible(el)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 && r.height === 0) continue;
                    const info = { text: (el.textContent || '').trim().slice(0, 30), id: el.id, x: r.x, y: r.y, w: r.width, h: r.height };
                    checked.push(info);
                    if (r.width <= 0 || r.height <= 0 || r.left < -1 || r.top < -1 || r.right > 845 || r.bottom > 391) {
                        violations.push(info);
                    }
                }
                return { checkedCount: checked.length, violations };
            }"""
        )
        assert hud_audit["checkedCount"] > 0, "Expected visible HUD controls at 844x390"
        assert len(hud_audit["violations"]) == 0, f"HUD controls overflow 844x390 viewport: {hud_audit['violations']}"

        mobile_png = artifacts_dir / "mobile_844x390.png"
        png_bytes = safe_screenshot(page, path=mobile_png)
        assert mobile_png.exists() and mobile_png.stat().st_size > 10_000, "mobile_844x390.png missing or empty"
        stats = analyze_image_bytes(png_bytes)
        assert stats["unique_colors"] > 100 and stats["rgb_std"] > 10.0, f"Mobile canvas appears blank: {stats}"

        page.wait_for_timeout(150)
        mon.assert_clean("T4-S4")
        if page.video is not None:
            video_path = Path(page.video.path())
        return {"dims": dims, "hud_checked": hud_audit["checkedCount"], "stats": stats, "screenshot": str(mobile_png)}
    finally:
        ctx.close()
        if not skip_video and video_path is not None:
            assert video_path.exists() and video_path.stat().st_size > 10_000, f"Mobile video missing/empty: {video_path}"


def run_t4_s5(browser: Browser, base_url: str, artifacts_dir: Path) -> dict[str, Any]:
    """T4-S5: Audio Toggle, Physics Lab Sliders & Persistence, Gust, 1v1/2v2, AI Styles, Input Modes."""
    ctx = create_context(browser, 1280, 720)
    try:
        page = ctx.new_page()
        mon = PageErrorMonitor(base_url)
        mon.attach(page)
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        wait_for_debug_hook(page)

        # 1. Audio toggle (muted False -> True -> False)
        assert page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getAudioEnabled()") is False, "Audio must start muted"
        audio_btn = find_visible_control(page, r"sound|audio|mute|🔇|🔊", ["audio", "sound", "mute"], tags=("button",))
        assert audio_btn is not None, "Could not locate Audio toggle button"
        audio_btn.click()
        page.wait_for_timeout(150)
        assert page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getAudioEnabled()") is True, "Audio toggle must enable sound"
        audio_btn.click()
        page.wait_for_timeout(150)
        assert page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getAudioEnabled()") is False, "Second audio click must mute"

        # 2. Physics Lab drawer + sliders + localStorage reload persistence + v1 isolation + Reset
        lab_btn = find_visible_control(page, r"physics\s*lab|⚙", ["physics", "lab"], tags=("button",))
        assert lab_btn is not None, "Could not locate Physics Lab button"
        lab_btn.click()
        page.wait_for_timeout(200)

        grav_slider = find_physics_slider(page, 6.0, 18.0, "gravity")
        gust_slider = find_physics_slider(page, 0.0, 2.0, "gust")
        set_range_slider(grav_slider, 14.0)
        set_range_slider(gust_slider, 1.6)
        page.wait_for_timeout(150)

        cfg_after = page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getPhysicsConfig()")
        assert abs(cfg_after["gravity"] - 14.0) < 0.05, f"Expected gravity=14.0, got {cfg_after}"
        assert abs(cfg_after["gustScale"] - 1.6) < 0.05, f"Expected gustScale=1.6, got {cfg_after}"

        stored_v2 = page.evaluate("() => localStorage.getItem('summer_heat_3d_physics_v2')")
        stored_v1 = page.evaluate("() => localStorage.getItem('neon_volley_heavy_gale_physics_v1')")
        assert stored_v2 is not None, "Physics Lab must persist to summer_heat_3d_physics_v2"
        assert stored_v1 is None, "v2 Physics Lab must never write to v1 key neon_volley_heavy_gale_physics_v1"

        # Trigger manual Gust (scope inside open Physics Lab drawer first)
        drawer = _find_open_physics_drawer(page)
        gust_btn = (
            find_visible_control(drawer, r"trigger\s*gust|gust|surge", ["gust", "surge"], tags=("button",))
            if drawer is not None
            else None
        )
        if gust_btn is None:
            gust_btn = find_visible_control(page, r"trigger\s*gust|gust|surge", ["gust", "surge"], tags=("button",))
        assert gust_btn is not None, "Could not locate Trigger Gust button"
        gust_btn.click()
        page.wait_for_timeout(200)
        wind_phase = page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getSnapshot().wind.phase")
        assert wind_phase in ("WARNING", "GUST"), f"Trigger Gust must enter WARNING or GUST, got {wind_phase}"

        # Reload and confirm persistence
        page.reload(wait_until="domcontentloaded")
        wait_for_debug_hook(page)
        cfg_reloaded = page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getPhysicsConfig()")
        assert abs(cfg_reloaded["gravity"] - 14.0) < 0.05, f"Gravity did not persist across reload: {cfg_reloaded}"
        assert abs(cfg_reloaded["gustScale"] - 1.6) < 0.05, f"GustScale did not persist across reload: {cfg_reloaded}"

        # Open drawer again and click drawer-scoped Reset Physics button (never bare HUD Reset Match)
        lab_btn2 = find_visible_control(page, r"physics\s*lab|⚙", ["physics", "lab"], tags=("button",))
        assert lab_btn2 is not None
        lab_btn2.click()
        page.wait_for_timeout(200)

        drawer2 = _find_open_physics_drawer(page)
        reset_btn = (
            find_visible_control(
                drawer2,
                r"reset\s*(defaults?|physics|gale|lab)?",
                ["reset-physics", "resetPhysics", "reset"],
                tags=("button",),
            )
            if drawer2 is not None
            else None
        )
        if reset_btn is None:
            reset_btn = find_visible_control(
                page,
                r"reset\s*(defaults?|physics|gale|lab)",
                ["reset-physics", "resetPhysics", "reset-defaults", "resetDefaults"],
                tags=("button",),
            )
        assert reset_btn is not None, "Could not locate Physics Lab Reset button"
        reset_btn.click()
        page.wait_for_timeout(150)
        cfg_reset = page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getPhysicsConfig()")
        assert abs(cfg_reset["gravity"] - 11.2) < 0.05, f"Reset must restore default gravity=11.2, got {cfg_reset}"

        # Close drawer if a close button is visible (scope inside open drawer first)
        close_btn = (
            find_visible_control(drawer2, r"close|×|✕", ["close"], tags=("button",))
            if drawer2 is not None
            else None
        )
        if close_btn is None:
            close_btn = find_visible_control(page, r"close|×|✕", ["close"], tags=("button",))
        if close_btn is not None:
            close_btn.click()
            page.wait_for_timeout(150)

        # 3. 1v1 <-> 2v2 format toggle
        switch_mode_control(
            page,
            4,
            "() => window.__SUMMER_HEAT_DEBUG__.getSnapshot().players.length",
            r"1v1|2v2|format|players",
            ["format", "2v2", "players"],
            direct_option_regex=r"2v2",
            option_value="2v2",
        )
        assert page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getSnapshot().players.length") == 4, "2v2 must spawn 4 players"

        switch_mode_control(
            page,
            2,
            "() => window.__SUMMER_HEAT_DEBUG__.getSnapshot().players.length",
            r"1v1|2v2|format|players",
            ["format", "1v1", "players"],
            direct_option_regex=r"1v1",
            option_value="1v1",
        )
        assert page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getSnapshot().players.length") == 2, "1v1 must spawn 2 players"

        # 4. Cycle AI styles (supports segmented button groups, <select>, or single cycling button)
        ai_btn_loc = page.locator("button").filter(has_text=re.compile(r"lobber|blocker|slicer", re.IGNORECASE))
        visible_ai_btns: list[Locator] = []
        for idx in range(ai_btn_loc.count()):
            cand = ai_btn_loc.nth(idx)
            try:
                if cand.is_visible():
                    visible_ai_btns.append(cand)
            except Exception:
                continue

        if len(visible_ai_btns) >= 2:
            seen_styles: set[str] = set()
            for btn in visible_ai_btns:
                btn.click()
                page.wait_for_timeout(100)
                lbl = (btn.text_content() or "").strip()
                if lbl:
                    seen_styles.add(lbl)
                sb_style = page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.getSnapshot()?.scoreboard?.aiStyle ?? null")
                if sb_style:
                    seen_styles.add(str(sb_style))
            assert len(seen_styles) >= 2, f"Segmented AI style buttons did not switch styles: {seen_styles}"
        else:
            ai_ctrl = find_visible_control(page, r"lobber|blocker|slicer|ai", ["ai"], tags=("select", "button"))
            assert ai_ctrl is not None, "Could not locate AI style selector"
            ai_tag = ai_ctrl.evaluate("el => el.tagName.toLowerCase()")
            if ai_tag == "select":
                for style in ("WIND_LOBBER", "NET_BLOCKER", "SPIN_SLICER"):
                    ai_ctrl.select_option(value=style)
                    page.wait_for_timeout(100)
                    assert ai_ctrl.input_value() == style, f"Expected AI select value {style}, got {ai_ctrl.input_value()}"
            else:
                seen_labels = set()
                for _ in range(4):
                    seen_labels.add((ai_ctrl.text_content() or "").strip())
                    ai_ctrl.click()
                    page.wait_for_timeout(100)
                assert len(seen_labels) >= 2, f"AI style button did not cycle styles: {seen_labels}"

        # 5. Cycle all 3 Input modes (1PAD, 2PAD, TOUCH)
        for mode, direct_re in (
            ("1PAD", r"1-?pad|stadia"),
            ("2PAD", r"2-?pad|keyboard"),
            ("TOUCH", r"touch"),
        ):
            res_mode = switch_mode_control(
                page,
                mode,
                "() => window.__SUMMER_HEAT_DEBUG__.getInputMode()",
                r"1-?pad|2-?pad|touch|input|mode",
                ["input", "mode"],
                direct_option_regex=direct_re,
            )
            assert res_mode == mode, f"Failed to switch input mode to {mode}, got {res_mode}"

        page.wait_for_timeout(150)
        mon.assert_clean("T4-S5")
        return {"physics_reloaded": cfg_reloaded, "physics_reset": cfg_reset, "wind_phase": wind_phase}
    finally:
        ctx.close()


def run_t4_s6(browser: Browser, base_url: str, artifacts_dir: Path) -> dict[str, Any]:
    """T4-S6: 3-Second Quick-Bind Modal Flow & localStorage Persistence."""
    ctx = create_context(browser, 1280, 720)
    try:
        page = ctx.new_page()
        mon = PageErrorMonitor(base_url)
        mon.attach(page)
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        wait_for_debug_hook(page)

        qb_btn = find_visible_control(page, r"quick[- ]?bind|bind|calibrat", ["quickbind", "quick-bind", "bind"], tags=("button",))
        assert qb_btn is not None, "Could not locate Quick-Bind modal button"
        qb_btn.click()
        page.wait_for_timeout(250)

        # Press keys to satisfy Quick-Bind slots (e.g., KeyF, KeyG, KeyJ, KeyK)
        for key in ("KeyF", "KeyG", "KeyJ", "KeyK"):
            page.keyboard.press(key)
            page.wait_for_timeout(200)

        # Wait briefly in case modal saves on final slot or timer
        deadline = time.monotonic() + 4.5
        stored_bindings = None
        while time.monotonic() < deadline:
            stored_bindings = page.evaluate("() => localStorage.getItem('summer_heat_3d_bindings_v2')")
            if stored_bindings:
                break
            page.wait_for_timeout(150)

        assert stored_bindings is not None, "Quick-Bind must persist bindings to summer_heat_3d_bindings_v2"
        parsed = json.loads(stored_bindings)
        assert isinstance(parsed, dict), f"Expected JSON object in summer_heat_3d_bindings_v2, got {type(parsed)}"

        # Close modal cleanly if still open
        close_btn = find_visible_control(page, r"cancel|close|done|×|✕", ["cancel", "close"], tags=("button",))
        if close_btn is not None:
            try:
                close_btn.click()
                page.wait_for_timeout(150)
            except Exception:
                pass

        page.wait_for_timeout(150)
        mon.assert_clean("T4-S6")
        return {"stored_keys": list(parsed.keys())}
    finally:
        ctx.close()


def run_t4_s7(browser: Browser, base_url: str, artifacts_dir: Path) -> dict[str, Any]:
    """T4-S7: [Play Classic 2D] Switcher, 1280x720 + 844x390 Overflow Audit, Cache Integrity & Return."""
    ctx = create_context(browser, 1280, 720)
    try:
        page = ctx.new_page()
        mon = PageErrorMonitor(base_url)
        mon.attach(page)
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        wait_for_debug_hook(page)

        # Wait for SW to activate before navigating
        page.evaluate("() => navigator.serviceWorker ? navigator.serviceWorker.ready : null")
        page.wait_for_timeout(400)

        classic_link = find_visible_control(page, r"classic\s*2d", ["classic"], tags=("a", "button"))
        assert classic_link is not None, "Could not locate [Play Classic 2D] link/button"
        classic_link.click()
        page.wait_for_url(re.compile(r"/classic-2d(?:/|/index\.html)?(?:[?#].*)?$"), timeout=10000)
        page.wait_for_selector("#gameCanvas", timeout=10000)
        page.wait_for_timeout(500)

        assert page.locator("#scoreP1").is_visible(), "#scoreP1 must be visible in Classic 2D"
        assert page.locator("#scoreP2").is_visible(), "#scoreP2 must be visible in Classic 2D"
        assert page.locator("#windLabel").is_visible(), "#windLabel must be visible in Classic 2D"

        # 1280x720 zero-overflow & non-blank check
        dims_1280 = page.evaluate(
            "() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight })"
        )
        assert dims_1280["sw"] <= 1280 and dims_1280["sh"] <= 720, f"Classic 2D overflow at 1280x720: {dims_1280}"

        classic_png = artifacts_dir / "classic_2d_1280x720.png"
        png_bytes = safe_screenshot(page, path=classic_png)
        assert classic_png.exists() and classic_png.stat().st_size > 10_000, "classic_2d_1280x720.png missing or empty"
        stats = analyze_image_bytes(png_bytes)
        assert stats["unique_colors"] > 30 and stats["rgb_std"] > 5.0, f"Classic 2D canvas appears blank: {stats}"

        # 844x390 mobile landscape overflow check on Classic 2D
        page.set_viewport_size({"width": 844, "height": 390})
        page.wait_for_timeout(300)
        dims_844 = page.evaluate(
            "() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight })"
        )
        assert dims_844["sw"] <= 844 and dims_844["sh"] <= 390, f"Classic 2D overflow at 844x390: {dims_844}"

        # Cache storage integrity: summer-heat-3d-v2 intact, NO neon-volley-heavy-gale-v1
        cache_keys = page.evaluate("async () => await caches.keys()")
        assert "neon-volley-heavy-gale-v1" not in cache_keys, f"v1 cache must NOT exist: {cache_keys}"
        assert "summer-heat-3d-v2" in cache_keys, f"summer-heat-3d-v2 cache missing: {cache_keys}"

        # Return to 3D app via #backTo3dLink
        page.set_viewport_size({"width": 1280, "height": 720})
        page.wait_for_timeout(200)
        back_link = page.locator("#backTo3dLink")
        assert back_link.is_visible(), "#backTo3dLink must be visible in Classic 2D"
        back_link.click()
        wait_for_debug_hook(page)

        page.wait_for_timeout(150)
        mon.assert_clean("T4-S7")
        return {"cache_keys": cache_keys, "classic_stats": stats, "screenshot": str(classic_png)}
    finally:
        ctx.close()


def is_portrait_overlay_visible(page: Page) -> bool:
    """Ancestor-aware visibility check for the Portrait Auto-Pause overlay."""
    return bool(
        page.evaluate(
            """() => {
                function isVisibleWithAncestors(el) {
                    let cur = el;
                    while (cur && cur.nodeType === 1) {
                        if (cur.hidden || cur.getAttribute('aria-hidden') === 'true' || cur.hasAttribute('inert')) {
                            return false;
                        }
                        const st = window.getComputedStyle(cur);
                        if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) <= 0.1) {
                            return false;
                        }
                        if (cur === document.body) break;
                        cur = cur.parentElement;
                    }
                    return true;
                }

                const candidates = Array.from(document.querySelectorAll('div, section, aside, dialog'));
                for (const el of candidates) {
                    const text = (el.textContent || '').toLowerCase();
                    if (!/(rotate|landscape|portrait|turn your device|paused)/i.test(text)) continue;
                    if (!isVisibleWithAncestors(el)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width > 100 && r.height > 40) {
                        return true;
                    }
                }
                return false;
            }"""
        )
    )


def run_t4_s8(browser: Browser, base_url: str, artifacts_dir: Path) -> dict[str, Any]:
    """T4-S8: Portrait Auto-Pause Overlay (390x844 -> 844x390)."""
    ctx = create_context(browser, 390, 844)
    try:
        page = ctx.new_page()
        mon = PageErrorMonitor(base_url)
        mon.attach(page)
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        wait_for_debug_hook(page)
        page.wait_for_timeout(350)

        assert page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.isPaused()") is True, (
            "Portrait 390x844 must auto-pause simulation (isPaused() === true)"
        )

        # Verify a visible rotate / portrait overlay is displayed
        assert is_portrait_overlay_visible(page) is True, "Portrait auto-pause overlay must be visible at 390x844"

        portrait_png = artifacts_dir / "portrait_390x844_paused.png"
        safe_screenshot(page, path=portrait_png)
        assert portrait_png.exists() and portrait_png.stat().st_size > 5_000

        # Rotate back to landscape 844x390 -> auto-resumes & hides overlay
        page.set_viewport_size({"width": 844, "height": 390})
        page.wait_for_function(
            "() => window.innerWidth === 844 && window.innerHeight === 390 && window.__SUMMER_HEAT_DEBUG__.isPaused() === false",
            timeout=5000,
        )
        assert page.evaluate("() => window.__SUMMER_HEAT_DEBUG__.isPaused()") is False, (
            "Returning to landscape 844x390 must auto-resume (isPaused() === false)"
        )
        assert is_portrait_overlay_visible(page) is False, (
            "Portrait auto-pause overlay must hide after returning to 844x390"
        )

        # Synthetic visibilitychange check (Wake Lock re-acquisition hygiene)
        page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_timeout(150)

        mon.assert_clean("T4-S8")
        return {"screenshot": str(portrait_png), "portrait_paused": True, "landscape_resumed": True}
    finally:
        ctx.close()


def run_t4_s9(browser: Browser, base_url: str, artifacts_dir: Path) -> dict[str, Any]:
    """T4-S9: SW summer-heat-3d-v2 Cache Completeness, Old v1 Cache Purge & Full Offline Reload."""
    ctx = create_context(browser, 1280, 720)
    try:
        # 1. Seed a dummy v1 cache on a temporary page BEFORE attaching PageErrorMonitor to the app page
        seed_page = ctx.new_page()
        try:
            seed_page.goto(f"{base_url}/manifest.json", wait_until="domcontentloaded")
            seed_page.evaluate(
                """async () => {
                    const c = await caches.open('neon-volley-heavy-gale-v1');
                    await c.put('./manifest.json', new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
                }"""
            )
            seeded_keys = seed_page.evaluate("async () => await caches.keys()")
            assert "neon-volley-heavy-gale-v1" in seeded_keys, "Failed to pre-seed dummy v1 cache"
        finally:
            seed_page.close()

        # 2. Load 3D app with clean monitor and wait for SW registration + activation + clients.claim()
        page = ctx.new_page()
        mon = PageErrorMonitor(base_url)
        mon.attach(page)
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        wait_for_debug_hook(page)

        page.evaluate(
            """async () => {
                const reg = await navigator.serviceWorker.ready;
                if (!reg.active) throw new Error('SW did not activate');
            }"""
        )

        # Wait for controller to take control (or reload once if first-load claim is asynchronous)
        has_controller = page.evaluate("() => Boolean(navigator.serviceWorker.controller)")
        if not has_controller:
            deadline = time.monotonic() + 4.0
            while time.monotonic() < deadline:
                has_controller = page.evaluate("() => Boolean(navigator.serviceWorker.controller)")
                if has_controller:
                    break
                page.wait_for_timeout(100)
        if not has_controller:
            page.reload(wait_until="domcontentloaded")
            wait_for_debug_hook(page)
            has_controller = page.evaluate("() => Boolean(navigator.serviceWorker.controller)")
        assert has_controller, "navigator.serviceWorker.controller must be active before offline test"

        # 3. Verify v1 cache purged & ONLY summer-heat-3d-v2 remains with all 16 assets
        cache_keys = page.evaluate("async () => await caches.keys()")
        assert cache_keys == ["summer-heat-3d-v2"], f"Expected caches.keys() == ['summer-heat-3d-v2'], got {cache_keys}"

        cached_urls: list[str] = page.evaluate(
            """async () => {
                const cache = await caches.open('summer-heat-3d-v2');
                const reqs = await cache.keys();
                return reqs.map(r => r.url);
            }"""
        )
        prefix = base_url.rstrip("/")
        cached_paths = {u[len(prefix):] if u.startswith(prefix) else u for u in cached_urls}

        missing = [p for p in EXPECTED_PRECACHE_PATHS if p not in cached_paths]
        assert len(missing) == 0, f"Missing required pre-cached assets in summer-heat-3d-v2: {missing} (have: {sorted(cached_paths)})"

        # 4. Full offline reload of BOTH 3D app and Classic 2D
        ctx.set_offline(True)
        try:
            page.reload(wait_until="domcontentloaded")
            wait_for_debug_hook(page)
            page.wait_for_timeout(450)
            offline_3d_stats = analyze_image_bytes(safe_screenshot(page))
            assert offline_3d_stats["unique_colors"] > 100 and offline_3d_stats["rgb_std"] > 10.0, (
                f"Offline 3D reload rendered blank frame: {offline_3d_stats}"
            )

            page.goto(f"{base_url}/classic-2d/", wait_until="domcontentloaded")
            page.wait_for_selector("#gameCanvas", timeout=10000)
            page.wait_for_timeout(450)
            offline_2d_stats = analyze_image_bytes(safe_screenshot(page))
            assert offline_2d_stats["unique_colors"] > 30 and offline_2d_stats["rgb_std"] > 5.0, (
                f"Offline Classic 2D reload rendered blank frame: {offline_2d_stats}"
            )
        finally:
            ctx.set_offline(False)

        page.wait_for_timeout(150)
        mon.assert_clean("T4-S9")
        return {
            "cache_keys": cache_keys,
            "cached_asset_count": len(cached_paths),
            "offline_3d_stats": offline_3d_stats,
            "offline_2d_stats": offline_2d_stats,
        }
    finally:
        ctx.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="SUMMER HEAT 3D Tier 4 Browser & Offline Cache E2E Suite (Playwright SwiftShader WebGL2)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("E2E_PORT", "8080")),
        help="Local HTTP server port on 127.0.0.1 (default: $E2E_PORT or 8080)",
    )
    parser.add_argument(
        "--artifacts-dir",
        type=str,
        default="./qa-artifacts",
        help="Output directory for PNG screenshots, .webm recordings, and e2e_summary.json",
    )
    parser.add_argument(
        "--skip-video",
        action="store_true",
        default=False,
        help="Disable .webm video recording (default: False, videos are recorded)",
    )
    parser.add_argument(
        "--scenario",
        type=str,
        default="all",
        help="Scenario filter: 'all' or comma-separated IDs (e.g. T4-S1,T4-S2)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    # Validate --scenario BEFORE creating artifacts_dir or launching server
    raw_scenario = args.scenario.strip()
    if not raw_scenario:
        print(f"ERROR: --scenario must not be empty. Valid: 'all' or {ALL_SCENARIOS}", file=sys.stderr)
        return 2
    if raw_scenario.lower() == "all":
        selected = list(ALL_SCENARIOS)
    else:
        selected = list(dict.fromkeys(s.strip().upper() for s in raw_scenario.split(",") if s.strip()))
        invalid = [s for s in selected if s not in ALL_SCENARIOS]
        if not selected or invalid:
            print(f"ERROR: Unknown or empty --scenario '{args.scenario}'. Valid: {ALL_SCENARIOS}", file=sys.stderr)
            return 2

    # Race-free pre-check for occupied port BEFORE spawning http.server
    if is_port_in_use("127.0.0.1", args.port):
        print(f"ERROR: Port {args.port} on 127.0.0.1 is already in use", file=sys.stderr)
        return 2

    artifacts_dir = Path(args.artifacts_dir).resolve()
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    base_url = f"http://127.0.0.1:{args.port}"
    server_proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(args.port), "--bind", "127.0.0.1"],
        cwd=str(REPO_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    summary: dict[str, Any] = {
        "port": args.port,
        "artifacts_dir": str(artifacts_dir),
        "skip_video": args.skip_video,
        "scenarios": {},
        "passed": 0,
        "failed": 0,
    }

    try:
        wait_for_port("127.0.0.1", args.port, timeout_s=10.0, server_proc=server_proc)
        print(f"[Tier 4] HTTP server ready at {base_url} (artifacts: {artifacts_dir})")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=LAUNCH_ARGS)
            try:
                runners = {
                    "T4-S1": lambda: run_t4_s1(browser, base_url, artifacts_dir),
                    "T4-S2": lambda: run_t4_s2(browser, base_url, artifacts_dir, args.skip_video),
                    "T4-S3": lambda: run_t4_s3(browser, base_url, artifacts_dir, args.skip_video),
                    "T4-S4": lambda: run_t4_s4(browser, base_url, artifacts_dir, args.skip_video),
                    "T4-S5": lambda: run_t4_s5(browser, base_url, artifacts_dir),
                    "T4-S6": lambda: run_t4_s6(browser, base_url, artifacts_dir),
                    "T4-S7": lambda: run_t4_s7(browser, base_url, artifacts_dir),
                    "T4-S8": lambda: run_t4_s8(browser, base_url, artifacts_dir),
                    "T4-S9": lambda: run_t4_s9(browser, base_url, artifacts_dir),
                }

                for sc_id in selected:
                    t0 = time.monotonic()
                    print(f"[Tier 4] Running {sc_id} ...", flush=True)
                    try:
                        details = runners[sc_id]()
                        elapsed = round(time.monotonic() - t0, 2)
                        summary["scenarios"][sc_id] = {"status": "PASS", "elapsed_s": elapsed, "details": details}
                        summary["passed"] += 1
                        print(f"[Tier 4] PASS {sc_id} ({elapsed}s)", flush=True)
                    except Exception as exc:
                        elapsed = round(time.monotonic() - t0, 2)
                        summary["scenarios"][sc_id] = {"status": "FAIL", "elapsed_s": elapsed, "error": str(exc)}
                        summary["failed"] += 1
                        print(f"[Tier 4] FAIL {sc_id} ({elapsed}s): {exc}", file=sys.stderr, flush=True)
            finally:
                browser.close()
    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()
            server_proc.wait(timeout=5)

    # Record produced artifacts after all contexts are closed & videos flushed
    png_files = sorted(str(f) for f in artifacts_dir.glob("*.png"))
    webm_files = sorted(str(f) for f in artifacts_dir.rglob("*.webm"))
    summary["artifacts"] = {"png": png_files, "webm": webm_files}

    summary_path = artifacts_dir / "e2e_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"[Tier 4] Summary written to {summary_path} (passed={summary['passed']}, failed={summary['failed']})")

    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
