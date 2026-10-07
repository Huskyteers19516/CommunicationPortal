// Meeting recorder: key points from a transcript (src/lib/meeting-recorder/key-points.ts) — decisions, to-dos with
// owners and deadlines, emphasis, marked moments, spread and limits — and merging Chrome summarizer bullets.
// Runs on a realistic 17-minute build meeting (tests/fixtures/ftc-meeting.ts). Pure functions, no database.
import { describe, expect, it } from "vitest";
import { cleanBulletText, generateKeyPoints, type KeyPoint, mergeKeyPoints } from "@/lib/meeting-recorder/key-points";
import { formatKeyPoints, parseKeyPointLines, parseTranscriptLines } from "@/lib/meeting-recorder/transcript-format";
import { FTC_MARKS, FTC_MEETING, FTC_ROSTER, fixtureTime as at, WHISPER_SHORT_TRANSCRIPT } from "./fixtures/ftc-meeting";

const find = (points: KeyPoint[], needle: string) => points.find((p) => p.text.includes(needle));

describe("generateKeyPoints on a build meeting", () => {
  const points = generateKeyPoints(FTC_MEETING, { roster: FTC_ROSTER, marks: FTC_MARKS });

  it("finds the design decision", () => {
    expect(find(points, "four-bar intake for the scrimmage")).toEqual({
      atMs: at(2, 45),
      text: "Decision: after looking at both prototypes, we decided to go with the four-bar intake for the scrimmage.",
      kind: "decision",
    });
  });

  it("turns an assignment into a to-do with the owner and deadline in the label", () => {
    expect(find(points, "312 RPM")).toEqual({
      atMs: at(3, 44),
      text: "To do (Alice, by Friday): order the 312 RPM motors and two more torque servos.",
      kind: "action",
    });
    expect(find(points, "practice field")).toMatchObject({
      atMs: at(16, 0),
      text: "To do (Will, before Thursday): set up the practice field in the garage.",
      kind: "action",
    });
    expect(find(points, "engineering notebook, so please")?.text).toBe(
      "To do (Ben, by next Wednesday): you're in charge of the engineering notebook, so please write up the intake comparison with photos.",
    );
  });

  it("leaves the owner open when nobody is named, and moves the deadline to the label", () => {
    expect(find(points, "Sign up")?.text ?? find(points, "sign up")?.text).toBe("To do (by next Monday): sign up on the portal if you can come.");
  });

  it("catches a new team rule and an agreement as decisions", () => {
    expect(find(points, "main branch")).toMatchObject({ kind: "decision", text: expect.stringMatching(/^Decision: from now on, nobody pushes/) });
    expect(find(points, "drivers for the scrimmage")).toMatchObject({ kind: "decision" });
  });

  it("keeps emphasised points and the marked moment", () => {
    expect(find(points, "stronger servo")).toMatchObject({ kind: "point", atMs: at(3, 20) });
    expect(find(points, "public library")).toEqual({
      atMs: at(12, 5),
      text: "The public library said yes to the robotics demo on November 8.",
      kind: "point",
      marked: true,
    });
  });

  it("leaves out chat, in-meeting requests and Whisper's sign-off", () => {
    const all = points.map((p) => p.text).join("\n");
    for (const noise of ["hex keys", "snacks", "pizza", "Right, right", "Thank you", "walk us through", "That's fair", "can everyone hear"]) {
      expect(all).not.toContain(noise);
    }
    expect(find(points, "test numbers from Marcus")).toBeUndefined(); // "I'll need…": Marcus isn't the one doing it
  });

  it("returns 5–10 points in time order, spread out", () => {
    expect(points.length).toBeGreaterThanOrEqual(5);
    expect(points.length).toBeLessThanOrEqual(10);
    const times = points.map((p) => p.atMs ?? -1);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(8_000);
  });

  it("writes tidy lines that survive the saved text format", () => {
    for (const p of points) {
      expect(p.text).toMatch(/^[A-Z].*[.!?…]$/);
      expect(p.text.length).toBeLessThanOrEqual(220);
      expect(p.text).not.toMatch(/\b(?:um|uh)\b/i);
    }
    const saved = formatKeyPoints(points);
    expect(saved.split("\n")[0]).toMatch(/^\[\d+:\d{2}\] /);
    expect(parseKeyPointLines(saved)).toEqual(points.map((p) => ({ atMs: Math.floor((p.atMs ?? 0) / 1000) * 1000, text: p.text })));
  });

  it("respects max and min", () => {
    expect(generateKeyPoints(FTC_MEETING, { roster: FTC_ROSTER, max: 3 })).toHaveLength(3);
    expect(generateKeyPoints(FTC_MEETING, { roster: FTC_ROSTER, max: 20, min: 12 }).length).toBeGreaterThanOrEqual(12);
  });
});

