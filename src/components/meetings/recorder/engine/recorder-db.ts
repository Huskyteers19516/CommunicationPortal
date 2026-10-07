// Crash protection for the meeting recorder: every 5-second piece of the recording and the transcript so far are
// saved in this browser's IndexedDB as the meeting goes, so a closed or crashed tab can be recovered from the
// recorder page ("Unsaved recording … Review & save / Discard") and an interrupted upload can be finished. The copy
// is deleted only after the server has the whole recording. Adapted from VoiceCollector's db.js. Browser only.
//
// IndexedDB can be missing or blocked (private windows, strict settings, a full disk): openRecorderDb() then
// returns a memory-only store with `persistent: false` — recording still works, without crash protection.

import type { TimedSegment } from "@/lib/meeting-recorder/transcript-text";

export const RECORDER_DB_NAME = "huskyteers-recorder";
const VERSION = 1;
/** Local copies of the audio older than this are deleted (the server keeps recordings 3 days too); text stays. */
export const LOCAL_AUDIO_KEEP_MS = 72 * 60 * 60 * 1000;
/** A "recording" whose heartbeat is older than this was cut off (a live recorder writes every 10 s). */
export const RECORDING_STALE_MS = 15_000;

export type RecordingStatus = "recording" | "stopped" | "uploading";

/** What the review form held, so a recovered recording opens where it was left. */
export type RecorderDraft = {
  title?: string;
  meetingDate?: string;
  categoryIds?: string[];
  keyPoints?: string;
  transcript?: string;
  keepAudio?: boolean;
};

export type RecordingDoc = {
  id: string;
  status: RecordingStatus;
  /** Date.now() when recording started / when the doc was last written. */
  startedAt: number;
  heartbeatAt: number;
  /** Recorded time so far (paused time left out). */
  durationMs: number;
  /** MediaRecorder's mimeType (e.g. "audio/webm;codecs=opus"). */
  mime: string;
  segments: TimedSegment[];
  marks: number[];
  /** Whether the live transcript covered the whole recording (else offer to transcribe the audio). */
  liveTranscriptComplete?: boolean;
  /** About how much of the recording the live transcript missed, in seconds (0 when complete). */
  liveTranscriptMissedSec?: number;
  draft?: RecorderDraft;
  /** The save's request id (a UUID, sent as createMeetingRecapAction's `requestId`): saving again after a lost answer
   *  reuses it, so the portal answers with the recap it already made instead of making a second one. */
  requestId?: string;
  /** Set once the recap was saved: the audio upload to finish. */
  recapId?: string;
  uploadedParts?: number[];
  /** The local audio was deleted (over 3 days old); the text can still be saved. */
  audioPurged?: boolean;
  /** Set for "Upload a recording": the picked file's name (the file is chunk 0). */
  fileName?: string;
};

export type RecorderDb = {
  /** False: memory only (IndexedDB unavailable, or a write failed — e.g. the disk is full). */
  readonly persistent: boolean;
  putRecording(doc: RecordingDoc): Promise<boolean>;
  getRecording(id: string): Promise<RecordingDoc | null>;
  /** Newest first. */
  listRecordings(): Promise<RecordingDoc[]>;
  putChunk(recId: string, seq: number, blob: Blob): Promise<boolean>;
  /** The recording so far: its pieces joined in order (null when there are none). */
  getAudio(recId: string, mime: string): Promise<Blob | null>;
  deleteChunks(recId: string): Promise<void>;
  /** The doc and its audio. */
  deleteRecording(recId: string): Promise<void>;
  /** Deletes the audio of recordings started over 3 days before `now` (keeps their text). Returns their ids. */
  purgeOldAudio(now?: number): Promise<string[]>;
};

type ChunkRow = { key: string; recId: string; seq: number; blob: Blob };

const chunkKey = (recId: string, seq: number) => `${recId}#${String(seq).padStart(6, "0")}`;

/** Recordings to offer on the recorder page: stopped or mid-upload, or "recording" with no heartbeat for 15 s. */
export function findRecoverable(docs: RecordingDoc[], now = Date.now()): RecordingDoc[] {
  return docs
    .filter((d) => d.status !== "recording" || now - d.heartbeatAt > RECORDING_STALE_MS)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Asks the browser not to clear this site's storage under pressure (no prompt in most browsers). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

/** Bytes this site stores and may store (0s when unknown). */
export async function storageEstimate(): Promise<{ used: number; quota: number }> {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return { used: 0, quota: 0 };
  }
}

