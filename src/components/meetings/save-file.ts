// Saving something the page built (a recap's .md, its transcript, the joined recording) as a download. Browser only.

/** Saves `blob` as `filename` (through a Blob URL and an <a download>; the URL is let go a little later). */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // Some browsers start the download after the click returns: give it time before letting the URL go.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
