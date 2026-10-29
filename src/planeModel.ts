import * as THREE from 'three';

// Low-poly high-wing trainer. Units are meters; the nose points down -Z, +Y is up,
// +X is the right wing. The origin is the CG; wheel bottoms sit at y = -1.2.

const WHITE = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, flatShading: true, roughness: 0.55 });
const RED = new THREE.MeshStandardMaterial({ color: 0xc8202c, flatShading: true, roughness: 0.5 });
const NAVY = new THREE.MeshStandardMaterial({ color: 0x1b2a4a, flatShading: true, roughness: 0.5 });
const GLASS = new THREE.MeshStandardMaterial({
  color: 0x2a3b4f,
  flatShading: true,
  roughness: 0.15,
  metalness: 0.4,
});
const DARK = new THREE.MeshStandardMaterial({ color: 0x222222, flatShading: true, roughness: 0.8 });
const METAL = new THREE.MeshStandardMaterial({ color: 0x9a9ea3, flatShading: true, roughness: 0.4, metalness: 0.6 });

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/** Fuselage as a lofted box: a list of [z, halfWidth, top, bottom] stations. */
function fuselage(): THREE.Mesh {
  const stations: [number, number, number, number][] = [
    [-3.3, 0.32, 0.25, -0.3],
    [-2.6, 0.52, 0.5, -0.55],
    [-1.2, 0.58, 0.85, -0.62],
    [0.9, 0.56, 0.85, -0.6],
    [2.2, 0.38, 0.55, -0.25],
    [4.6, 0.12, 0.35, 0.05],
  ];
  const positions: number[] = [];
  const ring = (s: (typeof stations)[number]) => {
    const [z, hw, top, bot] = s;
    return [
      [-hw, top, z],
      [hw, top, z],
      [hw, bot, z],
      [-hw, bot, z],
    ];
  };
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  for (let i = 0; i < stations.length - 1; i++) {
    const r0 = ring(stations[i]);
    const r1 = ring(stations[i + 1]);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      quad(r0[k], r0[k2], r1[k2], r1[k]);
    }
  }
  const front = ring(stations[0]);
  quad(front[3], front[2], front[1], front[0]);
  const back = ring(stations[stations.length - 1]);
  quad(back[0], back[1], back[2], back[3]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xf4f4f0, flatShading: true, roughness: 0.55, side: THREE.DoubleSide }));
}

/** A control surface hinged along its leading edge (local z = 0). */
function hinged(w: number, h: number, d: number, mat: THREE.Material): THREE.Group {
  const pivot = new THREE.Group();
  pivot.add(box(w, h, d, mat, 0, 0, d / 2));
  return pivot;
}

export interface PlaneModel {
  root: THREE.Group;
  shadow: THREE.Mesh;
  update(input: { pitch: number; roll: number; flapDeg: number; propAngle: number; throttle: number }): void;
}

