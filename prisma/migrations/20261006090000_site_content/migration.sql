-- CreateEnum
CREATE TYPE "SiteContentKind" AS ENUM ('TEXT', 'LINK', 'IMAGE');

-- CreateTable
CREATE TABLE "SiteContent" (
    "key" TEXT NOT NULL,
    "kind" "SiteContentKind" NOT NULL,
    "value" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteContent_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SiteImage" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA,
    "storageKey" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "alt" TEXT NOT NULL DEFAULT '',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteContentEdit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "SiteContentKind" NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "editedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteContentEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteImage_storageKey_key" ON "SiteImage"("storageKey");

-- CreateIndex
CREATE INDEX "SiteImage_key_createdAt_idx" ON "SiteImage"("key", "createdAt");

-- CreateIndex
CREATE INDEX "SiteContentEdit_createdAt_idx" ON "SiteContentEdit"("createdAt");

-- CreateIndex
CREATE INDEX "SiteContentEdit_key_createdAt_idx" ON "SiteContentEdit"("key", "createdAt");

-- AddForeignKey
ALTER TABLE "SiteContent" ADD CONSTRAINT "SiteContent_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteImage" ADD CONSTRAINT "SiteImage_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteContentEdit" ADD CONSTRAINT "SiteContentEdit_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Every site image row keeps its bytes somewhere, and images that live in R2 are queued for deletion like other uploads.
ALTER TABLE "SiteImage" ADD CONSTRAINT "SiteImage_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);
CREATE TRIGGER "SiteImage_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "SiteImage" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();
