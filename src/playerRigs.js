/**
 * SUMMER HEAT 3D — Articulated Stylized 3D Beach-Volleyball Athlete Rigs (F10)
 *
 * Strictly imports ONLY ../vendor/three.module.min.js and ./contracts.js.
 * Coordinate alignment: local forward = +Z, local up = +Y.
 * Applying `rig.root.rotation.y = facingYaw` aligns Team 1 (+PI/2) along +X toward net
 * and Team 2 (-PI/2) along -X toward net.
 * Zero per-frame Geometry/Material allocations; pre-allocated scratch math objects.
 */

import * as THREE from '../vendor/three.module.min.js';
import { ANIM_STATES, clamp } from './contracts.js';

const EPS = 1e-8;
const DOWN_AXIS = new THREE.Vector3(0, -1, 0);
const UP_AXIS = new THREE.Vector3(0, 1, 0);
const FWD_AXIS = new THREE.Vector3(0, 0, 1);
const RIGHT_AXIS = new THREE.Vector3(1, 0, 0);

const VALID_ANIM_STATES = new Set(Object.values(ANIM_STATES));

// Proportions for stylized ~1.78m coastal beach-volleyball athlete
const LIMB_DIMS = Object.freeze({
  PELVIS_STAND_Y: 0.90,
  LEG_UPPER: 0.44,
  LEG_LOWER: 0.42,
  FOOT_SOLE_Y: 0.04,
  ARM_UPPER: 0.30,
  ARM_LOWER: 0.28,
  SHOULDER_X: 0.25,
  SHOULDER_Y: 0.42,
  SHOULDER_Z: 0.01,
  HIP_X: 0.125,
  HIP_Y: -0.04,
});

// Module-level scratch math objects to guarantee zero per-frame heap churn
const _vToTarget = new THREE.Vector3();
const _vFwd = new THREE.Vector3();
const _vPolePerp = new THREE.Vector3();
const _vBendDir = new THREE.Vector3();
const _vFallback = new THREE.Vector3();
const _vOrigin = new THREE.Vector3();
const _vTarget = new THREE.Vector3();
const _vPole = new THREE.Vector3();

const _vBallWorld = new THREE.Vector3();
const _vBallLocalTorso = new THREE.Vector3();
const _vBallLocalRoot = new THREE.Vector3();
const _vLeftHandTarget = new THREE.Vector3();
const _vRightHandTarget = new THREE.Vector3();
const _vLeftArmPole = new THREE.Vector3();
const _vRightArmPole = new THREE.Vector3();
const _vLeftFootTarget = new THREE.Vector3();
const _vRightFootTarget = new THREE.Vector3();
const _vLeftLegPole = new THREE.Vector3();
const _vRightLegPole = new THREE.Vector3();
const _vLocalLowerDir = new THREE.Vector3();

const _qUpper = new THREE.Quaternion();
const _qUpperInv = new THREE.Quaternion();
const _qLower = new THREE.Quaternion();
const _mInvTorso = new THREE.Matrix4();
const _mInvRoot = new THREE.Matrix4();
const _cTmp = new THREE.Color();

const _ikScratch = {
  mid: new THREE.Vector3(),
  end: new THREE.Vector3(),
  upperDir: new THREE.Vector3(),
  lowerDir: new THREE.Vector3(),
  clamped: false,
};

const COLOR_HEAT_ORANGE = new THREE.Color('#ff6d00');
const COLOR_HEAT_GOLD = new THREE.Color('#ffe066');
const COLOR_CHARGE_GLOW = new THREE.Color('#fff1a8');

