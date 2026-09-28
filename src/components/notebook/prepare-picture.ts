// Browser-only: gets a picked picture ready for a notebook entry before it leaves the phone. Photos (and anything
// bigger than NOTEBOOK_PICTURE_MAX_SIDE pixels or NOTEBOOK_PICTURE_KEEP_BYTES) become a JPG at most 1280 pixels on
// the longest side, the right way up; WebP becomes a JPG too (Word can't show WebP). Small PNG screenshots and GIFs
// (which would lose their animation) are sent as they are. The server checks the result like any other upload.
import { LIMITS } from "@/lib/constants";
import { NOTEBOOK_PICTURE_KEEP_BYTES, NOTEBOOK_PICTURE_MAX_SIDE } from "@/lib/notebook";
import { fitWithin, jpgName } from "@/lib/posters";

/** Tried in order until the JPG fits the upload limit (the first nearly always does at 1280 px). */
const QUALITIES = [0.8, 0.7, 0.6];

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

const isGif = (file: File) => file.type === "image/gif" || /\.gif$/i.test(file.name);
const isWebp = (file: File) => file.type === "image/webp" || /\.webp$/i.test(file.name);

/**
 * The picture to upload for `file`: a smaller JPG copy when it needs one, else the file itself. When the browser
 * can't read it, the file comes back unchanged (the preview then shows it can't be opened).
 */
export async function preparePicture(file: File): Promise<File> {
  if (isGif(file)) return file;
  try {
    const img = await loadPicture(file);
    const { naturalWidth: w, naturalHeight: h } = img;
    if (!w || !h) return file;
    const needsShrink = Math.max(w, h) > NOTEBOOK_PICTURE_MAX_SIDE || file.size > NOTEBOOK_PICTURE_KEEP_BYTES || isWebp(file);
    if (!needsShrink) return file;
    const size = fitWithin(w, h, NOTEBOOK_PICTURE_MAX_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const g = canvas.getContext("2d");
    if (!g) return file;
    g.fillStyle = "#ffffff"; // transparent parts become white
    g.fillRect(0, 0, size.width, size.height);
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, size.width, size.height);
    for (const quality of QUALITIES) {
      const blob = await toJpeg(canvas, quality);
      if (blob && blob.size > 0 && blob.size <= LIMITS.resourceFileMaxBytes) {
        return new File([blob], jpgName(file.name), { type: "image/jpeg", lastModified: Date.now() });
      }
    }
    return file;
  } catch {
    return file; // not a picture this browser can read
  }
}
