/**
 * SUMMER HEAT 3D — Coastal Sunset Stadium Scene, Effects, LED Board & Dual Cameras (F07–F09)
 *
 * Strictly imports ONLY ../vendor/three.module.min.js, ./contracts.js, and ./playerRigs.js.
 * Zero external assets, zero CDNs, zero per-frame Geometry/Material allocations.
 * Supports optional DI (`options.renderer`, `options.createCanvas`) for headless Node 22 testing.
 */

import * as THREE from '../vendor/three.module.min.js';
import {
  BALL_SPEC,
  CAMERA_MODES,
  COURT,
  EVENTS,
  MATCH_FORMATS,
  TRAIL_MODES,
  WIND_PHASES,
  clamp,
} from './contracts.js';
import { createPlayerRig, updatePlayerRig, disposePlayerRig } from './playerRigs.js';

const TRAIL_MAX_POINTS = 28;
const STREAMER_SEGMENTS = 12;
const SHOCKWAVE_POOL_SIZE = 10;
const PARTICLE_POOL_SIZE = 24;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

const TRAIL_PALETTES = Object.freeze({
  [TRAIL_MODES.FLAME]: {
    head: new THREE.Color('#fff5b8'),
    mid: new THREE.Color('#ff6a00'),
    tail: new THREE.Color('#b80f0a'),
    width: 0.21,
  },
  [TRAIL_MODES.CYAN]: {
    head: new THREE.Color('#e0ffff'),
    mid: new THREE.Color('#00f3ff'),
    tail: new THREE.Color('#0055aa'),
    width: 0.17,
  },
  [TRAIL_MODES.LOB]: {
    head: new THREE.Color('#fff4b0'),
    mid: new THREE.Color('#ffba42'),
    tail: new THREE.Color('#e04882'),
    width: 0.16,
  },
  [TRAIL_MODES.NEUTRAL]: {
    head: new THREE.Color('#fff7e6'),
    mid: new THREE.Color('#ffd08a'),
    tail: new THREE.Color('#ff8c42'),
    width: 0.12,
  },
});

const SKY_VERTEX_SHADER = `
varying vec3 vWorldDir;
void main() {
  vWorldDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAGMENT_SHADER = `
uniform vec3 uZenithColor;
uniform vec3 uMidColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunDir;
uniform vec3 uSunGlowColor;
varying vec3 vWorldDir;

