import mapboxgl from 'mapbox-gl';
import * as THREE from 'three';
import { DEG, LocalFrame, wrapPi } from './geo';
import { GEAR_HEIGHT, type PlaneState } from './physics';
import { createPlane, type PlaneModel } from './planeModel';

// Mapbox's default vertical field of view (atan(3/4) * 2). The overlay camera
// must match it exactly so the plane sits at the right scale on the map.
const MAPBOX_FOV_DEG = 36.8699;
const CHASE_DISTANCE = 24;
const CHASE_HEIGHT = 5.5;
const LOOK_AHEAD = 10;
// Keep the 11 m wingspan within ~60% of the screen width on narrow (portrait) screens.
const WINGSPAN_COVERAGE = 11 / 0.6;
// Mapbox caps pitch at 85°, so the camera must look down at least 5°.
const MIN_LOOK_DOWN = 5 * DEG;

const ORBIT_DEFAULT = { yaw: 0, elevation: 20 * DEG, distance: 30 };
const ORBIT_LIMITS = { minElevation: MIN_LOOK_DOWN, maxElevation: 85 * DEG, minDistance: 12, maxDistance: 400 };
const ORBIT_RATES = { yaw: 90 * DEG, elevation: 45 * DEG, zoom: 1.2 };
// Pilot's eye relative to the CG: up and slightly forward.
const COCKPIT_EYE = { up: 0.55, forward: 0.6 };

export type CameraMode = 'chase' | 'orbit' | 'cockpit';

/** Orbit-mode input, each -1..1: yaw (+ = swing right), elevation (+ = up), zoom (+ = closer). */
export interface OrbitInput {
  yaw: number;
  elevation: number;
  zoom: number;
}

/**
 * Camera shared by Mapbox and the three.js overlay. Both cameras get the same
 * pose every frame; the plane is drawn at the overlay's origin. Modes: chase
 * (behind and above), orbit (player-controlled around the plane), and cockpit.
 */
export class View {
  readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly plane: PlaneModel;
  private camHeading = 0;
  private camGamma = 0;
  /** Chase distance multiplier: 1 on landscape screens, larger on portrait. */
  private zoom = 1;
  mode: CameraMode = 'chase';
  private orbit = { ...ORBIT_DEFAULT };