function finiteOr(val, fallback = 0) {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

function readVec3(src, out, fx = 0, fy = 0, fz = 0) {
  if (src !== null && typeof src === 'object') {
    out.set(finiteOr(src.x, fx), finiteOr(src.y, fy), finiteOr(src.z, fz));
  } else {
    out.set(fx, fy, fz);
  }
  return out;
}

function setQuaternionFromDownToDir(outQuat, dir) {
  const lenSq = dir.lengthSq();
  if (!Number.isFinite(lenSq) || lenSq < EPS) {
    outQuat.identity();
    return outQuat;
  }
  const invLen = 1 / Math.sqrt(lenSq);
  const dx = dir.x * invLen;
  const dy = dir.y * invLen;
  const dz = dir.z * invLen;

  // dot((0, -1, 0), (dx, dy, dz)) = -dy
  const dot = -dy;
  if (dot > 1 - 1e-6) {
    outQuat.identity();
  } else if (dot < -1 + 1e-6) {
    // 180-degree flip cleanly around +X axis
    outQuat.setFromAxisAngle(RIGHT_AXIS, Math.PI);
  } else {
    _vFallback.set(dx, dy, dz);
    outQuat.setFromUnitVectors(DOWN_AXIS, _vFallback);
  }
  return outQuat;
}

/**
 * Analytic law-of-cosines 2-bone Inverse Kinematics solver.
 * Safe against NaN/Infinity, zero-distance targets, and unreachable targets.
 *
 * @param {{x:number,y:number,z:number}} origin - Root joint position
 * @param {{x:number,y:number,z:number}} target - Desired effector position
 * @param {{x:number,y:number,z:number}} poleHint - Preferred bend direction for middle joint
 * @param {number} len1 - Upper segment length (> 0)
 * @param {number} len2 - Lower segment length (> 0)
 * @param {object} [out] - Optional pre-allocated output structure
 * @returns {{ mid: THREE.Vector3, end: THREE.Vector3, upperDir: THREE.Vector3, lowerDir: THREE.Vector3, clamped: boolean }}
 */
export function solveTwoBoneIK(origin, target, poleHint, len1, len2, out = null) {
  const result = out || {
    mid: new THREE.Vector3(),
    end: new THREE.Vector3(),
    upperDir: new THREE.Vector3(),
    lowerDir: new THREE.Vector3(),
    clamped: false,
  };

  const l1 = Math.max(1e-4, finiteOr(len1, 0.3));
  const l2 = Math.max(1e-4, finiteOr(len2, 0.3));

  readVec3(origin, _vOrigin, 0, 0, 0);
  readVec3(target, _vTarget, _vOrigin.x, _vOrigin.y - (l1 + l2) * 0.5, _vOrigin.z);
  readVec3(poleHint, _vPole, 0, 0, 1);

  _vToTarget.subVectors(_vTarget, _vOrigin);
  const rawDist = _vToTarget.length();

  if (!Number.isFinite(rawDist) || rawDist < EPS) {
    _vFwd.copy(DOWN_AXIS);
  } else {
    _vFwd.copy(_vToTarget).divideScalar(rawDist);
  }

  const minReach = Math.abs(l1 - l2) + 1e-4;
  const maxReach = l1 + l2 - 1e-4;
  const dist = clamp(rawDist, minReach, maxReach, minReach);
  result.clamped = !Number.isFinite(rawDist) || rawDist < minReach || rawDist > maxReach;

  // Orthonormal bend direction from poleHint projected perpendicular to _vFwd
  const poleDot = _vPole.dot(_vFwd);
  _vPolePerp.copy(_vPole).addScaledVector(_vFwd, -poleDot);
  const perpLen = _vPolePerp.length();

  if (!Number.isFinite(perpLen) || perpLen < 1e-6) {
    const refAxis = Math.abs(_vFwd.y) < 0.9 ? UP_AXIS : FWD_AXIS;
    _vBendDir.crossVectors(_vFwd, refAxis);
    const fbLen = _vBendDir.length();
    if (fbLen < 1e-6) {
      _vBendDir.set(1, 0, 0);
    } else {
      _vBendDir.divideScalar(fbLen);
    }
  } else {
    _vBendDir.copy(_vPolePerp).divideScalar(perpLen);
  }

  // Law of cosines for angle between _vFwd and upper segment
  const cosAlpha = clamp(
    (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist),
    -1,
    1,
    1,
  );
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

  const along = l1 * cosAlpha;
  const perp = l1 * sinAlpha;

  result.mid
    .copy(_vOrigin)
    .addScaledVector(_vFwd, along)
    .addScaledVector(_vBendDir, perp);

  result.end.copy(_vOrigin).addScaledVector(_vFwd, dist);

  result.upperDir.subVectors(result.mid, _vOrigin);
  const uLen = result.upperDir.length();
  if (uLen > EPS) {
    result.upperDir.divideScalar(uLen);
  } else {
    result.upperDir.copy(DOWN_AXIS);
  }

  result.lowerDir.subVectors(result.end, result.mid);
  const loLen = result.lowerDir.length();
  if (loLen > EPS) {
    result.lowerDir.divideScalar(loLen);
  } else {
    result.lowerDir.copy(result.upperDir);
  }

  return result;
}

function applyTwoBoneLimb(upperJoint, lowerJoint, targetLocal, poleLocal, len1, len2) {
  solveTwoBoneIK(upperJoint.position, targetLocal, poleLocal, len1, len2, _ikScratch);
  setQuaternionFromDownToDir(_qUpper, _ikScratch.upperDir);
  upperJoint.quaternion.copy(_qUpper);

  _qUpperInv.copy(_qUpper).invert();
  _vLocalLowerDir.copy(_ikScratch.lowerDir).applyQuaternion(_qUpperInv);
  setQuaternionFromDownToDir(_qLower, _vLocalLowerDir);
  lowerJoint.quaternion.copy(_qLower);
}

function getTeamPalette(team, role) {
  const isTeam2 = team === 2;
  const isPartner = role === 'PARTNER';

  if (!isTeam2) {
    // Team 1: Sunset Coral & Warm Gold
    return isPartner
      ? {
          jersey: '#ffb703',
          trim: '#ff4d2e',
          shorts: '#2b3a67',
          skin: '#c98258',
          hair: '#2b1b17',
          aura: '#ff9233',
        }
      : {
          jersey: '#ff5a36',
          trim: '#ffd166',
          shorts: '#c93326',
          skin: '#dc996e',
          hair: '#3a2318',
          aura: '#ff5a36',
        };
  }

  // Team 2: Ocean Cyan & Electric Lime
  return isPartner
    ? {
        jersey: '#52e5a8',
        trim: '#00b4d8',
        shorts: '#123c5c',
        skin: '#c47d54',
        hair: '#1a202c',
        aura: '#52e5a8',
      }
    : {
        jersey: '#00c2d1',
        trim: '#a8ff3e',
        shorts: '#006d77',
        skin: '#d9956a',
        hair: '#241b19',
        aura: '#00c2d1',
      };
}

function makeShadowMesh(geometry, material, name) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Create an articulated 3D stylized beach-volleyball athlete rig.
 *
 * @param {{ id?: string, team?: 1 | 2, role?: 'PRIMARY' | 'PARTNER' }} [options]
 * @returns {{ root: THREE.Group, id: string, team: number, role: string, joints: object, spring: object, materials: object }}
 */
export function createPlayerRig({ id = 'p1', team = 1, role = 'PRIMARY' } = {}) {
  const safeId = typeof id === 'string' && id.length > 0 ? id : 'p1';
  const safeTeam = team === 2 ? 2 : 1;
  const safeRole = role === 'PARTNER' ? 'PARTNER' : 'PRIMARY';
  const palette = getTeamPalette(safeTeam, safeRole);

  const ownedGeometries = [];
  const trackGeo = (geo) => {
    ownedGeometries.push(geo);
    return geo;
  };

  // Materials
  const materials = {
    skin: new THREE.MeshStandardMaterial({
      color: palette.skin,
      roughness: 0.62,
      metalness: 0.04,
    }),
    jersey: new THREE.MeshStandardMaterial({
      color: palette.jersey,
      emissive: new THREE.Color(palette.jersey),
      emissiveIntensity: 0.06,
      roughness: 0.45,
      metalness: 0.08,
    }),
    trim: new THREE.MeshStandardMaterial({
      color: palette.trim,
      emissive: new THREE.Color(palette.trim),
      emissiveIntensity: 0.15,
      roughness: 0.35,
      metalness: 0.12,
    }),
    shorts: new THREE.MeshStandardMaterial({
      color: palette.shorts,
      roughness: 0.58,
      metalness: 0.05,
    }),
    hair: new THREE.MeshStandardMaterial({
      color: palette.hair,
      roughness: 0.72,
      metalness: 0.05,
    }),
    shades: new THREE.MeshStandardMaterial({
      color: '#111622',
      emissive: new THREE.Color(palette.trim),
      emissiveIntensity: 0.18,
      roughness: 0.14,
      metalness: 0.82,
    }),
    tape: new THREE.MeshStandardMaterial({
      color: '#fff6e8',
      roughness: 0.55,
      metalness: 0.02,
    }),
    heatRing: new THREE.MeshBasicMaterial({
      color: palette.aura,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    chargeRing: new THREE.MeshBasicMaterial({
      color: '#fff1a8',
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  };

  // Root & hierarchy
  const root = new THREE.Group();
  root.name = `playerRig_${safeId}`;

  // Grounded heat + charge aura ring (stays on sand even while airborne)
  const auraGroup = new THREE.Group();
  auraGroup.name = 'auraGroup';
  auraGroup.position.set(0, 0.03, 0);
  root.add(auraGroup);

  const heatRingMesh = new THREE.Mesh(
    trackGeo(new THREE.RingGeometry(0.45, 0.58, 32)),
    materials.heatRing,
  );
  heatRingMesh.rotation.x = -Math.PI / 2;
  heatRingMesh.name = 'heatRing';
  auraGroup.add(heatRingMesh);

  const chargeRingMesh = new THREE.Mesh(
    trackGeo(new THREE.RingGeometry(0.24, 0.42, 32)),
    materials.chargeRing,
  );
  chargeRingMesh.rotation.x = -Math.PI / 2;
  chargeRingMesh.position.y = 0.004;
  chargeRingMesh.name = 'chargeRing';
  auraGroup.add(chargeRingMesh);

  // Body pivot for squash-stretch, sprint lean, and sand dive pitch
  const bodyPivot = new THREE.Group();
  bodyPivot.name = 'bodyPivot';
  root.add(bodyPivot);

  // Pelvis / Hips
  const pelvis = new THREE.Group();
  pelvis.name = 'pelvis';
  pelvis.position.set(0, LIMB_DIMS.PELVIS_STAND_Y, 0);
  bodyPivot.add(pelvis);

  const pelvisMesh = makeShadowMesh(
    trackGeo(new THREE.CapsuleGeometry(0.165, 0.10, 6, 12)),
    materials.shorts,
    'pelvisMesh',
  );
  pelvisMesh.rotation.z = Math.PI / 2;
  pelvis.add(pelvisMesh);

  // Shorts waist stripe trim
  const waistTrim = makeShadowMesh(
    trackGeo(new THREE.CylinderGeometry(0.172, 0.178, 0.055, 14)),
    materials.trim,
    'waistTrim',
  );
  waistTrim.position.set(0, 0.08, 0);
  pelvis.add(waistTrim);

  // Torso
  const torso = new THREE.Group();
  torso.name = 'torso';
  torso.position.set(0, 0.08, 0);
  pelvis.add(torso);

  const torsoMesh = makeShadowMesh(
    trackGeo(new THREE.CapsuleGeometry(0.185, 0.28, 6, 14)),
    materials.jersey,
    'torsoMesh',
  );
  torsoMesh.position.set(0, 0.24, 0);
  torsoMesh.scale.set(1.08, 1.0, 0.82);
  torso.add(torsoMesh);

  // Athletic chest accent stripe
  const chestStripe = makeShadowMesh(
    trackGeo(new THREE.BoxGeometry(0.32, 0.07, 0.295)),
    materials.trim,
    'chestStripe',
  );
  chestStripe.position.set(0, 0.29, 0.015);
  torso.add(chestStripe);

  // Neck + Head Group
  const headGroup = new THREE.Group();
  headGroup.name = 'headGroup';
  headGroup.position.set(0, 0.56, 0.015);
  torso.add(headGroup);

  const neckMesh = makeShadowMesh(
    trackGeo(new THREE.CylinderGeometry(0.058, 0.068, 0.10, 10)),
    materials.skin,
    'neckMesh',
  );
  neckMesh.position.set(0, -0.05, 0);
  headGroup.add(neckMesh);

  const headMesh = makeShadowMesh(
    trackGeo(new THREE.SphereGeometry(0.155, 16, 14)),
    materials.skin,
    'headMesh',
  );
  headMesh.position.set(0, 0.09, 0);
  headGroup.add(headMesh);

  // Hair cap / stylized silhouette
  const hairCap = makeShadowMesh(
    trackGeo(new THREE.SphereGeometry(0.158, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55)),
    materials.hair,
    'hairCap',
  );
  hairCap.position.set(0, 0.105, -0.01);
  headGroup.add(hairCap);

  // Athletic hair bun / ponytail back silhouette (distinguishes facing + role)
  const hairTail = makeShadowMesh(
    trackGeo(
      safeRole === 'PARTNER'
        ? new THREE.CapsuleGeometry(0.045, 0.09, 5, 8)
        : new THREE.SphereGeometry(0.068, 10, 8),
    ),
    materials.hair,
    'hairTail',
  );
  hairTail.position.set(0, 0.12, -0.155);
  hairTail.rotation.x = 0.55;
  headGroup.add(hairTail);

  // Vibrant headband
  const headband = makeShadowMesh(
    trackGeo(new THREE.TorusGeometry(0.152, 0.022, 8, 20)),
    materials.trim,
    'headband',
  );
  headband.position.set(0, 0.145, 0);
  headband.rotation.x = Math.PI / 2 + 0.12;
  headGroup.add(headband);

  // Sporty coastal visor peak facing +Z
  const visor = makeShadowMesh(
    trackGeo(new THREE.BoxGeometry(0.21, 0.024, 0.13)),
    materials.trim,
    'visor',
  );
  visor.position.set(0, 0.155, 0.145);
  visor.rotation.x = 0.14;
  headGroup.add(visor);

  // Reflective coastal sunglasses facing +Z
  const sunglasses = makeShadowMesh(
    trackGeo(new THREE.BoxGeometry(0.22, 0.065, 0.065)),
    materials.shades,
    'sunglasses',
  );
  sunglasses.position.set(0, 0.095, 0.132);
  headGroup.add(sunglasses);

  // Shared limb geometries (reused cleanly across left/right sides)
  const upperArmGeo = trackGeo(new THREE.CapsuleGeometry(0.052, LIMB_DIMS.ARM_UPPER - 0.10, 5, 10));
  const forearmGeo = trackGeo(new THREE.CapsuleGeometry(0.044, LIMB_DIMS.ARM_LOWER - 0.08, 5, 10));
  const wristTapeGeo = trackGeo(new THREE.CylinderGeometry(0.047, 0.047, 0.048, 10));
  const handGeo = trackGeo(new THREE.SphereGeometry(0.056, 10, 8));
  const jointCapGeo = trackGeo(new THREE.SphereGeometry(0.054, 10, 8));

  const thighGeo = trackGeo(new THREE.CapsuleGeometry(0.072, LIMB_DIMS.LEG_UPPER - 0.14, 5, 10));
  const shinGeo = trackGeo(new THREE.CapsuleGeometry(0.054, LIMB_DIMS.LEG_LOWER - 0.11, 5, 10));
  const kneeCapGeo = trackGeo(new THREE.SphereGeometry(0.062, 10, 8));
  const footGeo = trackGeo(new THREE.CapsuleGeometry(0.046, 0.11, 5, 8));

  function buildArm(sideSign, prefix) {
    const shoulder = new THREE.Group();
    shoulder.name = `${prefix}Shoulder`;
    shoulder.position.set(
      sideSign * LIMB_DIMS.SHOULDER_X,
      LIMB_DIMS.SHOULDER_Y,
      LIMB_DIMS.SHOULDER_Z,
    );
    torso.add(shoulder);

    const shoulderCap = makeShadowMesh(jointCapGeo, materials.skin, `${prefix}ShoulderCap`);
    shoulder.add(shoulderCap);

    const upperArmMesh = makeShadowMesh(upperArmGeo, materials.skin, `${prefix}UpperArm`);
    upperArmMesh.position.set(0, -LIMB_DIMS.ARM_UPPER * 0.5, 0);
    shoulder.add(upperArmMesh);

    const elbow = new THREE.Group();
    elbow.name = `${prefix}Elbow`;
    elbow.position.set(0, -LIMB_DIMS.ARM_UPPER, 0);
    shoulder.add(elbow);

    const forearmMesh = makeShadowMesh(forearmGeo, materials.skin, `${prefix}Forearm`);
    forearmMesh.position.set(0, -LIMB_DIMS.ARM_LOWER * 0.5, 0);
    elbow.add(forearmMesh);

    const wristBand = makeShadowMesh(wristTapeGeo, materials.tape, `${prefix}WristTape`);
    wristBand.position.set(0, -LIMB_DIMS.ARM_LOWER + 0.055, 0);
    elbow.add(wristBand);

    const hand = new THREE.Group();
    hand.name = `${prefix}Hand`;
    hand.position.set(0, -LIMB_DIMS.ARM_LOWER, 0);
    elbow.add(hand);

    const handMesh = makeShadowMesh(handGeo, materials.skin, `${prefix}HandMesh`);
    handMesh.scale.set(0.92, 1.15, 0.72);
    hand.add(handMesh);

    return { shoulder, elbow, hand };
  }

  function buildLeg(sideSign, prefix) {
    const hip = new THREE.Group();
    hip.name = `${prefix}Hip`;
    hip.position.set(sideSign * LIMB_DIMS.HIP_X, LIMB_DIMS.HIP_Y, 0);
    pelvis.add(hip);

    const thighMesh = makeShadowMesh(thighGeo, materials.shorts, `${prefix}ThighShorts`);
    thighMesh.position.set(0, -LIMB_DIMS.LEG_UPPER * 0.38, 0);
    thighMesh.scale.set(1.06, 0.65, 1.06);
    hip.add(thighMesh);

    const thighSkin = makeShadowMesh(thighGeo, materials.skin, `${prefix}ThighSkin`);
    thighSkin.position.set(0, -LIMB_DIMS.LEG_UPPER * 0.52, 0);
    hip.add(thighSkin);

    const knee = new THREE.Group();
    knee.name = `${prefix}Knee`;
    knee.position.set(0, -LIMB_DIMS.LEG_UPPER, 0);
    hip.add(knee);

    const kneeMesh = makeShadowMesh(kneeCapGeo, materials.skin, `${prefix}KneeCap`);
    knee.add(kneeMesh);

    const shinMesh = makeShadowMesh(shinGeo, materials.skin, `${prefix}Shin`);
    shinMesh.position.set(0, -LIMB_DIMS.LEG_LOWER * 0.5, 0);
    knee.add(shinMesh);

    const foot = new THREE.Group();
    foot.name = `${prefix}Foot`;
    foot.position.set(0, -LIMB_DIMS.LEG_LOWER, 0);
    knee.add(foot);

    const footMesh = makeShadowMesh(footGeo, materials.skin, `${prefix}FootMesh`);
    footMesh.rotation.x = Math.PI / 2;
    footMesh.position.set(0, -0.02, 0.055);
    foot.add(footMesh);

    return { hip, knee, foot };
  }

  // Local +X is left when facing +Z in right-handed Three.js
  const leftArm = buildArm(1, 'left');
  const rightArm = buildArm(-1, 'right');
  const leftLeg = buildLeg(1, 'left');
  const rightLeg = buildLeg(-1, 'right');

  const joints = {
    bodyPivot,
    pelvis,
    torso,
    headGroup,
    auraGroup,
    heatRingMesh,
    chargeRingMesh,
    leftShoulder: leftArm.shoulder,
    leftElbow: leftArm.elbow,
    leftHand: leftArm.hand,
    rightShoulder: rightArm.shoulder,
    rightElbow: rightArm.elbow,
    rightHand: rightArm.hand,
    leftHip: leftLeg.hip,
    leftKnee: leftLeg.knee,
    leftFoot: leftLeg.foot,
    rightHip: rightLeg.hip,
    rightKnee: rightLeg.knee,
    rightFoot: rightLeg.foot,
  };

  const spring = {
    scaleY: 1.0,
    scaleXZ: 1.0,
    velY: 0.0,
    targetY: 1.0,
    prevAirborne: false,
    prevStrikeCooldown: 0,
    prevAnimState: ANIM_STATES.IDLE,
    internalTime: 0,
  };

  return {
    root,
    id: safeId,
    team: safeTeam,
    role: safeRole,
    joints,
    spring,
    materials,
    _meta: {
      palette,
      baseAuraColor: new THREE.Color(palette.aura),
      geometries: ownedGeometries,
      disposed: false,
    },
  };
}

function stepSpringSquashStretch(spring, animState, isAirborne, chargeRatio, strikeCooldown, dt) {
  // Event impulses
  if (!spring.prevAirborne && isAirborne) {
    spring.velY += 4.2; // takeoff vertical stretch
  } else if (spring.prevAirborne && !isAirborne) {
    spring.velY -= 5.2; // landing sand compression squash
  }

  if (strikeCooldown > spring.prevStrikeCooldown + 0.02) {
    spring.velY += 2.6; // snappy strike pop
  }

  if (spring.prevAnimState !== ANIM_STATES.SAND_DIVE && animState === ANIM_STATES.SAND_DIVE) {
    spring.velY += 2.4; // dive launch elongation
  }

  // Target steady-state squash/stretch
  let targetY = 1.0 - 0.14 * chargeRatio;
  if (animState === ANIM_STATES.UNDERHAND_BUMP) {
    targetY -= 0.06;
  } else if (animState === ANIM_STATES.NET_BLOCK || animState === ANIM_STATES.JUMP_HEAT_SPIKE) {
    targetY += 0.06;
  } else if (isAirborne) {
    targetY += 0.04;
  }
  spring.targetY = clamp(targetY, 0.78, 1.18, 1.0);

  // Sub-stepped damped harmonic oscillator for unconditional stability
  if (dt > 0) {
    const stiffness = 145;
    const damping = 14.5;
    const subSteps = dt > 1 / 60 ? 2 : 1;
    const h = dt / subSteps;
    for (let i = 0; i < subSteps; i++) {
      const acc = stiffness * (spring.targetY - spring.scaleY) - damping * spring.velY;
      spring.velY += acc * h;
      spring.scaleY += spring.velY * h;
      if (spring.scaleY < 0.72) {
        spring.scaleY = 0.72;
        if (spring.velY < 0) spring.velY *= -0.25;
      } else if (spring.scaleY > 1.32) {
        spring.scaleY = 1.32;
        if (spring.velY > 0) spring.velY *= -0.25;
      }
    }
  }

  spring.scaleY = clamp(spring.scaleY, 0.72, 1.32, 1.0);
  spring.scaleXZ = 1 / Math.sqrt(spring.scaleY);
  spring.prevAirborne = isAirborne;
  spring.prevStrikeCooldown = strikeCooldown;
  spring.prevAnimState = animState;
}

/**
 * Update athlete rig pose, 2-bone procedural IK, spring squash-and-stretch,
 * and heat/charge aura visuals for the current frame.
 *
 * @param {object} rig - Rig returned by createPlayerRig
 * @param {object} playerState - PlayerState matching contracts.js
 * @param {object|null} ballState - BallState matching contracts.js (optional)
 * @param {number} dt - Frame delta seconds
 */
export function updatePlayerRig(rig, playerState, ballState, dt) {
  if (!rig || !rig.root || !rig.joints || !playerState) {
    return;
  }

  const safeDt = clamp(dt, 0, 0.05, 0);
  const { joints, spring, materials, _meta } = rig;
  spring.internalTime += safeDt;

  // Sanitize playerState fields
  const px = finiteOr(playerState.pos?.x, 0);
  const py = Math.max(0, finiteOr(playerState.pos?.y, 0));
  const pz = finiteOr(playerState.pos?.z, 0);
  const vx = finiteOr(playerState.vel?.x, 0);
  const vz = finiteOr(playerState.vel?.z, 0);
  const horizSpeed = Math.hypot(vx, vz);

  const defaultYaw = rig.team === 2 ? -Math.PI / 2 : Math.PI / 2;
  const facingYaw = finiteOr(playerState.facingYaw, defaultYaw);
  const rawAnim = playerState.animState;
  const animState = VALID_ANIM_STATES.has(rawAnim) ? rawAnim : ANIM_STATES.IDLE;
  const animTime = finiteOr(playerState.animTime, spring.internalTime);
  const animProgress = clamp(playerState.animProgress, 0, 1, 0);
  const chargeRatio = clamp(playerState.chargeRatio, 0, 1, 0);
  const heatMeter = clamp(playerState.heatMeter, 0, 1, 0);
  const isAirborne = Boolean(playerState.isAirborne || py > 0.08);
  const strikeCooldown = finiteOr(playerState.strikeCooldown, 0);

  // Position & align rig root
  rig.root.position.set(px, py, pz);
  rig.root.rotation.set(0, facingYaw, 0);

  // Keep grounded aura ring resting on the sand plane regardless of jump height
  joints.auraGroup.position.set(0, 0.03 - py, 0);

  // Update spring squash-and-stretch
  stepSpringSquashStretch(spring, animState, isAirborne, chargeRatio, strikeCooldown, safeDt);
  joints.bodyPivot.scale.set(spring.scaleXZ, spring.scaleY, spring.scaleXZ);

  // Reset base body/pelvis/torso transforms before applying state pose
  let pivotPosY = 0;
  let pivotPitch = 0;
  let pivotRoll = 0;
  let pelvisY = LIMB_DIMS.PELVIS_STAND_Y;
  let pelvisZ = 0;
  let pelvisPitch = 0;
  let torsoPitch = 0;
  let torsoYaw = 0;
  let torsoRoll = 0;

  // Default leg targets in pelvis-local space
  _vLeftFootTarget.set(0.15, -(LIMB_DIMS.PELVIS_STAND_Y - LIMB_DIMS.FOOT_SOLE_Y), 0.04);
  _vRightFootTarget.set(-0.15, -(LIMB_DIMS.PELVIS_STAND_Y - LIMB_DIMS.FOOT_SOLE_Y), -0.04);
  _vLeftLegPole.set(0.08, 0.15, 1.0);
  _vRightLegPole.set(-0.08, 0.15, 1.0);

  // Configure core body posture & leg IK targets per exact ANIM_STATE
  if (animState === ANIM_STATES.SPRINT) {
    const strideFreq = 7.5 + clamp(horizSpeed, 0, 10, 4) * 1.1;
    const cycle = animTime * strideFreq;
    const s = Math.sin(cycle);
    const c = Math.cos(cycle);

    pivotPitch = 0.20 + clamp(horizSpeed, 0, 9, 4) * 0.015;
    pelvisY = 0.85 + Math.abs(s) * 0.05;
    torsoYaw = -s * 0.24;
    torsoRoll = s * 0.06;

    _vLeftFootTarget.set(0.15, -0.78 + Math.max(0, s) * 0.22, s * 0.34);
    _vRightFootTarget.set(-0.15, -0.78 + Math.max(0, -s) * 0.22, -s * 0.34);
    _vLeftLegPole.set(0.06, 0.12 + Math.max(0, c) * 0.1, 1.0);
    _vRightLegPole.set(-0.06, 0.12 + Math.max(0, -c) * 0.1, 1.0);
  } else if (animState === ANIM_STATES.UNDERHAND_BUMP) {
    const bounce = Math.sin(animProgress * Math.PI) * 0.07;
    pelvisY = 0.67 + bounce;
    pelvisZ = -0.08;
    torsoPitch = 0.44 - bounce * 1.1;
    _vLeftFootTarget.set(0.24, -(pelvisY - LIMB_DIMS.FOOT_SOLE_Y), 0.14);
    _vRightFootTarget.set(-0.24, -(pelvisY - LIMB_DIMS.FOOT_SOLE_Y), -0.06);
    _vLeftLegPole.set(0.28, 0.18, 1.0);
    _vRightLegPole.set(-0.28, 0.18, 1.0);
  } else if (animState === ANIM_STATES.OVERHEAD_SET) {
    const ext = Math.sin(animProgress * Math.PI) * 0.09;
    pelvisY = 0.86 + ext;
    torsoPitch = -0.14 - ext * 0.4;
    _vLeftFootTarget.set(0.18, -(pelvisY - LIMB_DIMS.FOOT_SOLE_Y), 0.12);
    _vRightFootTarget.set(-0.18, -(pelvisY - LIMB_DIMS.FOOT_SOLE_Y), -0.08);
    _vLeftLegPole.set(0.14, 0.2, 1.0);
    _vRightLegPole.set(-0.14, 0.2, 1.0);
  } else if (animState === ANIM_STATES.JUMP_HEAT_SPIKE) {
    // Smooth windup (0..0.45) into explosive whip follow-through (0.45..1.0)
    const whipT = clamp((animProgress - 0.35) / 0.40, 0, 1, 0);
    const smoothWhip = whipT * whipT * (3 - 2 * whipT);

    pelvisY = 0.94;
    torsoPitch = THREE.MathUtils.lerp(-0.32, 0.38, smoothWhip);
    torsoYaw = THREE.MathUtils.lerp(-0.48, 0.42, smoothWhip);
    torsoRoll = THREE.MathUtils.lerp(0.14, -0.10, smoothWhip);

    // Athletic tucked airborne jump legs
    const tuck = 1 - smoothWhip * 0.45;
    _vLeftFootTarget.set(0.16, -0.58, -0.34 * tuck + 0.16 * smoothWhip);
    _vRightFootTarget.set(-0.16, -0.54, -0.40 * tuck + 0.12 * smoothWhip);
    _vLeftLegPole.set(0.1, -0.1, 1.0);
    _vRightLegPole.set(-0.1, -0.1, 1.0);
  } else if (animState === ANIM_STATES.NET_BLOCK) {
    pelvisY = 0.95;
    torsoPitch = 0.08;
    _vLeftFootTarget.set(0.16, -0.82, -0.05);
    _vRightFootTarget.set(-0.16, -0.82, -0.05);
    _vLeftLegPole.set(0.12, 0.1, 1.0);
    _vRightLegPole.set(-0.12, 0.1, 1.0);
  } else if (animState === ANIM_STATES.SAND_DIVE) {
    // Full horizontal layout near sand plane
    pivotPosY = 0.24;
    pivotPitch = 1.28;
    pelvisY = 0.30;
    pelvisZ = -0.18;
    torsoPitch = -0.18; // chest lifted slightly to sight ball
    _vLeftFootTarget.set(0.14, -0.78, -0.14);
    _vRightFootTarget.set(-0.14, -0.76, -0.22);
    _vLeftLegPole.set(0.1, 0.0, 1.0);
    _vRightLegPole.set(-0.1, 0.0, 1.0);
  } else {
    // ANIM_STATES.IDLE (and fallback for unknown states)
    const breathe = Math.sin(animTime * 3.1) * 0.025;
    const crouchCharge = chargeRatio * 0.14;
    pelvisY = 0.87 - crouchCharge + breathe;
    torsoPitch = 0.10 + chargeRatio * 0.18;
    _vLeftFootTarget.set(0.17, -(pelvisY - LIMB_DIMS.FOOT_SOLE_Y), 0.07);
    _vRightFootTarget.set(-0.17, -(pelvisY - LIMB_DIMS.FOOT_SOLE_Y), -0.07);
    _vLeftLegPole.set(0.14, 0.16, 1.0);
    _vRightLegPole.set(-0.14, 0.16, 1.0);
  }

  joints.bodyPivot.position.set(0, pivotPosY, 0);
  joints.bodyPivot.rotation.set(pivotPitch, 0, pivotRoll);
  joints.pelvis.position.set(0, pelvisY, pelvisZ);
  joints.pelvis.rotation.set(pelvisPitch, 0, 0);
  joints.torso.rotation.set(torsoPitch, torsoYaw, torsoRoll);

  // Update world matrices up through torso so ball targets transform accurately into local spaces
  rig.root.updateMatrixWorld(true);

  // Compute ball / targetBallPos in torso-local and root-local space
  const targetSource = playerState.targetBallPos || (ballState && ballState.pos) || null;
  let hasBallTarget = false;
  if (targetSource !== null && typeof targetSource === 'object') {
    const bx = finiteOr(targetSource.x, NaN);
    const by = finiteOr(targetSource.y, NaN);
    const bz = finiteOr(targetSource.z, NaN);
    if (Number.isFinite(bx) && Number.isFinite(by) && Number.isFinite(bz)) {
      _vBallWorld.set(bx, by, bz);
      _mInvTorso.copy(joints.torso.matrixWorld).invert();
      _vBallLocalTorso.copy(_vBallWorld).applyMatrix4(_mInvTorso);
      _mInvRoot.copy(rig.root.matrixWorld).invert();
      _vBallLocalRoot.copy(_vBallWorld).applyMatrix4(_mInvRoot);
      hasBallTarget = true;
    }
  }

  // Head look-tracking toward ball (clamped to natural anatomical range)
  if (hasBallTarget) {
    const lookYaw = clamp(Math.atan2(_vBallLocalRoot.x, Math.max(0.25, _vBallLocalRoot.z)), -0.65, 0.65, 0);
    const dyHead = _vBallLocalRoot.y - (pelvisY + 0.62);
    const horizDist = Math.hypot(_vBallLocalRoot.x, _vBallLocalRoot.z);
    const lookPitch = clamp(-Math.atan2(dyHead, Math.max(0.5, horizDist)), -0.65, 0.45, 0);
    joints.headGroup.rotation.set(lookPitch, lookYaw, 0);
  } else {
    joints.headGroup.rotation.set(0, 0, 0);
  }

  // Arm IK targets in torso-local space (+X = left, -X = right, +Y = up, +Z = forward)
  _vLeftArmPole.set(0.45, -0.35, -0.65);
  _vRightArmPole.set(-0.45, -0.35, -0.65);

  if (animState === ANIM_STATES.SPRINT) {
    const strideFreq = 7.5 + clamp(horizSpeed, 0, 10, 4) * 1.1;
    const s = Math.sin(animTime * strideFreq);
    _vLeftHandTarget.set(0.28, 0.14 + Math.max(0, -s) * 0.16, -s * 0.34 + 0.12);
    _vRightHandTarget.set(-0.28, 0.14 + Math.max(0, s) * 0.16, s * 0.34 + 0.12);
    _vLeftArmPole.set(0.5, -0.4, -0.8);
    _vRightArmPole.set(-0.5, -0.4, -0.8);
  } else if (animState === ANIM_STATES.UNDERHAND_BUMP) {
    // Converged forearm platform reaching dynamically toward ball contact
    let tx = 0;
    let ty = 0.08;
    let tz = 0.50;
    if (hasBallTarget) {
      tx = clamp(_vBallLocalTorso.x * 0.55, -0.28, 0.28, 0);
      ty = clamp(_vBallLocalTorso.y, -0.15, 0.32, 0.08);
      tz = clamp(_vBallLocalTorso.z, 0.34, 0.60, 0.50);
    }
    _vLeftHandTarget.set(tx + 0.045, ty, tz);
    _vRightHandTarget.set(tx - 0.045, ty, tz);
    _vLeftArmPole.set(0.35, -0.85, 0.2);
    _vRightArmPole.set(-0.35, -0.85, 0.2);
  } else if (animState === ANIM_STATES.OVERHEAD_SET) {
    // High fingertip cradle framing overhead ball
    let tx = 0;
    let ty = 0.84;
    let tz = 0.26;
    if (hasBallTarget) {
      tx = clamp(_vBallLocalTorso.x * 0.4, -0.22, 0.22, 0);
      ty = clamp(_vBallLocalTorso.y, 0.72, 0.98, 0.84);
      tz = clamp(_vBallLocalTorso.z, 0.12, 0.42, 0.26);
    }
    _vLeftHandTarget.set(tx + 0.13, ty, tz);
    _vRightHandTarget.set(tx - 0.13, ty, tz);
    _vLeftArmPole.set(0.85, 0.15, 0.45);
    _vRightArmPole.set(-0.85, 0.15, 0.45);
  } else if (animState === ANIM_STATES.JUMP_HEAT_SPIKE) {
    // Dominant right arm (-X side) cocks high behind head then whips through ball contact
    const whipT = clamp((animProgress - 0.35) / 0.40, 0, 1, 0);
    const smoothWhip = whipT * whipT * (3 - 2 * whipT);

    // Off-arm (left) sights upward during windup then pulls down for torque
    _vLeftHandTarget.set(
      0.24,
      THREE.MathUtils.lerp(0.84, 0.10, smoothWhip),
      THREE.MathUtils.lerp(0.34, 0.18, smoothWhip),
    );
    _vLeftArmPole.set(0.75, 0.1, 0.2);

    // Dominant spiking right arm
    let strikeX = -0.18;
    let strikeY = 0.86;
    let strikeZ = 0.38;
    if (hasBallTarget) {
      strikeX = clamp(_vBallLocalTorso.x, -0.45, 0.15, -0.18);
      strikeY = clamp(_vBallLocalTorso.y, 0.58, 0.98, 0.86);
      strikeZ = clamp(_vBallLocalTorso.z, 0.18, 0.52, 0.38);
    }

    if (animProgress < 0.38) {
      // Cocked bowstring windup
      _vRightHandTarget.set(-0.36, 0.82, -0.18);
    } else if (animProgress < 0.72) {
      // Explosive strike contact toward ball
      const tHit = clamp((animProgress - 0.38) / 0.34, 0, 1, 1);
      _vRightHandTarget.set(
        THREE.MathUtils.lerp(-0.36, strikeX, tHit),
        THREE.MathUtils.lerp(0.82, strikeY, tHit),
        THREE.MathUtils.lerp(-0.18, strikeZ, tHit),
      );
    } else {
      // Follow-through snap across torso
      const tFollow = clamp((animProgress - 0.72) / 0.28, 0, 1, 1);
      _vRightHandTarget.set(
        THREE.MathUtils.lerp(strikeX, -0.05, tFollow),
        THREE.MathUtils.lerp(strikeY, 0.18, tFollow),
        THREE.MathUtils.lerp(strikeZ, 0.42, tFollow),
      );
    }
    _vRightArmPole.set(-0.85, 0.35, -0.35);
  } else if (animState === ANIM_STATES.NET_BLOCK) {
    // Both hands towering overhead forming a tight blocking wall
    const blockX = hasBallTarget ? clamp(_vBallLocalTorso.x * 0.35, -0.20, 0.20, 0) : 0;
    _vLeftHandTarget.set(blockX + 0.15, 0.98, 0.26);
    _vRightHandTarget.set(blockX - 0.15, 0.98, 0.26);
    _vLeftArmPole.set(0.35, 0.2, 0.65);
    _vRightArmPole.set(-0.35, 0.2, 0.65);
  } else if (animState === ANIM_STATES.SAND_DIVE) {
    // Lead right arm outstretched forward for desperate pancake dig save
    let digX = -0.12;
    let digY = 0.94;
    let digZ = 0.22;
    if (hasBallTarget) {
      digX = clamp(_vBallLocalTorso.x * 0.5, -0.35, 0.25, -0.12);
      digY = clamp(_vBallLocalTorso.y, 0.65, 1.0, 0.94);
      digZ = clamp(_vBallLocalTorso.z, 0.05, 0.42, 0.22);
    }
    _vRightHandTarget.set(digX, digY, digZ);
    _vLeftHandTarget.set(0.34, 0.28, 0.28);
    _vRightArmPole.set(-0.4, 0.2, -0.7);
    _vLeftArmPole.set(0.7, -0.2, -0.5);
  } else {
    // Idle ready stance with subtle charge anticipation coil
    const sway = Math.sin(animTime * 3.1) * 0.025;
    const coil = chargeRatio * 0.12;
    _vLeftHandTarget.set(0.26 - coil * 0.4, 0.14 + sway - coil * 0.4, 0.30 + coil * 0.4);
    _vRightHandTarget.set(-0.26 + coil * 0.4, 0.14 - sway - coil * 0.4, 0.30 + coil * 0.4);
    _vLeftArmPole.set(0.65, -0.3, -0.55);
    _vRightArmPole.set(-0.65, -0.3, -0.55);
  }

  // Solve 2-bone IK for arms in torso space and legs in pelvis space
  applyTwoBoneLimb(
    joints.leftShoulder,
    joints.leftElbow,
    _vLeftHandTarget,
    _vLeftArmPole,
    LIMB_DIMS.ARM_UPPER,
    LIMB_DIMS.ARM_LOWER,
  );
  applyTwoBoneLimb(
    joints.rightShoulder,
    joints.rightElbow,
    _vRightHandTarget,
    _vRightArmPole,
    LIMB_DIMS.ARM_UPPER,
    LIMB_DIMS.ARM_LOWER,
  );

  // Solve 2-bone IK for legs in pelvis-local space
  applyTwoBoneLimb(
    joints.leftHip,
    joints.leftKnee,
    _vLeftFootTarget,
    _vLeftLegPole,
    LIMB_DIMS.LEG_UPPER,
    LIMB_DIMS.LEG_LOWER,
  );
  applyTwoBoneLimb(
    joints.rightHip,
    joints.rightKnee,
    _vRightFootTarget,
    _vRightLegPole,
    LIMB_DIMS.LEG_UPPER,
    LIMB_DIMS.LEG_LOWER,
  );

  // Update grounded Heat & Charge Aura + subtle Heat emissive boost
  const pulse = 0.5 + 0.5 * Math.sin(spring.internalTime * 9.0);
  const fullHeat = heatMeter >= 0.99;

  if (heatMeter > 0.02) {
    _cTmp.copy(_meta.baseAuraColor).lerp(COLOR_HEAT_ORANGE, clamp(heatMeter * 1.15, 0, 1, 0));
    if (fullHeat) {
      _cTmp.lerp(COLOR_HEAT_GOLD, 0.45 + 0.45 * pulse);
    }
    materials.heatRing.color.copy(_cTmp);
    materials.heatRing.opacity = 0.30 + heatMeter * 0.48 + (fullHeat ? pulse * 0.22 : 0);
    const ringScale = 1.0 + heatMeter * 0.14 + (fullHeat ? pulse * 0.12 : 0);
    joints.heatRingMesh.scale.set(ringScale, ringScale, 1);
  } else {
    materials.heatRing.color.copy(_meta.baseAuraColor);
    materials.heatRing.opacity = 0.28;
    joints.heatRingMesh.scale.set(1, 1, 1);
  }

  if (chargeRatio > 0.01) {
    materials.chargeRing.color.copy(COLOR_CHARGE_GLOW);
    materials.chargeRing.opacity = 0.25 + chargeRatio * 0.65;
    const cScale = 0.55 + chargeRatio * 0.65;
    joints.chargeRingMesh.scale.set(cScale, cScale, 1);
  } else {
    materials.chargeRing.opacity = 0.0;
    joints.chargeRingMesh.scale.set(0.55, 0.55, 1);
  }

  // Emissive heat sheen on jersey & trim
  const heatGlow = heatMeter > 0.5 ? (heatMeter - 0.5) * 2 : 0;
  materials.jersey.emissiveIntensity = 0.06 + heatGlow * 0.28 + (fullHeat ? pulse * 0.18 : 0);
  materials.trim.emissiveIntensity = 0.15 + heatGlow * 0.38 + chargeRatio * 0.25;

  rig.root.updateMatrixWorld(true);
}

/**
 * Dispose all geometries and materials owned by a player rig.
 * Safe and idempotent on repeated calls.
 *
 * @param {object} rig
 */
export function disposePlayerRig(rig) {
  if (!rig || !rig._meta || rig._meta.disposed) {
    return;
  }
  rig._meta.disposed = true;

  const geos = rig._meta.geometries;
  if (Array.isArray(geos)) {
    for (let i = 0; i < geos.length; i++) {
      if (geos[i] && typeof geos[i].dispose === 'function') {
        geos[i].dispose();
      }
    }
    geos.length = 0;
  }

  if (rig.materials && typeof rig.materials === 'object') {
    const matKeys = Object.keys(rig.materials);
    for (let i = 0; i < matKeys.length; i++) {
      const mat = rig.materials[matKeys[i]];
      if (mat && typeof mat.dispose === 'function') {
        if (mat.map && typeof mat.map.dispose === 'function') {
          mat.map.dispose();
        }
        mat.dispose();
      }
    }
  }
}
