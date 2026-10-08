// Client-safe team constants. Enum values come straight from the Prisma schema.
import {
  AccountStatus,
  AssignmentStatus,
  CalendarEventKind,
  DiscussionCategory,
  PartProcess,
  PartStatus,
  FundraiserKind,
  FundraiserStatus,
  Priority,
  PurchaseStatus,
  StrategyKind,
  QuestionStatus,
  ResourceStatus,
  ResourceType,
  Role,
  SponsorshipStage,
  Subteam,
} from "@/generated/prisma/enums";

export {
  CalendarEventKind,
  DiscussionCategory,
  AccountStatus,
  AssignmentStatus,
  PartProcess,
  PartStatus,
  FundraiserKind,
  FundraiserStatus,
  Priority,
  PurchaseStatus,
  StrategyKind,
  QuestionStatus,
  ResourceStatus,
  ResourceType,
  Role,
  SponsorshipStage,
  Subteam,
};

export const TEAM_NAME = "The Huskyteers";
export const TEAM_NUMBER = "19516";
export const APP_NAME = "Huskyteers Portal";

export const ROLE_LABELS: Record<Role, string> = {
  MEMBER: "Member",
  SOFTWARE_LEADER: "Software Leader",
  BUILD_LEADER: "Build Leader",
  BUSINESS_LEADER: "Business Leader",
  CAPTAIN: "Captain",
  MENTOR: "Mentor",
  TEACHER: "Teacher",
};

export const SUBTEAM_LABELS: Record<Subteam, string> = {
  SOFTWARE: "Software",
  BUILD: "Build",
  BUSINESS: "Business",
};

/** A person's position as the app shows it: "Build Leader", "Software member", "Mentor". */
export function describeRole(role: Role, subteam: Subteam | null): string {
  if (role === "MEMBER") return subteam ? `${SUBTEAM_LABELS[subteam]} member` : "Member";
  return ROLE_LABELS[role];
}

export const STATUS_LABELS: Record<AccountStatus, string> = {
  PENDING: "Pending approval",
  ACTIVE: "Active",
  REJECTED: "Rejected",
  DISABLED: "Disabled",
};

export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  TODO: "To do",
  SUBMITTED: "Waiting for review",
  APPROVED: "Approved",
  REJECTED: "Needs changes",
};

export const QUESTION_STATUS_LABELS: Record<QuestionStatus, string> = {
  OPEN: "Open",
  ANSWERED: "Answered",
  RESOLVED: "Resolved",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
};

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  DOCUMENT: "Document",
  SPREADSHEET: "Spreadsheet",
  WEBSITE: "Website",
  CAD: "CAD",
  CODE: "Code",
  VIDEO: "Video",
  OTHER: "Other",
};

export const RESOURCE_TYPES = Object.values(ResourceType) as ResourceType[];

export const RESOURCE_STATUS_LABELS: Record<ResourceStatus, string> = {
  PENDING: "Waiting for approval",
  APPROVED: "Approved",
  REJECTED: "Sent back",
};

/** In the order a sponsorship moves through them (used for sorting and the stage menu). */
export const SPONSORSHIP_STAGES: SponsorshipStage[] = [
  "NOT_STARTED",
  "DO_SOON",
  "IN_PROGRESS",
  "SUBMITTED",
  "ACCEPTED",
  "DECLINED",
  "FINISHED",
];

export const SPONSORSHIP_STAGE_LABELS: Record<SponsorshipStage, string> = {
  NOT_STARTED: "Haven't started",
  DO_SOON: "Do soon",
  IN_PROGRESS: "Needs work",
  SUBMITTED: "Submitted",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  FINISHED: "Finished",
};

export const PART_PROCESSES: PartProcess[] = ["PRINT_3D", "LASER_CUT", "CNC", "CUT", "MACHINE", "OTHER"];

export const PART_PROCESS_LABELS: Record<PartProcess, string> = {
  PRINT_3D: "3D print",
  LASER_CUT: "Laser cut",
  CNC: "CNC",
  CUT: "Cut",
  MACHINE: "Machine",
  OTHER: "Other",
};

export const PART_STATUS_LABELS: Record<PartStatus, string> = {
  NEEDED: "Up for grabs",
  CLAIMED: "Being made",
  DONE: "Done",
};

export const FUNDRAISER_KINDS: FundraiserKind[] = ["EVENT", "SALE", "ONLINE", "OTHER"];

export const FUNDRAISER_KIND_LABELS: Record<FundraiserKind, string> = {
  EVENT: "Event",
  SALE: "Sale",
  ONLINE: "Online",
  OTHER: "Other",
};

/** In the order a fundraiser moves through them. */
export const FUNDRAISER_STATUSES: FundraiserStatus[] = ["PLANNING", "UPCOMING", "ACTIVE", "DONE", "CANCELLED"];

