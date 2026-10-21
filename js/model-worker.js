// Builds 3D model files off the main thread so the glass keeps moving while the mesh is made.
import { buildNoteMesh, materialFor, writeGLB, writeUSDZ } from './export3d.js';

self.onmessage = ({ data }) => {
  const { id, dna, material, name } = data;
  try {
    const mesh = buildNoteMesh(dna);
    const mat = materialFor(dna, material);
    const glb = writeGLB(mesh, mat, name);
    const usdz = writeUSDZ(mesh, mat, name);
    self.postMessage({ id, glb, usdz }, [glb.buffer, usdz.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
