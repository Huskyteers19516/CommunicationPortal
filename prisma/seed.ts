// Demo data for local development: a realistic Huskyteers team with tasks, checklists, and questions.
//
//   npm run db:seed              # empty local database only
//   npm run db:seed -- --reset   # wipe every app row first (localhost only)
//
// Safety: refuses when NODE_ENV=production, and refuses non-localhost databases unless --force-remote.
// Importing this file has no side effects — tests call `seed(db, options)` directly.
//
// Keep this file free of `server-only` and next/* imports: it runs under plain tsx.
import { config as loadEnv } from "dotenv";
import type { Prisma } from "../src/generated/prisma/client";
import type { AccountStatus, AssignmentStatus, Priority, QuestionStatus, Role, Subteam } from "../src/generated/prisma/enums";
import { ROLE_LABELS, STATUS_LABELS, SUBTEAM_LABELS } from "../src/lib/constants";
import { addDays, dateOnlyToDb, type DateOnly, formatDateOnly, todayInTimezone } from "../src/lib/dates";
import { hashPassword } from "../src/server/auth/password";
import { createPrismaClient, type Db } from "../src/server/db";

export const DEMO_PASSWORD = "huskyteers123";
const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:54329/portal";
const DEFAULT_TIMEZONE = "America/Los_Angeles";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Tx = Prisma.TransactionClient;

/** The seed declined to run (e.g. the database already has users). Nothing was changed. */
export class SeedRefusedError extends Error {}

export interface SeedOptions {
  /** Delete every app row before seeding. Callers must only allow this on local databases. */
  reset?: boolean;
  /** Team timezone used to work out "today" (default America/Los_Angeles). */
  timezone?: string;
  /** Clock override for deterministic tests. */
  now?: Date;
  /** Password for every demo account (default "huskyteers123"). */
  password?: string;
}

export interface SeedCredential {
  name: string;
  email: string;
  position: string;
  status: AccountStatus;
}

export interface SeedResult {
  today: DateOnly;
  password: string;
  counts: { users: number; tasks: number; assignments: number; questions: number; replies: number; categories: number };
  credentials: SeedCredential[];
}

// ── The team ──────────────────────────────────────────────────────────────────

interface PersonSpec {
  name: string;
  email?: string;
  role: Role;
  subteam: Subteam | null;
  status?: AccountStatus;
  isAdmin?: boolean;
  joinedDaysAgo: number;
  /** Hours since last visit; omitted = never signed in. */
  seenHoursAgo?: number;
  emailOnAssigned?: boolean;
}

