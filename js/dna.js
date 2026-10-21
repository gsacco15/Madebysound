// Note DNA: the visual parameters a song's features sculpt into its glass note.
// Same features in, same DNA out. That is what makes a note collectible.

export const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Keys are colored by their place on the circle of fifths, so related keys sit near each other in hue.
export const fifthsPosition = (pc) => (pc * 7) % 12;
export const pitchHue = (pc) => (fifthsPosition(pc) / 12 + 0.55) % 1;

const HUE_NAMES = [
  [0.04, 'red'], [0.09, 'vermilion'], [0.13, 'amber'], [0.18, 'gold'], [0.26, 'lime'], [0.37, 'green'],
  [0.46, 'teal'], [0.53, 'cyan'], [0.6, 'azure'], [0.68, 'blue'], [0.76, 'indigo'], [0.83, 'violet'],
  [0.9, 'magenta'], [0.96, 'rose'], [1.01, 'red'],
];
export function hueName(h) {
  const x = ((h % 1) + 1) % 1;
  return HUE_NAMES.find(([edge]) => x < edge)[1];
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Coarse quantization keeps tiny float differences between browsers from changing a note's identity.
export function fingerprint(f) {
  const parts = [
    f.version,
    Math.round(f.duration),
    Math.round(f.tempo),
    f.key.tonic,
    f.key.mode,
    ...Object.values(f.bands).map((v) => Math.round(v * 100)),
    Math.round(f.brightness * 100),
    Math.round(f.dynamicRange),
    Math.round(f.onsetRate * 10),
    ...f.envelope.map((v) => Math.round(v * 20)),
    ...f.chroma.map((v) => Math.round(v * 10)),
  ];
  return fnv1a(parts.join('|'));
}

function secondaryPitch(f) {
  let best = (f.key.tonic + 7) % 12;
  let bestValue = -1;
  f.chroma.forEach((v, pc) => {
    if (pc !== f.key.tonic && v > bestValue) {
      bestValue = v;
      best = pc;
    }
  });
  return best;
}

export function makeDNA(f) {
  const seed = fingerprint(f);
  const rand = mulberry32(seed);
  const b = f.bands;
  const low = clamp01((b.sub + b.bass) / 0.55);
  const lowMid = clamp01(b.lowMid / 0.35);
  const mid = clamp01(b.mid / 0.3);
  const top = clamp01((b.highMid + b.air) / 0.6);
  const bright = clamp01((f.brightness - 0.25) / 0.65);
  const busy = clamp01(f.onsetRate / 6);
  const dyn = clamp01(f.dynamicRange / 24);
  const tempo = f.tempo > 0 ? f.tempo : 96;
  const minor = f.key.mode === 'minor';
  const hex = seed.toString(16).toUpperCase().padStart(8, '0');

  return {
    id: hex,
    label: `No. ${hex.slice(0, 4)}·${hex.slice(4)}`,
    keyName: `${PITCH_NAMES[f.key.tonic]} ${f.key.mode}`,
    tonic: f.key.tonic,
    hue: (pitchHue(f.key.tonic) + (rand() - 0.5) * 0.03 + 1) % 1,
    hue2: pitchHue(secondaryPitch(f)),
    saturation: clamp(0.5 + 0.35 * f.key.confidence - (minor ? 0.08 : 0), 0.3, 0.9),
    headSize: 0.29 + 0.11 * low,
    headTilt: 0.32 + 0.22 * rand(),
    stemWidth: 0.05 + 0.035 * lowMid,
    stemHeight: 1.3 + 0.4 * bright,
    beams: tempo >= 128 || busy > 0.7 ? 2 : 1,
    beamSlant: (minor ? -1 : 1) * (0.08 + 0.18 * rand()),
    beamThickness: 0.12 + 0.06 * mid,
    liquidity: 0.06 + 0.22 * (1 - busy),
    rippleFreq: 7 + 9 * clamp01((tempo - 60) / 120),
    rippleAmp: 0.002 + 0.007 * dyn,
    detail: 0.0008 + 0.003 * top,
    twist: (rand() - 0.5) * 0.5,
    lean: (rand() - 0.5) * 0.22,
    iridescence: 0.3 + 0.55 * clamp01(f.flatness * 4 + bright * 0.3),
    dispersion: 0.015 + 0.05 * bright,
    envelopeDepth: 0.35 + 0.5 * dyn,
    pulse: tempo / 60,
    envelope: f.envelope.slice(),
    chroma: f.chroma.slice(),
  };
}

// The readout that explains how this song made this note.
export function describe(f, dna) {
  const low = Math.round((f.bands.sub + f.bands.bass) * 100);
  const khz = f.centroidHz >= 1000 ? `${(f.centroidHz / 1000).toFixed(1)} kHz` : `${Math.round(f.centroidHz)} Hz`;
  return [
    { label: 'Key', value: dna.keyName, effect: `${capitalize(hueName(dna.hue))} glass, from the key's place on the circle of fifths` },
    { label: 'Tempo', value: f.tempo > 0 ? `${Math.round(f.tempo)} BPM` : 'Free time', effect: 'Ripple spacing and the breathing pulse' },
    { label: 'Low end', value: `${low}%`, effect: 'Weight of the note heads' },
    { label: 'Attack', value: `${f.onsetRate.toFixed(1)} onsets/s`, effect: f.onsetRate > 3 ? 'Crisp joins, two beams when it runs fast' : 'Liquid joins between head, stem and beam' },
    { label: 'Brightness', value: khz, effect: 'Stem height and how far light splits' },
    { label: 'Dynamics', value: `${Math.round(f.dynamicRange)} dB`, effect: 'Depth of the frozen ripples' },
  ];
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
