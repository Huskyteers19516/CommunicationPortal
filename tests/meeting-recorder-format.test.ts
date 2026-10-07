// Meeting recaps: the plain-text format of transcripts and key points ("[12:30] text" lines) and the exports
// everyone can download (src/lib/meeting-recorder/transcript-format.ts, export.ts). Pure functions, no database.
import { describe, expect, it } from "vitest";
import { keyPointsToClipboardText, recapFileBase, recapToMarkdown, recapToPlainText, type RecapExport } from "@/lib/meeting-recorder/export";
import {
  formatClock,
  formatKeyPoints,
  formatTranscript,
  parseKeyPointLines,
  parseTranscriptLines,
} from "@/lib/meeting-recorder/transcript-format";

describe("formatClock", () => {
  it("writes m:ss under an hour and h:mm:ss from an hour on", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(5_400)).toBe("0:05");
    expect(formatClock(750_000)).toBe("12:30");
    expect(formatClock(3_599_999)).toBe("59:59");
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_723_000)).toBe("1:02:03");
  });

  it("treats negative and non-finite times as zero", () => {
    expect(formatClock(-20)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });
});

describe("formatTranscript / formatKeyPoints", () => {
  it("writes one [m:ss] line per segment, skipping empty ones and joining line breaks", () => {
    const text = formatTranscript([
      { s: 0, text: "Okay, let's get started." },
      { s: 12_400, text: "  " },
      { s: 65_000, text: "The scrimmage is\non October 31." },
      { s: 3_725_000, text: "Thanks everyone." },
    ]);
    expect(text).toBe("[0:00] Okay, let's get started.\n[1:05] The scrimmage is on October 31.\n[1:02:05] Thanks everyone.");
  });

  it("leaves points without a time unprefixed", () => {
    expect(formatKeyPoints([{ atMs: null, text: "Bring safety glasses." }, { atMs: 1000, text: "Decision: four-bar." }])).toBe(
      "Bring safety glasses.\n[0:01] Decision: four-bar.",
    );
  });
});

describe("parseTranscriptLines", () => {
  it("reads [m:ss], [mm:ss] and [h:mm:ss] prefixes, and lines without one", () => {
    expect(parseTranscriptLines("[0:05] Hi.\n[12:30] Intake.\n[1:02:03] Late.\nNo time here.")).toEqual([
      { atMs: 5_000, text: "Hi." },
      { atMs: 750_000, text: "Intake." },
      { atMs: 3_723_000, text: "Late." },
      { atMs: null, text: "No time here." },
    ]);
  });

  it("drops empty lines, accepts CRLF and hand-typed minutes past 59", () => {
    expect(parseTranscriptLines("\r\n[75:10]   Long meeting.\r\n\r\n   \n[3:04]Tight.")).toEqual([
      { atMs: 4_510_000, text: "Long meeting." },
      { atMs: 184_000, text: "Tight." },
    ]);
  });

  it("keeps an invalid time as text", () => {
    expect(parseTranscriptLines("[1:75] Not a time.\n[1:60:00] Nope.")).toEqual([
      { atMs: null, text: "[1:75] Not a time." },
      { atMs: null, text: "[1:60:00] Nope." },
    ]);
  });

  it("round-trips formatTranscript", () => {
    const segments = [
      { s: 0, text: "One." },
      { s: 61_000, text: "Two." },
      { s: 3_661_000, text: "Three." },
    ];
    expect(parseTranscriptLines(formatTranscript(segments))).toEqual(segments.map((x) => ({ atMs: x.s, text: x.text })));
  });
});

