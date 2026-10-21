// The note's shape, shared by the shader host (renderer.js) and the 3D exporter (mesh.js).
// noteDistance() mirrors map() in shader.js with the music at rest, so exported models match the screen.

export const SHAPE_KEYS = [
  'headSize', 'headTilt', 'stemWidth', 'stemHeight', 'beamSlant', 'beamThickness', 'liquidity', 'rippleFreq',
  'rippleAmp', 'detail', 'twist', 'lean', 'iridescence', 'dispersion', 'envelopeDepth', 'pulse', 'saturation',
];

// In the tile view the liquid creeps up the wall at the song's two strongest pitches, placed on the
// circle of fifths as in the pitch wheel. Positions are fractions of a turn, 0 at the bottom.
function rimPulls(dna) {
  const order = dna.chroma.map((v, pc) => [v, pc]).filter(([, pc]) => pc !== dna.tonic).sort((a, b) => b[0] - a[0]);
  const second = order.length ? order[0][1] : (dna.tonic + 7) % 12;
  return {
    rimA: ((dna.tonic * 7) % 12) / 12,
    rimB: ((second * 7) % 12) / 12,
    pullA: 0.05 + 0.055 * Math.min(1, Math.max(0, (dna.headSize - 0.29) / 0.11)),
    pullB: 0.03 + 0.04 * Math.min(1, Math.max(0, (dna.stemHeight - 1.3) / 0.4)),
  };
}

export function toParams(dna) {
  const p = { hue: dna.hue, hue2: dna.hue2, beams: dna.beams, envelope: Float32Array.from(dna.envelope), ...rimPulls(dna) };
  for (const key of SHAPE_KEYS) p[key] = dna[key];
  return p;
}

// Places heads, stems and beam(s) from the DNA, centred on the origin.
export function layout(p) {
  const r = p.headSize;
  const spacing = 1.22;
  const h1 = [-spacing / 2, -0.62];
  const h2 = [spacing / 2, -0.62 + p.beamSlant];
  const attachX = r * 1.3 * Math.cos(p.headTilt) * 0.9;
  const attachY = r * 1.3 * Math.sin(p.headTilt) * 0.5;
  const s1x = h1[0] + attachX;
  const s2x = h2[0] + attachX;
  const top1 = h1[1] + p.stemHeight;
  const top2 = h2[1] + p.stemHeight;
  const minX = h1[0] - r * 1.3;
  const maxX = s2x + p.stemWidth * 2;
  const minY = Math.min(h1[1], h2[1]) - r;
  const maxY = Math.max(top1, top2);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    H1: [h1[0] - cx, h1[1] - cy, 0, r],
    H2: [h2[0] - cx, h2[1] - cy, 0, r],
    S1: [s1x - cx, h1[1] + attachY - cy, top1 - cy, p.stemWidth],
    S2: [s2x - cx, h2[1] + attachY - cy, top2 - cy, p.stemWidth],
    beam: [s1x - cx, top1 - cy, s2x - cx, top2 - cy],
    beam2: [p.beamThickness, p.stemWidth * 2.6, p.beams, p.beamThickness * 1.75],
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function ellipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return (k0 * (k0 - 1)) / k1;
}

function roundBox(x, y, z, bx, by, bz, r) {
  const qx = Math.abs(x) - bx + r;
  const qy = Math.abs(y) - by + r;
  const qz = Math.abs(z) - bz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

// Returns a signed distance function for the note at rest: no music, no motion.
export function noteDistance(p) {
  const g = layout(p);
  const env = p.envelope;
  const envAt = (t) => {
    const x = clamp01(t) * 31;
    const i = Math.floor(x);
    const j = Math.min(i + 1, 31);
    return env[i] + (env[j] - env[i]) * (x - i);
  };
  const ct = Math.cos(p.headTilt);
  const st = Math.sin(p.headTilt);
  const head = (x, y, z, h) => {
    const qx = x - h[0];
    const qy = y - h[1];
    const rx = ct * qx + st * qy;
    const ry = -st * qx + ct * qy;
    return ellipsoid(rx, ry, z - h[2], 1.3 * h[3], 0.9 * h[3], 0.78 * h[3]);
  };
  const stem = (x, y, z, s, start) => {
    const t = clamp01((y - s[1]) / (s[2] - s[1]));
    const w = s[3] * (1 - 0.5 * p.envelopeDepth + p.envelopeDepth * envAt(start + t * 0.5));
    return Math.hypot(x - s[0], y - (s[1] + (s[2] - s[1]) * t), z) - w;
  };
  const [ax, ay, bx, by] = g.beam;
  const len = Math.hypot(bx - ax, by - ay);
  const dx = (bx - ax) / len;
  const dy = (by - ay) / len;
  const nx = -dy;
  const ny = dx;
  const [th, depth, count, gap] = g.beam2;
  const halfLen = 0.5 * len + g.S1[3] * 1.3;
  const radius = Math.min(th, depth) * 0.45;
  const beam = (x, y, z, offset) => {
    const cx = 0.5 * (ax + bx) - nx * (th * 0.5 + offset);
    const cy = 0.5 * (ay + by) - ny * (th * 0.5 + offset);
    const qx = x - cx;
    const qy = y - cy;
    return roundBox(qx * dx + qy * dy, qx * nx + qy * ny, z, halfLen, th * 0.5, depth * 0.5, radius);
  };

  return (px, py, pz) => {
    const x0 = px - p.lean * py;
    const a = p.twist * py;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x = ca * x0 + sa * pz;
    const z = -sa * x0 + ca * pz;
    const y = py;
    const join = p.liquidity;
    let d = head(x, y, z, g.H1);
    d = smin(d, head(x, y, z, g.H2), join);
    d = smin(d, stem(x, y, z, g.S1, 0), join);
    d = smin(d, stem(x, y, z, g.S2, 0.5), join);
    let bm = beam(x, y, z, 0);
    if (count > 1.5) bm = Math.min(bm, beam(x, y, z, gap));
    d = smin(d, bm, join * 0.7);
    const r1 = Math.hypot(x - g.H1[0], y - g.H1[1], z - g.H1[2]);
    const r2 = Math.hypot(x - g.H2[0], y - g.H2[1], z - g.H2[2]);
    const frozen = Math.sin(r1 * p.rippleFreq) + Math.sin(r2 * p.rippleFreq + 1.7);
    const fine = Math.sin(x * 31) * Math.sin(y * 27) * Math.sin(z * 29);
    return d + p.rippleAmp * frozen * 0.5 + p.detail * fine;
  };
}
