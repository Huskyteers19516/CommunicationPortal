-- AlterTable
ALTER TABLE "User" ADD COLUMN     "showPhotoInPortal" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showPhotoOnWebsite" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "UserPhoto" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA,
    "storageKey" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPhoto_userId_key" ON "UserPhoto"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPhoto_storageKey_key" ON "UserPhoto"("storageKey");

-- AddForeignKey
ALTER TABLE "UserPhoto" ADD CONSTRAINT "UserPhoto_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Every photo row keeps its bytes somewhere, and photos that live in R2 are queued for deletion like other uploads.
ALTER TABLE "UserPhoto" ADD CONSTRAINT "UserPhoto_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);
CREATE TRIGGER "UserPhoto_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "UserPhoto" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();
