-- CreateEnum
CREATE TYPE "CalendarEventKind" AS ENUM ('MEET', 'ILT', 'SCRIMMAGE', 'COMPETITION', 'OUTREACH', 'TEAM', 'DEADLINE', 'OTHER');

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "CalendarEventKind" NOT NULL DEFAULT 'MEET',
    "startsOn" DATE NOT NULL,
    "endsOn" DATE,
    "startTime" TEXT,
    "endTime" TEXT,
    "location" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "sourceKey" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_sourceKey_key" ON "CalendarEvent"("sourceKey");

-- CreateIndex
CREATE INDEX "CalendarEvent_startsOn_idx" ON "CalendarEvent"("startsOn");

-- CreateIndex
CREATE INDEX "CalendarEvent_kind_startsOn_idx" ON "CalendarEvent"("kind", "startsOn");

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
