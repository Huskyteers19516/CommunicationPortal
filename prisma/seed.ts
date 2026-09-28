// Demo data for local development: a realistic Huskyteers team with tasks, checklists, and questions.
//
//   npm run db:seed              # empty local database only
//   npm run db:seed -- --reset   # wipe every app row first (localhost only)
//
// Safety: refuses when NODE_ENV=production, and refuses non-localhost databases unless --force-remote.
// Importing this file has no side effects — tests call `seed(db, options)` directly.
//
// Keep this file free of `server-only` and next/* imports: it runs under plain tsx.
import { randomBytes } from "node:crypto";
import { config as loadEnv } from "dotenv";
import type { Prisma } from "../src/generated/prisma/client";
import type { AccountStatus, AssignmentStatus, Priority, QuestionStatus, Role, Subteam } from "../src/generated/prisma/enums";
import {
  ATTENDANCE_SETTINGS_KEY,
  type AttendanceSettings,
  DEFAULT_ATTENDANCE_SETTINGS,
  isFlexDay,
  isRegularDay,
  isTeamDay,
  serializeAttendanceSettings,
  weekdayOf,
} from "../src/lib/attendance";
import { ROLE_LABELS, STATUS_LABELS, SUBTEAM_LABELS } from "../src/lib/constants";
import { addDays, dateOnlyToDb, type DateOnly, formatDateOnly, todayInTimezone } from "../src/lib/dates";
import { STANDARD_NOTEBOOKS } from "../src/lib/notebook";
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

// ── Posters ───────────────────────────────────────────────────────────────────

interface PosterSpec {
  title: string;
  description?: string;
  event?: string;
  /** Days from today. */
  date?: number;
  link?: string;
  /** A tiny generated PNG (24×32, base64), or none for a link-only poster. */
  png?: string;
  creator: PersonKey;
  addedHoursAgo: number;
}

/** Demo posters: three small generated pictures (one for a past event) and one link-only. Placeholder links only. */
const POSTERS: PosterSpec[] = [
  {
    title: "Robot demo at the library",
    description: "Tape one up by the front desk and one in the kids' section.",
    event: "Library demo",
    date: 9,
    png: "iVBORw0KGgoAAAANSUhEUgAAABgAAAAgCAIAAACHPC9vAAAARElEQVR42mMQSzWhCmIYNWgoGvTm+weqoMFskNe9BjIQLQ0axIENcTAxJD6DyDNl1EWjLhq8WYT4UpVeBg3jMnuwGAQAvFNiKk9hXecAAAAASUVORK5CYII=",
    creator: "ava",
    addedHoursAgo: 20,
  },
  {
    title: "Join the Huskyteers!",
    description: "For the club fair and the STEM hallway.",
    event: "Recruiting",
    link: "https://design.example.com/huskyteers-recruiting",
    png: "iVBORw0KGgoAAAANSUhEUgAAABgAAAAgCAIAAACHPC9vAAAARElEQVR42mM45MhDFcQwatBQNOj/97dUQYPZoN+TbMhAtDRoEAc2xMHEkPgMIs+UUReNumjwZhHiS1V6GTSMy+zBYhAAUPPV/bdL+NoAAAAASUVORK5CYII=",
    creator: "amara",
    addedHoursAgo: 24 * 6,
  },
  {
    title: "Car wash fundraiser",
    event: "Car wash",
    date: 20,
    link: "https://design.example.com/car-wash-flyer",
    creator: "grace",
    addedHoursAgo: 30,
  },
  {
    title: "Summer showcase",
    event: "Summer showcase",
    date: -40,
    png: "iVBORw0KGgoAAAANSUhEUgAAABgAAAAgCAIAAACHPC9vAAAARElEQVR42mOQc1hPFcQwatBQNOj9t/9UQYPZoISlv8hAtDRoEAc2xMHEkPgMIs+UUReNumjwZhHiS1V6GTSMy+zBYhAAi0TrMPLSmhwAAAAASUVORK5CYII=",
    creator: "daniel",
    addedHoursAgo: 24 * 50,
  },
];

// ── Fundraising ───────────────────────────────────────────────────────────────

interface FundraiserSpec {
  name: string;
  kind: NonNullable<Prisma.FundraiserCreateManyInput["kind"]>;
  status: NonNullable<Prisma.FundraiserCreateManyInput["status"]>;
  description?: string;
  location?: string;
  link?: string;
  /** Days from today. */
  starts?: number;
  ends?: number;
  goal?: number;
  raised?: number;
  lead?: PersonKey;
  /** Most helpers (none = no limit). */
  limit?: number;
  creator: PersonKey;
  /** Signed up with "I'll help", in this order (ACTIVE people only). */
  helpers?: PersonKey[];
}

/** Demo fundraisers in every status: one full, one past its goal, placeholder links only. */
const FUNDRAISERS: FundraiserSpec[] = [
  {
    name: "Car wash at the high school",
    kind: "EVENT",
    status: "UPCOMING",
    description: "Bring towels, sponges, and a water bottle. Wear clothes that can get wet. Signs and buckets are in the Business closet.",
    location: "School parking lot (north side)",
    starts: 9,
    goal: 600,
    lead: "ava",
    limit: 8,
    creator: "amara",
    helpers: ["ava", "grace", "ethan", "maya", "lucas"],
  },
  {
    name: "Restaurant night",
    kind: "EVENT",
    status: "UPCOMING",
    description: "Tell the cashier you're with the Huskyteers and part of the bill comes back to the team. Hand out flyers at the door.",
    location: "Pizza place on Main St",
    link: "https://flyers.example.com/restaurant-night",
    starts: 16,
    goal: 400,
    lead: "daniel",
    creator: "daniel",
    helpers: ["daniel", "chloe"],
  },
  {
    name: "Online donation drive",
    kind: "ONLINE",
    status: "ACTIVE",
    description: "Share the link with family and friends. Every donation helps pay for parts and the competition fee.",
    location: "Online",
    link: "https://donate.example.com/huskyteers",
    starts: -10,
    ends: 20,
    goal: 2000,
    raised: 850,
    lead: "amara",
    limit: 3,
    creator: "amara",
    helpers: ["amara", "leila", "grace"],
  },
  {
    name: "Candy grams for spirit week",
    kind: "SALE",
    status: "PLANNING",
    description: "Idea: sell candy grams at lunch for a week. Need to ask the school office first.",
    starts: 30,
    ends: 34,
    goal: 300,
    lead: "grace",
    limit: 6,
    creator: "grace",
  },
  {
    name: "Bake sale at back-to-school night",
    kind: "SALE",
    status: "DONE",
    location: "School front lobby",
    starts: -25,
    goal: 400,
    raised: 465,
    lead: "leila",
    creator: "amara",
    helpers: ["leila", "samuel", "isabella", "aiden", "zara"],
  },
  {
    name: "Team T-shirt sale",
    kind: "SALE",
    status: "DONE",
    starts: -45,
    ends: -30,
    goal: 500,
    raised: 380,
    lead: "ava",
    creator: "ava",
    helpers: ["ava", "hannah"],
  },
  {
    name: "Farmers market booth",
    kind: "EVENT",
    status: "CANCELLED",
    description: "Cancelled: the market closed for the heat wave. Try again in the spring.",
    location: "Downtown farmers market",
    starts: -5,
    goal: 300,
    lead: "daniel",
    limit: 4,
    creator: "daniel",
    helpers: ["daniel", "mateo"],
  },
];

