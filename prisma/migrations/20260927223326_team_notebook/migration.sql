-- CreateTable
CREATE TABLE "Notebook" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "subteam" "Subteam",
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notebook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotebookPage" (
    "id" TEXT NOT NULL,
    "notebookId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotebookPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotebookEntry" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastEditedById" TEXT,
    "lastEditedAt" TIMESTAMP(3),

    CONSTRAINT "NotebookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotebookEntryEdit" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "editorId" TEXT,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousTitle" TEXT NOT NULL,
    "previousBody" TEXT NOT NULL,

    CONSTRAINT "NotebookEntryEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotebookImage" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotebookImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notebook_position_idx" ON "Notebook"("position");

-- CreateIndex
CREATE INDEX "NotebookPage_notebookId_position_idx" ON "NotebookPage"("notebookId", "position");

-- CreateIndex
CREATE INDEX "NotebookEntry_pageId_createdAt_idx" ON "NotebookEntry"("pageId", "createdAt");

-- CreateIndex
CREATE INDEX "NotebookEntryEdit_entryId_editedAt_idx" ON "NotebookEntryEdit"("entryId", "editedAt");

-- CreateIndex
CREATE INDEX "NotebookImage_entryId_position_idx" ON "NotebookImage"("entryId", "position");

-- AddForeignKey
ALTER TABLE "Notebook" ADD CONSTRAINT "Notebook_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotebookPage" ADD CONSTRAINT "NotebookPage_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotebookPage" ADD CONSTRAINT "NotebookPage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotebookEntry" ADD CONSTRAINT "NotebookEntry_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "NotebookPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotebookEntry" ADD CONSTRAINT "NotebookEntry_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotebookEntry" ADD CONSTRAINT "NotebookEntry_lastEditedById_fkey" FOREIGN KEY ("lastEditedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotebookEntryEdit" ADD CONSTRAINT "NotebookEntryEdit_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "NotebookEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotebookEntryEdit" ADD CONSTRAINT "NotebookEntryEdit_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotebookImage" ADD CONSTRAINT "NotebookImage_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "NotebookEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
