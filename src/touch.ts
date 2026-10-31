const STICK_RANGE = 70; // px of drag for full deflection

/**
 * Drag-anywhere virtual joystick. Drag the plane where you want it to go:
 * up = nose up, sideways = roll. A ring and knob follow the finger.
 */
export class TouchStick {
  pitch = 0;
  roll = 0;
  /** Off while tilt controls are in charge. */
  enabled = true;
  private pointerId: number | null = null;
  private ox = 0;
  private oy = 0;
  private readonly knob: HTMLElement;

  constructor(
    private readonly el: HTMLElement,
    isBlocked: (target: EventTarget | null) => boolean,
  ) {
    this.knob = el.querySelector('.stick-knob') as HTMLElement;

    window.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.pointerId !== null || e.button !== 0 || isBlocked(e.target)) return;
      this.pointerId = e.pointerId;
      this.ox = e.clientX;
      this.oy = e.clientY;
      el.style.left = `${e.clientX}px`;
      el.style.top = `${e.clientY}px`;
      el.classList.add('active');
      this.move(e.clientX, e.clientY);
    });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pointerId) this.move(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.pointerId) this.release();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', () => this.release());
  }

  private move(x: number, y: number): void {
    let dx = x - this.ox;
    let dy = y - this.oy;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RANGE) {
      dx *= STICK_RANGE / len;
      dy *= STICK_RANGE / len;
    }
    this.roll = dx / STICK_RANGE;
    this.pitch = -dy / STICK_RANGE;
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  private release(): void {
    this.pointerId = null;
    this.pitch = 0;
    this.roll = 0;
    this.el.classList.remove('active');
  }
}

const HOLD_MS = 350;

/**
 * Tap fires `onTap`; pressing longer than HOLD_MS fires `onHoldStart` instead,
 * then `onHoldEnd` on release.
 */
export function pressable(
  el: HTMLElement,
  handlers: { onTap: () => void; onHoldStart: () => void; onHoldEnd?: () => void },
): void {
  let timer: number | undefined;
  let held = false;
  let pointerId: number | null = null;

  el.addEventListener('pointerdown', (e) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    el.setPointerCapture(e.pointerId);
    el.classList.add('pressed');
    held = false;
    timer = window.setTimeout(() => {
      held = true;
      handlers.onHoldStart();
    }, HOLD_MS);
  });
  const finish = (e: PointerEvent, cancelled: boolean) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    clearTimeout(timer);
    el.classList.remove('pressed');
    if (held) handlers.onHoldEnd?.();
    else if (!cancelled) handlers.onTap();
  };
  el.addEventListener('pointerup', (e) => finish(e, false));
  el.addEventListener('pointercancel', (e) => finish(e, true));
}

const TILT_ROLL_RANGE = 25; // degrees of sideways tilt for full roll
const TILT_PITCH_RANGE = 20; // degrees of fore/aft tilt (from neutral) for full pitch
const TILT_DEADZONE = 2.5;

/** iOS 13+ gates motion sensors behind a permission prompt that needs a user gesture. */
type PermissionRequestable = { requestPermission?: () => Promise<'granted' | 'denied'> };

/**
 * Tilt the phone to fly: sideways tilt rolls, tipping the top away from you
 * pushes the nose down (like a yoke). Fore/aft neutral is wherever the phone
 * was held when calibrated; sideways neutral is level.
 */
export class TiltControl {
  pitch = 0;
  roll = 0;
  private started = false;
  private pitch0: number | null = null;

  get enabled(): boolean {
    return this.started;
  }

  /** Ask for sensor access and start listening. Must run inside a tap handler on iOS. */
  async start(): Promise<boolean> {
    if (this.started) return true;
    const DOE = window.DeviceOrientationEvent as unknown as PermissionRequestable | undefined;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    window.addEventListener('deviceorientation', (e) => this.onOrientation(e));
    this.started = true;
    return true;
  }

  /** Treat the next reading's fore/aft angle as neutral. */
  calibrate(): void {
    this.pitch0 = null;
  }

  private onOrientation(e: DeviceOrientationEvent): void {
    if (e.beta == null || e.gamma == null) return;
    const b = e.beta * (Math.PI / 180);
    const g = e.gamma * (Math.PI / 180);

    // Gravity in device coordinates (x right, y toward the top edge, z out of the screen).
    const gx = Math.sin(g) * Math.cos(b);
    const gy = -Math.sin(b);
    const gz = -Math.cos(g) * Math.cos(b);

    // Rotate into screen coordinates so landscape works too.
    const a = ((screen.orientation?.angle ?? 0) * Math.PI) / 180;
    const sx = gx * Math.cos(a) - gy * Math.sin(a);
    const sy = gx * Math.sin(a) + gy * Math.cos(a);

    const rollDeg = Math.atan2(sx, Math.hypot(sy, gz)) * (180 / Math.PI);
    // 0 = screen upright; positive = top tipped away from you.
    const tipDeg = Math.atan2(-gz, -sy) * (180 / Math.PI);
    if (this.pitch0 === null) this.pitch0 = tipDeg;

    const shape = (deg: number, range: number) => {
      const mag = Math.max(0, Math.abs(deg) - TILT_DEADZONE) / (range - TILT_DEADZONE);
      return Math.sign(deg) * Math.min(1, mag);
    };
    // Low-pass to take the jitter out of the sensor.
    this.roll += (shape(rollDeg, TILT_ROLL_RANGE) - this.roll) * 0.35;
    this.pitch += (-shape(tipDeg - this.pitch0, TILT_PITCH_RANGE) - this.pitch) * 0.35;
  }
}