/** The season goal (TeamNote "fundraising-season-goal"), whole dollars. */
const FUNDRAISING_SEASON_GOAL = 5000;
/** When the season started (TeamNote "fundraising-season-start"), days from today: every demo fundraiser counts. */
const FUNDRAISING_SEASON_START_DAYS = -60;

// ── Strategy ──────────────────────────────────────────────────────────────────

/**
 * A tiny path the Pedro Pathing planner (BIOBUZZ edition) opens with Load: start against the audience wall by the
 * HIVE (the planner's default red start for a 16 in robot), drive out, wait to score, then curve over to park.
 */
const DEMO_PATH = {
  startPoint: { x: 61.75, y: 8, heading: "linear", startDeg: 90, endDeg: 90, locked: false },
  lines: [
    {
      id: "line-drive-out",
      name: "Drive out",
      endPoint: { x: 61.75, y: 30, heading: "linear", startDeg: 90, endDeg: 90 },
      controlPoints: [],
      color: "#ffc516",
      locked: false,
    },
    {
      id: "line-park",
      name: "Park",
      endPoint: { x: 36, y: 44, heading: "constant", degrees: 135 },
      controlPoints: [{ x: 58, y: 44 }],
      color: "#60a5fa",
      locked: false,
    },
  ],
  shapes: [],
  sequence: [
    { kind: "path", lineId: "line-drive-out" },
    { kind: "wait", id: "wait-score", name: "Score preload", durationMs: 800 },
    { kind: "path", lineId: "line-park" },
  ],
  version: "1.2.1",
};

interface StrategySpec {
  title: string;
  kind: "AUTO" | "TELEOP" | "ENDGAME" | "MATCH" | "SCOUTING" | "OTHER";
  description: string;
  link?: string;
  pinned?: boolean;
  /** A .pp path file (name + JSON). */
  path?: { filename: string; data: unknown };
  creator: PersonKey;
  addedHoursAgo: number;
}

/** Demo strategies: a pinned auto with a real .pp path, a match plan with a link, and scouting notes. Placeholder links only. */
const STRATEGIES: StrategySpec[] = [
  {
    title: "Red audience-side auto: score preload + park",
    kind: "AUTO",
    description:
      "Start against the audience wall next to the HIVE (red side), facing the field.\n\n1. Drive out 22 in.\n2. Score the preload (0.8 s wait).\n3. Curve over and park.\n\nTo see it: the planner on the Strategy page → Load (the ↑ arrow at the top) → pick red-audience-auto.pp. Blue side: use the planner's alliance switch.",
    pinned: true,
    path: { filename: "red-audience-auto.pp", data: DEMO_PATH },
    creator: "aiden",
    addedHoursAgo: 30,
  },
  {
    title: "Qualification match plan",
    kind: "MATCH",
    description:
      "Auto: run the audience-side auto unless our partner has a better one on that side.\nTeleOp: cycle from the loading zone; the drive coach calls when to stop.\nEndgame: start parking at 0:20.\n\nTalk to our alliance partner before every match — who takes which side.",
    link: "https://docs.example.com/huskyteers-match-plan",
    creator: "jordan",
    addedHoursAgo: 24 * 3,
  },
  {
    title: "Scouting notes: what to watch for",
    kind: "SCOUTING",
    description:
      "For every team we might pick or play against:\n- Do they score in auto? From which side?\n- How many cycles in TeleOp?\n- Do they park in endgame?\n- Any breakdowns or penalties?\n\nWrite it down right after the match, while it's fresh.",
    creator: "grace",
    addedHoursAgo: 24 * 5,
  },
];

// ── Strategy → Other teams ────────────────────────────────────────────────────

/** "Their strategy at a glance" for a league team (the teams themselves come from the league_teams migration). */
const LEAGUE_TEAM_SUMMARIES: { number: number; summary: string; by: PersonKey; hoursAgo: number }[] = [
  {
    number: 9040,
    summary:
      "Auto: starts on the rear wall (blue side), scores the preload, parks by the HIVE — about 22 s.\nTeleOp: 5–6 cycles from the loading zone; fast driver.\nEndgame: parks early, around 0:25.\nGood alliance partner; they like the rear side, so we take the audience side.",
    by: "grace",
    hoursAgo: 20,
  },
];

/** A strategy about another team: their auto, traced in the planner from a match video (a .pp path). */
const LEAGUE_TEAM_STRATEGIES: { teamNumber: number; title: string; description: string; path: { filename: string; data: unknown }; creator: PersonKey; addedHoursAgo: number }[] = [
  {
    teamNumber: 9040,
    title: "9040's rear-side auto (traced)",
    description: "Traced from their qualification match video. They finish around 22 s, so the audience side is ours.",
    path: {
      filename: "9040-rear-auto.pp",
      data: {
        startPoint: { x: 79.75, y: 133.5, heading: "linear", startDeg: -90, endDeg: -90, locked: false },
        lines: [
          {
            id: "line-9040-out",
            name: "Drive out",
            endPoint: { x: 79.75, y: 111.5, heading: "linear", startDeg: -90, endDeg: -90 },
            controlPoints: [],
            color: "#ffc516",
            locked: false,
          },
        ],
        shapes: [],
        sequence: [{ kind: "path", lineId: "line-9040-out" }],
        version: "1.2.1",
      },
    },
    creator: "aiden",
    addedHoursAgo: 18,
  },
];

// ── Order list ────────────────────────────────────────────────────────────────

