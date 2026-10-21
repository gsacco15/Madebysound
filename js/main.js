import { NoteRenderer, VIEWS, MATERIALS, SCENES } from './renderer.js';
import { AudioEngine } from './audio-engine.js';
import { analyzeAudioBuffer } from './analysis.js';
import { makeDNA, describe, pitchHue, fifthsPosition, PITCH_NAMES } from './dna.js';
import { DEMOS, renderDemo } from './demos.js';
import { DEMO_FEATURES } from './demo-features.js';
import { loadCollection, keepNote, removeNote, isKept, setFavorite } from './collection.js';
import { saveFile, canvasToBlob, makeCard, recordClip, clipSupported, inArtifactViewer, slug } from './exporter.js';
import { readTags } from './tags.js';
import { paletteFromImage } from './palette.js';
import { encodeShare, decodeShare, SHARE_PREFIX } from './share.js';
import { buildNoteMesh, materialFor, writeGLB, writeUSDZ, writeZip } from './export3d.js';
import * as spotify from './spotify.js';

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(
  [
    'stage', 'fallback', 'play', 'art', 'note-id', 'song-title', 'song-meta', 'keep', 'export', 'export-label', 'export-menu',
    'ar-view', 'save-card', 'save-wallpaper', 'wallpaper-size', 'record', 'record-label', 'save-glb', 'glb-hint', 'save-usdz',
    'copy-link', 'capture', 'capture-label', 'seek', 'track-wave', 'time-now', 'time-total', 'open', 'file', 'demos',
    'spotify', 'spotify-label', 'listen', 'listen-label', 'busy', 'busy-title', 'busy-step', 'busy-fill', 'drop', 'toast',
    'readout', 'env-chart', 'env-hint', 'wheel-hint', 'bands', 'wheel', 'views', 'view-hint', 'materials', 'scenes', 'color-modes', 'custom-hue', 'color-hint', 'influence',
    'influence-out', 'ripples-toggle', 'turn-toggle', 'haptics-row', 'haptics-toggle', 'ambient', 'ambient-hint',
    'collection-grid', 'collection-empty', 'collection-count', 'collection-tools', 'collection-filters', 'collection-sort',
    'collection-none', 'dock', 'linkbox', 'link-input', 'link-close',
  ].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(id)]),
);

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const arSupported = !inArtifactViewer && !!document.createElement('a').relList?.supports?.('ar');
const SETTINGS_KEY = 'madebysound.settings.v1';
const settings = {
  view: 'tile',
  material: 0,
  scene: 0,
  influence: 0.7,
  ripples: true,
  turn: !reducedMotion,
  colorMode: 'key',
  customHue: 0.55,
  haptics: false,
  filter: 'all',
  sort: 'newest',
  ...readSettings(),
};

const COLOR_MODES = [
  { id: 'key', label: 'From the key' },
  { id: 'art', label: 'Album art' },
  { id: 'custom', label: 'Custom' },
];
const BAND_LABELS = { sub: 'Sub', bass: 'Bass', lowMid: 'Low-mid', mid: 'Mid', highMid: 'High-mid', air: 'Air' };

const engine = new AudioEngine();
let renderer = null;
let track = null;
let listeningFrom = null;
let busyToken = 0;
let toastTimer = 0;
let wakeLock = null;
const ripples = [];
const view = { yaw: 0, pitch: 0, zoom: 1, autoAmp: settings.turn ? 1 : 0, shift: [0, 0], fit: 1, targetShift: [0, 0], targetFit: 1 };
const ambientState = { lastBeat: -1, mix: 1 };
const springs = { bass: { k: 70 }, mid: { k: 120 }, high: { k: 220 }, level: { k: 90 } };
for (const s of Object.values(springs)) Object.assign(s, { x: 0, v: 0 });
const spotifyState = { following: false, timer: 0, track: null };

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

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

