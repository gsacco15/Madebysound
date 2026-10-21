import { NoteRenderer, MATERIALS, SCENES } from './renderer.js';
import { AudioEngine } from './audio-engine.js';
import { analyzeAudioBuffer } from './analysis.js';
import { makeDNA, describe, pitchHue, fifthsPosition, PITCH_NAMES } from './dna.js';
import { DEMOS, renderDemo } from './demos.js';
import { DEMO_FEATURES } from './demo-features.js';
import { loadCollection, keepNote, removeNote, isKept } from './collection.js';
import { saveFile, canvasToBlob, makeCard, recordClip, clipSupported, inArtifactViewer, slug } from './exporter.js';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  fallback: $('fallback'),
  play: $('play'),
  noteId: $('note-id'),
  title: $('song-title'),
  meta: $('song-meta'),
  keep: $('keep'),
  saveCard: $('save-card'),
  record: $('record'),
  recordLabel: $('record-label'),
  capture: $('capture'),
  captureLabel: $('capture-label'),
  seek: $('seek'),
  wave: $('track-wave'),
  timeNow: $('time-now'),
  timeTotal: $('time-total'),
  open: $('open'),
  file: $('file'),
  demos: $('demos'),
  listen: $('listen'),
  listenLabel: $('listen-label'),
  busy: $('busy'),
  busyTitle: $('busy-title'),
  busyStep: $('busy-step'),
  busyFill: $('busy-fill'),
  drop: $('drop'),
  toast: $('toast'),
  readout: $('readout'),
  envChart: $('env-chart'),
  bands: $('bands'),
  wheel: $('wheel'),
  materials: $('materials'),
  scenes: $('scenes'),
  influence: $('influence'),
  influenceOut: $('influence-out'),
  ripplesToggle: $('ripples-toggle'),
  turnToggle: $('turn-toggle'),
  grid: $('collection-grid'),
  collectionEmpty: $('collection-empty'),
  collectionCount: $('collection-count'),
  dock: $('dock'),
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SETTINGS_KEY = 'madebysound.settings.v1';
const settings = { material: 0, scene: 0, influence: 0.7, ripples: true, turn: !reducedMotion, ...readSettings() };

const engine = new AudioEngine();
let renderer = null;
let track = null;
let listeningFrom = null;
let busyToken = 0;
let toastTimer = 0;
const ripples = [];
const view = { yaw: 0, pitch: 0, zoom: 1, autoAmp: settings.turn ? 1 : 0, shift: [0, 0], fit: 1, targetShift: [0, 0], targetFit: 1 };
const ambientState = { lastBeat: -1, mix: 1 };

const BAND_LABELS = { sub: 'Sub', bass: 'Bass', lowMid: 'Low-mid', mid: 'Mid', highMid: 'High-mid', air: 'Air' };

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked; settings just won't persist.
  }
}

