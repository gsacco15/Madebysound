// WebGL2 host for the glass-note shader: DNA → uniforms, morphing between notes, snapshots.

import { VERT, FRAG } from './shader.js';

export const MATERIALS = [
  { id: 'clear', label: 'Clear glass' },
  { id: 'frosted', label: 'Frosted' },
  { id: 'tinted', label: 'Song tint' },
  { id: 'metal', label: 'Liquid metal' },
  { id: 'neon', label: 'Neon edge' },
];

export const SCENES = [
  { id: 'oil', label: 'Oil bath' },
  { id: 'studio', label: 'Studio' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'void', label: 'Void' },
];

const SHAPE_KEYS = [
  'headSize', 'headTilt', 'stemWidth', 'stemHeight', 'beamSlant', 'beamThickness', 'liquidity', 'rippleFreq',
  'rippleAmp', 'detail', 'twist', 'lean', 'iridescence', 'dispersion', 'envelopeDepth', 'pulse', 'saturation',
];

const UNIFORMS = [
  'uRes', 'uTime', 'uCam', 'uShift', 'uH1', 'uH2', 'uS1', 'uS2', 'uBeam', 'uBeam2', 'uShape', 'uSurf', 'uLook',
  'uLook2', 'uLive', 'uLive2', 'uEnv', 'uRip', 'uRipStr',
];

const MAX_RIPPLES = 12;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function link(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Shader failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
function lerpHue(a, b, t) {
  let d = b - a;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return (a + d * t + 1) % 1;
}

function toParams(dna) {
  const p = { hue: dna.hue, hue2: dna.hue2, beams: dna.beams, envelope: Float32Array.from(dna.envelope) };
  for (const key of SHAPE_KEYS) p[key] = dna[key];
  return p;
}

function cloneParams(p) {
  return { ...p, envelope: Float32Array.from(p.envelope) };
}

// Places heads, stems and beam(s) from the DNA, centred on the origin.
function layout(p) {
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

export class NoteRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('webgl2-unavailable');
    this.current = null;
    this.from = null;
    this.target = null;
    this.morphStart = 0;
    this.morphDuration = 1.6;
    this.live = { bass: 0, mid: 0, high: 0, beat: 0, level: 0 };
    this.look = { material: 0, scene: 0, influence: 0.7, ripples: true };
    this.camera = { yaw: 0, pitch: 0.12, zoom: 1 };
    this.shift = [0, 0];
    this.ripples = new Float32Array(MAX_RIPPLES * 4);
    this.rippleStrength = new Float32Array(MAX_RIPPLES);
    this.scale = 1;
    this.maxDpr = 1.5;
    this.avgFrame = 16;
    this.cooldown = 60;
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => this.init());
    this.init();
  }

  init() {
    const gl = this.gl;
    this.program = link(gl);
    this.loc = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(this.program, name)]));
    this.vao = gl.createVertexArray();
  }

  setDNA(dna, { instant = false } = {}) {
    const target = toParams(dna);
    if (!this.current || instant) {
      this.current = cloneParams(target);
      this.target = target;
      this.from = null;
      return;
    }
    this.from = cloneParams(this.current);
    this.target = target;
    this.morphStart = performance.now() / 1000;
  }

  stepMorph() {
    if (!this.from) return 0;
    const k = Math.min(1, (performance.now() / 1000 - this.morphStart) / this.morphDuration);
    const e = ease(k);
    const { from, target, current } = this;
    for (const key of SHAPE_KEYS) current[key] = lerp(from[key], target[key], e);
    current.hue = lerpHue(from.hue, target.hue, e);
    current.hue2 = lerpHue(from.hue2, target.hue2, e);
    current.beams = e < 0.5 ? from.beams : target.beams;
    for (let i = 0; i < current.envelope.length; i++) current.envelope[i] = lerp(from.envelope[i], target.envelope[i], e);
    if (k >= 1) this.from = null;
    // The glass goes molten mid-morph, then sets into the new form.
    return Math.sin(Math.PI * k) * 0.32;
  }

  setRipples(list, now) {
    this.ripples.fill(0);
    this.rippleStrength.fill(0);
    list.slice(-MAX_RIPPLES).forEach((r, i) => {
      this.ripples.set([r.x, r.z, now - r.born, r.hue], i * 4);
      this.rippleStrength[i] = r.strength;
    });
  }

  adapt(frameMs) {
    this.avgFrame = this.avgFrame * 0.92 + Math.min(frameMs, 100) * 0.08;
    if (--this.cooldown > 0) return;
    if (this.avgFrame > 26 && this.scale > 0.4) {
      this.scale *= 0.85;
      this.cooldown = 45;
    } else if (this.avgFrame < 17.5 && this.scale < 1) {
      this.scale = Math.min(1, this.scale * 1.06);
      this.cooldown = 90;
    }
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr) * this.scale;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(time) {
    if (!this.current || this.gl.isContextLost()) return;
    this.resize();
    this.draw(time, this.canvas.width, this.canvas.height, this.shift);
  }

  draw(time, w, h, shift) {
    const gl = this.gl;
    const u = this.loc;
    const surge = this.stepMorph();
    const p = this.current;
    const geo = layout(p);
    const aspect = w / h;
    const fit = Math.min(1 / 3, aspect / 3);
    const distance = 1.12 / fit / 0.62 / this.camera.zoom;

    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uTime, time);
    gl.uniform3f(u.uCam, this.camera.yaw, this.camera.pitch, distance);
    gl.uniform2f(u.uShift, shift[0], shift[1]);
    gl.uniform4fv(u.uH1, geo.H1);
    gl.uniform4fv(u.uH2, geo.H2);
    gl.uniform4fv(u.uS1, geo.S1);
    gl.uniform4fv(u.uS2, geo.S2);
    gl.uniform4fv(u.uBeam, geo.beam);
    gl.uniform4fv(u.uBeam2, geo.beam2);
    gl.uniform4f(u.uShape, p.headTilt, p.liquidity, p.twist, p.lean);
    gl.uniform4f(u.uSurf, p.rippleFreq, p.rippleAmp, p.detail, p.envelopeDepth);
    gl.uniform4f(u.uLook, p.hue, p.hue2, p.saturation, p.iridescence);
    gl.uniform4f(u.uLook2, p.dispersion, this.look.material, this.look.scene, this.look.influence);
    gl.uniform4f(u.uLive, this.live.bass, this.live.mid, this.live.high, this.live.beat);
    gl.uniform4f(u.uLive2, this.live.level, p.pulse, surge, this.look.ripples ? 1 : 0);
    gl.uniform1fv(u.uEnv, p.envelope);
    gl.uniform4fv(u.uRip, this.ripples);
    gl.uniform1fv(u.uRipStr, this.rippleStrength);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Renders an off-screen square still at full quality and returns it as a 2D canvas.
  snapshot(time, size) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.draw(time, size, size, [0, 0]);
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);

    const out = document.createElement('canvas');
    out.width = size;
    out.height = size;
    const ctx = out.getContext('2d');
    const image = ctx.createImageData(size, size);
    const row = size * 4;
    for (let y = 0; y < size; y++) image.data.set(pixels.subarray((size - 1 - y) * row, (size - y) * row), y * row);
    ctx.putImageData(image, 0, 0);
    return out;
  }
}
