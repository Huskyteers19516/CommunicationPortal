// Taking the metadata out of public pictures (src/server/files/image-metadata.ts — sponsor logos on the team website):
// Exif (GPS, phone model, author), XMP, IPTC, comments, PNG text chunks, and WebP EXIF/XMP chunks go; the picture's
// own data (tables, frames, scans, colour profile) stays byte for byte; a JPEG / PNG's orientation is kept on its own.
// Strict mode (members' photos) also drops colour profiles, JFIF thumbnails, Adobe extras, and every PNG / WebP chunk
// the picture doesn't need; isAnimatedImage and jpegMarkersDrawable say what an avatar can't be.
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { exifOrientation, imageOrientation, isAnimatedImage, jpegMarkersDrawable, stripImageMetadata } from "@/server/files/image-metadata";
import { posterImageSize, sniffPosterFile } from "@/server/services/posters";

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

const SECRETS = ["Amara", "GPS", "iPhone", "xmpmeta", "Photoshop", "Comment", "MPF", "2026:09:24", "Created with"];

/** A little-endian TIFF block: Orientation, then an Artist string with a GPS note in it. */
function exifTiff(orientation: number): number[] {
  const note = ascii("GPSLatitude=33.8366;Artist=Amara Okafor;Model=iPhone 15;DateTime=2026:09:24\0");
  const le16 = (n: number) => [n & 255, (n >> 8) & 255];
  const dataAt = 8 + 2 + 2 * 12 + 4;
  return [
    ...ascii("II"), 42, 0, ...u32le(8),
    ...le16(2),
    ...le16(0x0112), ...le16(3), ...u32le(1), ...le16(orientation), 0, 0,
    ...le16(0x013b), ...le16(2), ...u32le(note.length), ...u32le(dataAt),
    ...u32le(0),
    ...note,
  ];
}

const segment = (marker: number, payload: number[]) => [0xff, marker, ...u16(payload.length + 2), ...payload];

/** A baseline-looking JPEG with every kind of metadata, a scan with stuffed bytes and a restart, and data after its end. */
function metadataJpeg(orientation = 6) {
  const scan = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a];
  const kept = {
    app0: segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    icc: segment(0xe2, [...ascii("ICC_PROFILE"), 0, 1, 1, ...ascii("fake-profile")]),
    adobe: segment(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1]),
    dqt: segment(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => i + 1)]),
    sof: segment(0xc0, [8, ...u16(100), ...u16(300), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    dht: segment(0xc4, [0, 1, 2, 3]),
    sos: segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
  };
  const file = bytes(
    [0xff, 0xd8],
    kept.app0,
    segment(0xe1, [...ascii("Exif"), 0, 0, ...exifTiff(orientation)]),
    segment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii("<x:xmpmeta>Creator: Amara Okafor</x:xmpmeta>")]),
    kept.icc,
    segment(0xe2, [...ascii("MPF"), 0, ...ascii("MPF index of the extra pictures")]),
    segment(0xed, [...ascii("Photoshop 3.0"), 0, ...ascii("IPTC byline Amara Okafor")]),
    segment(0xfe, ascii("Comment: Created with an iPhone by Amara")),
    kept.adobe,
    kept.dqt,
    kept.sof,
    kept.dht,
    kept.sos,
    scan,
    [0xff, 0xd9],
    ascii("MPF second picture: Exif Amara Okafor GPS"),
  );
  return { file, kept, scan };
}

