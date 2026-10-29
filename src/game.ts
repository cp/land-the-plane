import type { Airport } from './airports';
import { buildRunways, DEG, FT, KT, LocalFrame, onRunway, runwayRelative, type Runway, type RunwayEnd } from './geo';
import {
  FLAP_DEGREES,
  GEAR_HEIGHT,
  isNearStall,
  levelFlightAlpha,
  pitchAttitude,
  step,
  verticalSpeed,
  type Controls,
  type PlaneState,
} from './physics';

const NM = 1852;
const FPM = 196.85; // per m/s
const START_AGL = 3000 * FT;
const START_SPEED = 100 * KT;
const PHYSICS_DT = 1 / 120;

export const LIMITS = {
  maxSinkFpm: 600,
  maxBankDeg: 10,
  minPitchDeg: 0,
  stoppedKt: 5,
  /** Seconds of continuous rollout on the runway that count as a landing. */
  rolloutSeconds: 3,
};

export type Phase = 'flying' | 'rollout' | 'crashed' | 'landed';

export interface Touchdown {
  sinkFpm: number;
  bankDeg: number;
  pitchDeg: number;
  speedKt: number;
  centerlineFt: number;
  pastThresholdFt: number;
  runwayIdent: string;
  halfWidthFt: number;
}

export interface Outcome {
  phase: 'crashed' | 'landed';
  title: string;
  reason: string;
  touchdown?: Touchdown;
  grade?: { letter: string; score: number };
}

/** Ground elevation lookup in MSL meters, or null when terrain isn't loaded there. */
export type TerrainQuery = (x: number, y: number) => number | null;

export class Game {
  readonly frame: LocalFrame;
  readonly runways: Runway[];
  state!: PlaneState;
  target!: RunwayEnd;
  phase: Phase = 'flying';
  outcome: Outcome | null = null;
  touchdown: Touchdown | null = null;
  fieldElevation: number;
  private accumulator = 0;
  private rolloutTime = 0;

  constructor(
    readonly airport: Airport,
    private readonly terrain: TerrainQuery,
  ) {
    this.frame = new LocalFrame(airport.lat, airport.lng);
    this.runways = buildRunways(airport, this.frame);
    this.fieldElevation = airport.elevationFt * FT;
  }

  /** Pick a random spot 6–10 nm out and the runway end best lined up from there. */
  spawn(): void {
    const bearing = Math.random() * Math.PI * 2;
    const dist = (6 + Math.random() * 4) * NM;
    const x = Math.sin(bearing) * dist;
    const y = Math.cos(bearing) * dist;

    let best: RunwayEnd = this.runways[0].ends[0];
    let bestScore = -Infinity;
    for (const rwy of this.runways) {
      for (const end of rwy.ends) {
        // Cosine between "threshold -> spawn" and the reverse landing direction:
        // 1 means we're sitting right on the extended centerline.
        const vx = x - end.x;
        const vy = y - end.y;
        const score = -(vx * end.dx + vy * end.dy) / Math.hypot(vx, vy);
        if (score > bestScore) {
          bestScore = score;
          best = end;
        }
      }
    }
    this.target = best;

    // Point roughly at the airport, but not perfectly.
    const heading = Math.atan2(-x, -y) + (Math.random() - 0.5) * 50 * DEG;
    this.state = {
      x,
      y,
      z: this.fieldElevation + START_AGL + GEAR_HEIGHT,
      speed: START_SPEED,
      heading,
      gamma: 0,
      alpha: levelFlightAlpha(START_SPEED, 0),
      alphaTarget: levelFlightAlpha(START_SPEED, 0),
      bank: 0,
      throttle: 0.6,
      flaps: 0,
      onGround: false,
      stalled: false,
      stallTimer: 0,
      propAngle: 0,
    };
    this.phase = 'flying';
    this.outcome = null;
    this.touchdown = null;
    this.accumulator = 0;
    this.rolloutTime = 0;
  }

  /** Once terrain under the spawn point has loaded, set the true 3,000 ft AGL. */
  settleSpawnAltitude(): void {
    const ground = this.terrain(this.state.x, this.state.y) ?? this.fieldElevation;
    this.state.z = ground + START_AGL + GEAR_HEIGHT;
    this.refreshFieldElevation();
  }

  private refreshFieldElevation(): void {
    // KPDX is flat, so one sample at the airport reference point stands in for
    // every runway. That keeps the runway surface smooth instead of following DEM noise.
    const e = this.terrain(0, 0);
    if (e != null) this.fieldElevation = e;
  }

  runwayAt(x: number, y: number): Runway | null {
    return this.runways.find((r) => onRunway(r, x, y)) ?? null;
  }

  groundAt(x: number, y: number): number {
    if (this.runwayAt(x, y)) return this.fieldElevation;
    return this.terrain(x, y) ?? this.fieldElevation;
  }

  update(controls: Controls, dt: number): void {
    if (this.phase === 'crashed' || this.phase === 'landed') return;
    if (!this.state.onGround) this.refreshFieldElevation();

    this.accumulator += dt;
    while (this.accumulator >= PHYSICS_DT) {
      this.accumulator -= PHYSICS_DT;
      this.tick(controls);
      if (this.outcome) return;
    }
  }