  constructor(
    private readonly map: mapboxgl.Map,
    canvas: HTMLCanvasElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(MAPBOX_FOV_DEG, 1, 0.5, 5000);
    this.camera.rotation.order = 'YXZ';

    this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5a5040, 1.6));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(-40, 80, 30);
    this.scene.add(sun);

    this.plane = createPlane();
    this.plane.root.rotation.order = 'YXZ';
    this.scene.add(this.plane.root);
    this.scene.add(this.plane.shadow);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const halfTan = Math.tan((MAPBOX_FOV_DEG * DEG) / 2) * this.camera.aspect;
    this.zoom = Math.max(1, WINGSPAN_COVERAGE / (2 * halfTan) / CHASE_DISTANCE);
  }

  resetOrbit(): void {
    this.orbit = { ...ORBIT_DEFAULT };
  }

  /** Snap the chase camera behind the plane (used on spawn). */
  snap(s: PlaneState): void {
    this.camHeading = s.heading;
    this.camGamma = s.gamma;
  }

  update(
    s: PlaneState,
    frame: LocalFrame,
    groundAt: (x: number, y: number) => number,
    groundUnderPlane: number,
    input: { pitch: number; roll: number; flapDeg: number },
    orbitInput: OrbitInput,
    dt: number,
  ): void {
    // Smoothly trail the plane's heading and flight path so turns are visible.
    const k = Math.min(1, 2.5 * dt);
    this.camHeading = wrapPi(this.camHeading + wrapPi(s.heading - this.camHeading) * k);
    this.camGamma += (Math.max(-12 * DEG, Math.min(12 * DEG, s.gamma)) - this.camGamma) * k;

    const pose =
      this.mode === 'orbit' ? this.orbitPose(orbitInput, dt) : this.mode === 'cockpit' ? this.cockpitPose(s) : this.chasePose();

    // Never put the camera underground (Mapbox would bump it up and desync us).
    if (this.mode !== 'cockpit') {
      const camGround = groundAt(s.x + pose.ox, s.y + pose.oy);
      const minOz = camGround + 3 - s.z;
      if (pose.oz < minOz) {
        pose.oz = minOz;
        // Re-aim at the plane from the raised position.
        pose.lookDown = Math.atan2(pose.oz - pose.tz, Math.hypot(pose.tx - pose.ox, pose.ty - pose.oy));
      }
    }
    const { ox, oy, oz } = pose;
    const lookDown = Math.max(MIN_LOOK_DOWN, pose.lookDown);
    const bearing = pose.bearing;

    const [lng, lat] = frame.toLngLat(s.x + ox, s.y + oy);
    const opts = this.map.getFreeCameraOptions();
    opts.position = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], s.z + oz);
    opts.setPitchBearing(90 - lookDown / DEG, bearing / DEG);
    this.map.setFreeCameraOptions(opts);

    // Overlay world: x = east, y = up, z = south, plane at the origin.
    this.camera.position.set(ox, oz, -oy);
    this.camera.rotation.set(-lookDown, -bearing, 0);
    this.camera.updateMatrixWorld();

    // In the cockpit you're inside the plane, so don't draw it.
    this.plane.root.visible = this.mode !== 'cockpit';

    this.plane.root.rotation.set(s.gamma + s.alpha, -s.heading, -s.bank);
    this.plane.update({ ...input, propAngle: s.propAngle, throttle: s.throttle });

    const agl = s.z - GEAR_HEIGHT - groundUnderPlane;
    const shadow = this.plane.shadow;
    shadow.visible = agl < 80 && this.mode !== 'cockpit';
    shadow.position.set(0, -(s.z - groundUnderPlane) + 0.05, 0);
    shadow.rotation.set(-Math.PI / 2, 0, -s.heading);
    (shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - agl / 80);
    const spread = 1 + agl / 60;
    shadow.scale.set(spread, spread, 1);

    this.renderer.render(this.scene, this.camera);
  }

  /** Behind and above, looking slightly ahead of the plane. */
  private chasePose(): Pose {
    const fx = Math.sin(this.camHeading);
    const fy = Math.cos(this.camHeading);
    const dist = CHASE_DISTANCE * this.zoom;
    const back = dist * Math.cos(this.camGamma);
    const ox = -fx * back;
    const oy = -fy * back;
    const oz = CHASE_HEIGHT * this.zoom - dist * Math.sin(this.camGamma);
    const tx = fx * LOOK_AHEAD * this.zoom;
    const ty = fy * LOOK_AHEAD * this.zoom;
    return aim(ox, oy, oz, tx, ty, 0);
  }

  /** Player-controlled orbit around the plane, relative to its heading. */
  private orbitPose(input: OrbitInput, dt: number): Pose {
    const o = this.orbit;
    o.yaw = wrapPi(o.yaw + input.yaw * ORBIT_RATES.yaw * dt);
    o.elevation = Math.min(
      ORBIT_LIMITS.maxElevation,
      Math.max(ORBIT_LIMITS.minElevation, o.elevation + input.elevation * ORBIT_RATES.elevation * dt),
    );
    o.distance = Math.min(
      ORBIT_LIMITS.maxDistance,
      Math.max(ORBIT_LIMITS.minDistance, o.distance * Math.exp(-input.zoom * ORBIT_RATES.zoom * dt)),
    );

    // yaw 0 = directly behind; positive swings the camera clockwise around the plane.
    const around = this.camHeading + Math.PI + o.yaw;
    const dist = o.distance * this.zoom;
    const horizontal = dist * Math.cos(o.elevation);
    return aim(Math.sin(around) * horizontal, Math.cos(around) * horizontal, dist * Math.sin(o.elevation), 0, 0, 0);
  }

  /** Pilot's-eye view. Mapbox can't roll the camera, so the horizon stays level. */
  private cockpitPose(s: PlaneState): Pose {
    const fx = Math.sin(s.heading);
    const fy = Math.cos(s.heading);
    const ox = fx * COCKPIT_EYE.forward;
    const oy = fy * COCKPIT_EYE.forward;
    const pitch = s.gamma + s.alpha;
    return { ox, oy, oz: COCKPIT_EYE.up, tx: ox + fx, ty: oy + fy, tz: COCKPIT_EYE.up, lookDown: -pitch, bearing: s.heading };
  }

  /** Camera-space position of a world point relative to the plane (x right, y up, -z forward). */
  toCameraSpace(dx: number, dy: number, dz: number): THREE.Vector3 {
    return new THREE.Vector3(dx, dz, -dy).applyMatrix4(this.camera.matrixWorldInverse);
  }
}

/** Camera position and look target, both relative to the plane (east, north, up). */
interface Pose {
  ox: number;
  oy: number;
  oz: number;
  tx: number;
  ty: number;
  tz: number;
  lookDown: number;
  bearing: number;
}

function aim(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number): Pose {
  const dx = tx - ox;
  const dy = ty - oy;
  return { ox, oy, oz, tx, ty, tz, lookDown: Math.atan2(oz - tz, Math.hypot(dx, dy)), bearing: Math.atan2(dx, dy) };
}