describe("JPEG", () => {
  it("drops Exif, XMP, IPTC, comments, extra pictures, and anything after the end; keeps the picture byte for byte", () => {
    const { file, kept, scan } = metadataJpeg(1);
    const out = stripImageMetadata(file, "jpg");
    for (const secret of SECRETS) expect(text(out), secret).not.toContain(secret);
    // Orientation 1 is the default: no Exif at all.
    expect(out).toEqual(bytes([0xff, 0xd8], kept.app0, kept.icc, kept.adobe, kept.dqt, kept.sof, kept.dht, kept.sos, scan, [0xff, 0xd9]));
    expect(sniffPosterFile(out)).toBe("jpg");
    expect(posterImageSize(out, "jpg")).toEqual({ width: 300, height: 100 });
  });

  it("keeps a rotated photo's orientation, in an Exif block with nothing else in it, right after JFIF", () => {
    const { file, kept } = metadataJpeg(6);
    const out = stripImageMetadata(file, "jpg");
    for (const secret of SECRETS) expect(text(out), secret).not.toContain(secret);
    const app1 = 2 + kept.app0.length;
    expect([out[app1], out[app1 + 1]]).toEqual([0xff, 0xe1]);
    const length = (out[app1 + 2] << 8) | out[app1 + 3];
    expect(length).toBe(34);
    const payload = out.subarray(app1 + 4, app1 + 2 + length);
    expect(text(payload.subarray(0, 6))).toBe("Exif\0\0");
    expect(exifOrientation(payload.subarray(6))).toBe(6);
    expect(exifOrientation(Uint8Array.from(exifTiff(8)))).toBe(8);
    expect(posterImageSize(out, "jpg")).toEqual({ width: 300, height: 100 });
  });

  it("copies every scan of a progressive picture, with the tables between them", () => {
    const sof2 = segment(0xc2, [8, ...u16(10), ...u16(20), 1, 1, 0x11, 0]);
    const sos = segment(0xda, [1, 1, 0, 0, 0x3f, 0]);
    const dht = segment(0xc4, [0x10, 5, 6]);
    const file = bytes([0xff, 0xd8], sof2, sos, [1, 2, 0xff, 0x00, 3], dht, segment(0xfe, ascii("Comment")), sos, [4, 0xff, 0xd7, 5], [0xff, 0xd9]);
    expect(stripImageMetadata(file, "jpg")).toEqual(bytes([0xff, 0xd8], sof2, sos, [1, 2, 0xff, 0x00, 3], dht, sos, [4, 0xff, 0xd7, 5], [0xff, 0xd9]));
  });

  it("never throws on a damaged file, and never keeps metadata from it", () => {
    const { file } = metadataJpeg(6);
    for (let cut = 2; cut < file.length; cut += 7) {
      const out = stripImageMetadata(file.subarray(0, cut), "jpg");
      expect(text(out)).not.toContain("Amara");
    }
    expect(stripImageMetadata(Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01), "jpg")).toEqual(Uint8Array.of(0xff, 0xd8));
  });
});

// ── PNG ───────────────────────────────────────────────────────────────────────

function chunk(type: string, data: number[]): number[] {
  const body = Buffer.from([...ascii(type), ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

function chunksOf(b: Uint8Array): { type: string; data: Uint8Array; crcOk: boolean }[] {
  const out = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = Buffer.from(b.subarray(i, i + 4)).readUInt32BE(0);
    const type = text(b.subarray(i + 4, i + 8));
    const data = b.subarray(i + 8, i + 8 + length);
    const crc = Buffer.from(b.subarray(i + 8 + length, i + 12 + length)).readUInt32BE(0);
    out.push({ type, data, crcOk: crc === crc32(Buffer.from(b.subarray(i + 4, i + 8 + length))) });
    i += 12 + length;
  }
  return out;
}

describe("PNG", () => {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = chunk("IHDR", [...u32(64), ...u32(28), 8, 6, 0, 0, 0]);
  const iccp = chunk("iCCP", [...ascii("sRGB"), 0, 0, 1, 2, 3]);
  const idat = chunk("IDAT", [0x78, 0x9c, 1, 2, 3, 4]);
  const iend = chunk("IEND", []);
  const png = (orientation: number) =>
    bytes(
      SIGNATURE,
      ihdr,
      iccp,
      chunk("tEXt", [...ascii("Author"), 0, ...ascii("Amara Okafor")]),
      chunk("zTXt", [...ascii("Comment"), 0, 0, 1, 2]),
      chunk("iTXt", [...ascii("XML:com.adobe.xmp"), 0, 0, 0, 0, 0, ...ascii("<x:xmpmeta>GPS</x:xmpmeta>")]),
      chunk("eXIf", exifTiff(orientation)),
      chunk("tIME", [0x07, 0xea, 9, 24, 12, 0, 0]),
      idat,
      iend,
      ascii("trailing: Amara's iPhone"),
    );

  it("drops private and unknown chunks too (only the picture's own chunks are kept)", () => {
    const file = bytes(SIGNATURE, ihdr, chunk("prVt", ascii("Amara GPS")), chunk("caBX", ascii("Created with")), idat, iend);
    const out = stripImageMetadata(file, "png");
    for (const secret of SECRETS) expect(text(out), secret).not.toContain(secret);
    expect(out).toEqual(bytes(SIGNATURE, ihdr, idat, iend));
  });

  it("drops text, XMP, Exif, and time chunks and anything after IEND; keeps the picture's chunks as they were", () => {
    const out = stripImageMetadata(png(1), "png");
    for (const secret of SECRETS) expect(text(out), secret).not.toContain(secret);
    expect(out).toEqual(bytes(SIGNATURE, ihdr, iccp, idat, iend));
    expect(posterImageSize(out, "png")).toEqual({ width: 64, height: 28 });
  });

  it("keeps a rotated picture's orientation as an eXIf chunk with nothing else in it", () => {
    const out = stripImageMetadata(png(6), "png");
    for (const secret of SECRETS) expect(text(out), secret).not.toContain(secret);
    const chunks = chunksOf(out);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "iCCP", "eXIf", "IDAT", "IEND"]);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    expect(exifOrientation(chunks[2].data)).toBe(6);
    expect(chunks[2].data.length).toBe(26);
  });
});

