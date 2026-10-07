// Meeting recaps: fetching a saved recording in the browser (src/components/meetings/fetch-recording.ts, what the
// player and "Transcribe the recording again" use) — parts asked for one at a time in order and joined with the
// recording's type, progress, a part deleted meanwhile (404), signed out (redirected), refusals, sizes that don't add
// up, and aborting. A fake fetch; no database.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRecording,
  RECORDING_GONE,
  RECORDING_LOAD_FAILED,
  RECORDING_MESSAGES,
  RECORDING_SIGNED_OUT,
  type RecordingParts,
} from "@/components/meetings/fetch-recording";
import { meetingAudioPartHref } from "@/lib/meeting-recaps";

/** What the fake route answers for one part (the bits of a Response that fetchRecording reads). */
type FakeAnswer = { status?: number; redirected?: boolean; bytes?: Uint8Array };

function answer({ status = 200, redirected = false, bytes = new Uint8Array() }: FakeAnswer) {
  return { status, ok: status >= 200 && status < 300, redirected, blob: async () => new Blob([bytes as Uint8Array<ArrayBuffer>]) };
}

function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function parts(ids: string[], audioBytes: number): RecordingParts {
  return { partIds: ids, audioType: "audio/webm", audioBytes };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRecording", () => {
  it("asks for the parts one at a time, in order, and joins them with the recording's type", async () => {
    const answers: Record<string, Uint8Array> = { p1: bytes(5, 1), p2: bytes(3, 2), p3: bytes(4, 3) };
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    let inFlight = 0;
    let mostAtOnce = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        inFlight++;
        mostAtOnce = Math.max(mostAtOnce, inFlight);
        // The first part is the slowest: the later ones still wait for it.
        const id = url.split("/").pop()!;
        await new Promise((resolve) => setTimeout(resolve, id === "p1" ? 20 : 1));
        inFlight--;
        return answer({ bytes: answers[id] });
      }),
    );
    const controller = new AbortController();
    const progress: number[] = [];
    const blob = await fetchRecording(parts(["p1", "p2", "p3"], 12), controller.signal, (n) => progress.push(n));

    expect(calls.map((c) => c.url)).toEqual(["p1", "p2", "p3"].map(meetingAudioPartHref));
    expect(mostAtOnce).toBe(1);
    for (const c of calls) expect(c.init).toEqual({ signal: controller.signal, cache: "no-store", credentials: "same-origin" });
    expect(progress).toEqual([5, 8, 12]);
    expect(blob.type).toBe("audio/webm");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3]);
  });

  it("says the recording was just deleted when a part is a 404, and asks for nothing after it", async () => {
    const fetch = vi.fn(async (url: string) => (url.endsWith("/p2") ? answer({ status: 404 }) : answer({ bytes: bytes(4, 9) })));
    vi.stubGlobal("fetch", fetch);
    const progress: number[] = [];
    await expect(fetchRecording(parts(["p1", "p2", "p3"], 12), new AbortController().signal, (n) => progress.push(n))).rejects.toThrow(
      RECORDING_GONE,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([4]);
  });

  it("says the person was signed out when the route sent them to the sign-in page (even with a 200)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ redirected: true, bytes: new TextEncoder().encode("<html>Sign in</html>") })),
    );
    await expect(fetchRecording(parts(["p1"], 20), new AbortController().signal, () => {})).rejects.toThrow(RECORDING_SIGNED_OUT);
  });

  it("says it couldn't load on any other refusal", async () => {
    for (const status of [403, 500, 502]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => answer({ status })),
      );
      await expect(fetchRecording(parts(["p1"], 4), new AbortController().signal, () => {})).rejects.toThrow(RECORDING_LOAD_FAILED);
    }
  });

  it("says it couldn't load when the parts don't add up to the recording's size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ bytes: bytes(4, 1) })),
    );
    await expect(fetchRecording(parts(["p1", "p2"], 9), new AbortController().signal, () => {})).rejects.toThrow(RECORDING_LOAD_FAILED);
    await expect(fetchRecording(parts(["p1", "p2"], 7), new AbortController().signal, () => {})).rejects.toThrow(RECORDING_LOAD_FAILED);
    await expect(fetchRecording(parts(["p1", "p2"], 8), new AbortController().signal, () => {})).resolves.toHaveProperty("size", 8);
  });

  it("stops with the fetch's own AbortError when aborted (not one of its messages)", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/p1")) return answer({ bytes: bytes(4, 1) });
        // Part 2 hangs until the abort.
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
      }),
    );
    const progress: number[] = [];
    const loading = fetchRecording(parts(["p1", "p2"], 8), controller.signal, (n) => {
      progress.push(n);
      // Aborted once the first part is in, while the second is on its way.
      setTimeout(() => controller.abort(), 0);
    });
    const error = await loading.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(RECORDING_MESSAGES.has((error as Error).message)).toBe(false);
    expect(progress).toEqual([4]);
  });
});