const formatTime = (s) => {
  const t = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const metaLine = (features, dna, source) =>
  [dna.keyName, features.tempo > 0 ? `${Math.round(features.tempo)} BPM` : null, source].filter(Boolean).join(' · ');

function cleanTitle(name) {
  return (
    name
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/^\d{1,3}[\s._-]+/, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  );
}

// ---------- Track ----------

function setTrack(next, { autoplay = false } = {}) {
  track = next;
  engine.load(next.buffer || null, { loop: !!next.loop });
  renderer?.setDNA(next.dna);
  document.documentElement.style.setProperty('--song-h', Math.round(next.dna.hue * 360));
  els.noteId.textContent = next.dna.label;
  els.title.textContent = next.title;
  els.title.title = next.title;
  els.meta.textContent = next.meta;
  renderReadout();
  updateKeep();
  updateDemoButtons();
  syncTransport();
  if (next.pending) {
    next.pending.then((buffer) => {
      if (track !== next) return;
      next.buffer = buffer;
      next.pending = null;
      engine.load(buffer, { loop: !!next.loop });
      if (autoplay || next.wantsPlay) engine.play();
      syncTransport();
    });
  } else if (autoplay && next.buffer) {
    engine.play();
  }
}

function demoTrack(demo) {
  const features = DEMO_FEATURES[demo.id];
  const dna = makeDNA(features);
  return {
    kind: 'demo',
    demoId: demo.id,
    title: demo.title,
    meta: metaLine(features, dna, 'Demo'),
    features,
    dna,
    buffer: null,
    loop: true,
    pending: renderDemo(demo),
  };
}

function playDemo(demo) {
  if (track?.demoId === demo.id && track.kind === 'demo') {
    engine.unlock();
    if (track.pending) return;
    engine.toggle();
    return;
  }
  engine.unlock();
  stopListening();
  setTrack(demoTrack(demo), { autoplay: true });
}

async function openFile(file) {
  if (!file) return;
  const looksLikeAudio = file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?|webm|mp4)$/i.test(file.name);
  if (!looksLikeAudio) {
    toast('That file is not audio. Choose an MP3, M4A, WAV, FLAC or OGG file.');
    return;
  }
  engine.unlock();
  stopListening();
  const token = ++busyToken;
  showBusy('Listening to the whole song', 'Reading the file', 0.02);
  try {
    const data = await file.arrayBuffer();
    if (token !== busyToken) return;
    setBusy('Decoding the audio', 0.06);
    const buffer = await engine.decode(data);
    if (token !== busyToken) return;
    const features = await analyzeAudioBuffer(buffer, {
      onProgress: (p) => token === busyToken && setBusy('Listening for key, tempo and energy', 0.1 + p * 0.86),
    });
    if (token !== busyToken) return;
    setBusy('Shaping the glass', 1);
    const dna = makeDNA(features);
    setTrack({ kind: 'file', title: cleanTitle(file.name), meta: metaLine(features, dna, 'Your file'), features, dna, buffer }, { autoplay: true });
  } catch (err) {
    console.error(err);
    if (token === busyToken) {
      toast("Couldn't read that song. Files bought or downloaded from streaming apps are often copy-protected. Try an MP3, M4A or WAV you own.");
    }
  } finally {
    if (token === busyToken) hideBusy();
  }
}

