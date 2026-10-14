-- Этап 1 абстракции платежей: провайдер-нейтральные поля (PaymentProvider).
-- Заказы и онбординг продавца перестают знать про ЮKassa напрямую.
--
-- Данные копируются из legacy yookassa*-полей; сами legacy-поля НЕ удаляются
-- (полный переход и удаление — отдельным решением после стабилизации).
--
-- Обратимость (ручной downgrade):
--   DROP INDEX "Order_providerPaymentId_idx";
--   ALTER TABLE "Order" DROP COLUMN "providerPaymentId",
--                       DROP COLUMN "providerPayoutId",
--                       DROP COLUMN "provider";
--   ALTER TABLE "User" DROP COLUMN "payoutOnboarded",
--                       DROP COLUMN "payoutAccountId";
--   DROP TYPE "PaymentProvider";

-- 1) Enum провайдеров (MOCK — только тесты/дев, в проде не используется)
CREATE TYPE "PaymentProvider" AS ENUM ('YOOKASSA', 'MONETA', 'MOCK');

-- 2) Order: провайдер сделки + provider-нейтральные идентификаторы
ALTER TABLE "Order" ADD COLUMN "provider" "PaymentProvider" NOT NULL DEFAULT 'YOOKASSA';
ALTER TABLE "Order" ADD COLUMN "providerPaymentId" TEXT;
ALTER TABLE "Order" ADD COLUMN "providerPayoutId" TEXT;
CREATE INDEX "Order_providerPaymentId_idx" ON "Order"("providerPaymentId");

-- 3) User: провайдер-нейтральные поля онбординга продавца
ALTER TABLE "User" ADD COLUMN "payoutAccountId" TEXT;
ALTER TABLE "User" ADD COLUMN "payoutOnboarded" BOOLEAN NOT NULL DEFAULT false;

-- 4) Backfill: существующие сделки остаются на ЮKassa, продавцы «переезжают»
UPDATE "Order" SET "providerPaymentId" = "yookassaPaymentId"
  WHERE "yookassaPaymentId" IS NOT NULL;
UPDATE "User" SET "payoutAccountId" = "yookassaShopId", "payoutOnboarded" = "yookassaOnboarded"
  WHERE "yookassaShopId" IS NOT NULL OR "yookassaOnboarded" = true;
