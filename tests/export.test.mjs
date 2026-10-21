import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDNA } from '../js/dna.js';
import { DEMO_FEATURES } from '../js/demo-features.js';
import { buildNoteMesh, materialFor, writeGLB, writeUSDA, writeUSDZ, writeZip, crc32 } from '../js/export3d.js';
import { surfaceNets } from '../js/mesh.js';

const dna = makeDNA(DEMO_FEATURES['night-drive']);

test('surface nets mesh a sphere into a closed, outward-facing surface', () => {
  const mesh = surfaceNets((x, y, z) => Math.hypot(x, y, z) - 1, { min: [-1.3, -1.3, -1.3], max: [1.3, 1.3, 1.3], cell: 0.1 });
  const { positions, normals, indices } = mesh;
  for (let i = 0; i < positions.length; i += 3) {
    assert.ok(Math.abs(Math.hypot(positions[i], positions[i + 1], positions[i + 2]) - 1) < 0.01, 'vertices sit on the surface');
    assert.ok(Math.abs(Math.hypot(normals[i], normals[i + 1], normals[i + 2]) - 1) < 1e-4);
  }
  // Every edge is shared by exactly two triangles, in opposite directions.
  const edges = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e];
      const b = indices[t + ((e + 1) % 3)];
      const key = `${a},${b}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    const [a, b] = key.split(',');
    assert.equal(count, 1);
    assert.equal(edges.get(`${b},${a}`), 1);
  }
  // Faces point outward: the signed volume is positive.
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((i) => positions.subarray(i * 3, i * 3 + 3));
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  assert.ok(Math.abs(volume - (4 / 3) * Math.PI) < 0.1, `volume ${volume}`);
});

test('note mesh stands on the floor at about 20 cm', () => {
  const mesh = buildNoteMesh(dna, { cell: 0.05 });
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < mesh.positions.length; i += 3) {
    minY = Math.min(minY, mesh.positions[i]);
    maxY = Math.max(maxY, mesh.positions[i]);
  }
  assert.ok(Math.abs(minY) < 1e-6);
  assert.ok(maxY > 0.15 && maxY < 0.26, `height ${maxY}`);
  assert.ok(Math.max(...mesh.indices) < mesh.positions.length / 3);
});

test('GLB has a valid header, JSON chunk and binary chunk', () => {
  const mesh = buildNoteMesh(dna, { cell: 0.05 });
  const glb = writeGLB(mesh, materialFor(dna, 0), 'Night Drive');
  const v = new DataView(glb.buffer);
  assert.equal(v.getUint32(0, true), 0x46546c67);
  assert.equal(v.getUint32(8, true), glb.length);
  const jsonLength = v.getUint32(12, true);
  assert.equal(jsonLength % 4, 0);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  assert.equal(json.accessors[0].count, mesh.positions.length / 3);
  assert.equal(json.materials[0].extensions.KHR_materials_ior.ior, 1.46);
  assert.equal(v.getUint32(20 + jsonLength + 4, true), 0x004e4942);
});

test('USDZ is a stored zip with 64-byte aligned data and correct CRCs', () => {
  const mesh = buildNoteMesh(dna, { cell: 0.06 });
  const usda = writeUSDA(mesh, materialFor(dna, 3), 'Night "Drive"');
  assert.match(usda, /^#usda 1\.0/);
  assert.match(usda, /assetInfo = \{\n\s+string name = "Night \\"Drive\\""/);
  assert.match(usda, /prepend apiSchemas = \["MaterialBindingAPI"\]/);
  const zip = writeUSDZ(mesh, materialFor(dna, 3), 'Night Drive');
  const v = new DataView(zip.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  assert.equal(v.getUint16(8, true), 0, 'stored, not compressed');
  const nameLen = v.getUint16(26, true);
  const extraLen = v.getUint16(28, true);
  const start = 30 + nameLen + extraLen;
  assert.equal(start % 64, 0);
  const size = v.getUint32(18, true);
  assert.equal(crc32(zip.subarray(start, start + size)), v.getUint32(14, true));
  assert.equal(new TextDecoder().decode(zip.subarray(start, start + 9)), '#usda 1.0');
});

test('zip end record points at the central directory', () => {
  const zip = writeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.bin', data: Uint8Array.of(1, 2, 3) }]);
  const v = new DataView(zip.buffer);
  const end = zip.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint16(end + 10, true), 2);
  assert.equal(v.getUint32(v.getUint32(end + 16, true), true), 0x02014b50);
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
});