describe("parseKeyPointLines", () => {
  it("strips typed list markers before or after the time", () => {
    expect(parseKeyPointLines("- [12:30] Decision: four-bar.\n* Order motors.\n• [1:00] - Notebook.\n1. First.\n2) Second.")).toEqual([
      { atMs: 750_000, text: "Decision: four-bar." },
      { atMs: null, text: "Order motors." },
      { atMs: 60_000, text: "Notebook." },
      { atMs: null, text: "First." },
      { atMs: null, text: "Second." },
    ]);
  });

  it("doesn't mistake numbers for list markers", () => {
    expect(parseKeyPointLines("3D-printed spacers arrived.\n1.5 mm shims fit.\n-5 V rail is fine.")).toEqual([
      { atMs: null, text: "3D-printed spacers arrived." },
      { atMs: null, text: "1.5 mm shims fit." },
      { atMs: null, text: "-5 V rail is fine." },
    ]);
  });
});

const recap: RecapExport = {
  title: "Build meeting",
  meetingDate: "2026-10-07",
  categories: ["Build", "Strategy"],
  durationSec: 1_020,
  keyPoints: "[2:45] Decision: we go with the four-bar intake.\n[3:44] To do (Alice, by Friday): order the 312 RPM motors.\nBring safety glasses.",
  transcript: "[0:00] Okay, let's get started.\n[2:45] We decided to go with the four-bar intake.\nUntimed line.",
  recordedBy: "Martin Max",
};

describe("exports", () => {
  it("copies key points as a plain list", () => {
    expect(keyPointsToClipboardText(recap.keyPoints)).toBe(
      "- [2:45] Decision: we go with the four-bar intake.\n- [3:44] To do (Alice, by Friday): order the 312 RPM motors.\n- Bring safety glasses.",
    );
    expect(keyPointsToClipboardText("  \n")).toBe("");
  });

  it("writes Markdown with details, key points and transcript", () => {
    expect(recapToMarkdown(recap)).toBe(
      [
        "# Build meeting",
        "",
        "- Date: Wed, Oct 7, 2026",
        "- Duration: 17 min",
        "- Categories: Build, Strategy",
        "- Recorded by: Martin Max",
        "",
        "## Key points",
        "",
        "- **[2:45]** Decision: we go with the four-bar intake.",
        "- **[3:44]** To do (Alice, by Friday): order the 312 RPM motors.",
        "- Bring safety glasses.",
        "",
        "## Transcript",
        "",
        "**[0:00]** Okay, let's get started.",
        "",
        "**[2:45]** We decided to go with the four-bar intake.",
        "",
        "Untimed line.",
        "",
      ].join("\n"),
    );
  });

  it("says so when there are no key points or transcript", () => {
    const md = recapToMarkdown({ ...recap, keyPoints: "", transcript: "", categories: [], durationSec: null, recordedBy: null });
    expect(md).toContain("_No key points._");
    expect(md).toContain("_No transcript._");
    expect(md).not.toContain("Duration");
    expect(md).not.toContain("Categories");
  });

  it("writes the transcript .txt with a header", () => {
    expect(recapToPlainText(recap)).toBe(
      [
        "Build meeting",
        "Date: Wed, Oct 7, 2026 · Duration: 17 min · Categories: Build, Strategy · Recorded by: Martin Max",
        "--------------------",
        "",
        "[0:00] Okay, let's get started.",
        "[2:45] We decided to go with the four-bar intake.",
        "Untimed line.",
        "",
      ].join("\n"),
    );
  });

  it("makes safe file names", () => {
    expect(recapFileBase("Build meeting", "2026-10-07")).toBe("Build meeting 2026-10-07");
    expect(recapFileBase('Intake: roller / four-bar? <final> "v2"', "2026-10-07")).toBe("Intake roller four-bar final v2 2026-10-07");
    expect(recapFileBase("..hidden‮txt.exe", "2026-10-07")).toBe("hiddentxt.exe 2026-10-07");
    expect(recapFileBase("   ", "2026-10-07")).toBe("Meeting recap 2026-10-07");
    expect(recapFileBase("x".repeat(300), "2026-10-07")).toBe(`${"x".repeat(100)} 2026-10-07`);
  });
});