describe("generateKeyPoints on a saved Whisper transcript", () => {
  // What "Suggest key points" on the edit page starts from: the saved text, times from the [m:ss] prefixes.
  const segments = parseTranscriptLines(WHISPER_SHORT_TRANSCRIPT).map((l) => ({ s: l.atMs ?? 0, text: l.text }));
  const points = generateKeyPoints(segments, { roster: FTC_ROSTER });

  it("splits Whisper's comma splices where someone is addressed", () => {
    expect(find(points, "312 RPM")?.text).toBe("To do (Alice, by Friday): order the 312 RPM motors and two more torque servos.");
    expect(find(points, "stronger servo")?.text).toBe(
      "The important thing is that the 4-bar needs a stronger servo, because the current one stalls at full extension.",
    );
    expect(find(points, "main branch")?.text).toBe("Decision: from now on, nobody pushes to the main branch without a code review.");
    expect(find(points, "engineering notebook")?.text).toBe(
      "To do (Ben, by next Wednesday): you are in charge of the engineering notebook, so please write up the intake comparison with photos.",
    );
  });

  it("takes a plan as a to-do when a team member is the one doing it", () => {
    expect(find(points, "heading controller")).toMatchObject({ text: "To do (Priya, by this week): tune the heading controller.", kind: "action" });
  });

  it("spreads a one-minute meeting over several points, each at its own moment", () => {
    expect(find(points, "four bar intake for the scrimmage")?.kind).toBe("decision");
    expect(points.length).toBeGreaterThanOrEqual(5);
    const times = points.map((p) => p.atMs);
    expect(new Set(times).size).toBe(times.length);
    expect(find(points, "Thanks everyone")).toBeUndefined();
  });
});