void main() {
  vec3 dir = normalize(vWorldDir);
  float h = clamp(dir.y, -0.15, 1.0);

  // Horizon -> mid sunset coral/magenta -> twilight indigo zenith
  float lowBlend = smoothstep(-0.04, 0.22, h);
  float highBlend = smoothstep(0.18, 0.72, h);
  vec3 sky = mix(uHorizonColor, uMidColor, lowBlend);
  sky = mix(sky, uZenithColor, highBlend);

  // Subtle warm sun halo over the -Z ocean horizon
  float sunAmt = max(dot(dir, normalize(uSunDir)), 0.0);
  float glowWide = pow(sunAmt, 6.0) * 0.42;
  float glowCore = pow(sunAmt, 42.0) * 0.78;
  sky += uSunGlowColor * (glowWide + glowCore);

  gl_FragColor = vec4(sky, 1.0);
}
`;

function finiteOr(val, fallback = 0) {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

function defaultCreateCanvas(width, height) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null;
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function createProceduralSandTexture(canvasFactory) {
  const c = canvasFactory(256, 256);
  if (!c || typeof c.getContext !== 'function') return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#e7bd7e';
  ctx.fillRect(0, 0, 256, 256);

  // Subtle warm beach ripple waves & fine sand grain (deterministic PRNG)
  let seed = 1337;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let y = 0; y < 256; y += 8) {
    ctx.fillStyle = y % 16 === 0 ? 'rgba(255, 232, 185, 0.14)' : 'rgba(186, 130, 70, 0.10)';
    ctx.fillRect(0, y, 256, 3);
  }

  for (let i = 0; i < 1600; i++) {
    const x = Math.floor(nextRand() * 256);
    const y = Math.floor(nextRand() * 256);
    const bright = nextRand() > 0.5;
    ctx.fillStyle = bright ? 'rgba(255, 244, 214, 0.24)' : 'rgba(168, 114, 58, 0.20)';
    ctx.fillRect(x, y, 2, 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 10);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createVolleyballTexture(canvasFactory) {
  const c = canvasFactory(256, 128);
  if (!c || typeof c.getContext !== 'function') return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;

  // Vibrant 6-panel summer beach volleyball pattern so spin is unmistakable
  const panelColors = ['#fff8ec', '#ff5a36', '#ffd166', '#fff8ec', '#00c2d1', '#ff7b29'];
  const panelW = 256 / panelColors.length;

  for (let i = 0; i < panelColors.length; i++) {
    ctx.fillStyle = panelColors[i];
    ctx.fillRect(i * panelW, 0, panelW + 1, 128);
  }

  // Stylized equatorial wavy accent stripe + crisp panel seam lines
  ctx.strokeStyle = 'rgba(32, 24, 38, 0.45)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= panelColors.length; i++) {
    const x = i * panelW;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + 10, 42, x - 10, 86, x, 128);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 64);
  ctx.lineTo(256, 64);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createDropShadowTexture(canvasFactory) {
  const c = canvasFactory(128, 128);
  if (!c || typeof c.getContext !== 'function') return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, 128, 128);
  if (typeof ctx.createRadialGradient === 'function') {
    const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 60);
    grad.addColorStop(0, 'rgba(38, 18, 8, 0.88)');
    grad.addColorStop(0.55, 'rgba(38, 18, 8, 0.48)');
    grad.addColorStop(1, 'rgba(38, 18, 8, 0.0)');
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = 'rgba(38, 18, 8, 0.65)';
  }
  ctx.fillRect(0, 0, 128, 128);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createNetMeshTexture(canvasFactory) {
  const c = canvasFactory(256, 64);
  if (!c || typeof c.getContext !== 'function') return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, 256, 64);
  ctx.strokeStyle = 'rgba(255, 250, 240, 0.85)';
  ctx.lineWidth = 2;

  const step = 16;
  for (let x = 0; x <= 256; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 64);
    ctx.stroke();
  }
  for (let y = 0; y <= 64; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 1.5);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildPalmTree(seedOffset, trunkMat, frondMat, coconutMat, palmGeos) {
  const root = new THREE.Group();
  root.name = `palmTree_${seedOffset}`;

  const segments = [];
  let parent = root;
  const segCount = 4;
  const segHeight = 1.45;
  const baseLean = (seedOffset % 2 === 0 ? 1 : -1) * 0.06;

  for (let i = 0; i < segCount; i++) {
    const segGroup = new THREE.Group();
    segGroup.position.set(0, i === 0 ? 0 : segHeight * 0.94, 0);
    segGroup.rotation.z = baseLean * (1 + i * 0.35);
    segGroup.rotation.x = 0.04 * (i + 1);
    parent.add(segGroup);

    const trunkMesh = new THREE.Mesh(palmGeos.trunks[i], trunkMat);
    trunkMesh.position.set(0, segHeight * 0.5, 0);
    trunkMesh.castShadow = true;
    trunkMesh.receiveShadow = false;
    segGroup.add(trunkMesh);

    segments.push({
      group: segGroup,
      baseRotX: segGroup.rotation.x,
      baseRotZ: segGroup.rotation.z,
      weight: (i + 1) / segCount,
    });
    parent = segGroup;
  }

  // Crown + coconuts
  const crown = new THREE.Group();
  crown.position.set(0, segHeight * 0.95, 0);
  parent.add(crown);

  for (let c = 0; c < 3; c++) {
    const ang = (c / 3) * Math.PI * 2 + seedOffset;
    const nut = new THREE.Mesh(palmGeos.coconut, coconutMat);
    nut.position.set(Math.cos(ang) * 0.18, -0.06, Math.sin(ang) * 0.18);
    crown.add(nut);
  }

  // Arching coastal fronds
  const fronds = [];
  const frondCount = 7;
  for (let f = 0; f < frondCount; f++) {
    const yaw = (f / frondCount) * Math.PI * 2 + seedOffset * 0.4;
    const frondPivot = new THREE.Group();
    frondPivot.rotation.y = yaw;
    frondPivot.rotation.x = 0.42 + (f % 2) * 0.18;
    crown.add(frondPivot);

    // Two-piece arched palm leaf
    const leafInner = new THREE.Mesh(palmGeos.leafInner, frondMat);
    leafInner.position.set(0, 0.08, 0.68);
    leafInner.rotation.x = -0.18;
    leafInner.castShadow = true;
    frondPivot.add(leafInner);

    const leafOuter = new THREE.Mesh(palmGeos.leafOuter, frondMat);
    leafOuter.position.set(0, -0.18, 1.72);
    leafOuter.rotation.x = 0.36;
    frondPivot.add(leafOuter);

    fronds.push({
      pivot: frondPivot,
      basePitch: frondPivot.rotation.x,
      yaw,
      phase: seedOffset * 1.7 + f * 0.9,
    });
  }

  return { root, segments, fronds, phase: seedOffset * 1.3 };
}

function buildWindStreamer(anchorX, anchorY, anchorZ) {
  const vertCount = (STREAMER_SEGMENTS + 1) * 2;
  const positions = new Float32Array(vertCount * 3);
  const indices = [];

  for (let i = 0; i < STREAMER_SEGMENTS; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c);
  }

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setIndex(indices);

  const material = new THREE.MeshStandardMaterial({
    color: '#ffd166',
    emissive: new THREE.Color('#ff8c42'),
    emissiveIntensity: 0.35,
    roughness: 0.4,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(anchorX, anchorY, anchorZ);
  mesh.frustumCulled = false;
  mesh.name = `windStreamer_${anchorZ < 0 ? 'far' : 'near'}`;

  return { mesh, geometry, material, posAttr, positions };
}

function updateWindStreamerGeometry(streamer, wx, wy, wz, speed, phase, time) {
  const { positions, posAttr, material } = streamer;
  const horizSpeed = Math.hypot(wx, wz);

  let dirX = 1;
  let dirZ = 0;
  if (horizSpeed > 1e-4) {
    dirX = wx / horizSpeed;
    dirZ = wz / horizSpeed;
  } else {
    dirX = Math.cos(time * 0.4) * 0.7 + 0.3;
    dirZ = Math.sin(time * 0.4) * 0.3;
    const norm = Math.hypot(dirX, dirZ) || 1;
    dirX /= norm;
    dirZ /= norm;
  }

  // Side perpendicular vector for flutter oscillation
  const perpX = -dirZ;
  const perpZ = dirX;

  const taut = clamp(speed / 7.5, 0.12, 1.0, 0.25);
  const length = 1.05 + taut * 0.95;
  const flutterFreq = 7.0 + speed * 2.4 + (phase === WIND_PHASES.GUST ? 8.0 : 0);
  const flutterAmp = 0.05 + taut * 0.14 + (phase === WIND_PHASES.GUST ? 0.08 : 0);
  const droopStrength = (1 - taut) * 0.55;

  for (let i = 0; i <= STREAMER_SEGMENTS; i++) {
    const t = i / STREAMER_SEGMENTS;
    const halfH = 0.14 * (1 - t * 0.72); // tapers to a pennant tip
    const along = t * length;
    const wave = Math.sin(time * flutterFreq - t * 6.8) * flutterAmp * t;
    const vertWave = Math.cos(time * (flutterFreq * 0.72) - t * 5.2) * (flutterAmp * 0.45) * t;
    const droop = -droopStrength * t * t + clamp(wy * 0.04, -0.2, 0.2, 0) * t;

    const cx = dirX * along + perpX * wave;
    const cy = droop + vertWave;
    const cz = dirZ * along + perpZ * wave;

    const idx = i * 6;
    positions[idx] = cx;
    positions[idx + 1] = cy + halfH;
    positions[idx + 2] = cz;

    positions[idx + 3] = cx;
    positions[idx + 4] = cy - halfH;
    positions[idx + 5] = cz;
  }

  posAttr.needsUpdate = true;
  streamer.geometry.computeVertexNormals();

  // Phase color feedback
  if (phase === WIND_PHASES.GUST) {
    const flash = 0.5 + 0.5 * Math.sin(time * 16.0);
    material.color.set(flash > 0.5 ? '#00f3ff' : '#ff3d71');
    material.emissive.set(flash > 0.5 ? '#00c2d1' : '#ff2a6d');
    material.emissiveIntensity = 0.65;
  } else if (phase === WIND_PHASES.WARNING) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 10.0);
    material.color.set('#ff9f1c');
    material.emissive.set('#ff5500');
    material.emissiveIntensity = 0.35 + pulse * 0.45;
  } else {
    material.color.set('#ffd166');
    material.emissive.set('#ff8c42');
    material.emissiveIntensity = 0.28;
  }
}

function normalizeScoreboard(snapshot) {
  const sb = snapshot.scoreboard && typeof snapshot.scoreboard === 'object' ? snapshot.scoreboard : {};
  const players = Array.isArray(snapshot.players) ? snapshot.players : [];
  const wind = snapshot.wind && typeof snapshot.wind === 'object' ? snapshot.wind : {};

  let p1HeatFallback = 0;
  let p2HeatFallback = 0;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p) continue;
    if (p.team === 1) p1HeatFallback = Math.max(p1HeatFallback, finiteOr(p.heatMeter, 0));
    if (p.team === 2) p2HeatFallback = Math.max(p2HeatFallback, finiteOr(p.heatMeter, 0));
  }

  const scoreT1 = Math.max(
    0,
    Math.floor(
      finiteOr(
        sb.scoreT1 ?? sb.team1Score ?? sb.p1Score ?? sb.score1 ?? snapshot.score?.t1 ?? snapshot.score?.[0],
        0,
      ),
    ),
  );
  const scoreT2 = Math.max(
    0,
    Math.floor(
      finiteOr(
        sb.scoreT2 ?? sb.team2Score ?? sb.p2Score ?? sb.score2 ?? snapshot.score?.t2 ?? snapshot.score?.[1],
        0,
      ),
    ),
  );
  const servingTeam = (sb.servingTeam ?? snapshot.servingTeam) === 2 ? 2 : 1;
  const heatT1 = clamp(sb.heatT1 ?? sb.heat1 ?? p1HeatFallback, 0, 1, 0);
  const heatT2 = clamp(sb.heatT2 ?? sb.heat2 ?? p2HeatFallback, 0, 1, 0);
  const touchCount = clamp(sb.touchCount ?? sb.touches ?? snapshot.rallyTouches, 0, 3, 0);
  const activeTeam = (sb.activeTeam ?? snapshot.activeTeam) === 2 ? 2 : 1;
  const windPhase = typeof (sb.windPhase ?? wind.phase) === 'string'
    ? (sb.windPhase ?? wind.phase)
    : WIND_PHASES.BREEZE;
  const windSpeedMs = Math.max(0, finiteOr(sb.windSpeedMs ?? sb.windSpeed ?? wind.speed, 0));

  let bannerText = '';
  if (typeof sb.bannerText === 'string') {
    bannerText = sb.bannerText;
  } else if (typeof snapshot.banner === 'string') {
    bannerText = snapshot.banner;
  } else if (snapshot.banner && typeof snapshot.banner.text === 'string') {
    bannerText = snapshot.banner.text;
  } else if (snapshot.matchOver && snapshot.winner) {
    bannerText = `TEAM ${snapshot.winner} WINS!`;
  }

  const bannerColor = typeof (sb.bannerColor ?? snapshot.banner?.color) === 'string'
    ? (sb.bannerColor ?? snapshot.banner?.color)
    : '#ffb703';
  const format = typeof (sb.format ?? snapshot.format) === 'string'
    ? (sb.format ?? snapshot.format)
    : (players.length > 2 ? MATCH_FORMATS.TWO_V_TWO : MATCH_FORMATS.ONE_V_ONE);
  const aiStyle = typeof (sb.aiStyle ?? snapshot.aiStyle) === 'string'
    ? (sb.aiStyle ?? snapshot.aiStyle)
    : '';

  return {
    scoreT1,
    scoreT2,
    servingTeam,
    heatT1,
    heatT2,
    touchCount: Math.round(touchCount),
    activeTeam,
    windPhase,
    windSpeedMs,
    bannerText,
    bannerColor,
    format,
    aiStyle,
  };
}

function drawLedScoreboard(ctx, state) {
  const W = 512;
  const H = 256;

  // Deep coastal night LED backing
  ctx.fillStyle = '#0e0a24';
  ctx.fillRect(0, 0, W, H);

  // Subtle LED pixel scanline sheen
  ctx.fillStyle = 'rgba(255, 160, 80, 0.06)';
  for (let y = 0; y < H; y += 8) {
    ctx.fillRect(0, y, W, 2);
  }

  // Outer glowing border
  ctx.strokeStyle = '#ff7b3b';
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, W - 8, H - 8);

  // Top Header Bar
  ctx.fillStyle = '#1d1340';
  ctx.fillRect(8, 8, W - 16, 36);

  ctx.fillStyle = '#ffd166';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('SUMMER HEAT 3D', 18, 27);

  // Format + AI badge
  const rightMeta = state.aiStyle
    ? `${state.format.toUpperCase()}  •  ${state.aiStyle.replace(/_/g, ' ')}`
    : state.format.toUpperCase();
  ctx.fillStyle = '#8be9fd';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(rightMeta, W - 18, 27);

  // Team 1 Score Box (Left — Sunset Coral)
  ctx.fillStyle = 'rgba(255, 90, 54, 0.16)';
  ctx.fillRect(16, 52, 165, 108);
  ctx.strokeStyle = '#ff5a36';
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 52, 165, 108);

  ctx.fillStyle = '#ff8b66';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(state.servingTeam === 1 ? '● TEAM 1 SERVE' : 'TEAM 1', 98, 70);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText(String(state.scoreT1), 98, 122);

  // Team 2 Score Box (Right — Ocean Cyan)
  ctx.fillStyle = 'rgba(0, 194, 209, 0.16)';
  ctx.fillRect(W - 181, 52, 165, 108);
  ctx.strokeStyle = '#00c2d1';
  ctx.lineWidth = 2;
  ctx.strokeRect(W - 181, 52, 165, 108);

  ctx.fillStyle = '#70f3ff';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(state.servingTeam === 2 ? '● TEAM 2 SERVE' : 'TEAM 2', W - 98, 70);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText(String(state.scoreT2), W - 98, 122);

  // Center Touch Counter + Wind Status
  ctx.fillStyle = '#ffd166';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`TOUCHES (T${state.activeTeam})`, W / 2, 68);

  for (let i = 0; i < 3; i++) {
    const cx = W / 2 + (i - 1) * 32;
    const lit = i < state.touchCount;
    ctx.beginPath();
    ctx.arc(cx, 94, 10, 0, Math.PI * 2);
    ctx.fillStyle = lit
      ? (state.activeTeam === 1 ? '#ff7b3b' : '#00f3ff')
      : '#261e47';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Wind indicator pill
  const isGust = state.windPhase === WIND_PHASES.GUST;
  const isWarn = state.windPhase === WIND_PHASES.WARNING;
  ctx.fillStyle = isGust ? '#b8144a' : isWarn ? '#b85d00' : '#1b3556';
  ctx.fillRect(194, 118, 124, 42);
  ctx.strokeStyle = isGust ? '#00f3ff' : isWarn ? '#ffd166' : '#58a6ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(194, 118, 124, 42);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText(isGust ? 'HEAVY GALE' : isWarn ? 'GALE WARN' : 'BREEZE', W / 2, 132);
  ctx.fillStyle = '#ffd166';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText(`${state.windSpeedMs.toFixed(1)} m/s`, W / 2, 150);

  // Heat Meters (Bottom row)
  const drawHeatBar = (x, y, w, h, ratio, label, baseColor) => {
    ctx.fillStyle = '#1b1636';
    ctx.fillRect(x, y, w, h);
    const fillW = Math.round(w * clamp(ratio, 0, 1, 0));
    const full = ratio >= 0.99;
    ctx.fillStyle = full ? '#ffe066' : baseColor;
    ctx.fillRect(x, y, fillW, h);
    ctx.strokeStyle = full ? '#ffffff' : '#6c6391';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = full ? '#140c24' : '#ffffff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    const pct = Math.round(ratio * 100);
    ctx.fillText(full ? `${label} MAX HEAT!` : `${label} ${pct}%`, x + w / 2, y + h / 2 + 1);
  };

  drawHeatBar(16, 174, 232, 26, state.heatT1, 'T1 HEAT', '#ff5a36');
  drawHeatBar(W - 248, 174, 232, 26, state.heatT2, 'T2 HEAT', '#00c2d1');

  // Bottom Dynamic Banner Strip
  ctx.fillStyle = state.bannerText ? '#27143f' : '#130e2b';
  ctx.fillRect(16, 210, W - 32, 34);
  if (state.bannerText) {
    ctx.strokeStyle = state.bannerColor || '#ffd166';
    ctx.lineWidth = 2;
    ctx.strokeRect(16, 210, W - 32, 34);
    ctx.fillStyle = state.bannerColor || '#ffd166';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(state.bannerText.slice(0, 32), W / 2, 228);
  } else {
    ctx.fillStyle = 'rgba(255, 224, 166, 0.65)';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BUMP  •  SET  •  HEAT SPIKE', W / 2, 228);
  }
}

/**
 * Create the complete SUMMER HEAT 3D coastal sunset Three.js scene controller.
 *
 * @param {HTMLCanvasElement|null} canvas
 * @param {{ renderer?: object, createCanvas?: Function, width?: number, height?: number }} [options]
 * @returns {{ syncState: Function, render: Function, resize: Function, triggerCameraPunch: Function, dispose: Function }}
 */
export function createCourtScene(canvas, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const canvasFactory = typeof opts.createCanvas === 'function' ? opts.createCanvas : defaultCreateCanvas;

  let viewWidth = clamp(
    opts.width ?? canvas?.clientWidth ?? canvas?.width ?? DEFAULT_WIDTH,
    1,
    8192,
    DEFAULT_WIDTH,
  );
  let viewHeight = clamp(
    opts.height ?? canvas?.clientHeight ?? canvas?.height ?? DEFAULT_HEIGHT,
    1,
    8192,
    DEFAULT_HEIGHT,
  );

  // Renderer initialization (supports DI mock renderer for Node 22 unit tests)
  const renderer =
    opts.renderer ||
    new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });

  const dpr =
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? window.devicePixelRatio
      : 1;
  if (typeof renderer.setPixelRatio === 'function') {
    renderer.setPixelRatio(Math.min(Math.max(1, dpr), 2));
  }
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (typeof renderer.setClearColor === 'function') {
    renderer.setClearColor(0x140d2e, 1);
  }
  if (typeof renderer.setSize === 'function') {
    renderer.setSize(viewWidth, viewHeight, false);
  }

  // Scene + coastal sunset atmosphere
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1a1236');
  scene.fog = new THREE.FogExp2('#d9785f', 0.0075);

  const ownedTextures = [];
  const trackTex = (tex) => {
    if (tex) ownedTextures.push(tex);
    return tex;
  };

  // --- Sunset Sky Dome & Glowing Sun ---
  const sunDir = new THREE.Vector3(0.0, 0.16, -0.987).normalize();
  const skyGeo = new THREE.SphereGeometry(145, 28, 18);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    uniforms: {
      uZenithColor: { value: new THREE.Color('#191246') },
      uMidColor: { value: new THREE.Color('#c84b6b') },
      uHorizonColor: { value: new THREE.Color('#ff9d47') },
      uSunDir: { value: sunDir.clone() },
      uSunGlowColor: { value: new THREE.Color('#ffe08c') },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  skyDome.name = 'sunsetSkyDome';
  scene.add(skyDome);

  // Glowing sunset sun orb over -Z ocean
  const sunGroup = new THREE.Group();
  sunGroup.position.set(0, 14.5, -96);
  scene.add(sunGroup);

  const sunOrb = new THREE.Mesh(
    new THREE.CircleGeometry(8.8, 32),
    new THREE.MeshBasicMaterial({ color: '#fff1b8', fog: false }),
  );
  sunOrb.name = 'sunsetSunOrb';
  sunGroup.add(sunOrb);

  const sunHalo = new THREE.Mesh(
    new THREE.CircleGeometry(15.5, 32),
    new THREE.MeshBasicMaterial({
      color: '#ff8a3d',
      transparent: true,
      opacity: 0.36,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  sunHalo.position.z = -0.2;
  sunGroup.add(sunHalo);

  // --- Golden-Hour Coastal Lighting (SwiftShader-friendly 1024x1024 PCFSoftShadowMap) ---
  const hemiLight = new THREE.HemisphereLight('#ffc194', '#c9935b', 0.98);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight('#ffd8a6', 2.25);
  sunLight.position.set(10, 17, -15);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.left = -14;
  sunLight.shadow.camera.right = 14;
  sunLight.shadow.camera.top = 12;
  sunLight.shadow.camera.bottom = -12;
  sunLight.shadow.camera.near = 2;
  sunLight.shadow.camera.far = 52;
  sunLight.shadow.bias = -0.0008;
  sunLight.shadow.normalBias = 0.03;
  scene.add(sunLight);

  const frontFillLight = new THREE.DirectionalLight('#7ee4ff', 0.62);
  frontFillLight.position.set(-7, 9, 15);
  scene.add(frontFillLight);

  // --- Golden Sand Beach (Y = 0) & Court Markings (16m x 8m) ---
  const sandTexture = trackTex(createProceduralSandTexture(canvasFactory));
  const sandMat = new THREE.MeshStandardMaterial({
    color: '#ecc282',
    map: sandTexture,
    roughness: 0.92,
    metalness: 0.02,
  });
  const sandMesh = new THREE.Mesh(new THREE.PlaneGeometry(110, 52), sandMat);
  sandMesh.rotation.x = -Math.PI / 2;
  sandMesh.position.set(0, COURT.SAND_Y, 15);
  sandMesh.receiveShadow = true;
  sandMesh.name = 'beachSand';
  scene.add(sandMesh);

  // Subtle coastal boardwalk edge separating beach sand from ocean surf
  const boardwalkMat = new THREE.MeshStandardMaterial({
    color: '#8f5d38',
    roughness: 0.85,
    metalness: 0.05,
  });
  const boardwalk = new THREE.Mesh(new THREE.BoxGeometry(56, 0.14, 0.8), boardwalkMat);
  boardwalk.position.set(0, 0.04, -10.2);
  boardwalk.receiveShadow = true;
  scene.add(boardwalk);

  // Court boundary lines: X in [-8, +8], Z in [-4, +4]
  const courtLinesGroup = new THREE.Group();
  courtLinesGroup.name = 'courtMarkings';
  scene.add(courtLinesGroup);

  const lineMat = new THREE.MeshBasicMaterial({ color: '#fff8ec' });
  const coralAccentMat = new THREE.MeshBasicMaterial({ color: '#ff6b4a' });
  const lineY = 0.012;
  const lineW = 0.12;

  const addFlatRect = (w, d, x, z, mat = lineMat) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, lineY, z);
    courtLinesGroup.add(m);
  };

  // Outer perimeter lines
  addFlatRect(COURT.LENGTH + lineW, lineW, 0, COURT.HALF_WIDTH);
  addFlatRect(COURT.LENGTH + lineW, lineW, 0, -COURT.HALF_WIDTH);
  addFlatRect(lineW, COURT.WIDTH + lineW, -COURT.HALF_LENGTH, 0);
  addFlatRect(lineW, COURT.WIDTH + lineW, COURT.HALF_LENGTH, 0);
  // Center line under net
  addFlatRect(0.08, COURT.WIDTH, 0, 0, coralAccentMat);
  // Subtle 3m attack-zone reference lines
  addFlatRect(0.05, COURT.WIDTH, -3.0, 0, coralAccentMat);
  addFlatRect(0.05, COURT.WIDTH, 3.0, 0, coralAccentMat);

  // --- Animated Ocean Plane beyond -Z ---
  const oceanGeo = new THREE.PlaneGeometry(220, 110, 44, 22);
  oceanGeo.rotateX(-Math.PI / 2);
  const oceanPosAttr = oceanGeo.attributes.position;
  oceanPosAttr.setUsage(THREE.DynamicDrawUsage);
  const oceanNormAttr = oceanGeo.attributes.normal;
  oceanNormAttr.setUsage(THREE.DynamicDrawUsage);
  const oceanVertCount = oceanPosAttr.count;
  const oceanBaseX = new Float32Array(oceanVertCount);
  const oceanBaseZ = new Float32Array(oceanVertCount);
  for (let i = 0; i < oceanVertCount; i++) {
    oceanBaseX[i] = oceanPosAttr.getX(i);
    oceanBaseZ[i] = oceanPosAttr.getZ(i);
  }

  const oceanMat = new THREE.MeshStandardMaterial({
    color: '#0e5c78',
    emissive: new THREE.Color('#3b1f2b'),
    emissiveIntensity: 0.35,
    roughness: 0.22,
    metalness: 0.42,
  });
  const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
  oceanMesh.position.set(0, -0.32, -65.5);
  oceanMesh.name = 'animatedOcean';
  scene.add(oceanMesh);

  // Golden sun shimmer reflection path across the -Z ocean
  const sunShimmerMat = new THREE.MeshBasicMaterial({
    color: '#ffb75e',
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sunShimmer = new THREE.Mesh(new THREE.PlaneGeometry(14, 76), sunShimmerMat);
  sunShimmer.rotation.x = -Math.PI / 2;
  sunShimmer.position.set(0, -0.02, -52);
  scene.add(sunShimmer);

  // Shoreline surf foam band
  const foamMat = new THREE.MeshBasicMaterial({
    color: '#ffe9d6',
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
  });
  const foamStrip = new THREE.Mesh(new THREE.PlaneGeometry(110, 1.8), foamMat);
  foamStrip.rotation.x = -Math.PI / 2;
  foamStrip.position.set(0, 0.015, -11.4);
  scene.add(foamStrip);

  // --- Swaying Coastal Palm Trees (clear of Broadcast + Split camera sightlines) ---
  const palmTrunkMat = new THREE.MeshStandardMaterial({ color: '#7a5236', roughness: 0.88 });
  const palmFrondMat = new THREE.MeshStandardMaterial({
    color: '#2c8c57',
    emissive: new THREE.Color('#133b25'),
    emissiveIntensity: 0.12,
    roughness: 0.65,
  });
  const palmCoconutMat = new THREE.MeshStandardMaterial({ color: '#59371e', roughness: 0.8 });

  const palmGeos = {
    trunks: [0, 1, 2, 3].map((i) => new THREE.CylinderGeometry(0.20 - i * 0.032, 0.24 - i * 0.032, 1.45, 8)),
    coconut: new THREE.SphereGeometry(0.14, 8, 6),
    leafInner: new THREE.BoxGeometry(0.46, 0.04, 1.35),
    leafOuter: new THREE.BoxGeometry(0.32, 0.035, 1.15),
  };

  const palmPlacements = [
    { x: -10.8, z: -11.2, s: 1.05 },
    { x: 10.8, z: -11.2, s: 1.02 },
    { x: -16.2, z: -12.6, s: 1.18 },
    { x: 16.2, z: -12.6, s: 1.15 },
    { x: -19.5, z: -7.5, s: 0.96 },
    { x: 19.5, z: -7.5, s: 0.98 },
  ];
  const palms = [];
  for (let i = 0; i < palmPlacements.length; i++) {
    const p = palmPlacements[i];
    const palm = buildPalmTree(i + 1, palmTrunkMat, palmFrondMat, palmCoconutMat, palmGeos);
    palm.root.position.set(p.x, 0, p.z);
    palm.root.scale.setScalar(p.s);
    scene.add(palm.root);
    palms.push(palm);
  }

  // --- Glowing Translucent Outer Arcade Walls (X = +-11.5, Z = +-6.5, Y = 14.0) ---
  const wallsGroup = new THREE.Group();
  wallsGroup.name = 'outerArcadeWalls';
  scene.add(wallsGroup);

  const railMat = new THREE.MeshBasicMaterial({
    color: '#ff8a4c',
    transparent: true,
    opacity: 0.62,
  });
  const cyanRailMat = new THREE.MeshBasicMaterial({
    color: '#00e5ff',
    transparent: true,
    opacity: 0.55,
  });

  const ax = COURT.ARENA_HALF_X;
  const az = COURT.ARENA_HALF_Z;
  const cy = COURT.CEILING_Y;

  // Vertical corner pillars
  const cornerCoords = [
    [-ax, -az],
    [ax, -az],
    [-ax, az],
    [ax, az],
  ];
  const pillarGeo = new THREE.CylinderGeometry(0.06, 0.06, cy, 8);
  for (let i = 0; i < cornerCoords.length; i++) {
    const [cx, cz] = cornerCoords[i];
    const pillar = new THREE.Mesh(pillarGeo, cx < 0 ? railMat : cyanRailMat);
    pillar.position.set(cx, cy * 0.5, cz);
    wallsGroup.add(pillar);
  }

  // Horizontal perimeter boundary energy rails (low + ceiling framing)
  const addRail = (len, x, y, z, rotY, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.065, 0.065), mat);
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    wallsGroup.add(m);
  };
  const railHeights = [0.22, cy];
  for (let i = 0; i < railHeights.length; i++) {
    const ry = railHeights[i];
    addRail(ax * 2, 0, ry, -az, 0, railMat);
    addRail(ax * 2, 0, ry, az, 0, railMat);
    addRail(az * 2, -ax, ry, 0, Math.PI / 2, railMat);
    addRail(az * 2, ax, ry, 0, Math.PI / 2, cyanRailMat);
  }

  // Translucent reactive bounce panels
  const makeWallPanel = (w, h, x, y, z, rotX, rotY, baseColor, baseOpacity) => {
    const mat = new THREE.MeshBasicMaterial({
      color: baseColor,
      transparent: true,
      opacity: baseOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rotX, rotY, 0);
    wallsGroup.add(mesh);
    return { mesh, mat, baseOpacity, flash: 0 };
  };

  const wallPanels = Object.assign(Object.create(null), {
    left: makeWallPanel(az * 2, cy, -ax, cy * 0.5, 0, 0, Math.PI / 2, '#ff6a3d', 0.055),
    right: makeWallPanel(az * 2, cy, ax, cy * 0.5, 0, 0, -Math.PI / 2, '#00d9f5', 0.055),
    far: makeWallPanel(ax * 2, cy, 0, cy * 0.5, -az, 0, 0, '#ff9f43', 0.04),
    near: makeWallPanel(ax * 2, cy, 0, cy * 0.5, az, 0, Math.PI, '#ff9f43', 0.015),
    ceiling: makeWallPanel(ax * 2, az * 2, 0, cy, 0, Math.PI / 2, 0, '#ffd166', 0.02),
  });

  // --- Volleyball Net (X = 0, Z in [-4.5, +4.5], Height = 2.38m) ---
  const netGroup = new THREE.Group();
  netGroup.name = 'volleyballNet';
  scene.add(netGroup);

  const postMat = new THREE.MeshStandardMaterial({
    color: '#e85d3f',
    roughness: 0.35,
    metalness: 0.55,
  });
  const postHeight = COURT.NET_HEIGHT + 0.28;
  const postGeo = new THREE.CylinderGeometry(
    COURT.NET_POST_RADIUS,
    COURT.NET_POST_RADIUS,
    postHeight,
    14,
  );

  const farPost = new THREE.Mesh(postGeo, postMat);
  farPost.position.set(COURT.NET_X, postHeight * 0.5, -COURT.NET_HALF_Z);
  farPost.castShadow = true;
  netGroup.add(farPost);

  const nearPost = new THREE.Mesh(postGeo, postMat);
  nearPost.position.set(COURT.NET_X, postHeight * 0.5, COURT.NET_HALF_Z);
  nearPost.castShadow = true;
  netGroup.add(nearPost);

  // Volleyball antennae at Z = +-4.0
  const antennaMat = new THREE.MeshStandardMaterial({ color: '#ff3b30', roughness: 0.4 });
  const antennaGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.72, 8);
  const farAntenna = new THREE.Mesh(antennaGeo, antennaMat);
  farAntenna.position.set(COURT.NET_X, COURT.NET_HEIGHT + 0.32, -COURT.HALF_WIDTH);
  netGroup.add(farAntenna);
  const nearAntenna = new THREE.Mesh(antennaGeo, antennaMat);
  nearAntenna.position.set(COURT.NET_X, COURT.NET_HEIGHT + 0.32, COURT.HALF_WIDTH);
  netGroup.add(nearAntenna);

  // Rounded top tape (top surface aligns with NET_HEIGHT = 2.38m)
  const topTapeMat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    emissive: new THREE.Color('#ffd166'),
    emissiveIntensity: 0.08,
    roughness: 0.38,
  });
  const topTape = new THREE.Mesh(
    new THREE.CylinderGeometry(
      COURT.NET_TAPE_RADIUS,
      COURT.NET_TAPE_RADIUS,
      COURT.NET_HALF_Z * 2,
      14,
    ),
    topTapeMat,
  );
  topTape.rotation.x = Math.PI / 2;
  topTape.position.set(COURT.NET_X, COURT.NET_HEIGHT - COURT.NET_TAPE_RADIUS, 0);
  topTape.castShadow = true;
  netGroup.add(topTape);

  // Bottom tape band
  const bottomTape = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, COURT.NET_HALF_Z * 2, 10),
    topTapeMat,
  );
  bottomTape.rotation.x = Math.PI / 2;
  bottomTape.position.set(COURT.NET_X, 1.24, 0);
  netGroup.add(bottomTape);

  // Net mesh grid
  const netTexture = trackTex(createNetMeshTexture(canvasFactory));
  const netMeshMat = new THREE.MeshStandardMaterial({
    color: '#fff8ee',
    map: netTexture,
    transparent: true,
    opacity: netTexture ? 0.88 : 0.42,
    wireframe: !netTexture,
    side: THREE.DoubleSide,
    roughness: 0.6,
  });
  const netMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.NET_HALF_Z * 2, 1.06, 12, 4),
    netMeshMat,
  );
  netMesh.rotation.y = Math.PI / 2;
  netMesh.position.set(COURT.NET_X, 1.79, 0);
  netGroup.add(netMesh);

  let netFlashTimer = 0;

  // --- Net-Post Cloth Wind Streamers (F08) ---
  const farStreamer = buildWindStreamer(COURT.NET_X, postHeight, -COURT.NET_HALF_Z);
  const nearStreamer = buildWindStreamer(COURT.NET_X, postHeight, COURT.NET_HALF_Z);
  scene.add(farStreamer.mesh);
  scene.add(nearStreamer.mesh);

  // --- 3D Textured Beach Volleyball + Crisp Sand Drop-Shadow (F08) ---
  const ballTexture = trackTex(createVolleyballTexture(canvasFactory));
  const ballMat = new THREE.MeshStandardMaterial({
    color: ballTexture ? '#ffffff' : '#ffd166',
    map: ballTexture,
    roughness: 0.38,
    metalness: 0.04,
  });
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_SPEC.RADIUS, 24, 18), ballMat);
  ballMesh.castShadow = true;
  ballMesh.receiveShadow = false;
  ballMesh.position.set(-4, 2.0, 0);
  ballMesh.name = 'beachVolleyball';
  scene.add(ballMesh);

  const dropShadowTex = trackTex(createDropShadowTexture(canvasFactory));
  const dropShadowMat = new THREE.MeshBasicMaterial({
    color: dropShadowTex ? '#ffffff' : '#241208',
    map: dropShadowTex,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
  });
  const dropShadowMesh = new THREE.Mesh(
    new THREE.CircleGeometry(BALL_SPEC.RADIUS * 1.65, 24),
    dropShadowMat,
  );
  dropShadowMesh.rotation.x = -Math.PI / 2;
  dropShadowMesh.position.set(-4, 0.016, 0);
  dropShadowMesh.name = 'ballDropShadow';
  scene.add(dropShadowMesh);

  // --- Pulsing 3D Landing Reticle at predictLandingPoint3D (F08) ---
  const reticleGroup = new THREE.Group();
  reticleGroup.position.set(0, 0.024, 0);
  reticleGroup.visible = false;
  reticleGroup.name = 'landingReticle';
  scene.add(reticleGroup);

  const reticleOuterMat = new THREE.MeshBasicMaterial({
    color: '#00f3ff',
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const reticleOuter = new THREE.Mesh(new THREE.RingGeometry(0.48, 0.60, 32), reticleOuterMat);
  reticleOuter.rotation.x = -Math.PI / 2;
  reticleGroup.add(reticleOuter);

  const reticleInnerMat = new THREE.MeshBasicMaterial({
    color: '#ffd166',
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const reticleInner = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.24, 24), reticleInnerMat);
  reticleInner.rotation.x = -Math.PI / 2;
  reticleGroup.add(reticleInner);

  const tickGeo = new THREE.PlaneGeometry(0.24, 0.055);
  for (let i = 0; i < 4; i++) {
    const tick = new THREE.Mesh(tickGeo, reticleOuterMat);
    const angle = (i * Math.PI) / 2;
    tick.rotation.x = -Math.PI / 2;
    tick.rotation.z = angle;
    tick.position.set(Math.cos(angle) * 0.72, 0.002, Math.sin(angle) * 0.72);
    reticleGroup.add(tick);
  }

  // --- Shrinking 3D Timing Ring at Set Apex (F08) ---
  const timingRingGroup = new THREE.Group();
  timingRingGroup.visible = false;
  timingRingGroup.name = 'timingRing3D';
  scene.add(timingRingGroup);

  const timingTargetMat = new THREE.MeshBasicMaterial({
    color: '#ffd166',
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const timingTargetHalo = new THREE.Mesh(
    new THREE.TorusGeometry(0.56, 0.032, 10, 36),
    timingTargetMat,
  );
  timingRingGroup.add(timingTargetHalo);

  const timingShrinkMat = new THREE.MeshBasicMaterial({
    color: '#00f3ff',
    transparent: true,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const timingShrinkHalo = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.042, 10, 36),
    timingShrinkMat,
  );
  timingRingGroup.add(timingShrinkHalo);

  // --- Pre-Allocated 3D Ball Spin Ribbon Trail (F08 — ZERO per-frame allocations) ---
  const trailPositions = new Float32Array(TRAIL_MAX_POINTS * 2 * 3);
  const trailColors = new Float32Array(TRAIL_MAX_POINTS * 2 * 3);
  const trailIndices = [];
  for (let i = 0; i < TRAIL_MAX_POINTS - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    trailIndices.push(a, b, c, b, d, c);
  }
  const trailGeo = new THREE.BufferGeometry();
  const trailPosAttr = new THREE.BufferAttribute(trailPositions, 3);
  trailPosAttr.setUsage(THREE.DynamicDrawUsage);
  const trailColAttr = new THREE.BufferAttribute(trailColors, 3);
  trailColAttr.setUsage(THREE.DynamicDrawUsage);
  trailGeo.setAttribute('position', trailPosAttr);
  trailGeo.setAttribute('color', trailColAttr);
  trailGeo.setIndex(trailIndices);
  trailGeo.setDrawRange(0, 0);

  const trailMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const trailMesh = new THREE.Mesh(trailGeo, trailMat);
  trailMesh.frustumCulled = false;
  trailMesh.name = 'ballSpinRibbon';
  scene.add(trailMesh);

  // Pre-allocated sample ring buffer for ball trail
  const trailSamples = [];
  for (let i = 0; i < TRAIL_MAX_POINTS; i++) {
    trailSamples.push(new THREE.Vector3());
  }
  let trailCount = 0;

  // --- Diegetic 3D Stadium LED Scoreboard (F09) ---
  const ledGroup = new THREE.Group();
  ledGroup.position.set(0, 5.15, -9.2);
  ledGroup.rotation.x = 0.11;
  ledGroup.name = 'stadiumLedScoreboard';
  scene.add(ledGroup);

  const gantryMat = new THREE.MeshStandardMaterial({
    color: '#1b182e',
    roughness: 0.45,
    metalness: 0.72,
  });
  const bezelMesh = new THREE.Mesh(new THREE.BoxGeometry(6.6, 2.55, 0.34), gantryMat);
  bezelMesh.castShadow = true;
  ledGroup.add(bezelMesh);

  const bezelRimMat = new THREE.MeshBasicMaterial({ color: '#ff7b3b' });
  const bezelRimTop = new THREE.Mesh(new THREE.BoxGeometry(6.72, 0.08, 0.38), bezelRimMat);
  bezelRimTop.position.set(0, 1.29, 0);
  ledGroup.add(bezelRimTop);
  const bezelRimBot = new THREE.Mesh(new THREE.BoxGeometry(6.72, 0.08, 0.38), bezelRimMat);
  bezelRimBot.position.set(0, -1.29, 0);
  ledGroup.add(bezelRimBot);

  // Support truss pillars down to the beach
  const legGeo = new THREE.CylinderGeometry(0.14, 0.17, 5.3, 10);
  const leftLeg = new THREE.Mesh(legGeo, gantryMat);
  leftLeg.position.set(-2.9, -2.65, -0.05);
  ledGroup.add(leftLeg);
  const rightLeg = new THREE.Mesh(legGeo, gantryMat);
  rightLeg.position.set(2.9, -2.65, -0.05);
  ledGroup.add(rightLeg);

  const ledCanvas = canvasFactory(512, 256);
  const ledCtx = ledCanvas && typeof ledCanvas.getContext === 'function' ? ledCanvas.getContext('2d') : null;
  let ledTexture = null;
  if (ledCanvas) {
    ledTexture = trackTex(new THREE.CanvasTexture(ledCanvas));
    ledTexture.colorSpace = THREE.SRGBColorSpace;
  }
  const ledScreenMat = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    map: ledTexture,
  });
  const ledScreen = new THREE.Mesh(new THREE.PlaneGeometry(6.24, 2.22), ledScreenMat);
  ledScreen.position.set(0, 0, 0.185);
  ledScreen.name = 'ledScoreboardScreen';
  ledGroup.add(ledScreen);

  let lastLedSignature = '';

  // Initial scoreboard draw
  if (ledCtx) {
    const initSb = normalizeScoreboard({});
    drawLedScoreboard(ledCtx, initSb);
    if (ledTexture) ledTexture.needsUpdate = true;
  }

  // --- Pre-Allocated 4-Slot Player Rig Pool (1v1 <-> 2v2 with ZERO runtime allocations) ---
  const rigPool = [
    createPlayerRig({ id: 'slot_t1_primary', team: 1, role: 'PRIMARY' }),
    createPlayerRig({ id: 'slot_t1_partner', team: 1, role: 'PARTNER' }),
    createPlayerRig({ id: 'slot_t2_primary', team: 2, role: 'PRIMARY' }),
    createPlayerRig({ id: 'slot_t2_partner', team: 2, role: 'PARTNER' }),
  ];
  for (let i = 0; i < rigPool.length; i++) {
    rigPool[i].root.visible = false;
    scene.add(rigPool[i].root);
  }
  const rigSlotUsed = [false, false, false, false];

  // --- Pre-Allocated Impact FX Pools (Shockwave Rings & Sand/Spark Bursts) ---
  const shockwaveGeo = new THREE.RingGeometry(0.18, 0.34, 24);
  const shockwavePool = [];
  for (let i = 0; i < SHOCKWAVE_POOL_SIZE; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: '#ffd166',
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(shockwaveGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    shockwavePool.push({
      mesh,
      mat,
      active: false,
      age: 0,
      duration: 0.4,
      maxScale: 4.0,
    });
  }
  let shockwaveCursor = 0;

  const particleGeo = new THREE.SphereGeometry(0.075, 8, 6);
  const particlePool = [];
  for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: '#ffe0a3',
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(particleGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    particlePool.push({
      mesh,
      mat,
      active: false,
      age: 0,
      duration: 0.55,
      vel: new THREE.Vector3(),
      gravity: 9.8,
    });
  }
  let particleCursor = 0;

  function spawnShockwave(x, y, z, colorHex, maxScale, duration, flatOnSand) {
    const fx = shockwavePool[shockwaveCursor];
    shockwaveCursor = (shockwaveCursor + 1) % SHOCKWAVE_POOL_SIZE;
    fx.active = true;
    fx.age = 0;
    fx.duration = duration;
    fx.maxScale = maxScale;
    fx.mat.color.set(colorHex);
    fx.mat.opacity = 0.92;
    fx.mesh.position.set(x, flatOnSand ? 0.035 : y, z);
    fx.mesh.rotation.set(flatOnSand ? -Math.PI / 2 : 0, 0, 0);
    fx.mesh.scale.setScalar(0.35);
    fx.mesh.visible = true;
  }

  function spawnBurstParticles(x, y, z, colorHex, count, speedScale, sandBurst) {
    for (let i = 0; i < count; i++) {
      const p = particlePool[particleCursor];
      particleCursor = (particleCursor + 1) % PARTICLE_POOL_SIZE;
      const ang = (i / Math.max(1, count)) * Math.PI * 2 + elapsed * 3.1;
      const spread = (0.45 + ((i * 37) % 10) * 0.06) * speedScale;
      p.active = true;
      p.age = 0;
      p.duration = sandBurst ? 0.52 : 0.42;
      p.gravity = sandBurst ? 11.5 : 6.5;
      p.mat.color.set(colorHex);
      p.mat.opacity = 0.95;
      p.mesh.position.set(x, Math.max(0.06, y), z);
      p.mesh.scale.setScalar(sandBurst ? 1.15 : 0.9);
      p.vel.set(
        Math.cos(ang) * spread,
        (sandBurst ? 2.4 : 1.5) + ((i * 19) % 7) * 0.35,
        Math.sin(ang) * spread,
      );
      p.mesh.visible = true;
    }
  }

  // --- Dual Camera Systems (BROADCAST & SPLIT_SCREEN) ---
  const broadcastBaseFov = 44;
  const splitBaseFov = 54;
  const broadcastCam = new THREE.PerspectiveCamera(broadcastBaseFov, viewWidth / viewHeight, 0.2, 260);
  broadcastCam.position.set(0, 8.2, 16.4);
  broadcastCam.lookAt(0, 1.45, -0.7);

  const splitLeftCam = new THREE.PerspectiveCamera(
    splitBaseFov,
    Math.max(1, viewWidth * 0.5) / viewHeight,
    0.2,
    260,
  );
  splitLeftCam.position.set(-13.4, 4.6, 0);
  splitLeftCam.lookAt(1.5, 1.85, 0);

  const splitRightCam = new THREE.PerspectiveCamera(
    splitBaseFov,
    Math.max(1, viewWidth * 0.5) / viewHeight,
    0.2,
    260,
  );
  splitRightCam.position.set(13.4, 4.6, 0);
  splitRightCam.lookAt(-1.5, 1.85, 0);

  // Scratch vectors & runtime state
  let elapsed = 0;
  let punchIntensity = 0;
  let smoothBallX = 0;
  let smoothBallZ = 0;
  let disposed = false;

  const _vDir = new THREE.Vector3();
  const _vSide = new THREE.Vector3();
  const _vUpRef = new THREE.Vector3(0, 1, 0);
  const _vAltRef = new THREE.Vector3(0, 0, 1);
  const _cRibbon = new THREE.Color();

  function updateOceanWaves(time, windSpeed) {
    const chop = 1.0 + clamp(windSpeed / 10, 0, 1.2, 0);
    const amp1 = 0.22 * chop;
    const amp2 = 0.14 * chop;
    const kx = 0.14;
    const kz = 0.21;
    const t1 = time * (1.5 + chop * 0.45);
    const t2 = time * (2.0 + chop * 0.35);

    for (let i = 0; i < oceanVertCount; i++) {
      const bx = oceanBaseX[i];
      const bz = oceanBaseZ[i];
      const p1 = bx * kx + t1;
      const p2 = bz * kz - t2;
      const y = Math.sin(p1) * amp1 + Math.cos(p2) * amp2;
      oceanPosAttr.setY(i, y);

      // Exact analytic surface normal for y(x, z) = amp1*sin(kx*x + t1) + amp2*cos(kz*z - t2)
      const dydx = amp1 * kx * Math.cos(p1);
      const dydz = -amp2 * kz * Math.sin(p2);
      const invLen = 1 / Math.sqrt(dydx * dydx + 1 + dydz * dydz);
      oceanNormAttr.setXYZ(i, -dydx * invLen, invLen, -dydz * invLen);
    }
    oceanPosAttr.needsUpdate = true;
    oceanNormAttr.needsUpdate = true;

    // Gentle shoreline surf pulse & sun reflection shimmer
    foamStrip.position.z = -11.35 + Math.sin(time * 1.9) * 0.45;
    foamMat.opacity = 0.38 + 0.16 * Math.sin(time * 1.9);
    sunShimmerMat.opacity = 0.22 + 0.08 * Math.sin(time * 2.8);
  }

  function updatePalms(time, wx, wz, speed) {
    const bendZ = clamp(-wx * 0.022, -0.24, 0.24, 0);
    const bendX = clamp(wz * 0.022, -0.24, 0.24, 0);
    const swayAmp = 0.025 + clamp(speed * 0.008, 0, 0.09, 0);

    for (let i = 0; i < palms.length; i++) {
      const palm = palms[i];
      const sway = Math.sin(time * (1.6 + speed * 0.2) + palm.phase) * swayAmp;
      for (let s = 0; s < palm.segments.length; s++) {
        const seg = palm.segments[s];
        seg.group.rotation.z = seg.baseRotZ + (bendZ + sway) * seg.weight;
        seg.group.rotation.x = seg.baseRotX + (bendX + sway * 0.5) * seg.weight;
      }
      for (let f = 0; f < palm.fronds.length; f++) {
        const frond = palm.fronds[f];
        const flutter = Math.sin(time * (3.2 + speed * 0.5) + frond.phase) * (0.04 + swayAmp * 0.8);
        frond.pivot.rotation.x = frond.basePitch + flutter;
      }
    }
  }

  function updateTrailRibbon(bx, by, bz, active, trailMode) {
    if (!active) {
      trailCount = 0;
      trailGeo.setDrawRange(0, 0);
      return;
    }

    // Clear ribbon on teleport / point reset jump (> 3.5m in one frame)
    if (trailCount > 0) {
      const prev = trailSamples[trailCount - 1];
      const jumpDist = Math.hypot(bx - prev.x, by - prev.y, bz - prev.z);
      if (jumpDist > 3.5) {
        trailCount = 0;
      } else if (jumpDist < 0.03) {
        // Keep current head updated smoothly without collapsing segments
        prev.set(bx, by, bz);
      } else {
        if (trailCount < TRAIL_MAX_POINTS) {
          trailSamples[trailCount].set(bx, by, bz);
          trailCount++;
        } else {
          for (let i = 0; i < TRAIL_MAX_POINTS - 1; i++) {
            trailSamples[i].copy(trailSamples[i + 1]);
          }
          trailSamples[TRAIL_MAX_POINTS - 1].set(bx, by, bz);
        }
      }
    } else {
      trailSamples[0].set(bx, by, bz);
      trailCount = 1;
    }

    if (trailCount < 2) {
      trailGeo.setDrawRange(0, 0);
      return;
    }

    const palette =
      typeof trailMode === 'string' && Object.hasOwn(TRAIL_PALETTES, trailMode)
        ? TRAIL_PALETTES[trailMode]
        : TRAIL_PALETTES[TRAIL_MODES.NEUTRAL];

    for (let i = 0; i < trailCount; i++) {
      // t = 0 at oldest tail, t = 1 at newest head
      const t = i / (trailCount - 1);
      const curr = trailSamples[i];

      if (i === 0) {
        _vDir.subVectors(trailSamples[1], curr);
      } else if (i === trailCount - 1) {
        _vDir.subVectors(curr, trailSamples[i - 1]);
      } else {
        _vDir.subVectors(trailSamples[i + 1], trailSamples[i - 1]);
      }

      const dLen = _vDir.length();
      if (dLen > 1e-6) {
        _vDir.divideScalar(dLen);
      } else {
        _vDir.set(1, 0, 0);
      }

      const ref = Math.abs(_vDir.y) < 0.92 ? _vUpRef : _vAltRef;
      _vSide.crossVectors(_vDir, ref);
      const sLen = _vSide.length();
      if (sLen > 1e-6) {
        _vSide.divideScalar(sLen);
      } else {
        _vSide.set(0, 0, 1);
      }

      const halfWidth = palette.width * Math.pow(t, 0.85);
      const vIdx = i * 6;
      trailPositions[vIdx] = curr.x + _vSide.x * halfWidth;
      trailPositions[vIdx + 1] = curr.y + _vSide.y * halfWidth;
      trailPositions[vIdx + 2] = curr.z + _vSide.z * halfWidth;

      trailPositions[vIdx + 3] = curr.x - _vSide.x * halfWidth;
      trailPositions[vIdx + 4] = curr.y - _vSide.y * halfWidth;
      trailPositions[vIdx + 5] = curr.z - _vSide.z * halfWidth;

      // Gradient color scaled by t for smooth additive fade at tail
      if (t > 0.55) {
        _cRibbon.copy(palette.mid).lerp(palette.head, (t - 0.55) / 0.45);
      } else {
        _cRibbon.copy(palette.tail).lerp(palette.mid, t / 0.55);
      }
      const fade = t * t;
      trailColors[vIdx] = _cRibbon.r * fade;
      trailColors[vIdx + 1] = _cRibbon.g * fade;
      trailColors[vIdx + 2] = _cRibbon.b * fade;

      trailColors[vIdx + 3] = _cRibbon.r * fade;
      trailColors[vIdx + 4] = _cRibbon.g * fade;
      trailColors[vIdx + 5] = _cRibbon.b * fade;
    }

    trailGeo.setDrawRange(0, (trailCount - 1) * 6);
    trailPosAttr.needsUpdate = true;
    trailColAttr.needsUpdate = true;
  }

  function flashNearestWall(x, y, z, wallName) {
    if (typeof wallName === 'string' && Object.hasOwn(wallPanels, wallName)) {
      wallPanels[wallName].flash = 1.0;
      return;
    }
    const dLeft = Math.abs(x + COURT.ARENA_HALF_X);
    const dRight = Math.abs(x - COURT.ARENA_HALF_X);
    const dFar = Math.abs(z + COURT.ARENA_HALF_Z);
    const dNear = Math.abs(z - COURT.ARENA_HALF_Z);
    const dCeil = Math.abs(y - COURT.CEILING_Y);
    const minD = Math.min(dLeft, dRight, dFar, dNear, dCeil);
    if (minD === dLeft) wallPanels.left.flash = 1.0;
    else if (minD === dRight) wallPanels.right.flash = 1.0;
    else if (minD === dFar) wallPanels.far.flash = 1.0;
    else if (minD === dNear) wallPanels.near.flash = 1.0;
    else wallPanels.ceiling.flash = 1.0;
  }

  function processEvents(events, ballX, ballY, ballZ) {
    if (!Array.isArray(events) || events.length === 0) return;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev) continue;
      const type = typeof ev === 'string' ? ev : ev.type;
      const ex = finiteOr(ev?.pos?.x ?? ev?.x, ballX);
      const ey = finiteOr(ev?.pos?.y ?? ev?.y, ballY);
      const ez = finiteOr(ev?.pos?.z ?? ev?.z, ballZ);

      if (type === EVENTS.HEAT_SPIKE) {
        punchIntensity = Math.max(punchIntensity, clamp(ev?.intensity ?? 0.9, 0.3, 1.0, 0.9));
        spawnShockwave(ex, ey, ez, '#ff7b00', 5.8, 0.48, false);
        spawnBurstParticles(ex, ey, ez, '#ffe066', 10, 5.2, false);
      } else if (type === EVENTS.SPIKE) {
        punchIntensity = Math.max(punchIntensity, 0.35);
        spawnShockwave(ex, ey, ez, '#ffd166', 3.4, 0.34, false);
        spawnBurstParticles(ex, ey, ez, '#ffd166', 5, 3.6, false);
      } else if (type === EVENTS.POKEY_CUT) {
        spawnShockwave(ex, ey, ez, '#00f3ff', 3.0, 0.35, false);
        spawnBurstParticles(ex, ey, ez, '#00f3ff', 5, 3.0, false);
      } else if (type === EVENTS.STUFF_BLOCK || type === EVENTS.NET_BLOCK) {
        punchIntensity = Math.max(punchIntensity, type === EVENTS.STUFF_BLOCK ? 0.65 : 0.25);
        spawnShockwave(ex, ey, ez, '#ff4d6d', 4.2, 0.38, false);
        spawnBurstParticles(ex, ey, ez, '#ffffff', 6, 4.0, false);
      } else if (type === EVENTS.WALL_BOUNCE) {
        flashNearestWall(ex, ey, ez, ev?.wall);
        spawnShockwave(ex, ey, ez, '#ff9f43', 2.8, 0.32, false);
        spawnBurstParticles(ex, ey, ez, '#ffbe76', 4, 3.2, false);
      } else if (type === EVENTS.SAND_IMPACT) {
        spawnShockwave(ex, 0.03, ez, '#ffe0a3', 4.0, 0.45, true);
        spawnBurstParticles(ex, 0.08, ez, '#f0c888', 8, 3.4, true);
      } else if (type === EVENTS.DIVE) {
        spawnShockwave(ex, 0.03, ez, '#ffd166', 2.8, 0.36, true);
        spawnBurstParticles(ex, 0.06, ez, '#ecc282', 6, 2.8, true);
      } else if (type === EVENTS.BUMP || type === EVENTS.SET) {
        spawnShockwave(ex, ey, ez, type === EVENTS.SET ? '#ffe066' : '#fff4d6', 2.0, 0.26, false);
      } else if (type === EVENTS.NET_TAPE_HIT || type === EVENTS.NET_MESH_HIT) {
        netFlashTimer = 0.28;
        spawnShockwave(ex, ey, ez, '#ffffff', 2.2, 0.25, false);
      }
    }
  }

  function updateFxPools(dt) {
    // Wall bounce flashes decay smoothly
    const panelKeys = Object.keys(wallPanels);
    for (let i = 0; i < panelKeys.length; i++) {
      const panel = wallPanels[panelKeys[i]];
      if (panel.flash > 0) {
        panel.flash = Math.max(0, panel.flash - dt * 3.4);
        panel.mat.opacity = panel.baseOpacity + panel.flash * 0.42;
      }
    }

    // Net tape hit flash
    if (netFlashTimer > 0) {
      netFlashTimer = Math.max(0, netFlashTimer - dt);
      topTapeMat.emissiveIntensity = 0.08 + (netFlashTimer / 0.28) * 0.75;
    } else {
      topTapeMat.emissiveIntensity = 0.08;
    }

    // Shockwave rings
    for (let i = 0; i < SHOCKWAVE_POOL_SIZE; i++) {
      const fx = shockwavePool[i];
      if (!fx.active) continue;
      fx.age += dt;
      if (fx.age >= fx.duration) {
        fx.active = false;
        fx.mesh.visible = false;
        continue;
      }
      const u = fx.age / fx.duration;
      const scale = 0.35 + (fx.maxScale - 0.35) * (1 - (1 - u) * (1 - u));
      fx.mesh.scale.setScalar(scale);
      fx.mat.opacity = (1 - u) * 0.9;
    }

    // Burst particles
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const p = particlePool[i];
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.duration) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      const u = p.age / p.duration;
      p.vel.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      if (p.mesh.position.y < 0.04) {
        p.mesh.position.y = 0.04;
        p.vel.y = Math.abs(p.vel.y) * 0.25;
      }
      p.mat.opacity = 1 - u;
      p.mesh.scale.setScalar(Math.max(0.1, 1 - u * 0.75));
    }
  }

  function updateCameras(dt) {
    // Smooth rally tracking
    const followRate = dt > 0 ? 1 - Math.exp(-dt * 4.5) : 0;
    smoothBallX += (ballMesh.position.x - smoothBallX) * followRate;
    smoothBallZ += (ballMesh.position.z - smoothBallZ) * followRate;

    // Damped camera punch shake + subtle FOV kick
    if (punchIntensity > 0 && dt > 0) {
      punchIntensity = Math.max(0, punchIntensity - dt * 3.6);
    }

    const shakeMag = punchIntensity * punchIntensity * 0.34;
    const shakeX = shakeMag * Math.sin(elapsed * 58.0);
    const shakeY = shakeMag * Math.cos(elapsed * 71.0);
    const fovKick = punchIntensity * 3.8;

    // Broadcast 3/4 coastal camera on +Z
    const bxTarget = clamp(smoothBallX * 0.14, -1.6, 1.6, 0);
    const lookX = clamp(smoothBallX * 0.18, -2.2, 2.2, 0);
    broadcastCam.position.set(bxTarget + shakeX, 8.2 + shakeY, 16.4 - punchIntensity * 0.45);
    broadcastCam.lookAt(lookX, 1.45, -0.7);
    if (Math.abs(broadcastCam.fov - (broadcastBaseFov + fovKick)) > 1e-4) {
      broadcastCam.fov = broadcastBaseFov + fovKick;
      broadcastCam.updateProjectionMatrix();
    }

    // Split-Screen Team 1 (-X looking +X) & Team 2 (+X looking -X)
    const splitZ = clamp(smoothBallZ * 0.24, -1.4, 1.4, 0);
    const lookZ = clamp(smoothBallZ * 0.18, -1.2, 1.2, 0);
    splitLeftCam.position.set(-13.4 + shakeX * 0.6, 4.65 + shakeY * 0.6, splitZ);
    splitLeftCam.lookAt(1.5, 1.85, lookZ);
    if (Math.abs(splitLeftCam.fov - (splitBaseFov + fovKick)) > 1e-4) {
      splitLeftCam.fov = splitBaseFov + fovKick;
      splitLeftCam.updateProjectionMatrix();
    }

    splitRightCam.position.set(13.4 - shakeX * 0.6, 4.65 + shakeY * 0.6, splitZ);
    splitRightCam.lookAt(-1.5, 1.85, lookZ);
    if (Math.abs(splitRightCam.fov - (splitBaseFov + fovKick)) > 1e-4) {
      splitRightCam.fov = splitBaseFov + fovKick;
      splitRightCam.updateProjectionMatrix();
    }
  }

  function syncPlayers(players, ballState, dt) {
    for (let i = 0; i < rigPool.length; i++) {
      rigSlotUsed[i] = false;
    }

    if (Array.isArray(players)) {
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p || typeof p !== 'object') continue;
        const team = p.team === 2 ? 2 : 1;
        const role = p.role === 'PARTNER' ? 'PARTNER' : 'PRIMARY';

        // Deterministic slot lookup: exact (team, role) -> same team free -> any free
        const preferredIdx = (team === 1 ? 0 : 2) + (role === 'PARTNER' ? 1 : 0);
        let chosenIdx = -1;
        if (!rigSlotUsed[preferredIdx]) {
          chosenIdx = preferredIdx;
        } else {
          const teamStart = team === 1 ? 0 : 2;
          if (!rigSlotUsed[teamStart]) chosenIdx = teamStart;
          else if (!rigSlotUsed[teamStart + 1]) chosenIdx = teamStart + 1;
          else {
            for (let k = 0; k < rigPool.length; k++) {
              if (!rigSlotUsed[k]) {
                chosenIdx = k;
                break;
              }
            }
          }
        }

        if (chosenIdx >= 0) {
          rigSlotUsed[chosenIdx] = true;
          const rig = rigPool[chosenIdx];
          rig.root.visible = true;
          updatePlayerRig(rig, p, ballState, dt);
        }
      }
    }

    for (let i = 0; i < rigPool.length; i++) {
      if (!rigSlotUsed[i]) {
        rigPool[i].root.visible = false;
      }
    }
  }

  /**
   * Synchronize all 3D visual elements from a RenderSnapshot.
   * Zero per-frame Three.js Geometry or Material allocations.
   */
  function syncState(snapshot, dt = 1 / 60) {
    if (disposed || !snapshot || typeof snapshot !== 'object') {
      return;
    }
    const safeDt = clamp(dt, 0, 0.05, 0);
    elapsed += safeDt;

    // 1. Wind state
    const wind = snapshot.wind && typeof snapshot.wind === 'object' ? snapshot.wind : {};
    const wx = finiteOr(wind.windVec3?.x, 0);
    const wy = finiteOr(wind.windVec3?.y, 0);
    const wz = finiteOr(wind.windVec3?.z, 0);
    const windSpeed = Math.max(0, finiteOr(wind.speed, Math.hypot(wx, wy, wz)));
    const windPhase = typeof wind.phase === 'string' ? wind.phase : WIND_PHASES.BREEZE;

    updateOceanWaves(elapsed, windSpeed);
    updatePalms(elapsed, wx, wz, windSpeed);
    updateWindStreamerGeometry(farStreamer, wx, wy, wz, windSpeed, windPhase, elapsed);
    updateWindStreamerGeometry(nearStreamer, wx, wy, wz, windSpeed, windPhase, elapsed);

    // 2. Ball, drop-shadow & spin ribbon
    const ball = snapshot.ball && typeof snapshot.ball === 'object' ? snapshot.ball : null;
    const ballActive = ball ? ball.active !== false : false;
    const bx = finiteOr(ball?.pos?.x, 0);
    const by = Math.max(BALL_SPEC.RADIUS, finiteOr(ball?.pos?.y, 2.0));
    const bz = finiteOr(ball?.pos?.z, 0);
    const trailMode = typeof ball?.trailMode === 'string' ? ball.trailMode : TRAIL_MODES.NEUTRAL;

    ballMesh.visible = ballActive;
    ballMesh.position.set(bx, by, bz);
    if (ball?.spinAngle) {
      ballMesh.rotation.set(
        finiteOr(ball.spinAngle.x, 0),
        finiteOr(ball.spinAngle.y, 0),
        finiteOr(ball.spinAngle.z, 0),
      );
    }

    // Crisp sand drop-shadow scaling & fading with height
    dropShadowMesh.visible = ballActive;
    dropShadowMesh.position.set(bx, 0.016, bz);
    const heightAboveSand = Math.max(0, by - BALL_SPEC.RADIUS);
    const shadowScale = clamp(1.0 / (1 + heightAboveSand * 0.14), 0.35, 1.25, 1.0);
    dropShadowMesh.scale.setScalar(shadowScale);
    dropShadowMat.opacity = clamp(0.62 / (1 + heightAboveSand * 0.18), 0.12, 0.65, 0.5);

    updateTrailRibbon(bx, by, bz, ballActive, trailMode);

    // 3. Pulsing 3D Landing Reticle at predictLandingPoint3D
    const pred = snapshot.prediction && typeof snapshot.prediction === 'object' ? snapshot.prediction : null;
    if (
      ballActive &&
      pred &&
      Number.isFinite(pred.x) &&
      Number.isFinite(pred.z)
    ) {
      const rx = clamp(pred.x, -COURT.ARENA_HALF_X, COURT.ARENA_HALF_X, 0);
      const rz = clamp(pred.z, -COURT.ARENA_HALF_Z, COURT.ARENA_HALF_Z, 0);
      const hangTime = clamp(pred.hangTime, 0, 5, 1.0);
      const urgency = clamp(1 - hangTime / 1.4, 0, 1, 0);
      const pulseFreq = 5.0 + urgency * 12.0;
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * pulseFreq);

      reticleGroup.visible = true;
      reticleGroup.position.set(rx, 0.024, rz);
      reticleGroup.rotation.y = elapsed * (0.9 + urgency * 1.4);

      const outerScale = 0.88 + pulse * (0.18 + urgency * 0.14);
      reticleOuter.scale.setScalar(outerScale);
      reticleOuterMat.color.set(hangTime < 0.38 ? '#ff5a36' : '#00f3ff');
      reticleOuterMat.opacity = 0.55 + pulse * 0.4;
      reticleInnerMat.opacity = 0.6 + (1 - pulse) * 0.35;
    } else {
      reticleGroup.visible = false;
    }

    // 4. Shrinking 3D Timing Ring at Set apex
    const tr = snapshot.timingRing && typeof snapshot.timingRing === 'object' ? snapshot.timingRing : null;
    const trActive = Boolean(tr && (tr.active === true || tr.visible === true));
    const trX = finiteOr(tr?.x ?? tr?.pos?.x, NaN);
    const trY = finiteOr(tr?.y ?? tr?.pos?.y, NaN);
    const trZ = finiteOr(tr?.z ?? tr?.pos?.z, NaN);
    if (trActive && Number.isFinite(trX) && Number.isFinite(trY) && Number.isFinite(trZ)) {
      const progress = clamp(tr.progress ?? tr.ratio ?? tr.normalizedTime, 0, 1, 0);
      const sweetMin = clamp(tr.sweetMin, 0, 1, 0.68);
      const sweetMax = clamp(tr.sweetMax, sweetMin, 1, 0.94);
      const isSweetSpot = Boolean(
        tr.isSweetSpot ?? tr.sweetSpot ?? (progress >= sweetMin && progress <= sweetMax),
      );
      const baseRadiusScale = clamp(tr.radius, 0.5, 2.2, 1.0);

      timingRingGroup.visible = true;
      timingRingGroup.position.set(trX, Math.max(0.5, trY), trZ);

      // Outer ring shrinks smoothly from 1.38 down onto the 0.56 sweet-spot halo
      const shrinkScale = (1.38 - progress * 0.96) * baseRadiusScale;
      timingShrinkHalo.scale.setScalar(Math.max(0.28, shrinkScale));
      timingTargetHalo.scale.setScalar(baseRadiusScale);

      if (isSweetSpot) {
        const flash = 0.5 + 0.5 * Math.sin(elapsed * 26.0);
        timingTargetMat.color.set('#fff6a8');
        timingShrinkMat.color.set(flash > 0.5 ? '#ffffff' : '#ff9f1c');
        timingTargetMat.opacity = 1.0;
        timingShrinkMat.opacity = 1.0;
      } else {
        timingTargetMat.color.set('#ffd166');
        timingShrinkMat.color.set('#00f3ff');
        timingTargetMat.opacity = 0.78;
        timingShrinkMat.opacity = 0.90;
      }
    } else {
      timingRingGroup.visible = false;
    }

    // 5. Articulated Athlete Rigs (pre-allocated 4-rig pool)
    syncPlayers(snapshot.players, ball, safeDt);

    // 6. Camera Punch & Events FX
    const snapPunch = clamp(snapshot.cameraPunch, 0, 1, 0);
    if (snapPunch > punchIntensity) {
      punchIntensity = snapPunch;
    }
    processEvents(snapshot.events, bx, by, bz);
    updateFxPools(safeDt);
    updateCameras(safeDt);

    // 7. Diegetic Stadium LED Scoreboard (dirty-check cached redraw)
    if (ledCtx) {
      const sb = normalizeScoreboard(snapshot);
      const sig = [
        sb.scoreT1,
        sb.scoreT2,
        sb.servingTeam,
        Math.round(sb.heatT1 * 50),
        Math.round(sb.heatT2 * 50),
        sb.touchCount,
        sb.activeTeam,
        sb.windPhase,
        Math.round(sb.windSpeedMs * 10),
        sb.bannerText,
        sb.bannerColor,
        sb.format,
        sb.aiStyle,
      ].join('|');

      if (sig !== lastLedSignature) {
        lastLedSignature = sig;
        drawLedScoreboard(ledCtx, sb);
        if (ledTexture) {
          ledTexture.needsUpdate = true;
        }
      }
    }
  }

  /**
   * Render the scene in BROADCAST (single full-viewport) or SPLIT (dual scissor viewport) mode.
   */
  function render(cameraMode = CAMERA_MODES.BROADCAST) {
    if (disposed) return;

    const w = Math.max(1, Math.floor(viewWidth));
    const h = Math.max(1, Math.floor(viewHeight));

    if (cameraMode === CAMERA_MODES.SPLIT_SCREEN) {
      const divider = w >= 4 ? 2 : 0;
      const leftW = Math.max(1, Math.floor((w - divider) / 2));
      const rightX = leftW + divider;
      const rightW = Math.max(1, w - rightX);

      // Clear full canvas once so the 2px center divider stripe is crisp dark sunset navy
      if (typeof renderer.setScissorTest === 'function') {
        renderer.setScissorTest(false);
      }
      if (typeof renderer.setViewport === 'function') {
        renderer.setViewport(0, 0, w, h);
      }
      if (typeof renderer.clear === 'function') {
        renderer.clear();
      }

      if (typeof renderer.setScissorTest === 'function') {
        renderer.setScissorTest(true);
      }

      // Left viewport: Team 1 camera (-X looking +X)
      splitLeftCam.aspect = leftW / h;
      splitLeftCam.updateProjectionMatrix();
      if (timingRingGroup.visible) {
        timingRingGroup.lookAt(splitLeftCam.position);
      }
      if (typeof renderer.setViewport === 'function') {
        renderer.setViewport(0, 0, leftW, h);
      }
      if (typeof renderer.setScissor === 'function') {
        renderer.setScissor(0, 0, leftW, h);
      }
      renderer.render(scene, splitLeftCam);

      // Right viewport: Team 2 camera (+X looking -X)
      splitRightCam.aspect = rightW / h;
      splitRightCam.updateProjectionMatrix();
      if (timingRingGroup.visible) {
        timingRingGroup.lookAt(splitRightCam.position);
      }
      if (typeof renderer.setViewport === 'function') {
        renderer.setViewport(rightX, 0, rightW, h);
      }
      if (typeof renderer.setScissor === 'function') {
        renderer.setScissor(rightX, 0, rightW, h);
      }
      renderer.render(scene, splitRightCam);
    } else {
      // BROADCAST mode: strictly reset scissor test & full viewport
      broadcastCam.aspect = w / h;
      broadcastCam.updateProjectionMatrix();
      if (timingRingGroup.visible) {
        timingRingGroup.lookAt(broadcastCam.position);
      }
      if (typeof renderer.setScissorTest === 'function') {
        renderer.setScissorTest(false);
      }
      if (typeof renderer.setViewport === 'function') {
        renderer.setViewport(0, 0, w, h);
      }
      renderer.render(scene, broadcastCam);
    }
  }

  /**
   * Resize the renderer and update all camera projection matrices safely.
   */
  function resize(width, height) {
    if (disposed) return;
    const nextW = clamp(width, 1, 8192, viewWidth);
    const nextH = clamp(height, 1, 8192, viewHeight);
    viewWidth = Math.max(1, Math.floor(nextW));
    viewHeight = Math.max(1, Math.floor(nextH));

    if (typeof renderer.setSize === 'function') {
      renderer.setSize(viewWidth, viewHeight, false);
    }

    const halfW = Math.max(1, Math.floor(viewWidth / 2));
    broadcastCam.aspect = viewWidth / viewHeight;
    broadcastCam.updateProjectionMatrix();
    splitLeftCam.aspect = halfW / viewHeight;
    splitLeftCam.updateProjectionMatrix();
    splitRightCam.aspect = halfW / viewHeight;
    splitRightCam.updateProjectionMatrix();
  }

  /**
   * Imperatively trigger camera shake / FOV punch (e.g. Heat Spike impact).
   */
  function triggerCameraPunch(intensity = 0.6) {
    if (disposed) return;
    const clamped = clamp(intensity, 0, 1, 0.5);
    if (clamped > punchIntensity) {
      punchIntensity = clamped;
    }
  }

  /**
   * Dispose all geometries, materials, textures, athlete rigs, and renderer cleanly.
   * Idempotent on repeated calls.
   */
  function dispose() {
    if (disposed) return;
    disposed = true;

    for (let i = 0; i < rigPool.length; i++) {
      disposePlayerRig(rigPool[i]);
    }

    const disposedGeos = new Set();
    const disposedMats = new Set();
    const disposedLights = new Set();
    scene.traverse((obj) => {
      if (obj.geometry && !disposedGeos.has(obj.geometry)) {
        disposedGeos.add(obj.geometry);
        if (typeof obj.geometry.dispose === 'function') {
          obj.geometry.dispose();
        }
      }
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (let i = 0; i < mats.length; i++) {
          const mat = mats[i];
          if (mat && !disposedMats.has(mat)) {
            disposedMats.add(mat);
            if (typeof mat.dispose === 'function') {
              mat.dispose();
            }
          }
        }
      }
      if (obj.isLight && !disposedLights.has(obj)) {
        disposedLights.add(obj);
        if (typeof obj.dispose === 'function') {
          obj.dispose();
        } else if (obj.shadow && obj.shadow.map && typeof obj.shadow.map.dispose === 'function') {
          obj.shadow.map.dispose();
        }
      }
    });

    if (sunLight && !disposedLights.has(sunLight)) {
      if (typeof sunLight.dispose === 'function') {
        sunLight.dispose();
      } else if (sunLight.shadow && sunLight.shadow.map && typeof sunLight.shadow.map.dispose === 'function') {
        sunLight.shadow.map.dispose();
      }
    }

    for (let i = 0; i < ownedTextures.length; i++) {
      if (ownedTextures[i] && typeof ownedTextures[i].dispose === 'function') {
        ownedTextures[i].dispose();
      }
    }
    ownedTextures.length = 0;

    if (typeof scene.clear === 'function') {
      scene.clear();
    }

    if (renderer && typeof renderer.dispose === 'function') {
      renderer.dispose();
    }
  }

  return {
    syncState,
    render,
    resize,
    triggerCameraPunch,
    dispose,
  };
}
