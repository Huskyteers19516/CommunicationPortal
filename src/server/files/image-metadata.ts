// Takes the hidden metadata out of a PNG, JPG, or WebP picture before it's published (sponsor logos are public on the
// team website): Exif (GPS position, camera and phone model, the date, a thumbnail), XMP and IPTC (author, software,
// editing history, content credentials), and comments. Works on the file's structure only — the picture is never
// decoded or re-encoded, so it looks exactly the same, keeps its colour profile, and keeps its rotation (a JPEG or
// PNG's Exif orientation is kept as a tiny Exif block with nothing else in it). Anything after the picture's end
// (e.g. a phone's extra pictures appended to a JPEG) is dropped too. Never throws: whatever it can't read is left out.

export type MetadataImageKind = "png" | "jpg" | "webp";

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function startsWith(b: Uint8Array, prefix: number[], offset = 0): boolean {
  if (b.length < offset + prefix.length) return false;
  return prefix.every((v, i) => b[offset + i] === v);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

// ── Exif orientation (all that's kept of Exif) ───────────────────────────────

/** The orientation (1–8) in a TIFF/Exif block ("II*\0" or "MM\0*"), or null. */
export function exifOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return null;
  const u16 = (i: number) => (i + 2 <= tiff.length ? (little ? tiff[i] | (tiff[i + 1] << 8) : u16be(tiff, i)) : -1);
  const u32 = (i: number) => (i + 4 <= tiff.length ? (little ? u32le(tiff, i) : u32be(tiff, i)) : -1);
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  const count = u16(ifd);
  if (ifd < 8 || count < 0) return null;
  for (let k = 0; k < count && k < 500; k++) {
    const e = ifd + 2 + 12 * k;
    if (e + 12 > tiff.length) return null;
    // Tag 0x0112 (Orientation), type SHORT, at least one value.
    if (u16(e) === 0x0112 && u16(e + 2) === 3 && u32(e + 4) >= 1) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** A TIFF block holding only an orientation (big-endian, one entry). */
function orientationTiff(orientation: number): Uint8Array {
  return Uint8Array.from([
    ...ascii("MM"), 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // header, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation = SHORT ×1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

const EXIF_ID = [...ascii("Exif"), 0, 0];
const ICC_ID = [...ascii("ICC_PROFILE"), 0];

/**
 * Which header segments a published JPEG keeps: APP0 (JFIF), APP2 only for the ICC colour profile, APP14 (Adobe:
 * how the colours are stored), and everything the picture needs (tables, frame, scans). Dropped: APP1 (Exif, XMP),
 * APP2's other uses (MPF: extra pictures), APP3–APP13 and APP15 (IPTC, Photoshop, vendor data, content credentials),
 * and comments (COM).
 */
function keepJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xe1 || marker === 0xfe) return false;
  if (marker === 0xe2) return startsWith(payload, ICC_ID);
  if (marker >= 0xe3 && marker <= 0xef) return marker === 0xee;
  return true;
}

function stripJpeg(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  /** Where the orientation-only Exif block goes: after SOI and JFIF (APP0). */
  let exifAt = 1;
  let orientation: number | null = null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i++; // stray bytes between segments (decoders skip them too)
      continue;
    }
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) break;
    const marker = b[i++];
    if (marker === 0x00) continue;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(Uint8Array.of(0xff, marker));
      continue;
    }
    if (marker === 0xd9) {
      parts.push(Uint8Array.of(0xff, 0xd9)); // the end: anything after it is dropped
      break;
    }
    if (i + 2 > b.length) break;
    const length = u16be(b, i);
    if (length < 2) break;
    const end = Math.min(b.length, i + length);
    const payload = b.subarray(i + 2, end);
    if (marker === 0xe1 && startsWith(payload, EXIF_ID) && orientation === null) orientation = exifOrientation(payload.subarray(6));
    if (keepJpegSegment(marker, payload)) {
      parts.push(Uint8Array.of(0xff, marker), b.subarray(i, end));
      if (marker === 0xe0 && exifAt === parts.length - 2) exifAt = parts.length;
    }
    i = end;
    if (marker === 0xda) {
      // The scan's coded data runs to the next marker that isn't a stuffed 0xFF00, a restart, or fill.
      let k = i;
      while (k < b.length) {
        if (b[k] !== 0xff) {
          k++;
          continue;
        }
        const next = b[k + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) k += 2;
        else if (next === 0xff) k += 1;
        else break;
      }
      parts.push(b.subarray(i, Math.min(k, b.length)));
      i = k;
    }
  }
  if (orientation !== null && orientation !== 1) {
    const tiff = orientationTiff(orientation);
    const length = 2 + EXIF_ID.length + tiff.length;
    parts.splice(exifAt, 0, Uint8Array.of(0xff, 0xe1, length >> 8, length & 0xff, ...EXIF_ID), tiff);
  }
  return concat(parts);
}

// ── PNG ──────────────────────────────────────────────────────────────────────

/**
 * The chunks a PNG keeps: the picture, its colours, and animation (APNG). Everything else goes — text (author,
 * software, comments, XMP), the time it was saved, signatures, content credentials (caBX), and any private chunk an
 * app adds — so nothing unknown can carry metadata out. eXIf is rebuilt with only the orientation.
 */
