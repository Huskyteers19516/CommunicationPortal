// Meeting recorder: cleaning Whisper's output (src/lib/meeting-recorder/transcript-text.ts — the loop and repeat
// cases come from VoiceCollector's real classroom recordings), speech detection (vad.ts) and the text handling for
// Chrome's summarizer (summary-text.ts). Pure functions, no database.
import { describe, expect, it } from "vitest";
import { chunkText, isUnusableSummary, parseSummaryBullets } from "@/lib/meeting-recorder/summary-text";
import {
  type AsrChunk,
  chunksToSegments,
  cleanTranscript,
  collapseLoops,
  createRepeatMemory,
  dropRepeats,
  dropSilenceHallucinations,
  isSilencePhrase,
  LOW_SPEECH_RATIO,
  overlapJoinLength,
  splitSegmentSentences,
  tokenize,
} from "@/lib/meeting-recorder/transcript-text";
import { detectSpeech, hasEnoughSpeech, SAMPLE_RATE, speechBlocks, speechRatio } from "@/lib/meeting-recorder/vad";

describe("tokenize", () => {
  it("compares words without case or edge punctuation but remembers where they start", () => {
    const text = "Okay, the Four-bar's done!";
    const t = tokenize(text);
    expect(t.map((x) => x.n)).toEqual(["okay", "the", "4", "bar's", "done"]);
    expect(t.map((x) => text.slice(x.start, x.start + 4))).toEqual(["Okay", "the ", "Four", "bar'", "done"]);
  });

  it("treats spelled-out numbers, ordinals and hyphens alike", () => {
    const n = (s: string) => tokenize(s).map((x) => x.n);
    expect(n("the four-bar intake on October 31st")).toEqual(n("The 4 bar intake on October 31."));
    expect(n("forty tries, twenty-two seconds")).toEqual(["40", "tries", "20", "2", "seconds"]);
  });
});

describe("overlapJoinLength", () => {
  const words = (s: string) => tokenize(s);

  it("finds the words the next window repeats", () => {
    expect(overlapJoinLength(words("we need the robot driving by then"), words("driving by then so it's tight"), 24)).toBe(3);
  });

  it("matches fuzzily when a word was recognised differently", () => {
    // "fifty" vs "50": 3 of 4 positions equal (75%)
    expect(overlapJoinLength(words("the arm reaches fifty centimeters out"), words("reaches 50 centimeters out and back"), 24)).toBe(4);
  });

  it("matches windows that wrote the same words differently (seen with whisper-small.en)", () => {
    const prev = words("So after looking at both prototypes, we decided to go with the four-bar intake for the scrimmage.");
    const cur = words("We decided to go with the 4 bar intake for the scrimmage. The important thing is the servo.");
    expect(overlapJoinLength(prev, cur, 24)).toBe(12);
  });

  it("prefers a long real overlap over a stray matching word", () => {
    const prev = words("we tested the intake at the end of the");
    const cur = words("at the end of the practice we tested it");
    expect(overlapJoinLength(prev, cur, 24)).toBe(5);
  });

  it("is limited to maxK words and 0 when nothing matches", () => {
    expect(overlapJoinLength(words("a b c d e f"), words("a b c d e f"), 3)).toBe(0);
    expect(overlapJoinLength(words("one two"), words("three four"), 24)).toBe(0);
    expect(overlapJoinLength([], words("anything"), 24)).toBe(0);
  });
});

describe("collapseLoops", () => {
  it("keeps one copy of a phrase repeated 3+ times in a row", () => {
    expect(collapseLoops(`So ${"I think it's like, ".repeat(74)}the robot works.`)).toBe("So I think it's like, the robot works.");
    expect(collapseLoops(`${"like, I'm ".repeat(107)}done`)).toBe("like, I'm done");
    expect(collapseLoops("Okay. ".repeat(14).trim())).toBe("Okay.");
  });

  it("keeps exactly-two repeats", () => {
    expect(collapseLoops("No, no.")).toBe("No, no.");
    expect(collapseLoops("The intake jams. The intake jams, but only with two samples.")).toBe(
      "The intake jams. The intake jams, but only with two samples.",
    );
  });

  it("leaves short and normal text alone", () => {
    expect(collapseLoops("")).toBe("");
    expect(collapseLoops("Hi there")).toBe("Hi there");
    expect(collapseLoops("We built the roller intake over the weekend.")).toBe("We built the roller intake over the weekend.");
  });
});

