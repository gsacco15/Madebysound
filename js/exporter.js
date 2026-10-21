// Note cards, video clips, and getting files out of the browser.

// Inside a claude.ai artifact viewer, downloads go through the viewer's own save prompt.
export const inArtifactViewer = typeof window !== 'undefined' && typeof window.claude?.use === 'function';

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not capture the image.'))), type, quality);
  });
}

export async function saveFile(filename, blob) {
  if (inArtifactViewer) {
    const downloads = await window.claude.use('downloads');
    if (!downloads) throw Object.assign(new Error('Saving files is not available in this view.'), { code: 'unavailable' });
    await downloads.save({ filename, data: blob });
    return;
  }
  const file = new File([blob], filename, { type: blob.type });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === 'AbortError') throw Object.assign(err, { code: 'declined' });
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function slug(text) {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .slice(0, 48) || 'note'
  );
}

const songColor = (hue, lightness = 68) => `hsl(${Math.round(hue * 360)} 72% ${lightness}%)`;

function fitFont(ctx, text, family, size, maxWidth) {
  let s = size;
  ctx.font = `400 ${s}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && s > 32) {
    s -= 2;
    ctx.font = `400 ${s}px ${family}`;
  }
}

// A 4:5 card: the glass note, the song, and its loudness signature.
export async function makeCard({ still, title, meta, dna }) {
  const display = '"Instrument Serif", "Iowan Old Style", Georgia, serif';
  const mono = '"Geist Mono", ui-monospace, Menlo, monospace';
  if (document.fonts?.load) {
    await Promise.all([`400 80px ${display}`, `italic 400 44px ${display}`, `400 24px ${mono}`].map((f) => document.fonts.load(f).catch(() => {})));
  }
  const W = 1080;
  const H = 1350;
  const card = document.createElement('canvas');
  card.width = W;
  card.height = H;
  const g = card.getContext('2d');
  g.fillStyle = '#07080b';
  g.fillRect(0, 0, W, H);
  g.drawImage(still, 0, 0, W, W);
  const fade = g.createLinearGradient(0, 820, 0, W);
  fade.addColorStop(0, 'rgba(7,8,11,0)');
  fade.addColorStop(1, 'rgba(7,8,11,1)');
  g.fillStyle = fade;
  g.fillRect(0, 820, W, W - 820);

  g.textBaseline = 'alphabetic';
  g.font = `400 44px ${display}`;
  g.fillStyle = 'rgba(238,241,247,0.9)';
  let x = 64;
  g.fillText('made', x, 104);
  x += g.measureText('made').width;
  g.font = `italic 400 44px ${display}`;
  g.fillStyle = songColor(dna.hue);
  g.fillText('by', x, 104);
  x += g.measureText('by').width;
  g.font = `400 44px ${display}`;
  g.fillStyle = 'rgba(238,241,247,0.9)';
  g.fillText('sound', x, 104);

  g.fillStyle = '#eef1f7';
  fitFont(g, title, display, 80, W - 128);
  g.fillText(title, 64, 1132);
  g.font = `400 24px ${mono}`;
  g.fillStyle = '#9aa1b2';
  g.fillText(`${meta}  ·  ${dna.label}`.toUpperCase(), 64, 1182);

  const env = dna.envelope;
  const left = 64;
  const width = W - 128;
  const base = 1290;
  const step = width / env.length;
  g.fillStyle = songColor(dna.hue);
  env.forEach((v, i) => {
    const h = 6 + v * 64;
    const bx = left + i * step + step * 0.2;
    g.globalAlpha = 0.35 + 0.65 * v;
    roundRect(g, bx, base - h, step * 0.6, h, Math.min(4, step * 0.3));
  });
  g.globalAlpha = 1;
  return card;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fill();
}

export function clipSupported() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

export async function recordClip(canvas, audioStream, seconds, onTick) {
  const stream = canvas.captureStream(30);
  audioStream?.getAudioTracks().forEach((t) => stream.addTrack(t));
  const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start(250);
  const started = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      const elapsed = (performance.now() - started) / 1000;
      onTick?.(Math.min(seconds, elapsed));
      if (elapsed >= seconds) resolve();
      else setTimeout(tick, 200);
    };
    tick();
  });
  recorder.stop();
  await stopped;
  // The audio track belongs to the shared player output, so only the video track is ended.
  stream.getVideoTracks().forEach((t) => t.stop());
  const type = recorder.mimeType || mimeType || 'video/webm';
  return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
}
