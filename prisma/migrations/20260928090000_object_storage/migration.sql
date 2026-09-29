-- Uploaded files can live in Cloudflare R2 instead of Postgres (when the R2_* environment variables are set).
-- A file row then has storageKey set and data null. Existing files stay in Postgres until an owner moves them.

-- AlterTable
ALTER TABLE "NotebookImage" ADD COLUMN     "storageKey" TEXT,
ALTER COLUMN "data" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PosterFile" ADD COLUMN     "storageKey" TEXT,
ALTER COLUMN "data" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ResourceFile" ADD COLUMN     "storageKey" TEXT,
ALTER COLUMN "data" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SponsorshipFile" ADD COLUMN     "storageKey" TEXT,
ALTER COLUMN "data" DROP NOT NULL;

-- AlterTable
ALTER TABLE "StrategyFile" ADD COLUMN     "storageKey" TEXT,
ALTER COLUMN "data" DROP NOT NULL;

-- CreateTable
CREATE TABLE "FileDeletion" (
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FileDeletion_pkey" PRIMARY KEY ("storageKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotebookImage_storageKey_key" ON "NotebookImage"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "PosterFile_storageKey_key" ON "PosterFile"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceFile_storageKey_key" ON "ResourceFile"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipFile_storageKey_key" ON "SponsorshipFile"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyFile_storageKey_key" ON "StrategyFile"("storageKey");


-- Every file row keeps its bytes somewhere.
ALTER TABLE "NotebookImage" ADD CONSTRAINT "NotebookImage_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);
ALTER TABLE "PosterFile" ADD CONSTRAINT "PosterFile_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);
ALTER TABLE "ResourceFile" ADD CONSTRAINT "ResourceFile_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);
ALTER TABLE "SponsorshipFile" ADD CONSTRAINT "SponsorshipFile_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);
ALTER TABLE "StrategyFile" ADD CONSTRAINT "StrategyFile_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);

-- When a file row that lives in R2 goes away (deleted directly or by a cascade, e.g. a whole notebook), or its key
-- changes, remember the old object so the app deletes it from R2 (src/server/files/object-store.ts).
CREATE OR REPLACE FUNCTION "queue_file_deletion"() RETURNS trigger AS $$
BEGIN
  IF OLD."storageKey" IS NOT NULL AND (TG_OP = 'DELETE' OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey") THEN
    INSERT INTO "FileDeletion" ("storageKey") VALUES (OLD."storageKey") ON CONFLICT ("storageKey") DO NOTHING;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NotebookImage_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "NotebookImage" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();
CREATE TRIGGER "PosterFile_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "PosterFile" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();
CREATE TRIGGER "ResourceFile_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "ResourceFile" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();
CREATE TRIGGER "SponsorshipFile_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "SponsorshipFile" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();
CREATE TRIGGER "StrategyFile_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "StrategyFile" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();
