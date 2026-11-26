import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/three.module.min.js';
import {
  ANIM_STATES,
  BALL_SPEC,
  CAMERA_MODES,
  COURT,
  EVENTS,
  MATCH_FORMATS,
  TRAIL_MODES,
  WIND_PHASES,
  createBallState,
  createPlayerState,
  createWindState,
} from '../../src/contracts.js';
import {
  solveTwoBoneIK,
  createPlayerRig,
  updatePlayerRig,
  disposePlayerRig,
} from '../../src/playerRigs.js';
import { createCourtScene } from '../../src/courtScene.js';

function assertFiniteVec3(v, label = 'vec3') {
  assert.ok(
    Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z),
    `${label} must be finite, got (${v.x}, ${v.y}, ${v.z})`,
  );
}

function assertRigMatricesFinite(rig) {
  rig.root.updateMatrixWorld(true);
  rig.root.traverse((obj) => {
    const els = obj.matrixWorld.elements;
    for (let i = 0; i < 16; i++) {
      assert.ok(Number.isFinite(els[i]), `Non-finite matrix element on ${obj.name}`);
    }
  });
}

function createMockRenderer() {
  const calls = [];
  let lastScene = null;
  const camerasRendered = [];
  let disposeCount = 0;

  return {
    shadowMap: { enabled: false, type: null },
    toneMapping: null,
    toneMappingExposure: 1,
    outputColorSpace: null,
    pixelRatio: 1,
    size: { w: 0, h: 0, updateStyle: null },
    scissorTest: false,
    clearColor: null,
    calls,
    camerasRendered,
    getLastScene: () => lastScene,
    getDisposeCount: () => disposeCount,
    setPixelRatio(r) {
      this.pixelRatio = r;
      calls.push({ fn: 'setPixelRatio', r });
    },
    setClearColor(color, alpha) {
      this.clearColor = { color, alpha };
      calls.push({ fn: 'setClearColor', color, alpha });
    },
    setSize(w, h, updateStyle) {
      this.size = { w, h, updateStyle };
      calls.push({ fn: 'setSize', w, h, updateStyle });
    },
    setViewport(x, y, w, h) {
      calls.push({ fn: 'setViewport', x, y, w, h });
    },
    setScissor(x, y, w, h) {
      calls.push({ fn: 'setScissor', x, y, w, h });
    },
    setScissorTest(enabled) {
      this.scissorTest = enabled;
      calls.push({ fn: 'setScissorTest', enabled });
    },
    clear() {
      calls.push({ fn: 'clear' });
    },
    render(scene, camera) {
      lastScene = scene;
      camerasRendered.push(camera);
      calls.push({
        fn: 'render',
        camera,
        aspect: camera.aspect,
        scissorTest: this.scissorTest,
        pos: camera.position.clone(),
      });
    },
    dispose() {
      disposeCount++;
      calls.push({ fn: 'dispose' });
    },
  };
}

function createMockCanvasFactory() {
  const canvases = [];
  const factory = (width, height) => {
    let fillTextCalls = 0;
    let fillRectCalls = 0;
    const ctx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      fillRect() {
        fillRectCalls++;
      },
      strokeRect() {},
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      bezierCurveTo() {},
      arc() {},
      stroke() {},
      fill() {},
      fillText() {
        fillTextCalls++;
      },
      createRadialGradient() {
        return { addColorStop() {} };
      },
      getStats() {
        return { fillTextCalls, fillRectCalls };
      },
    };
    const canvas = {
      width,
      height,
      getContext(type) {
        return type === '2d' ? ctx : null;
      },
      _ctx: ctx,
    };
    canvases.push(canvas);
    return canvas;
  };
  factory.canvases = canvases;
  return factory;
}

