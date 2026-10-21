// GLSL for the glass note. One full-screen triangle; everything is raymarched.

export const VERT = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCam;      // yaw, pitch, distance
uniform vec2 uShift;    // moves the note on screen, in view units
uniform vec4 uH1;       // head 1 centre xyz, radius
uniform vec4 uH2;
uniform vec4 uS1;       // stem 1: x, y bottom, y top, width
uniform vec4 uS2;
uniform vec4 uBeam;     // beam top edge: start xy, end xy
uniform vec4 uBeam2;    // thickness, depth, count, gap
uniform vec4 uShape;    // head tilt, liquidity, twist, lean
uniform vec4 uSurf;     // ripple frequency, ripple depth, fine detail, envelope depth
uniform vec4 uLook;     // hue, second hue, saturation, iridescence
uniform vec4 uLook2;    // dispersion, material, scene, sound influence
uniform vec4 uLive;     // bass, mid, high, beat
uniform vec4 uLive2;    // level, pulse (beats per second), morph surge, ripples on
uniform float uEnv[32]; // loudness over the song
uniform vec4 uRip[12];  // ripple x, z, age, hue
uniform float uRipStr[12];

#define PI 3.14159265
const float FLOOR_Y = -1.45;

vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float envAt(float t) {
  float x = clamp(t, 0.0, 1.0) * 31.0;
  int i = int(floor(x));
  int j = min(i + 1, 31);
  return mix(uEnv[i], uEnv[j], fract(x));
}

float influence() { return uLook2.w; }

float noteHead(vec3 p, vec4 h) {
  vec3 q = p - h.xyz;
  q.xy = rot(uShape.x) * q.xy;
  float r = h.w * (1.0 + 0.16 * uLive.x * influence());
  return sdEllipsoid(q, vec3(1.3, 0.9, 0.78) * r);
}

// The song's loudness is engraved along the stems: first half on the left, second half on the right.
float stem(vec3 p, vec4 s, float songStart) {
  float t = clamp((p.y - s.y) / (s.z - s.y), 0.0, 1.0);
  float e = envAt(songStart + t * 0.5);
  float w = s.w * (1.0 - 0.5 * uSurf.w + uSurf.w * e);
  return length(p - vec3(s.x, mix(s.y, s.z, t), 0.0)) - w;
}

float beam(vec3 p, float offset) {
  vec2 a = uBeam.xy;
  vec2 b = uBeam.zw;
  vec2 dir = normalize(b - a);
  vec2 nrm = vec2(-dir.y, dir.x);
  float th = uBeam2.x;
  vec2 c = 0.5 * (a + b) - nrm * (th * 0.5 + offset);
  vec2 q = p.xy - c;
  float u = dot(q, dir);
  float v = dot(q, nrm) + 0.03 * uLive.z * influence() * sin(u * 9.0 - uTime * 7.0);
  float halfLen = 0.5 * length(b - a) + uS1.w * 1.3;
  return sdRoundBox(vec3(u, v, p.z), vec3(halfLen, th * 0.5, uBeam2.y * 0.5), min(th, uBeam2.y) * 0.45);
}

float map(vec3 p) {
  float t = uTime;
  float k = influence();
  p.y -= 0.035 * sin(t * 0.9);
  float s = 1.0 + 0.045 * uLive.w * k + 0.012 * sin(t * PI * uLive2.y);
  p /= s;
  p.x -= uShape.w * p.y;
  p.xz = rot(uShape.z * p.y) * p.xz;

  float join = uShape.y + uLive2.z;
  float d = noteHead(p, uH1);
  d = smin(d, noteHead(p, uH2), join);
  d = smin(d, stem(p, uS1, 0.0), join);
  d = smin(d, stem(p, uS2, 0.5), join);
  float bm = beam(p, 0.0);
  if (uBeam2.z > 1.5) bm = min(bm, beam(p, uBeam2.w));
  d = smin(d, bm, join * 0.7);

  float r1 = length(p - uH1.xyz);
  float r2 = length(p - uH2.xyz);
  float frozen = sin(r1 * uSurf.x) + sin(r2 * uSurf.x + 1.7);
  float waves = sin(r1 * uSurf.x - t * 5.0) + sin(r2 * uSurf.x - t * 5.0 + 1.3);
  float fine = sin(p.x * 31.0 + t * 1.3) * sin(p.y * 27.0 - t * 1.1) * sin(p.z * 29.0 + t * 0.7);
  d += uSurf.y * frozen * 0.5 + 0.008 * uLive.y * k * waves + uSurf.z * (1.0 + 2.5 * uLive.z * k) * fine;
  return d * s;
}

