-- AlterEnum: объявление зарезервировано на время оплаты (PENDING/PAID заказ).
-- Новое значение нельзя использовать в той же транзакции, здесь только ALTER.
ALTER TYPE "ListingStatus" ADD VALUE 'RESERVED';