describe("dropRepeats", () => {
  it("drops a sentence identical to one of the last three", () => {
    const memory = createRepeatMemory();
    expect(dropRepeats("This is our H.I.S. 4.3.4.", memory)).toBe("This is our H.I.S. 4.3.4.");
    expect(dropRepeats("This is our H.I.S. 4.3.4. This is our H.I.S.", memory)).toBe("");
    expect(dropRepeats("I don't know.", memory)).toBe("I don't know.");
    expect(dropRepeats("I don't know.", memory)).toBe("");
  });

  it("drops a re-recognised sentence (70% of its word triples just said)", () => {
    const memory = createRepeatMemory();
    dropRepeats("The four-bar intake never jammed in forty tries over the weekend.", memory);
    expect(dropRepeats("Four-bar intake never jammed in forty tries over the weekend, honestly.", memory)).toBe("");
    expect(dropRepeats("The roller intake is faster.", memory)).toBe("The roller intake is faster.");
  });
});

describe("cleanTranscript", () => {
  it("cleans each chunk, drops re-recognised chunks and rebuilds the text", () => {
    const chunks: AsrChunk[] = [
      { text: " We tested the four-bar intake forty times.", timestamp: [0, 3.2] },
      { text: " Okay. Okay. Okay. Okay.", timestamp: [3.2, 5] },
      { text: " We tested the four-bar intake forty times.", timestamp: [5, 8] },
      { text: " It never jammed.", timestamp: [8, null] },
    ];
    const out = cleanTranscript({ text: "", chunks });
    expect(out.chunks.map((c) => c.text.trim())).toEqual(["We tested the four-bar intake forty times.", "Okay.", "It never jammed."]);
    expect(out.text).toBe("We tested the four-bar intake forty times. Okay. It never jammed.");
  });

  it("works on plain text without chunks", () => {
    expect(cleanTranscript({ text: "Yes. Yes. Yes. Yes.", chunks: [] })).toEqual({ text: "Yes.", chunks: [] });
  });
});

describe("chunksToSegments", () => {
  it("joins half sentences, with the first start and the last end in ms", () => {
    const segs = chunksToSegments([
      { text: " So we built", timestamp: [0.5, 1.4] },
      { text: " two prototypes.", timestamp: [1.4, 2.6] },
      { text: " The roller", timestamp: [3, 3.8] },
      { text: " jams.", timestamp: [3.8, null] },
    ]);
    expect(segs).toEqual([
      { s: 500, e: 2600, text: "So we built two prototypes." },
      { s: 3000, e: 3800, text: "The roller jams." },
    ]);
  });

  it("breaks after 40 words without punctuation and applies an offset", () => {
    const long = Array.from({ length: 45 }, (_, i) => `w${i}`);
    const segs = chunksToSegments(
      long.map((w, i) => ({ text: ` ${w}`, timestamp: [i, i + 1] as [number, number] })),
      60_000,
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ s: 60_000, e: 101_000 });
    expect(segs[0].text.split(" ")).toHaveLength(41);
    expect(segs[1]).toMatchObject({ s: 101_000, e: 105_000 });
  });

  it("keeps a closing quote or bracket after the period", () => {
    const segs = chunksToSegments([
      { text: ' He said "ship it."', timestamp: [0, 1] },
      { text: " Next.", timestamp: [1, 2] },
    ]);
    expect(segs.map((s) => s.text)).toEqual(['He said "ship it."', "Next."]);
  });
});

describe("splitSegmentSentences", () => {
  it("spreads a window's time over its sentences by length and joins very short ones", () => {
    const parts = splitSegmentSentences({ s: 22_000, e: 47_000, text: "Okay. So the intake is done. Now the drivetrain needs new motors." });
    expect(parts.map((p) => p.text)).toEqual(["Okay. So the intake is done.", "Now the drivetrain needs new motors."]);
    expect(parts[0].s).toBe(22_000);
    expect(parts[0].e).toBe(parts[1].s);
    expect(parts[1].s).toBeGreaterThan(22_000);
    expect(parts[1].e).toBe(47_000);
  });

  it("gives every sentence the start time when there's no end", () => {
    expect(splitSegmentSentences({ s: 5_000, e: null, text: "The first thing goes here. The second thing goes there." })).toEqual([
      { s: 5_000, e: null, text: "The first thing goes here." },
      { s: 5_000, e: null, text: "The second thing goes there." },
    ]);
    expect(splitSegmentSentences({ s: 0, e: 10, text: "   " })).toEqual([]);
  });
});

describe("silence hallucinations", () => {
  it("knows Whisper's stock phrases", () => {
    expect(isSilencePhrase("Thank you.")).toBe(true);
    expect(isSilencePhrase(" you ")).toBe(true);
    expect(isSilencePhrase("Thanks for watching!")).toBe(true);
    expect(isSilencePhrase("Thank you, Alice, for ordering the motors.")).toBe(false);
  });

  it("always removes sound labels", () => {
    expect(dropSilenceHallucinations("[BLANK_AUDIO]", 1)).toBe("");
    expect(dropSilenceHallucinations("(music) We start now. [Music] ♪ ♪", 1)).toBe("We start now.");
    expect(dropSilenceHallucinations("[soft music playing] *laughs* Okay.", 1)).toBe("Okay.");
  });

  it("removes stock phrases only when the audio was mostly silent", () => {
    expect(dropSilenceHallucinations("Thank you. Thanks for watching!", 0.1)).toBe("");
    expect(dropSilenceHallucinations("The intake works. Thank you.", 0.1)).toBe("The intake works.");
    expect(dropSilenceHallucinations("The intake works. Thank you.", LOW_SPEECH_RATIO)).toBe("The intake works. Thank you.");
  });
});