export const FUNDRAISER_STATUS_LABELS: Record<FundraiserStatus, string> = {
  PLANNING: "Planning",
  UPCOMING: "Upcoming",
  ACTIVE: "Happening now",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

/** In the order an item moves through them. */
export const PURCHASE_STATUSES: PurchaseStatus[] = ["REQUESTED", "APPROVED", "ORDERED", "DONE", "NOT_NEEDED"];

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  REQUESTED: "Requested",
  APPROVED: "Approved",
  ORDERED: "Ordered",
  DONE: "Done",
  NOT_NEEDED: "N/A",
};

export const STRATEGY_KINDS: StrategyKind[] = ["AUTO", "TELEOP", "ENDGAME", "MATCH", "SCOUTING", "OTHER"];

export const STRATEGY_KIND_LABELS: Record<StrategyKind, string> = {
  AUTO: "Autonomous",
  TELEOP: "TeleOp",
  ENDGAME: "Endgame",
  MATCH: "Match plan",
  SCOUTING: "Scouting",
  OTHER: "Other",
};

/** In the order they're offered on the form. */
export const CALENDAR_EVENT_KINDS: CalendarEventKind[] = ["MEET", "ILT", "SCRIMMAGE", "COMPETITION", "MEETING", "OUTREACH", "TEAM", "DEADLINE", "OTHER"];

export const CALENDAR_EVENT_KIND_LABELS: Record<CalendarEventKind, string> = {
  MEET: "League meet",
  ILT: "League tournament (ILT)",
  SCRIMMAGE: "League scrimmage",
  COMPETITION: "Competition",
  MEETING: "Extra meeting",
  OUTREACH: "Outreach",
  TEAM: "Team event",
  DEADLINE: "Deadline",
  OTHER: "Other",
};

/** Kinds that count as "the next meet" (Today's countdown and the calendar's banner). */
export const CALENDAR_MEET_KINDS: CalendarEventKind[] = ["MEET", "ILT", "SCRIMMAGE", "COMPETITION"];

/** In the order they're offered (Discussion). */
export const DISCUSSION_CATEGORIES: DiscussionCategory[] = ["GENERAL", "SOFTWARE", "BUILD", "BUSINESS", "IDEAS", "OFF_TOPIC"];

export const DISCUSSION_CATEGORY_LABELS: Record<DiscussionCategory, string> = {
  GENERAL: "General",
  SOFTWARE: "Software",
  BUILD: "Build",
  BUSINESS: "Business",
  IDEAS: "Ideas",
  OFF_TOPIC: "Off-topic",
};

/** Our FTC team number (left out of Strategy → Other teams). */
export const OUR_TEAM_NUMBER = 19516;

/**
 * The team's Pedro Pathing visualizer (BIOBUZZ edition) on GitHub Pages. The Strategy page shows this site's own copy
 * (PLANNER_URL in ./planner-paths.ts, with the team library); this one is the fallback link.
 */
export const PEDRO_VISUALIZER_URL = "https://martinmax0711.github.io/PedroPathingBiobuzz/";

export const ROLES = Object.values(Role) as Role[];
export const SUBTEAMS = Object.values(Subteam) as Subteam[];

/** Subteam leader roles and the subteam each one leads. */
export const LEADER_ROLE_SUBTEAM = {
  SOFTWARE_LEADER: "SOFTWARE",
  BUILD_LEADER: "BUILD",
  BUSINESS_LEADER: "BUSINESS",
} as const satisfies Partial<Record<Role, Subteam>>;

export type SubteamLeaderRole = keyof typeof LEADER_ROLE_SUBTEAM;

export const SUBTEAM_LEADER_ROLE: Record<Subteam, SubteamLeaderRole> = {
  SOFTWARE: "SOFTWARE_LEADER",
  BUILD: "BUILD_LEADER",
  BUSINESS: "BUSINESS_LEADER",
};

/** How many people may hold each leadership seat. The admin sees a warning when approving past the limit. */
export const SEAT_LIMITS: Partial<Record<Role, number>> = {
  CAPTAIN: 1,
  SOFTWARE_LEADER: 1,
  BUILD_LEADER: 3,
  BUSINESS_LEADER: 1,
};

/** Every role except MEMBER needs the site admin to approve the account. */
export function roleNeedsApproval(role: Role): boolean {
  return role !== "MEMBER";
}

export function isSubteamLeaderRole(role: Role): role is SubteamLeaderRole {
  return role in LEADER_ROLE_SUBTEAM;
}

/** Roles that can see and manage every subteam. */
export const ALL_SCOPE_ROLES: readonly Role[] = ["CAPTAIN", "MENTOR", "TEACHER"];

/** Roles that count as "staff" (can assign tasks, review, answer questions). */
export const STAFF_ROLES: readonly Role[] = [
  "SOFTWARE_LEADER",
  "BUILD_LEADER",
  "BUSINESS_LEADER",
  "CAPTAIN",
  "MENTOR",
  "TEACHER",
];

