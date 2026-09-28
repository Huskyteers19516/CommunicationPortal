-- Announcements replace Meeting updates, and attendance check-ins get a credit (1, 2/3, 1/2, 1/3, EC, Flex).
-- Meeting updates already written on the live site are kept: each one becomes an announcement for its subteam
-- (same author and time) before the MeetingUpdate table goes.

-- CreateEnum
CREATE TYPE "AttendanceCreditKind" AS ENUM ('REGULAR', 'EXTRA', 'FLEX');

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "credit" INTEGER NOT NULL DEFAULT 6,
ADD COLUMN     "creditChangedAt" TIMESTAMP(3),
ADD COLUMN     "creditChangedById" TEXT,
ADD COLUMN     "creditKind" "AttendanceCreditKind" NOT NULL DEFAULT 'REGULAR';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "announcementsSeenAt" TIMESTAMP(3);

-- Nothing that exists today counts as a "new" announcement (including the converted meeting updates below).
UPDATE "User" SET "announcementsSeenAt" = CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "subteam" "Subteam",
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "authorId" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_createdAt_idx" ON "Announcement"("createdAt");

-- CreateIndex
CREATE INDEX "Announcement_subteam_createdAt_idx" ON "Announcement"("subteam", "createdAt");

-- CreateIndex
CREATE INDEX "Announcement_pinned_createdAt_idx" ON "Announcement"("pinned", "createdAt");

-- Keep every meeting update as an announcement for its subteam, e.g. "Build meeting update · Tue, Sep 29".
INSERT INTO "Announcement" ("id", "title", "body", "subteam", "pinned", "authorId", "editedAt", "createdAt", "updatedAt")
SELECT
  'mu' || m."id",
  (CASE m."subteam" WHEN 'SOFTWARE' THEN 'Software' WHEN 'BUILD' THEN 'Build' ELSE 'Business' END)
    || ' meeting update · ' || to_char(m."meetingDate", 'Dy, Mon FMDD'),
  m."body"
    || CASE WHEN m."nextSteps" <> '' THEN E'\n\nNext time: ' || m."nextSteps" ELSE '' END
    || CASE WHEN m."blockers" <> '' THEN E'\n\nProblems or help needed: ' || m."blockers" ELSE '' END,
  m."subteam",
  false,
  m."authorId",
  m."lastEditedAt",
  m."createdAt",
  m."updatedAt"
FROM "MeetingUpdate" m;

-- DropForeignKey
ALTER TABLE "MeetingUpdate" DROP CONSTRAINT "MeetingUpdate_authorId_fkey";

-- DropForeignKey
ALTER TABLE "MeetingUpdate" DROP CONSTRAINT "MeetingUpdate_lastEditedById_fkey";

-- DropTable
DROP TABLE "MeetingUpdate";

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_creditChangedById_fkey" FOREIGN KEY ("creditChangedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Check-ins at Flex sessions count as Flex.
UPDATE "AttendanceRecord" r SET "creditKind" = 'FLEX' FROM "AttendanceSession" s WHERE s.id = r."sessionId" AND s.kind = 'FLEX';
