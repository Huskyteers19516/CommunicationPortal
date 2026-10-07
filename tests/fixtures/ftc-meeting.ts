// A realistic transcript of a 17-minute Huskyteers build meeting, the way whole-file transcription segments it
// (one sentence per segment, ms from the start). It mixes what a recap needs — a design decision, assignments
// with owners and deadlines, emphasis, a new rule — with the chat around it (hex keys, snacks, "Right, right,
// right. Okay.") and Whisper's sign-off "Thank you.". Used by tests/meeting-recorder-key-points.test.ts.

export type FixtureSegment = { s: number; e: number; text: string };

const at = (min: number, sec: number) => (min * 60 + sec) * 1000;

const lines: [number, number, string][] = [
  [0, 0, "Okay, can everyone hear me in the back? Let's get started, we have a lot to cover today."],
  [0, 12, "So first, um, the scrimmage is on October 31 at Troy High School, and we need the robot driving well before then."],
  [0, 31, "That's two and a half weeks from now, so it's tight."],
  [0, 45, "Yeah, I mean, last year we were still wiring the robot the night before, so let's not do that again."],
  [1, 2, "Okay, intake. Marcus, can you walk us through the two prototypes?"],
  [1, 10, "Sure. So we built the roller intake and the four-bar intake over the weekend."],
  [1, 24, "The roller intake grabs the samples really fast, but it jams when two samples come in at once."],
  [1, 41, "The four-bar intake is slower, maybe half a second per cycle, but it never jammed in like forty tries."],
  [2, 2, "Did you test it with the new compliant wheels?"],
  [2, 8, "Not yet, the compliant wheels are still in the box from AndyMark."],
  [2, 20, "Honestly, I think jamming is the bigger risk at a scrimmage, because one jam basically ends the match for us."],
  [2, 38, "Right, right, right. Okay."],
  [2, 45, "So after looking at both prototypes, we decided to go with the four-bar intake for the scrimmage."],
  [3, 2, "We can still revisit the roller design after the scrimmage if we have time."],
  [3, 20, "The important thing is that the four-bar needs a stronger servo, because the current one stalls at full extension."],
  [3, 44, "Alice, can you order the 312 RPM motors and two more torque servos by Friday?"],
  [3, 55, "Yep, I'll put them on the order list tonight."],
  [4, 5, "Check the budget first, we spent a lot on the odometry pods last month."],
  [4, 20, "We have about four hundred dollars left in the build budget for October."],
  [4, 34, "Wait, who took the hex keys? I can't find any of them."],
  [4, 40, "Haha, they're always in the bottom drawer."],
  [5, 0, "Moving on to software. Priya, how's autonomous going?"],
  [5, 6, "So the odometry pods are working, and the robot can drive a square and come back within about one inch."],
  [5, 25, "The problem is the heading drifts when the robot turns fast, so I want to tune the heading PID this week."],
  [5, 45, "I need the drivetrain for at least two hours on Saturday to tune it properly."],
  [6, 0, "Okay, Saturday morning the drivetrain belongs to software."],
  [6, 15, "Also, everybody pull the latest code before you change anything, we had a merge conflict last week that broke tele-op."],
  [6, 35, "From now on, nobody pushes to the main branch without a code review from Priya or Will."],
  [6, 55, "That's fair."],
  [7, 5, "Um, so, uh, like, what about the camera? Are we doing the camera this year?"],
  [7, 15, "The camera is a stretch goal. Let's get the basic autonomous working first."],
  [8, 0, "Did anyone bring snacks today?"],
  [8, 4, "No, but there's pizza on Friday."],
  [9, 0, "Next thing, the engineering notebook."],
  [9, 5, "Judges at the scrimmage won't score it, but the qualifier in November definitely will."],
  [9, 20, "Ben, you're in charge of the engineering notebook, so please write up the intake comparison with photos by next Wednesday."],
  [9, 40, "Sure, I'll need the test numbers from Marcus."],
  [9, 50, "I'll send you the spreadsheet after the meeting."],
  [10, 10, "Don't forget, every notebook entry needs a date and who worked on it, the judges really care about that."],
  [12, 0, "Outreach. Grace, you had an update?"],
  [12, 5, "Yes, the public library said yes to the robotics demo on November 8."],
  [12, 20, "We need four volunteers and a working robot, even the old one from last season is fine."],
  [12, 40, "Sign up on the portal by next Monday if you can come."],
  [13, 0, "Can we bring the old robot? It still has the broken arm."],
  [13, 10, "We can bring it, just zip tie the arm down."],
  [15, 0, "Last thing, the practice schedule."],
  [15, 5, "Starting next week we'll meet Tuesday, Thursday and Saturday until the scrimmage."],
  [15, 22, "Drive practice is Thursday after school, and the drive team should be there every single time."],
  [15, 40, "We agreed that Will and Grace are the drivers for the scrimmage, with Ben as the backup."],
  [16, 0, "Will, can you set up the practice field in the garage before Thursday?"],
  [16, 10, "Yeah, I'll do it Wednesday night."],
  [16, 20, "Okay, I think that's everything. Thanks everyone, good meeting."],
  [16, 30, "Thank you."],
];

export const FTC_MEETING: FixtureSegment[] = lines.map(([m, s, text], i) => {
  const next = lines[i + 1];
  const start = at(m, s);
  const end = next ? Math.min(at(next[0], next[1]), start + Math.max(2000, text.split(" ").length * 380)) : start + 2000;
  return { s: start, e: end, text };
});

/** First names of the team's active members (the recorder gets these from getMeetingRecorderSetup). */
export const FTC_ROSTER = ["Alice", "Ben", "Priya", "Will", "Marcus", "Grace", "Jordan"];

/** "Mark key moment" pressed right after Grace's library news. */
export const FTC_MARKS = [at(12, 12)];

export { at as fixtureTime };

/**
 * A saved transcript exactly as the recorder made it: a one-minute meeting read by macOS `say`, transcribed in the
 * browser by whisper-base.en through transcribeBlob. Note Whisper's comma splices ("…full extension, Alice, can
 * you order…") and its spelling of numbers ("October 31st", "312 RPM", "1 inch").
 */
export const WHISPER_SHORT_TRANSCRIPT = `[0:00] Okay, let's get started.
[0:02] The scrimmage is on October 31st at Troy High School, so we need the robot driving well before then.
[0:08] Marcus built two intake prototypes over the weekend.
[0:11] The roller intake is fast, but it jams when two samples come in at once.
[0:15] The four bar intake is slower, but it never jammed in 40 tries.
[0:19] So after looking at both prototypes, we decided to go with the four bar intake for the scrimmage.
[0:25] The important thing is that the 4-bar needs a stronger servo, because the current one stalls at full extension, Alice, can you order the 312 RPM motors and two more torque servos by Friday?
[0:37] Moving on to software, the odometry pods are working, and the robot can drive a square and come back within about 1 inch.
[0:44] The heading drifts when the robot turns fast, so Priya will tune the heading controller this week.
[0:49] From now on, nobody pushes to the main branch without a code review, Ben, you are in charge of the engineering notebook, so please write up the intake comparison with photos by next Wednesday.
[1:00] Thanks everyone, good meeting.`;
