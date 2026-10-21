// Reads title, artist, album, genre and cover art from MP3 (ID3v2), M4A/MP4, FLAC and WAV files.
// Pure: takes an ArrayBuffer, returns plain values; cover art comes back as { mime, data }.

const latin1 = new TextDecoder('iso-8859-1');
const utf8 = new TextDecoder('utf-8');

const ascii = (b, p, n) => latin1.decode(b.subarray(p, p + n));
const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u32le = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const syncsafe = (b, p) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);

function clean(text) {
  const t = (text || '').split('\0')[0].trim();
  return t || undefined;
}

export function readTags(buffer) {
  const b = new Uint8Array(buffer);
  try {
    if (ascii(b, 0, 3) === 'ID3') return id3(b, 0);
    if (ascii(b, 4, 4) === 'ftyp') return mp4(b);
    if (ascii(b, 0, 4) === 'fLaC') return flac(b);
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return wav(b);
  } catch {
    // A damaged tag shouldn't stop the song from playing.
  }
  return {};
}

// ---------- ID3v2.2–2.4 ----------

function decodeText(bytes, encoding) {
  if (encoding === 0) return latin1.decode(bytes);
  if (encoding === 3) return utf8.decode(bytes);
  if (encoding === 1) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2));
    const body = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2) : bytes;
    return new TextDecoder('utf-16le').decode(body);
  }
  return utf16be(bytes);
}

function utf16be(bytes) {
  const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let i = 0; i < swapped.length; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  return new TextDecoder('utf-16le').decode(swapped);
}

// End of a NUL-terminated string in the given encoding (two-byte NUL for UTF-16).
function terminator(bytes, start, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return [i, i + 2];
  } else {
    for (let i = start; i < bytes.length; i++) if (bytes[i] === 0) return [i, i + 1];
  }
  return [bytes.length, bytes.length];
}

function removeUnsync(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return Uint8Array.from(out);
}

function id3(b, offset) {
  const major = b[offset + 3];
  const flags = b[offset + 5];
  const size = syncsafe(b, offset + 6);
  let tag = b.subarray(offset + 10, offset + 10 + size);
  if (flags & 0x80 && major < 4) tag = removeUnsync(tag);
  let p = 0;
  if (flags & 0x40 && major >= 3) p += major === 4 ? syncsafe(tag, 0) : u32(tag, 0) + 4;
  const out = {};
  const pictures = [];
  const headerSize = major === 2 ? 6 : 10;
  while (p + headerSize <= tag.length) {
    const id = ascii(tag, p, major === 2 ? 3 : 4);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const frameSize = major === 2 ? (tag[p + 3] << 16) | (tag[p + 4] << 8) | tag[p + 5] : major === 4 ? syncsafe(tag, p + 4) : u32(tag, p + 4);
    if (frameSize <= 0) break;
    let data = tag.subarray(p + headerSize, p + headerSize + frameSize);
    if (major === 4) {
      const format = tag[p + 9];
      if (format & 0x01) data = data.subarray(4);
      if (format & 0x02) data = removeUnsync(data);
    }
    p += headerSize + frameSize;
    const text = () => clean(decodeText(data.subarray(1), data[0]));
    switch (id) {
      case 'TIT2':
      case 'TT2':
        out.title = text();
        break;
      case 'TPE1':
      case 'TP1':
        out.artist = text();
        break;
      case 'TALB':
      case 'TAL':
        out.album = text();
        break;
      case 'TCON':
      case 'TCO':
        out.genre = genreName(text());
        break;
      case 'APIC':
      case 'PIC': {
        const enc = data[0];
        let q = 1;
        let mime;
        if (id === 'PIC') {
          mime = ascii(data, 1, 3).toUpperCase() === 'PNG' ? 'image/png' : 'image/jpeg';
          q = 4;
        } else {
          const [end, next] = terminator(data, 1, 0);
          mime = ascii(data, 1, end - 1).toLowerCase() || 'image/jpeg';
          if (!mime.includes('/')) mime = `image/${mime === 'png' ? 'png' : 'jpeg'}`;
          q = next;
        }
        const type = data[q];
        const [, after] = terminator(data, q + 1, enc);
        pictures.push({ type, mime, data: data.slice(after) });
        break;
      }
      default:
    }
  }
  const cover = pictures.find((pic) => pic.type === 3) || pictures[0];
  if (cover && cover.data.length) out.picture = { mime: cover.mime, data: cover.data };
  return out;
}