function makeSampleSnapshot(overrides = {}) {
  const ball = createBallState({
    pos: { x: -2.2, y: 3.1, z: 0.4 },
    vel: { x: 6.5, y: 2.0, z: -0.5 },
    omega: { x: 0, y: 2.0, z: -12.0 },
    spinAngle: { x: 0.4, y: 0.8, z: -1.2 },
    trailMode: TRAIL_MODES.FLAME,
    active: true,
    ...(overrides.ball || {}),
  });
  const wind = createWindState({
    time: 4.5,
    phase: WIND_PHASES.BREEZE,
    windVec3: { x: 3.2, y: 0.1, z: -1.1 },
    speed: 3.38,
    ...(overrides.wind || {}),
  });
  const players = overrides.players || [
    createPlayerState({
      id: 'p1',
      team: 1,
      role: 'PRIMARY',
      pos: { x: -4.2, y: 0, z: 0.3 },
      facingYaw: Math.PI / 2,
      animState: ANIM_STATES.UNDERHAND_BUMP,
      heatMeter: 0.8,
      chargeRatio: 0.5,
    }),
    createPlayerState({
      id: 'p2',
      team: 2,
      role: 'PRIMARY',
      pos: { x: 4.0, y: 0, z: -0.2 },
      facingYaw: -Math.PI / 2,
      animState: ANIM_STATES.IDLE,
      heatMeter: 0.3,
    }),
  ];

  return {
    ball,
    wind,
    prediction:
      overrides.prediction !== undefined
        ? overrides.prediction
        : { x: 3.5, z: -0.6, hangTime: 0.65, landedWithinSteps: true, steps: 78 },
    players,
    timingRing:
      overrides.timingRing !== undefined
        ? overrides.timingRing
        : {
            active: true,
            x: -1.2,
            y: 3.4,
            z: 0.2,
            progress: 0.5,
            radius: 1.0,
            sweetMin: 0.7,
            sweetMax: 0.94,
            isSweetSpot: false,
          },
    scoreboard: {
      scoreT1: 3,
      scoreT2: 2,
      servingTeam: 1,
      heatT1: 0.8,
      heatT2: 0.3,
      touchCount: 2,
      activeTeam: 1,
      windPhase: wind.phase,
      windSpeedMs: wind.speed,
      bannerText: 'HEAT SPIKE!',
      bannerColor: '#ff7b00',
      format: players.length > 2 ? MATCH_FORMATS.TWO_V_TWO : MATCH_FORMATS.ONE_V_ONE,
      aiStyle: 'SPIN_SLICER',
      ...(overrides.scoreboard || {}),
    },
    cameraPunch: overrides.cameraPunch ?? 0,
    hitStopFrames: overrides.hitStopFrames ?? 0,
    events: overrides.events ?? [],
  };
}