describe("owners", () => {
  it("finds a to-do's owner from the roster without one being addressed", () => {
    const [p] = generateKeyPoints([{ s: 0, e: 6000, text: "Okay so Priya needs to finish the heading PID tuning before the scrimmage." }], {
      roster: ["Priya"],
    });
    expect(p.text).toBe("To do (Priya): finish the heading PID tuning before the scrimmage.");
  });

  it("only counts a name that is also a word when it's capitalised mid-sentence or addressed", () => {
    const roster = ["Will", "Mark", "Grace"];
    const plain = generateKeyPoints([{ s: 0, e: 8000, text: "I will make sure the battery charger is packed for the scrimmage on Saturday." }], { roster });
    expect(plain[0].text).toBe("To do (by Saturday): I will make sure the battery charger is packed for the scrimmage.");
    const named = generateKeyPoints([{ s: 0, e: 8000, text: "Tomorrow Mark will make sure the battery charger is packed for the scrimmage." }], { roster });
    expect(named[0].text).toMatch(/^To do \(Mark, by tomorrow\): make sure the battery charger/);
  });

  it("takes the person addressed even when they aren't on the roster", () => {
    const [p] = generateKeyPoints([{ s: 0, e: 6000, text: "Jordan, can you email the sponsor the thank-you letter by Monday?" }]);
    expect(p.text).toBe("To do (Jordan, by Monday): email the sponsor the thank-you letter.");
  });

  it("finds owners whose names start or end with a letter outside ASCII", () => {
    const roster = ["José", "Zoë", "Émile", "Alice"];
    const one = (text: string, r = roster) => generateKeyPoints([{ s: 0, e: 8000, text }], { roster: r })[0]?.text;
    expect(one("José will order the 312 RPM motors by Friday for the new drivetrain.")).toBe(
      "To do (José, by Friday): order the 312 RPM motors for the new drivetrain.",
    );
    expect(one("We need to ask Zoë to redo the notebook pages next week before judging.")).toMatch(/^To do \(Zoë, by next week\): /);
    expect(one("Émile is responsible for submitting the portfolio before Saturday.")).toMatch(/^To do \(Émile, before Saturday\): /);
    expect(one("Émile, can you print the poster for the qualifier by Friday?")).toBe("To do (Émile, by Friday): print the poster for the qualifier.");
    expect(one("The poster draft looks great, Émile, can you print it for the qualifier by Friday?")).toBe(
      "To do (Émile, by Friday): print it for the qualifier.",
    );
    // A name typed with a combining accent (NFD) matches the transcript's, and the other way round.
    expect(one("José will order the 312 RPM motors by Friday for the new drivetrain.", ["José"])).toMatch(/^To do \(José, by Friday\): /);
    expect(one("José will order the 312 RPM motors by Friday for the new drivetrain.", ["José"])).toMatch(/^To do \(José, by Friday\): /);
    // Still whole names only.
    expect(one("O'Neil will order the 312 RPM motors by Friday for the new drivetrain.", ["Neil"])).toBe(
      "To do (by Friday): O'Neil will order the 312 RPM motors for the new drivetrain.",
    );
  });

  it("doesn't take a plan as a to-do unless a team member is the one doing it", () => {
    const points = generateKeyPoints(
      [
        { s: 0, e: 6000, text: "Starting next week we'll meet Tuesday, Thursday and Saturday until the qualifier." },
        { s: 10_000, e: 16_000, text: "I'll be honest, the wiring on the old robot is a complete mess right now." },
      ],
      { roster: FTC_ROSTER },
    );
    expect(points.every((p) => p.kind === "point")).toBe(true);
  });
});

