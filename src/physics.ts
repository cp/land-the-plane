import { DEG, wrapPi } from './geo';

// Roughly a Cessna 172: stall ~48 kt clean / ~42 kt full flaps, cruise ~110 kt.
const MASS = 1000; // kg
const G = 9.81;
const WEIGHT = MASS * G;
const RHO = 1.225;
const WING_AREA = 16.2;
const CL0 = 0.3;
const CL_ALPHA = 5.0; // per radian
const CD0 = 0.03;
const INDUCED_K = 0.05;
const STATIC_THRUST = 2800; // N at full throttle, zero airspeed
const THRUST_ZERO_SPEED = 122; // m/s where the prop stops producing thrust
const MAX_LOAD_FACTOR = 3.8;
const WINGSPAN = 11;

export const FLAP_DEGREES = [0, 10, 20, 30] as const;
const FLAP_CL = [0, 0.2, 0.35, 0.5];
const FLAP_CD = [0, 0.01, 0.025, 0.045];
const FLAP_STALL_ALPHA = [15, 14.5, 14, 13].map((d) => d * DEG);

/** Distance from the CG down to the bottom of the wheels. */
export const GEAR_HEIGHT = 1.2;

const ROLL_RATE = 50 * DEG;
const PATH_RATE = 10 * DEG; // flight path change per second at full pitch input
const GROUND_PITCH_RATE = 8 * DEG;
const STALL_BREAK_SECONDS = 1.5;
const MAX_BANK = 65 * DEG;
const ALPHA_MIN = -6 * DEG;
const ALPHA_MAX = 18 * DEG;

export interface Controls {
  pitch: number; // -1..1, +1 = nose up
  roll: number; // -1..1, +1 = roll right
  brakes: boolean;
}

export interface PlaneState {
  x: number;
  y: number;
  z: number; // meters MSL
  speed: number; // true airspeed, m/s (no wind, so also ground speed)
  heading: number; // radians, clockwise from north
  gamma: number; // flight path angle, radians
  alpha: number; // angle of attack, radians
  alphaTarget: number; // alpha the airframe is moving toward
  bank: number; // radians, + = right wing down
  throttle: number; // 0..1
  flaps: number; // index into FLAP_DEGREES
  onGround: boolean;
  stalled: boolean;
  stallTimer: number; // seconds left of the post-stall nose drop
  propAngle: number;
}

export function pitchAttitude(s: PlaneState): number {
  return s.gamma + s.alpha;
}

export function verticalSpeed(s: PlaneState): number {
  return s.speed * Math.sin(s.gamma);
}

/** Alpha that gives 1 g of lift at a given speed and flap setting. */
export function levelFlightAlpha(speed: number, flaps: number): number {
  const q = 0.5 * RHO * speed * speed;
  return (WEIGHT / (q * WING_AREA) - CL0 - FLAP_CL[flaps]) / CL_ALPHA;
}

function liftCoefficient(alpha: number, flaps: number): number {
  const crit = FLAP_STALL_ALPHA[flaps];
  const linear = (a: number) => CL0 + FLAP_CL[flaps] + CL_ALPHA * a;
  if (alpha <= crit) return linear(alpha);
  // Past the critical angle lift falls off sharply.
  return Math.max(0.4, linear(crit) - 2.5 * (alpha - crit));
}

export function isNearStall(s: PlaneState): boolean {
  return !s.onGround && s.alpha > FLAP_STALL_ALPHA[s.flaps] - 2.5 * DEG;
}

export interface GroundInfo {
  /** Ground elevation (MSL meters) directly under the plane. */
  elevation: number;
}

/**
 * Point-mass flight model with a forgiving pitch law: pitch input commands a
 * rate of change of the flight path, and with no input the plane holds its
 * current climb or descent angle (compensating for bank). Airspeed is still
 * physical, so holding a climb at low power bleeds speed until it stalls.
 */