function openSaved(entry) {
  const dna = makeDNA(entry.features);
  const demo = DEMOS.find((d) => d.id === entry.demoId);
  if (demo) {
    stopListening();
    setTrack({ ...demoTrack(demo), title: entry.title });
    return;
  }
  stopListening();
  const saved = new Date(entry.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  setTrack({ kind: 'saved', id: entry.id, title: entry.title, meta: metaLine(entry.features, dna, `Kept ${saved}`), features: entry.features, dna, buffer: null });
}

// ---------- Listening ----------

async function toggleListening() {
  if (engine.listening) {
    stopListening();
    return;
  }
  engine.unlock();
  try {
    await engine.startMic();
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your browser settings to use Listen.' : "Couldn't start the microphone.");
    return;
  }
  listeningFrom = track;
  els.title.textContent = 'Listening';
  els.meta.textContent = `Live from your microphone · ${track.dna.keyName} glass`;
  els.listen.setAttribute('aria-pressed', 'true');
  els.listenLabel.textContent = 'Stop';
  els.capture.hidden = false;
  els.record.hidden = true;
  syncTransport();
}

function stopListening() {
  if (!engine.listening && !listeningFrom) return;
  engine.stopMic();
  els.listen.setAttribute('aria-pressed', 'false');
  els.listenLabel.textContent = 'Listen';
  els.capture.hidden = true;
  els.record.hidden = false;
  if (listeningFrom && track === listeningFrom) {
    els.title.textContent = track.title;
    els.meta.textContent = track.meta;
  }
  listeningFrom = null;
  syncTransport();
}

async function captureFromMic() {
  const seconds = 12;
  els.capture.disabled = true;
  try {
    const buffer = await engine.recordMic(seconds, (p) => {
      els.captureLabel.textContent = `Recording ${Math.ceil(seconds * (1 - p))} s`;
    });
    const token = ++busyToken;
    showBusy('Listening to what you played', 'Analysing', 0.1);
    const features = await analyzeAudioBuffer(buffer, { onProgress: (p) => setBusy('Analysing', 0.1 + p * 0.9) });
    if (token !== busyToken) return;
    hideBusy();
    stopListening();
    const dna = makeDNA(features);
    const when = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    setTrack({ kind: 'capture', title: `Heard at ${when}`, meta: metaLine(features, dna, 'Microphone'), features, dna, buffer });
  } catch (err) {
    console.error(err);
    hideBusy();
    toast(err.message || "Couldn't record from the microphone.");
  } finally {
    els.capture.disabled = false;
    els.captureLabel.textContent = 'Make a note';
  }
}

// ---------- Ripples and ambient motion ----------

function spawnRipple(pitchClass, strength, now) {
  if (!settings.ripples) return;
  const angle = (fifthsPosition(pitchClass) / 12) * Math.PI * 2;
  const radius = 1.75 + Math.random() * 0.45;
  ripples.push({ x: Math.sin(angle) * radius, z: Math.cos(angle) * radius * 0.85 + 0.25, born: now, hue: pitchHue(pitchClass), strength });
  if (ripples.length > 12) ripples.shift();
}

function pickPitch(chroma) {
  const total = chroma.reduce((a, b) => a + b * b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < 12; i++) {
    r -= chroma[i] * chroma[i];
    if (r <= 0) return i;
  }
  return 0;
}

// When nothing is playing the note keeps breathing at its song's tempo and hums its pitches.
function ambient(now) {
  const dna = track?.dna;
  const rate = dna ? dna.pulse : 1.2;
  const phase = now * rate * 0.5;
  const beatIndex = Math.floor(phase);
  if (dna && beatIndex !== ambientState.lastBeat) {
    ambientState.lastBeat = beatIndex;
    if (ambientState.mix > 0.5) spawnRipple(pickPitch(dna.chroma), 0.55, now);
  }
  return {
    bass: 0.2 + 0.1 * Math.sin(now * 0.7),
    mid: 0.12 + 0.08 * Math.sin(now * 1.1 + 1),
    high: 0.06,
    beat: Math.exp(-(phase % 1) * 6) * 0.3,
    level: 0.2,
  };
}

// ---------- Render loop ----------

let lastFrame = performance.now();
let lastUi = 0;

function frame(ms) {
  const now = ms / 1000;
  const dt = Math.min(0.1, (ms - lastFrame) / 1000);
  lastFrame = ms;
  const live = engine.sample(now);
  const amb = ambient(now);
  ambientState.mix += ((live.active ? 0 : 1) - ambientState.mix) * (1 - Math.exp(-dt * 2));
  const m = ambientState.mix;
  for (const key of ['bass', 'mid', 'high', 'beat', 'level']) renderer.live[key] = live[key] * (1 - m) + amb[key] * m;

  while (ripples.length && now - ripples[0].born > 4.5) ripples.shift();
  renderer.setRipples(ripples, now);

  view.autoAmp += ((settings.turn ? 1 : 0) - view.autoAmp) * (1 - Math.exp(-dt * 1.5));
  const ease = 1 - Math.exp(-dt * 5);
  view.shift[0] += (view.targetShift[0] - view.shift[0]) * ease;
  view.shift[1] += (view.targetShift[1] - view.shift[1]) * ease;
  view.fit += (view.targetFit - view.fit) * ease;
  renderer.camera.yaw = view.yaw + 0.38 * Math.sin(now * 0.11) * view.autoAmp;
  renderer.camera.pitch = 0.12 + view.pitch;
  renderer.camera.zoom = view.zoom * view.fit;
  renderer.shift = view.shift;
  renderer.render(now);
  renderer.adapt(dt * 1000);

  if (ms - lastUi > 90) {
    lastUi = ms;
    updateTime();
  }
  requestAnimationFrame(frame);
}

// Keeps the note centred in the space the header, dock and open panel leave free.
function layoutView() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dock = els.dock.getBoundingClientRect();
  const top = document.querySelector('.topbar').getBoundingClientRect().bottom + 8;
  let bottom = dock.top - 8;
  let right = W;
  const panel = document.querySelector('.panel:not([hidden])');
  if (panel) {
    const r = panel.getBoundingClientRect();
    if (r.left > W * 0.4) right = r.left - 8;
    else bottom = Math.min(bottom, r.top - 8);
  }
  const availW = Math.max(120, right);
  const availH = Math.max(120, bottom - top);
  view.targetShift = [(availW / 2 - W / 2) / H, (H / 2 - (top + availH / 2)) / H];
  view.targetFit = Math.min(1, Math.min(availW, availH) / Math.min(W, H));
  document.documentElement.style.setProperty('--dock-h', `${Math.round(dock.height)}px`);
  document.documentElement.style.setProperty('--panel-top', `${Math.round(top + 2)}px`);
}