  private tick(controls: Controls): void {
    const s = this.state;
    const ground = this.groundAt(s.x, s.y);
    const wasOnGround = s.onGround;
    step(s, controls, { elevation: ground }, PHYSICS_DT);

    if (wasOnGround && !s.onGround) {
      this.phase = 'flying'; // bounced or went around
      return;
    }

    if (!s.onGround) {
      const groundNow = this.groundAt(s.x, s.y);
      if (s.z - GEAR_HEIGHT <= groundNow) this.handleContact(groundNow);
      return;
    }

    // Rolling out on the runway.
    if (!this.runwayAt(s.x, s.y) && s.speed > 1) {
      this.crash('Ran off the runway', 'The wheels left the pavement during the rollout.');
      return;
    }
    this.rolloutTime += PHYSICS_DT;
    if (this.rolloutTime >= LIMITS.rolloutSeconds || s.speed < LIMITS.stoppedKt * KT) this.land();
  }

  private handleContact(ground: number): void {
    const s = this.state;
    const sinkFpm = -verticalSpeed(s) * FPM;
    const bankDeg = Math.abs(s.bank) / DEG;
    const pitchDeg = pitchAttitude(s) / DEG;
    const rwy = this.runwayAt(s.x, s.y);

    if (!rwy) {
      if (sinkFpm < LIMITS.maxSinkFpm && bankDeg < LIMITS.maxBankDeg) {
        this.crash('Off-runway landing', 'You put it down gently... in the wrong place.');
      } else {
        this.crash('Controlled flight into terrain', `Hit the ground at ${Math.round(s.speed / KT)} kt.`);
      }
      return;
    }
    if (sinkFpm > LIMITS.maxSinkFpm) {
      this.crash('Hard landing', `Touched down at ${fmt(sinkFpm)} fpm. The gear is rated for ${LIMITS.maxSinkFpm}.`);
      return;
    }
    if (bankDeg > LIMITS.maxBankDeg) {
      this.crash('Wing strike', `Banked ${bankDeg.toFixed(0)}° at touchdown. Keep it under ${LIMITS.maxBankDeg}°.`);
      return;
    }
    if (pitchDeg < LIMITS.minPitchDeg) {
      this.crash('Nose wheel first', `Pitched ${Math.abs(pitchDeg).toFixed(1)}° nose-down at touchdown. Flare!`);
      return;
    }

    // Good contact: measure against whichever end we're rolling toward.
    const end = rwy.ends.find((e) => e.dx * Math.sin(s.heading) + e.dy * Math.cos(s.heading) > 0) ?? rwy.ends[0];
    const rel = runwayRelative(end, s.x, s.y);
    this.touchdown = {
      sinkFpm,
      bankDeg,
      pitchDeg,
      speedKt: s.speed / KT,
      centerlineFt: Math.abs(rel.cross) / FT,
      pastThresholdFt: rel.along / FT,
      runwayIdent: end.ident,
      halfWidthFt: rwy.halfWidth / FT,
    };
    s.onGround = true;
    s.z = ground + GEAR_HEIGHT;
    s.gamma = 0;
    this.phase = 'rollout';
    this.rolloutTime = 0;
  }

  private crash(title: string, reason: string): void {
    this.phase = 'crashed';
    this.outcome = { phase: 'crashed', title, reason };
  }

  private land(): void {
    const td = this.touchdown!;
    const sinkScore = clamp01(1 - (td.sinkFpm - 100) / (LIMITS.maxSinkFpm - 100)) * 50;
    const lineScore = clamp01(1 - td.centerlineFt / td.halfWidthFt) * 50;
    const score = Math.round(sinkScore + lineScore);
    const letter = score >= 92 ? 'A+' : score >= 82 ? 'A' : score >= 68 ? 'B' : score >= 52 ? 'C' : 'D';
    this.phase = 'landed';
    this.outcome = {
      phase: 'landed',
      title: 'Landed!',
      reason: `Runway ${td.runwayIdent} at ${this.airport.icao}`,
      touchdown: td,
      grade: { letter, score },
    };
  }

  // --- Readouts for the HUD -------------------------------------------------

  agl(): number {
    return this.state.z - GEAR_HEIGHT - this.groundAt(this.state.x, this.state.y);
  }

  flapDegrees(): number {
    return FLAP_DEGREES[this.state.flaps];
  }

  nearStall(): boolean {
    return isNearStall(this.state);
  }

  /** Glideslope/localizer deviation for the target runway in degrees, or null off-approach. */
  approach(): { distance: number; glideslope: number | null; localizer: number | null } {
    const s = this.state;
    const rel = runwayRelative(this.target, s.x, s.y);
    const distToThreshold = -rel.along;
    const distance = Math.hypot(s.x - this.target.x, s.y - this.target.y);
    if (distToThreshold < 60) return { distance, glideslope: null, localizer: null };
    const localizer = Math.atan2(rel.cross, distToThreshold) / DEG;
    if (Math.abs(localizer) > 35) return { distance, glideslope: null, localizer: null };
    // Aim 300 m past the threshold, like a real touchdown-zone aim point.
    const height = s.z - GEAR_HEIGHT - this.fieldElevation;
    const glideslope = Math.atan2(height, distToThreshold + 300) / DEG - 3;
    return { distance, glideslope, localizer };
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
