-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('REQUESTED', 'APPROVED', 'ORDERED', 'DONE', 'NOT_NEEDED');

-- CreateTable
CREATE TABLE "PurchaseItem" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL DEFAULT '',
    "vendor" TEXT NOT NULL DEFAULT '',
    "quantity" INTEGER,
    "costCents" INTEGER,
    "subteam" "Subteam",
    "status" "PurchaseStatus" NOT NULL DEFAULT 'REQUESTED',
    "ordererId" TEXT,
    "createdById" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurchaseItem_status_createdAt_idx" ON "PurchaseItem"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseItem_ordererId_idx" ON "PurchaseItem"("ordererId");

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_ordererId_fkey" FOREIGN KEY ("ordererId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_statusChangedById_fkey" FOREIGN KEY ("statusChangedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
