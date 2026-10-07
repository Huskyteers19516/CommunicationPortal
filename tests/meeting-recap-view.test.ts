// Meeting recaps' pages: the labels they share, which transcript line goes with a moment of the recording, and the
// category picker catching up with the team's list (src/lib/meeting-recap-view.ts). Pure functions, no database.
import { describe, expect, it } from "vitest";
import {
  catchUpMeetingCategories,
  findMeetingCategory,
  meetingAudioUntilLabel,
  meetingCategoryKey,
  meetingRecapOrigin,
  playingTranscriptLine,
  removedMeetingCategoriesText,
  splitKeyPointLabel,
  transcriptLineAt,
} from "@/lib/meeting-recap-view";
import { parseTranscriptLines } from "@/lib/meeting-recorder/transcript-format";

const TZ = "America/Los_Angeles";

describe("meetingAudioUntilLabel", () => {
  it("says until when in the team's timezone, short for lists and long for a recap's page", () => {
    // 2026-10-09 22:40 UTC = Fri, Oct 9, 3:40 PM in Los Angeles.
    expect(meetingAudioUntilLabel("2026-10-09T22:40:00.000Z", TZ)).toBe("Fri 3:40 PM");
    expect(meetingAudioUntilLabel("2026-10-09T22:40:00.000Z", TZ, "long")).toBe("Fri, Oct 9, 3:40 PM");
    expect(meetingAudioUntilLabel("not a date", TZ)).toBe("");
  });
});

describe("meetingRecapOrigin", () => {
  it("is “Recorded” when the recap came from the recorder (a length or a recording), else “Written up”", () => {
    expect(meetingRecapOrigin({ durationSec: 1540, audio: { state: "none" } })).toBe("Recorded");
    expect(meetingRecapOrigin({ durationSec: null, audio: { state: "deleted", early: false, at: "2026-10-10T22:40:00.000Z" } })).toBe(
      "Recorded",
    );
    expect(meetingRecapOrigin({ durationSec: null, audio: { state: "none" } })).toBe("Written up");
  });
});

describe("splitKeyPointLabel", () => {
  it("splits off the recorder's labels, owners and dates included", () => {
    expect(splitKeyPointLabel("Decision: we go with the 4-bar intake.")).toEqual({
      label: "Decision",
      text: "we go with the 4-bar intake.",
    });
    expect(splitKeyPointLabel("To do (Alice, by Friday): order the 312 RPM motors.")).toEqual({
      label: "To do (Alice, by Friday)",
      text: "order the 312 RPM motors.",
    });
    expect(splitKeyPointLabel("To do: charge the batteries.")).toEqual({ label: "To do", text: "charge the batteries." });
  });

  it("leaves any other point as it is", () => {
    for (const text of ["The scrimmage is on Oct 31.", "Goal: 3 samples in auto.", "Decision:", "decision: lower case", "To do (x): "]) {
      expect(splitKeyPointLabel(text)).toEqual({ label: null, text });
    }
  });
});

describe("transcript lines and moments", () => {
  const lines = parseTranscriptLines(
    [
      "[0:04] Okay, let's get started.",
      "[1:12] The 4-bar won the vote.",
      "A line typed without a time.",
      "[3:30] The slides wait for next year.",
    ].join("\n"),
  );

  it("transcriptLineAt: the latest line at or before the moment, else the first; -1 without times", () => {
    expect(transcriptLineAt(lines, 0)).toBe(0); // before every line: the first one
    expect(transcriptLineAt(lines, 4_000)).toBe(0);
    expect(transcriptLineAt(lines, 72_000)).toBe(1);
    expect(transcriptLineAt(lines, 200_000)).toBe(1);
    expect(transcriptLineAt(lines, 210_000)).toBe(3);
    expect(transcriptLineAt(lines, 99_000_000)).toBe(3);
    expect(transcriptLineAt(parseTranscriptLines("no times\nat all"), 5_000)).toBe(-1);
    expect(transcriptLineAt([], 5_000)).toBe(-1);
  });

  it("transcriptLineAt copes with times typed out of order, and picks the first of equal ones", () => {
    const messy = parseTranscriptLines("[2:00] b\n[1:00] a\n[1:00] a again\n[3:00] c");
    expect(transcriptLineAt(messy, 90_000)).toBe(1);
    expect(transcriptLineAt(messy, 150_000)).toBe(0);
    expect(transcriptLineAt(messy, 30_000)).toBe(1);
  });

  it("playingTranscriptLine: none before the first line or well past a line's end", () => {
    expect(playingTranscriptLine(lines, 1_000, null)).toBe(-1);
    expect(playingTranscriptLine(lines, 4_000, null)).toBe(0);
    expect(playingTranscriptLine(lines, 71_999, null)).toBe(0);
    expect(playingTranscriptLine(lines, 72_000, null)).toBe(1);
    // The last line runs to the recording's end (else 8 s), plus 1.5 s.
    expect(playingTranscriptLine(lines, 215_000, null)).toBe(3);
    expect(playingTranscriptLine(lines, 219_500, null)).toBe(3);
    expect(playingTranscriptLine(lines, 219_501, null)).toBe(-1);
    expect(playingTranscriptLine(lines, 300_000, 400_000)).toBe(3);
    expect(playingTranscriptLine(lines, 401_501, 400_000)).toBe(-1);
    // A recording shorter than the last line's start doesn't cut it off.
    expect(playingTranscriptLine(lines, 215_000, 1_000)).toBe(3);
  });
});

