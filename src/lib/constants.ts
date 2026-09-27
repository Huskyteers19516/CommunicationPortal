// Client-safe team constants. Enum values come straight from the Prisma schema.
import {
  AccountStatus,
  AssignmentStatus,
  Priority,
  QuestionStatus,
  ResourceStatus,
  ResourceType,
  Role,
  Subteam,
} from "@/generated/prisma/enums";

export { AccountStatus, AssignmentStatus, Priority, QuestionStatus, ResourceStatus, ResourceType, Role, Subteam };

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
  /** Uploaded files are stored in Postgres, so keep them small (and under Vercel's 4.5 MB request limit). */
  resourceFileMaxBytes: 4 * 1024 * 1024,
  /** Total size of every uploaded file together (protects the database's storage quota). */
  resourceStorageMaxBytes: 300 * 1024 * 1024,
  resourceFilenameMax: 120,
  categoryNameMax: 40,
  categoriesPerSubteamMax: 30,
  /** Most people a sign-up task can take. */
  signupLimitMax: 150,
} as const;
