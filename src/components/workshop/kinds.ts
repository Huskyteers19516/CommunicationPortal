// What the Workshop's pages call things, by kind of project (client-safe: the form and the project page share it).
import { Box, CodeXml, Hammer, type LucideIcon } from "lucide-react";
import { TEAM_SITE_ORIGIN } from "@/lib/public-progress";
import type { WorkshopKindValue } from "@/lib/workshop";

/** The team website's Workshop page. */
export const WORKSHOP_SITE_URL = `${TEAM_SITE_ORIGIN}/workshop`;

/** A project on the team website's Workshop page (it scrolls to the project). */
export function workshopSiteHref(projectId: string): string {
  return `${WORKSHOP_SITE_URL}#${encodeURIComponent(projectId)}`;
}

export const WORKSHOP_KIND_ICONS: Record<WorkshopKindValue, LucideIcon> = {
  PART: Box,
  SOFTWARE: CodeXml,
  OTHER: Hammer,
};

export interface WorkshopFieldLabels {
  /** The summary box. */
  summary: string;
  summaryPlaceholder: string;
  /** The material box. */
  material: string;
  materialPlaceholder: string;
  /** The main link. */
  link: string;
  linkHint?: string;
  titlePlaceholder: string;
}

export const WORKSHOP_FIELD_LABELS: Record<WorkshopKindValue, WorkshopFieldLabels> = {
  PART: {
    summary: "What it does on the robot",
    summaryPlaceholder: "e.g. Holds the intake roller. Version 2 is lighter and doesn't crack on impact.",
    material: "Material",
    materialPlaceholder: "e.g. PETG",
    link: "CAD link",
    linkHint: "Onshape, Printables, GrabCAD…",
    titlePlaceholder: "e.g. Intake roller bracket",
  },
  SOFTWARE: {
    summary: "What it does",
    summaryPlaceholder: "e.g. Scouts other teams at competitions and ranks them for alliance selection.",
    material: "Built with",
    materialPlaceholder: "e.g. Next.js, Postgres",
    link: "Website or app link",
    titlePlaceholder: "e.g. Scouting app",
  },
  OTHER: {
    summary: "What it does",
    summaryPlaceholder: "e.g. A half-size practice field wall we can set up in the classroom.",
    material: "Made of",
    materialPlaceholder: "e.g. Plywood and aluminum extrusion",
    link: "Link",
    titlePlaceholder: "e.g. Practice field wall",
  },
};
