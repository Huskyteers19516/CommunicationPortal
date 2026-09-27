-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "signupMode" BOOLEAN NOT NULL DEFAULT false;

-- Tasks that were already set up for sign-ups (open, with spots, or with people who signed themselves up).
UPDATE "Task" t
SET "signupMode" = true
WHERE t."signupOpen"
   OR t."signupLimit" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "TaskAssignment" a WHERE a."taskId" = t.id AND a."selfAssigned");
