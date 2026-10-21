// Turns a signed distance function into a triangle mesh with naive surface nets:
// one vertex per surface-crossing cell (snapped onto the surface), one quad per crossing grid edge.

const CORNERS = [];
for (let i = 0; i < 8; i++) CORNERS.push([i & 1, (i >> 1) & 1, (i >> 2) & 1]);
const EDGES = [];
for (let i = 0; i < 8; i++) {
  for (let axis = 0; axis < 3; axis++) {
    const j = i | (1 << axis);
    if (j !== i) EDGES.push([i, j]);
  }
}

export function surfaceNets(sdf, { min, max, cell }) {
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1;
  const ny = Math.ceil((max[1] - min[1]) / cell) + 1;
  const nz = Math.ceil((max[2] - min[2]) / cell) + 1;
  const at = (i, j, k) => i + nx * (j + ny * k);
  const field = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = min[2] + k * cell;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * cell;
      for (let i = 0; i < nx; i++) field[at(i, j, k)] = sdf(min[0] + i * cell, y, z);
    }
  }

  const cellVertex = new Int32Array(nx * ny * nz).fill(-1);
  const positions = [];
  const values = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNERS[c];
          values[c] = field[at(i + dx, j + dy, k + dz)];
          if (values[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [a, b] of EDGES) {
          const va = values[a];
          const vb = values[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          const ca = CORNERS[a];
          const cb = CORNERS[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          n++;
        }
        cellVertex[at(i, j, k)] = positions.length / 3;
        positions.push(min[0] + (i + sx / n) * cell, min[1] + (j + sy / n) * cell, min[2] + (k + sz / n) * cell);
      }
    }
  }

  // Each grid edge that crosses the surface is shared by four cells; their vertices make a quad.
  const indices = [];
  const steps = [1, nx, nx * ny];
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const here = at(i, j, k);
        const v0 = field[here];
        for (let axis = 0; axis < 3; axis++) {
          const v1 = field[here + steps[axis]];
          if (v0 < 0 === v1 < 0) continue;
          const u = steps[(axis + 1) % 3];
          const v = steps[(axis + 2) % 3];
          const quad = [cellVertex[here], cellVertex[here - u], cellVertex[here - u - v], cellVertex[here - v]];
          if (quad.some((q) => q < 0)) continue;
          // Wind so faces point from inside (negative) to outside.
          if (v0 < 0) indices.push(quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]);
          else indices.push(quad[0], quad[2], quad[1], quad[0], quad[3], quad[2]);
        }
      }
    }
  }

  // Snap vertices onto the surface and take normals from the field's gradient.
  const e = cell * 0.25;
  const normals = new Float32Array(positions.length);
  const pos = Float32Array.from(positions);
  for (let v = 0; v < pos.length; v += 3) {
    for (let pass = 0; pass < 2; pass++) {
      const [x, y, z] = [pos[v], pos[v + 1], pos[v + 2]];
      const gx = sdf(x + e, y, z) - sdf(x - e, y, z);
      const gy = sdf(x, y + e, z) - sdf(x, y - e, z);
      const gz = sdf(x, y, z + e) - sdf(x, y, z - e);
      const len = Math.hypot(gx, gy, gz) || 1;
      if (pass === 0) {
        const d = sdf(x, y, z);
        pos[v] -= (d * gx) / len;
        pos[v + 1] -= (d * gy) / len;
        pos[v + 2] -= (d * gz) / len;
      } else {
        normals[v] = gx / len;
        normals[v + 1] = gy / len;
        normals[v + 2] = gz / len;
      }
    }
  }
  const IndexArray = pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
  return { positions: pos, normals, indices: IndexArray.from(indices) };
}
