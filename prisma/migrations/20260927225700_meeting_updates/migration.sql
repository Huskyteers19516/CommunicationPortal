-- CreateTable
CREATE TABLE "MeetingUpdate" (
    "id" TEXT NOT NULL,
    "meetingDate" DATE NOT NULL,
    "subteam" "Subteam" NOT NULL,
    "body" TEXT NOT NULL,
    "nextSteps" TEXT NOT NULL DEFAULT '',
    "blockers" TEXT NOT NULL DEFAULT '',
    "authorId" TEXT,
    "lastEditedAt" TIMESTAMP(3),
    "lastEditedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetingUpdate_meetingDate_subteam_idx" ON "MeetingUpdate"("meetingDate", "subteam");

-- CreateIndex
CREATE INDEX "MeetingUpdate_subteam_meetingDate_idx" ON "MeetingUpdate"("subteam", "meetingDate");

-- CreateIndex
CREATE INDEX "MeetingUpdate_authorId_idx" ON "MeetingUpdate"("authorId");

-- AddForeignKey
ALTER TABLE "MeetingUpdate" ADD CONSTRAINT "MeetingUpdate_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingUpdate" ADD CONSTRAINT "MeetingUpdate_lastEditedById_fkey" FOREIGN KEY ("lastEditedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
