import "server-only";
// The team website's Workshop page (https://huskyteers19516.github.io/workshop): the APPROVED projects as public data
// (PublicWorkshop in src/lib/workshop.ts), and the rows behind their public photos and design files. Served by
// publicWorkshopResponse / publicWorkshopPhotoResponse / publicWorkshopFileResponse in ../public-api.ts.
// Anything not approved (a draft, waiting for approval, sent back, taken off the website) is never in the answer and
// its photos and files are 404s, so nothing becomes public before a reviewer has approved it. Never in the answer:
// account ids, emails, who added or reviewed a project, review notes.
import { PUBLIC_WORKSHOP_FILES_PREFIX, PUBLIC_WORKSHOP_PHOTOS_PREFIX } from "@/lib/public-api";
import { type NameStyle, publicName } from "@/lib/public-progress";
import { parseHttpUrl } from "@/lib/urls";
import {
  defaultCoverIndex,
  type PublicWorkshop,
  type PublicWorkshopPhoto,
  type PublicWorkshopProject,
  workshopExtension,
  workshopFileFormat,
} from "@/lib/workshop";
import type { Db } from "../db";
import { STORED_FILE_SELECT } from "../files/respond";
import { getPublicProgressConfig } from "./public-progress";
import { splitExtraCredits } from "./workshop";

/** At most this many projects in the answer (the featured ones, then the newest on the website). */
export const PUBLIC_WORKSHOP_MAX = 200;

export function publicWorkshopPhotoPath(photoId: string): string {
  return `${PUBLIC_WORKSHOP_PHOTOS_PREFIX}${encodeURIComponent(photoId)}`;
}

export function publicWorkshopFilePath(fileId: string): string {
  return `${PUBLIC_WORKSHOP_FILES_PREFIX}${encodeURIComponent(fileId)}`;
}

/**
 * A credit as the website shows names: publicName for the name, keeping a note in brackets after it ("Alex Park
 * (2024 alum)" → "Alex P. (2024 alum)"), so a note isn't taken for part of the name. Null when names are hidden.
 */
export function publicCredit(credit: string, style: NameStyle): string | null {
  const m = /^(.*?)\s*(\([^()]*\))\s*$/.exec(credit.trim());
  const name = publicName(m && m[1] ? m[1] : credit, style);
  if (!name) return null;
  return m && m[1] ? `${name} ${m[2]}` : name;
}

/** The approved projects, as the team website shows them. Names follow the website's name style (Admin → Team website). */
export async function getPublicWorkshop(db: Db, { now }: { now: Date }): Promise<PublicWorkshop> {
  const { settings } = await getPublicProgressConfig(db);
  const rows = await db.workshopProject.findMany({
    where: { status: "APPROVED" },
    orderBy: [{ featured: "desc" }, { publishedAt: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
    take: PUBLIC_WORKSHOP_MAX,
    select: {
      id: true,
      kind: true,
      title: true,
      summary: true,
      material: true,
      season: true,
      extraCredits: true,
      link: true,
      codeLink: true,
      featured: true,
      coverPhotoId: true,
      publishedAt: true,
      updatedAt: true,
      credits: { orderBy: { position: "asc" }, select: { user: { select: { name: true } } } },
      photos: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, width: true, height: true, label: true, note: true },
      },
      files: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, filename: true, size: true, label: true } },
    },
  });

  const named = (name: string) => publicCredit(name, settings.nameStyle);
  const projects = rows.map((p): PublicWorkshopProject => {
    const photos: PublicWorkshopPhoto[] = p.photos.map((ph) => ({
      id: ph.id,
      path: publicWorkshopPhotoPath(ph.id),
      width: ph.width,
      height: ph.height,
      label: ph.label,
      note: ph.note,
    }));
    // Each person once (by their full name, before it's shortened: "Sam Lee" and "Sam Li" are two people).
    const designers = [...new Set([...p.credits.map((c) => c.user.name.trim()), ...splitExtraCredits(p.extraCredits)])]
      .map(named)
      .filter((n): n is string => !!n);
    return {
      id: p.id,
      kind: p.kind,
      title: p.title,
      summary: p.summary,
      material: p.material,
      season: p.season,
      designers,
      featured: p.featured,
      link: p.link ? parseHttpUrl(p.link) : null,
      codeLink: p.kind !== "PART" && p.codeLink ? parseHttpUrl(p.codeLink) : null,
      cover: photos.find((ph) => ph.id === p.coverPhotoId) ?? photos[defaultCoverIndex(p.kind, photos.length)] ?? null,
      photos,
      downloads: p.files.map((f) => ({
        id: f.id,
        path: publicWorkshopFilePath(f.id),
        filename: f.filename,
        format: workshopFileFormat(f.filename),
        size: f.size,
        label: f.label,
      })),
      publishedAt: (p.publishedAt ?? p.updatedAt).toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  });
  return { updatedAt: now.toISOString(), projects };
}

/** An approved project's photo with its bytes, or null (no such photo, or its project isn't on the website). */
export function getPublicWorkshopPhoto(db: Db, photoId: string) {
  return db.workshopPhoto.findFirst({ where: { id: photoId, project: { status: "APPROVED" } }, select: STORED_FILE_SELECT });
}

/** An approved project's design file with its bytes, or null (no such file, or its project isn't on the website). */
export function getPublicWorkshopFile(db: Db, fileId: string) {
  return db.workshopFile.findFirst({ where: { id: fileId, project: { status: "APPROVED" } }, select: STORED_FILE_SELECT });
}

/**
 * The neutral name a public photo is served under ("workshop-photo.jpg"): the uploaded name (IMG_0042.HEIC, a folder,
 * someone's name) never goes out with it.
 */
export function publicWorkshopPhotoFilename(stored: { filename: string }): string {
  const ext = workshopExtension(stored.filename);
  return `workshop-photo.${ext === "jpeg" ? "jpg" : ext || "jpg"}`;
}
