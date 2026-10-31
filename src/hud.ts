export interface HudData {
  speedKt: number;
  aglFt: number;
  vsFpm: number;
  headingDeg: number;
  throttle: number;
  flapDeg: number;
  /** Flap setting as a notch count (0 = up). */
  flapNotch: number;
  brakes: boolean;
  stall: boolean;
  onGround: boolean;
  target: { ident: string; distNm: number };
  /** Degrees above (+) or below (-) the 3° glide path; null when not on approach. */
  glideslope: number | null;
  /** Degrees right (+) or left (-) of the extended centerline; null when not on approach. */
  localizer: number | null;
  /** Target threshold in camera space (x right, y up, -z forward). */
  targetCam: { x: number; y: number; z: number };
  focal: number;
  showHints: boolean;
}

const ACCENT = '#7cf3c8';
const FLAP_NOTCHES = 3;

// Full-scale deflection, matching a real ILS (2 dots each side).
const GS_FULL = 1.4;
const LOC_FULL = 2.5;

/** A labelled readout cell in the top bar. */
function cell(bar: HTMLElement, label: string, unit = ''): { root: HTMLElement; value: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'hud-cell';
  root.dataset.k = label;
  root.innerHTML = `<span class="hud-label"></span><span class="hud-value"></span><span class="hud-unit"></span>`;
  root.children[0].textContent = label;
  root.children[2].textContent = unit;
  bar.appendChild(root);
  return { root, value: root.children[1] as HTMLElement };
}

/** Mini ILS scale: five dots and a diamond that slides along it. */
function scale(bar: HTMLElement, label: string, vertical: boolean): { root: HTMLElement; diamond: HTMLElement } {
  const root = document.createElement('div');
  root.className = `hud-cell hud-ils ${vertical ? 'vertical' : 'horizontal'}`;
  root.innerHTML = `<span class="hud-label"></span><div class="ils-track"><i></i><i></i><b></b><i></i><i></i><span class="ils-diamond"></span></div>`;
  root.children[0].textContent = label;
  bar.appendChild(root);
  return { root, diamond: root.querySelector('.ils-diamond') as HTMLElement };
}

/** A thin vertical rule, appended to `parent` or placed right after `after`. */
function divider(parent: HTMLElement, after?: HTMLElement): void {
  const d = document.createElement('div');
  d.className = 'hud-divider';
  if (after) after.after(d);
  else parent.appendChild(d);
}

/**
 * Everything lives in one translucent bar across the top. The only thing drawn
 * in the 3D view is the target runway marker (a bracket, or an edge arrow).
 */
