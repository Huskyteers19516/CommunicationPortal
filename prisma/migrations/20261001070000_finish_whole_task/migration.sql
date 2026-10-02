-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedById" TEXT;

-- AlterTable
ALTER TABLE "TaskAssignment" ADD COLUMN     "finishedWithTask" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "statusBeforeFinish" "AssignmentStatus";

-- CreateIndex
CREATE INDEX "Task_completedAt_idx" ON "Task"("completedAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