// ── WebP ──────────────────────────────────────────────────────────────────────

describe("WebP", () => {
  const riffChunk = (fourcc: string, data: number[]) => [...ascii(fourcc), ...u32le(data.length), ...data, ...(data.length % 2 ? [0] : [])];
  const vp8x = (flags: number) => riffChunk("VP8X", [flags, 0, 0, 0, 49, 0, 0, 19, 0, 0]);
  const iccp = riffChunk("ICCP", [1, 2, 3, 4]);
  const vp8l = riffChunk("VP8L", [0x2f, 0x31, 0xc0, 0x04, 0x00, 7, 8]); // odd: padded
  const riff = (...chunks: number[][]) => {
    const body = chunks.flat();
    return [...ascii("RIFF"), ...u32le(4 + body.length), ...ascii("WEBP"), ...body];
  };

  it("drops the EXIF and XMP chunks, clears their flags, and fixes the RIFF size", () => {
    const file = bytes(
      riff(vp8x(0x20 | 0x10 | 0x08 | 0x04), iccp, vp8l, riffChunk("EXIF", exifTiff(6)), riffChunk("XMP ", ascii("<x:xmpmeta>Amara GPS</x:xmpmeta>"))),
      ascii("trailing Amara"),
    );
    const out = stripImageMetadata(file, "webp");
    for (const secret of SECRETS) expect(text(out), secret).not.toContain(secret);
    expect(out).toEqual(bytes(riff(vp8x(0x20 | 0x10), iccp, vp8l)));
    expect(Buffer.from(out.subarray(4, 8)).readUInt32LE(0)).toBe(out.length - 8);
    expect(sniffPosterFile(out)).toBe("webp");
    expect(posterImageSize(out, "webp")).toEqual({ width: 50, height: 20 });
  });

  it("leaves a simple WebP (no metadata possible) as it was", () => {
    const file = bytes(riff(vp8l));
    expect(stripImageMetadata(file, "webp")).toEqual(file);
  });

  it("drops content credentials (C2PA) and any chunk it doesn't know", () => {
    const file = bytes(riff(vp8x(0x20), iccp, vp8l, riffChunk("C2PA", ascii("creator=Amara GPS 33.8")), riffChunk("ZZZZ", ascii("Amara"))));
    const out = stripImageMetadata(file, "webp");
    for (const secret of SECRETS) expect(text(out), secret).not.toContain(secret);
    expect(out).toEqual(bytes(riff(vp8x(0x20), iccp, vp8l)));
  });
});

it("returns a file that isn't what it says unchanged", () => {
  const notJpeg = Uint8Array.from(ascii("hello"));
  expect(stripImageMetadata(notJpeg, "jpg")).toEqual(notJpeg);
  expect(stripImageMetadata(notJpeg, "png")).toEqual(notJpeg);
  expect(stripImageMetadata(notJpeg, "webp")).toEqual(notJpeg);
});