interface PurchaseSpec {
  description: string;
  notes?: string;
  link?: string;
  vendor?: string;
  quantity?: number;
  /** Price for the whole line, in cents. */
  cost?: number;
  subteam: Subteam | null;
  status: "REQUESTED" | "APPROVED" | "ORDERED" | "DONE" | "NOT_NEEDED";
  orderer: PersonKey | null;
  creator: PersonKey;
  addedHoursAgo: number;
  /** The last status change: who, and how many hours ago. */
  changed?: { by: PersonKey; hoursAgo: number };
}

/** Demo order list, like the Business team's old "Purchase List" sheet: every status. Placeholder links only. */
const PURCHASES: PurchaseSpec[] = [
  {
    description: "Flywheels for the outtake",
    notes: "SKU am-5437 (2)",
    vendor: "AndyMark",
    link: "https://shop.example.com/andymark/am-5437",
    quantity: 2,
    cost: 5998,
    subteam: "BUILD",
    status: "DONE",
    orderer: "ethan",
    creator: "ethan",
    addedHoursAgo: 24 * 9,
    changed: { by: "ethan", hoursAgo: 24 * 2 },
  },
  {
    description: "Dirty Soda Fundraiser Supplies",
    notes: "Go to the fundraiser doc for all supplies",
    cost: 8650,
    subteam: "BUSINESS",
    status: "ORDERED",
    orderer: "ava",
    creator: "ava",
    addedHoursAgo: 24 * 6,
    changed: { by: "ava", hoursAgo: 20 },
  },
  {
    description: "USB-C cables for the Control Hub",
    notes: "Short ones (1 ft). We keep losing them.",
    link: "https://shop.example.com/usb-c-1ft",
    quantity: 3,
    cost: 1797,
    subteam: "SOFTWARE",
    status: "APPROVED",
    orderer: "maya",
    creator: "maya",
    addedHoursAgo: 30,
    changed: { by: "priya", hoursAgo: 5 },
  },
  {
    description: "Yellow Jacket motors (312 RPM)",
    notes: "SKU 5203-2402-0019 (4) for the new drivetrain",
    vendor: "goBILDA",
    link: "https://shop.example.com/gobilda/5203-2402-0019",
    quantity: 4,
    cost: 15996,
    subteam: "BUILD",
    status: "REQUESTED",
    orderer: "isabella",
    creator: "isabella",
    addedHoursAgo: 6,
  },
  {
    description: "Team T-shirts for the first qualifier",
    notes: "Sizes are in the team sheet",
    quantity: 30,
    subteam: null,
    status: "REQUESTED",
    orderer: "daniel",
    creator: "daniel",
    addedHoursAgo: 26,
  },
  {
    description: "Replacement mecanum rollers",
    notes: "Found spares in the parts bin",
    vendor: "goBILDA",
    quantity: 8,
    cost: 3200,
    subteam: "BUILD",
    status: "NOT_NEEDED",
    orderer: "zara",
    creator: "zara",
    addedHoursAgo: 24 * 4,
    changed: { by: "marcus", hoursAgo: 24 * 3 },
  },
];

function purchaseRows(ago: (hours: number) => Date, uid: (key: PersonKey) => string): Prisma.PurchaseItemCreateManyInput[] {
  return PURCHASES.map((item) => ({
    description: item.description,
    notes: item.notes ?? "",
    link: item.link ?? "",
    vendor: item.vendor ?? "",
    quantity: item.quantity ?? null,
    costCents: item.cost ?? null,
    subteam: item.subteam,
    status: item.status,
    ordererId: item.orderer ? uid(item.orderer) : null,
    createdById: uid(item.creator),
    createdAt: ago(item.addedHoursAgo),
    updatedAt: ago(item.changed?.hoursAgo ?? item.addedHoursAgo),
    statusChangedAt: item.changed ? ago(item.changed.hoursAgo) : null,
    statusChangedById: item.changed ? uid(item.changed.by) : null,
  }));
}

// ── Team notebook ─────────────────────────────────────────────────────────────

interface NotebookEntrySpec {
  author: PersonKey;
  hoursAgo: number;
  title?: string;
  body: string;
  /** Changed later: who changed it, when, and what it said before (shown under History). */
  edited?: { by: PersonKey; hoursAgo: number; previousTitle?: string; previousBody: string };
  /** A tiny generated PNG (base64) on the entry. */
  png?: { filename: string; data: string; width: number; height: number };
}

/**
 * Demo entries for the standard notebooks (STANDARD_NOTEBOOKS in src/lib/notebook.ts), by "Notebook / Page".
 * One was changed later by a Build leader (it has a history), one has a small picture; Transfer is still empty.
 */
const NOTEBOOK_ENTRIES: Record<string, NotebookEntrySpec[]> = {
  "Hardware Notebook / Intake": [
    {
      author: "ethan",
      hoursAgo: 24 * 3 + 2,
      title: "Roller intake v1",
      body: "Built the first roller intake: 2\" compliant wheels on a 5 mm hex shaft.\n- 312 rpm motor\n- Grabs samples from the wall and the floor\n- Jams when two come in at once\nNext: a funnel so only one fits.",
      edited: {
        by: "marcus",
        hoursAgo: 24 * 2 + 5,
        previousTitle: "Roller intake",
        previousBody: "Built the first roller intake with compliant wheels.\n- Grabs samples from the wall\n- Jams sometimes",
      },
    },
    {
      author: "isabella",
      hoursAgo: 20,
      title: "Funnel test",
      body: "Printed a funnel in PETG and bolted it in front of the rollers. 9 of 10 grabs worked; the miss was a sample standing on its edge.",
      png: {
        filename: "funnel-test.png",
        data: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAAM0lEQVR42mO48+YeTRHDqAUj2AL9WiuS0KgFoxaMWjBqAS0sgCAbGCBJakRZMFqjvbkHAKEcf1ccFGZ+AAAAAElFTkSuQmCC",
        width: 32,
        height: 24,
      },
    },
  ],
  "Hardware Notebook / Outtake": [
    {
      author: "marcus",
      hoursAgo: 24 * 2 + 1,
      title: "Slide rigging",
      body: "Re-strung both slides with continuous rigging. Full extension now takes 0.6 s instead of 1.1 s, and the string no longer goes slack on the way down.",
    },
  ],
  "Software Notebook / Competition": [
    {
      author: "priya",
      hoursAgo: 24 * 4,
      title: "Qualifier checklist",
      body: "Before every match:\n- Charge both batteries\n- Check the Control Hub firmware\n- Pick the auto that matches our alliance partner\nAfter the match, write down what the auto did.",
    },
  ],
  "Software Notebook / Prototyping": [
    {
      author: "aiden",
      hoursAgo: 30,
      body: "Ran the 3-sample auto 10 times: 8 clean runs. Both misses were from the far-side start, so I'm retuning the heading PID next.",
    },
  ],
  "Business Notebook / Outreach": [
    {
      author: "ava",
      hoursAgo: 24 * 5,
      title: "Library demo",
      body: "Showed the robot to about 40 kids at the library and let them drive it. Handed out 30 flyers. Photos: https://photos.example.com/library-demo",
    },
  ],
  "Business Notebook / Sponsorships": [
    {
      author: "amara",
      hoursAgo: 24 * 3,
      title: "Grant application sent",
      body: "Sent the STEM grant application with our budget and outreach numbers. We should hear back in about four weeks.",
    },
  ],
  "Business Notebook / Engineering Journal": [
    {
      author: "grace",
      hoursAgo: 12,
      title: "Week 4 recap",
      body: "Intake works with the new funnel, the slides are faster, and auto scores 3 samples most of the time. Next week: driver practice.",
    },
  ],
};

