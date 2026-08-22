/**
 * Plate I — the mark, presented as an instrument reading.
 *
 * The graticule, the ticks and the constants are not decoration: they are the
 * apparatus the form was measured with, drawn at the same weight as the thing
 * measured. Turbulence, held still long enough to be read.
 *
 *   node plate.mjs
 */

import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const W = 1600;
const H = 2100;

const INK = '#0B0E14';
const BONE = '#FDF6E9';
const EMBER_RIM = '#A9571A';
const EMBER_EYE = '#FFD489';
const GRID = '#232B3B'; // apparatus — present, never competing
const LABEL = '#5C6474'; // clinical annotation
const WARM = '#8A6F4E'; // annotation that belongs to the form

// governing constants, shared with build.mjs
const TURNS = 1.46;
const R0 = 400;
const W_RIM = 116;
const TAPER = 1.24;
const ARMS = 2;
const SAMPLES = 480;
const THETA = TURNS * 2 * Math.PI;
const B = Math.log(R0 / 34) / THETA;

const f = (n) => Number(n.toFixed(2));
const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function mix(a, b, t) {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const ch = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

const radius = (t) => R0 * Math.exp(-B * t);
const halfWidth = (t) => (W_RIM / 2) * Math.pow(radius(t) / R0, TAPER);

/** The mark, drawn about a local origin of (512,512) in a 1024 field. */
function markBody(id) {
  const C = 512;
  const stops = [0, 0.28, 0.55, 0.8, 1]
    .map((s) => `<stop offset="${s}" stop-color="${mix(EMBER_EYE, EMBER_RIM, s)}"/>`)
    .join('');

  const phases = [...Array(ARMS).keys()].map((i) => (i * 2 * Math.PI) / ARMS);

  const caps = phases
    .map((p) => {
      const r = radius(0);
      const h = halfWidth(0);
      return `<circle cx="${f(C + r * Math.cos(p))}" cy="${f(C + r * Math.sin(p))}" r="${f(h)}" fill="${EMBER_RIM}"/>`;
    })
    .join('');

  const arms = phases
    .map((phase) => {
      const outer = [];
      const inner = [];
      for (let i = 0; i <= SAMPLES; i++) {
        const t = (i / SAMPLES) * THETA;
        const r = radius(t);
        const h = halfWidth(t);
        const a = t + phase;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        outer.push([C + (r + h) * cos, C + (r + h) * sin]);
        inner.push([C + (r - h) * cos, C + (r - h) * sin]);
      }
      const d =
        `M ${f(outer[0][0])} ${f(outer[0][1])} ` +
        outer.slice(1).map(([x, y]) => `L ${f(x)} ${f(y)}`).join(' ') +
        ' ' +
        inner.reverse().map(([x, y]) => `L ${f(x)} ${f(y)}`).join(' ') +
        ' Z';
      return `<path d="${d}" fill="url(#${id})"/>`;
    })
    .join('');

  return {
    defs: `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`,
    body: `${caps}${arms}<circle cx="${C}" cy="${C}" r="52" fill="${BONE}"/>`,
  };
}

/** Places the mark at (cx,cy) with the given diameter. */
function placed(cx, cy, diameter, id) {
  const s = diameter / 1024;
  const { body } = markBody(id);
  return `<g transform="translate(${f(cx - diameter / 2)},${f(cy - diameter / 2)}) scale(${f(s)})">${body}</g>`;
}

// ── apparatus ────────────────────────────────────────────────────────────────
const CX = 800;
const CY = 810;

/** Concentric rings and radial ticks — the instrument the form was read on. */
function graticule() {
  const rings = [300, 400, 500, 560]
    .map(
      (r, i) =>
        `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${GRID}" stroke-width="${i === 3 ? 1.6 : 1}"/>`,
    )
    .join('');

  let ticks = '';
  for (let d = 0; d < 360; d += 7.5) {
    const major = d % 90 === 0;
    const mid = d % 30 === 0;
    const len = major ? 30 : mid ? 18 : 9;
    const a = (d * Math.PI) / 180;
    const r1 = 560;
    const r2 = 560 + len;
    ticks +=
      `<line x1="${f(CX + r1 * Math.cos(a))}" y1="${f(CY + r1 * Math.sin(a))}" ` +
      `x2="${f(CX + r2 * Math.cos(a))}" y2="${f(CY + r2 * Math.sin(a))}" ` +
      `stroke="${major ? WARM : GRID}" stroke-width="${major ? 1.8 : 1}"/>`;
  }

  // Crosshair, stopped short of the form so it frames rather than crosses it.
  const cross =
    `<line x1="${CX}" y1="150" x2="${CX}" y2="${CY - 610}" stroke="${GRID}" stroke-width="1"/>` +
    `<line x1="${CX}" y1="${CY + 610}" x2="${CX}" y2="${CY + 700}" stroke="${GRID}" stroke-width="1"/>` +
    `<line x1="130" y1="${CY}" x2="${CX - 610}" y2="${CY}" stroke="${GRID}" stroke-width="1"/>` +
    `<line x1="${CX + 610}" y1="${CY}" x2="1470" y2="${CY}" stroke="${GRID}" stroke-width="1"/>`;

  return rings + ticks + cross;
}

const mono = (x, y, size, fill, text, opts = '') =>
  `<text x="${x}" y="${y}" font-family="Consolas, monospace" font-size="${size}" fill="${fill}" letter-spacing="${size * 0.14}" ${opts}>${text}</text>`;

// ── specimen strip: what a viewer actually receives ──────────────────────────
function specimens() {
  const sizes = [128, 72, 40];
  const gap = 46;
  const baseY = 1848;
  const labelY = 1950; // one baseline for every label, whatever the diameter
  let x = 1120; // right edge lands inside the 1470 margin
  let out = '';

  for (const [i, d] of sizes.entries()) {
    const cx = x + d / 2;
    out +=
      `<circle cx="${cx}" cy="${baseY}" r="${d / 2 + 7}" fill="none" stroke="${GRID}" stroke-width="1"/>` +
      `<clipPath id="c${i}"><circle cx="${cx}" cy="${baseY}" r="${d / 2}"/></clipPath>` +
      `<g clip-path="url(#c${i})"><rect x="${cx - d / 2}" y="${baseY - d / 2}" width="${d}" height="${d}" fill="${INK}"/>` +
      placed(cx, baseY, d * 0.86, `sp${i}`) +
      `</g>` +
      mono(cx, labelY, 15, LABEL, `${d}`, 'text-anchor="middle"');
    x += d + gap;
  }
  return out;
}

const { defs } = markBody('heat');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    ${defs}
    ${[0, 1, 2].map((i) => markBody(`sp${i}`).defs).join('\n    ')}
  </defs>

  <rect width="${W}" height="${H}" fill="${INK}"/>

  ${graticule()}
  ${placed(CX, CY, 900, 'heat')}

  ${mono(130, 168, 18, LABEL, 'INSTRUMENT WEATHER')}
  ${mono(1470, 168, 18, LABEL, 'PLATE I', 'text-anchor="end"')}
  <line x1="130" y1="196" x2="1470" y2="196" stroke="${GRID}" stroke-width="1"/>

  <text x="${W / 2}" y="1560" font-family="Segoe UI, sans-serif" font-weight="300"
        font-size="96" fill="${BONE}" letter-spacing="26" text-anchor="middle">ROBONADO</text>
  ${mono(W / 2, 1616, 19, WARM, 'COMMODITIES &#183; FX &#183; EQUITIES', 'text-anchor="middle"')}

  <line x1="130" y1="1720" x2="1470" y2="1720" stroke="${GRID}" stroke-width="1"/>

  ${mono(130, 1772, 16, LABEL, 'GOVERNING CURVE')}
  ${mono(130, 1808, 20, WARM, 'r(&#952;) = R &#183; e^(&#8722;b&#952;)')}
  ${mono(130, 1848, 16, LABEL, `TURNS ${TURNS.toFixed(2)}   ARMS ${ARMS}   TAPER ${TAPER.toFixed(2)}`)}
  ${mono(130, 1880, 16, LABEL, `b = ${B.toFixed(4)}   R = ${R0}`)}
  ${mono(130, 1912, 16, LABEL, 'NADO &#183; INK L2')}

  ${specimens()}
  ${mono(1470, 1772, 16, LABEL, 'RENDERED DIAMETER, PX', 'text-anchor="end"')}
</svg>`;

writeFileSync('plate.svg', svg);
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile('robonado-plate.png');
console.log('plate rendered');