// ---------- Transport UI ----------

function syncTransport() {
  const listening = engine.listening;
  const pending = !!track?.pending;
  els.play.classList.toggle('is-playing', engine.playing);
  els.play.classList.toggle('is-pending', pending);
  els.play.disabled = listening || (!engine.buffer && !pending);
  els.play.setAttribute('aria-label', pending ? 'Loading' : engine.playing ? 'Pause' : 'Play');
  els.play.title = !engine.buffer && !pending && track?.kind === 'saved' ? 'Open the song again to hear it' : '';
  els.seek.disabled = !engine.buffer || listening;
  els.record.disabled = !engine.buffer || !clipSupported();
  els.keep.disabled = !track || listening;
  els.saveCard.disabled = !track;
  updateDemoButtons();
  updateTime();
}

function updateTime() {
  const duration = engine.duration || track?.features?.duration || 0;
  const current = engine.currentTime;
  els.timeNow.textContent = formatTime(current);
  els.timeTotal.textContent = formatTime(duration);
  const progress = duration ? current / duration : 0;
  if (document.activeElement !== els.seek) els.seek.value = String(Math.round(progress * 1000));
  drawTrackWave(progress);
}

function sizeCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

const songColor = (alpha = 1, light = 70) => `hsl(${Math.round((track?.dna.hue ?? 0.5) * 360)} 72% ${light}% / ${alpha})`;

// The scrubber shows the same loudness signature that is engraved along the stems.
function drawTrackWave(progress) {
  if (!track) return;
  const { w, h } = sizeCanvas(els.wave);
  const g = els.wave.getContext('2d');
  g.clearRect(0, 0, w, h);
  const env = track.dna.envelope;
  const step = w / env.length;
  const playedX = progress * w;
  env.forEach((v, i) => {
    const bh = Math.max(h * 0.12, v * h * 0.9);
    const x = i * step + step * 0.22;
    const bw = step * 0.56;
    const played = x + bw / 2 <= playedX;
    g.fillStyle = played ? songColor(0.95) : 'rgba(238, 241, 247, 0.2)';
    g.beginPath();
    g.roundRect ? g.roundRect(x, (h - bh) / 2, bw, bh, Math.min(bw / 2, 3)) : g.rect(x, (h - bh) / 2, bw, bh);
    g.fill();
  });
  if (engine.buffer) {
    g.fillStyle = 'rgba(238, 241, 247, 0.9)';
    g.fillRect(Math.round(playedX) - 1, 0, 2, h);
  }
}

function updateDemoButtons() {
  els.demos.querySelectorAll('.demo').forEach((b) => {
    const current = track?.kind === 'demo' && track.demoId === b.dataset.demo;
    b.setAttribute('aria-pressed', String(current));
  });
}

function updateKeep() {
  const kept = !!track && isKept(track.dna.id);
  els.keep.setAttribute('aria-pressed', String(kept));
  els.keep.querySelector('span').textContent = kept ? 'Kept' : 'Keep';
}

// ---------- Panels ----------

function setPanel(name) {
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== `panel-${name}`));
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-expanded', String(t.dataset.panel === name)));
  if (name === 'note') renderReadout();
  if (name === 'collection') renderCollection();
  layoutView();
}

function currentPanel() {
  return document.querySelector('.panel:not([hidden])')?.id.replace('panel-', '') ?? null;
}

function renderReadout() {
  if (!track || document.getElementById('panel-note').hidden) return;
  const { features, dna } = track;
  els.readout.replaceChildren(
    ...describe(features, dna).map((row) => {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      const strong = document.createElement('strong');
      strong.textContent = row.value;
      const span = document.createElement('span');
      span.textContent = row.effect;
      dd.append(strong, span);
      wrap.append(dt, dd);
      return wrap;
    }),
  );

  const max = Math.max(...Object.values(features.bands), 0.001);
  els.bands.replaceChildren(
    ...Object.entries(features.bands).map(([name, value]) => {
      const row = document.createElement('div');
      row.className = 'band';
      const label = document.createElement('span');
      label.textContent = BAND_LABELS[name];
      const bar = document.createElement('div');
      bar.className = 'band-bar';
      const fill = document.createElement('i');
      fill.style.transform = `scaleX(${value / max})`;
      bar.append(fill);
      const pct = document.createElement('b');
      pct.textContent = `${Math.round(value * 100)}%`;
      row.append(label, bar, pct);
      return row;
    }),
  );
  drawEnvelopeChart();
  drawWheel();
}