describe("replies", () => {
  // A 46-second build meeting as the live transcript wrote it in a real browser (Whisper, macOS `say` voices).
  const BUILD_MEETING = `[0:00] Okay everyone, let's get started with the build meeting.
[0:03] First, the intake.
[0:04] We tested the four bar intake and the roller intake on Saturday.
[0:09] The four bar intake picked up samples about twice as fast.
[0:12] I think we should go with it.
[0:15] Great.
[0:15] So we decided to go with the four bar intake for the qualifier.
[0:19] Next, motors.
[0:20] Alice, can you order the 312 rpm motors by Friday?
[0:25] Yes, I will order them today. We also need new wheels for the drivetrain.
[0:30] Important, the scrimmage is on October 31st, so the robot must be driving by next Thursday.
[0:37] Ethan, please print the new brackets this week, and remember to update the engineering notebook after every meeting.
[0:43] That's it. Thanks everyone.`;
  const segments = parseTranscriptLines(BUILD_MEETING).map((l) => ({ s: l.atMs ?? 0, text: l.text }));
  const points = generateKeyPoints(segments, { roster: ["Alice", "Ethan", "Ben", "Priya"] });

  it("folds a yes into the request it answers instead of writing a to-do of its own", () => {
    expect(find(points, "order them")).toBeUndefined();
    expect(points.filter((p) => p.kind === "action").map((p) => p.text)).toEqual([
      "To do (Alice, by Friday): order the 312 rpm motors.",
      "To do (Ethan, by this week): print the new brackets and remember to update the engineering notebook after every meeting.",
    ]);
    expect(find(points, "Decision:")).toEqual({
      atMs: 15_000,
      text: "Decision: we decided to go with the four bar intake for the qualifier.",
      kind: "decision",
    });
    expect(find(points, "scrimmage is on October 31st")?.atMs).toBe(30_000);
  });

  const lines = (...texts: string[]) => texts.map((text, i) => ({ s: i * 6000, e: i * 6000 + 5500, text }));
  const todos = (texts: string[], roster: string[] = []) =>
    generateKeyPoints(lines(...texts), { roster })
      .filter((p) => p.kind === "action")
      .map((p) => p.text);

  it("gives the request the reply's deadline when it had none", () => {
    expect(todos(["Alice, can you order the 312 rpm motors for the drivetrain?", "Sure, I will order them by Friday."], ["Alice"])).toEqual([
      "To do (Alice, by Friday): order the 312 rpm motors for the drivetrain.",
    ]);
    expect(todos(["Alice, can you order the 312 rpm motors by Friday?", "Yes, I'll order the 312 rpm motors tomorrow."], ["Alice"])).toEqual([
      "To do (Alice, by Friday): order the 312 rpm motors.",
    ]);
  });

  it("drops a bare yes, but keeps a reply that adds something and a plan said out of the blue", () => {
    expect(todos(["The drivetrain is done and the wiring looks clean now.", "Okay, I will order them today."])).toEqual([]);
    expect(todos(["Alice, can you order the 312 rpm motors by Friday?", "Yes, and I will also order the new wheels for the drivetrain."], ["Alice"])).toEqual([
      "To do (Alice, by Friday): order the 312 rpm motors.",
      "To do: I will also order the new wheels for the drivetrain.",
    ]);
    expect(todos(["The drivetrain is done and the wiring looks clean now.", "Okay, I'll order new mecanum wheels from goBILDA by Friday."])).toEqual([
      "To do (by Friday): I'll order new mecanum wheels from goBILDA.",
    ]);
    expect(todos(["Alice, can you print the brackets by Friday?", "Okay, we need to order more motors by Friday too."], ["Alice"])).toHaveLength(2);
  });
});

describe("edge cases", () => {
  it("returns nothing for an empty transcript, but keeps marks as placeholders", () => {
    expect(generateKeyPoints([])).toEqual([]);
    expect(generateKeyPoints([{ s: 0, text: "   " }], { marks: [90_000, 92_000, 400_000] })).toEqual([
      { atMs: 90_000, text: "Key moment.", kind: "point", marked: true },
      { atMs: 400_000, text: "Key moment.", kind: "point", marked: true },
    ]);
  });

  it("keeps a short transcript short", () => {
    const points = generateKeyPoints([
      { s: 0, e: 4000, text: "Quick sync today." },
      { s: 5000, e: 12_000, text: "We decided to use the blue alliance practice field layout from now on." },
      { s: 13_000, e: 15_000, text: "Okay, thanks." },
    ]);
    expect(points).toEqual([
      { atMs: 5000, text: "Decision: we decided to use the blue alliance practice field layout from now on.", kind: "decision" },
    ]);
  });

  it("attaches a mark to the sentence that just finished, not the one starting", () => {
    const segments = [
      { s: 0, e: 5000, text: "The new battery mount fits perfectly under the control hub." },
      { s: 5200, e: 10_000, text: "Anyway, does anybody know where the zip ties went?" },
    ];
    const points = generateKeyPoints(segments, { marks: [5600], max: 1 });
    expect(points).toEqual([{ atMs: 0, text: "The new battery mount fits perfectly under the control hub.", kind: "point", marked: true }]);
  });

  it("joins a sentence cut between segments (a live window's edge, the 40-word cap)", () => {
    const points = generateKeyPoints(
      [
        { s: 41_000, e: 55_000, text: "From now on, nobody pushes to the main branch without a review. Ben, you are in charge of the notebook, so please write up the intake comparison" },
        { s: 55_000, e: 62_000, text: "with photos by next Wednesday. Thanks everyone, good meeting." },
      ],
      { roster: ["Ben"] },
    );
    expect(find(points, "intake comparison")?.text).toBe(
      "To do (Ben, by next Wednesday): you are in charge of the notebook, so please write up the intake comparison with photos.",
    );
  });

  it("splits long unpunctuated speech so a sentence can't swallow the meeting", () => {
    const run = Array.from({ length: 200 }, (_, i) => (i % 25 === 0 ? "intake" : `word${i}`)).join(" ");
    const points = generateKeyPoints([{ s: 0, e: 80_000, text: run }]);
    for (const p of points) expect(p.text.length).toBeLessThanOrEqual(220);
  });
});

