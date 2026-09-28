-- AlterTable
ALTER TABLE "Strategy" ADD COLUMN     "teamId" TEXT;

-- CreateTable
CREATE TABLE "LeagueTeam" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "summaryUpdatedAt" TIMESTAMP(3),
    "summaryUpdatedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueTeam_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeagueTeam_number_key" ON "LeagueTeam"("number");

-- CreateIndex
CREATE INDEX "Strategy_teamId_updatedAt_idx" ON "Strategy"("teamId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "LeagueTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueTeam" ADD CONSTRAINT "LeagueTeam_summaryUpdatedById_fkey" FOREIGN KEY ("summaryUpdatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueTeam" ADD CONSTRAINT "LeagueTeam_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The other 17 teams in our league (19516 The Huskyteers is us). Data only; `number` is unique, so this never duplicates.
INSERT INTO "LeagueTeam" ("id", "number", "name", "city", "updatedAt")
VALUES
  ('leagueteam9040', 9040, 'STEAMpunks Alpha', 'Irvine', CURRENT_TIMESTAMP),
  ('leagueteam13171', 13171, 'Polyisoprene Mallards', 'Tustin', CURRENT_TIMESTAMP),
  ('leagueteam13277', 13277, 'STEAMpunks Bravo', 'Irvine', CURRENT_TIMESTAMP),
  ('leagueteam13303', 13303, 'SMES Robotics', 'San Juan Capistrano', CURRENT_TIMESTAMP),
  ('leagueteam14295', 14295, 'Operation T.A.C.', 'San Juan Capistrano', CURRENT_TIMESTAMP),
  ('leagueteam14377', 14377, 'RoboPanthers', 'Anaheim', CURRENT_TIMESTAMP),
  ('leagueteam19510', 19510, 'VolTech', 'Walnut', CURRENT_TIMESTAMP),
  ('leagueteam19812', 19812, 'Quantum Leap A', 'Cypress', CURRENT_TIMESTAMP),
  ('leagueteam21982', 21982, 'I-kineers', 'Costa Mesa', CURRENT_TIMESTAMP),
  ('leagueteam21990', 21990, 'Roots Robotics 1', 'Laguna Niguel', CURRENT_TIMESTAMP),
  ('leagueteam23365', 23365, 'Alpha Robotics', 'Irvine', CURRENT_TIMESTAMP),
  ('leagueteam23796', 23796, 'Quantum Leap B', 'Cypress', CURRENT_TIMESTAMP),
  ('leagueteam24216', 24216, 'Roots Robotics 2', 'Laguna Niguel', CURRENT_TIMESTAMP),
  ('leagueteam25639', 25639, 'SJC Short Circuits', 'San Juan Capistrano', CURRENT_TIMESTAMP),
  ('leagueteam26577', 26577, 'Bots and Baddies', 'Mission Viejo', CURRENT_TIMESTAMP),
  ('leagueteam30099', 30099, 'OmicronX', 'Irvine', CURRENT_TIMESTAMP),
  ('leagueteam30790', 30790, 'Computent Crafters', 'Fountain Valley', CURRENT_TIMESTAMP)
ON CONFLICT ("number") DO NOTHING;