/** Returns the subteam a role implies (leaders), null for all-scope roles, or undefined if the user must choose (members). */
export function subteamForRole(role: Role): Subteam | null | undefined {
  if (isSubteamLeaderRole(role)) return LEADER_ROLE_SUBTEAM[role];
  if (role === "MEMBER") return undefined;
  return null;
}

export const LIMITS = {
  nameMax: 80,
  emailMax: 254,
  passwordMin: 8,
  passwordMax: 200,
  taskTitleMax: 140,
  taskDescriptionMax: 5000,
  questionTitleMax: 160,
  questionBodyMax: 5000,
  replyBodyMax: 5000,
  noteMax: 1000,
  resourceTitleMax: 120,
  resourceDescriptionMax: 500,
  resourceGroupMax: 60,
  resourceUrlMax: 2000,
  resourceLinksMax: 20,
  resourceLinkLabelMax: 60,
  /** Each uploaded file (any kind): under Vercel's 4.5 MB request limit, wherever it's stored. */
  resourceFileMaxBytes: 4 * 1024 * 1024,
  /**
   * Total size of every uploaded file together while they're stored in Postgres (protects the database's storage
   * quota). With Cloudflare R2 set up the cap is OBJECT_STORAGE_CAP_BYTES instead (src/server/files/storage.ts).
   */
  resourceStorageMaxBytes: 300 * 1024 * 1024,
  resourceFilenameMax: 120,
  categoryNameMax: 40,
  categoriesPerSubteamMax: 30,
  /** Most people a sign-up task can take. */
  signupLimitMax: 150,
  sponsorNameMax: 120,
  sponsorAskingMax: 200,
  sponsorNotesMax: 5000,
  /** Biggest amount received that can be entered, in dollars. */
  sponsorAmountMax: 10_000_000,
  /** Sponsorships' "Info for applications" note (its textarea's maxLength too). */
  teamNoteMax: 10000,
  /** Files attached to one sponsor (forms, filled-out copies…). */
  sponsorFilesMax: 10,
  partNameMax: 120,
  partMaterialMax: 80,
  partNotesMax: 2000,
  /** "For" on a part, when typed in instead of picked from the categories. */
  partForMax: 60,
  posterTitleMax: 120,
  posterEventMax: 80,
  posterDescriptionMax: 1000,
  fundraiserNameMax: 120,
  fundraiserLocationMax: 160,
  fundraiserDescriptionMax: 5000,
  fundraiserVolunteersMax: 200,
  /** "What we did" on an attendance session. */
  attendanceNoteMax: 2000,
  /** The plan for a day, written ahead by the captain/leaders. */
  attendancePlanMax: 2000,
  /** Optional note with a Coming? answer, e.g. "leaving at 5". */
  rsvpNoteMax: 200,
  /** How far ahead members can answer Coming? (days). */
  rsvpDaysAhead: 28,
  notebookTitleMax: 80,
  notebookPageTitleMax: 80,
  notebookEntryTitleMax: 160,
  notebookEntryBodyMax: 20000,
  notebookImagesPerEntry: 10,
  strategyTitleMax: 120,
  strategyDescriptionMax: 10000,
  strategyFilesMax: 10,
  purchaseDescriptionMax: 200,
  purchaseNotesMax: 1000,
  purchaseVendorMax: 80,
  purchaseQuantityMax: 10000,
  partQuantityMax: 500,
  calendarTitleMax: 120,
  calendarLocationMax: 200,
  calendarNotesMax: 5000,
  leagueTeamNameMax: 80,
  leagueTeamCityMax: 80,
  /** "Their strategy at a glance" on another league team. */
  leagueTeamSummaryMax: 5000,
  discussionTitleMax: 160,
  discussionBodyMax: 10000,
  discussionReplyMax: 5000,
  announcementTitleMax: 160,
  announcementBodyMax: 10000,
  meetingTitleMax: 160,
  /** A meeting recap's key points (one per line). */
  meetingKeyPointsMax: 20_000,
  /** A meeting recap's transcript: about 3 hours of talking, and still well under a Server Action's 5 MB. */
  meetingTranscriptMax: 300_000,
  plannerPathNameMax: 80,
  plannerPathNotesMax: 2000,
  /** A saved planner path's .pp JSON, in bytes. Real paths are a few KB. */
  plannerPathDataMaxBytes: 256 * 1024,
  saleItemNameMax: 80,
  saleItemCategoryMax: 40,
  saleCustomerMax: 80,
  saleNoteMax: 300,
  /** Different things on one order. */
  saleLinesMax: 40,
  /** How many of one thing on one order. */
  saleQuantityMax: 999,
  ledgerDescriptionMax: 200,
} as const;
