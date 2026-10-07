-- CreateTable
CREATE TABLE "MeetingCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingRecap" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "meetingDate" DATE NOT NULL,
    "keyPoints" TEXT NOT NULL DEFAULT '',
    "transcript" TEXT NOT NULL DEFAULT '',
    "durationSec" INTEGER,
    "createdById" TEXT,
    "editedAt" TIMESTAMP(3),
    "editedById" TEXT,
    "audioType" TEXT,
    "audioParts" INTEGER NOT NULL DEFAULT 0,
    "audioBytes" INTEGER NOT NULL DEFAULT 0,
    "audioExpiresAt" TIMESTAMP(3),
    "audioDeletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingRecap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingRecapCategory" (
    "recapId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,

    CONSTRAINT "MeetingRecapCategory_pkey" PRIMARY KEY ("recapId","categoryId")
);

-- CreateTable
CREATE TABLE "MeetingAudioPart" (
    "id" TEXT NOT NULL,
    "recapId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA,
    "storageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingAudioPart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeetingCategory_nameKey_key" ON "MeetingCategory"("nameKey");

-- CreateIndex
CREATE INDEX "MeetingRecap_meetingDate_createdAt_idx" ON "MeetingRecap"("meetingDate", "createdAt");

-- CreateIndex
CREATE INDEX "MeetingRecap_audioExpiresAt_idx" ON "MeetingRecap"("audioExpiresAt");

-- CreateIndex
CREATE INDEX "MeetingRecap_createdAt_idx" ON "MeetingRecap"("createdAt");

-- CreateIndex
CREATE INDEX "MeetingRecapCategory_categoryId_idx" ON "MeetingRecapCategory"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingAudioPart_storageKey_key" ON "MeetingAudioPart"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingAudioPart_recapId_position_key" ON "MeetingAudioPart"("recapId", "position");

-- AddForeignKey
ALTER TABLE "MeetingCategory" ADD CONSTRAINT "MeetingCategory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRecap" ADD CONSTRAINT "MeetingRecap_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRecap" ADD CONSTRAINT "MeetingRecap_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRecapCategory" ADD CONSTRAINT "MeetingRecapCategory_recapId_fkey" FOREIGN KEY ("recapId") REFERENCES "MeetingRecap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRecapCategory" ADD CONSTRAINT "MeetingRecapCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MeetingCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAudioPart" ADD CONSTRAINT "MeetingAudioPart_recapId_fkey" FOREIGN KEY ("recapId") REFERENCES "MeetingRecap"("id") ON DELETE CASCADE ON UPDATE CASCADE;




-- Every recording part keeps its bytes somewhere, and parts that live in R2 are queued for deletion like other uploads.
ALTER TABLE "MeetingAudioPart" ADD CONSTRAINT "MeetingAudioPart_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);
CREATE TRIGGER "MeetingAudioPart_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "MeetingAudioPart" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();

-- The usual kinds of meeting (people with admin access add, rename, and delete them).
INSERT INTO "MeetingCategory" ("id", "name", "nameKey", "updatedAt")
VALUES
  ('meetingcat-whole-team', 'Whole team', 'whole team', CURRENT_TIMESTAMP),
  ('meetingcat-leadership', 'Leadership', 'leadership', CURRENT_TIMESTAMP),
  ('meetingcat-strategy', 'Strategy', 'strategy', CURRENT_TIMESTAMP),
  ('meetingcat-build', 'Build', 'build', CURRENT_TIMESTAMP),
  ('meetingcat-software', 'Software', 'software', CURRENT_TIMESTAMP),
  ('meetingcat-business', 'Business', 'business', CURRENT_TIMESTAMP),
  ('meetingcat-outreach', 'Outreach', 'outreach', CURRENT_TIMESTAMP),
  ('meetingcat-competition', 'Competition', 'competition', CURRENT_TIMESTAMP)
ON CONFLICT ("nameKey") DO NOTHING;