describe("imageOrientation", () => {
  it("reads the orientation a JPEG or PNG keeps after stripping, and 1 when there's none", () => {
    expect(imageOrientation(stripImageMetadata(metadataJpeg(6).file, "jpg"), "jpg")).toBe(6);
    expect(imageOrientation(metadataJpeg(8).file, "jpg")).toBe(8); // before stripping too
    expect(imageOrientation(stripImageMetadata(metadataJpeg(1).file, "jpg"), "jpg")).toBe(1);
    expect(imageOrientation(Uint8Array.from(ascii("hello")), "jpg")).toBe(1);
    expect(imageOrientation(Uint8Array.from(ascii("hello")), "png")).toBe(1);
    expect(imageOrientation(Uint8Array.from(ascii("hello")), "webp")).toBe(1);
  });
});

// ── Strict mode (members' photos) ─────────────────────────────────────────────

describe("strict mode", () => {
  it("JPEG: no colour profile, a bare JFIF header (no thumbnail), a bare Adobe header; orientation and the picture kept", () => {
    const { kept, scan } = metadataJpeg(6);
    const file = bytes(
      [0xff, 0xd8],
      segment(0xe0, [...ascii("JFIF"), 0, 1, 2, 1, 0, 72, 0, 72, 2, 1, ...ascii("SECRET-APP0-THUMB-DATA")]),
      segment(0xe0, [...ascii("JFXX"), 0, 0x10, ...ascii("SECRET-JFXX")]),
      segment(0xe1, [...ascii("Exif"), 0, 0, ...exifTiff(6)]),
      segment(0xe2, [...ascii("ICC_PROFILE"), 0, 1, 1, ...ascii("SECRET-ICC-TEXT owner Maya's phone")]),
      segment(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1, ...ascii("SECRET-ADOBE")]),
      kept.dqt,
      kept.sof,
      kept.dht,
      kept.sos,
      scan,
      [0xff, 0xd9],
    );
    const out = stripImageMetadata(file, "jpg", { strict: true });
    for (const secret of [...SECRETS, "SECRET", "ICC_PROFILE", "JFXX"]) expect(text(out), secret).not.toContain(secret);
    const orientationOnly = stripImageMetadata(metadataJpeg(6).file, "jpg").subarray(2 + kept.app0.length);
    const exif = orientationOnly.subarray(0, 4 + ((orientationOnly[2] << 8) | orientationOnly[3]) - 2);
    expect(out).toEqual(
      bytes(
        [0xff, 0xd8],
        segment(0xe0, [...ascii("JFIF"), 0, 1, 2, 1, 0, 72, 0, 72, 0, 0]),
        exif,
        segment(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1]),
        kept.dqt,
        kept.sof,
        kept.dht,
        kept.sos,
        scan,
        [0xff, 0xd9],
      ),
    );
    expect(imageOrientation(out, "jpg")).toBe(6);
    expect(posterImageSize(out, "jpg")).toEqual({ width: 300, height: 100 });
    // Without strict, the profile stays (sponsor logos, Workshop photos: colours exactly as uploaded).
    expect(text(stripImageMetadata(file, "jpg"))).toContain("ICC_PROFILE");
  });

  it("PNG: only the chunks that draw the picture (no iCCP, sPLT, hIST, bKGD, animation)", () => {
    const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = chunk("IHDR", [...u32(64), ...u32(28), 8, 6, 0, 0, 0]);
    const srgb = chunk("sRGB", [0]);
    const idat = chunk("IDAT", [0x78, 0x9c, 1, 2, 3, 4]);
    const iend = chunk("IEND", []);
    const file = bytes(
      SIGNATURE,
      ihdr,
      chunk("iCCP", [...ascii("SECRET-ICC-NAME"), 0, 0, 1, 2, 3]),
      srgb,
      chunk("sPLT", [...ascii("SECRET-SPLT-NAME Maya"), 0, 8, 1, 2, 3, 4, 0, 1]),
      chunk("hIST", [0, 1]),
      chunk("bKGD", [0, 0, 0, 0, 0, 0]),
      chunk("acTL", [...u32(1), ...u32(0)]),
      idat,
      iend,
    );
    const out = stripImageMetadata(file, "png", { strict: true });
    expect(text(out)).not.toContain("SECRET");
    expect(out).toEqual(bytes(SIGNATURE, ihdr, srgb, idat, iend));
    expect(text(stripImageMetadata(file, "png"))).toContain("SECRET-SPLT-NAME"); // not strict: kept, as before
  });

  it("WebP: no ICCP or animation chunks, and their flags cleared", () => {
    const le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    const riffChunk = (fourcc: string, data: number[]) => [...ascii(fourcc), ...le(data.length), ...data, ...(data.length % 2 ? [0] : [])];
    const vp8x = (flags: number) => riffChunk("VP8X", [flags, 0, 0, 0, 49, 0, 0, 19, 0, 0]);
    const vp8l = riffChunk("VP8L", [0x2f, 0x31, 0xc0, 0x04, 0x00, 7, 8]);
    const riff = (...chunks: number[][]) => {
      const body = chunks.flat();
      return [...ascii("RIFF"), ...le(4 + body.length), ...ascii("WEBP"), ...body];
    };
    const file = bytes(riff(vp8x(0x20 | 0x10 | 0x02), riffChunk("ICCP", ascii("SECRET")), riffChunk("ANIM", [0, 0, 0, 0, 0, 0]), vp8l));
    expect(stripImageMetadata(file, "webp", { strict: true })).toEqual(bytes(riff(vp8x(0x10), vp8l)));
  });

  it("says when a PNG or WebP is an animation", () => {
    const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = chunk("IHDR", [...u32(64), ...u32(28), 8, 6, 0, 0, 0]);
    const idat = chunk("IDAT", [0x78, 0x9c, 1, 2, 3, 4]);
    const iend = chunk("IEND", []);
    expect(isAnimatedImage(bytes(SIGNATURE, ihdr, idat, iend), "png")).toBe(false);
    expect(isAnimatedImage(bytes(SIGNATURE, ihdr, chunk("acTL", [...u32(2), ...u32(0)]), idat, iend), "png")).toBe(true);
    expect(isAnimatedImage(bytes(SIGNATURE, ihdr, idat, chunk("fdAT", [0, 0, 0, 1]), iend), "png")).toBe(true);
    const le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    const riff = (...chunks: number[][]) => {
      const body = chunks.flat();
      return bytes([...ascii("RIFF"), ...le(4 + body.length), ...ascii("WEBP"), ...body]);
    };
    const vp8x = (flags: number) => [...ascii("VP8X"), ...le(10), flags, 0, 0, 0, 49, 0, 0, 19, 0, 0];
    expect(isAnimatedImage(riff(vp8x(0)), "webp")).toBe(false);
    expect(isAnimatedImage(riff(vp8x(0x02)), "webp")).toBe(true);
    expect(isAnimatedImage(riff(vp8x(0), [...ascii("ANMF"), ...le(2), 0, 0]), "webp")).toBe(true);
    expect(isAnimatedImage(metadataJpeg(1).file, "jpg")).toBe(false);
  });

  it("says whether every marker in a JPEG is one browsers draw", () => {
    const { file, kept, scan } = metadataJpeg(1);
    expect(jpegMarkersDrawable(file)).toBe(true);
    expect(jpegMarkersDrawable(stripImageMetadata(file, "jpg", { strict: true }))).toBe(true);
    const withMarker = (marker: number) => bytes([0xff, 0xd8], segment(marker, [1, 2]), kept.dqt, kept.sof, kept.dht, kept.sos, scan, [0xff, 0xd9]);
    for (const marker of [0xf0, 0xf7, 0xfd, 0xc8, 0xdc, 0xde, 0xdf, 0x02, 0xbf]) expect(jpegMarkersDrawable(withMarker(marker)), marker.toString(16)).toBe(false);
    for (const marker of [0xdd, 0xfe, 0xe5, 0xcc]) expect(jpegMarkersDrawable(withMarker(marker)), marker.toString(16)).toBe(true);
    const sof = (marker: number) => bytes([0xff, 0xd8], kept.dqt, [0xff, marker, ...kept.sof.slice(2)], kept.dht, kept.sos, scan, [0xff, 0xd9]);
    for (const marker of [0xc0, 0xc1, 0xc2]) expect(jpegMarkersDrawable(sof(marker))).toBe(true);
    for (const marker of [0xc3, 0xc5, 0xc9, 0xca, 0xcf]) expect(jpegMarkersDrawable(sof(marker))).toBe(false);
    // The scan's coded bytes (stuffed 0xFF00, restarts) are not markers.
    expect(jpegMarkersDrawable(bytes([0xff, 0xd8], kept.sof, kept.sos, [1, 0xff, 0x00, 2, 0xff, 0xd3, 3], [0xff, 0xd9]))).toBe(true);
    expect(jpegMarkersDrawable(Uint8Array.from(ascii("hello")))).toBe(false);
  });
});