function memoryDb(): RecorderDb {
  const docs = new Map<string, RecordingDoc>();
  const chunks = new Map<string, ChunkRow>();
  const chunksOf = (recId: string) => [...chunks.values()].filter((c) => c.recId === recId).sort((a, b) => a.seq - b.seq);
  return {
    persistent: false,
    async putRecording(doc) {
      docs.set(doc.id, structuredClone(doc));
      return true;
    },
    async getRecording(id) {
      const d = docs.get(id);
      return d ? structuredClone(d) : null;
    },
    async listRecordings() {
      return [...docs.values()].map((d) => structuredClone(d)).sort((a, b) => b.startedAt - a.startedAt);
    },
    async putChunk(recId, seq, blob) {
      chunks.set(chunkKey(recId, seq), { key: chunkKey(recId, seq), recId, seq, blob });
      return true;
    },
    async getAudio(recId, mime) {
      const list = chunksOf(recId);
      return list.length ? new Blob(list.map((c) => c.blob), { type: mime }) : null;
    },
    async deleteChunks(recId) {
      for (const c of chunksOf(recId)) chunks.delete(c.key);
    },
    async deleteRecording(recId) {
      docs.delete(recId);
      for (const c of chunksOf(recId)) chunks.delete(c.key);
    },
    async purgeOldAudio(now = Date.now()) {
      const purged: string[] = [];
      for (const d of docs.values()) {
        if (d.audioPurged || now - d.startedAt <= LOCAL_AUDIO_KEEP_MS) continue;
        for (const c of chunksOf(d.id)) chunks.delete(c.key);
        d.audioPurged = true;
        purged.push(d.id);
      }
      return purged;
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs `fn` in one transaction; resolves with its result when the transaction completes. */
function run<T>(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  return new Promise((resolve, reject) => {
    let out: T;
    let t: IDBTransaction;
    try {
      t = db.transaction(stores, mode);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("The browser's storage refused the write."));
    Promise.resolve(fn(t)).then(
      (v) => {
        out = v;
      },
      (e) => {
        try {
          t.abort();
        } catch {
          // already finished
        }
        reject(e);
      },
    );
  });
}

function idbDb(db: IDBDatabase): RecorderDb {
  let persistent = true;
  const write = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch {
      persistent = false;
      return false;
    }
  };
  const deleteChunksIn = (t: IDBTransaction, recId: string) =>
    new Promise<void>((resolve, reject) => {
      const store = t.objectStore("chunks");
      const cursorReq = store.index("recId").openKeyCursor(IDBKeyRange.only(recId));
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c) return resolve();
        store.delete(c.primaryKey);
        c.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

  const api: RecorderDb = {
    get persistent() {
      return persistent;
    },
    putRecording(doc) {
      return write(() => run(db, "recordings", "readwrite", (t) => request(t.objectStore("recordings").put(doc))));
    },
    async getRecording(id) {
      try {
        return ((await run(db, "recordings", "readonly", (t) => request(t.objectStore("recordings").get(id)))) as RecordingDoc | undefined) ?? null;
      } catch {
        return null;
      }
    },
    async listRecordings() {
      try {
        const all = (await run(db, "recordings", "readonly", (t) => request(t.objectStore("recordings").getAll()))) as RecordingDoc[];
        return all.sort((a, b) => b.startedAt - a.startedAt);
      } catch {
        return [];
      }
    },
    putChunk(recId, seq, blob) {
      const row: ChunkRow = { key: chunkKey(recId, seq), recId, seq, blob };
      return write(() => run(db, "chunks", "readwrite", (t) => request(t.objectStore("chunks").put(row))));
    },
    async getAudio(recId, mime) {
      try {
        const rows = (await run(db, "chunks", "readonly", (t) => request(t.objectStore("chunks").index("recId").getAll(IDBKeyRange.only(recId))))) as ChunkRow[];
        rows.sort((a, b) => a.seq - b.seq);
        return rows.length ? new Blob(rows.map((r) => r.blob), { type: mime }) : null;
      } catch {
        return null;
      }
    },
    async deleteChunks(recId) {
      await run(db, "chunks", "readwrite", (t) => deleteChunksIn(t, recId)).catch(() => {});
    },
    async deleteRecording(recId) {
      await run(db, ["recordings", "chunks"], "readwrite", async (t) => {
        t.objectStore("recordings").delete(recId);
        await deleteChunksIn(t, recId);
      }).catch(() => {});
    },
    async purgeOldAudio(now = Date.now()) {
      const purged: string[] = [];
      for (const d of await api.listRecordings()) {
        if (d.audioPurged || now - d.startedAt <= LOCAL_AUDIO_KEEP_MS) continue;
        await api.deleteChunks(d.id);
        if (await api.putRecording({ ...d, audioPurged: true })) purged.push(d.id);
      }
      return purged;
    },
  };
  return api;
}

/**
 * Opens the recorder's IndexedDB (`huskyteers-recorder` v1: `recordings` by id, `chunks` by "<id>#<seq6>" with a
 * `recId` index). Never throws: falls back to a memory-only store (`persistent: false`) after 4 s or on any error.
 */
export async function openRecorderDb(): Promise<RecorderDb> {
  if (typeof indexedDB === "undefined") return memoryDb();
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("IndexedDB didn't open in time.")), 4000);
      const req = indexedDB.open(RECORDER_DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("recordings")) d.createObjectStore("recordings", { keyPath: "id" });
        if (!d.objectStoreNames.contains("chunks")) d.createObjectStore("chunks", { keyPath: "key" }).createIndex("recId", "recId");
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        resolve(req.result);
      };
      req.onerror = () => {
        clearTimeout(timer);
        reject(req.error);
      };
      req.onblocked = () => {
        clearTimeout(timer);
        reject(new Error("IndexedDB is blocked by another tab."));
      };
    });
    return idbDb(db);
  } catch {
    return memoryDb();
  }
}