// ── Attendance ────────────────────────────────────────────────────────────────

/** Who's on the team for attendance (active students: members, leaders, the captain). */
const ATTENDANCE_TEAM: PersonKey[] = [
  "jordan", "priya", "marcus", "sofia", "kenji", "amara",
  "aiden", "maya", "lucas", "chloe", "omar", "ethan", "isabella", "liam", "zara", "mateo", "hannah",
  "ava", "daniel", "leila", "grace", "samuel",
];
/** People the e2e tests answer "Coming?" as: no demo answers for upcoming days. */
const ATTENDANCE_E2E_PEOPLE: PersonKey[] = ["maya", "ethan", "ava"];

const ATTENDANCE_NOTES = [
  "Drive practice on the full field, then tuned the intake roller speed.",
  "Build: new outtake side plates. Software: auto paths for the left start.",
  "Sponsor calls (Business), wiring cleanup, and a practice match at the end.",
  "Rebuilt the lift string spool. Everyone else worked on the notebook.",
  "Scrimmage prep: checklist, spare parts box, and two practice matches.",
  "",
];

/**
 * How much a demo scanned check-in counts (in sixths, see CREDIT_OPTIONS in src/lib/attendance.ts). At Regular a
 * scan counts as 1; a few were lowered (or made EC) by the runner afterwards (`byRunner`: "changed by", in the change
 * log). At Flex members pick 1 Flex or 1/2 Flex themselves.
 */
function seedCredit(kind: "REGULAR" | "FLEX", i: number, n: number) {
  if (kind === "FLEX") return { credit: (i + n) % 5 === 0 ? 3 : 6, creditKind: "FLEX" as const, byRunner: false };
  const k = (i * 5 + n * 3) % 16;
  const changed = ([[3, "REGULAR"], [4, "REGULAR"], [2, "REGULAR"], [6, "EXTRA"]] as const)[k];
  return changed && i % 4 === 0
    ? { credit: changed[0], creditKind: changed[1], byRunner: true }
    : { credit: 6, creditKind: "REGULAR" as const, byRunner: false };
}

/** Added by hand (no scan): only a partial credit or EC (src/lib/attendance.ts: HAND_CREDIT_IDS). */
function seedHandCredit(i: number, n: number) {
  return ([[4, "REGULAR"], [3, "REGULAR"], [2, "REGULAR"], [3, "EXTRA"], [6, "EXTRA"]] as const)[(i + n) % 5];
}

/** The next Saturday after `today` (1–7 days ahead): the demo's extra meeting. */
export function seedExtraMeetingDay(today: DateOnly): DateOnly {
  return addDays(today, (6 - weekdayOf(today) + 7) % 7 || 7);
}

/**
 * Two weeks of attendance before today (Regular every team day but one, Flex on Flex days), with "What we did",
 * check-ins (mostly scanned, some typed, a few added by hand), "Coming?" answers for those days and the next
 * week (the regular Mon/Tue/Thu meetings plus an extra meeting — a Saturday build day on the Team calendar), and
 * a plan for the next team day. Today has no sessions, so attendance can be started fresh.
 */