const PEOPLE = {
  jordan: { name: "Jordan Lee", email: "admin@example.com", role: "CAPTAIN", subteam: null, isAdmin: true, joinedDaysAgo: 62, seenHoursAgo: 1 },
  priya: { name: "Priya Raman", role: "SOFTWARE_LEADER", subteam: "SOFTWARE", joinedDaysAgo: 58, seenHoursAgo: 2 },
  marcus: { name: "Marcus Johnson", role: "BUILD_LEADER", subteam: "BUILD", joinedDaysAgo: 57, seenHoursAgo: 3 },
  sofia: { name: "Sofia Hernandez", role: "BUILD_LEADER", subteam: "BUILD", joinedDaysAgo: 56, seenHoursAgo: 20 },
  kenji: { name: "Kenji Watanabe", role: "BUILD_LEADER", subteam: "BUILD", joinedDaysAgo: 41, seenHoursAgo: 6 },
  amara: { name: "Amara Okafor", role: "BUSINESS_LEADER", subteam: "BUSINESS", joinedDaysAgo: 55, seenHoursAgo: 4 },
  elena: { name: "Elena Petrova", role: "MENTOR", subteam: null, joinedDaysAgo: 60, seenHoursAgo: 26 },
  david: { name: "David Kim", role: "TEACHER", subteam: null, joinedDaysAgo: 61, seenHoursAgo: 5 },

  aiden: { name: "Aiden Nguyen", role: "MEMBER", subteam: "SOFTWARE", joinedDaysAgo: 50, seenHoursAgo: 7 },
  maya: { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE", joinedDaysAgo: 49, seenHoursAgo: 3, emailOnAssigned: true },
  lucas: { name: "Lucas Silva", role: "MEMBER", subteam: "SOFTWARE", joinedDaysAgo: 47, seenHoursAgo: 30 },
  chloe: { name: "Chloe Martin", role: "MEMBER", subteam: "SOFTWARE", joinedDaysAgo: 35, seenHoursAgo: 9 },
  omar: { name: "Omar Haddad", role: "MEMBER", subteam: "SOFTWARE", joinedDaysAgo: 21, seenHoursAgo: 72 },

  ethan: { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD", joinedDaysAgo: 52, seenHoursAgo: 2 },
  isabella: { name: "Isabella Rossi", role: "MEMBER", subteam: "BUILD", joinedDaysAgo: 51, seenHoursAgo: 5 },
  liam: { name: "Liam O'Connor", role: "MEMBER", subteam: "BUILD", joinedDaysAgo: 44, seenHoursAgo: 28 },
  zara: { name: "Zara Ahmed", role: "MEMBER", subteam: "BUILD", joinedDaysAgo: 40, seenHoursAgo: 8, emailOnAssigned: true },
  mateo: { name: "Mateo Garcia", role: "MEMBER", subteam: "BUILD", joinedDaysAgo: 33, seenHoursAgo: 50 },
  hannah: { name: "Hannah Schmidt", role: "MEMBER", subteam: "BUILD", joinedDaysAgo: 18, seenHoursAgo: 4 },

  ava: { name: "Ava Thompson", role: "MEMBER", subteam: "BUSINESS", joinedDaysAgo: 53, seenHoursAgo: 6 },
  daniel: { name: "Daniel Park", role: "MEMBER", subteam: "BUSINESS", joinedDaysAgo: 46, seenHoursAgo: 10 },
  leila: { name: "Leila Hosseini", role: "MEMBER", subteam: "BUSINESS", joinedDaysAgo: 39, seenHoursAgo: 48 },
  grace: { name: "Grace Liu", role: "MEMBER", subteam: "BUSINESS", joinedDaysAgo: 30, seenHoursAgo: 12 },
  samuel: { name: "Samuel Adeyemi", role: "MEMBER", subteam: "BUSINESS", joinedDaysAgo: 14, seenHoursAgo: 96 },

  // Waiting for the admin (a 4th build leader shows the seat-limit warning).
  tyler: { name: "Tyler Brooks", role: "BUILD_LEADER", subteam: "BUILD", status: "PENDING", joinedDaysAgo: 1 },
  rachel: { name: "Rachel Goldberg", role: "MENTOR", subteam: null, status: "PENDING", joinedDaysAgo: 0 },
  // Left the team.
  noah: { name: "Noah Fischer", role: "MEMBER", subteam: "BUILD", status: "DISABLED", joinedDaysAgo: 59, seenHoursAgo: 24 * 20 },
} satisfies Record<string, PersonSpec>;

type PersonKey = keyof typeof PEOPLE;

const MEMBERS: PersonKey[] = [
  "aiden", "maya", "lucas", "chloe", "omar",
  "ethan", "isabella", "liam", "zara", "mateo", "hannah",
  "ava", "daniel", "leila", "grace", "samuel",
];
const SUBTEAM_LEADERS: PersonKey[] = ["priya", "marcus", "sofia", "kenji", "amara"];

function emailFor(key: PersonKey): string {
  const p: PersonSpec = PEOPLE[key];
  if (p.email) return p.email;
  const [first, ...rest] = p.name.toLowerCase().replace(/[^a-z ]/g, "").split(" ");
  return `${first}.${rest.join("")}@example.com`;
}

function positionFor(p: PersonSpec): string {
  const base = p.role === "MEMBER" && p.subteam ? `${SUBTEAM_LABELS[p.subteam]} member` : ROLE_LABELS[p.role];
  return p.isAdmin ? `${base} + admin` : base;
}

// ── Tasks & checklist items ───────────────────────────────────────────────────

interface AssignmentSpec {
  who: PersonKey;
  status: AssignmentStatus;
  submissionNote?: string;
  reviewNote?: string;
  /** Signed themselves up on the Task dashboard. */
  self?: boolean;
}

const todo = (who: PersonKey): AssignmentSpec => ({ who, status: "TODO" });
const signedUp = (who: PersonKey): AssignmentSpec => ({ who, status: "TODO", self: true });
const submitted = (who: PersonKey, submissionNote?: string): AssignmentSpec => ({ who, status: "SUBMITTED", submissionNote });
const approved = (who: PersonKey, submissionNote?: string, reviewNote?: string): AssignmentSpec => ({
  who,
  status: "APPROVED",
  submissionNote,
  reviewNote,
});
const sentBack = (who: PersonKey, reviewNote: string, submissionNote?: string): AssignmentSpec => ({
  who,
  status: "REJECTED",
  submissionNote,
  reviewNote,
});

interface TaskSpec {
  title: string;
  description: string;
  subteam: Subteam | null;
  /** Due date relative to today (team timezone). */
  day: number;
  priority?: Priority;
  creator: PersonKey;
  assignments: AssignmentSpec[];
  /** Task dashboard category (see CATEGORIES); defaults to TASK_CATEGORY[title]. */
  category?: string;
  signupOpen?: boolean;
  signupLimit?: number;
}

// ── Task dashboard categories ─────────────────────────────────────────────────

const CATEGORIES: { subteam: Subteam | null; creator: PersonKey; names: string[] }[] = [
  { subteam: "SOFTWARE", creator: "priya", names: ["Autonomous", "TeleOp", "Vision", "Tools"] },
  { subteam: "BUILD", creator: "marcus", names: ["Intake", "Outtake", "Drivetrain", "Lift", "CAD & Design"] },
  { subteam: "BUSINESS", creator: "amara", names: ["Outreach", "Sponsors", "Portfolio", "Social media"] },
  { subteam: null, creator: "jordan", names: ["Events", "Competition"] },
];

/** Where the tasks in buildTasks() are sorted. A few stay uncategorized on purpose ("Other tasks"). */
const TASK_CATEGORY: Record<string, string> = {
  "Set up Android Studio and pull the latest robot code": "Tools",
  "Write the autonomous path for the left start position": "Autonomous",
  "Tune the drivetrain PID and log the results": "Autonomous",
  "Review the vision pipeline pull request": "Vision",
  "Add telemetry for the lift encoder positions": "TeleOp",
  "Document the TeleOp controls for the drive team": "TeleOp",
  "Rebuild the intake roller with new surgical tubing": "Intake",
  "Replace the worn chain on the lift": "Lift",
  "CAD the new outtake bracket in Onshape": "CAD & Design",
  "Print 4 spare TPU wheels": "Drivetrain",
  "Drive practice: 10 full match cycles": "Drivetrain",
  "Email three local sponsors with our sponsorship packet": "Sponsors",
  "Draft the outreach section of the engineering portfolio": "Portfolio",
  "Post the scrimmage recap on Instagram": "Social media",
  "Plan the elementary school robotics demo": "Outreach",
  "Turn in the league meet permission slip": "Competition",
  "Finalize the drive team lineup for the league meet": "Competition",
  "Read the Game Manual Part 2 update (Q&A 41–58)": "Competition",
  "Pack the pit for the league meet": "Competition",
};

/** Tasks people sign themselves up for on the Task dashboard. */
function buildSignupTasks(): TaskSpec[] {
  return [
    {
      title: "Help machine the new outtake plates",
      description: "Three people on the mill with Sofia. Bring safety glasses; we'll cut both plates in one session.",
      subteam: "BUILD",
      day: 4,
      creator: "marcus",
      category: "Outtake",
      signupOpen: true,
      signupLimit: 3,
      assignments: [signedUp("liam"), signedUp("hannah")],
    },
    {
      title: "Run the drivetrain test cycles",
      description: "Run 20 full-speed cycles and write down anything that rattles or gets hot.",
      subteam: "BUILD",
      day: 2,
      creator: "kenji",
      category: "Drivetrain",
      signupOpen: true,
      signupLimit: 2,
      assignments: [todo("mateo"), signedUp("ethan")],
    },
    {
      title: "Test the new vision code on the practice field",
      description: "Try detection from every starting tile and note where it misses. Anyone on Software can help.",
      subteam: "SOFTWARE",
      day: 3,
      creator: "priya",
      category: "Vision",
      signupOpen: true,
      assignments: [signedUp("chloe")],
    },
    {
      title: "Volunteer at the league meet check-in table",
      description: "Greet teams, hand out pit maps, and answer questions for one hour. Six volunteers needed.",
      subteam: null,
      day: 5,
      creator: "jordan",
      category: "Events",
      signupOpen: true,
      signupLimit: 6,
      assignments: [signedUp("aiden"), signedUp("ava"), signedUp("isabella")],
    },
  ];
}

function buildTasks(): TaskSpec[] {
  // Whole-team permission slip: everyone but the adults, mostly turned in.
  const slip = [...SUBTEAM_LEADERS, ...MEMBERS].map((who): AssignmentSpec => {
    if (who === "omar" || who === "samuel") return todo(who);
    if (who === "mateo") return submitted(who, "Gave it to Mr. Kim this morning.");
    return approved(who);
  });
  // Hours log due today: a realistic mix.
  const hours = MEMBERS.map((who, i): AssignmentSpec =>
    i % 3 === 0 ? approved(who) : i % 3 === 1 ? submitted(who, i === 1 ? "4.5 hours this week." : undefined) : todo(who),
  );

  return [
    // Software (Priya)
    {
      title: "Set up Android Studio and pull the latest robot code",
      description: "Install Android Studio, clone the team repo, and make sure TeamCode builds. Ping me if Gradle fights you.",
      subteam: "SOFTWARE",
      day: -6,
      creator: "priya",
      assignments: [approved("aiden"), approved("maya"), approved("lucas"), approved("chloe", undefined, "Nice — you're all set."), approved("omar")],
    },
    {
      title: "Write the autonomous path for the left start position",
      description: "Use Pedro Pathing. Score the preload, then park. Upload a video of three clean runs to the team Drive.",
      subteam: "SOFTWARE",
      day: -4,
      priority: "HIGH",
      creator: "priya",
      assignments: [
        approved("aiden", "Video is in the Drive: auto-left-v2.mp4", "Clean runs, great job."),
        sentBack("lucas", "The path clips the truss on the second curve. Re-tune the heading and send a new video.", "Works most of the time!"),
        approved("maya"),
      ],
    },
    {
      title: "Tune the drivetrain PID and log the results",
      description: "Write down every kP / kI / kD you tried and the final numbers in the tuning sheet.",
      subteam: "SOFTWARE",
      day: -2,
      creator: "priya",
      assignments: [approved("omar", "Final values are in the sheet, tab 3."), todo("chloe")],
    },
    {
      title: "Review the vision pipeline pull request",
      description: "Read through the PR, leave comments, and test it on the practice bot if it's free.",
      subteam: "SOFTWARE",
      day: 0,
      creator: "priya",
      assignments: [
        submitted("maya", "Left 4 comments on the PR. The threshold values look off in low light."),
        todo("aiden"),
        todo("chloe"),
        approved("lucas", "Tested on the practice bot — detection works at 3 ft."),
      ],
    },
    {
      title: "Add telemetry for the lift encoder positions",
      description: "Show target vs. actual ticks for both lift motors on the Driver Hub.",
      subteam: "SOFTWARE",
      day: 2,
      creator: "priya",
      assignments: [todo("omar"), todo("lucas")],
    },
    {
      title: "Document the TeleOp controls for the drive team",
      description: "One page with a gamepad diagram. Put it in the Drive under Drive Team.",
      subteam: "SOFTWARE",
      day: 5,
      priority: "LOW",
      creator: "priya",
      assignments: [todo("maya"), todo("aiden")],
    },

    // Build (Marcus, Sofia, Kenji)
    {
      title: "Rebuild the intake roller with new surgical tubing",
      description: "Swap all the tubing on the roller and check the zip ties. Old tubing goes in the scrap bin.",
      subteam: "BUILD",
      day: -5,
      priority: "HIGH",
      creator: "marcus",
      assignments: [
        approved("ethan"),
        approved("isabella", "Rebuilt and tested — no slipping."),
        sentBack("liam", "The tubing on the left side is loose. Tighten it and send a photo.", "Done, rebuilt both sides."),
        approved("mateo"),
      ],
    },
    {
      title: "Inventory the REV and goBILDA parts bins",
      description: "Count what's left and update the parts sheet. Flag anything we have fewer than 4 of.",
      subteam: "BUILD",
      day: -3,
      creator: "sofia",
      assignments: [approved("zara", "Sheet updated. We're low on 5 mm hex shafts."), approved("hannah"), todo("mateo")],
    },
    {
      title: "Cable-manage the control hub and label every port",
      description: "Use the label maker. Every motor and servo cable gets a label on both ends.",
      subteam: "BUILD",
      day: -1,
      creator: "kenji",
      assignments: [approved("ethan"), submitted("isabella", "Labeled everything. Photo is in the Drive."), todo("liam")],
    },
    {
      title: "Replace the worn chain on the lift",
      description: "The lift chain skipped twice at the scrimmage. Replace it and re-tension it. Safety glasses on!",
      subteam: "BUILD",
      day: 0,
      priority: "HIGH",
      creator: "marcus",
      assignments: [todo("zara"), submitted("hannah", "New chain is on and tension is checked."), submitted("sofia", "Replaced and ran 20 lift cycles.")],
    },
    {
      title: "CAD the new outtake bracket in Onshape",
      description: 'Base it on the v2 sketch. 1/8" aluminum, two mounting holes per side.',
      subteam: "BUILD",
      day: 0,
      creator: "sofia",
      assignments: [submitted("isabella", "v3 is in the team Onshape folder."), todo("mateo")],
    },
    {
      title: "Print 4 spare TPU wheels",
      description: "Use the 95A TPU profile. Check the first layer before you walk away.",
      subteam: "BUILD",
      day: 3,
      priority: "LOW",
      creator: "kenji",
      assignments: [todo("ethan"), todo("hannah")],
    },
    {
      title: "Drive practice: 10 full match cycles",
      description: "Driver + coach pairs. Log cycle times in the practice sheet.",
      subteam: "BUILD",
      day: 6,
      creator: "marcus",
      assignments: [todo("liam"), todo("zara"), todo("mateo")],
    },

    // Business (Amara)
    {
      title: "Email three local sponsors with our sponsorship packet",
      description: "Use the updated packet (v4) in the Drive and CC Amara on every email.",
      subteam: "BUSINESS",
      day: -6,
      priority: "HIGH",
      creator: "amara",
      assignments: [
        approved("ava", "Emailed Anaheim Hardware, OC Machining, and PCB Express."),
        approved("daniel"),
        sentBack("leila", "Please use the updated packet (v4) and CC me, then resend.", "Sent to two sponsors."),
        approved("grace"),
      ],
    },
    {
      title: "Draft the outreach section of the engineering portfolio",
      description: "Half a page. Include the library demo and the scrimmage volunteer hours.",
      subteam: "BUSINESS",
      day: -2,
      creator: "amara",
      assignments: [approved("grace", undefined, "Great draft — love the photos."), submitted("samuel", "Draft is on page 7 of the portfolio doc."), todo("leila")],
    },
    {
      title: "Post the scrimmage recap on Instagram",
      description: "3–5 photos, tag our sponsors, and get the caption approved by a leader first.",
      subteam: "BUSINESS",
      day: 0,
      creator: "amara",
      assignments: [submitted("ava", "Posted! Amara approved the caption in chat."), todo("daniel")],
    },
    {
      title: "Plan the elementary school robotics demo",
      description: "Pick a date with Ms. Rivera, book the gym, and list which robots we'll bring.",
      subteam: "BUSINESS",
      day: 4,
      creator: "amara",
      assignments: [todo("leila"), todo("samuel"), todo("grace")],
    },

    // Whole team (captain, mentor, teacher)
    {
      title: "Turn in the league meet permission slip",
      description: "Signed by a parent or guardian. Drop it in the folder on Mr. Kim's desk.",
      subteam: null,
      day: -3,
      priority: "HIGH",
      creator: "jordan",
      assignments: slip,
    },
    {
      title: "Finalize the drive team lineup for the league meet",
      description: "Pick a driver, operator, and coach plus one backup, and share it with the mentors.",
      subteam: null,
      day: -1,
      creator: "elena",
      assignments: [submitted("jordan", "Driver: Ethan · Operator: Zara · Coach: Jordan · Backup: Liam.")],
    },
    {
      title: "Log this week's shop hours",
      description: "Add your hours to the attendance sheet before you leave today.",
      subteam: null,
      day: 0,
      creator: "david",
      assignments: hours,
    },
    {
      title: "Read the Game Manual Part 2 update (Q&A 41–58)",
      description: "Skim the new rulings and bring one question to Thursday's meeting.",
      subteam: null,
      day: 1,
      creator: "elena",
      // The captain and every subteam leader, plus a few members.
      assignments: (["jordan", ...SUBTEAM_LEADERS, "aiden", "ethan", "ava", "zara"] as PersonKey[]).map((who) => todo(who)),
    },
    {
      title: "Pack the pit for the league meet",
      description: "Follow the pit checklist: charged batteries, spare parts box, tools, banner, and extension cords.",
      subteam: null,
      day: 6,
      priority: "HIGH",
      creator: "jordan",
      assignments: [todo("kenji"), todo("marcus"), todo("isabella"), todo("daniel")],
    },
  ];
}

// ── Questions ─────────────────────────────────────────────────────────────────

interface QuestionSpec {
  title: string;
  body: string;
  asker: PersonKey;
  recipient?: PersonKey;
  subteam: Subteam | null;
  /** Title of the task it's about. */
  task?: string;
  status: QuestionStatus;
  askedHoursAgo: number;
  replies: { author: PersonKey; body: string; hoursAgo: number }[];
}

const QUESTIONS: QuestionSpec[] = [
  {
    title: "Which branch should the vision changes go on?",
    body: "Should I branch off main or off scrimmage-fixes? The PR is based on scrimmage-fixes.",
    asker: "maya",
    subteam: "SOFTWARE",
    task: "Review the vision pipeline pull request",
    status: "OPEN",
    askedHoursAgo: 3,
    replies: [],
  },
  {
    title: "Where are the spare #25 chain links?",
    body: "I want extras ready before we replace the lift chain, but I couldn't find them on the parts wall.",
    asker: "ethan",
    recipient: "marcus",
    subteam: "BUILD",
    task: "Replace the worn chain on the lift",
    status: "ANSWERED",
    askedHoursAgo: 6,
    replies: [{ author: "marcus", body: "Top drawer of the red toolbox, in the bag labeled \"chain\". Grab two master links too.", hoursAgo: 2 }],
  },
  {
    title: "Can we put the team logo on the sponsor thank-you cards?",
    body: "I'd like to print cards for the sponsors who replied. Is the logo OK to use, and is there a high-res version?",
    asker: "ava",
    subteam: "BUSINESS",
    status: "RESOLVED",
    askedHoursAgo: 50,
    replies: [
      { author: "amara", body: "Yes! Use the PNG in Drive → Branding → Logos. Keep it green — please don't recolor it.", hoursAgo: 46 },
      { author: "ava", body: "Perfect, thank you!", hoursAgo: 45 },
    ],
  },
  {
    title: "Can I use the drill press for the new bracket holes?",
    body: "The outtake bracket needs two new holes in the aluminum channel. Does a mentor need to be there when I use the drill press?",
    asker: "liam",
    recipient: "elena",
    subteam: "BUILD",
    status: "OPEN",
    askedHoursAgo: 5,
    replies: [],
  },
  {
    title: "What time does the bus leave for the league meet?",
    body: "My parents need to know when to drop me off.",
    asker: "zara",
    subteam: null,
    status: "ANSWERED",
    askedHoursAgo: 20,
    replies: [{ author: "jordan", body: "6:45 AM from the school parking lot. Please be there by 6:30 with your permission slip turned in!", hoursAgo: 18 }],
  },
  {
    title: "RoadRunner or Pedro Pathing for the left auto?",
    body: "I've used RoadRunner before, but the rest of our code uses Pedro. Which one should I use?",
    asker: "lucas",
    recipient: "priya",
    subteam: "SOFTWARE",
    task: "Write the autonomous path for the left start position",
    status: "RESOLVED",
    askedHoursAgo: 120,
    replies: [
      { author: "priya", body: "Stick with Pedro so it matches the rest of the codebase. The tuning guide is pinned in the software channel.", hoursAgo: 117 },
      { author: "elena", body: "+1. Tune the follower before you start on the path — it saves a lot of time.", hoursAgo: 110 },
      { author: "lucas", body: "Got it, switching to Pedro. Thanks!", hoursAgo: 108 },
    ],
  },
  {
    title: "Could I get a letter confirming my volunteer hours?",
    body: "I need it for my school service hours — it's for the library demo.",
    asker: "daniel",
    recipient: "david",
    subteam: "BUSINESS",
    status: "OPEN",
    askedHoursAgo: 30,
    replies: [
      { author: "david", body: "Of course. Which dates did you volunteer?", hoursAgo: 26 },
      { author: "daniel", body: "September 13 and September 20, about 3 hours each.", hoursAgo: 25 },
    ],
  },
  {
    title: "I can't open the vision pull request",
    body: "GitHub says I don't have access to the repo. Can someone add me?",
    asker: "chloe",
    subteam: "SOFTWARE",
    task: "Review the vision pipeline pull request",
    status: "ANSWERED",
    askedHoursAgo: 9,
    replies: [{ author: "priya", body: "Sent you an invite — accept it from your email, then refresh the PR.", hoursAgo: 8 }],
  },
];

/** A member's uploaded OpMode, shown on the Resources page (an approved file resource). */
const TELEOP_JAVA = `package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.eventloop.opmode.TeleOp;
import com.qualcomm.robotcore.hardware.DcMotor;

@TeleOp(name = "TeleOp Main", group = "Huskyteers")
public class TeleOpMain extends LinearOpMode {
    @Override
    public void runOpMode() {
        DcMotor left = hardwareMap.get(DcMotor.class, "leftDrive");
        DcMotor right = hardwareMap.get(DcMotor.class, "rightDrive");
        DcMotor intake = hardwareMap.get(DcMotor.class, "intake");
        right.setDirection(DcMotor.Direction.REVERSE);

        waitForStart();
        while (opModeIsActive()) {
            double drive = -gamepad1.left_stick_y;
            double turn = gamepad1.right_stick_x;
            left.setPower(drive + turn);
            right.setPower(drive - turn);
            // Right trigger pulls game pieces in, left trigger spits them out.
            intake.setPower(gamepad1.right_trigger - gamepad1.left_trigger);

            telemetry.addData("Drive", "%.2f", drive);
            telemetry.addData("Turn", "%.2f", turn);
            telemetry.update();
        }
    }
}
`;

// ── Parts queue ───────────────────────────────────────────────────────────────

interface PartSpec {
  name: string;
  process: Prisma.PartCreateManyInput["process"];
  quantity?: number;
  material: string;
  file?: string;
  notes?: string;
  /** A Build category (see CATEGORIES). */
  category?: string;
  /** Needed by, in days from today. */
  neededIn?: number;
  asker: PersonKey;
  askedHoursAgo: number;
  /** Grabbed ("I'll make it") by, hours ago. */
  maker?: { who: PersonKey; hoursAgo: number };
  /** Marked done, hours ago (after being grabbed). */
  doneHoursAgo?: number;
}

/** Parts that aren't done are listed in queue order (the first gets made first). */
const PARTS: PartSpec[] = [
  {
    name: "Intake roller hub",
    process: "PRINT_3D",
    quantity: 4,
    material: "PETG",
    file: "https://cad.example.com/huskyteers/intake-roller-hub.stl",
    notes: "40% infill, 4 walls. Two of them are spares.",
    category: "Intake",
    neededIn: 1,
    asker: "ethan",
    askedHoursAgo: 20,
  },
  {
    name: "Outtake side plates",
    process: "LASER_CUT",
    quantity: 2,
    material: "1/8 in polycarbonate",
    file: "https://cad.example.com/huskyteers/outtake-side-plate.dxf",
    notes: "Mirror the second one.",
    category: "Outtake",
    neededIn: 3,
    asker: "marcus",
    askedHoursAgo: 30,
    maker: { who: "isabella", hoursAgo: 5 },
  },
  {
    name: "Drivetrain motor mount",
    process: "CNC",
    quantity: 2,
    material: "1/4 in aluminum (6061)",
    file: "https://cad.example.com/huskyteers/drivetrain-motor-mount.step",
    category: "Drivetrain",
    neededIn: 6,
    asker: "kenji",
    askedHoursAgo: 48,
  },
  {
    name: "Lift string spool",
    process: "PRINT_3D",
    quantity: 2,
    material: "PLA",
    file: "https://cad.example.com/huskyteers/lift-spool.stl",
    category: "Lift",
    asker: "sofia",
    askedHoursAgo: 50,
    maker: { who: "liam", hoursAgo: 26 },
  },
  {
    name: "Lift extrusions cut to length",
    process: "CUT",
    quantity: 4,
    material: "goBILDA U-channel",
    notes: "Cut to 336 mm and deburr the ends.",
    category: "Lift",
    neededIn: 4,
    asker: "zara",
    askedHoursAgo: 8,
  },
  {
    name: "Axle spacers",
    process: "MACHINE",
    quantity: 8,
    material: "Delrin rod",
    notes: "8 mm bore, 5 mm long. The lathe is in the back room.",
    category: "Drivetrain",
    asker: "mateo",
    askedHoursAgo: 3,
  },
  {
    name: "Driver station phone holder",
    process: "PRINT_3D",
    material: "PLA",
    file: "https://cad.example.com/huskyteers/phone-holder.stl",
    asker: "ethan",
    askedHoursAgo: 72,
    maker: { who: "hannah", hoursAgo: 60 },
    doneHoursAgo: 40,
  },
  {
    name: "Intake flap",
    process: "OTHER",
    material: "Polycarbonate sheet, heat-bent",
    category: "Intake",
    asker: "marcus",
    askedHoursAgo: 120,
    maker: { who: "ethan", hoursAgo: 100 },
    doneHoursAgo: 90,
  },
];

function partRows(
  today: DateOnly,
  ago: (hours: number) => Date,
  uid: (key: PersonKey) => string,
  buildCategory: (name: string) => string,
): Prisma.PartCreateManyInput[] {
  let position = 0;
  return PARTS.map((p) => {
    const done = p.doneHoursAgo !== undefined;
    return {
      name: p.name,
      process: p.process,
      quantity: p.quantity ?? 1,
      material: p.material,
      fileUrl: p.file ?? "",
      notes: p.notes ?? "",
      categoryId: p.category ? buildCategory(p.category) : null,
      neededBy: p.neededIn === undefined ? null : dateOnlyToDb(addDays(today, p.neededIn)),
      position: done ? 0 : position++,
      status: done ? "DONE" : p.maker ? "CLAIMED" : "NEEDED",
      requestedById: uid(p.asker),
      claimedById: p.maker ? uid(p.maker.who) : null,
      claimedAt: p.maker ? ago(p.maker.hoursAgo) : null,
      doneAt: done ? ago(p.doneHoursAgo!) : null,
      createdAt: ago(p.askedHoursAgo),
    };
  });
}

// ── Sponsorships ──────────────────────────────────────────────────────────────

interface SponsorshipSpec {
  name: string;
  website?: string;
  contactName?: string;
  contactEmail?: string;
  asking?: string;
  amountReceived?: number;
  stage: Prisma.SponsorshipCreateManyInput["stage"];
  owner?: PersonKey;
  creator: PersonKey;
  /** Days from today. */
  submitted?: number;
  accepted?: number;
  closes?: number;
  notes?: string;
}

/** Demo asks in every stage: public company names with placeholder links and contacts (no real team info). */
const SPONSORSHIPS: SponsorshipSpec[] = [
  {
    name: "Polymaker",
    website: "https://sponsors.example.com/polymaker",
    contactEmail: "education@polymaker.example.com",
    asking: "10 spools of PLA filament",
    stage: "SUBMITTED",
    owner: "ava",
    creator: "ava",
    submitted: -9,
    notes: "Sent the packet and our season plan. They usually reply within 3 weeks.",
  },
  {
    name: "REV Robotics",
    website: "https://sponsors.example.com/rev-robotics",
    contactName: "Sponsorship team",
    contactEmail: "sponsors@rev.example.com",
    asking: "$500 in parts credit",
    amountReceived: 500,
    stage: "ACCEPTED",
    owner: "amara",
    creator: "amara",
    submitted: -24,
    accepted: -3,
    notes: "Send a thank-you card and tag them in our next post.",
  },
  {
    name: "Bambu Lab",
    website: "https://sponsors.example.com/bambu-lab",
    asking: "A1 mini printer for the build room",
    stage: "DO_SOON",
    owner: "daniel",
    creator: "daniel",
    closes: 4,
  },
  {
    name: "Boeing",
    website: "https://sponsors.example.com/boeing-stem",
    asking: "$2,500 STEM grant",
    stage: "IN_PROGRESS",
    owner: "leila",
    creator: "amara",
    closes: 12,
    notes: "Needs two letters of recommendation (ask Mr. Kim and Elena).",
  },
  { name: "Costco", asking: "Snacks and water for competition day", stage: "NOT_STARTED", creator: "grace", closes: 30 },
  {
    name: "Home Depot",
    website: "https://sponsors.example.com/home-depot",
    contactEmail: "community@homedepot.example.com",
    asking: "$750 gift card for tools and lumber",
    amountReceived: 750,
    stage: "FINISHED",
    owner: "ava",
    creator: "ava",
    submitted: -60,
    accepted: -41,
  },
  {
    name: "Lockheed Martin",
    website: "https://sponsors.example.com/lockheed-martin",
    asking: "$1,000 team grant",
    stage: "DECLINED",
    owner: "amara",
    creator: "amara",
    submitted: -35,
    notes: "They fund in the spring. Try again in February.",
  },
  {
    name: "Qualcomm",
    website: "https://sponsors.example.com/qualcomm",
    asking: "Robot parts sponsorship",
    stage: "NOT_STARTED",
    owner: "grace",
    creator: "grace",
    closes: -2,
    notes: "Missed this round. Check when the next one opens.",
  },
];

/** The "Info for applications" card (TeamNote "sponsorship-info"): placeholders only, never passwords. */
const SPONSORSHIP_INFO = [
  "Demo info: replace it with the team's details.",
  "Team address: 123 Example Ave, Anaheim, CA",
  "Person of contact: Amara Okafor (Business lead)",
  "Team email: team@example.com",
  "Sponsorship packet: https://docs.example.com/sponsorship-packet",
  "Grant list: https://docs.example.com/grant-list",
  "Instagram: @example_team",
].join("\n");

function sponsorshipRows(
  today: DateOnly,
  ago: (hours: number) => Date,
  uid: (key: PersonKey) => string,
): Prisma.SponsorshipCreateManyInput[] {
  const day = (n: number | undefined) => (n === undefined ? null : dateOnlyToDb(addDays(today, n)));
  return SPONSORSHIPS.map((s, i) => ({
    name: s.name,
    website: s.website ?? "",
    contactName: s.contactName ?? "",
    contactEmail: s.contactEmail ?? "",
    asking: s.asking ?? "",
    amountReceived: s.amountReceived ?? null,
    stage: s.stage,
    ownerId: s.owner ? uid(s.owner) : null,
    submittedOn: day(s.submitted),
    acceptedOn: day(s.accepted),
    closesOn: day(s.closes),
    notes: s.notes ?? "",
    createdById: uid(s.creator),
    // Added a few days before it was sent (or a couple of weeks ago).
    createdAt: ago(24 * Math.max(14, 3 - (s.submitted ?? 0)) + i),
  }));
}

// ── Seeding ───────────────────────────────────────────────────────────────────

/** Delete every app row, children first. */
async function wipeAppData(tx: Tx): Promise<void> {
  await tx.sponsorship.deleteMany();
  await tx.teamNote.deleteMany();
  await tx.part.deleteMany();
  await tx.resource.deleteMany();
  await tx.emailLog.deleteMany();
  await tx.rateLimit.deleteMany();
  await tx.questionReply.deleteMany();
  await tx.question.deleteMany();
  await tx.taskAssignment.deleteMany();
  await tx.task.deleteMany();
  await tx.taskCategory.deleteMany();
  await tx.passwordResetToken.deleteMany();
  await tx.session.deleteMany();
  await tx.user.deleteMany();
}

/**
 * Load the demo team into `db`. Refuses (SeedRefusedError) if users already exist, unless `reset` is set.
 * Everything runs in one transaction, so a failure leaves the database untouched.
 */
export async function seed(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const now = options.now ?? new Date();
  const today = todayInTimezone(options.timezone ?? DEFAULT_TIMEZONE, now);
  const password = options.password ?? DEMO_PASSWORD;

  const existing = await db.user.count();
  if (existing > 0 && !options.reset) {
    throw new SeedRefusedError(
      `The database already has ${existing} ${existing === 1 ? "user" : "users"}, so nothing was changed.\n` +
        "Run `npm run db:seed -- --reset` to wipe it and load the demo team (local databases only).",
    );
  }

  const passwordHash = await hashPassword(password); // one hash for everyone keeps seeding fast
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
  /** A time on due-day `day` (same clock time as now, minus `hoursBefore`), never in the future. */
  const onDay = (day: number, hoursBefore: number) =>
    new Date(Math.min(now.getTime() + day * DAY - hoursBefore * HOUR, now.getTime() - 10 * 60 * 1000));

  const counts = await db.$transaction(
    async (tx) => {
      if (options.reset) await wipeAppData(tx);

      // Users: the admin first (approves everyone else).
      const keys = Object.keys(PEOPLE) as PersonKey[];
      const userRow = (key: PersonKey, approvedById: string | null): Prisma.UserCreateManyInput => {
        const p: PersonSpec = PEOPLE[key];
        const status = p.status ?? "ACTIVE";
        const createdAt = ago(p.joinedDaysAgo * 24 + 3);
        const needsApproval = p.role !== "MEMBER" && !p.isAdmin && status !== "PENDING";
        return {
          name: p.name,
          email: emailFor(key),
          passwordHash,
          role: p.role,
          subteam: p.subteam,
          status,
          isAdmin: p.isAdmin ?? false,
          emailOnAssigned: p.emailOnAssigned ?? false,
          approvedById: needsApproval ? approvedById : null,
          approvedAt: needsApproval ? new Date(createdAt.getTime() + 20 * HOUR) : null,
          lastSeenAt: p.seenHoursAgo === undefined ? null : ago(p.seenHoursAgo),
          createdAt,
        };
      };
      const admin = await tx.user.create({ data: userRow("jordan", null), select: { id: true } });
      const others = await tx.user.createManyAndReturn({
        data: keys.filter((k) => k !== "jordan").map((k) => userRow(k, admin.id)),
        select: { id: true, email: true },
      });
      const idByEmail = new Map(others.map((u) => [u.email, u.id]));
      idByEmail.set(emailFor("jordan"), admin.id);
      const uid = (key: PersonKey) => {
        const id = idByEmail.get(emailFor(key));
        if (!id) throw new Error(`seed: missing user ${key}`);
        return id;
      };

      // Task dashboard categories.
      const categories = await tx.taskCategory.createManyAndReturn({
        data: CATEGORIES.flatMap((c) =>
          c.names.map((name, position) => ({
            subteam: c.subteam,
            name,
            nameKey: name.toLowerCase(),
            position,
            createdById: uid(c.creator),
            createdAt: ago(24 * 40),
          })),
        ),
        select: { id: true, subteam: true, name: true },
      });
      const categoryIdFor = (t: TaskSpec) => {
        const name = t.category ?? TASK_CATEGORY[t.title];
        if (!name) return null;
        const found = categories.find((c) => c.subteam === t.subteam && c.name === name);
        if (!found) throw new Error(`seed: no "${name}" category for ${t.title}`);
        return found.id;
      };

      // Tasks.
      const taskSpecs = [...buildTasks(), ...buildSignupTasks()];
      const taskCreatedAt = (t: TaskSpec) => ago(24 * (Math.max(0, -t.day) + 2) + 3);
      const tasks = await tx.task.createManyAndReturn({
        data: taskSpecs.map((t) => ({
          title: t.title,
          description: t.description,
          subteam: t.subteam,
          dueDate: dateOnlyToDb(addDays(today, t.day)),
          priority: t.priority ?? "NORMAL",
          categoryId: categoryIdFor(t),
          signupMode: t.signupOpen ?? false,
          signupOpen: t.signupOpen ?? false,
          signupLimit: t.signupLimit ?? null,
          createdById: uid(t.creator),
          createdAt: taskCreatedAt(t),
        })),
        select: { id: true, title: true },
      });
      const taskIdByTitle = new Map(tasks.map((t) => [t.title, t.id]));

      // Checklist items. The task's creator does the reviewing.
      const assignmentRows: Prisma.TaskAssignmentCreateManyInput[] = [];
      for (const t of taskSpecs) {
        const createdAt = taskCreatedAt(t);
        t.assignments.forEach((a, i) => {
          const row: Prisma.TaskAssignmentCreateManyInput = {
            taskId: taskIdByTitle.get(t.title)!,
            userId: uid(a.who),
            status: a.status,
            selfAssigned: a.self ?? false,
            createdAt,
          };
          if (a.status !== "TODO") {
            const submittedAt = new Date(Math.max(onDay(t.day, 2 + (i % 5)).getTime(), createdAt.getTime() + HOUR));
            row.submittedAt = submittedAt;
            row.submissionNote = a.submissionNote ?? null;
          }
          if (a.status === "APPROVED" || a.status === "REJECTED") {
            row.reviewedById = uid(t.creator);
            row.reviewedAt = new Date(Math.min((row.submittedAt as Date).getTime() + (3 + (i % 4)) * HOUR, now.getTime() - 5 * 60 * 1000));
            row.reviewNote = a.reviewNote ?? null;
          }
          assignmentRows.push(row);
        });
      }
      await tx.taskAssignment.createMany({ data: assignmentRows });

      // Questions and replies.
      const questions = await tx.question.createManyAndReturn({
        data: QUESTIONS.map((q) => ({
          title: q.title,
          body: q.body,
          askerId: uid(q.asker),
          recipientId: q.recipient ? uid(q.recipient) : null,
          subteam: q.subteam,
          taskId: q.task ? taskIdByTitle.get(q.task)! : null,
          status: q.status,
          createdAt: ago(q.askedHoursAgo),
          lastActivityAt: ago(Math.min(q.askedHoursAgo, ...q.replies.map((r) => r.hoursAgo))),
        })),
        select: { id: true, title: true },
      });
      const questionIdByTitle = new Map(questions.map((q) => [q.title, q.id]));
      const replyRows: Prisma.QuestionReplyCreateManyInput[] = QUESTIONS.flatMap((q) =>
        q.replies.map((r) => ({
          questionId: questionIdByTitle.get(q.title)!,
          authorId: uid(r.author),
          body: r.body,
          createdAt: ago(r.hoursAgo),
        })),
      );
      await tx.questionReply.createMany({ data: replyRows });

      // A few sample resources (public FTC pages + placeholders; real team links are added in the app).
      await tx.resource.createMany({
        data: [
          {
            title: "Team Docs (demo)",
            url: "https://docs.example.com/huskyteers-team-docs",
            description: "All team materials: agenda, dates, notebooks, orders.",
            type: "DOCUMENT",
            group: "Team Docs",
            pinned: true,
            links: [
              { label: "Meeting Agenda", url: "https://docs.example.com/huskyteers-team-docs#agenda" },
              { label: "Important Dates", url: "https://docs.example.com/huskyteers-team-docs#dates" },
              { label: "Team Tasks", url: "https://docs.example.com/huskyteers-team-docs#tasks" },
            ],
            createdById: uid("jordan"),
          },
          {
            title: "Inventory tracker (demo)",
            url: "https://inventory.example.com/",
            description: "What parts we have and where they are.",
            type: "WEBSITE",
            group: "Project assets",
            createdById: uid("marcus"),
          },
          {
            title: "FTC Docs",
            url: "https://ftc-docs.firstinspires.org/",
            description: "Official FTC programming and robot documentation.",
            type: "WEBSITE",
            group: "Learning",
            createdById: uid("priya"),
          },
        ],
      });

      // Members' shares: one waiting for approval, one approved uploaded file, one turned down.
      await tx.resource.create({
        data: {
          title: "Gear ratio calculator",
          url: "https://gears.example.com/ratio-calculator",
          description: "Handy for picking sprockets for the new arm.",
          type: "WEBSITE",
          group: "Build",
          status: "PENDING",
          createdById: uid("ethan"),
          createdAt: ago(5),
        },
      });
      const teleOp = new TextEncoder().encode(TELEOP_JAVA);
      await tx.resource.create({
        data: {
          title: "TeleOp starter code",
          description: "Arcade drive plus the intake on the triggers. A good starting point for new programmers.",
          type: "CODE",
          group: "Code",
          status: "APPROVED",
          createdById: uid("aiden"),
          createdAt: ago(26),
          reviewedById: uid("priya"),
          reviewedAt: ago(20),
          file: { create: { filename: "TeleOpMain.java", contentType: "text/x-java", size: teleOp.byteLength, data: teleOp, createdAt: ago(26) } },
        },
      });
      await tx.resource.create({
        data: {
          title: "Robot photos",
          url: "https://photos.example.com/huskyteers-robot",
          description: "Photos from the last build session.",
          type: "OTHER",
          group: "Media",
          status: "REJECTED",
          createdById: uid("maya"),
          createdAt: ago(8),
          reviewedById: uid("priya"),
          reviewedAt: ago(2),
          reviewNote: "That album is private, so the team can't open it. Share it with the team first, then send it again.",
        },
      });

      // Parts queue: Build's parts to make, most important first; two being made, two done.
      const buildCategory = (name: string) => {
        const found = categories.find((c) => c.subteam === "BUILD" && c.name === name);
        if (!found) throw new Error(`seed: no Build category "${name}"`);
        return found.id;
      };
      await tx.part.createMany({ data: partRows(today, ago, uid, buildCategory) });

      // Sponsorships (Business): every stage, money in on two, deadlines coming up, one missed.
      await tx.sponsorship.createMany({ data: sponsorshipRows(today, ago, uid) });
      // Key "sponsorship-info" = SPONSORSHIP_INFO_KEY in src/server/services/sponsorships.ts (not imported: server-only).
      await tx.teamNote.create({ data: { key: "sponsorship-info", body: SPONSORSHIP_INFO, updatedById: uid("amara") } });

      return {
        users: keys.length,
        tasks: tasks.length,
        assignments: assignmentRows.length,
        questions: questions.length,
        replies: replyRows.length,
        categories: categories.length,
      };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );

  const order: AccountStatus[] = ["ACTIVE", "PENDING", "DISABLED", "REJECTED"];
  const credentials = (Object.keys(PEOPLE) as PersonKey[])
    .map((key): SeedCredential => {
      const p: PersonSpec = PEOPLE[key];
      return { name: p.name, email: emailFor(key), position: positionFor(p), status: p.status ?? "ACTIVE" };
    })
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return { today, password, counts, credentials };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

/** True for localhost / 127.0.0.1 / ::1 (and unix sockets). */
export function isLocalDatabaseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const hostParam = u.searchParams.get("host");
    if (hostParam?.startsWith("/")) return true;
    const host = (hostParam ?? u.hostname).toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Why the seed must not run with these settings, or null if it may. */
export function checkSeedSafety(input: { nodeEnv?: string; databaseUrl: string; reset: boolean; forceRemote: boolean }): string | null {
  if (input.nodeEnv === "production") {
    return "Refusing to seed: NODE_ENV is \"production\". Demo data is for local development only.";
  }
  if (isLocalDatabaseUrl(input.databaseUrl)) return null;
  if (input.reset) return "Refusing to --reset a database that isn't on localhost. --reset only works on local databases.";
  if (!input.forceRemote) {
    return "Refusing to seed: DATABASE_URL doesn't point at localhost. Pass --force-remote if you really want demo data there.";
  }
  return null;
}

function printSummary(result: SeedResult, appUrl: string) {
  const { counts } = result;
  const rows = result.credentials.map((c) => [c.email, c.position, STATUS_LABELS[c.status], result.password]);
  const header = ["Email", "Role", "Status", "Password"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => "  " + cells.map((c, i) => c.padEnd(widths[i])).join("   ");

  console.log(`\nDemo team loaded (today is ${formatDateOnly(result.today)}).`);
  console.log(
    `  ${counts.users} people · ${counts.tasks} tasks (${counts.categories} categories) · ${counts.assignments} checklist items · ` +
      `${counts.questions} questions · ${counts.replies} replies\n`,
  );
  console.log(line(header));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(r));
  console.log(`\nSign in at ${appUrl}/login with any Active account above (password: ${result.password}).`);
  console.log("  Try admin@example.com (captain + admin), marcus.johnson@example.com (build leader),");
  console.log("  and maya.patel@example.com (software member). Pending accounts wait for approval in Admin → Approvals.\n");
}

async function main() {
  loadEnv({ quiet: true });
  const args = new Set(process.argv.slice(2));
  const reset = args.has("--reset");
  const forceRemote = args.has("--force-remote");
  const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

  const problem = checkSeedSafety({ nodeEnv: process.env.NODE_ENV, databaseUrl, reset, forceRemote });
  if (problem) {
    console.error(problem);
    process.exitCode = 1;
    return;
  }

  const db = createPrismaClient(databaseUrl);
  try {
    const result = await seed(db, { reset, timezone: process.env.TEAM_TIMEZONE || DEFAULT_TIMEZONE });
    printSummary(result, (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, ""));
  } catch (e) {
    if (e instanceof SeedRefusedError) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  } finally {
    await db.$disconnect();
  }
}

/** Only run when executed directly (`tsx prisma/seed.ts`), never when imported by tests. */
function isCliEntry(): boolean {
  const entry = process.argv[1];
  return !!entry && /(^|[\\/])prisma[\\/]seed\.[cm]?[jt]s$/.test(entry);
}

if (isCliEntry()) {
  main().catch((e) => {
    console.error("Seeding failed:", e);
    process.exit(1);
  });
}
