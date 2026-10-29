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

/**
 * Chase camera shared by Mapbox and the three.js overlay. Both cameras get the
 * same pose every frame; the plane is drawn at the overlay's origin.
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
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const halfTan = Math.tan((MAPBOX_FOV_DEG * DEG) / 2) * this.camera.aspect;
    this.zoom = Math.max(1, WINGSPAN_COVERAGE / (2 * halfTan) / CHASE_DISTANCE);
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
    dt: number,
  ): void {
    // Smoothly trail the plane's heading and flight path so turns are visible.
    const k = Math.min(1, 2.5 * dt);
    this.camHeading = wrapPi(this.camHeading + wrapPi(s.heading - this.camHeading) * k);
    this.camGamma += (Math.max(-12 * DEG, Math.min(12 * DEG, s.gamma)) - this.camGamma) * k;

    const fx = Math.sin(this.camHeading);
    const fy = Math.cos(this.camHeading);
    const dist = CHASE_DISTANCE * this.zoom;
    const back = dist * Math.cos(this.camGamma);
    let ox = -fx * back;
    let oy = -fy * back;
    let oz = CHASE_HEIGHT * this.zoom - dist * Math.sin(this.camGamma);

    // Never put the camera underground (Mapbox would bump it up and desync us).
    const camGround = groundAt(s.x + ox, s.y + oy);
    oz = Math.max(oz, camGround + 3 - s.z);

    const tx = fx * LOOK_AHEAD * this.zoom - ox;
    const ty = fy * LOOK_AHEAD * this.zoom - oy;
    const lookDown = Math.max(MIN_LOOK_DOWN, Math.atan2(oz, Math.hypot(tx, ty)));
    const bearing = Math.atan2(tx, ty);

    const [lng, lat] = frame.toLngLat(s.x + ox, s.y + oy);
    const opts = this.map.getFreeCameraOptions();
    opts.position = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], s.z + oz);
    opts.setPitchBearing(90 - lookDown / DEG, bearing / DEG);
    this.map.setFreeCameraOptions(opts);

    // Overlay world: x = east, y = up, z = south, plane at the origin.
    this.camera.position.set(ox, oz, -oy);
    this.camera.rotation.set(-lookDown, -bearing, 0);
    this.camera.updateMatrixWorld();

    this.plane.root.rotation.set(s.gamma + s.alpha, -s.heading, -s.bank);
    this.plane.update({ ...input, propAngle: s.propAngle, throttle: s.throttle });

    const agl = s.z - GEAR_HEIGHT - groundUnderPlane;
    const shadow = this.plane.shadow;
    shadow.visible = agl < 80;
    shadow.position.set(0, -(s.z - groundUnderPlane) + 0.05, 0);
    shadow.rotation.set(-Math.PI / 2, 0, -s.heading);
    (shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - agl / 80);
    const spread = 1 + agl / 60;
    shadow.scale.set(spread, spread, 1);

    this.renderer.render(this.scene, this.camera);
  }

  /** Camera-space position of a world point relative to the plane (x right, y up, -z forward). */
  toCameraSpace(dx: number, dy: number, dz: number): THREE.Vector3 {
    return new THREE.Vector3(dx, dz, -dy).applyMatrix4(this.camera.matrixWorldInverse);
  }
}
