-- CreateEnum
CREATE TYPE "WorkshopKind" AS ENUM ('PART', 'SOFTWARE', 'OTHER');

-- CreateEnum
CREATE TYPE "WorkshopStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "WorkshopProject" (
    "id" TEXT NOT NULL,
    "kind" "WorkshopKind" NOT NULL DEFAULT 'PART',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "material" TEXT NOT NULL DEFAULT '',
    "season" TEXT NOT NULL DEFAULT '',
    "extraCredits" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL DEFAULT '',
    "codeLink" TEXT NOT NULL DEFAULT '',
    "status" "WorkshopStatus" NOT NULL DEFAULT 'DRAFT',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "coverPhotoId" TEXT,
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkshopProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkshopCredit" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorkshopCredit_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "WorkshopPhoto" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA,
    "storageKey" TEXT,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkshopPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkshopFile" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA,
    "storageKey" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkshopFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkshopProject_coverPhotoId_key" ON "WorkshopProject"("coverPhotoId");

-- CreateIndex
CREATE INDEX "WorkshopProject_status_kind_idx" ON "WorkshopProject"("status", "kind");

-- CreateIndex
CREATE INDEX "WorkshopProject_createdById_idx" ON "WorkshopProject"("createdById");

-- CreateIndex
CREATE INDEX "WorkshopCredit_userId_idx" ON "WorkshopCredit"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkshopPhoto_storageKey_key" ON "WorkshopPhoto"("storageKey");

-- CreateIndex
CREATE INDEX "WorkshopPhoto_projectId_position_idx" ON "WorkshopPhoto"("projectId", "position");

-- CreateIndex
CREATE INDEX "WorkshopPhoto_uploadedById_idx" ON "WorkshopPhoto"("uploadedById");

-- CreateIndex
CREATE UNIQUE INDEX "WorkshopFile_storageKey_key" ON "WorkshopFile"("storageKey");

-- CreateIndex
CREATE INDEX "WorkshopFile_projectId_createdAt_idx" ON "WorkshopFile"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkshopFile_uploadedById_idx" ON "WorkshopFile"("uploadedById");

-- AddForeignKey
ALTER TABLE "WorkshopProject" ADD CONSTRAINT "WorkshopProject_coverPhotoId_fkey" FOREIGN KEY ("coverPhotoId") REFERENCES "WorkshopPhoto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkshopProject" ADD CONSTRAINT "WorkshopProject_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkshopProject" ADD CONSTRAINT "WorkshopProject_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkshopCredit" ADD CONSTRAINT "WorkshopCredit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "WorkshopProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkshopCredit" ADD CONSTRAINT "WorkshopCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkshopPhoto" ADD CONSTRAINT "WorkshopPhoto_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "WorkshopProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkshopFile" ADD CONSTRAINT "WorkshopFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "WorkshopProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Every photo and design file keeps its bytes somewhere (Postgres or Cloudflare R2), and ones that live in R2 are
-- queued for deletion like other uploads when their row goes (directly, or with its project) or their key changes.
ALTER TABLE "WorkshopPhoto" ADD CONSTRAINT "WorkshopPhoto_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);
ALTER TABLE "WorkshopFile" ADD CONSTRAINT "WorkshopFile_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);
CREATE TRIGGER "WorkshopPhoto_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "WorkshopPhoto" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();
CREATE TRIGGER "WorkshopFile_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "WorkshopFile" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();

-- Sane photo sizes (read from the picture's header when it was uploaded).
ALTER TABLE "WorkshopPhoto" ADD CONSTRAINT "WorkshopPhoto_size_check" CHECK ("width" > 0 AND "height" > 0);
