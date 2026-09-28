-- CreateEnum
CREATE TYPE "AttendanceChangeAction" AS ENUM ('ADDED', 'REMOVED', 'CREDIT_CHANGED', 'SESSION_DELETED');

-- CreateTable
CREATE TABLE "AttendanceChange" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "sessionDate" DATE NOT NULL,
    "sessionKind" "AttendanceKind" NOT NULL,
    "userId" TEXT,
    "userName" TEXT NOT NULL DEFAULT '',
    "changedById" TEXT,
    "action" "AttendanceChangeAction" NOT NULL,
    "fromCredit" INTEGER,
    "fromKind" "AttendanceCreditKind",
    "toCredit" INTEGER,
    "toKind" "AttendanceCreditKind",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceChange_createdAt_idx" ON "AttendanceChange"("createdAt");

-- CreateIndex
CREATE INDEX "AttendanceChange_sessionId_idx" ON "AttendanceChange"("sessionId");

-- CreateIndex
CREATE INDEX "AttendanceChange_userId_createdAt_idx" ON "AttendanceChange"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceChange_changedById_createdAt_idx" ON "AttendanceChange"("changedById", "createdAt");

-- AddForeignKey
ALTER TABLE "AttendanceChange" ADD CONSTRAINT "AttendanceChange_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AttendanceSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceChange" ADD CONSTRAINT "AttendanceChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceChange" ADD CONSTRAINT "AttendanceChange_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
