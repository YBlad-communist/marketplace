-- Русификация платёжного слоя:
-- 1) Stripe -> ЮKassa (сплитование для платформ): у User вместо stripe-полей
--    появляется идентификатор магазина ЮKassa; у Order каждый платёж ссылается
--    на yookassaPaymentId, stripeTransferId больше не нужен (сплит переводит
--    деньги продавцу при capture автоматически).
-- 2) OAuth Google убран (заглушка): googleId @unique дропается.
-- 3) Единственная валюта — российский рубль (RUB).

ALTER TABLE "User" DROP COLUMN "stripeAccountId";
ALTER TABLE "User" DROP COLUMN "stripeOnboarded";
ALTER TABLE "User" DROP COLUMN "googleId";
ALTER TABLE "User" ADD COLUMN "yookassaShopId" TEXT;
ALTER TABLE "User" ADD COLUMN "yookassaOnboarded" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Order" DROP COLUMN "stripePaymentIntentId";
ALTER TABLE "Order" DROP COLUMN "stripeTransferId";
ALTER TABLE "Order" ADD COLUMN "yookassaPaymentId" TEXT;

-- Все исторические данные в рублях (новые объявления/заказы уже получают RUB по умолчанию).
UPDATE "Listing" SET "currency" = 'RUB' WHERE "currency" IS DISTINCT FROM 'RUB';
UPDATE "Order"   SET "currency" = 'RUB' WHERE "currency" IS DISTINCT FROM 'RUB';
ALTER TABLE "Listing" ALTER COLUMN "currency" SET DEFAULT 'RUB';
ALTER TABLE "Order"   ALTER COLUMN "currency" SET DEFAULT 'RUB';

CREATE INDEX "Order_yookassaPaymentId_idx" ON "Order"("yookassaPaymentId");