describe('playerRigs.js — Rig Creation, 2-Bone IK, 7 Anim States & Disposal', () => {
  it('creates distinct Team 1/2 and PRIMARY/PARTNER hierarchical rigs with shadow-casting limbs', () => {
    const t1Primary = createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const t1Partner = createPlayerRig({ id: 'p1b', team: 1, role: 'PARTNER' });
    const t2Primary = createPlayerRig({ id: 'p2', team: 2, role: 'PRIMARY' });
    const t2Partner = createPlayerRig({ id: 'p2b', team: 2, role: 'PARTNER' });

    assert.ok(t1Primary.root instanceof THREE.Group);
    assert.equal(t1Primary.team, 1);
    assert.equal(t1Primary.role, 'PRIMARY');
    assert.equal(t1Partner.role, 'PARTNER');
    assert.equal(t2Primary.team, 2);
    assert.equal(t2Partner.role, 'PARTNER');

    // Distinct team & partner jersey colors
    assert.notEqual(
      t1Primary.materials.jersey.color.getHex(),
      t2Primary.materials.jersey.color.getHex(),
    );
    assert.notEqual(
      t1Primary.materials.jersey.color.getHex(),
      t1Partner.materials.jersey.color.getHex(),
    );
    assert.notEqual(
      t2Primary.materials.jersey.color.getHex(),
      t2Partner.materials.jersey.color.getHex(),
    );

    // Essential hierarchy joints exist
    for (const key of [
      'bodyPivot',
      'pelvis',
      'torso',
      'headGroup',
      'leftShoulder',
      'leftElbow',
      'leftHand',
      'rightShoulder',
      'rightElbow',
      'rightHand',
      'leftHip',
      'leftKnee',
      'leftFoot',
      'rightHip',
      'rightKnee',
      'rightFoot',
      'auraGroup',
    ]) {
      assert.ok(t1Primary.joints[key], `Missing joint ${key}`);
    }

    let shadowCasterCount = 0;
    t1Primary.root.traverse((obj) => {
      if (obj.isMesh && obj.castShadow) shadowCasterCount++;
    });
    assert.ok(shadowCasterCount >= 12, `Expected >= 12 shadow-casting limb meshes, got ${shadowCasterCount}`);

    disposePlayerRig(t1Primary);
    disposePlayerRig(t1Partner);
    disposePlayerRig(t2Primary);
    disposePlayerRig(t2Partner);
  });

  it('solveTwoBoneIK solves exact bone lengths and safely clamps near, unreachable, zero, and NaN targets', () => {
    const l1 = 0.30;
    const l2 = 0.28;
    const origin = { x: 0.25, y: 0.42, z: 0.01 };
    const pole = { x: 0.5, y: -0.3, z: -0.6 };

    // 1. Reachable normal target
    const target = { x: 0.15, y: 0.22, z: 0.40 };
    const sol = solveTwoBoneIK(origin, target, pole, l1, l2);
    assert.equal(sol.clamped, false);
    assertFiniteVec3(sol.mid, 'mid');
    assertFiniteVec3(sol.end, 'end');
    const originV = new THREE.Vector3(origin.x, origin.y, origin.z);
    const targetV = new THREE.Vector3(target.x, target.y, target.z);
    assert.ok(Math.abs(sol.mid.distanceTo(originV) - l1) < 1e-5);
    assert.ok(Math.abs(sol.end.distanceTo(sol.mid) - l2) < 1e-5);
    assert.ok(sol.end.distanceTo(targetV) < 1e-5);

    // 2. Unreachable distant target (1000m)
    const farSol = solveTwoBoneIK(origin, { x: 1000, y: 500, z: 1000 }, pole, l1, l2);
    assert.equal(farSol.clamped, true);
    assertFiniteVec3(farSol.mid, 'farMid');
    assertFiniteVec3(farSol.end, 'farEnd');
    assert.ok(farSol.end.distanceTo(originV) <= l1 + l2);

    // 3. Zero-distance target (origin === target)
    const zeroSol = solveTwoBoneIK(origin, origin, pole, l1, l2);
    assert.equal(zeroSol.clamped, true);
    assertFiniteVec3(zeroSol.mid, 'zeroMid');
    assertFiniteVec3(zeroSol.end, 'zeroEnd');

    // 4. NaN / Infinity hostile inputs
    const hostileSol = solveTwoBoneIK(
      { x: NaN, y: Infinity, z: -Infinity },
      { x: NaN, y: NaN, z: Infinity },
      { x: 0, y: 0, z: 0 },
      l1,
      l2,
    );
    assertFiniteVec3(hostileSol.mid, 'hostileMid');
    assertFiniteVec3(hostileSol.end, 'hostileEnd');
    assertFiniteVec3(hostileSol.upperDir, 'hostileUpperDir');
    assertFiniteVec3(hostileSol.lowerDir, 'hostileLowerDir');
  });

  it('animates all 7 ANIM_STATES with distinct, coherent poses and safely falls back on unknown states', () => {
    const rig = createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const ball = createBallState({ pos: { x: -3.4, y: 1.9, z: 0.1 } });
    const poseSignatures = new Map();

    const leftHandW = new THREE.Vector3();
    const rightHandW = new THREE.Vector3();
    const pelvisW = new THREE.Vector3();

    for (const stateName of Object.values(ANIM_STATES)) {
      const ps = createPlayerState({
        id: 'p1',
        team: 1,
        pos: { x: -4.0, y: stateName === ANIM_STATES.JUMP_HEAT_SPIKE || stateName === ANIM_STATES.NET_BLOCK ? 1.0 : 0, z: 0 },
        vel: stateName === ANIM_STATES.SPRINT ? { x: 5.5, y: 0, z: 0 } : { x: 0, y: 0, z: 0 },
        facingYaw: Math.PI / 2,
        animState: stateName,
        animTime: 0.45,
        animProgress: 0.55,
        isAirborne: stateName === ANIM_STATES.JUMP_HEAT_SPIKE || stateName === ANIM_STATES.NET_BLOCK,
        targetBallPos: { x: -3.5, y: 1.85, z: 0.05 },
      });

      updatePlayerRig(rig, ps, ball, 1 / 60);
      assertRigMatricesFinite(rig);

      rig.joints.leftHand.getWorldPosition(leftHandW);
      rig.joints.rightHand.getWorldPosition(rightHandW);
      rig.joints.pelvis.getWorldPosition(pelvisW);

      poseSignatures.set(stateName, {
        lh: leftHandW.clone(),
        rh: rightHandW.clone(),
        pelvisY: pelvisW.y,
        pivotPitch: rig.joints.bodyPivot.rotation.x,
        handGap: leftHandW.distanceTo(rightHandW),
      });
    }

    // Physical pose coherence checks
    const dive = poseSignatures.get(ANIM_STATES.SAND_DIVE);
    const idle = poseSignatures.get(ANIM_STATES.IDLE);
    const bump = poseSignatures.get(ANIM_STATES.UNDERHAND_BUMP);
    const setPose = poseSignatures.get(ANIM_STATES.OVERHEAD_SET);
    const block = poseSignatures.get(ANIM_STATES.NET_BLOCK);
    const spike = poseSignatures.get(ANIM_STATES.JUMP_HEAT_SPIKE);

    assert.ok(dive.pivotPitch > 1.0, `SandDive should pitch horizontally, got ${dive.pivotPitch}`);
    assert.ok(dive.pelvisY < idle.pelvisY - 0.25, 'SandDive should lower pelvis near sand');
    assert.ok(bump.handGap < 0.22, `UnderhandBump hands should converge tightly, got gap ${bump.handGap}`);
    assert.ok(setPose.lh.y > bump.lh.y + 0.35, 'OverheadSet hands should be higher than UnderhandBump');
    assert.ok(block.lh.y > 2.4 && block.rh.y > 2.4, 'NetBlock airborne hands should tower above net height');
    assert.ok(spike.rh.y > idle.rh.y + 0.5, 'JumpHeatSpike spiking hand should reach high');

    // Unknown animState falls back cleanly to Idle without throwing
    assert.doesNotThrow(() => {
      updatePlayerRig(
        rig,
        createPlayerState({ animState: 'NON_EXISTENT_STATE', pos: { x: -4, y: 0, z: 0 } }),
        null,
        NaN,
      );
    });
    assertRigMatricesFinite(rig);

    disposePlayerRig(rig);
  });

  it('drives bounded volume-preserving spring squash-and-stretch and grounded heat/charge aura', () => {
    const rig = createPlayerRig({ id: 'p1', team: 1, role: 'PRIMARY' });
    const ball = createBallState({ pos: { x: 0, y: 2, z: 0 } });

    // Grounded baseline
    updatePlayerRig(rig, createPlayerState({ pos: { x: -4, y: 0, z: 0 }, isAirborne: false }), ball, 1 / 60);

    // Takeoff triggers upward stretch (scaleY > 1)
    updatePlayerRig(
      rig,
      createPlayerState({ pos: { x: -4, y: 1.5, z: 0 }, isAirborne: true, heatMeter: 1.0, chargeRatio: 0.8 }),
      ball,
      1 / 60,
    );
    assert.ok(rig.spring.scaleY > 1.01, `Takeoff should stretch scaleY > 1, got ${rig.spring.scaleY}`);
    assert.ok(rig.spring.scaleY >= 0.72 && rig.spring.scaleY <= 1.32);

    // Volume preservation: scaleXZ^2 * scaleY === 1
    const vol = rig.spring.scaleXZ * rig.spring.scaleXZ * rig.spring.scaleY;
    assert.ok(Math.abs(vol - 1.0) < 1e-6, `Expected volume=1, got ${vol}`);

    // Aura stays grounded on sand despite pos.y === 1.5
    const auraWorld = new THREE.Vector3();
    rig.joints.auraGroup.getWorldPosition(auraWorld);
    assert.ok(Math.abs(auraWorld.y - 0.03) < 1e-4, `Aura must stay grounded at y=0.03, got ${auraWorld.y}`);
    assert.ok(rig.materials.chargeRing.opacity > 0.5, 'Charge ring should glow when chargeRatio=0.8');
    assert.ok(rig.materials.heatRing.opacity > 0.7, 'Heat ring should glow strongly at max heat');

    // Landing triggers compression squash (scaleY < 1)
    for (let i = 0; i < 4; i++) {
      updatePlayerRig(rig, createPlayerState({ pos: { x: -4, y: 0, z: 0 }, isAirborne: false }), ball, 1 / 60);
    }
    assert.ok(rig.spring.scaleY < 0.98, `Landing should squash scaleY < 1, got ${rig.spring.scaleY}`);
    assert.ok(rig.spring.scaleY >= 0.72 && rig.spring.scaleY <= 1.32);

    // Idempotent disposal
    assert.doesNotThrow(() => {
      disposePlayerRig(rig);
      disposePlayerRig(rig);
    });
  });
});

