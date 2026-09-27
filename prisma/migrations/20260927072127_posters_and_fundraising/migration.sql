-- CreateEnum
CREATE TYPE "FundraiserKind" AS ENUM ('EVENT', 'SALE', 'ONLINE', 'OTHER');

-- CreateEnum
CREATE TYPE "FundraiserStatus" AS ENUM ('PLANNING', 'UPCOMING', 'ACTIVE', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "Poster" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL DEFAULT '',
    "event" TEXT NOT NULL DEFAULT '',
    "eventDate" DATE,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Poster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosterFile" (
    "id" TEXT NOT NULL,
    "posterId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosterFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fundraiser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "FundraiserKind" NOT NULL DEFAULT 'EVENT',
    "status" "FundraiserStatus" NOT NULL DEFAULT 'PLANNING',
    "description" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL DEFAULT '',
    "startsOn" DATE,
    "endsOn" DATE,
    "goalAmount" INTEGER,
    "raisedAmount" INTEGER NOT NULL DEFAULT 0,
    "leadId" TEXT,
    "volunteerLimit" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fundraiser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundraiserVolunteer" (
    "id" TEXT NOT NULL,
    "fundraiserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundraiserVolunteer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Poster_eventDate_idx" ON "Poster"("eventDate");

-- CreateIndex
CREATE INDEX "Poster_createdAt_idx" ON "Poster"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PosterFile_posterId_key" ON "PosterFile"("posterId");

-- CreateIndex
CREATE INDEX "Fundraiser_status_startsOn_idx" ON "Fundraiser"("status", "startsOn");

-- CreateIndex
CREATE INDEX "FundraiserVolunteer_userId_idx" ON "FundraiserVolunteer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FundraiserVolunteer_fundraiserId_userId_key" ON "FundraiserVolunteer"("fundraiserId", "userId");

-- AddForeignKey
ALTER TABLE "Poster" ADD CONSTRAINT "Poster_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosterFile" ADD CONSTRAINT "PosterFile_posterId_fkey" FOREIGN KEY ("posterId") REFERENCES "Poster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fundraiser" ADD CONSTRAINT "Fundraiser_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fundraiser" ADD CONSTRAINT "Fundraiser_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundraiserVolunteer" ADD CONSTRAINT "FundraiserVolunteer_fundraiserId_fkey" FOREIGN KEY ("fundraiserId") REFERENCES "Fundraiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundraiserVolunteer" ADD CONSTRAINT "FundraiserVolunteer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