describe("the category picker and the team's list", () => {
  const build = { id: "meetingcat-build", name: "Build" };
  const outreach = { id: "meetingcat-outreach", name: "Outreach" };
  const strategy = { id: "meetingcat-strategy", name: "Strategy" };
  const drive = { id: "cat-drive", name: "Drive team" };

  it("compares names the way the server does: spaces tidied, case ignored", () => {
    expect(meetingCategoryKey("  Drive   TEAM ")).toBe("drive team");
    expect(findMeetingCategory([build, drive], "drive  team")).toBe(drive);
    expect(findMeetingCategory([build, drive], "BUILD")).toBe(build);
    expect(findMeetingCategory([build, drive], "Builds")).toBeUndefined();
    expect(findMeetingCategory([build], "   ")).toBeUndefined();
  });

  it("drops picks whose category was deleted meanwhile, and names them", () => {
    const caught = catchUpMeetingCategories({
      before: [build, outreach, strategy],
      next: [build, strategy],
      added: [],
      selected: [outreach.id, build.id, strategy.id],
    });
    expect(caught).toEqual({ added: [], selected: [build.id, strategy.id], removed: ["Outreach"] });
  });

  it("leaves a category added in the picker to the list once the list has it, so a later delete removes it too", () => {
    // The refresh after the add: the list has it now.
    const listed = catchUpMeetingCategories({ before: [build], next: [build, drive], added: [drive], selected: [drive.id] });
    expect(listed).toEqual({ added: [], selected: [drive.id], removed: [] });
    // Someone deletes it later.
    const deleted = catchUpMeetingCategories({ before: [build, drive], next: [build], added: listed.added, selected: listed.selected });
    expect(deleted).toEqual({ added: [], selected: [], removed: ["Drive team"] });
  });

  it("keeps a category added in the picker while the list doesn't have it yet (its refresh is still on its way)", () => {
    const caught = catchUpMeetingCategories({ before: [build], next: [build, outreach], added: [drive], selected: [drive.id, build.id] });
    expect(caught).toEqual({ added: [drive], selected: [drive.id, build.id], removed: [] });
  });

  it("drops picks it never knew without naming them, and changes nothing when nothing moved", () => {
    expect(catchUpMeetingCategories({ before: [build], next: [build], added: [], selected: ["cat-unknown", build.id] })).toEqual({
      added: [],
      selected: [build.id],
      removed: [],
    });
    expect(catchUpMeetingCategories({ before: [build, outreach], next: [outreach, build], added: [], selected: [build.id] })).toEqual({
      added: [],
      selected: [build.id],
      removed: [],
    });
  });

  it("says which picked categories were deleted", () => {
    expect(removedMeetingCategoriesText([])).toBe("");
    expect(removedMeetingCategoriesText(["Outreach"])).toBe("“Outreach” was deleted from the team's list, so it isn't picked anymore.");
    expect(removedMeetingCategoriesText(["Outreach", "Build"])).toBe(
      "“Outreach” and “Build” were deleted from the team's list, so they aren't picked anymore.",
    );
    expect(removedMeetingCategoriesText(["Outreach", "Build", "Strategy"])).toBe(
      "“Outreach”, “Build”, and “Strategy” were deleted from the team's list, so they aren't picked anymore.",
    );
  });
});