describe('courtScene.js — Stadium, Effects, LED Dirty-Check, Cameras & Zero Allocations', () => {
  it('configures renderer hygiene, 1024x1024 PCF soft shadows, and pixel ratio cap', () => {
    const renderer = createMockRenderer();
    const canvasFactory = createMockCanvasFactory();
    const ctrl = createCourtScene(null, {
      renderer,
      createCanvas: canvasFactory,
      width: 1280,
      height: 720,
    });

    assert.equal(renderer.shadowMap.enabled, true);
    assert.equal(renderer.shadowMap.type, THREE.PCFSoftShadowMap);
    assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);
    assert.equal(renderer.outputColorSpace, THREE.SRGBColorSpace);
    assert.ok(renderer.pixelRatio >= 1 && renderer.pixelRatio <= 2);

    ctrl.render(CAMERA_MODES.BROADCAST);
    const scene = renderer.getLastScene();
    assert.ok(scene instanceof THREE.Scene);

    let shadowLightFound = false;
    scene.traverse((obj) => {
      if (obj.isDirectionalLight && obj.castShadow) {
        shadowLightFound = true;
        assert.equal(obj.shadow.mapSize.width, 1024);
        assert.equal(obj.shadow.mapSize.height, 1024);
      }
    });
    assert.ok(shadowLightFound, 'Expected 1024x1024 shadow-casting directional sun light');

    ctrl.dispose();
    assert.equal(renderer.getDisposeCount(), 1);
    // Idempotent dispose
    ctrl.dispose();
    assert.equal(renderer.getDisposeCount(), 1);
  });

  it('syncs ball, drop-shadow, landing reticle, timing ring, wind streamer, spin ribbon, and 1v1<->2v2 with zero allocations', () => {
    const renderer = createMockRenderer();
    const canvasFactory = createMockCanvasFactory();
    const ctrl = createCourtScene(null, {
      renderer,
      createCanvas: canvasFactory,
      width: 1280,
      height: 720,
    });

    ctrl.render(CAMERA_MODES.BROADCAST);
    const scene = renderer.getLastScene();

    const countResources = () => {
      const geos = new Set();
      const mats = new Set();
      scene.traverse((obj) => {
        if (obj.geometry) geos.add(obj.geometry);
        if (obj.material) {
          const list = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of list) mats.add(m);
        }
      });
      return { geoCount: geos.size, matCount: mats.size };
    };

    const initialCounts = countResources();
    const ballMesh = scene.getObjectByName('beachVolleyball');
    const dropShadow = scene.getObjectByName('ballDropShadow');
    const reticle = scene.getObjectByName('landingReticle');
    const timingRing = scene.getObjectByName('timingRing3D');
    const ribbon = scene.getObjectByName('ballSpinRibbon');
    const streamer = scene.getObjectByName('windStreamer_far');

    assert.ok(ballMesh && dropShadow && reticle && timingRing && ribbon && streamer);

    // Run 60 frames toggling 1v1 <-> 2v2, all TRAIL_MODES, WIND_PHASES, and EVENTS
    const modes = Object.values(TRAIL_MODES);
    const phases = Object.values(WIND_PHASES);
    const allEvents = [
      { type: EVENTS.BUMP },
      { type: EVENTS.SET },
      { type: EVENTS.HEAT_SPIKE, intensity: 0.95 },
      { type: EVENTS.SPIKE },
      { type: EVENTS.POKEY_CUT },
      { type: EVENTS.STUFF_BLOCK },
      { type: EVENTS.WALL_BOUNCE, pos: { x: COURT.ARENA_HALF_X, y: 4, z: 0 } },
      { type: EVENTS.NET_TAPE_HIT, pos: { x: 0, y: COURT.NET_HEIGHT, z: 0 } },
      { type: EVENTS.SAND_IMPACT, pos: { x: 4, y: 0.22, z: 1 } },
      { type: EVENTS.DIVE, pos: { x: -5, y: 0.2, z: -1 } },
    ];

    for (let f = 0; f < 60; f++) {
      const is2v2 = f >= 20 && f < 40;
      const players = is2v2
        ? [
            createPlayerState({ id: 'p1', team: 1, role: 'PRIMARY', pos: { x: -4, y: 0, z: -1 } }),
            createPlayerState({ id: 'p1p', team: 1, role: 'PARTNER', pos: { x: -2, y: 0, z: 1.5 } }),
            createPlayerState({ id: 'p2', team: 2, role: 'PRIMARY', pos: { x: 4, y: 0, z: 1 } }),
            createPlayerState({ id: 'p2p', team: 2, role: 'PARTNER', pos: { x: 2, y: 0, z: -1.5 } }),
          ]
        : [
            createPlayerState({ id: 'p1', team: 1, role: 'PRIMARY', pos: { x: -4, y: 0, z: 0 } }),
            createPlayerState({ id: 'p2', team: 2, role: 'PRIMARY', pos: { x: 4, y: 0, z: 0 } }),
          ];

      const snap = makeSampleSnapshot({
        ball: {
          pos: { x: -5 + f * 0.16, y: 2.2 + Math.sin(f * 0.15), z: Math.cos(f * 0.1) },
          trailMode: modes[f % modes.length],
          active: true,
        },
        wind: {
          phase: phases[f % phases.length],
          windVec3: { x: 4.5 * Math.cos(f * 0.1), y: 0.2, z: 2.0 * Math.sin(f * 0.1) },
          speed: 5.0,
        },
        players,
        timingRing: {
          active: f % 2 === 0,
          x: -1.0,
          y: 3.3,
          z: 0.2,
          progress: (f % 20) / 20,
          isSweetSpot: f % 20 >= 14,
        },
        events: f < allEvents.length ? [allEvents[f]] : [],
      });

      ctrl.syncState(snap, 1 / 60);
      ctrl.render(f % 3 === 0 ? CAMERA_MODES.SPLIT_SCREEN : CAMERA_MODES.BROADCAST);

      // Verify exact active rig count matches 1v1 (2) vs 2v2 (4)
      let visibleRigs = 0;
      for (const child of scene.children) {
        if (child.name && child.name.startsWith('playerRig_') && child.visible) {
          visibleRigs++;
        }
      }
      assert.equal(visibleRigs, is2v2 ? 4 : 2);
    }

    // Zero Geometry or Material allocations across 60 frames + 1v1<->2v2 switches!
    const afterCounts = countResources();
    assert.deepStrictEqual(afterCounts, initialCounts);

    // Spin ribbon must have built triangles during movement
    assert.ok(ribbon.geometry.drawRange.count > 0, 'Spin ribbon should have active draw triangles');

    // Ball teleport (> 3.5m jump) cleanly resets trail buffer
    ctrl.syncState(
      makeSampleSnapshot({
        ball: { pos: { x: -10, y: 2.0, z: -4 }, active: true },
      }),
      1 / 60,
    );
    assert.equal(ribbon.geometry.drawRange.count, 0, 'Ball teleport should reset ribbon trail cleanly');

    // Inactive ball & null prediction hide ball, drop-shadow, reticle, and timing ring
    ctrl.syncState(
      makeSampleSnapshot({
        ball: { active: false },
        prediction: null,
        timingRing: { active: false },
      }),
      1 / 60,
    );
    assert.equal(ballMesh.visible, false);
    assert.equal(dropShadow.visible, false);
    assert.equal(reticle.visible, false);
    assert.equal(timingRing.visible, false);

    ctrl.dispose();
  });

  it('switches cleanly between SPLIT and BROADCAST, resetting setScissorTest(false), and handles 1280x720, 844x390 & 390x844', () => {
    const renderer = createMockRenderer();
    const ctrl = createCourtScene(null, {
      renderer,
      createCanvas: createMockCanvasFactory(),
      width: 1280,
      height: 720,
    });

    for (const [w, h] of [
      [1280, 720],
      [844, 390],
      [390, 844],
    ]) {
      ctrl.resize(w, h);
      renderer.calls.length = 0;

      // Render SPLIT -> 2 passes with scissorTest === true
      ctrl.render(CAMERA_MODES.SPLIT_SCREEN);
      const splitRenders = renderer.calls.filter((c) => c.fn === 'render');
      assert.equal(splitRenders.length, 2, `Expected 2 render passes in SPLIT at ${w}x${h}`);
      assert.equal(splitRenders[0].scissorTest, true);
      assert.equal(splitRenders[1].scissorTest, true);
      assert.ok(splitRenders[0].pos.x < 0, 'Left split camera should be behind Team 1 (-X)');
      assert.ok(splitRenders[1].pos.x > 0, 'Right split camera should be behind Team 2 (+X)');
      assert.ok(Number.isFinite(splitRenders[0].aspect) && splitRenders[0].aspect > 0);
      assert.ok(Number.isFinite(splitRenders[1].aspect) && splitRenders[1].aspect > 0);

      // Render BROADCAST -> MUST reset setScissorTest(false) and full viewport
      renderer.calls.length = 0;
      ctrl.render(CAMERA_MODES.BROADCAST);
      const bcRenders = renderer.calls.filter((c) => c.fn === 'render');
      assert.equal(bcRenders.length, 1);
      assert.equal(bcRenders[0].scissorTest, false);
      assert.equal(renderer.scissorTest, false);
      assert.ok(Math.abs(bcRenders[0].aspect - w / h) < 1e-6);
    }

    // Invalid resize inputs never produce NaN aspect ratios
    assert.doesNotThrow(() => {
      ctrl.resize(0, -10);
      ctrl.resize(NaN, Infinity);
      ctrl.render(CAMERA_MODES.BROADCAST);
    });
    const lastRender = renderer.calls.filter((c) => c.fn === 'render').at(-1);
    assert.ok(Number.isFinite(lastRender.aspect) && lastRender.aspect > 0);

    ctrl.dispose();
  });

  it('dirty-checks diegetic LED scoreboard redraws and decays triggerCameraPunch cleanly', () => {
    const renderer = createMockRenderer();
    const canvasFactory = createMockCanvasFactory();
    const ctrl = createCourtScene(null, {
      renderer,
      createCanvas: canvasFactory,
      width: 1280,
      height: 720,
    });

    // LED canvas is the 512x256 canvas created by courtScene
    const ledCanvas = canvasFactory.canvases.find((c) => c.width === 512 && c.height === 256);
    assert.ok(ledCanvas, 'Expected 512x256 LED scoreboard canvas');

    const snapA = makeSampleSnapshot({ scoreboard: { scoreT1: 5, scoreT2: 4, bannerText: 'ACE!' } });
    ctrl.syncState(snapA, 1 / 60);
    const afterFirstDraw = ledCanvas._ctx.getStats().fillTextCalls;
    assert.ok(afterFirstDraw > 0);

    // Repeating identical scoreboard values must NOT trigger redundant 2D redraws
    for (let i = 0; i < 10; i++) {
      ctrl.syncState(snapA, 1 / 60);
    }
    assert.equal(ledCanvas._ctx.getStats().fillTextCalls, afterFirstDraw);

    // Changing score triggers exactly one redraw
    const snapB = makeSampleSnapshot({ scoreboard: { scoreT1: 6, scoreT2: 4, bannerText: 'POINT!' } });
    ctrl.syncState(snapB, 1 / 60);
    assert.ok(ledCanvas._ctx.getStats().fillTextCalls > afterFirstDraw);

    // Camera punch perturbs camera then decays smoothly to baseline
    renderer.calls.length = 0;
    ctrl.render(CAMERA_MODES.BROADCAST);
    const baselineFov = renderer.calls.at(-1).camera.fov;

    ctrl.triggerCameraPunch(1.0);
    ctrl.syncState(snapB, 1 / 60);
    ctrl.render(CAMERA_MODES.BROADCAST);
    const punchedFov = renderer.calls.at(-1).camera.fov;
    assert.ok(punchedFov > baselineFov + 1.0, 'Camera punch should kick FOV');

    for (let i = 0; i < 60; i++) {
      ctrl.syncState(snapB, 1 / 60);
    }
    ctrl.render(CAMERA_MODES.BROADCAST);
    const settledFov = renderer.calls.at(-1).camera.fov;
    assert.ok(Math.abs(settledFov - baselineFov) < 1e-3, 'Camera punch should decay back to baseline');

    ctrl.dispose();
  });

  it('survives hostile / null / NaN snapshots without throwing or producing NaN matrices', () => {
    const renderer = createMockRenderer();
    const ctrl = createCourtScene(null, {
      renderer,
      createCanvas: () => null, // tests bare Node fallback without any 2D canvas
      width: 1280,
      height: 720,
    });

    assert.doesNotThrow(() => {
      ctrl.syncState(null, 1 / 60);
      ctrl.syncState(undefined, NaN);
      ctrl.syncState({}, -1);
      ctrl.syncState(
        {
          ball: {
            pos: { x: NaN, y: Infinity, z: -Infinity },
            spinAngle: { x: NaN, y: NaN, z: NaN },
            trailMode: 'UNKNOWN',
            active: true,
          },
          wind: { windVec3: { x: NaN, y: NaN, z: NaN }, speed: NaN, phase: 'UNKNOWN' },
          prediction: { x: NaN, z: Infinity, hangTime: NaN },
          timingRing: { active: true, x: NaN, y: NaN, z: NaN, progress: NaN },
          players: [null, { id: 'bad', pos: { x: NaN, y: -5, z: Infinity }, animState: 'BOGUS' }],
          cameraPunch: NaN,
          events: [null, 'HEAT_SPIKE', { type: EVENTS.WALL_BOUNCE, pos: { x: NaN, y: NaN, z: NaN } }],
        },
        Infinity,
      );
      ctrl.render(CAMERA_MODES.BROADCAST);
      ctrl.render(CAMERA_MODES.SPLIT_SCREEN);
    });

    const scene = renderer.getLastScene();
    scene.updateMatrixWorld(true);
    scene.traverse((obj) => {
      const els = obj.matrixWorld.elements;
      for (let i = 0; i < 16; i++) {
        assert.ok(Number.isFinite(els[i]), `Non-finite matrix element on ${obj.name || obj.type}`);
      }
    });

    ctrl.dispose();
  });
});