export function createPlane(): PlaneModel {
  const root = new THREE.Group();

  root.add(fuselage());
  // Cheat stripe and tail band.
  root.add(box(1.18, 0.12, 4.6, RED, 0, 0.05, -0.7));
  root.add(box(1.18, 0.06, 4.6, NAVY, 0, -0.06, -0.7));
  // Windshield and side windows.
  const windshield = box(1.0, 0.45, 0.08, GLASS, 0, 0.62, -1.15);
  windshield.rotation.x = -0.75;
  root.add(windshield);
  root.add(box(1.17, 0.38, 1.3, GLASS, 0, 0.58, -0.25));
  // Cowling and spinner.
  root.add(box(0.7, 0.55, 0.4, WHITE, 0, -0.03, -3.35));
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.4, 8), METAL);
  spinner.rotation.x = -Math.PI / 2;
  spinner.position.set(0, 0, -3.7);
  root.add(spinner);

  // Propeller: two blades plus a translucent disc that shows up at high RPM.
  const prop = new THREE.Group();
  prop.position.set(0, 0, -3.6);
  prop.add(box(0.12, 1.9, 0.04, DARK));
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 24),
    new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
  );
  root.add(prop);
  disc.position.set(0, 0, -3.62);
  root.add(disc);

  // High wing: inner panels carry flaps, outer panels carry ailerons.
  const WING_Y = 0.92;
  const WING_LE = -0.75;
  const CHORD = 1.5;
  const SPAN = 11;
  const fixedChord = 1.15;
  root.add(box(SPAN, 0.14, fixedChord, WHITE, 0, WING_Y, WING_LE + fixedChord / 2));
  root.add(box(0.6, 0.15, fixedChord * 0.98, RED, SPAN / 2 - 0.3, WING_Y, WING_LE + fixedChord / 2));
  root.add(box(0.6, 0.15, fixedChord * 0.98, RED, -SPAN / 2 + 0.3, WING_Y, WING_LE + fixedChord / 2));
  const hingeZ = WING_LE + fixedChord;
  const surfaceChord = CHORD - fixedChord;

  const flaps: THREE.Group[] = [];
  const ailerons: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const flap = hinged(2.8, 0.08, surfaceChord, WHITE);
    flap.position.set(side * 2.1, WING_Y, hingeZ);
    root.add(flap);
    flaps.push(flap);

    const aileron = hinged(2.3, 0.08, surfaceChord, WHITE);
    aileron.position.set(side * 4.2, WING_Y, hingeZ);
    aileron.userData.side = side;
    root.add(aileron);
    ailerons.push(aileron);

    // Wing strut from the lower fuselage up to mid-wing.
    const lower = new THREE.Vector3(side * 0.55, -0.45, -0.1);
    const upper = new THREE.Vector3(side * 2.6, WING_Y - 0.07, -0.1);
    const strut = box(0.07, 0.07, lower.distanceTo(upper), METAL);
    strut.position.copy(lower).add(upper).multiplyScalar(0.5);
    strut.lookAt(upper);
    root.add(strut);
  }

  // Tail.
  root.add(box(3.4, 0.08, 0.65, WHITE, 0, 0.3, 4.15));
  const elevator = hinged(3.3, 0.06, 0.4, RED);
  elevator.position.set(0, 0.3, 4.48);
  root.add(elevator);
  const fin = new THREE.Mesh(
    new THREE.ExtrudeGeometry(
      new THREE.Shape([
        new THREE.Vector2(0, 0),
        new THREE.Vector2(1.3, 0),
        new THREE.Vector2(1.3, 1.45),
        new THREE.Vector2(0.75, 1.45),
      ]),
      { depth: 0.08, bevelEnabled: false },
    ),
    RED,
  );
  fin.rotation.y = -Math.PI / 2;
  fin.position.set(0.04, 0.32, 3.35);
  root.add(fin);

  // Landing gear.
  const wheel = (x: number, z: number) => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.16, 12), DARK);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, -0.92, z);
    root.add(w);
  };
  for (const side of [-1, 1]) {
    const leg = box(0.08, 0.95, 0.12, METAL, side * 0.85, -0.55, 0.3);
    leg.rotation.z = side * 0.55;
    root.add(leg);
    wheel(side * 1.2, 0.3);
  }
  root.add(box(0.08, 0.6, 0.08, METAL, 0, -0.75, -2.55));
  wheel(0, -2.55);

  // Soft drop shadow, positioned on the ground beneath the plane each frame.
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 128;
  const ctx = shadowCanvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 9),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = -1;

  return {
    root,
    shadow,
    update({ pitch, roll, flapDeg, propAngle, throttle }) {
      prop.rotation.z = propAngle;
      (disc.material as THREE.MeshBasicMaterial).opacity = 0.08 + throttle * 0.22;
      prop.visible = throttle < 0.15;
      elevator.rotation.x = -pitch * 0.4;
      for (const a of ailerons) a.rotation.x = -a.userData.side * roll * 0.35;
      for (const f of flaps) f.rotation.x = flapDeg * (Math.PI / 180) * 1.3;
    },
  };
}
