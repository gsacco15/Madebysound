// Three short songs composed in code, so the app has music to play with before you open your own.
// Each one is rendered offline with Web Audio and then analysed like any other track.

const SR = 44100;
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

export const DEMOS = [
  { id: 'glass-lullaby', title: 'Glass Lullaby', bpm: 76, bars: 8, mood: 'Soft bells over warm chords', compose: lullaby },
  { id: 'night-drive', title: 'Night Drive', bpm: 112, bars: 8, mood: 'Four-on-the-floor synth bass', compose: nightDrive },
  { id: 'bright-rush', title: 'Bright Rush', bpm: 150, bars: 12, mood: 'Fast arpeggios, a breakdown and a drop', compose: brightRush },
];

const cache = new Map();

export function renderDemo(demo) {
  if (!cache.has(demo.id)) cache.set(demo.id, render(demo));
  return cache.get(demo.id);
}

async function render(demo) {
  const beat = 60 / demo.bpm;
  const seconds = demo.bars * 4 * beat;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(2, Math.ceil((seconds + 0.05) * SR), SR);
  const master = ctx.createGain();
  master.gain.value = 0.7;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 3;
  master.connect(comp).connect(ctx.destination);
  const verb = ctx.createConvolver();
  verb.buffer = impulse(ctx, 2.4);
  const verbGain = ctx.createGain();
  verbGain.gain.value = 0.28;
  verb.connect(verbGain).connect(master);
  // Hats and claps share one filter each instead of one per hit, which keeps rendering quick.
  const hatBus = ctx.createBiquadFilter();
  hatBus.type = 'highpass';
  hatBus.frequency.value = 7500;
  hatBus.connect(master);
  const clapBus = ctx.createBiquadFilter();
  clapBus.type = 'bandpass';
  clapBus.frequency.value = 1600;
  clapBus.Q.value = 0.9;
  clapBus.connect(master);
  const clapVerb = ctx.createGain();
  clapVerb.gain.value = 0.6;
  clapBus.connect(clapVerb).connect(verb);
  const s = { ctx, out: master, verb, beat, seconds, noise: noiseBuffer(ctx), hatBus, clapBus };
  demo.compose(s);
  return ctx.startRendering();
}

function impulse(ctx, seconds) {
  const len = Math.floor(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = rand() * (1 - i / len) ** 3;
  }
  return buf;
}

function noiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 3;
  for (let i = 0; i < d.length; i++) d[i] = ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  return buf;
}

function envGain(ctx, t, peak, attack, release) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
  return g;
}

function send(s, node, amount) {
  if (!amount) return;
  const g = s.ctx.createGain();
  g.gain.value = amount;
  node.connect(g).connect(s.verb);
}

function kick(s, t, peak = 0.9) {
  const o = s.ctx.createOscillator();
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  const g = envGain(s.ctx, t, peak, 0.004, 0.4);
  o.connect(g).connect(s.out);
  o.start(t);
  o.stop(t + 0.45);
}

function hat(s, t, peak = 0.12, length = 0.05) {
  const src = s.ctx.createBufferSource();
  src.buffer = s.noise;
  const g = envGain(s.ctx, t, peak, 0.002, length);
  src.connect(g).connect(s.hatBus);
  src.start(t, (t * 7.31) % 0.8);
  src.stop(t + length + 0.02);
}

function clap(s, t, peak = 0.35) {
  const src = s.ctx.createBufferSource();
  src.buffer = s.noise;
  const g = envGain(s.ctx, t, peak, 0.003, 0.18);
  src.connect(g).connect(s.clapBus);
  src.start(t, (t * 3.17) % 0.7);
  src.stop(t + 0.22);
}

// A crash cymbal: a long wash of bright noise.
function crash(s, t, peak = 0.3) {
  const src = s.ctx.createBufferSource();
  src.buffer = s.noise;
  src.loop = true;
  const g = envGain(s.ctx, t, peak, 0.002, 1.6);
  src.connect(g).connect(s.hatBus);
  send(s, g, 0.4);
  src.start(t);
  src.stop(t + 1.65);
}

// A noise sweep that rises into a drop and cuts off right on it.
function riser(s, t, length, peak = 0.06) {
  const src = s.ctx.createBufferSource();
  src.buffer = s.noise;
  src.loop = true;
  const bp = s.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(7000, t + length);
  const g = s.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + length);
  src.connect(bp).connect(g).connect(s.out);
  src.start(t);
  src.stop(t + length);
}

function tone(s, t, midi, length, { type = 'sine', peak = 0.15, attack = 0.01, cutoff = 0, detune = 0, reverb = 0 } = {}) {
  const o = s.ctx.createOscillator();
  o.type = type;
  o.frequency.value = midiHz(midi);
  o.detune.value = detune;
  const g = envGain(s.ctx, t, peak, attack, length);
  let node = o;
  if (cutoff) {
    const lp = s.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff * 3, t);
    lp.frequency.exponentialRampToValueAtTime(cutoff, t + Math.min(0.25, length));
    node = node.connect(lp);
  }
  node.connect(g).connect(s.out);
  send(s, g, reverb);
  o.start(t);
  o.stop(t + attack + length + 0.05);
}

