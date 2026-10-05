// The Workshop (client-safe): what the team designs and builds — 3D-printed and CAD parts, software, and other
// builds — with photos of each version and design files anyone can download. Projects are added in the portal
// (/workshop) and, once approved, shown on the team website's Workshop page
// (https://huskyteers19516.github.io/workshop), which reads GET /api/public/workshop.
// Rules: src/server/services/workshop.ts; the public answer: src/server/queries/public-workshop.ts and
// src/server/public-api.ts.
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "./files";

export const WORKSHOP_KINDS = ["PART", "SOFTWARE", "OTHER"] as const;
export type WorkshopKindValue = (typeof WORKSHOP_KINDS)[number];

/** Section names, in the order the team website shows them (parts first). */
export const WORKSHOP_KIND_LABELS: Record<WorkshopKindValue, string> = {
  PART: "3D prints & CAD",
  SOFTWARE: "Software",
  OTHER: "Other builds",
};

/** One project, in a sentence (the kind picker). */
export const WORKSHOP_KIND_HINTS: Record<WorkshopKindValue, string> = {
  PART: "A printed, cut, or machined part, with its CAD.",
  SOFTWARE: "An app, tool, or program the team wrote.",
  OTHER: "Anything else the team built: a field element, a pit display…",
};

export const WORKSHOP_STATUSES = ["DRAFT", "PENDING", "APPROVED", "REJECTED"] as const;
export type WorkshopStatusValue = (typeof WORKSHOP_STATUSES)[number];

export const WORKSHOP_STATUS_LABELS: Record<WorkshopStatusValue, string> = {
  DRAFT: "Draft",
  PENDING: "Waiting for approval",
  APPROVED: "On the website",
  REJECTED: "Needs changes",
};

export const WORKSHOP_LIMITS = {
  titleMax: 100,
  summaryMax: 600,
  /** Material ("PETG") for parts, "Built with" ("Next.js, Postgres") for software. */
  materialMax: 80,
  seasonMax: 20,
  /** Names of people without a portal account (alumni…), comma-separated. */
  extraCreditsMax: 200,
  /** People with portal accounts credited on one project. */
  creditsMax: 12,
  linkMax: 2000,
  photoLabelMax: 40,
  photoNoteMax: 300,
  fileLabelMax: 60,
  reviewNoteMax: 500,
  photosPerProject: 12,
  filesPerProject: 8,
} as const;

/** Suggestions for the material box (it takes anything). */
export const WORKSHOP_MATERIAL_SUGGESTIONS = [
  "PLA",
  "PLA+",
  "PETG",
  "TPU",
  "ABS",
  "ASA",
  "Nylon",
  "Carbon-fiber nylon",
  "Polycarbonate",
  "Aluminum",
  "Plywood",
] as const;

// ---------- photos ----------

/**
 * Which photo is the cover when nobody picked one: a part's newest version (the last photo — the finished part),
 * the first photo of software and other builds (usually the main screen). -1 when there are none.
 */
export function defaultCoverIndex(kind: WorkshopKindValue, photoCount: number): number {
  if (photoCount === 0) return -1;
  return kind === "PART" ? photoCount - 1 : 0;
}

/** What the photo picker offers (the camera roll on phones). */
export const WORKSHOP_PHOTO_ACCEPT = "image/png,image/jpeg,image/webp";
const PHOTO_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp"]);
const PHOTO_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * The longest side the form keeps when it makes a photo smaller before uploading (every guest who opens the
 * Workshop page downloads these, so they're kept web-sized).
 */
export const WORKSHOP_PHOTO_MAX_SIDE = 2000;
/** Photos over this size are made smaller (as a JPG) in the browser before uploading. */
export const WORKSHOP_PHOTO_SHRINK_OVER_BYTES = 1.5 * 1024 * 1024;

export const WORKSHOP_PHOTO_TYPES_MESSAGE = "Photos can be a PNG, JPG, or WebP picture.";
export const WORKSHOP_PHOTO_HEIC_MESSAGE =
  "That's an iPhone photo format (HEIC) that browsers can't show. Take a screenshot of it, or save it as a JPG, and try again.";
export const WORKSHOP_PHOTO_UNREADABLE_MESSAGE = "That picture couldn't be opened. Save it again as a PNG or JPG and try again.";

export function workshopPhotoTooBigMessage(size: number): string {
  return `That photo is ${formatFileSize(size)}. Photos can be up to ${RESOURCE_FILE_MAX_MB} MB — save a smaller JPG and try again.`;
}

// ---------- design files (downloads) ----------

/**
 * Design files people can download from the team website: CAD and 3D-printing formats, drawings (PDF), and ZIPs.
 * Always sent as downloads, never shown in the browser.
 */
export const WORKSHOP_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // meshes and printing
  "stl", "3mf", "obj", "amf", "ply", "gcode", "bgcode",
  // CAD exchange and native formats
  "step", "stp", "iges", "igs", "x_t", "x_b", "f3d", "f3z", "sldprt", "sldasm", "slddrw", "ipt", "iam", "scad",
  "dxf", "dwg",
  // drawings, bundles
  "pdf", "zip",
]);