async function seedAttendance(tx: Tx, today: DateOnly, uid: (key: PersonKey) => string) {
  // Reports start on the Monday about three weeks back, so there's a past two weeks and a current one.
  const back = addDays(today, -21);
  const reportStart = addDays(back, -((weekdayOf(back) + 6) % 7));
  // Key "attendance-settings" = ATTENDANCE_SETTINGS_KEY in src/lib/attendance.ts. Extra meetings are never saved in it.
  const saved = { ...DEFAULT_ATTENDANCE_SETTINGS, reportStart };
  await tx.teamNote.create({ data: { key: ATTENDANCE_SETTINGS_KEY, body: serializeAttendanceSettings(saved), updatedById: uid("david") } });

  // An extra meeting (Team calendar, kind MEETING): a build day next Saturday. It's a meeting day in Attendance.
  const extraDay = seedExtraMeetingDay(today);
  await tx.calendarEvent.create({
    data: {
      title: "Extra build day",
      kind: "MEETING",
      startsOn: dateOnlyToDb(extraDay),
      startTime: "09:00",
      endTime: "13:00",
      location: "Robotics room",
      notes: "Finishing the intake before League Scrimmage 0. Bring safety glasses; lunch is on the team.",
      createdById: uid("jordan"),
      // Added two days ago, around 4 PM Pacific.
      createdAt: new Date(dateOnlyToDb(addDays(today, -2)).getTime() + 23 * HOUR),
      updatedAt: new Date(dateOnlyToDb(addDays(today, -2)).getTime() + 23 * HOUR),
    },
  });
  const settings: AttendanceSettings = { ...saved, extraDays: [extraDay] };

  const runners: PersonKey[] = ["david", "amara", "jordan"];
  const rsvps = new Map<string, Prisma.AttendanceRsvpCreateManyInput>();
  const rsvp = (who: PersonKey, day: DateOnly, data: Partial<Prisma.AttendanceRsvpCreateManyInput>) => {
    const key = `${who}|${day}`;
    rsvps.set(key, { userId: uid(who), date: dateOnlyToDb(day), ...rsvps.get(key), ...data });
  };

  // The admins' change log (AttendanceChange): every hand add, credit a runner changed, and one person taken off.
  const changes: Prisma.AttendanceChangeCreateManyInput[] = [];
  let lastRegular: { id: string; day: DateOnly; opener: PersonKey; openedAt: Date; people: PersonKey[] } | null = null;

  let n = 0;
  let skipped = false;
  let removedOne = false;
  for (let offset = -14; offset <= -1; offset++) {
    const day = addDays(today, offset);
    if (!isTeamDay(settings, day)) continue;
    const midnight = dateOnlyToDb(day).getTime(); // 00:00 UTC ≈ 5 pm the day before in California
    const kinds: ("REGULAR" | "FLEX")[] = [];
    if (isFlexDay(settings, day)) kinds.push("FLEX");
    // One day with no practice (the first regular day without Flex, so nothing was taken that day).
    const noPractice = !skipped && !isFlexDay(settings, day);
    if (noPractice) skipped = true;
    else if (isRegularDay(settings, day)) kinds.push("REGULAR");
    for (const kind of kinds) {
      n++;
      const opener = runners[n % runners.length];
      // Flex around 10 am, regular practice around 3:30 pm (Pacific).
      const openedAt = new Date(midnight + (kind === "FLEX" ? 17 : 22.5) * HOUR);
      const people = ATTENDANCE_TEAM.filter((_, i) => (i * 7 + n * 3) % (kind === "FLEX" ? 3 : 6) !== 0);
      type SeedRecord = {
        who: PersonKey;
        record: Omit<Prisma.AttendanceRecordCreateWithoutSessionInput, "user" | "markedBy" | "creditChangedBy"> & {
          userId: string;
          markedById: string | null;
          creditChangedById?: string;
        };
        change: Pick<Prisma.AttendanceChangeCreateManyInput, "action" | "fromCredit" | "fromKind" | "toCredit" | "toKind" | "createdAt"> | null;
      };
      const records: SeedRecord[] = people.map((who, i): SeedRecord => {
        const checkedInAt = new Date(openedAt.getTime() + (2 + ((i * 3) % 20)) * 60 * 1000);
        const e2e = ATTENDANCE_E2E_PEOPLE.includes(who);
        // A few added by hand at Regular (forgot their phone, came for part of it): partial credit or EC only.
        if (kind === "REGULAR" && (i + n) % 12 === 4 && who !== opener && !e2e) {
          const [credit, creditKind] = seedHandCredit(i, n);
          return {
            who,
            record: {
              userId: uid(who),
              method: "MANUAL" as const,
              markedById: uid(opener),
              checkedInAt,
              credit,
              creditKind,
              creditChangedAt: checkedInAt,
              creditChangedById: uid(opener),
            },
            change: { action: "ADDED" as const, toCredit: credit, toKind: creditKind, createdAt: checkedInAt },
          };
        }
        const { credit, creditKind, byRunner } = seedCredit(kind, i, n);
        const changedAt = new Date(openedAt.getTime() + 2 * HOUR);
        const lowered = byRunner && who !== opener && !e2e;
        // Flex: the member's own pick (never logged). Regular: 1, unless the runner changed it.
        const kept = kind === "FLEX" || lowered;
        return {
          who,
          record: {
            userId: uid(who),
            method: i % 4 === 1 ? "CODE" : "QR",
            markedById: null,
            checkedInAt,
            credit: kept ? credit : 6,
            creditKind: kept ? creditKind : "REGULAR",
            ...(lowered ? { creditChangedAt: changedAt, creditChangedById: uid(opener) } : {}),
          },
          change: lowered ? { action: "CREDIT_CHANGED", fromCredit: 6, fromKind: "REGULAR", toCredit: credit, toKind: creditKind, createdAt: changedAt } : null,
        };
      });
      const session = await tx.attendanceSession.create({
        data: {
          date: dateOnlyToDb(day),
          kind,
          secret: randomBytes(32).toString("base64url"),
          openedById: uid(opener),
          openedAt,
          closedAt: new Date(openedAt.getTime() + (kind === "FLEX" ? 0.75 : 2.5) * HOUR),
          note: kind === "REGULAR" ? ATTENDANCE_NOTES[n % ATTENDANCE_NOTES.length] : "Flex: notebook and CAD.",
          records: { create: records.map((r) => r.record) },
        },
        select: { id: true },
      });
      for (const r of records) {
        if (!r.change) continue;
        changes.push({
          sessionId: session.id,
          sessionDate: dateOnlyToDb(day),
          sessionKind: kind,
          userId: uid(r.who),
          userName: PEOPLE[r.who].name,
          changedById: uid(opener),
          ...r.change,
        });
      }
      if (kind === "REGULAR") lastRegular = { id: session.id, day, opener, openedAt, people };
      // Someone who scanned from the hallway and left: the runner took them off (only the log remembers).
      if (!removedOne && kind === "REGULAR") {
        const gone = ATTENDANCE_TEAM.find((who) => !people.includes(who) && who !== opener && !ATTENDANCE_E2E_PEOPLE.includes(who));
        if (gone) {
          removedOne = true;
          changes.push({
            sessionId: session.id,
            sessionDate: dateOnlyToDb(day),
            sessionKind: kind,
            userId: uid(gone),
            userName: PEOPLE[gone].name,
            changedById: uid(opener),
            action: "REMOVED",
            fromCredit: 6,
            fromKind: "REGULAR",
            createdAt: new Date(openedAt.getTime() + 0.5 * HOUR),
          });
        }
      }
      // Most people answered ahead; a couple said yes and didn't make it.
      ATTENDANCE_TEAM.forEach((who, i) => {
        if ((i + n) % 5 === 0) return; // didn't answer
        const came = people.includes(who);
        if (kind === "REGULAR") rsvp(who, day, { regular: came ? (i % 6 === 2 ? "HALF" : "YES") : i % 2 ? "NO" : "YES" });
        else rsvp(who, day, { flex: came ? "YES" : "NO" });
      });
    }
  }
  // On the last Regular day, someone who said Yes and didn't come was marked "No credit" (not an e2e person).
  if (lastRegular) {
    const { id, day, opener, openedAt, people } = lastRegular;
    const who = ATTENDANCE_TEAM.find((p) => !people.includes(p) && p !== opener && !ATTENDANCE_E2E_PEOPLE.includes(p));
    if (who) {
      rsvp(who, day, { regular: "YES" });
      const when = new Date(openedAt.getTime() + 1.5 * HOUR);
      await tx.attendanceRecord.create({
        data: {
          sessionId: id,
          userId: uid(who),
          method: "MANUAL",
          markedById: uid(opener),
          checkedInAt: when,
          credit: 0,
          creditKind: "REGULAR",
          creditChangedAt: when,
          creditChangedById: uid(opener),
        },
      });
      changes.push({
        sessionId: id,
        sessionDate: dateOnlyToDb(day),
        sessionKind: "REGULAR",
        userId: uid(who),
        userName: PEOPLE[who].name,
        changedById: uid(opener),
        action: "ADDED",
        toCredit: 0,
        toKind: "REGULAR",
        createdAt: when,
      });
    }
  }
  await tx.attendanceChange.createMany({ data: changes });

  // The next week's answers, the extra meeting's too (not for the people the e2e tests use).
  const upcoming: DateOnly[] = [];
  for (let offset = 0; offset <= 7; offset++) {
    const day = addDays(today, offset);
    if (isTeamDay(settings, day)) upcoming.push(day);
  }
  upcoming.forEach((day, d) => {
    ATTENDANCE_TEAM.forEach((who, i) => {
      if (ATTENDANCE_E2E_PEOPLE.includes(who) || (i + d) % 4 === 0) return;
      if (isRegularDay(settings, day)) rsvp(who, day, { regular: (i + d) % 7 === 1 ? "NO" : (i + d) % 5 === 2 ? "HALF" : "YES" });
      if (isFlexDay(settings, day)) rsvp(who, day, { flex: (i + d) % 3 === 0 ? "NO" : "YES" });
      if ((i + d) % 11 === 3) rsvp(who, day, { note: "Leaving at 5" });
    });
  });
  await tx.attendanceRsvp.createMany({ data: [...rsvps.values()] });

  // The plan for the next team day.
  const next = upcoming.find((day) => day > today);
  if (next) {
    await tx.attendancePlan.create({
      data: {
        date: dateOnlyToDb(next),
        plan: "Build: finish the intake rollers. Software: tune the left-side auto. Business: sponsor calls at 4.",
        updatedById: uid("jordan"),
      },
    });
  }
}

