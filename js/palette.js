// Picks two glass colors from album art: the strongest vivid hue, and a second one clearly apart from it.

export function paletteFromPixels(rgba) {
  const bins = new Float64Array(36);
  const hueSum = new Float64Array(36);
  const satSum = new Float64Array(36);
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] / 255;
    const g = rgba[i + 1] / 255;
    const b = rgba[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const v = max;
    const s = max ? (max - min) / max : 0;
    if (s < 0.2 || v < 0.15) continue;
    let h;
    if (max === r) h = ((g - b) / (max - min)) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h = ((h / 6) % 1 + 1) % 1;
    const w = s * v;
    const bin = Math.min(35, Math.floor(h * 36));
    bins[bin] += w;
    hueSum[bin] += h * w;
    satSum[bin] += s * w;
    total += w;
  }
  // Mostly grey or black-and-white artwork has no colour worth taking.
  if (total < (rgba.length / 4) * 0.04) return null;
  const smooth = (i) => bins[(i + 35) % 36] * 0.5 + bins[i] + bins[(i + 1) % 36] * 0.5;
  let first = 0;
  for (let i = 1; i < 36; i++) if (smooth(i) > smooth(first)) first = i;
  const distance = (a, b) => Math.min(Math.abs(a - b), 36 - Math.abs(a - b));
  let second = -1;
  for (let i = 0; i < 36; i++) {
    if (distance(i, first) < 5 || bins[i] <= 0) continue;
    if (second < 0 || smooth(i) > smooth(second)) second = i;
  }
  const hueOf = (i) => (bins[i] ? hueSum[i] / bins[i] : (i + 0.5) / 36);
  const hue = hueOf(first);
  return {
    hue,
    hue2: second >= 0 && smooth(second) > smooth(first) * 0.08 ? hueOf(second) : (hue + 0.09) % 1,
    saturation: Math.min(0.9, Math.max(0.4, satSum[first] / bins[first])),
  };
}

export async function paletteFromImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 48;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, 48, 48);
  bitmap.close?.();
  return paletteFromPixels(g.getImageData(0, 0, 48, 48).data);
}
