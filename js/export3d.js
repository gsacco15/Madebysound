// 3D models of a note: binary glTF (.glb) for viewers and editors, USDZ for AR Quick Look on iPhone.

import { noteDistance, toParams } from './note-geometry.js';
import { surfaceNets } from './mesh.js';

// Real-world size: the note stands about 22 cm tall, resting on the floor.
const METERS_PER_UNIT = 0.1;

export function buildNoteMesh(dna, { cell = 0.02 } = {}) {
  const sdf = noteDistance(toParams(dna));
  const mesh = surfaceNets(sdf, { min: [-1.5, -1.45, -0.62], max: [1.5, 1.45, 0.62], cell });
  const { positions } = mesh;
  let minY = Infinity;
  for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, positions[i]);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] *= METERS_PER_UNIT;
    positions[i + 1] = (positions[i + 1] - minY) * METERS_PER_UNIT;
    positions[i + 2] *= METERS_PER_UNIT;
  }
  return mesh;
}

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

// Material presets per Studio material, in physically based terms.
export function materialFor(dna, material) {
  const tint = hsvToRgb(dna.hue, dna.saturation, 1);
  const pale = tint.map((c) => 0.75 + 0.25 * c);
  const presets = [
    { name: 'Clear glass', color: pale, metallic: 0, roughness: 0.04, transmission: 1, opacity: 0.3 },
    { name: 'Frosted', color: pale, metallic: 0, roughness: 0.42, transmission: 1, opacity: 0.55 },
    { name: 'Song tint', color: tint, metallic: 0, roughness: 0.05, transmission: 0.9, opacity: 0.5 },
    { name: 'Liquid metal', color: tint.map((c) => 0.6 + 0.4 * c), metallic: 1, roughness: 0.12, transmission: 0, opacity: 1 },
    { name: 'Neon edge', color: [0.05, 0.05, 0.06], metallic: 0, roughness: 0.08, transmission: 0.4, opacity: 0.75, emissive: hsvToRgb(dna.hue, 0.85, 1) },
  ];
  return { ...presets[material] ?? presets[0], tint, iridescence: dna.iridescence };
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  return { min, max };
}

const pad4 = (n) => (n + 3) & ~3;

export function writeGLB(mesh, mat, name) {
  const { positions, normals, indices } = mesh;
  const { min, max } = bounds(positions);
  const idx32 = indices instanceof Uint32Array;
  const views = [positions, normals, indices];
  const offsets = [];
  let byteLength = 0;
  for (const v of views) {
    offsets.push(byteLength);
    byteLength = pad4(byteLength + v.byteLength);
  }
  const extensions = ['KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_volume', 'KHR_materials_iridescence'];
  if (mat.emissive) extensions.push('KHR_materials_emissive_strength');
  const material = {
    name: mat.name,
    pbrMetallicRoughness: { baseColorFactor: [...mat.color, 1], metallicFactor: mat.metallic, roughnessFactor: mat.roughness },
    extensions: {
      KHR_materials_transmission: { transmissionFactor: mat.transmission },
      KHR_materials_ior: { ior: 1.46 },
      KHR_materials_volume: { thicknessFactor: 0.03, attenuationDistance: 0.12, attenuationColor: mat.tint },
      KHR_materials_iridescence: { iridescenceFactor: mat.iridescence, iridescenceIor: 1.3 },
    },
  };
  if (mat.emissive) {
    material.emissiveFactor = mat.emissive;
    material.extensions.KHR_materials_emissive_strength = { emissiveStrength: 2 };
  }
  const json = {
    asset: { version: '2.0', generator: 'madebysound' },
    extensionsUsed: extensions,
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [material],
    buffers: [{ byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: normals.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: indices.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: idx32 ? 5125 : 5123, count: indices.length, type: 'SCALAR' },
    ],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLength + 8 + byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  const binStart = 20 + jsonLength;
  dv.setUint32(binStart, byteLength, true);
  dv.setUint32(binStart + 4, 0x004e4942, true);
  views.forEach((v, i) => out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), binStart + 8 + offsets[i]));
  return out;
}

const f = (v, d) => {
  const s = v.toFixed(d);
  return s === `-${(0).toFixed(d)}` ? (0).toFixed(d) : s;
};
const rgb = (c) => `(${c.map((v) => f(v, 4)).join(', ')})`;
const usdString = (s) => JSON.stringify(String(s));

export function writeUSDA(mesh, mat, name) {
  const { positions, normals, indices } = mesh;
  const { min, max } = bounds(positions);
  const points = [];
  const norms = [];
  for (let i = 0; i < positions.length; i += 3) {
    points.push(`(${f(positions[i], 5)}, ${f(positions[i + 1], 5)}, ${f(positions[i + 2], 5)})`);
    norms.push(`(${f(normals[i], 4)}, ${f(normals[i + 1], 4)}, ${f(normals[i + 2], 4)})`);
  }
  const counts = new Array(indices.length / 3).fill(3).join(', ');
  const emissive = mat.emissive ? `\n                color3f inputs:emissiveColor = ${rgb(mat.emissive)}` : '';
  return `#usda 1.0
(
    defaultPrim = "Note"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Note" (
    assetInfo = {
        string name = ${usdString(name)}
    }
    kind = "component"
)
{
    def Mesh "Glass" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {
        uniform bool doubleSided = 0
        float3[] extent = [${rgb(min)}, ${rgb(max)}]
        int[] faceVertexCounts = [${counts}]
        int[] faceVertexIndices = [${Array.from(indices).join(', ')}]
        rel material:binding = </Note/Materials/Glass>
        normal3f[] normals = [${norms.join(', ')}] (
            interpolation = "vertex"
        )
        point3f[] points = [${points.join(', ')}]
        uniform token subdivisionScheme = "none"
    }

    def Scope "Materials"
    {
        def Material "Glass"
        {
            token outputs:surface.connect = </Note/Materials/Glass/Surface.outputs:surface>

            def Shader "Surface"
            {
                uniform token info:id = "UsdPreviewSurface"
                float inputs:clearcoat = 1
                float inputs:clearcoatRoughness = 0.02
                color3f inputs:diffuseColor = ${rgb(mat.color)}${emissive}
                float inputs:ior = 1.46
                float inputs:metallic = ${mat.metallic}
                float inputs:opacity = ${mat.opacity}
                float inputs:roughness = ${mat.roughness}
                token outputs:surface
            }
        }
    }
}
`;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// An uncompressed zip. With align = 64 each file's data starts on a 64-byte boundary, as USDZ requires.
export function writeZip(files, { align = 0 } = {}) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : enc.encode(file.data);
    const crc = crc32(data);
    let extra = new Uint8Array(0);
    if (align) {
      const pad = (align - ((offset + 30 + name.length + 4) % align)) % align;
      extra = new Uint8Array(4 + pad);
      new DataView(extra.buffer).setUint16(0, 0x1986, true);
      new DataView(extra.buffer).setUint16(2, pad, true);
    }
    const header = new Uint8Array(30 + name.length + extra.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(8, 0, true);
    h.setUint16(10, 0, true);
    h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    h.setUint16(28, extra.length, true);
    header.set(name, 30);
    header.set(extra, 30 + name.length);
    locals.push(header, data);

    const entry = new Uint8Array(46 + name.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);
    offset += header.length + data.length;
  }
  const centralSize = central.reduce((s, e) => s + e.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of [...locals, ...central, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export function writeUSDZ(mesh, mat, name) {
  return writeZip([{ name: 'note.usda', data: writeUSDA(mesh, mat, name) }], { align: 64 });
}
