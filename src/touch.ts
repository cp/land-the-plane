const STICK_RANGE = 70; // px of drag for full deflection

/**
 * Drag-anywhere virtual joystick. Drag the plane where you want it to go:
 * up = nose up, sideways = roll. A ring and knob follow the finger.
 */
export class TouchStick {
  pitch = 0;
  roll = 0;
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
      if (this.pointerId !== null || e.button !== 0 || isBlocked(e.target)) return;
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