vec2 sphereHit(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

float march(vec3 ro, vec3 rd) {
  vec2 bound = sphereHit(ro, rd, 1.95);
  if (bound.y < 0.0) return -1.0;
  float t = max(bound.x, 0.0);
  for (int i = 0; i < 110; i++) {
    float d = map(ro + rd * t);
    if (d < 0.0008 * t) return t;
    t += d * 0.75;
    if (t > bound.y) break;
  }
  return -1.0;
}

vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(1.0, -1.0) * 0.0015;
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

int sceneId() { return int(uLook2.z + 0.5); }

// Softboxes that live in reflections. Two strips take the song's colours.
vec3 studioLights(vec3 d) {
  vec3 c = vec3(1.0) * smoothstep(0.55, 0.88, d.y) * 2.2;
  float az = atan(d.x, d.z);
  float s1 = smoothstep(0.16, 0.04, abs(az - 1.9)) * smoothstep(-0.25, 0.05, d.y) * smoothstep(0.75, 0.45, d.y);
  float s2 = smoothstep(0.12, 0.03, abs(az + 1.6)) * smoothstep(-0.2, 0.1, d.y) * smoothstep(0.7, 0.4, d.y);
  c += hsv(uLook.x, 0.35, 1.0) * s1 * 2.4;
  c += hsv(uLook.y, 0.45, 1.0) * s2 * 1.8;
  c += vec3(0.25) * smoothstep(0.75, 0.95, d.z) * smoothstep(-0.1, 0.3, d.y);
  c += vec3(3.0) * pow(max(dot(d, normalize(vec3(0.5, 0.6, 0.6))), 0.0), 60.0);
  return c;
}

// A soft light behind the note in the song's colour. It breathes with the music.
vec3 backlight(vec3 rd, float strength) {
  float b = max(dot(rd, normalize(vec3(0.0, 0.16, -1.0))), 0.0);
  float breathe = 0.75 + 0.7 * uLive2.x * influence();
  return hsv(uLook.x, 0.6, 1.0) * (pow(b, 12.0) * 0.1 + pow(b, 70.0) * 0.5) * strength * breathe;
}

vec3 sky(vec3 rd, bool primary) {
  int scene = sceneId();
  float y = rd.y;
  vec3 lights = studioLights(rd);
  if (scene == 1) {
    vec3 c = mix(vec3(0.74, 0.75, 0.78), vec3(0.93, 0.93, 0.95), smoothstep(-0.2, 0.7, y));
    // Black cards beside the set give the glass its dark edges, as in product photography.
    if (!primary) {
      float az = abs(atan(rd.x, rd.z));
      c *= 1.0 - 0.9 * smoothstep(0.32, 0.14, abs(az - 2.2)) * smoothstep(-0.35, -0.05, y) * smoothstep(0.85, 0.5, y);
    }
    return c + lights * 0.35;
  }
  if (scene == 2) {
    vec3 c = mix(vec3(0.95, 0.48, 0.3), vec3(0.14, 0.1, 0.28), smoothstep(0.0, 0.55, y));
    c = mix(c, vec3(1.0, 0.8, 0.55), exp(-abs(y) * 14.0) * 0.7);
    float sun = max(dot(rd, normalize(vec3(-0.35, 0.07, -1.0))), 0.0);
    c += vec3(1.0, 0.7, 0.4) * (pow(sun, 400.0) * 6.0 + pow(sun, 18.0) * 0.35);
    return c + lights * 0.6;
  }
  if (scene == 3) return vec3(0.004, 0.004, 0.006) + lights + backlight(rd, 0.3);
  if (scene == 4) {
    // Neon club: tubes in the song's two colours behind the note, pulsing with the level.
    float az = atan(rd.x, rd.z);
    float behind = az > 0.0 ? az - PI : az + PI;
    float pulse = 0.8 + 0.6 * uLive2.x * influence() + 0.5 * uLive.w * influence();
    float span = smoothstep(0.62, 0.55, abs(behind));
    float d1 = abs(y - 0.24);
    float d2 = abs(y - 0.02);
    float dv = abs(abs(behind) - 0.58);
    float vspan = smoothstep(-0.08, -0.04, y) * smoothstep(0.32, 0.28, y);
    vec3 a = hsv(uLook.x, 0.85, 1.0);
    vec3 b = hsv(uLook.y, 0.85, 1.0);
    vec3 c = vec3(0.006, 0.004, 0.012);
    c += a * span * (exp(-pow(d1 / 0.004, 2.0)) * 4.0 + exp(-pow(d1 / 0.035, 2.0)) * 0.35) * pulse;
    c += b * span * (exp(-pow(d2 / 0.004, 2.0)) * 3.0 + exp(-pow(d2 / 0.03, 2.0)) * 0.25) * pulse;
    c += mix(a, b, 0.5) * vspan * (exp(-pow(dv / 0.004, 2.0)) * 3.0 + exp(-pow(dv / 0.03, 2.0)) * 0.25) * pulse;
    c += a * 0.03 * exp(-abs(y - 0.15) * 5.0);
    return c + lights * 0.35 * mix(vec3(1.0), a, 0.5);
  }
  return mix(vec3(0.008, 0.009, 0.013), vec3(0.03, 0.034, 0.048), smoothstep(-0.05, 0.5, y)) + lights + backlight(rd, 1.0);
}

// Height-field gradient of the bath, plus the coloured glow of each note's ripple.
vec2 rippleField(vec2 xz, out vec3 glow) {
  glow = vec3(0.0);
  float r0 = length(xz) + 1e-4;
  float a0 = (0.006 + 0.03 * uLive.x * influence()) * exp(-r0 * 0.45);
  vec2 g = (xz / r0) * a0 * 10.0 * cos(r0 * 10.0 - uTime * 6.0);
  if (uLive2.w < 0.5) return g;
  for (int i = 0; i < 12; i++) {
    float s = uRipStr[i];
    if (s <= 0.0) continue;
    vec4 r = uRip[i];
    vec2 dv = xz - r.xy;
    float d = length(dv) + 1e-4;
    float x = d - r.z * 1.5;
    float env = exp(-x * x * 2.2) * exp(-r.z * 0.8) * s;
    float w = 13.0;
    g += (dv / d) * env * (w * cos(x * w) - 4.4 * x * sin(x * w)) * 0.02;
    glow += hsv(r.w, 0.75, 1.0) * env * (0.5 + 0.5 * cos(x * w));
  }
  return g;
}

vec3 floorShade(vec3 ro, vec3 rd, float t) {
  int scene = sceneId();
  vec3 p = ro + rd * t;
  vec3 glow;
  vec2 g = rippleField(p.xz, glow);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 r = reflect(rd, n);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
  vec3 refl = sky(r, false);
  float dist = length(p.xz);
  float shade = 1.0 - 0.55 * exp(-dist * dist * 0.9);
  vec3 col;
  if (scene == 1) {
    col = vec3(0.8, 0.8, 0.83) * shade + refl * fres * 0.25;
    col = mix(col, col * (0.55 + 0.45 * normalize(glow + 1e-3)), clamp(length(glow), 0.0, 1.0) * 0.5);
  } else if (scene == 2) {
    col = vec3(0.04, 0.025, 0.05) + refl * fres * shade;
    col += glow * 0.22;
  } else {
    col = vec3(0.003, 0.004, 0.006) + refl * fres * (0.4 + 0.6 * shade);
    col += glow * (scene == 4 ? 0.4 : 0.24);
  }
  return mix(col, sky(rd, false), smoothstep(10.0, 40.0, t));
}

vec3 background(vec3 ro, vec3 rd, bool primary) {
  if (sceneId() != 3 && rd.y < -0.001) {
    float t = (FLOOR_Y - ro.y) / rd.y;
    if (t > 0.0) return floorShade(ro, rd, t);
  }
  return sky(rd, primary);
}

vec3 shadeNote(vec3 p, vec3 rd) {
  vec3 n = calcNormal(p);
  float ndv = clamp(dot(-rd, n), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 5.0);
  int mat = int(uLook2.y + 0.5);
  float k = influence();
  vec3 tint = hsv(uLook.x, uLook.z, 1.0);
  vec3 r = reflect(rd, n);
  vec3 refl = background(p + r * 0.01, r, false);

  if (mat == 3) {
    vec3 f0 = mix(vec3(0.92), tint, 0.4);
    return (f0 + (1.0 - f0) * fres) * refl + tint * uLive.w * k * 0.08;
  }

  float ior = 1.46;
  vec3 rdi = refract(rd, n, 1.0 / ior);
  if (mat == 1) {
    rdi = normalize(rdi + 0.22 * vec3(sin(p.y * 41.0 + p.z * 13.0), sin(p.z * 37.0 + p.x * 17.0), sin(p.x * 43.0 + p.y * 11.0)));
  }
  float t = 0.03;
  for (int i = 0; i < 32; i++) {
    float d = -map(p + rdi * t);
    if (d < 0.002) break;
    t += max(d * 0.9, 0.01);
  }
  vec3 pe = p + rdi * t;
  vec3 ne = -calcNormal(pe);
  float disp = uLook2.x;

  vec3 oR = refract(rdi, ne, ior - disp);
  vec3 oG = refract(rdi, ne, ior);
  vec3 oB = refract(rdi, ne, ior + disp);
  if (dot(oR, oR) < 0.01) oR = reflect(rdi, ne);
  if (dot(oG, oG) < 0.01) oG = reflect(rdi, ne);
  if (dot(oB, oB) < 0.01) oB = reflect(rdi, ne);
  vec3 col = vec3(
    background(pe + oR * 0.01, oR, false).r,
    background(pe + oG * 0.01, oG, false).g,
    background(pe + oB * 0.01, oB, false).b
  );

  vec3 absorb = (1.0 - tint) * 0.35 + 0.02;
  if (mat == 2) absorb = (1.0 - tint) * 1.6 + 0.05;
  if (mat == 4) absorb = vec3(2.4);
  col *= exp(-absorb * t);

  float irid = uLook.w;
  vec3 film = 0.5 + 0.5 * cos(2.0 * PI * (vec3(0.0, 0.33, 0.67) + uLook.x + t * 0.9 + fres * 1.2 + n.y * 0.15));
  col *= mix(vec3(1.0), film * 1.3, irid * 0.35);
  if (mat == 1) col = mix(col, vec3(dot(col, vec3(0.333))) * mix(vec3(1.0), tint, 0.4) + 0.1 + 0.08 * tint, 0.7);

  vec3 c = mix(col, refl, 0.04 + 0.96 * fres);
  c += film * fres * irid * 0.5 * (1.0 + uLive.z * k);
  if (mat == 4) {
    float rim = pow(1.0 - ndv, 2.2);
    vec3 neon = mix(hsv(uLook.x, 0.85, 1.0), hsv(uLook.y, 0.85, 1.0), 0.5 + 0.5 * n.y);
    c += neon * rim * (1.6 + 2.0 * uLive2.x * k + 1.5 * uLive.w * k);
  }
  c += tint * uLive.w * k * 0.12 * (0.3 + fres);
  return c;
}

void main() {
  vec2 screen = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 uv = screen - uShift;
  vec3 ta = vec3(0.0, -0.1, 0.0);
  vec3 ro = ta + uCam.z * vec3(sin(uCam.x) * cos(uCam.y), sin(uCam.y), cos(uCam.x) * cos(uCam.y));
  vec3 ww = normalize(ta - ro);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = cross(uu, ww);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.5 * ww);

  int scene = sceneId();
  vec3 col = background(ro, rd, true);
  float t = march(ro, rd);
  if (t > 0.0) col = shadeNote(ro + rd * t, rd);

  col = col * (2.51 * col + 0.03) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  float vig = smoothstep(1.25, 0.35, length(screen * vec2(0.9, 1.1)));
  col *= mix(scene == 1 ? 0.9 : 0.7, 1.0, vig);
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * (2.0 / 255.0);
  outColor = vec4(col, 1.0);
}`;