const formatTime = (s) => {
  const t = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const metaLine = (features, dna, source, artist) =>
  [artist, dna.keyName, features.tempo > 0 ? `${Math.round(features.tempo)} BPM` : null, source].filter(Boolean).join(' · ');

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

// ---------- Look: the DNA's shape with the chosen glass colour ----------

function activePalette() {
  if (spotifyState.following && spotifyState.track?.palette) return spotifyState.track.palette;
  return track?.palette || null;
}

function lookDNA() {
  const dna = track.dna;
  const palette = activePalette();
  const useArt = settings.colorMode === 'art' || (spotifyState.following && settings.colorMode !== 'custom');
  if (useArt && palette) return { ...dna, hue: palette.hue, hue2: palette.hue2, saturation: palette.saturation };
  if (settings.colorMode === 'custom') return { ...dna, hue: settings.customHue, hue2: (settings.customHue + 0.12) % 1 };
  return dna;
}

function applyLook({ quiet = false } = {}) {
  if (!track) return;
  const look = lookDNA();
  renderer?.setDNA(look, { quiet });
  document.documentElement.style.setProperty('--song-h', Math.round(look.hue * 360));
  updateColorChips();
  if (currentPanel() === 'note') renderReadout();
  updateTime();
}

const songColor = (alpha = 1, light = 70) => `hsl(${Math.round((track ? lookDNA().hue : 0.5) * 360)} 72% ${light}% / ${alpha})`;

// ---------- Track ----------

function setTrack(next, { autoplay = false, reveal = false } = {}) {
  track = next;
  engine.load(next.buffer || null, { loop: !!next.loop });
  applyLook();
  showLabels();
  renderReadout();
  updateKeep();
  updateDemoButtons();
  syncTransport();
  if (reveal) engine.chime(next.dna.tonic, next.features.key.mode);
  const start = () => {
    if (track === next && (autoplay || next.wantsPlay)) engine.play();
  };
  if (next.pending) {
    next.pending
      .then((buffer) => {
        if (track !== next) return;
        next.buffer = buffer;
        next.pending = null;
        engine.load(buffer, { loop: !!next.loop });
        start();
        syncTransport();
      })
      .catch(() => toast("This browser couldn't compose the demo song."));
  } else if (next.buffer && autoplay) {
    if (reveal) setTimeout(start, 450);
    else start();
  }
}

function showLabels() {
  if (!track) return;
  const sp = spotifyState.following ? spotifyState.track : null;
  let art = track.artUrl;
  if (sp) {
    els.noteId.textContent = 'Playing on Spotify';
    els.songTitle.textContent = sp.title;
    els.songMeta.textContent = engine.listening
      ? `${sp.artist} · the glass moves with your microphone`
      : `${sp.artist} · allow the microphone so the glass can move with it`;
    art = sp.artUrl;
  } else if (engine.listening) {
    els.noteId.textContent = 'Listening';
    els.songTitle.textContent = 'Listening';
    els.songMeta.textContent = `Live from your microphone · ${track.dna.keyName} glass`;
  } else {
    els.noteId.textContent = track.dna.label;
    els.songTitle.textContent = track.title;
    els.songMeta.textContent = track.meta;
  }
  els.songTitle.title = els.songTitle.textContent;
  els.art.hidden = !art;
  if (art) els.art.src = art;
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
  engine.unlock();
  if (track?.kind === 'demo' && track.demoId === demo.id) {
    if (track.pending) track.wantsPlay = true;
    else engine.toggle();
    return;
  }
  stopListening();
  setTrack(demoTrack(demo), { autoplay: true });
}

function melt(on) {
  if (renderer) renderer.moltenTarget = on ? 1 : 0;
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
  melt(true);
  try {
    const data = await file.arrayBuffer();
    if (token !== busyToken) return;
    // Tags first: decoding detaches the buffer.
    const tags = readTags(data);
    let artUrl;
    let palette = null;
    if (tags.picture) {
      const art = new Blob([tags.picture.data], { type: tags.picture.mime });
      artUrl = URL.createObjectURL(art);
      palette = await paletteFromImage(art).catch(() => null);
    }
    setBusy('Decoding the audio', 0.06);
    const buffer = await engine.decode(data);
    if (token !== busyToken) return;
    let lastRipple = 0;
    const features = await analyzeAudioBuffer(buffer, {
      onProgress: (p) => {
        if (token !== busyToken) return;
        setBusy('Listening for key, tempo and energy', 0.1 + p * 0.86);
        if (p - lastRipple > 0.1) {
          lastRipple = p;
          spawnRipple(Math.floor(Math.random() * 12), 0.75, performance.now() / 1000);
        }
      },
    });
    if (token !== busyToken) return;
    const dna = makeDNA(features);
    setTrack(
      {
        kind: 'file',
        title: tags.title || cleanTitle(file.name),
        artist: tags.artist,
        genre: tags.genre,
        artUrl,
        palette,
        meta: metaLine(features, dna, 'Your file', tags.artist),
        features,
        dna,
        buffer,
      },
      { autoplay: true, reveal: true },
    );
  } catch (err) {
    console.error(err);
    if (token === busyToken) {
      toast("Couldn't read that song. Files from streaming apps are usually copy-protected. Try an MP3, M4A or WAV you own.");
    }
  } finally {
    if (token === busyToken) {
      hideBusy();
      melt(false);
    }
  }
}

function openSaved(entry) {
  stopListening();
  const dna = makeDNA(entry.features);
  const demo = DEMOS.find((d) => d.id === entry.demoId);
  if (demo) {
    setTrack({ ...demoTrack(demo), title: entry.title });
    return;
  }
  const saved = new Date(entry.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  setTrack({
    kind: 'saved',
    title: entry.title,
    artist: entry.artist,
    genre: entry.genre,
    palette: entry.palette || null,
    meta: metaLine(entry.features, dna, `Kept ${saved}`, entry.artist),
    features: entry.features,
    dna,
    buffer: null,
  });
}

function openShared(token) {
  const shared = decodeShare(token);
  if (!shared) return false;
  stopListening();
  const dna = makeDNA(shared.features);
  setTrack({ kind: 'shared', title: shared.title || 'A shared note', meta: metaLine(shared.features, dna, 'Shared note'), features: shared.features, dna, buffer: null });
  return true;
}

// ---------- Listening and Spotify ----------

async function startListening() {
  engine.unlock();
  try {
    await engine.startMic();
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your browser settings to use Listen.' : "Couldn't start the microphone.");
    return false;
  }
  listeningFrom = track;
  els.listen.setAttribute('aria-pressed', 'true');
  els.listenLabel.textContent = 'Stop';
  els.capture.hidden = false;
  showLabels();
  syncTransport();
  return true;
}

function stopListening() {
  const wasActive = engine.listening || listeningFrom || spotifyState.following;
  engine.stopMic();
  clearInterval(spotifyState.timer);
  spotifyState.following = false;
  spotifyState.track = null;
  if (!wasActive) return;
  listeningFrom = null;
  els.listen.setAttribute('aria-pressed', 'false');
  els.listenLabel.textContent = 'Listen';
  els.capture.hidden = true;
  updateSpotifyButton();
  showLabels();
  applyLook({ quiet: true });
  syncTransport();
}

async function captureFromMic() {
  const seconds = 12;
  els.capture.disabled = true;
  const sp = spotifyState.following ? spotifyState.track : null;
  try {
    const buffer = await engine.recordMic(seconds, (p) => {
      els.captureLabel.textContent = `Recording ${Math.ceil(seconds * (1 - p))} s`;
    });
    const token = ++busyToken;
    showBusy('Listening to what you played', 'Analysing', 0.1);
    melt(true);
    const features = await analyzeAudioBuffer(buffer, { onProgress: (p) => setBusy('Analysing', 0.1 + p * 0.9) });
    if (token !== busyToken) return;
    stopListening();
    const dna = makeDNA(features);
    const when = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    setTrack(
      {
        kind: 'capture',
        title: sp ? sp.title : `Heard at ${when}`,
        artist: sp?.artist,
        artUrl: sp?.artUrl,
        palette: sp?.palette || null,
        meta: metaLine(features, dna, sp ? 'Heard from Spotify' : 'Microphone', sp?.artist),
        features,
        dna,
        buffer,
      },
      { reveal: true },
    );
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't record from the microphone.");
  } finally {
    hideBusy();
    melt(false);
    els.capture.disabled = false;
    els.captureLabel.textContent = 'Make a note';
  }
}

async function initSpotify() {
  const usable = !inArtifactViewer && spotify.spotifyAvailable();
  els.spotify.hidden = !usable;
  if (!usable) return;
  try {
    if (await spotify.completeLogin()) toast('Spotify is connected. Press Spotify to follow what you play.');
  } catch (err) {
    toast(err.message);
  }
  updateSpotifyButton();
}

function updateSpotifyButton() {
  els.spotifyLabel.textContent = !spotify.isConnected() ? 'Connect Spotify' : spotifyState.following ? 'Stop Spotify' : 'Spotify';
  els.spotify.setAttribute('aria-pressed', String(spotifyState.following));
}

async function toggleSpotify() {
  engine.unlock();
  if (!spotify.isConnected()) {
    spotify.connect();
    return;
  }
  if (spotifyState.following) {
    stopListening();
    return;
  }
  spotifyState.following = true;
  updateSpotifyButton();
  await pollSpotify();
  if (!spotifyState.following) return;
  if (!engine.listening) await startListening();
  showLabels();
  spotifyState.timer = setInterval(pollSpotify, 5000);
}

async function pollSpotify() {
  try {
    const now = await spotify.nowPlaying();
    if (!spotifyState.following) return;
    if (!now) {
      if (!spotifyState.track) toast('Nothing is playing on Spotify right now. Start a song and it will show up here.');
      return;
    }
    if (now.id === spotifyState.track?.id) return;
    spotifyState.track = { ...now, palette: null };
    if (now.artUrl) {
      try {
        const art = await (await fetch(now.artUrl)).blob();
        if (spotifyState.track?.id === now.id) spotifyState.track.palette = await paletteFromImage(art);
      } catch {
        // Cover art without CORS access still shows; it just can't colour the glass.
      }
    }
    showLabels();
    applyLook({ quiet: true });
  } catch (err) {
    toast(err.message);
    stopListening();
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
  // Springs give the glass a little weight: it swells, overshoots slightly and settles like a liquid.
  const steps = Math.max(1, Math.ceil(dt / 0.008));
  for (const [key, s] of Object.entries(springs)) {
    const target = live[key] * (1 - m) + amb[key] * m;
    const damping = 1.5 * Math.sqrt(s.k);
    for (let i = 0; i < steps; i++) {
      s.v += ((target - s.x) * s.k - damping * s.v) * (dt / steps);
      s.x += s.v * (dt / steps);
    }
    renderer.live[key] = Math.min(1.2, Math.max(0, s.x));
  }
  renderer.live.beat = live.beat * (1 - m) + amb.beat * m;

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
  if (document.body.classList.contains('ambient')) {
    view.targetShift = [0, 0];
    view.targetFit = 1;
    return;
  }
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
  els.play.title = !engine.buffer && !pending && (track?.kind === 'saved' || track?.kind === 'shared') ? 'Open the song again to hear it' : '';
  els.seek.disabled = !engine.buffer || listening;
  els.record.disabled = !engine.buffer || !clipSupported() || listening;
  els.keep.disabled = !track || listening;
  els.export.disabled = !track;
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

// The scrubber shows the same loudness signature that is engraved along the stems.
function drawTrackWave(progress) {
  if (!track) return;
  const { w, h } = sizeCanvas(els.trackWave);
  const g = els.trackWave.getContext('2d');
  g.clearRect(0, 0, w, h);
  const env = track.dna.envelope;
  const step = w / env.length;
  const playedX = progress * w;
  const played = songColor(0.95);
  env.forEach((v, i) => {
    const bh = Math.max(h * 0.12, v * h * 0.9);
    const x = i * step + step * 0.22;
    const bw = step * 0.56;
    g.fillStyle = x + bw / 2 <= playedX ? played : 'rgba(238, 241, 247, 0.2)';
    g.beginPath();
    if (g.roundRect) g.roundRect(x, (h - bh) / 2, bw, bh, Math.min(bw / 2, 3));
    else g.rect(x, (h - bh) / 2, bw, bh);
    g.fill();
  });
  if (engine.buffer) {
    g.fillStyle = 'rgba(238, 241, 247, 0.9)';
    g.fillRect(Math.round(playedX) - 1, 0, 2, h);
  }
}

function updateDemoButtons() {
  els.demos.querySelectorAll('.demo').forEach((b) => {
    b.setAttribute('aria-pressed', String(track?.kind === 'demo' && track.demoId === b.dataset.demo));
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
  if (!track || $('panel-note').hidden) return;
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
      span.textContent = row.label === 'Key' && lookDNA() !== dna ? `${row.effect}. The Studio is overriding the color.` : row.effect;
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
  const tile = settings.view === 'tile';
  els.envHint.textContent = tile
    ? "Shapes the note's stems. A song with more dynamic range lies deeper in the bath, so its waves bend the note further. In the sculpture this curve is engraved along the stems."
    : 'Engraved along the stems: the first half of the song runs up the left stem, the second half up the right.';
  els.wheelHint.textContent = tile
    ? "The song's two strongest pitches sound from their places on this wheel around the rim, and their waves cross over the note. Bass pumps rings from the middle, and each note you hear sends a ring from its own place."
    : "While a song plays, each note you hear drops a ripple in its pitch's color, from that pitch's place around the bath. Pitches a fifth apart sit side by side.";
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
    const strength = track.dna.chroma[pc];
    g.fillStyle = `hsl(${Math.round(pitchHue(pc) * 360)} 75% 66%)`;
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

// ---------- Collection ----------

const energyOf = (f) => 0.6 * clamp01(f.onsetRate / 5) + 0.4 * clamp01((f.tempo - 70) / 90);

function collectionFilters(list) {
  const genres = [...new Set(list.map((e) => e.genre).filter(Boolean))].slice(0, 4);
  return [
    { id: 'all', label: 'All', test: () => true },
    { id: 'favorites', label: 'Favorites', test: (e) => e.favorite },
    { id: 'energetic', label: 'Energetic', test: (e) => energyOf(e.features) >= 0.5 },
    { id: 'calm', label: 'Calm', test: (e) => energyOf(e.features) < 0.5 },
    ...genres.map((g) => ({ id: `genre:${g}`, label: g, test: (e) => e.genre === g })),
  ];
}

const SORTS = {
  newest: (a, b) => b.savedAt - a.savedAt,
  energy: (a, b) => energyOf(b.features) - energyOf(a.features),
  tempo: (a, b) => b.features.tempo - a.features.tempo,
  color: (a, b) => makeDNA(a.features).hue - makeDNA(b.features).hue,
};

function renderCollection() {
  const list = loadCollection();
  els.collectionCount.textContent = String(list.length);
  els.collectionCount.toggleAttribute('data-zero', list.length === 0);
  els.collectionEmpty.hidden = list.length > 0;
  els.collectionTools.hidden = list.length === 0;
  const filters = collectionFilters(list);
  if (!filters.some((f) => f.id === settings.filter)) settings.filter = 'all';
  buildChoices(els.collectionFilters, 'collection-filter', filters, filters.findIndex((f) => f.id === settings.filter), (i) => {
    settings.filter = filters[i].id;
    writeSettings();
    renderCollection();
  });
  els.collectionSort.value = SORTS[settings.sort] ? settings.sort : 'newest';
  const active = filters.find((f) => f.id === settings.filter);
  const shown = list.filter(active.test).sort(SORTS[els.collectionSort.value]);
  els.collectionNone.hidden = list.length === 0 || shown.length > 0;
  els.collectionGrid.replaceChildren(...shown.map(collectionItem));
}

function collectionItem(entry) {
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
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'star';
  star.setAttribute('aria-pressed', String(!!entry.favorite));
  star.setAttribute('aria-label', `Favorite ${entry.title}`);
  star.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/></svg>';
  star.addEventListener('click', () => {
    setFavorite(entry.id, !entry.favorite);
    renderCollection();
  });
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
  li.append(open, star, title, meta);
  return li;
}

// ---------- Exports ----------

// Stills are framed for their own shape, ignoring the on-screen fit around panels.
function still(width, height = width, shift = [0, 0], zoom = view.zoom) {
  const saved = renderer.camera.zoom;
  renderer.camera.zoom = zoom;
  const canvas = renderer.snapshot(performance.now() / 1000, width, height, shift);
  renderer.camera.zoom = saved;
  return canvas;
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
      artist: track.artist,
      genre: track.genre,
      demoId: track.demoId,
      palette: track.palette || null,
      features: track.features,
      thumb: still(240).toDataURL('image/jpeg', 0.82),
      savedAt: Date.now(),
    });
    toast(list ? 'Kept in your collection' : "Couldn't keep it. This browser is blocking storage.");
  }
  renderCollection();
  updateKeep();
}

async function guardedSave(fn) {
  try {
    await fn();
  } catch (err) {
    if (err?.code !== 'declined') {
      console.error(err);
      toast(err?.message || "Couldn't save that.");
    }
  } finally {
    hideBusy();
  }
}

function saveNoteCard() {
  return guardedSave(async () => {
    const card = await makeCard({ still: still(1080), title: track.title, meta: track.meta, dna: lookDNA() });
    await saveFile(`madebysound-${slug(track.title)}.png`, await canvasToBlob(card));
  });
}

function wallpaperSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let w = Math.round(screen.width * dpr);
  let h = Math.round(screen.height * dpr);
  const long = Math.max(w, h);
  const k = long > 3200 ? 3200 / long : long < 1600 ? 1600 / long : 1;
  w = Math.round(w * k);
  h = Math.round(h * k);
  return { w, h };
}

function saveWallpaper() {
  return guardedSave(async () => {
    const { w, h } = wallpaperSize();
    showBusy('Rendering your wallpaper', `${w} × ${h}`, 0.5);
    await nextFrame();
    await nextFrame();
    // Portrait wallpapers sit the note a little low, clear of the lock-screen clock.
    const canvas = still(w, h, [0, h > w ? -0.05 : 0], view.zoom * (h > w ? 1 : 0.9));
    const blob = await canvasToBlob(canvas);
    hideBusy();
    await saveFile(`madebysound-${slug(track.title)}-wallpaper.png`, blob);
  });
}

async function recordNoteClip() {
  if (!engine.buffer) return;
  if (!engine.playing) engine.play();
  els.export.classList.add('is-live');
  els.export.disabled = true;
  try {
    const seconds = 8;
    const { blob, ext } = await recordClip(els.stage, engine.audioStream(), seconds, (t) => {
      els.exportLabel.textContent = `0:0${Math.max(0, Math.ceil(seconds - t))}`;
    });
    await saveFile(`madebysound-${slug(track.title)}.${ext}`, blob);
  } catch (err) {
    if (err?.code !== 'declined') toast(err?.message || "Couldn't record a clip.");
  } finally {
    els.export.classList.remove('is-live');
    els.exportLabel.textContent = 'Share';
    syncTransport();
  }
}

let modelWorker;
let modelJob = null;

function modelKey(dna) {
  return `${dna.id}:${settings.material}:${dna.hue.toFixed(3)}:${dna.saturation.toFixed(3)}:${track.title}`;
}

// Meshes the note in a worker (inline if workers are unavailable) and caches the files per look.
function requestModel() {
  const dna = lookDNA();
  const key = modelKey(dna);
  if (modelJob?.key === key) return modelJob.promise;
  const name = track.title;
  const material = settings.material;
  const inline = () => {
    const mesh = buildNoteMesh(dna);
    const mat = materialFor(dna, material);
    return { glb: writeGLB(mesh, mat, name), usdz: writeUSDZ(mesh, mat, name) };
  };
  const job = { key, usdzUrl: null };
  job.promise = new Promise((resolve, reject) => {
    if (modelWorker === undefined) {
      try {
        modelWorker = new Worker(new URL('./model-worker.js', import.meta.url), { type: 'module' });
      } catch {
        modelWorker = null;
      }
    }
    const fallback = () => setTimeout(() => {
      try {
        resolve(inline());
      } catch (err) {
        reject(err);
      }
    }, 30);
    if (!modelWorker) return fallback();
    const id = Math.random();
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    const onError = (e) => {
      e.preventDefault?.();
      cleanup();
      modelWorker = null;
      fallback();
    };
    const cleanup = () => {
      modelWorker?.removeEventListener('message', onMessage);
      modelWorker?.removeEventListener('error', onError);
    };
    modelWorker.addEventListener('message', onMessage);
    modelWorker.addEventListener('error', onError);
    modelWorker.postMessage({ id, dna, material, name });
  }).then((files) => {
    job.usdzUrl = URL.createObjectURL(new Blob([files.usdz], { type: 'model/vnd.usdz+zip' }));
    return files;
  });
  job.promise.catch(() => {
    if (modelJob === job) modelJob = null;
  });
  modelJob = job;
  return job.promise;
}

function openQuickLook(url) {
  const a = document.createElement('a');
  a.setAttribute('rel', 'ar');
  a.href = url;
  a.append(document.createElement('img'));
  a.click();
}

async function viewInAR() {
  const key = modelKey(lookDNA());
  if (modelJob?.key === key && modelJob.usdzUrl) {
    openQuickLook(modelJob.usdzUrl);
    return;
  }
  await guardedSave(async () => {
    showBusy('Shaping the 3D model', 'Meshing the glass', 0.5);
    await requestModel();
    hideBusy();
    openQuickLook(modelJob.usdzUrl);
  });
}

function saveModel(kind) {
  return guardedSave(async () => {
    showBusy('Shaping the 3D model', 'Meshing the glass', 0.5);
    const files = await requestModel();
    hideBusy();
    const base = `madebysound-${slug(track.title)}`;
    if (inArtifactViewer) {
      const zip = writeZip([
        { name: `${base}.glb`, data: new Uint8Array(files.glb) },
        { name: `${base}.usdz`, data: new Uint8Array(files.usdz) },
      ]);
      await saveFile(`${base}-3d.zip`, new Blob([zip], { type: 'application/zip' }));
    } else if (kind === 'glb') {
      await saveFile(`${base}.glb`, new Blob([files.glb], { type: 'model/gltf-binary' }));
    } else {
      await saveFile(`${base}.usdz`, new Blob([files.usdz], { type: 'model/vnd.usdz+zip' }));
    }
  });
}

function shareBase() {
  return document.querySelector('meta[name="mbs-share-base"]')?.content || `${location.origin}${location.pathname}`;
}

function copyShareLink() {
  const url = `${shareBase()}#${encodeShare(track.features, track.title)}`;
  const showBox = () => {
    els.linkInput.value = url;
    els.linkbox.hidden = false;
    els.linkInput.focus();
    els.linkInput.select();
  };
  if (!navigator.clipboard?.writeText) return showBox();
  navigator.clipboard.writeText(url).then(() => toast('Link copied. It opens this note, without the audio.'), showBox);
}

function toggleMenu(open = els.exportMenu.hidden) {
  els.exportMenu.hidden = !open;
  els.export.setAttribute('aria-expanded', String(open));
  document.querySelector('.dock').classList.toggle('menu-open', open);
  if (!open) return;
  els.wallpaperSize.textContent = `PNG, ${wallpaperSize().w} × ${wallpaperSize().h}`;
  els.record.disabled = !engine.buffer || !clipSupported() || engine.listening;
  // Prepare the AR model now, so tapping View in AR can open it straight away.
  if (arSupported) requestModel().catch(() => {});
  els.exportMenu.querySelector('button:not([hidden]):not(:disabled)')?.focus();
}

function menuAction(fn) {
  return () => {
    toggleMenu(false);
    fn();
  };
}

// ---------- Ambient mode ----------

async function enterAmbient() {
  setPanel(null);
  toggleMenu(false);
  document.body.classList.add('ambient');
  layoutView();
  els.ambientHint.hidden = true;
  void els.ambientHint.offsetWidth;
  els.ambientHint.hidden = false;
  try {
    await document.documentElement.requestFullscreen?.();
  } catch {
    // Full screen is optional; ambient mode works without it.
  }
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}

function exitAmbient() {
  if (!document.body.classList.contains('ambient')) return;
  document.body.classList.remove('ambient');
  els.ambientHint.hidden = true;
  layoutView();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
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
      input.id = `${name}-${opt.id}`.replace(/[^\w-]/g, '-');
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

function updateColorChips() {
  const hasArt = !!activePalette();
  const art = $('color-mode-art');
  if (art) art.disabled = !hasArt && settings.colorMode !== 'art';
  els.customHue.hidden = settings.colorMode !== 'custom';
  els.colorHint.textContent =
    settings.colorMode === 'art' && !hasArt
      ? "This song has no album art with color in it, so the glass uses the key's color."
      : settings.colorMode === 'art'
        ? "From the cover: its strongest color, with a second one for the side light."
        : settings.colorMode === 'custom'
          ? 'Your own color. The shape still comes from the song.'
        : "From the key, the song's own color. Album art takes it from the cover.";
}

function applyRenderSettings() {
  renderer.look.view = settings.view === 'sculpture' ? 1 : 0;
  renderer.look.material = settings.material;
  renderer.look.scene = settings.scene;
  renderer.look.influence = settings.influence;
  renderer.look.ripples = settings.ripples;
  els.influenceOut.textContent = `${Math.round(settings.influence * 100)}%`;
}

function bindStudio() {
  const saveAndApply = () => {
    if (renderer) applyRenderSettings();
    writeSettings();
  };
  buildChoices(els.views, 'view', VIEWS, Math.max(0, VIEWS.findIndex((v) => v.id === settings.view)), (i) => {
    settings.view = VIEWS[i].id;
    saveAndApply();
    renderReadout();
  });
  buildChoices(els.materials, 'material', MATERIALS, settings.material, (i) => {
    settings.material = i;
    saveAndApply();
  });
  buildChoices(els.scenes, 'scene', SCENES, settings.scene, (i) => {
    settings.scene = i;
    saveAndApply();
  });
  buildChoices(els.colorModes, 'color-mode', COLOR_MODES, Math.max(0, COLOR_MODES.findIndex((m) => m.id === settings.colorMode)), (i) => {
    settings.colorMode = COLOR_MODES[i].id;
    writeSettings();
    applyLook({ quiet: true });
  });
  els.customHue.value = String(Math.round(settings.customHue * 360));
  els.customHue.addEventListener('input', () => {
    settings.customHue = Number(els.customHue.value) / 360;
    writeSettings();
    applyLook({ quiet: true });
  });
  els.influence.value = String(Math.round(settings.influence * 100));
  els.influence.addEventListener('input', () => {
    settings.influence = Number(els.influence.value) / 100;
    saveAndApply();
  });
  els.ripplesToggle.checked = settings.ripples;
  els.ripplesToggle.addEventListener('change', () => {
    settings.ripples = els.ripplesToggle.checked;
    if (!settings.ripples) ripples.length = 0;
    saveAndApply();
  });
  els.turnToggle.checked = settings.turn;
  els.turnToggle.addEventListener('change', () => {
    settings.turn = els.turnToggle.checked;
    writeSettings();
  });
  els.hapticsRow.hidden = typeof navigator.vibrate !== 'function';
  els.hapticsToggle.checked = settings.haptics;
  els.hapticsToggle.addEventListener('change', () => {
    settings.haptics = els.hapticsToggle.checked;
    writeSettings();
  });
  els.ambient.addEventListener('click', enterAmbient);
}

function bindPointer() {
  const pointers = new Map();
  let pinch = 0;
  let travel = 0;
  const stage = els.stage;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    travel = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    travel += Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y);
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
    if (e.type === 'pointerup' && travel < 8) exitAmbient();
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
  els.export.addEventListener('click', () => toggleMenu());
  els.arView.hidden = !arSupported;
  els.arView.addEventListener('click', menuAction(viewInAR));
  els.saveCard.addEventListener('click', menuAction(saveNoteCard));
  els.saveWallpaper.addEventListener('click', menuAction(saveWallpaper));
  els.record.addEventListener('click', menuAction(recordNoteClip));
  els.saveGlb.addEventListener('click', menuAction(() => saveModel('glb')));
  els.saveUsdz.addEventListener('click', menuAction(() => saveModel('usdz')));
  els.copyLink.addEventListener('click', menuAction(copyShareLink));
  // The artifact viewer only saves certain file types, so both 3D files travel in one zip there.
  if (inArtifactViewer) {
    els.saveUsdz.hidden = true;
    els.glbHint.textContent = '.zip with .glb and .usdz files';
  }
  document.addEventListener('pointerdown', (e) => {
    if (!els.exportMenu.hidden && !e.target.closest('.menu-wrap')) toggleMenu(false);
  });
  els.linkClose.addEventListener('click', () => (els.linkbox.hidden = true));
  els.capture.addEventListener('click', captureFromMic);
  els.listen.addEventListener('click', () => (engine.listening || spotifyState.following ? stopListening() : startListening()));
  // The artifact viewer refuses microphone access, so Listen only appears where it can work.
  els.listen.hidden = inArtifactViewer || !navigator.mediaDevices?.getUserMedia;
  els.spotify.addEventListener('click', toggleSpotify);
  els.collectionSort.addEventListener('change', () => {
    settings.sort = els.collectionSort.value;
    writeSettings();
    renderCollection();
  });

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
    if (document.body.classList.contains('ambient')) {
      exitAmbient();
      return;
    }
    if (e.key === 'Escape') {
      if (!els.exportMenu.hidden) {
        toggleMenu(false);
        els.export.focus();
      } else if (!els.linkbox.hidden) els.linkbox.hidden = true;
      else if (currentPanel()) setPanel(null);
      return;
    }
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && !e.target.closest('button')) {
      e.preventDefault();
      if (engine.buffer) {
        engine.unlock();
        engine.toggle();
      }
    }
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) exitAmbient();
  });
  window.addEventListener('hashchange', () => openShared(location.hash.slice(1)));

  engine.onChange = syncTransport;
  engine.onNote = ({ pitchClass, strength }) => spawnRipple(pitchClass, strength, performance.now() / 1000);
  engine.onBeat = () => {
    if (settings.haptics) navigator.vibrate?.(12);
  };

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
  if (renderer) applyRenderSettings();
  const hash = location.hash.slice(1);
  if (!(hash.startsWith(SHARE_PREFIX) && openShared(hash))) setTrack(demoTrack(DEMOS[0]));
  renderCollection();
  initSpotify();
  if (window.innerWidth >= 1100) setPanel('note');
  layoutView();
  if (renderer) {
    view.shift = [...view.targetShift];
    view.fit = view.targetFit;
    requestAnimationFrame(frame);
  }
}

boot();
