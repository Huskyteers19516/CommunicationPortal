-- CreateTable
CREATE TABLE "SponsorshipFile" (
    "id" TEXT NOT NULL,
    "sponsorshipId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsorshipFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SponsorshipFile_sponsorshipId_createdAt_idx" ON "SponsorshipFile"("sponsorshipId", "createdAt");

-- AddForeignKey
ALTER TABLE "SponsorshipFile" ADD CONSTRAINT "SponsorshipFile_sponsorshipId_fkey" FOREIGN KEY ("sponsorshipId") REFERENCES "Sponsorship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorshipFile" ADD CONSTRAINT "SponsorshipFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
