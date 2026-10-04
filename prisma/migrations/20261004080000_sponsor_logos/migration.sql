-- AlterTable
ALTER TABLE "Sponsorship" ADD COLUMN     "publicName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "showOnWebsite" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "SponsorshipLogo" (
    "id" TEXT NOT NULL,
    "sponsorshipId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA,
    "storageKey" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsorshipLogo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipLogo_sponsorshipId_key" ON "SponsorshipLogo"("sponsorshipId");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipLogo_storageKey_key" ON "SponsorshipLogo"("storageKey");

-- AddForeignKey
ALTER TABLE "SponsorshipLogo" ADD CONSTRAINT "SponsorshipLogo_sponsorshipId_fkey" FOREIGN KEY ("sponsorshipId") REFERENCES "Sponsorship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorshipLogo" ADD CONSTRAINT "SponsorshipLogo_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Every logo row keeps its bytes somewhere, and logos that live in R2 are queued for deletion like other uploads.
ALTER TABLE "SponsorshipLogo" ADD CONSTRAINT "SponsorshipLogo_stored_check" CHECK ("data" IS NOT NULL OR "storageKey" IS NOT NULL);
CREATE TRIGGER "SponsorshipLogo_queue_file_deletion" AFTER DELETE OR UPDATE OF "storageKey" ON "SponsorshipLogo" FOR EACH ROW EXECUTE FUNCTION "queue_file_deletion"();
