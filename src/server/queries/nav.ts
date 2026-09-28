import "server-only";
import { cache } from "react";
import type { Actor } from "../actor";
import { prisma } from "../db";
import { canAccessManage, canAdminister, canReviewResources } from "../permissions";
import { countUnreadAnnouncements } from "./announcements";
import { countUnreadDiscussions } from "./discussion";
import { questionInboxWhere, resourceReviewQueueWhere, reviewQueueWhere } from "../scopes";

export interface NavCounts {
  /** Staff: submissions waiting for my review. */
  reviewQueue: number;
  /** Staff: open questions in my inbox. */
  openQuestions: number;
  /** Everyone: my questions that have an answer I haven't closed yet. */
  answeredForMe: number;
  /** Admin: accounts waiting for approval. */
  pendingApprovals: number;
  /** Admin access: resources members shared that wait for approval. */
  pendingResources: number;
  /** Everyone: announcements for me posted since I last opened Announcements. */
  unreadAnnouncements: number;
  /** Everyone: Discussion threads with activity from others since I last opened them. */
  unreadDiscussions: number;
}

/** Badge counts for the navigation. Cached per request. */
export const getNavCounts = cache(async (actor: Actor): Promise<NavCounts> => {
  const staff = canAccessManage(actor);
  const admin = canAdminister(actor);
  const [reviewQueue, openQuestions, answeredForMe, pendingApprovals, pendingResources, unreadAnnouncements, unreadDiscussions] = await Promise.all([
    staff ? prisma.taskAssignment.count({ where: reviewQueueWhere(actor) }) : 0,
    staff ? prisma.question.count({ where: { AND: [questionInboxWhere(actor), { status: "OPEN" }] } }) : 0,
    prisma.question.count({ where: { askerId: actor.id, status: "ANSWERED" } }),
    admin ? prisma.user.count({ where: { status: "PENDING" } }) : 0,
    canReviewResources(actor) ? prisma.resource.count({ where: resourceReviewQueueWhere(actor) }) : 0,
    countUnreadAnnouncements(actor),
    countUnreadDiscussions(actor),
  ]);
  return { reviewQueue, openQuestions, answeredForMe, pendingApprovals, pendingResources, unreadAnnouncements, unreadDiscussions };
});
