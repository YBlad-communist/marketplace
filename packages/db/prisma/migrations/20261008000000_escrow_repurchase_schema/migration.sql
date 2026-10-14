-- Этап 1: повторная покупка после возврата + статус SHIPPED + споры.
--
-- SHIPPED добавляем в КОНЕЦ enum (ALTER TYPE дописывает в конец) — так же,
-- как он расположен в schema.prisma, чтобы порядок значений совпадал.

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'SHIPPED';

-- Убираем вечный unique с listingId: история заказов по объявлению теперь
-- растёт (после возврата/выплаты объявление снова продаётся). Ограничение
-- «не более одного активного заказа» переходит в частичный уникальный индекс
-- (следующая миграция) — он не мешает завершённым заказам.
DROP INDEX "Order_listingId_key";

-- AlterTable: срок холда, данные об отправке и флаги предупреждений.
ALTER TABLE "Order" ADD COLUMN "holdExpiresAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "shippedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "shipComment" TEXT;
ALTER TABLE "Order" ADD COLUMN "trackingNumber" TEXT;
ALTER TABLE "Order" ADD COLUMN "holdWarned2dAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "holdWarned12hAt" TIMESTAMP(3);

-- AlterTable: индекс под периодические джобы по сроку холда.
CREATE INDEX "Order_status_holdExpiresAt_idx" ON "Order"("status", "holdExpiresAt");

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "openedById" TEXT,
    "reason" TEXT NOT NULL,
    "comment" TEXT,
    "photos" TEXT[],
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolutionComment" TEXT,
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_orderId_key" ON "Dispute"("orderId");

-- CreateIndex
CREATE INDEX "Dispute_status_createdAt_idx" ON "Dispute"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
