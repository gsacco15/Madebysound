// WebGL2 host for the glass-note shader: DNA → uniforms, morphing between notes, snapshots.

import { VERT, FRAG, FRAG_TILE, POST_DOWN, POST_UP, POST_COMPOSITE } from './shader.js';
import { SHAPE_KEYS, toParams, layout } from './note-geometry.js';

export const VIEWS = [
  { id: 'tile', label: 'Tile' },
  { id: 'sculpture', label: 'Sculpture' },
];

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
  { id: 'club', label: 'Neon club' },
  { id: 'rig', label: 'Making of' },
];

const UNIFORMS = [
  'uRes', 'uTime', 'uCam', 'uShift', 'uZoom', 'uH1', 'uH2', 'uS1', 'uS2', 'uBeam', 'uBeam2', 'uShape', 'uSurf', 'uLook',
  'uLook2', 'uLive', 'uLive2', 'uEnv', 'uRip', 'uRipStr', 'uTile', 'uFx',
];
const POST_UNIFORMS = ['uSrc', 'uSrcTexel', 'uDstSize', 'uThreshold', 'uScene', 'uBloom', 'uStrength', 'uTint'];

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

function link(gl, fragment) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
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

function cloneParams(p) {
  return { ...p, envelope: Float32Array.from(p.envelope) };
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
    // The latest big hit: how hard it landed (0..1) and how many seconds ago.
    this.fx = { impact: 0, age: 99 };
    this.look = { view: 0, material: 0, scene: 0, influence: 0.7, ripples: true };
    this.camera = { yaw: 0, pitch: 0.12, zoom: 1 };
    this.shift = [0, 0];
    this.molten = 0;
    this.moltenTarget = 0;
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
    // One program per view: the tile (top-down liquid) and the sculpture (raymarched glass).
    this.programs = [FRAG_TILE, FRAG].map((source) => {
      const program = link(gl, source);
      return { program, loc: Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) };
    });
    const post = (source) => {
      const program = link(gl, source);
      return { program, loc: Object.fromEntries(POST_UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) };
    };
    this.post = { down: post(POST_DOWN), up: post(POST_UP), composite: post(POST_COMPOSITE) };
    // Half-float glow buffers where the device can render to them, so bright light doesn't clip.
    this.hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.vao = gl.createVertexArray();
    this.targets = null;
  }

  createTarget(w, h, hdr) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (hdr && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      this.hdr = false;
      return this.createTarget(w, h, false);
    }
    return { tex, fbo, w, h };
  }

  // The scene buffer plus a ladder of glow buffers, each half the size of the one before.
  createTargets(w, h) {
    const levels = [];
    let lw = Math.max(1, w >> 1);
    let lh = Math.max(1, h >> 1);
    while (levels.length < 5 && Math.min(lw, lh) >= 8) {
      levels.push(this.createTarget(lw, lh, this.hdr));
      lw >>= 1;
      lh >>= 1;
    }
    return { w, h, scene: this.createTarget(w, h, false), levels };
  }

  deleteTargets(t) {
    const gl = this.gl;
    for (const target of [t.scene, ...t.levels, t.out].filter(Boolean)) {
      gl.deleteFramebuffer(target.fbo);
      gl.deleteTexture(target.tex);
    }
  }

  // How much glow each look gets: strong halation for the logo-like tile, gentler for the sculpture,
  // little on the light studio set, and a burst on every big hit.
  glowSettings() {
    const { view, scene } = this.look;
    let threshold = view === 1 ? 0.75 : 0.72;
    let strength = view === 1 ? 0.4 : 0.5;
    if (scene === 1) {
      threshold = 0.92;
      strength = 0.2;
    } else if (scene === 4) {
      strength *= 1.3;
    } else if (scene === 5) {
      threshold = 0.85;
      strength = 0.22;
    }
    strength += this.fx.impact * 0.45 * Math.exp(-this.fx.age * 3);
    return { threshold, strength };
  }

  glow(t, out) {
    const gl = this.gl;
    const { threshold, strength } = this.glowSettings();
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.vao);
    const pass = (prog, src, dst, extra) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.useProgram(prog.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(prog.loc.uSrc, 0);
      gl.uniform2f(prog.loc.uSrcTexel, 1 / src.w, 1 / src.h);
      gl.uniform2f(prog.loc.uDstSize, dst.w, dst.h);
      extra?.();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    let src = t.scene;
    t.levels.forEach((dst, i) => {
      pass(this.post.down, src, dst, () => gl.uniform1f(this.post.down.loc.uThreshold, i === 0 ? threshold : -1));
      src = dst;
    });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = t.levels.length - 1; i > 0; i--) pass(this.post.up, t.levels[i], t.levels[i - 1]);
    gl.disable(gl.BLEND);

    const c = this.post.composite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
    gl.viewport(0, 0, t.w, t.h);
    gl.useProgram(c.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.scene.tex);
    gl.uniform1i(c.loc.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t.levels.length ? t.levels[0].tex : t.scene.tex);
    gl.uniform1i(c.loc.uBloom, 1);
    gl.uniform2f(c.loc.uDstSize, t.w, t.h);
    gl.uniform1f(c.loc.uStrength, t.levels.length ? strength : 0);
    gl.uniform3f(c.loc.uTint, 1.0, 0.97, 1.03);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  // A quiet change (only the colour moved) blends quickly without the glass going molten.
  setDNA(dna, { instant = false, quiet = false } = {}) {
    const target = toParams(dna);
    this.quietMorph = quiet;
    this.morphDuration = quiet ? 0.6 : 1.6;
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
    this.molten += (this.moltenTarget - this.molten) * 0.06;
    const melt = this.molten * 0.38;
    if (!this.from) return melt;
    const k = Math.min(1, (performance.now() / 1000 - this.morphStart) / this.morphDuration);
    const e = ease(k);
    const { from, target, current } = this;
    for (const key of SHAPE_KEYS) current[key] = lerp(from[key], target[key], e);
    current.hue = lerpHue(from.hue, target.hue, e);
    current.hue2 = lerpHue(from.hue2, target.hue2, e);
    current.rimA = lerpHue(from.rimA, target.rimA, e);
    current.rimB = lerpHue(from.rimB, target.rimB, e);
    current.pullA = lerp(from.pullA, target.pullA, e);
    current.pullB = lerp(from.pullB, target.pullB, e);
    current.beams = e < 0.5 ? from.beams : target.beams;
    for (let i = 0; i < current.envelope.length; i++) current.envelope[i] = lerp(from.envelope[i], target.envelope[i], e);
    if (k >= 1) this.from = null;
    // The glass goes molten mid-morph, then sets into the new form.
    return Math.max(melt, this.quietMorph ? 0 : Math.sin(Math.PI * k) * 0.32);
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
    const { width: w, height: h } = this.canvas;
    if (!this.targets || this.targets.w !== w || this.targets.h !== h) {
      if (this.targets) this.deleteTargets(this.targets);
      this.targets = this.createTargets(w, h);
    }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.targets.scene.fbo);
    this.draw(time, w, h, this.shift);
    this.glow(this.targets, null);
  }

  draw(time, w, h, shift) {
    const gl = this.gl;
    const { program, loc: u } = this.programs[this.look.view === 1 ? 1 : 0];
    const surge = this.stepMorph();
    const p = this.current;
    const geo = layout(p);
    const aspect = w / h;
    const fit = Math.min(1 / 3, aspect / 3);
    const distance = 1.12 / fit / 0.62 / this.camera.zoom;

    gl.viewport(0, 0, w, h);
    gl.useProgram(program);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uTime, time);
    gl.uniform3f(u.uCam, this.camera.yaw, this.camera.pitch, distance);
    gl.uniform2f(u.uShift, shift[0], shift[1]);
    gl.uniform1f(u.uZoom, this.camera.zoom * Math.min(1, aspect / 0.95));
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
    gl.uniform4f(u.uTile, p.rimA * Math.PI * 2, p.rimB * Math.PI * 2, p.pullA, p.pullB);
    gl.uniform4f(u.uFx, this.fx.impact, this.fx.age, 0, 0);
    gl.uniform4fv(u.uRip, this.ripples);
    gl.uniform1fv(u.uRipStr, this.rippleStrength);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Renders an off-screen still at full quality and returns it as a 2D canvas. Large stills are drawn
  // in horizontal bands so no single draw call runs long enough to trip a GPU watchdog.
  snapshot(time, width, height = width, shift = [0, 0]) {
    const gl = this.gl;
    const t = this.createTargets(width, height);
    t.out = this.createTarget(width, height, false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.scene.fbo);
    const band = Math.max(64, Math.floor(400000 / width));
    gl.enable(gl.SCISSOR_TEST);
    for (let y = 0; y < height; y += band) {
      gl.scissor(0, y, width, Math.min(band, height - y));
      this.draw(time, width, height, shift);
    }
    gl.disable(gl.SCISSOR_TEST);
    this.glow(t, t.out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.out.fbo);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.deleteTargets(t);

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    const image = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    ctx.putImageData(image, 0, 0);
    return out;
  }
}
