// Browser-only: makes a picked picture that's over the upload limit (a 48 MP phone photo, a big PNG export) small
// enough to upload, as a JPG, before it leaves the phone. The server checks the result like any other file.
import { LIMITS } from "@/lib/constants";
import { fitWithin, jpgName } from "@/lib/posters";

/** Tried in order until the JPG fits: the first keeps plenty for printing a letter-size flyer. */
const STEPS: readonly { maxSide: number; quality: number }[] = [
  { maxSide: 3000, quality: 0.85 },
  { maxSide: 2400, quality: 0.8 },
  { maxSide: 1600, quality: 0.75 },
];

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

/**
 * A smaller JPG copy of `file` that fits LIMITS.resourceFileMaxBytes, or null when the browser can't read the
 * picture or it doesn't get small enough. Transparent parts become white.
 */
export async function shrinkPicture(file: File): Promise<File | null> {
  try {
    const img = await loadPicture(file);
    if (!img.naturalWidth || !img.naturalHeight) return null;
    for (const step of STEPS) {
      const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, step.maxSide);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext("2d");
      if (!g) return null;
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, width, height);
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, width, height);
      const blob = await toJpeg(canvas, step.quality);
      if (blob && blob.size > 0 && blob.size <= LIMITS.resourceFileMaxBytes) {
        return new File([blob], jpgName(file.name), { type: "image/jpeg", lastModified: Date.now() });
      }
    }
    return null;
  } catch {
    return null; // not a picture this browser can read
  }
}
