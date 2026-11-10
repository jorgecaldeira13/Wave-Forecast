// Text readouts and the little compass.

import { compassPoint } from '../model/seaState.js';
import { ratingColour } from './timeline.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

function el(name, attrs, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

const KIND_NAMES = { swell: 'Swell', swell2: '2nd swell', wind: 'Wind waves' };

export class Hud {
  constructor(beach) {
    this.beach = beach;
    $('beach-name').textContent = beach.name;
    $('region').textContent = beach.region.replace(', ', ' · ');
    this.whenFmt = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: beach.timezone,
    });
    $('rating-dots').replaceChildren(...Array.from({ length: 5 }, () => document.createElement('i')));
    this.buildCompass();
  }

  buildCompass() {
    const svg = $('compass');
    svg.replaceChildren();
    el('circle', { r: 46, fill: 'rgba(255,255,255,0.04)', stroke: 'rgba(190,225,235,0.22)', 'stroke-width': 1 }, svg);
    for (let a = 0; a < 360; a += 45) {
      const g = el('g', { transform: `rotate(${a})` }, svg);
      el('line', { x1: 0, y1: -46, x2: 0, y2: a % 90 === 0 ? -40 : -43, stroke: 'rgba(190,225,235,0.4)', 'stroke-width': 1 }, g);
    }
    const n = el('text', { x: 0, y: -49, 'text-anchor': 'middle', 'font-size': 9, fill: '#a9bcc6', 'font-weight': 600 }, svg);
    n.textContent = 'N';
    // the land side of the beach as a sand-coloured arc
    const sb = this.beach.seawardBearing;
    const landArc = el('path', { fill: 'rgba(227,207,156,0.28)', stroke: '#e3cf9c', 'stroke-width': 1.5 }, svg);
    const pt = (bearing, r) => {
      const rad = (bearing * Math.PI) / 180;
      return `${(Math.sin(rad) * r).toFixed(2)} ${(-Math.cos(rad) * r).toFixed(2)}`;
    };
    // chord perpendicular to the seaward bearing, land on the far side
    landArc.setAttribute('d', `M ${pt(sb - 90, 40)} A 40 40 0 0 0 ${pt(sb + 90, 40)} Z`);
    const mkArrow = (colour, width) => {
      const g = el('g', {}, svg);
      el('line', { x1: 0, y1: -40, x2: 0, y2: -9, stroke: colour, 'stroke-width': width, 'stroke-linecap': 'round' }, g);
      el('path', { d: 'M -6 -17 L 0 -6 L 6 -17 Z', fill: colour }, g);
      return g;
    };
    this.swellArrow = mkArrow('#5fe3cf', 3.2);
    this.windArrow = mkArrow('#ffb454', 2.2);
  }

  /** @param state result of computeSeaState; @param nextHour for the tide trend */
  update(state, nextHour) {
    const { hour } = state;
    $('when').textContent = this.whenFmt.format(hour.time);

    const h = state.surfHeight;
    $('surf-height').textContent = h < 0.05 ? '0' : h.toFixed(1);
    $('surf-size').textContent = state.sizeLabel;
    const bits = [];
    if (state.surf) {
      bits.push(`${state.surf.breakerType} waves`);
      if (state.setHeight > h + 0.15) bits.push(`sets to ${state.setHeight.toFixed(1)} m`);
    } else bits.push('nothing breaking');
    $('surf-detail').textContent = bits.join(' · ');

    const dots = $('rating-dots').children;
    const tone = ratingColour(state.rating.score);
    for (let i = 0; i < 5; i++) {
      const fill = Math.min(1, Math.max(0, state.rating.score - i));
      dots[i].style.setProperty('--fill', `${fill * 100}%`);
      dots[i].style.setProperty('--tone', tone);
    }
    $('rating-label').textContent = state.rating.label;
    $('rating').setAttribute('aria-label', `Surf rating ${state.rating.score} out of 5: ${state.rating.label}`);

    // swell: describe the main offshore train, then what else is in the water
    const main = [...hour.trains].sort((a, b) => b.height ** 2 * b.period - a.height ** 2 * a.period)[0];
    $('swell-value').textContent = `${main.height.toFixed(1)} m · ${main.period.toFixed(0)} s`;
    const others = hour.trains.filter((t) => t !== main && t.height >= 0.2)
      .map((t) => `${KIND_NAMES[t.kind].toLowerCase()} ${t.height.toFixed(1)} m`);
    $('swell-sub').textContent = [`from ${compassPoint(main.direction)} ${Math.round(main.direction)}°`, ...others].join(' · ');
    this.swellArrow.setAttribute('transform', `rotate(${main.direction})`);

    if (hour.wind) {
      $('wind-value').textContent = `${Math.round(hour.wind.speed)} km/h ${compassPoint(hour.wind.direction)}`;
      const gust = hour.wind.gust ? ` · gusts ${Math.round(hour.wind.gust)}` : '';
      $('wind-sub').textContent = `${state.windRelation.label}${gust}`;
      this.windArrow.setAttribute('transform', `rotate(${hour.wind.direction})`);
      this.windArrow.style.display = '';
    } else {
      $('wind-value').textContent = '—';
      $('wind-sub').textContent = 'wind forecast unavailable';
      this.windArrow.style.display = 'none';
    }
    // where the wind number comes from, and what the other model thinks
    const note = $('wind-note');
    note.replaceChildren();
    const ai = hour.windAI, local = hour.windLocal, src = hour.wind?.source;
    const say = (w) => `${Math.round(w.speed)} km/h ${compassPoint(w.direction)}`;
    const sure = ai?.spread != null ? ` ±${Math.round(ai.spread)}` : '';
    if (src === 'google') {
      note.append('Google WeatherNext 2', sure ? `${sure} km/h` : '');
      if (local) note.append(` · regional model ${say(local)}`);
    } else if (src === 'blend') {
      note.append(`Blend · Google AI ${say(ai)}${sure} · regional ${say(local)}`);
    } else if (src === 'local') {
      note.append('Regional hi-res model');
      if (ai) note.append(` · Google AI ${say(ai)}${sure}`);
    }
    // flag the hours where the two forecasts tell different stories
    if (ai && local && Math.abs(ai.speed - local.speed) > Math.max(10, 2 * (ai.spread ?? 0))) {
      const b = document.createElement('b');
      b.textContent = ' · models disagree';
      note.append(b);
    }

    const trend = nextHour ? (nextHour.tide > hour.tide + 0.02 ? 'rising' : nextHour.tide < hour.tide - 0.02 ? 'falling' : 'slack') : '';
    $('tide-value').textContent = `${hour.tide >= 0 ? '+' : '−'}${Math.abs(hour.tide).toFixed(1)} m`;
    $('tide-sub').textContent = trend;

    $('water-value').textContent = hour.waterTemp !== null ? `${hour.waterTemp.toFixed(0)} °C` : '—';
    $('water-sub').textContent = hour.airTemp !== null ? `air ${hour.airTemp.toFixed(0)} °C` : state.surf ? `breaks ${Math.max(0, Math.round(-state.surf.breakX))} m out` : '';
  }

  showNotice(text) {
    const n = $('notice');
    n.textContent = text;
    n.hidden = !text;
  }
}