// ID3 genres can be "(17)", "17" or "(17)Rock"; numeric-only references are dropped.
function genreName(raw) {
  if (!raw) return undefined;
  const named = raw.replace(/^\(\d+\)/, '').trim();
  if (named && !/^\d+$/.test(named)) return named;
  return undefined;
}

// ---------- MP4 / M4A ----------

function* atoms(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = ascii(b, p + 4, 4);
    let header = 8;
    if (size === 1) {
      size = Number(new DataView(b.buffer, b.byteOffset + p + 8, 8).getBigUint64(0));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) return;
    yield { type, start: p + header, end: Math.min(end, p + size) };
    p += size;
  }
}

const child = (b, parent, type) => {
  for (const a of atoms(b, parent.start, parent.end)) if (a.type === type) return a;
  return null;
};

function mp4(b) {
  const root = { start: 0, end: b.length };
  const moov = child(b, root, 'moov');
  const udta = moov && child(b, moov, 'udta');
  const meta = udta && child(b, udta, 'meta');
  // meta is a full box: four bytes of version and flags before its children.
  const ilst = meta && child(b, { start: meta.start + 4, end: meta.end }, 'ilst');
  if (!ilst) return {};
  const out = {};
  for (const item of atoms(b, ilst.start, ilst.end)) {
    const data = child(b, item, 'data');
    if (!data) continue;
    const kind = u32(b, data.start) & 0xffffff;
    const payload = b.subarray(data.start + 8, data.end);
    const text = () => clean(utf8.decode(payload));
    if (item.type === '©nam') out.title = text();
    else if (item.type === '©ART') out.artist = text();
    else if (item.type === 'aART' && !out.artist) out.artist = text();
    else if (item.type === '©alb') out.album = text();
    else if (item.type === '©gen') out.genre = text();
    else if (item.type === 'covr' && payload.length) out.picture = { mime: kind === 14 ? 'image/png' : 'image/jpeg', data: payload.slice() };
  }
  return out;
}

// ---------- FLAC ----------

function flac(b) {
  const out = {};
  let p = 4;
  while (p + 4 <= b.length) {
    const header = b[p];
    const type = header & 0x7f;
    const len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    const block = b.subarray(p + 4, p + 4 + len);
    if (type === 4) Object.assign(out, vorbisComments(block));
    if (type === 6) {
      let q = 4;
      const mimeLen = u32(block, q);
      const mime = ascii(block, q + 4, mimeLen);
      q += 4 + mimeLen;
      q += 4 + u32(block, q);
      q += 16;
      const dataLen = u32(block, q);
      if (!out.picture || u32(block, 0) === 3) out.picture = { mime: mime || 'image/jpeg', data: block.slice(q + 4, q + 4 + dataLen) };
    }
    if (header & 0x80) break;
    p += 4 + len;
  }
  return out;
}

function vorbisComments(block) {
  const out = {};
  let q = 4 + u32le(block, 0);
  const count = u32le(block, q);
  q += 4;
  for (let i = 0; i < count && q + 4 <= block.length; i++) {
    const len = u32le(block, q);
    const entry = utf8.decode(block.subarray(q + 4, q + 4 + len));
    q += 4 + len;
    const eq = entry.indexOf('=');
    const key = entry.slice(0, eq).toUpperCase();
    const value = clean(entry.slice(eq + 1));
    if (key === 'TITLE') out.title = value;
    else if (key === 'ARTIST') out.artist = value;
    else if (key === 'ALBUM') out.album = value;
    else if (key === 'GENRE') out.genre = value;
  }
  return out;
}

// ---------- WAV ----------

function wav(b) {
  const out = {};
  let p = 12;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    const body = p + 8;
    if (id === 'LIST' && ascii(b, body, 4) === 'INFO') {
      let q = body + 4;
      while (q + 8 <= body + size) {
        const sub = ascii(b, q, 4);
        const subSize = u32le(b, q + 4);
        const value = clean(latin1.decode(b.subarray(q + 8, q + 8 + subSize)));
        if (sub === 'INAM') out.title = value;
        else if (sub === 'IART') out.artist = value;
        else if (sub === 'IPRD') out.album = value;
        else if (sub === 'IGNR') out.genre = value;
        q += 8 + subSize + (subSize % 2);
      }
    } else if ((id === 'id3 ' || id === 'ID3 ') && ascii(b, body, 3) === 'ID3') {
      Object.assign(out, id3(b, body));
    }
    p = body + size + (size % 2);
  }
  return out;
}
