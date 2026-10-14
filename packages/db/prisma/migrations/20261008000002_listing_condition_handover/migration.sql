-- Этап 2: состояние товара (NEW/USED) и способ получения (PICKUP/DELIVERY).
-- Оба поля опциональные: старые объявления остаются без значения.
CREATE TYPE "ItemCondition" AS ENUM ('NEW', 'USED');
CREATE TYPE "HandoverMethod" AS ENUM ('PICKUP', 'DELIVERY');

ALTER TABLE "Listing" ADD COLUMN "condition" "ItemCondition";
ALTER TABLE "Listing" ADD COLUMN "handover" "HandoverMethod";