export class Hud {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bar: HTMLElement;
  private readonly hints: HTMLElement;
  private readonly el;
  private w = 0;
  private h = 0;
  private last: Record<string, string> = {};
  /** Every element that acts as a throttle / flaps button (top bar and mobile dock). */
  readonly throttleButtons: HTMLElement[];
  readonly flapsButtons: HTMLElement[];
  private readonly dock;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    container: HTMLElement,
  ) {
    this.ctx = canvas.getContext('2d')!;

    const wrap = document.createElement('div');
    wrap.id = 'hud-bar';
    this.bar = document.createElement('div');
    this.bar.className = 'hud-row';
    wrap.appendChild(this.bar);

    // Two groups so narrow screens can stack them as two rows.
    const flight = document.createElement('div');
    const nav = document.createElement('div');
    flight.className = nav.className = 'hud-group';
    this.bar.append(flight, nav);

    const speed = cell(flight, 'SPD', 'KT');
    const alt = cell(flight, 'ALT', 'FT');
    const vs = cell(flight, 'V/S', 'FPM');
    divider(flight);
    const hdg = cell(flight, 'HDG');
    divider(this.bar, flight);
    const rwy = cell(nav, 'RWY');
    const dist = cell(nav, 'DIST', 'NM');
    divider(nav);
    const gs = scale(nav, 'GS', true);
    const loc = scale(nav, 'LOC', false);
    divider(nav);
    const thr = cell(nav, 'THR', '%');
    const thrBar = document.createElement('div');
    thrBar.className = 'thr-bar';
    thrBar.innerHTML = '<span></span>';
    thr.root.insertBefore(thrBar, thr.value);
    const flaps = cell(nav, 'FLAPS');
    thr.root.classList.add('pressable');
    flaps.root.classList.add('pressable');
    const status = document.createElement('div');
    status.className = 'hud-status';
    nav.appendChild(status);

    this.hints = document.createElement('div');
    this.hints.className = 'hud-hints';
    // Keyboard shortcuts only; hidden on touch devices via CSS.
    this.hints.innerHTML =
      '<div class="hud-hints-inner">' +
      '<span><kbd>↑</kbd><kbd>↓</kbd> pitch</span><span><kbd>←</kbd><kbd>→</kbd> roll</span>' +
      '<span><kbd>C</kbd><kbd>V</kbd> throttle</span><span><kbd>F</kbd> flaps</span>' +
      '<span><kbd>B</kbd> brakes</span><span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> camera</span>' +
      '<span><kbd>P</kbd> pause</span><span><kbd>R</kbd> restart</span>' +
      '</div>';
    wrap.appendChild(this.hints);
    container.appendChild(wrap);

    // Mobile dock: big, obvious power and flaps buttons along the bottom.
    const dockEl = document.createElement('div');
    dockEl.id = 'hud-dock';
    dockEl.innerHTML = `
      <div class="dock-btn" data-k="power">
        <div class="dock-head"><span class="dock-label">POWER</span><span class="dock-value"></span></div>
        <div class="dock-meter"><span></span></div>
        <div class="dock-caption">TAP + · HOLD −</div>
      </div>
      <div class="dock-btn" data-k="flaps">
        <div class="dock-head"><span class="dock-label">FLAPS</span><span class="dock-value"></span></div>
        <div class="dock-notches">${'<i></i>'.repeat(FLAP_NOTCHES)}</div>
        <div class="dock-caption">TAP + · HOLD −</div>
      </div>`;
    container.appendChild(dockEl);
    const [powerBtn, flapsBtn] = Array.from(dockEl.querySelectorAll<HTMLElement>('.dock-btn'));
    this.dock = {
      el: dockEl,
      powerValue: powerBtn.querySelector('.dock-value') as HTMLElement,
      powerFill: powerBtn.querySelector('.dock-meter span') as HTMLElement,
      flapsValue: flapsBtn.querySelector('.dock-value') as HTMLElement,
      notches: Array.from(flapsBtn.querySelectorAll<HTMLElement>('.dock-notches i')),
    };

    this.el = { wrap, speed, alt, vs, hdg, rwy, dist, gs, loc, thr, thrFill: thrBar.firstElementChild as HTMLElement, flaps, status };
    this.throttleButtons = [thr.root, powerBtn];
    this.flapsButtons = [flaps.root, flapsBtn];

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setVisible(visible: boolean): void {
    this.el.wrap.classList.toggle('visible', visible);
    this.dock.el.classList.toggle('visible', visible);
    if (!visible) this.ctx.clearRect(0, 0, this.w, this.h);
  }

  /** Only touch the DOM when a value actually changes. */
  private set(key: string, el: HTMLElement, text: string): void {
    if (this.last[key] === text) return;
    this.last[key] = text;
    el.textContent = text;
  }

  private flag(key: string, el: HTMLElement, cls: string, on: boolean): void {
    const k = `${key}:${cls}`;
    const v = on ? '1' : '0';
    if (this.last[k] === v) return;
    this.last[k] = v;
    el.classList.toggle(cls, on);
  }

  draw(d: HudData, time: number): void {
    const e = this.el;

    this.set('spd', e.speed.value, `${Math.round(d.speedKt)}`);
    this.flag('spd', e.speed.root, 'warn', !d.onGround && d.speedKt < 55 && !d.stall);
    this.flag('spd', e.speed.root, 'danger', d.stall);

    this.set('alt', e.alt.value, Math.max(0, Math.round(d.aglFt)).toLocaleString('en-US'));
    this.flag('alt', e.alt.root, 'warn', !d.onGround && d.aglFt < 200);

    const vs = Math.round(d.vsFpm / 10) * 10;
    this.set('vs', e.vs.value, `${vs > 0 ? '▲' : vs < 0 ? '▼' : ''}${Math.abs(vs).toLocaleString('en-US')}`);
    this.flag('vs', e.vs.root, 'danger', d.aglFt < 100 && vs < -600);

    this.set('hdg', e.hdg.value, `${String(Math.round(d.headingDeg) % 360).padStart(3, '0')}°`);
    this.set('rwy', e.rwy.value, d.target.ident);
    this.set('dist', e.dist.value, d.target.distNm.toFixed(1));

    const active = d.glideslope !== null && d.localizer !== null && !d.onGround;
    this.flag('ils', e.gs.root, 'inactive', !active);
    this.flag('ils', e.loc.root, 'inactive', !active);
    if (active) {
      // Fly toward the diamond: it shows where the glide path / centerline is.
      const gs = clamp(-d.glideslope! / GS_FULL, -1, 1);
      const loc = clamp(-d.localizer! / LOC_FULL, -1, 1);
      e.gs.diamond.style.top = `${50 - gs * 45}%`;
      e.loc.diamond.style.left = `${50 + loc * 45}%`;
    }

    this.set('thr', e.thr.value, `${Math.round(d.throttle * 100)}`);
    e.thrFill.style.transform = `scaleX(${d.throttle.toFixed(3)})`;
    this.set('flaps', e.flaps.value, `${d.flapDeg}°`);
    this.set('dockPower', this.dock.powerValue, `${Math.round(d.throttle * 100)}%`);
    this.dock.powerFill.style.transform = `scaleX(${d.throttle.toFixed(3)})`;
    this.set('dockFlaps', this.dock.flapsValue, `${d.flapDeg}°`);
    this.dock.notches.forEach((n, i) => this.flag(`notch${i}`, n, 'on', i < d.flapNotch));
    this.flag('flaps', e.flaps.root, 'on', d.flapDeg > 0);

    const status = d.stall ? 'STALL' : d.brakes ? 'BRAKES' : '';
    this.set('status', e.status, status);
    this.flag('status', e.status, 'danger', d.stall);
    this.flag('status', e.status, 'blink', d.stall && Math.floor(time * 4) % 2 === 0);

    this.flag('hints', this.hints, 'visible', d.showHints);

    this.targetMarker(d);
  }

  /** Bracket on the target threshold when visible, otherwise an arrow at the screen edge. */
  private targetMarker(d: HudData): void {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const { x, y, z } = d.targetCam;
    const cx = w / 2;
    const cy = h / 2;
    const margin = 60;
    // Keep clear of the top bar and (on mobile) the bottom dock.
    const top = this.el.wrap.getBoundingClientRect().bottom + 30;
    const dockRect = this.dock.el.getBoundingClientRect();
    const bottom = dockRect.height ? dockRect.top - 20 : h - 50;
    ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';

    if (z < -1) {
      const sx = cx + (x / -z) * d.focal;
      const sy = cy - (y / -z) * d.focal;
      if (sx > margin && sx < w - margin && sy > top && sy < bottom) {
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2;
        const r = 14;
        ctx.beginPath();
        for (const [ax, ay] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]) {
          ctx.moveTo(sx + ax * r, sy + ay * (r - 6));
          ctx.lineTo(sx + ax * r, sy + ay * r);
          ctx.lineTo(sx + ax * (r - 6), sy + ay * r);
        }
        ctx.stroke();
        ctx.fillStyle = ACCENT;
        ctx.fillText(d.target.ident, sx, sy - r - 6);
        return;
      }
    }

    // Off screen (or behind): arrow at the edge of an inset ellipse.
    const angle = Math.atan2(-y, x);
    const ax = cx + Math.cos(angle) * (w / 2 - 70);
    const ay = (top + bottom) / 2 + Math.sin(angle) * ((bottom - top) / 2 - 40);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(angle);
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-8, -11);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-8, 11);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = ACCENT;
    ctx.fillText(d.target.ident, ax - Math.cos(angle) * 28, ay - Math.sin(angle) * 28 + 4);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
