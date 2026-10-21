// Small signal generators for analysis tests.
export const SR = 44100;

export function silence(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Short decaying noise bursts on every beat.
export function clickTrack(bpm, seconds, seed = 1) {
  const out = silence(seconds);
  const rand = mulberry(seed);
  const period = Math.round((60 / bpm) * SR);
  const burst = Math.round(0.03 * SR);
  for (let start = 0; start < out.length; start += period) {
    for (let i = 0; i < burst && start + i < out.length; i++) {
      out[start + i] += (rand() * 2 - 1) * 0.6 * Math.exp(-i / (0.006 * SR));
    }
  }
  return out;
}

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

// Each chord is a list of MIDI notes held for `beats` beats; tones have a few harmonics.
export function chordSequence(chords, bpm, beatsPerChord = 2) {
  const beat = 60 / bpm;
  const seconds = chords.length * beatsPerChord * beat;
  const out = silence(seconds);
  chords.forEach((notes, c) => {
    const start = Math.round(c * beatsPerChord * beat * SR);
    const len = Math.round(beatsPerChord * beat * SR);
    for (const note of notes) {
      const f = midiHz(note);
      for (let i = 0; i < len && start + i < out.length; i++) {
        const t = i / SR;
        const env = Math.min(1, t / 0.01) * Math.exp(-t * 1.5);
        const s = Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t) + 0.2 * Math.sin(6 * Math.PI * f * t);
        out[start + i] += s * env * 0.12;
      }
    }
  });
  return out;
}

export function noise(seconds, color, seed = 7) {
  const out = silence(seconds);
  const rand = mulberry(seed);
  let lp = 0;
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rand() * 2 - 1;
    if (color === 'brown') {
      lp = lp * 0.995 + w * 0.05;
      out[i] = lp;
    } else if (color === 'hiss') {
      out[i] = (w - prev) * 0.25;
      prev = w;
    } else {
      out[i] = w * 0.25;
    }
  }
  return out;
}

export function mix(...signals) {
  const n = Math.max(...signals.map((s) => s.length));
  const out = new Float32Array(n);
  for (const s of signals) for (let i = 0; i < s.length; i++) out[i] += s[i];
  return out;
}
