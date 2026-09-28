-- CreateEnum
CREATE TYPE "StrategyKind" AS ENUM ('AUTO', 'TELEOP', 'ENDGAME', 'MATCH', 'SCOUTING', 'OTHER');

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "StrategyKind" NOT NULL DEFAULT 'AUTO',
    "description" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL DEFAULT '',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyFile" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Strategy_pinned_updatedAt_idx" ON "Strategy"("pinned", "updatedAt");

-- CreateIndex
CREATE INDEX "StrategyFile_strategyId_createdAt_idx" ON "StrategyFile"("strategyId", "createdAt");

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyFile" ADD CONSTRAINT "StrategyFile_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