function bell(s, t, midi, peak = 0.12) {
  tone(s, t, midi, 1.6, { peak, attack: 0.003, reverb: 0.8 });
  tone(s, t, midi + 19.02, 0.5, { peak: peak * 0.3, attack: 0.002, reverb: 0.6 });
  tone(s, t, midi + 28.0, 0.18, { peak: peak * 0.15, attack: 0.001 });
}

function pad(s, t, chord, length, peak = 0.05, type = 'triangle') {
  for (const m of chord) {
    for (const detune of [-7, 7]) tone(s, t, m, length, { type, peak, attack: 0.4, cutoff: 1400, detune, reverb: 0.5 });
  }
}

function eachBar(s, bars, fn) {
  for (let bar = 0; bar < bars; bar++) fn(bar, bar * 4 * s.beat);
}

// F major, I–vi–IV–V. Bells on the beat, softer in between.
function lullaby(s) {
  const chords = [[53, 57, 60], [50, 53, 57], [46, 50, 53], [48, 52, 55]];
  eachBar(s, 8, (bar, t0) => {
    const chord = chords[bar % 4];
    pad(s, t0, chord, 4 * s.beat, 0.035);
    tone(s, t0, chord[0] - 12, 4 * s.beat, { peak: 0.12, attack: 0.05 });
    kick(s, t0, 0.35);
    const arp = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[1] + 24];
    for (let i = 0; i < 8; i++) {
      bell(s, t0 + i * s.beat * 0.5, arp[i % 4], i % 2 === 0 ? 0.11 : 0.05);
    }
  });
}

// A minor, i–VI–iv–V. Eighth-note bass, claps on two and four.
function nightDrive(s) {
  const chords = [[57, 60, 64], [53, 57, 60], [50, 53, 57], [52, 56, 59]];
  const roots = [45, 41, 38, 40];
  eachBar(s, 8, (bar, t0) => {
    const c = bar % 4;
    pad(s, t0, chords[c], 4 * s.beat, 0.025, 'sawtooth');
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * s.beat;
      kick(s, t, 0.85);
      if (b % 2 === 1) clap(s, t, 0.3);
      hat(s, t + s.beat / 2, 0.09);
    }
    for (let e = 0; e < 8; e++) {
      tone(s, t0 + e * s.beat * 0.5, roots[c] - 12 + (e % 2 ? 12 : 0), s.beat * 0.4, { type: 'sawtooth', peak: 0.12, cutoff: 420 });
    }
    if (bar >= 2) {
      const lead = [chords[c][2] + 12, chords[c][1] + 12, chords[c][0] + 12, chords[c][1] + 12];
      lead.forEach((m, i) => tone(s, t0 + i * s.beat, m, s.beat * 0.8, { type: 'square', peak: 0.03, cutoff: 1800, reverb: 0.4 }));
    }
  });
}

// F♯ major, I–vi–IV–V at 150 BPM. Sixteenth hats and bright plucked arpeggios. Bars 7 and 8 drop
// the drums and bass and build back up, and bar 9 lands the drop.
function brightRush(s) {
  const chords = [[54, 58, 61], [51, 54, 58], [47, 51, 54], [49, 53, 56]];
  const roots = [42, 39, 47, 37];
  eachBar(s, 12, (bar, t0) => {
    const c = bar % 4;
    pad(s, t0, chords[c].map((m) => m + 12), 4 * s.beat, 0.018, 'sawtooth');
    if (bar === 7) riser(s, t0, 4 * s.beat);
    if (bar === 8) crash(s, t0);
    const breakdown = bar === 6 || bar === 7;
    for (let i = 0; i < 16; i++) {
      const arp = [0, 1, 2, 1];
      const m = chords[c][arp[i % 4]] + 24 + (i >= 8 ? 12 : 0);
      tone(s, t0 + i * s.beat * 0.25, m, s.beat * 0.22, { type: 'sawtooth', peak: breakdown ? 0.025 : 0.035, cutoff: 2600, reverb: 0.3 });
    }
    if (breakdown) return;
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * s.beat;
      if (b === 0 || b === 2) kick(s, t, 0.8);
      if (b === 3) kick(s, t + s.beat * 0.5, 0.55);
      if (b % 2 === 1) clap(s, t, 0.28);
    }
    for (let i = 0; i < 16; i++) hat(s, t0 + i * s.beat * 0.25, i % 4 === 2 ? 0.1 : 0.05, 0.035);
    for (let e = 0; e < 4; e++) tone(s, t0 + e * s.beat, roots[c], s.beat * 0.8, { type: 'triangle', peak: 0.2, cutoff: 600 });
  });
}