// ── Announcements ─────────────────────────────────────────────────────────────

type SeedAnnouncement = { by: PersonKey; subteam: Subteam | null; title: string; body: string; hoursAgo: number; pinned?: boolean; editedHoursAgo?: number };

/** A pinned whole-team one, one for Build, one for Business, and an older one everyone has seen. */
const ANNOUNCEMENTS: SeedAnnouncement[] = [
  {
    by: "jordan",
    subteam: null,
    pinned: true,
    title: "Welcome to the 2026–27 season!",
    body: "Big season ahead: League Scrimmage 0 is our first chance to drive in front of judges.\n\nCheck Today every day for your tasks, answer Coming? for each meeting, and ask in Questions if you're stuck.\nGame manual: https://www.firstinspires.org/resource-library/ftc/game-and-season-info",
    hoursAgo: 50,
  },
  {
    by: "marcus",
    subteam: "BUILD",
    title: "Bring safety glasses on Saturday",
    body: "Extra build day this Saturday, 9 to 1. We're cutting aluminum for the intake, so no glasses = no tools.\nLunch is on the team.",
    hoursAgo: 20,
  },
  {
    by: "amara",
    subteam: "BUSINESS",
    title: "Sponsor thank-you cards due Friday",
    body: "Each of us writes two cards. The list of sponsors and addresses is in Sponsorships → Info for applications.",
    hoursAgo: 5,
  },
  {
    by: "elena",
    subteam: null,
    title: "Engineering notebook check next week",
    body: "I'll read every notebook page next Tuesday. Make sure your entries have dates, pictures, and what you'd change next time.",
    hoursAgo: 24 * 8,
    editedHoursAgo: 24 * 8 - 2,
  },
];

/** When everyone last opened Announcements in the demo: the older one is seen, the rest are new. */
const ANNOUNCEMENTS_SEEN_HOURS_AGO = 24 * 5;

async function seedAnnouncements(tx: Tx, ago: (hours: number) => Date, uid: (key: PersonKey) => string) {
  await tx.announcement.createMany({
    data: ANNOUNCEMENTS.map((a) => ({
      title: a.title,
      body: a.body,
      subteam: a.subteam,
      pinned: a.pinned ?? false,
      authorId: uid(a.by),
      createdAt: ago(a.hoursAgo),
      editedAt: a.editedHoursAgo === undefined ? null : ago(a.editedHoursAgo),
      updatedAt: ago(a.editedHoursAgo ?? a.hoursAgo),
    })),
  });
  await tx.user.updateMany({ where: { status: "ACTIVE" }, data: { announcementsSeenAt: ago(ANNOUNCEMENTS_SEEN_HOURS_AGO) } });
}

// ── Discussion ────────────────────────────────────────────────────────────────

interface SeedDiscussion {
  /** Fixed, so e2e and the screenshot tour can open them. */
  id: string;
  title: string;
  body: string;
  category: NonNullable<Prisma.DiscussionThreadCreateManyInput["category"]>;
  by: PersonKey;
  hoursAgo: number;
  pinned?: boolean;
  locked?: boolean;
  replies: { by: PersonKey; hoursAgo: number; body: string; editedHoursAgo?: number }[];
  /** Who has opened it: "everyone" (ACTIVE) up to its last activity, or each person up to how many replies they saw. */
  readBy: "everyone" | Partial<Record<PersonKey, number>>;
}

