import test from 'node:test';
import assert from 'node:assert/strict';
import { readTags } from '../js/tags.js';

const enc = new TextEncoder();
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const be32 = (n) => Uint8Array.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
const le32 = (n) => Uint8Array.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]);
const syncsafe = (n) => Uint8Array.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const latin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf16 = (s) => {
  const out = [0xff, 0xfe];
  for (const c of s) out.push(c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8);
  return Uint8Array.from(out);
};

function id3Frame(id, body, major) {
  return concat(latin(id), major === 4 ? syncsafe(body.length) : be32(body.length), Uint8Array.of(0, 0), body);
}

function id3(major, frames) {
  const body = concat(...frames, new Uint8Array(32));
  return concat(latin('ID3'), Uint8Array.of(major, 0, 0), syncsafe(body.length), body, new Uint8Array(64).fill(0xff));
}

test('reads ID3v2.3 text in UTF-16 and Latin-1, and the front cover', () => {
  const file = id3(3, [
    id3Frame('TIT2', concat(Uint8Array.of(1), utf16('Sunrise Arpeggio')), 3),
    id3Frame('TPE1', concat(Uint8Array.of(0), latin('Café Nights')), 3),
    id3Frame('TCON', concat(Uint8Array.of(0), latin('(13)')), 3),
    id3Frame('APIC', concat(Uint8Array.of(0), latin('image/png\0'), Uint8Array.of(4), latin('back\0'), PNG), 3),
    id3Frame('APIC', concat(Uint8Array.of(0), latin('image/jpeg\0'), Uint8Array.of(3), latin('front\0'), JPEG), 3),
  ]);
  const tags = readTags(file.buffer);
  assert.equal(tags.title, 'Sunrise Arpeggio');
  assert.equal(tags.artist, 'Café Nights');
  assert.equal(tags.genre, undefined, 'numeric-only genre codes are dropped');
  assert.equal(tags.picture.mime, 'image/jpeg');
  assert.deepEqual(tags.picture.data, JPEG);
});

test('reads ID3v2.4 UTF-8 frames with syncsafe sizes', () => {
  const file = id3(4, [
    id3Frame('TIT2', concat(Uint8Array.of(3), enc.encode('Ünïcode Sōng')), 4),
    id3Frame('TALB', concat(Uint8Array.of(3), enc.encode('Album')), 4),
    id3Frame('TCON', concat(Uint8Array.of(3), enc.encode('Electronic')), 4),
  ]);
  assert.deepEqual(readTags(file.buffer), { title: 'Ünïcode Sōng', album: 'Album', genre: 'Electronic' });
});

function atom(type, ...children) {
  const body = concat(...children);
  return concat(be32(body.length + 8), latin(type), body);
}
const dataAtom = (kind, payload) => atom('data', be32(kind), be32(0), payload);

test('reads M4A metadata even when moov comes after mdat', () => {
  const ilst = atom(
    'ilst',
    atom('©nam', dataAtom(1, enc.encode('Night Drive'))),
    atom('©ART', dataAtom(1, enc.encode('madebysound'))),
    atom('©gen', dataAtom(1, enc.encode('Synthwave'))),
    atom('covr', dataAtom(13, JPEG)),
  );
  const meta = atom('meta', be32(0), atom('hdlr', new Uint8Array(25)), ilst);
  const file = concat(atom('ftyp', latin('M4A '), be32(0)), atom('mdat', new Uint8Array(1000)), atom('moov', atom('mvhd', new Uint8Array(100)), atom('udta', meta)));
  const tags = readTags(file.buffer);
  assert.equal(tags.title, 'Night Drive');
  assert.equal(tags.artist, 'madebysound');
  assert.equal(tags.genre, 'Synthwave');
  assert.equal(tags.picture.mime, 'image/jpeg');
  assert.deepEqual(tags.picture.data, JPEG);
});

test('reads FLAC Vorbis comments and picture', () => {
  const comment = (s) => concat(le32(enc.encode(s).length), enc.encode(s));
  const vorbis = concat(comment('ref'), le32(3), comment('TITLE=Glass Lullaby'), comment('artist=Demo'), comment('GENRE=Ambient'));
  const pic = concat(be32(3), be32(9), latin('image/png'), be32(0), be32(1), be32(1), be32(24), be32(0), be32(PNG.length), PNG);
  const block = (type, body, last) => concat(Uint8Array.of(type | (last ? 0x80 : 0), body.length >> 16, (body.length >> 8) & 255, body.length & 255), body);
  const file = concat(latin('fLaC'), block(0, new Uint8Array(34)), block(4, vorbis), block(6, pic, true));
  const tags = readTags(file.buffer);
  assert.deepEqual([tags.title, tags.artist, tags.genre], ['Glass Lullaby', 'Demo', 'Ambient']);
  assert.equal(tags.picture.mime, 'image/png');
  assert.deepEqual(tags.picture.data, PNG);
});

test('reads WAV LIST INFO', () => {
  const sub = (id, s) => {
    const v = concat(latin(s), Uint8Array.of(0));
    return concat(latin(id), le32(v.length), v, v.length % 2 ? Uint8Array.of(0) : new Uint8Array(0));
  };
  const info = concat(latin('INFO'), sub('INAM', 'Field Recording'), sub('IART', 'Me'));
  const fmt = concat(latin('fmt '), le32(16), new Uint8Array(16));
  const list = concat(latin('LIST'), le32(info.length), info);
  const body = concat(latin('WAVE'), fmt, list, latin('data'), le32(4), new Uint8Array(4));
  const file = concat(latin('RIFF'), le32(body.length), body);
  assert.deepEqual(readTags(file.buffer), { title: 'Field Recording', artist: 'Me' });
});

test('ignores unknown or damaged files', () => {
  assert.deepEqual(readTags(new Uint8Array(10).buffer), {});
  const broken = concat(latin('ID3'), Uint8Array.of(3, 0, 0), syncsafe(5000), latin('TIT2'), be32(999999));
  assert.doesNotThrow(() => readTags(broken.buffer));
});