// Synthetic audio at 16 kHz.
function tone(seconds: number, freq: number, amp: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  return out;
}
/** Voice-like: a 180 Hz buzz with harmonics, in ~5 syllables a second with gaps between them. */
function syllables(seconds: number, amp = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const phase = (t * 5) % 1;
    const env = phase < 0.6 ? Math.sin((Math.PI * phase) / 0.6) : 0;
    const carrier = Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.25 * Math.sin(2 * Math.PI * 720 * t);
    out[i] = amp * env * carrier * 0.6;
  }
  return out;
}
function noise(seconds: number, amp: number): Float32Array {
  let seed = 12345;
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((seed / 0x7fffffff) * 2 - 1);
  }
  return out;
}
function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("detectSpeech", () => {
  it("hears syllables but not silence, a steady hum or hiss", () => {
    expect(detectSpeech(syllables(1))).toBe(true);
    expect(detectSpeech(new Float32Array(SAMPLE_RATE))).toBe(false);
    expect(detectSpeech(tone(1, 120, 0.2))).toBe(false);
    expect(detectSpeech(noise(1, 0.2))).toBe(false);
    expect(detectSpeech(syllables(1, 0.0005))).toBe(false); // below -50 dB
    expect(detectSpeech(new Float32Array(10))).toBe(false);
  });

  it("scales the zero-crossing limits to the sample rate", () => {
    // The same voice at 48 kHz crosses zero a third as often per sample: without scaling it would look like hum.
    const at48k = new Float32Array(48_000);
    for (let i = 0; i < at48k.length; i++) {
      const t = i / 48_000;
      const phase = (t * 5) % 1;
      const carrier = Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.25 * Math.sin(2 * Math.PI * 720 * t);
      at48k[i] = 0.18 * (phase < 0.6 ? Math.sin((Math.PI * phase) / 0.6) : 0) * carrier;
    }
    expect(detectSpeech(at48k, { rate: 48_000 })).toBe(true);
    expect(detectSpeech(at48k, { rate: 16_000 })).toBe(false);
  });
});

describe("speechRatio", () => {
  it("is the share of 1-second blocks with speech", () => {
    const audio = concat(syllables(3), new Float32Array(7 * SAMPLE_RATE));
    expect(speechBlocks(audio)).toEqual([true, true, true, false, false, false, false, false, false, false]);
    expect(speechRatio(audio)).toBeCloseTo(0.3);
    expect(hasEnoughSpeech(audio)).toBe(true);
  });

  it("calls a window with almost no speech not worth transcribing", () => {
    const audio = concat(syllables(1), new Float32Array(24 * SAMPLE_RATE));
    expect(speechRatio(audio)).toBeCloseTo(1 / 25);
    expect(hasEnoughSpeech(audio)).toBe(false);
    expect(speechRatio(new Float32Array(0))).toBe(0);
  });
});

describe("summary text", () => {
  it("chunks at line breaks and hard-splits a very long line", () => {
    expect(chunkText("aaa\nbbb\nccc", 8)).toEqual(["aaa\nbbb", "ccc"]);
    const long = `${"word ".repeat(30).trim()}`;
    const chunks = chunkText(long, 40);
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
    expect(chunks.join("").replace(/\s+/g, "")).toBe(long.replace(/\s+/g, ""));
    expect(chunkText("", 10)).toEqual([]);
  });

  it("reads markdown bullets", () => {
    expect(parseSummaryBullets("Here are the key points:\n\n* **Intake:** four-bar chosen.\n- Motors ordered\n1. Notebook due\n  • Nested bullet\nPlain line")).toEqual([
      "Intake: four-bar chosen.",
      "Motors ordered",
      "Notebook due",
      "Nested bullet",
    ]);
  });

  it("rejects stubs and echoes", () => {
    const input = "We decided to go with the four-bar intake for the scrimmage and Alice orders the motors by Friday.";
    expect(isUnusableSummary("", input)).toBe(true);
    expect(isUnusableSummary("Model not available in Chromium\n" + input, input)).toBe(true);
    expect(isUnusableSummary(`* ${input}`, input)).toBe(true);
    expect(isUnusableSummary("* The team chose the four-bar intake.", input)).toBe(false);
  });
});
