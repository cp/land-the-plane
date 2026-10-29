import type { Airport } from './airports';

export const FT = 0.3048;
export const KT = 0.514444;
export const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;

/**
 * Flat east/north/up frame (meters) centered on an airport. Within ~30 km the
 * flat-earth error is negligible for a game.
 */
export class LocalFrame {
  private readonly mPerDegLng: number;

  constructor(
    readonly lat0: number,
    readonly lng0: number,
  ) {
    this.mPerDegLng = M_PER_DEG_LAT * Math.cos(lat0 * DEG);
  }

  toLngLat(x: number, y: number): [number, number] {
    return [this.lng0 + x / this.mPerDegLng, this.lat0 + y / M_PER_DEG_LAT];
  }

  fromLngLat(lng: number, lat: number): { x: number; y: number } {
    return { x: (lng - this.lng0) * this.mPerDegLng, y: (lat - this.lat0) * M_PER_DEG_LAT };
  }
}

/** One landing direction of a runway: threshold point plus unit vector down the runway. */
export interface RunwayEnd {
  ident: string;
  x: number;
  y: number;
  /** Unit vector pointing from this threshold toward the far end. */
  dx: number;
  dy: number;
  /** True heading of the landing direction, degrees. */
  headingDeg: number;
  length: number;
  halfWidth: number;
}

export interface Runway {
  ends: [RunwayEnd, RunwayEnd];
  length: number;
  halfWidth: number;
}

export function buildRunways(airport: Airport, frame: LocalFrame): Runway[] {
  return airport.runways.map((r) => {
    const a = frame.fromLngLat(r.le.lng, r.le.lat);
    const b = frame.fromLngLat(r.he.lng, r.he.lat);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const dx = (b.x - a.x) / length;
    const dy = (b.y - a.y) / length;
    const halfWidth = (r.widthFt * FT) / 2;
    const heading = (Math.atan2(dx, dy) / DEG + 360) % 360;
    return {
      length,
      halfWidth,
      ends: [
        { ident: r.le.ident, x: a.x, y: a.y, dx, dy, headingDeg: heading, length, halfWidth },
        {
          ident: r.he.ident,
          x: b.x,
          y: b.y,
          dx: -dx,
          dy: -dy,
          headingDeg: (heading + 180) % 360,
          length,
          halfWidth,
        },
      ],
    };
  });
}

/**
 * Position relative to a runway end: `along` is distance past the threshold
 * (negative = still on approach), `cross` is right-of-centerline distance.
 */
export function runwayRelative(end: RunwayEnd, x: number, y: number) {
  const rx = x - end.x;
  const ry = y - end.y;
  return {
    along: rx * end.dx + ry * end.dy,
    cross: rx * end.dy - ry * end.dx,
  };
}

/** Margin lets a wheel sit just on the edge stripe without counting as off-runway. */
export function onRunway(rwy: Runway, x: number, y: number, margin = 3): boolean {
  const { along, cross } = runwayRelative(rwy.ends[0], x, y);
  return along >= -margin && along <= rwy.length + margin && Math.abs(cross) <= rwy.halfWidth + margin;
}

export function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