const PNG_KEEP_CHUNKS: ReadonlySet<string> = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "cICP", "mDCV", "cLLI", "sBIT", "bKGD", "pHYs",
  "hIST", "sPLT", "acTL", "fcTL", "fdAT",
]);

let crcTable: Uint32Array | null = null;
function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = crcTable[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const t = Uint8Array.from(ascii(type));
  const crc = crc32([t, data]);
  const n = data.length;
  return concat([
    Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255),
    t,
    data,
    Uint8Array.of((crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255),
  ]);
}

function stripPng(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= b.length) {
    const length = u32be(b, i);
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const end = i + 12 + length;
    if (end > b.length) {
      // Cut short: keep what's there of a picture chunk, nothing of anything else.
      if (PNG_KEEP_CHUNKS.has(type)) parts.push(b.subarray(i));
      break;
    }
    if (type === "eXIf") {
      const orientation = exifOrientation(b.subarray(i + 8, i + 8 + length));
      if (orientation !== null && orientation !== 1) parts.push(pngChunk("eXIf", orientationTiff(orientation)));
    } else if (PNG_KEEP_CHUNKS.has(type)) {
      parts.push(b.subarray(i, end));
    }
    i = end;
    if (type === "IEND") break; // anything after the end is dropped
  }
  return concat(parts);
}

// ── WebP ─────────────────────────────────────────────────────────────────────

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
/**
 * The chunks a WebP keeps: the picture (lossy, lossless, alpha), animation, and the colour profile. EXIF and XMP go,
 * and so does anything else (content credentials in a C2PA chunk, private chunks), so nothing unknown carries metadata
 * out. A WebP's Exif orientation isn't kept (browsers draw WebPs as stored).
 */
const WEBP_KEEP_CHUNKS: ReadonlySet<string> = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);

function stripWebp(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  const parts: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= riffEnd) {
    const fourcc = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    const size = u32le(b, i + 4);
    const end = Math.min(riffEnd, i + 8 + size + (size & 1));
    if (WEBP_KEEP_CHUNKS.has(fourcc)) {
      const chunk = b.slice(i, end);
      if (fourcc === "VP8X" && chunk.length > 8) chunk[8] &= ~(VP8X_EXIF | VP8X_XMP);
      parts.push(chunk);
    }
    i = end;
  }
  const body = concat(parts);
  const size = 4 + body.length;
  return concat([
    Uint8Array.from(ascii("RIFF")),
    Uint8Array.of(size & 255, (size >>> 8) & 255, (size >>> 16) & 255, (size >>> 24) & 255),
    Uint8Array.from(ascii("WEBP")),
    body,
  ]);
}

/**
 * The picture without its metadata (see the top of this file). `kind` is what the file really is (sniffed from its
 * bytes). A file that doesn't start the way its kind does comes back unchanged.
 */
export function stripImageMetadata(bytes: Uint8Array, kind: MetadataImageKind): Uint8Array<ArrayBuffer> {
  switch (kind) {
    case "jpg":
      if (startsWith(bytes, [0xff, 0xd8])) return stripJpeg(bytes);
      break;
    case "png":
      if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return stripPng(bytes);
      break;
    case "webp":
      if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return stripWebp(bytes);
      break;
  }
  return Uint8Array.from(bytes);
}

/**
 * The picture's Exif orientation (1–8; 1 = as stored), read from the file before or after stripImageMetadata (which
 * keeps it for JPEG and PNG, not WebP): a JPEG's first Exif APP1 block, a PNG's eXIf chunk, a WebP's EXIF chunk. 1 when
 * there's none or it can't be read. Orientations 5–8 mean the picture is shown turned a quarter: its width and height swap on screen.
 */
export function imageOrientation(b: Uint8Array, kind: MetadataImageKind): number {
  if (kind === "jpg") {
    if (!startsWith(b, [0xff, 0xd8])) return 1;
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xff) {
      const marker = b[i + 1];
      if (marker === 0xda || marker === 0xd9) break; // the picture's data starts: no more metadata blocks
      const length = u16be(b, i + 2);
      if (length < 2) break;
      const payload = b.subarray(i + 4, i + 2 + length);
      if (marker === 0xe1 && startsWith(payload, EXIF_ID)) return exifOrientation(payload.subarray(6)) ?? 1;
      i += 2 + length;
    }
    return 1;
  }
  if (kind === "png") {
    let i = 8;
    while (i + 12 <= b.length) {
      const length = u32be(b, i);
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      if (type === "eXIf") return exifOrientation(b.subarray(i + 8, i + 8 + length)) ?? 1;
      if (type === "IDAT" || type === "IEND") break;
      i += 12 + length;
    }
    return 1;
  }
  let i = 12;
  while (i + 8 <= b.length) {
    const size = u32le(b, i + 4);
    if (String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]) === "EXIF") {
      const exif = b.subarray(i + 8, i + 8 + size);
      return exifOrientation(startsWith(exif, EXIF_ID) ? exif.subarray(6) : exif) ?? 1;
    }
    i += 8 + size + (size & 1);
  }
  return 1;
}
