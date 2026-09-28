-- CreateEnum
CREATE TYPE "DiscussionCategory" AS ENUM ('GENERAL', 'SOFTWARE', 'BUILD', 'BUSINESS', 'IDEAS', 'OFF_TOPIC');

-- CreateTable
CREATE TABLE "DiscussionThread" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "DiscussionCategory" NOT NULL DEFAULT 'GENERAL',
    "authorId" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityById" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscussionThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscussionReply" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscussionReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscussionRead" (
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscussionRead_pkey" PRIMARY KEY ("userId","threadId")
);

-- CreateIndex
CREATE INDEX "DiscussionThread_pinned_lastActivityAt_idx" ON "DiscussionThread"("pinned", "lastActivityAt");

-- CreateIndex
CREATE INDEX "DiscussionThread_category_lastActivityAt_idx" ON "DiscussionThread"("category", "lastActivityAt");

-- CreateIndex
CREATE INDEX "DiscussionThread_authorId_idx" ON "DiscussionThread"("authorId");

-- CreateIndex
CREATE INDEX "DiscussionReply_threadId_createdAt_idx" ON "DiscussionReply"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscussionReply_authorId_idx" ON "DiscussionReply"("authorId");

-- CreateIndex
CREATE INDEX "DiscussionRead_threadId_idx" ON "DiscussionRead"("threadId");

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_lastActivityById_fkey" FOREIGN KEY ("lastActivityById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionReply" ADD CONSTRAINT "DiscussionReply_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "DiscussionThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionReply" ADD CONSTRAINT "DiscussionReply_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionRead" ADD CONSTRAINT "DiscussionRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionRead" ADD CONSTRAINT "DiscussionRead_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "DiscussionThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