export const WORKSHOP_FILE_TYPES_MESSAGE =
  "Design files can be STL, STEP, 3MF, OBJ, Fusion (F3D), SolidWorks, Inventor, IGES, DXF, G-code, PDF, or ZIP. Zip anything else, or add a link instead.";

export function workshopFileTooBigMessage(size: number): string {
  return `That file is ${formatFileSize(size)}. Design files can be up to ${RESOURCE_FILE_MAX_MB} MB — share bigger ones from Onshape, Printables, or Google Drive with a link instead.`;
}

/** Lower-case extension without the dot, or "". */
export function workshopExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

/** "bracket.STL" → "STL", "arm.x_t" → "X_T" (the format badge next to a download). */
export function workshopFileFormat(filename: string): string {
  return workshopExtension(filename).toUpperCase() || "FILE";
}

/** The problem with a picked photo (checked in the browser before sending), or null when it looks fine. */
export function workshopPhotoProblem(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return "That file is empty. Choose another one.";
  const ext = workshopExtension(file.name);
  const type = file.type.toLowerCase();
  if (ext === "heic" || ext === "heif" || type === "image/heic" || type === "image/heif") return WORKSHOP_PHOTO_HEIC_MESSAGE;
  if (!PHOTO_EXTENSIONS.has(ext) && !PHOTO_TYPES.has(type)) return WORKSHOP_PHOTO_TYPES_MESSAGE;
  return null;
}

/** The problem with a picked design file (checked in the browser before sending), or null when it looks fine. */
export function workshopFileProblem(file: { name: string; size: number }, maxBytes: number): string | null {
  if (file.size === 0) return "That file is empty. Choose another one.";
  if (!WORKSHOP_FILE_EXTENSIONS.has(workshopExtension(file.name))) return WORKSHOP_FILE_TYPES_MESSAGE;
  if (file.size > maxBytes) return workshopFileTooBigMessage(file.size);
  return null;
}

// ---------- the public answer (GET /api/public/workshop) ----------

export const PUBLIC_WORKSHOP_PATH = "/api/public/workshop";

/** A photo of one version (or a screenshot). `path` is on the portal: prefix the portal's address. */
export interface PublicWorkshopPhoto {
  id: string;
  /** e.g. "/api/public/workshop/photos/clx…" */
  path: string;
  width: number;
  height: number;
  /** e.g. "Version 1" ("" when none). */
  label: string;
  /** What changed, or what failed and why ("" when none). */
  note: string;
}

/** A design file anyone can download. `path` is on the portal: prefix the portal's address. */
export interface PublicWorkshopDownload {
  id: string;
  /** e.g. "/api/public/workshop/files/clx…" */
  path: string;
  filename: string;
  /** "STL", "STEP", "PDF"… */
  format: string;
  /** Bytes. */
  size: number;
  /** e.g. "Print-ready STL" ("" when none). */
  label: string;
}

export interface PublicWorkshopProject {
  id: string;
  kind: WorkshopKindValue;
  title: string;
  /** Parts: what it does on the robot. Software and other builds: what it is / does. */
  summary: string;
  /** Parts: the material ("PETG"). Software: what it's built with. "" when none. */
  material: string;
  /** e.g. "2025–26" ("" when none). */
  season: string;
  /** Who designed or built it, as the website shows names (may be empty). */
  designers: string[];
  /** Shown first in its section. */
  featured: boolean;
  /** Parts: the CAD (Onshape, Printables…). Software: the website or app. Null when none. */
  link: string | null;
  /** Source code (GitHub…). Null when none. */
  codeLink: string | null;
  /** The photo to show first (the finished part). Null when there are no photos. */
  cover: PublicWorkshopPhoto | null;
  /** Every photo in story order: the first version first. */
  photos: PublicWorkshopPhoto[];
  downloads: PublicWorkshopDownload[];
  /** When it first went on the website (ISO). */
  publishedAt: string;
  /** Last change (ISO). */
  updatedAt: string;
}

export interface PublicWorkshop {
  /** When this answer was made (ISO). */
  updatedAt: string;
  /** Approved projects: featured first, then the newest on the website first. */
  projects: PublicWorkshopProject[];
}
