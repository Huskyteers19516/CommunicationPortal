-- CreateEnum
CREATE TYPE "SponsorshipStage" AS ENUM ('NOT_STARTED', 'DO_SOON', 'IN_PROGRESS', 'SUBMITTED', 'ACCEPTED', 'DECLINED', 'FINISHED');

-- CreateEnum
CREATE TYPE "PartProcess" AS ENUM ('PRINT_3D', 'LASER_CUT', 'CNC', 'CUT', 'MACHINE', 'OTHER');

-- CreateEnum
CREATE TYPE "PartStatus" AS ENUM ('NEEDED', 'CLAIMED', 'DONE');

-- CreateTable
CREATE TABLE "Sponsorship" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT NOT NULL DEFAULT '',
    "contactName" TEXT NOT NULL DEFAULT '',
    "contactEmail" TEXT NOT NULL DEFAULT '',
    "asking" TEXT NOT NULL DEFAULT '',
    "amountReceived" INTEGER,
    "stage" "SponsorshipStage" NOT NULL DEFAULT 'NOT_STARTED',
    "ownerId" TEXT,
    "submittedOn" DATE,
    "acceptedOn" DATE,
    "closesOn" DATE,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sponsorship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamNote" (
    "key" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamNote_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Part" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "process" "PartProcess" NOT NULL DEFAULT 'PRINT_3D',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "material" TEXT NOT NULL DEFAULT '',
    "fileUrl" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "categoryId" TEXT,
    "neededBy" DATE,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" "PartStatus" NOT NULL DEFAULT 'NEEDED',
    "requestedById" TEXT,
    "claimedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sponsorship_stage_closesOn_idx" ON "Sponsorship"("stage", "closesOn");

-- CreateIndex
CREATE INDEX "Sponsorship_ownerId_idx" ON "Sponsorship"("ownerId");

-- CreateIndex
CREATE INDEX "Part_status_position_idx" ON "Part"("status", "position");

-- CreateIndex
CREATE INDEX "Part_claimedById_status_idx" ON "Part"("claimedById", "status");

-- AddForeignKey
ALTER TABLE "Sponsorship" ADD CONSTRAINT "Sponsorship_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sponsorship" ADD CONSTRAINT "Sponsorship_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamNote" ADD CONSTRAINT "TeamNote_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "TaskCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
