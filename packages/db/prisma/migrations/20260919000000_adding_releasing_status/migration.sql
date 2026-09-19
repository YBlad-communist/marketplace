-- AlterEnum: промежуточный статус между PAID и RELEASED, закрывающий гонку
-- двойной выплаты в releaseOrder. Значение не используется в этой же транзакции.
ALTER TYPE "OrderStatus" ADD VALUE 'RELEASING';