function drawEnvelopeChart() {
  const { w, h, dpr } = sizeCanvas(els.envChart);
  const g = els.envChart.getContext('2d');
  const env = track.dna.envelope;
  g.clearRect(0, 0, w, h);
  const pad = 2 * dpr;
  const x = (i) => pad + (i / (env.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - v * (h - pad * 2);
  g.strokeStyle = 'rgba(238, 241, 247, 0.08)';
  g.lineWidth = dpr;
  for (const v of [0.25, 0.5, 0.75]) {
    g.beginPath();
    g.moveTo(pad, y(v));
    g.lineTo(w - pad, y(v));
    g.stroke();
  }
  g.beginPath();
  g.moveTo(x(0), h);
  env.forEach((v, i) => g.lineTo(x(i), y(v)));
  g.lineTo(x(env.length - 1), h);
  g.closePath();
  const fill = g.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, songColor(0.45));
  fill.addColorStop(1, songColor(0));
  g.fillStyle = fill;
  g.fill();
  g.beginPath();
  env.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
  g.strokeStyle = songColor(1);
  g.lineWidth = 1.5 * dpr;
  g.stroke();
  g.strokeStyle = 'rgba(238, 241, 247, 0.35)';
  g.setLineDash([3 * dpr, 3 * dpr]);
  g.beginPath();
  g.moveTo(w / 2, 0);
  g.lineTo(w / 2, h);
  g.stroke();
  g.setLineDash([]);
}

// The circle of fifths laid out as seen from above the bath: the camera sits at the bottom.
function drawWheel() {
  const c = els.wheel;
  const g = c.getContext('2d');
  const s = c.width;
  g.clearRect(0, 0, s, s);
  const cx = s / 2;
  const cy = s / 2;
  const r = s * 0.36;
  g.strokeStyle = 'rgba(238, 241, 247, 0.12)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(238, 241, 247, 0.4)';
  g.font = '500 22px "Geist Mono", ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('♫', cx, cy);
  const tonic = track.dna.tonic;
  for (let pc = 0; pc < 12; pc++) {
    const a = (fifthsPosition(pc) / 12) * Math.PI * 2;
    const px = cx + Math.sin(a) * r;
    const py = cy + Math.cos(a) * r;
    const color = `hsl(${Math.round(pitchHue(pc) * 360)} 75% 66%)`;
    const strength = track.dna.chroma[pc];
    g.fillStyle = color;
    g.globalAlpha = 0.35 + 0.65 * strength;
    g.beginPath();
    g.arc(px, py, 9 + 9 * strength, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    if (pc === tonic) {
      g.strokeStyle = '#eef1f7';
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(px, py, 24, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = pc === tonic ? '#eef1f7' : 'rgba(238, 241, 247, 0.6)';
    g.font = '400 20px "Geist", system-ui, sans-serif';
    g.fillText(PITCH_NAMES[pc], cx + Math.sin(a) * (r + 44), cy + Math.cos(a) * (r + 44));
  }
}

function renderCollection() {
  const list = loadCollection();
  els.collectionCount.textContent = String(list.length);
  els.collectionCount.toggleAttribute('data-zero', list.length === 0);
  els.collectionEmpty.hidden = list.length > 0;
  els.grid.replaceChildren(
    ...list.map((entry) => {
      const dna = makeDNA(entry.features);
      const li = document.createElement('li');
      li.className = 'saved';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'saved-open';
      open.setAttribute('aria-label', `Show ${entry.title}`);
      if (track?.dna.id === entry.id) open.setAttribute('aria-current', 'true');
      if (entry.thumb) {
        const img = document.createElement('img');
        img.src = entry.thumb;
        img.alt = '';
        open.append(img);
      } else {
        open.style.background = `radial-gradient(circle at 50% 45%, hsl(${Math.round(dna.hue * 360)} 70% 55%), #07080b 70%)`;
      }
      open.addEventListener('click', () => openSaved(entry));
      const title = document.createElement('p');
      title.className = 'saved-title';
      title.textContent = entry.title;
      const meta = document.createElement('div');
      meta.className = 'saved-meta';
      const info = document.createElement('span');
      info.textContent = `${dna.keyName}${entry.features.tempo > 0 ? ` · ${Math.round(entry.features.tempo)}` : ''}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'saved-remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${entry.title}`);
      remove.addEventListener('click', () => {
        removeNote(entry.id);
        renderCollection();
        updateKeep();
      });
      meta.append(info, remove);
      li.append(open, title, meta);
      return li;
    }),
  );
}

// ---------- Actions ----------

// Stills are framed for a square, ignoring the on-screen fit around panels.
function still(size) {
  const zoom = renderer.camera.zoom;
  renderer.camera.zoom = view.zoom;
  const canvas = renderer.snapshot(performance.now() / 1000, size);
  renderer.camera.zoom = zoom;
  return canvas;
}

function thumbnail() {
  return still(240).toDataURL('image/jpeg', 0.82);
}

function toggleKeep() {
  if (!track) return;
  if (isKept(track.dna.id)) {
    removeNote(track.dna.id);
    toast('Removed from your collection');
  } else {
    const list = keepNote({
      id: track.dna.id,
      title: track.title,
      demoId: track.demoId,
      features: track.features,
      thumb: thumbnail(),
      savedAt: Date.now(),
    });
    toast(list ? 'Kept in your collection' : "Couldn't keep it. This browser is blocking storage.");
  }
  renderCollection();
  updateKeep();
}

async function saveNoteCard() {
  if (!track) return;
  els.saveCard.disabled = true;
  try {
    const card = await makeCard({ still: still(1080), title: track.title, meta: track.meta, dna: track.dna });
    const blob = await canvasToBlob(card);
    await saveFile(`madebysound-${slug(track.title)}.png`, blob);
  } catch (err) {
    if (err?.code !== 'declined') toast(err?.message || "Couldn't save the card.");
  } finally {
    els.saveCard.disabled = !track;
  }
}

async function recordNoteClip() {
  if (!engine.buffer) return;
  if (!engine.playing) engine.play();
  els.record.disabled = true;
  els.record.classList.add('is-live');
  try {
    const seconds = 8;
    const { blob, ext } = await recordClip(els.stage, engine.audioStream(), seconds, (t) => {
      els.recordLabel.textContent = `0:0${Math.max(0, Math.ceil(seconds - t))}`;
    });
    await saveFile(`madebysound-${slug(track.title)}.${ext}`, blob);
  } catch (err) {
    if (err?.code !== 'declined') toast(err?.message || "Couldn't record a clip.");
  } finally {
    els.record.classList.remove('is-live');
    els.recordLabel.textContent = 'Clip';
    syncTransport();
  }
}

// ---------- Busy + toast ----------

function showBusy(title, step, progress) {
  els.busyTitle.textContent = title;
  els.busy.hidden = false;
  setBusy(step, progress);
}

function setBusy(step, progress) {
  els.busyStep.textContent = step;
  els.busyFill.style.transform = `scaleX(${progress})`;
}

function hideBusy() {
  els.busy.hidden = true;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 4200);
}

// ---------- Wiring ----------

function buildChoices(container, name, options, selected, onChange) {
  container.replaceChildren(
    ...options.map((opt, i) => {
      const label = document.createElement('label');
      label.className = 'chip';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.id = `${name}-${opt.id}`;
      input.value = String(i);
      input.checked = i === selected;
      input.addEventListener('change', () => onChange(i));
      const span = document.createElement('span');
      span.textContent = opt.label;
      label.append(input, span);
      return label;
    }),
  );
}

function applyLook() {
  renderer.look.material = settings.material;
  renderer.look.scene = settings.scene;
  renderer.look.influence = settings.influence;
  renderer.look.ripples = settings.ripples;
  els.influenceOut.textContent = `${Math.round(settings.influence * 100)}%`;
}

function bindStudio() {
  buildChoices(els.materials, 'material', MATERIALS, settings.material, (i) => {
    settings.material = i;
    applyLook();
    writeSettings();
  });
  buildChoices(els.scenes, 'scene', SCENES, settings.scene, (i) => {
    settings.scene = i;
    applyLook();
    writeSettings();
  });
  els.influence.value = String(Math.round(settings.influence * 100));
  els.influence.addEventListener('input', () => {
    settings.influence = Number(els.influence.value) / 100;
    applyLook();
    writeSettings();
  });
  els.ripplesToggle.checked = settings.ripples;
  els.ripplesToggle.addEventListener('change', () => {
    settings.ripples = els.ripplesToggle.checked;
    if (!settings.ripples) ripples.length = 0;
    applyLook();
    writeSettings();
  });
  els.turnToggle.checked = settings.turn;
  els.turnToggle.addEventListener('change', () => {
    settings.turn = els.turnToggle.checked;
    writeSettings();
  });
}

function bindPointer() {
  const pointers = new Map();
  let pinch = 0;
  const stage = els.stage;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      view.yaw -= (e.clientX - p.x) * 0.008;
      view.pitch = Math.min(0.55, Math.max(-0.1, view.pitch + (e.clientY - p.y) * 0.005));
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) view.zoom = Math.min(2, Math.max(0.55, view.zoom * (d / pinch)));
      pinch = d;
    }
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      view.zoom = Math.min(2, Math.max(0.55, view.zoom * Math.exp(-e.deltaY * 0.0012)));
    },
    { passive: false },
  );
  stage.addEventListener('dblclick', () => {
    view.yaw = 0;
    view.pitch = 0;
    view.zoom = 1;
  });
}

function bindDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    depth++;
    els.drop.hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) els.drop.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    els.drop.hidden = true;
    openFile(e.dataTransfer?.files?.[0]);
  });
}

function bindUi() {
  els.play.addEventListener('click', () => {
    engine.unlock();
    if (track?.pending) track.wantsPlay = true;
    else engine.toggle();
  });
  els.seek.addEventListener('input', () => engine.seek((Number(els.seek.value) / 1000) * engine.duration));
  els.open.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => {
    openFile(els.file.files[0]);
    els.file.value = '';
  });
  els.keep.addEventListener('click', toggleKeep);
  els.saveCard.addEventListener('click', saveNoteCard);
  els.record.addEventListener('click', recordNoteClip);
  els.capture.addEventListener('click', captureFromMic);
  els.listen.addEventListener('click', toggleListening);
  // The artifact viewer refuses microphone access, so Listen only appears where it can work.
  els.listen.hidden = inArtifactViewer || !navigator.mediaDevices?.getUserMedia;

  els.demos.replaceChildren(
    ...DEMOS.map((demo) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'demo';
      b.dataset.demo = demo.id;
      b.title = demo.mood;
      const dot = document.createElement('i');
      dot.style.setProperty('--h', String(Math.round(makeDNA(DEMO_FEATURES[demo.id]).hue * 360)));
      b.append(dot, document.createTextNode(demo.title));
      b.addEventListener('click', () => playDemo(demo));
      return b;
    }),
  );

  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => setPanel(currentPanel() === tab.dataset.panel ? null : tab.dataset.panel)),
  );
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => setPanel(null)));

  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && !e.target.closest('button')) {
      e.preventDefault();
      if (engine.buffer) {
        engine.unlock();
        engine.toggle();
      }
    } else if (e.key === 'Escape' && currentPanel()) {
      setPanel(null);
    }
  });

  engine.onChange = syncTransport;
  engine.onNote = ({ pitchClass, strength }) => spawnRipple(pitchClass, strength, performance.now() / 1000);

  new ResizeObserver(layoutView).observe(els.dock);
  window.addEventListener('resize', () => {
    layoutView();
    if (track && currentPanel() === 'note') drawEnvelopeChart();
  });
  bindStudio();
  bindPointer();
  bindDrop();
}

function boot() {
  try {
    renderer = new NoteRenderer(els.stage);
  } catch (err) {
    console.error(err);
    els.fallback.hidden = false;
    els.stage.hidden = true;
  }
  bindUi();
  if (renderer) applyLook();
  setTrack(demoTrack(DEMOS[0]));
  renderCollection();
  if (window.innerWidth >= 1100) setPanel('note');
  layoutView();
  if (renderer) {
    view.shift = [...view.targetShift];
    view.fit = view.targetFit;
    requestAnimationFrame(frame);
  }
}

boot();
