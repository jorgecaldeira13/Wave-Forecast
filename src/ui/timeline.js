// Seven-day strip: one bar per hour (breaking wave height, coloured by rating),
// the tide as a line, night shaded. Drag to scrub.

export const RATING_COLOURS = ['#5b6f7d', '#6f8ea3', '#4fa8d8', '#40cfb5', '#a5df5c', '#ffd34d'];
export const ratingColour = (score) => RATING_COLOURS[Math.min(5, Math.max(0, Math.round(score)))];

export class Timeline {
  constructor({ canvas, daysEl, hours, quick, timezone, isNight, onSelect }) {
    Object.assign(this, { canvas, daysEl, hours, quick, timezone, isNight, onSelect });
    this.index = 0;
    this.ctx = canvas.getContext('2d');
    this.maxH = Math.max(1.2, ...quick.map((q) => q.surfHeight)) * 1.12;
    this.tideMin = Math.min(...hours.map((h) => h.tide));
    this.tideMax = Math.max(...hours.map((h) => h.tide));
    this.buildDays();
    const pick = (ev) => {
      const r = canvas.getBoundingClientRect();
      const i = Math.floor(((ev.clientX - r.left) / r.width) * hours.length);
      onSelect(Math.min(hours.length - 1, Math.max(0, i)));
    };
    canvas.addEventListener('pointerdown', (ev) => {
      canvas.setPointerCapture(ev.pointerId);
      this.dragging = true;
      pick(ev);
    });
    canvas.addEventListener('pointermove', (ev) => this.dragging && pick(ev));
    const stop = () => { this.dragging = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  buildDays() {
    const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', timeZone: this.timezone });
    const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone });
    this.days = [];
    this.hours.forEach((h, i) => {
      const key = keyFmt.format(h.time);
      const last = this.days[this.days.length - 1];
      if (!last || last.key !== key) this.days.push({ key, start: i, count: 1, label: dayFmt.format(h.time) });
      else last.count++;
    });
    this.daysEl.style.gridTemplateColumns = this.days.map((d) => `${d.count}fr`).join(' ');
    this.daysEl.style.gridAutoFlow = 'unset';
    this.daysEl.replaceChildren(
      ...this.days.map((d) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = d.count >= 10 ? d.label : '';
        b.title = d.label;
        // jump to the middle of the daylight part of that day
        b.addEventListener('click', () => this.onSelect(Math.min(this.hours.length - 1, d.start + Math.min(d.count - 1, 12))));
        d.el = b;
        return b;
      }),
    );
  }

  setIndex(i) {
    this.index = i;
    for (const d of this.days) d.el.classList.toggle('active', i >= d.start && i < d.start + d.count);
    this.draw();
  }

  draw() {
    const { canvas, ctx, hours, quick } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const n = hours.length;
    const bw = w / n;
    const base = h - 2;
    const top = 14;

    // night bands
    ctx.fillStyle = 'rgba(0, 6, 14, 0.42)';
    for (let i = 0; i < n; i++) if (this.isNight(hours[i])) ctx.fillRect(i * bw, 0, bw + 0.5, h);

    // day separators
    ctx.fillStyle = 'rgba(190, 225, 235, 0.14)';
    for (const d of this.days) if (d.start > 0) ctx.fillRect(Math.round(d.start * bw), 0, 1, h);

    // bars
    const gap = bw > 3 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const v = quick[i].surfHeight;
      const bh = Math.max(1.5, (v / this.maxH) * (base - top));
      ctx.globalAlpha = i === this.index ? 1 : this.isNight(hours[i]) ? 0.5 : 0.85;
      ctx.fillStyle = ratingColour(quick[i].rating.score);
      ctx.fillRect(i * bw + gap / 2, base - bh, Math.max(1, bw - gap), bh);
    }
    ctx.globalAlpha = 1;

    // tide line
    ctx.beginPath();
    const span = Math.max(0.5, this.tideMax - this.tideMin);
    for (let i = 0; i < n; i++) {
      const y = base - 4 - ((hours[i].tide - this.tideMin) / span) * (base - top - 8);
      const x = (i + 0.5) * bw;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(238, 246, 248, 0.5)';
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // scale hint
    ctx.fillStyle = 'rgba(169, 188, 198, 0.75)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(`${this.maxH.toFixed(1)} m`, 3, 1);
    const tideLabel = 'tide';
    ctx.fillText(tideLabel, w - ctx.measureText(tideLabel).width - 4, 1);

    // cursor
    const cx = (this.index + 0.5) * bw;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(cx) - 1, 0, 2, h);
    ctx.beginPath();
    ctx.moveTo(cx - 5, 0); ctx.lineTo(cx + 5, 0); ctx.lineTo(cx, 6); ctx.closePath();
    ctx.fill();
  }
}