/** A pinned welcome, a busy Software one, a Build one with news for its helpers, and a locked vote. */
const DISCUSSIONS: SeedDiscussion[] = [
  {
    id: "demo-thread-welcome",
    title: "Welcome to Discussion: read me first",
    body: "This is the team's place to talk things over: ideas, robot questions, plans, and fun stuff.\n\nQuestions just for your leaders still go in Questions. Keep it kind, and use Off-topic for everything that isn't robots.\nLeaders can pin or lock a discussion when needed. Go Huskies!",
    category: "GENERAL",
    by: "jordan",
    hoursAgo: 24 * 10,
    pinned: true,
    replies: [
      { by: "maya", hoursAgo: 24 * 9 + 20, body: "Love this! Way easier than scrolling through the group chat." },
      { by: "david", hoursAgo: 24 * 9 + 18, body: "Great idea. Remember that the whole team, mentors included, can read everything here." },
    ],
    readBy: "everyone",
  },
  {
    id: "demo-thread-autos",
    title: "Pedro Pathing or Road Runner for this season's autos?",
    body: "We used Road Runner last year, but the Pedro planner on the Strategy page is really nice: smoother curves, and we can draw paths in the visualizer.\n\nShould we switch, or stick with what we know?",
    category: "SOFTWARE",
    by: "aiden",
    hoursAgo: 24 * 3,
    replies: [
      { by: "priya", hoursAgo: 24 * 2 + 20, body: "Let's try Pedro on the red audience auto first and compare cycle times at the scrimmage." },
      { by: "lucas", hoursAgo: 24 * 2, body: "I can port the drive constants this week. Does anyone know where last year's tuning values are?" },
      { by: "maya", hoursAgo: 30, body: "They're in the Software Notebook, on the Competition page. Screenshot of the old values: https://example.com/tuning-2025" },
      {
        by: "chloe",
        hoursAgo: 5,
        body: "Tested Pedro on the practice field today: the curve into the basket is way smoother, and the whole auto is about 2 s faster. +1 for switching.",
        editedHoursAgo: 4,
      },
    ],
    readBy: { aiden: 4, priya: 2, lucas: 3, maya: 3 },
  },
  {
    id: "demo-thread-intake",
    title: "Intake keeps jamming on the second ball",
    body: "When we pick up two in a row, the second one gets stuck under the top roller. Video from Tuesday: https://example.com/intake-jam\n\nIdeas?",
    category: "BUILD",
    by: "ethan",
    hoursAgo: 26,
    replies: [
      { by: "marcus", hoursAgo: 22, body: "Try raising the top roller about 1/4 in. and check the belt tension." },
      { by: "zara", hoursAgo: 20, body: "We had the same problem last year. Softer compliant wheels fixed it." },
      { by: "ethan", hoursAgo: 3, body: "Raised it 1/4 in. and it works now, 20 pickups in a row. Thanks!" },
    ],
    readBy: { ethan: 3, marcus: 1, zara: 2 },
  },
  {
    id: "demo-thread-shirts",
    title: "Team T-shirt color vote",
    body: "Vote here! Options: green (team color), black, or gray. Most votes by Friday wins.",
    category: "OFF_TOPIC",
    by: "grace",
    hoursAgo: 24 * 6,
    locked: true,
    replies: [
      { by: "ava", hoursAgo: 24 * 6 - 1, body: "Green!" },
      { by: "mateo", hoursAgo: 24 * 6 - 3, body: "Black looks cooler." },
      { by: "hannah", hoursAgo: 24 * 5 + 20, body: "Green, obviously." },
      { by: "amara", hoursAgo: 24 * 5, body: "Green wins! Ordering this week. Locking this so the vote stays final. Thanks, everyone." },
    ],
    readBy: "everyone",
  },
];

async function seedDiscussions(tx: Tx, ago: (hours: number) => Date, uid: (key: PersonKey) => string) {
  const everyone = await tx.user.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  for (const d of DISCUSSIONS) {
    const startedAt = ago(d.hoursAgo);
    const replies = d.replies.map((r) => ({ ...r, at: ago(r.hoursAgo) }));
    const last = replies.at(-1);
    await tx.discussionThread.create({
      data: {
        id: d.id,
        title: d.title,
        body: d.body,
        category: d.category,
        authorId: uid(d.by),
        pinned: d.pinned ?? false,
        locked: d.locked ?? false,
        replyCount: replies.length,
        lastActivityAt: last?.at ?? startedAt,
        lastActivityById: uid(last?.by ?? d.by),
        createdAt: startedAt,
        updatedAt: startedAt,
        replies: {
          create: replies.map((r) => ({
            body: r.body,
            authorId: uid(r.by),
            createdAt: r.at,
            editedAt: r.editedHoursAgo === undefined ? null : ago(r.editedHoursAgo),
            updatedAt: r.editedHoursAgo === undefined ? r.at : ago(r.editedHoursAgo),
          })),
        },
      },
      select: { id: true },
    });
    const marks =
      d.readBy === "everyone"
        ? everyone.map((u) => ({ userId: u.id, lastReadAt: last?.at ?? startedAt }))
        : (Object.entries(d.readBy) as [PersonKey, number][]).map(([who, seen]) => ({
            userId: uid(who),
            lastReadAt: seen > 0 ? replies[seen - 1].at : startedAt,
          }));
    await tx.discussionRead.createMany({ data: marks.map((m) => ({ ...m, threadId: d.id })) });
  }
}

// ── Seeding ───────────────────────────────────────────────────────────────────