describe("cleanBulletText", () => {
  it("drops openers, fillers and stutters, and punctuates", () => {
    expect(cleanBulletText("So, um, we need to, you know, test the the intake")).toBe("We need to test the intake.");
    expect(cleanBulletText("okay yeah the arm works now?")).toBe("The arm works now?");
    expect(cleanBulletText("  ,,, ")).toBe("");
    expect(cleanBulletText(`The drivetrain ${"really ".repeat(80)}works`).length).toBeLessThanOrEqual(220);
  });
});

describe("mergeKeyPoints", () => {
  const extractive = generateKeyPoints(FTC_MEETING, { roster: FTC_ROSTER, marks: FTC_MARKS });
  const bullets = [
    "**The team decided to go with the four-bar intake for the scrimmage.**",
    "Autonomous drives a square within one inch, but heading drift at fast turns needs PID tuning.",
    "The public library approved a robotics demo on November 8 and needs four volunteers.",
    "Practice moves to Tuesday, Thursday and Saturday until the scrimmage.",
    "Practice moves to Tuesday, Thursday and Saturday until the scrimmage!",
  ];
  const merged = mergeKeyPoints(bullets, extractive, FTC_MEETING);

  it("adds the summarizer's narrative, linked to where it was said", () => {
    expect(find(merged, "Autonomous drives")).toEqual({
      atMs: at(5, 25),
      text: "Autonomous drives a square within one inch, but heading drift at fast turns needs PID tuning.",
      kind: "point",
    });
    expect(find(merged, "Practice moves")?.atMs).toBe(at(15, 5));
  });

  it("keeps the extractive decisions, to-dos and marks, and drops near-duplicates", () => {
    expect(merged.filter((p) => p.text.includes("four-bar intake for the scrimmage"))).toHaveLength(1);
    expect(find(merged, "four-bar intake for the scrimmage")?.kind).toBe("decision");
    expect(merged.filter((p) => p.text.includes("library"))).toHaveLength(1);
    expect(merged.filter((p) => p.text.startsWith("Practice moves"))).toHaveLength(1);
    for (const p of extractive.filter((x) => x.kind !== "point" || x.marked)) expect(merged).toContainEqual(p);
    expect(merged.some((p) => p.text.includes("stronger servo"))).toBe(false); // plain extractive points give way
  });

  it("caps the list and sorts it by time, untimed points last", () => {
    const animals = "zebra quokka walrus heron bison lemur otter falcon gecko panda llama koala tapir moose raven".split(" ");
    const fruits = "mango kiwi papaya guava lychee fig plum pear date lime peach melon quince apricot olive".split(" ");
    const many = animals.map((a, i) => `The ${a} brought a ${fruits[i]} today.`);
    const capped = mergeKeyPoints(many, extractive, FTC_MEETING, { max: 12 });
    expect(capped).toHaveLength(12);
    const timed = capped.filter((p) => p.atMs !== null).map((p) => p.atMs as number);
    expect(timed).toEqual([...timed].sort((a, b) => a - b));
    expect(capped.findIndex((p) => p.atMs === null)).toBeGreaterThanOrEqual(timed.length);
  });

  it("returns the extractive list when there are no bullets", () => {
    expect(mergeKeyPoints([], extractive, FTC_MEETING)).toEqual(extractive);
    expect(mergeKeyPoints(["   ", "**"], extractive, FTC_MEETING)).toEqual(extractive);
  });
});
