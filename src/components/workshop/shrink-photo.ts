// Browser-only: makes a picked Workshop photo web-sized before it leaves the phone. Every guest who opens the team
// website's Workshop page downloads these, so a photo bigger than WORKSHOP_PHOTO_MAX_SIDE pixels on its longest side,
// or over WORKSHOP_PHOTO_SHRINK_OVER_BYTES, becomes a JPG of at most that size. The server checks the result like any
// other photo. (Like ../posters/shrink-picture.ts, which only shrinks what's over the upload limit.)
import { LIMITS } from "@/lib/constants";
import { fitWithin, jpgName } from "@/lib/posters";
import { WORKSHOP_PHOTO_MAX_SIDE, WORKSHOP_PHOTO_SHRINK_OVER_BYTES } from "@/lib/workshop";

/** Tried in order until the JPG fits the upload limit (the first one almost always does at this size). */
const QUALITIES: readonly number[] = [0.85, 0.75, 0.6];

async function loadPicture(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    // An <img> turns phone photos the right way up (EXIF orientation), and so does drawing it.
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

export type PreparedPhoto =
  /** Ready to upload: the picked file as it was, or a smaller JPG copy (`shrunkFrom` = the picked file's size). */
  | { ok: true; file: File; shrunkFrom?: number }
  /** The browser can't read it (damaged, or not really a picture). */
  | { ok: false };

/**
 * The photo to upload: `file` itself when it's small enough already (in pixels and bytes), else a JPG copy at most
 * WORKSHOP_PHOTO_MAX_SIDE on the longest side (transparent parts become white). When a copy can't be made (the browser
 * can't draw it) but the picture itself was readable, the original is used and the server decides.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  let img: HTMLImageElement;
  try {
    img = await loadPicture(file);
  } catch {
    return { ok: false };
  }
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!w || !h) return { ok: false };
  if (Math.max(w, h) <= WORKSHOP_PHOTO_MAX_SIDE && file.size <= WORKSHOP_PHOTO_SHRINK_OVER_BYTES) return { ok: true, file };

  try {
    const { width, height } = fitWithin(w, h, WORKSHOP_PHOTO_MAX_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) return { ok: true, file };
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, width, height);
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, width, height);
    for (const quality of QUALITIES) {
      const blob = await toJpeg(canvas, quality);
      if (!blob || blob.size === 0 || blob.size > LIMITS.resourceFileMaxBytes) continue;
      // Already web-sized in pixels and the copy isn't smaller: keep the original.
      if (blob.size >= file.size && Math.max(w, h) <= WORKSHOP_PHOTO_MAX_SIDE) return { ok: true, file };
      return {
        ok: true,
        file: new File([blob], jpgName(file.name), { type: "image/jpeg", lastModified: Date.now() }),
        shrunkFrom: file.size,
      };
    }
  } catch {
    // Fall through: send the original.
  }
  return { ok: true, file };
}