/** Delete every app row, children first. */
async function wipeAppData(tx: Tx): Promise<void> {
  await tx.announcement.deleteMany();
  // The season schedule comes from a migration (it has a sourceKey) and stays; events people added go.
  await tx.calendarEvent.deleteMany({ where: { sourceKey: null } });
  await tx.attendanceChange.deleteMany(); // the admins' change log (it outlives sessions and accounts otherwise)
  await tx.attendanceSession.deleteMany(); // check-ins cascade
  await tx.attendanceRsvp.deleteMany();
  await tx.attendancePlan.deleteMany();
  await tx.fundraiser.deleteMany(); // helper lists cascade
  await tx.poster.deleteMany(); // poster files cascade
  await tx.strategy.deleteMany(); // strategy files cascade
  await tx.notebook.deleteMany(); // pages, entries, history, and pictures cascade
  // The league's teams come from a migration and stay; only what people wrote about them goes.
  await tx.leagueTeam.updateMany({ data: { summary: "", summaryUpdatedAt: null, summaryUpdatedById: null } });
  await tx.sponsorship.deleteMany();
  await tx.teamNote.deleteMany();
  await tx.part.deleteMany();
  await tx.purchaseItem.deleteMany();
  await tx.resource.deleteMany();
  await tx.emailLog.deleteMany();
  await tx.rateLimit.deleteMany();
  await tx.discussionThread.deleteMany(); // replies and read marks cascade
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

      // Posters (whole team): pictures for upcoming, undated, and past events, and one link-only.
      for (const p of POSTERS) {
        const bytes = p.png ? Uint8Array.from(Buffer.from(p.png, "base64")) : null;
        const createdAt = ago(p.addedHoursAgo);
        await tx.poster.create({
          data: {
            title: p.title,
            description: p.description ?? "",
            event: p.event ?? "",
            eventDate: p.date === undefined ? null : dateOnlyToDb(addDays(today, p.date)),
            link: p.link ?? "",
            createdById: uid(p.creator),
            createdAt,
            file: bytes
              ? { create: { filename: `${p.title.replace(/[^A-Za-z0-9 ]+/g, "").trim()}.png`, contentType: "image/png", size: bytes.byteLength, data: bytes, createdAt } }
              : undefined,
          },
          select: { id: true },
        });
      }

      // Strategy (whole team): a pinned auto with a .pp path, a match plan with a link, and scouting notes.
      for (const s of STRATEGIES) {
        const createdAt = ago(s.addedHoursAgo);
        const bytes = s.path ? new TextEncoder().encode(JSON.stringify(s.path.data, null, 2)) : null;
        await tx.strategy.create({
          data: {
            title: s.title,
            kind: s.kind,
            description: s.description,
            link: s.link ?? "",
            pinned: s.pinned ?? false,
            createdById: uid(s.creator),
            createdAt,
            updatedAt: createdAt,
            files:
              s.path && bytes
                ? { create: { filename: s.path.filename, contentType: "application/json", size: bytes.byteLength, data: bytes, createdAt } }
                : undefined,
          },
          select: { id: true },
        });
      }

      // Strategy → Other teams: a summary and a traced auto for one league team (skipped if it isn't on the list).
      for (const t of LEAGUE_TEAM_SUMMARIES) {
        await tx.leagueTeam.updateMany({
          where: { number: t.number },
          data: { summary: t.summary, summaryUpdatedAt: ago(t.hoursAgo), summaryUpdatedById: uid(t.by) },
        });
      }
      for (const s of LEAGUE_TEAM_STRATEGIES) {
        const team = await tx.leagueTeam.findUnique({ where: { number: s.teamNumber }, select: { id: true } });
        if (!team) continue;
        const createdAt = ago(s.addedHoursAgo);
        const bytes = new TextEncoder().encode(JSON.stringify(s.path.data, null, 2));
        await tx.strategy.create({
          data: {
            title: s.title,
            kind: "AUTO",
            description: s.description,
            teamId: team.id,
            createdById: uid(s.creator),
            createdAt,
            updatedAt: createdAt,
            files: { create: { filename: s.path.filename, contentType: "application/json", size: bytes.byteLength, data: bytes, createdAt } },
          },
          select: { id: true },
        });
      }

      // Fundraising: every status, helpers signed up (one fundraiser full), and a season goal.
      for (const [i, f] of FUNDRAISERS.entries()) {
        const day = (n: number | undefined) => (n === undefined ? null : dateOnlyToDb(addDays(today, n)));
        const createdAt = ago(24 * (Math.max(7, 12 - (f.starts ?? 0)) + i));
        await tx.fundraiser.create({
          data: {
            name: f.name,
            kind: f.kind,
            status: f.status,
            description: f.description ?? "",
            location: f.location ?? "",
            link: f.link ?? "",
            startsOn: day(f.starts),
            endsOn: day(f.ends),
            goalAmount: f.goal ?? null,
            raisedAmount: f.raised ?? 0,
            leadId: f.lead ? uid(f.lead) : null,
            volunteerLimit: f.limit ?? null,
            createdById: uid(f.creator),
            createdAt,
            volunteers: {
              create: (f.helpers ?? []).map((who, j) => ({ userId: uid(who), createdAt: new Date(createdAt.getTime() + (j + 1) * 3 * HOUR) })),
            },
          },
          select: { id: true },
        });
      }
      // Keys = FUNDRAISING_SEASON_GOAL_KEY / _START_KEY in src/server/services/fundraising.ts (not imported: server-only).
      await tx.teamNote.create({
        data: { key: "fundraising-season-goal", body: String(FUNDRAISING_SEASON_GOAL), updatedById: uid("amara") },
      });
      await tx.teamNote.create({
        data: { key: "fundraising-season-start", body: addDays(today, FUNDRAISING_SEASON_START_DAYS), updatedById: uid("amara") },
      });

      // Team notebook: the standard notebooks with a few entries (one changed later, one with a picture).
      for (const [position, nb] of STANDARD_NOTEBOOKS.entries()) {
        const setUpAt = ago(24 * 30);
        const notebook = await tx.notebook.create({
          data: {
            title: nb.title,
            emoji: nb.emoji,
            description: nb.description,
            subteam: nb.subteam,
            position,
            createdById: uid("jordan"),
            createdAt: setUpAt,
            pages: { create: nb.pages.map((title, i) => ({ title, position: i, createdById: uid("jordan"), createdAt: setUpAt })) },
          },
          select: { pages: { select: { id: true, title: true } } },
        });
        for (const page of notebook.pages) {
          for (const e of NOTEBOOK_ENTRIES[`${nb.title} / ${page.title}`] ?? []) {
            const createdAt = ago(e.hoursAgo);
            const editedAt = e.edited ? ago(e.edited.hoursAgo) : null;
            const png = e.png ? Uint8Array.from(Buffer.from(e.png.data, "base64")) : null;
            await tx.notebookEntry.create({
              data: {
                pageId: page.id,
                title: e.title ?? "",
                body: e.body,
                authorId: uid(e.author),
                createdAt,
                updatedAt: editedAt ?? createdAt,
                lastEditedById: e.edited ? uid(e.edited.by) : null,
                lastEditedAt: editedAt,
                edits: e.edited
                  ? {
                      create: {
                        editorId: uid(e.edited.by),
                        editedAt: editedAt!,
                        previousTitle: e.edited.previousTitle ?? e.title ?? "",
                        previousBody: e.edited.previousBody,
                      },
                    }
                  : undefined,
                images:
                  png && e.png
                    ? {
                        create: {
                          filename: e.png.filename,
                          contentType: "image/png",
                          size: png.byteLength,
                          data: png,
                          width: e.png.width,
                          height: e.png.height,
                          createdAt,
                        },
                      }
                    : undefined,
              },
              select: { id: true },
            });
          }
        }
      }

      // Order list (whole team): something in every status; the T-shirts have no price yet.
      await tx.purchaseItem.createMany({ data: purchaseRows(ago, uid) });

      // Discussion: a pinned welcome, a busy Software discussion, a Build one, and a locked vote (with read marks).
      await seedDiscussions(tx, ago, uid);

      // Attendance: two weeks of sessions and check-ins, "Coming?" answers, and the next team day's plan.
      await seedAttendance(tx, today, uid);

      // Announcements: a pinned welcome, one each for Build and Business, and an older one everyone has seen.
      await seedAnnouncements(tx, ago, uid);

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