export function step(s: PlaneState, c: Controls, ground: GroundInfo, dt: number): void {
  const q = 0.5 * RHO * s.speed * s.speed;
  const qS = q * WING_AREA;
  const crit = FLAP_STALL_ALPHA[s.flaps];

  // Elevator authority fades at low speed.
  const authority = Math.min(1, s.speed / 25);

  if (s.onGround) {
    s.alphaTarget += c.pitch * GROUND_PITCH_RATE * authority * dt;
    s.alphaTarget = Math.max(0, Math.min(12 * DEG, s.alphaTarget));
    // The nose settles onto the nose wheel when the elevator can't hold it up.
    if (s.speed < 20) s.alphaTarget *= Math.max(0, 1 - 2 * dt);
  } else {
    const v = Math.max(s.speed, 5);
    const pathRate = c.pitch * PATH_RATE * authority;
    const liftNeeded = (MASS * (v * pathRate + G * Math.cos(s.gamma))) / Math.max(0.3, Math.cos(s.bank));
    let target = qS > 1 ? (liftNeeded / qS - CL0 - FLAP_CL[s.flaps]) / CL_ALPHA : ALPHA_MAX;
    // Never let the pilot exceed the structural load limit.
    const alphaForMaxG = qS > 1 ? ((MAX_LOAD_FACTOR * WEIGHT) / qS - CL0 - FLAP_CL[s.flaps]) / CL_ALPHA : ALPHA_MAX;
    target = Math.min(target, alphaForMaxG, ALPHA_MAX);
    if (s.stallTimer > 0) target = Math.min(target, crit - 3 * DEG); // nose drops after a stall
    s.alphaTarget = Math.max(ALPHA_MIN, target);
  }

  s.alpha += (s.alphaTarget - s.alpha) * Math.min(1, 6 * dt);

  const wasStalled = s.stalled;
  s.stalled = !s.onGround && s.alpha > crit;
  if (s.stalled && !wasStalled) s.stallTimer = STALL_BREAK_SECONDS;
  s.stallTimer = Math.max(0, s.stallTimer - dt);
  if (s.stalled || s.stallTimer > 0) s.bank += (Math.random() - 0.5) * 50 * DEG * dt; // wing rock

  // Ground effect: within about a wingspan of the surface induced drag drops
  // and lift rises a little, which is what makes a flare float.
  const wingHeight = Math.max(0, s.z - ground.elevation);
  const ge = (16 * wingHeight) / WINGSPAN;
  const inducedFactor = (ge * ge) / (1 + ge * ge);
  const liftFactor = 1 + 0.1 * Math.max(0, 1 - wingHeight / WINGSPAN);

  const cl = liftCoefficient(s.alpha, s.flaps) * liftFactor;
  const cd = CD0 + FLAP_CD[s.flaps] + INDUCED_K * inducedFactor * cl * cl;
  const lift = qS * cl;
  const drag = qS * cd;
  const thrust = s.throttle * STATIC_THRUST * Math.max(0, 1 - s.speed / THRUST_ZERO_SPEED);

  s.propAngle += (8 + s.throttle * 60) * dt;

  if (s.onGround) {
    stepGround(s, c, ground, lift, drag, thrust, dt);
  } else {
    stepAir(s, c, lift, drag, thrust, dt);
  }

  const horizontal = s.speed * Math.cos(s.gamma);
  s.x += horizontal * Math.sin(s.heading) * dt;
  s.y += horizontal * Math.cos(s.heading) * dt;
  if (!s.onGround) s.z += s.speed * Math.sin(s.gamma) * dt;
}

function stepAir(s: PlaneState, c: Controls, lift: number, drag: number, thrust: number, dt: number): void {
  s.bank += c.roll * ROLL_RATE * dt;
  s.bank = Math.max(-MAX_BANK, Math.min(MAX_BANK, s.bank));

  const v = Math.max(s.speed, 5);
  const ca = Math.cos(s.alpha);
  const sa = Math.sin(s.alpha);

  s.speed += ((thrust * ca - drag) / MASS - G * Math.sin(s.gamma)) * dt;
  s.speed = Math.max(0, s.speed);
  s.gamma += ((lift * Math.cos(s.bank) + thrust * sa - WEIGHT * Math.cos(s.gamma)) / (MASS * v)) * dt;
  s.gamma = Math.max(-80 * DEG, Math.min(80 * DEG, s.gamma));
  s.heading = wrapPi(s.heading + ((lift * Math.sin(s.bank)) / (MASS * v * Math.max(0.2, Math.cos(s.gamma)))) * dt);
}

function stepGround(
  s: PlaneState,
  c: Controls,
  ground: GroundInfo,
  lift: number,
  drag: number,
  thrust: number,
  dt: number,
): void {
  s.gamma = 0;
  s.z = ground.elevation + GEAR_HEIGHT;
  s.bank *= Math.max(0, 1 - 6 * dt);

  // Nose-wheel steering with the roll keys.
  s.heading = wrapPi(s.heading + c.roll * 20 * DEG * Math.min(1, s.speed / 10) * dt);

  const normal = Math.max(0, WEIGHT - lift);
  const mu = 0.02 + (c.brakes ? 0.4 : 0);
  const rolling = s.speed > 0.05 ? mu * normal : 0;
  s.speed = Math.max(0, s.speed + ((thrust - drag - rolling) / MASS) * dt);

  if (lift > WEIGHT && s.alpha > 0) s.onGround = false;
}
