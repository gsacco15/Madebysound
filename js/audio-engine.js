// Playback, microphone input and live listening: band energy, beats, and the pitch of every new note.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.loop = false;
    this.source = null;
    this.startedAt = 0;
    this.offset = 0;
    this.playing = false;
    this.micStream = null;
    this.micNode = null;
    this.onChange = () => {};
    this.onNote = () => {};
    this.onBeat = () => {};
    this.live = { bass: 0, mid: 0, high: 0, beat: 0, level: 0, active: false };
    this.peaks = { bass: 1e-3, mid: 1e-3, high: 1e-3 };
    this.fluxHistory = [];
    this.lowHistory = [];
    this.lastNote = 0;
    this.lastBeat = 0;
    this.lastSample = 0;
  }

  // Must run inside a user gesture the first time (iOS will not start audio otherwise).
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.input = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      this.output = this.ctx.createGain();
      this.input.connect(this.analyser);
      this.input.connect(this.output);
      this.output.connect(this.ctx.destination);
      const bins = this.analyser.frequencyBinCount;
      this.freq = new Float32Array(bins);
      this.wave = new Float32Array(this.analyser.fftSize);
      this.prevSpectrum = new Float32Array(bins);
      const binHz = this.ctx.sampleRate / this.analyser.fftSize;
      this.binPitch = new Int8Array(bins).fill(-1);
      for (let k = 1; k < bins; k++) {
        const f = k * binHz;
        if (f >= 80 && f <= 2000) this.binPitch[k] = (((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12);
      }
    }
    // On iPhone, Web Audio is silenced by the ring/silent switch unless the session is marked as playback.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  async decode(arrayBuffer) {
    if (this.ctx) return this.ctx.decodeAudioData(arrayBuffer);
    const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
    return offline.decodeAudioData(arrayBuffer);
  }

  load(buffer, { loop = false } = {}) {
    this.stopSource();
    this.stopMic();
    this.buffer = buffer;
    this.loop = loop;
    this.offset = 0;
    this.playing = false;
    this.onChange();
  }

  play() {
    if (!this.buffer) return;
    const ctx = this.unlock();
    this.stopMic();
    this.stopSource();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.loop;
    src.connect(this.input);
    const offset = this.offset >= this.buffer.duration ? 0 : this.offset;
    src.start(0, offset);
    this.startedAt = ctx.currentTime - offset;
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.playing = false;
      this.offset = 0;
      this.onChange('ended');
    };
    this.source = src;
    this.playing = true;
    this.onChange();
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.stopSource();
    this.playing = false;
    this.onChange();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(seconds) {
    if (!this.buffer) return;
    const wasPlaying = this.playing;
    this.stopSource();
    this.playing = false;
    this.offset = Math.min(Math.max(0, seconds), this.buffer.duration);
    if (wasPlaying) this.play();
    else this.onChange();
  }

  stopSource() {
    if (!this.source) return;
    const src = this.source;
    this.source = null;
    src.onended = null;
    try {
      src.stop();
    } catch {
      // Already stopped.
    }
  }

  get currentTime() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    let t = this.ctx.currentTime - this.startedAt;
    if (this.loop) t %= this.buffer.duration;
    return Math.min(t, this.buffer.duration);
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  get listening() {
    return !!this.micStream;
  }

  async startMic() {
    const ctx = this.unlock();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the microphone.');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.pause();
    this.stopMic();
    this.micStream = stream;
    this.micNode = ctx.createMediaStreamSource(stream);
    this.micNode.connect(this.analyser);
    this.onChange();
  }

  stopMic() {
    if (!this.micStream) return;
    this.micStream.getTracks().forEach((t) => t.stop());
    this.micNode?.disconnect();
    this.micStream = null;
    this.micNode = null;
    this.onChange();
  }

  // Records what the microphone hears, for turning into a note.
  async recordMic(seconds, onTick) {
    if (!this.micStream) throw new Error('Start listening first.');
    if (typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record audio.');
    const recorder = new MediaRecorder(this.micStream);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    const started = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const elapsed = (performance.now() - started) / 1000;
        onTick?.(Math.min(1, elapsed / seconds));
        if (elapsed >= seconds || !this.micStream) resolve();
        else setTimeout(tick, 100);
      };
      tick();
    });
    if (recorder.state !== 'inactive') recorder.stop();
    await done;
    const blob = new Blob(chunks, { type: recorder.mimeType });
    return this.decode(await blob.arrayBuffer());
  }

  // A soft glass arpeggio on the song's tonic chord, played when a new note is revealed.
  chime(tonic, mode) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.05;
    out.connect(ctx.destination);
    const start = ctx.currentTime + 0.03;
    [0, mode === 'minor' ? 3 : 4, 7, 12].forEach((step, i) => {
      const t = start + i * 0.085;
      const f = 440 * 2 ** ((72 + tonic + step - 69) / 12);
      for (const [ratio, level, decay] of [[1, 1, 2.4], [2.76, 0.25, 0.6], [5.4, 0.08, 0.25]]) {
        const o = ctx.createOscillator();
        o.frequency.value = f * ratio;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(level, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + decay + 0.05);
      }
    });
  }

  // A stream of what is playing, for recording video clips.
  audioStream() {
    const ctx = this.unlock();
    if (!this.streamDestination) {
      this.streamDestination = ctx.createMediaStreamDestination();
      this.output.connect(this.streamDestination);
    }
    return this.streamDestination.stream;
  }

  // Called once per animation frame. Returns smoothed, self-normalising levels in 0..1.
  sample(now) {
    const dt = Math.min(0.1, Math.max(0.001, now - (this.lastSample || now - 0.016)));
    this.lastSample = now;
    const live = this.live;
    live.active = !!this.ctx && (this.playing || this.listening);
    if (!live.active) {
      const fade = Math.exp(-dt * 3);
      live.bass *= fade;
      live.mid *= fade;
      live.high *= fade;
      live.level *= fade;
      live.beat *= Math.exp(-dt * 6);
      return live;
    }

    this.analyser.getFloatFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.wave);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    let bass = 0;
    let mid = 0;
    let high = 0;
    let flux = 0;
    let lowFlux = 0;
    const chroma = new Float32Array(12);
    for (let k = 1; k < this.freq.length; k++) {
      const db = this.freq[k];
      const m = db > -160 ? 10 ** (db / 20) : 0;
      const f = k * binHz;
      if (f < 250) bass += m;
      else if (f < 2000) mid += m;
      else if (f < 12000) high += m;
      const lg = Math.log1p(m * 400);
      const d = lg - this.prevSpectrum[k];
      this.prevSpectrum[k] = lg;
      if (d > 0 && f < 6000) {
        flux += d;
        if (f < 180) lowFlux += d;
      }
      const pc = this.binPitch[k];
      if (pc >= 0) chroma[pc] += m * m;
    }

    let sq = 0;
    for (let i = 0; i < this.wave.length; i++) sq += this.wave[i] * this.wave[i];
    const rmsDb = 20 * Math.log10(Math.sqrt(sq / this.wave.length) + 1e-9);
    const gate = clamp01((rmsDb + 62) / 20);

    const attack = 1 - Math.exp(-dt / 0.03);
    const release = 1 - Math.exp(-dt / 0.22);
    const decay = Math.exp(-dt / 8);
    for (const [name, value] of [['bass', bass], ['mid', mid], ['high', high]]) {
      this.peaks[name] = Math.max(value, this.peaks[name] * decay, 1e-4);
      const target = (value / this.peaks[name]) ** 1.5 * gate;
      live[name] += (target - live[name]) * (target > live[name] ? attack : release);
    }
    const levelTarget = clamp01((rmsDb + 50) / 40);
    live.level += (levelTarget - live.level) * (levelTarget > live.level ? attack : release);

    live.beat *= Math.exp(-dt * 7);
    const lowMean = mean(this.lowHistory);
    if (gate > 0.2 && lowFlux > lowMean * 1.7 + 0.4 && now - this.lastBeat > 0.25) {
      live.beat = 1;
      this.lastBeat = now;
      this.onBeat();
    }
    pushLimited(this.lowHistory, lowFlux, 45);

    const fluxMean = mean(this.fluxHistory);
    if (gate > 0.2 && flux > fluxMean * 1.5 + 1.5 && now - this.lastNote > 0.12) {
      this.lastNote = now;
      let pc = 0;
      let total = 0;
      for (let i = 0; i < 12; i++) {
        total += chroma[i];
        if (chroma[i] > chroma[pc]) pc = i;
      }
      if (total > 0) this.onNote({ pitchClass: pc, strength: clamp01(0.45 + (flux / (fluxMean * 3 + 1e-3)) * 0.4) });
    }
    pushLimited(this.fluxHistory, flux, 45);
    return live;
  }
}

function mean(list) {
  if (!list.length) return 0;
  let s = 0;
  for (const v of list) s += v;
  return s / list.length;
}

function pushLimited(list, value, max) {
  list.push(value);
  if (list.length > max) list.shift();
}
