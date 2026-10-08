-- CreateEnum
CREATE TYPE "SalePayment" AS ENUM ('CASH', 'CARD', 'VENMO', 'ZELLE', 'OTHER');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('OPEN', 'SERVED', 'VOIDED');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('INCOME', 'EXPENSE');

-- CreateTable
CREATE TABLE "SaleItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "priceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "customer" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "payment" "SalePayment" NOT NULL DEFAULT 'CASH',
    "status" "SaleStatus" NOT NULL DEFAULT 'SERVED',
    "totalCents" INTEGER NOT NULL,
    "soldOn" DATE NOT NULL,
    "fundraiserId" TEXT,
    "soldById" TEXT,
    "servedAt" TIMESTAMP(3),
    "servedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "itemId" TEXT,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "SaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "kind" "LedgerKind" NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "payment" "SalePayment",
    "occurredOn" DATE NOT NULL,
    "fundraiserId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SaleItem_active_category_name_idx" ON "SaleItem"("active", "category", "name");

-- CreateIndex
CREATE INDEX "Sale_status_createdAt_idx" ON "Sale"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Sale_soldOn_idx" ON "Sale"("soldOn");

-- CreateIndex
CREATE INDEX "Sale_fundraiserId_idx" ON "Sale"("fundraiserId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_number_key" ON "Sale"("number");

-- CreateIndex
CREATE INDEX "SaleLine_saleId_idx" ON "SaleLine"("saleId");

-- CreateIndex
CREATE INDEX "SaleLine_itemId_idx" ON "SaleLine"("itemId");

-- CreateIndex
CREATE INDEX "LedgerEntry_occurredOn_idx" ON "LedgerEntry"("occurredOn");

-- CreateIndex
CREATE INDEX "LedgerEntry_fundraiserId_idx" ON "LedgerEntry"("fundraiserId");

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_fundraiserId_fkey" FOREIGN KEY ("fundraiserId") REFERENCES "Fundraiser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_soldById_fkey" FOREIGN KEY ("soldById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_servedById_fkey" FOREIGN KEY ("servedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "SaleItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_fundraiserId_fkey" FOREIGN KEY ("fundraiserId") REFERENCES "Fundraiser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
