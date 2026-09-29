-- CreateTable
CREATE TABLE "PlannerPath" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "data" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "teamId" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlannerPath_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlannerPath_updatedAt_idx" ON "PlannerPath"("updatedAt");

-- CreateIndex
CREATE INDEX "PlannerPath_teamId_updatedAt_idx" ON "PlannerPath"("teamId", "updatedAt");

-- CreateIndex
CREATE INDEX "PlannerPath_createdById_idx" ON "PlannerPath"("createdById");

-- AddForeignKey
ALTER TABLE "PlannerPath" ADD CONSTRAINT "PlannerPath_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "LeagueTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannerPath" ADD CONSTRAINT "PlannerPath_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannerPath" ADD CONSTRAINT "PlannerPath_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

