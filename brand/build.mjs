/**
 * RoboNado identity — generated, not drawn.
 *
 * One governing curve: a logarithmic spiral, r(θ) = R·e^(−bθ), rendered as a
 * ribbon whose width decays on the same exponent that governs its radius. Two
 * arms, opposed, so the form reads as rotation rather than as rings. A single
 * near-white disc at the origin — the only place the eye can rest.
 *
 * Turbulence plotted with the calm of a measuring device.
 *
 *   node build.mjs
 */

import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

// ── palette ──────────────────────────────────────────────────────────────────
const INK = '#0B0E14'; // unlit ground
const BONE = '#FDF6E9'; // used once, at the point of resolution
const EMBER_RIM = '#A9571A'; // coolest, at the outer edge
const EMBER_EYE = "#FFD489"; // hottest, approaching the origin

// ── governing constants ──────────────────────────────────────────────────────
const S = 1024;
const C = S / 2;

const TURNS = 1.46; // revolutions each arm traces — fewer inner turns survive 40px
const R0 = 400; // radius at the rim
const W_RIM = 116; // ribbon width where it enters
const TAPER = 1.24; // width decays faster than radius when > 1
const ARMS = 2; // opposed, for rotational read
const SAMPLES = 480; // enough that the edge is a curve, not a polygon

const THETA = TURNS * 2 * Math.PI;
const B = Math.log(R0 / 34) / THETA; // spiral tightens to r≈34 at the eye

const f = (n) => Number(n.toFixed(2));

function parse(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
function mix(a, b, t) {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const ch = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

const radius = (t) => R0 * Math.exp(-B * t);
const halfWidth = (t) => (W_RIM / 2) * Math.pow(radius(t) / R0, TAPER);

/**
 * One arm as a closed path: out along the spiral's outer edge, back along its
 * inner edge. Offsetting radially rather than normally keeps the two edges
 * concentric with the curve, which is what stops the ribbon pinching on the
 * tighter inner turns.
 */
function arm(phase) {
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

  return `<path d="${d}" fill="url(#heat)"/>`;
}

/** The rim end of each arm, rounded so the ribbon enters rather than stops. */
function cap(phase) {
  const r = radius(0);
  const h = halfWidth(0);
  return `<circle cx="${f(C + r * Math.cos(phase))}" cy="${f(C + r * Math.sin(phase))}" r="${f(h)}" fill="${EMBER_RIM}"/>`;
}

function defs() {
  // Radial, so temperature tracks distance from the origin rather than the
  // page — the gradient belongs to the form, not the frame.
  const stops = [0, 0.28, 0.55, 0.8, 1]
    .map((s) => `<stop offset="${s}" stop-color="${mix(EMBER_EYE, EMBER_RIM, s)}"/>`)
    .join('');
  return `<defs><radialGradient id="heat" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient></defs>`;
}

function mark() {
  const phases = [...Array(ARMS).keys()].map((i) => (i * 2 * Math.PI) / ARMS);
  return [
    defs(),
    ...phases.map(cap),
    ...phases.map(arm),
    `<circle cx="${C}" cy="${C}" r="52" fill="${BONE}"/>`,
  ].join('\n  ');
}

function svg({ ground = INK, scale = 1 } = {}) {
  const g = ground === 'none' ? '' : `<rect width="${S}" height="${S}" fill="${ground}"/>`;
  const t =
    scale === 1
      ? ''
      : ` transform="translate(${C},${C}) scale(${scale}) translate(${-C},${-C})"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  ${g}
  <g${t}>
  ${mark()}
  </g>
</svg>`;
}

// Telegram crops to a circle, so the mark sits inside the inscribed circle
// with margin rather than filling the square.
const avatar = svg({ ground: INK, scale: 0.86 });
const transparent = svg({ ground: 'none', scale: 0.94 });

writeFileSync('robonado-mark.svg', transparent);
writeFileSync('robonado-avatar.svg', avatar);

const png = (src, size, out) =>
  sharp(Buffer.from(src)).resize(size, size).png({ compressionLevel: 9 }).toFile(out);

await Promise.all([
  png(avatar, 1024, 'robonado-avatar-1024.png'),
  png(avatar, 512, 'robonado-avatar-512.png'),
  png(avatar, 128, 'robonado-avatar-128.png'),
  png(avatar, 40, 'robonado-avatar-40.png'),
  png(transparent, 1024, 'robonado-mark-1024.png'),
  png(transparent, 256, 'robonado-mark-256.png'),
]);

console.log('rendered 6 files');
