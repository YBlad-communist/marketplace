-- AlterEnum: промежуточный статус между оплатой и возвратом, закрывающий гонку
-- двойного возврата в refundOrder (атомарный клейм PAID/… -> REFUNDING).
-- Значение не используется в этой же транзакции.
ALTER TYPE "OrderStatus" ADD VALUE 'REFUNDING';