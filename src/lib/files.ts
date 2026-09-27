// Client-safe helpers for uploaded files.
import { LIMITS } from "./constants";

/** "812 bytes", "3.4 KB", "1.2 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The upload limit in whole megabytes (for messages), e.g. 4. */
export const RESOURCE_FILE_MAX_MB = Math.floor(LIMITS.resourceFileMaxBytes / (1024 * 1024));
