-- Отзыв обязан ссылаться на реальную сделку: orderId больше не nullable.
-- Уникальность (authorId, revieweeId, orderId) в Postgres не работает для NULL,
-- поэтому связь с заказом делаем обязательной. Существующих NULL-строк нет
-- (отзывы создаются только POST /api/reviews с обязательным orderId),
-- поэтому NOT NULL добавляем сразу.
ALTER TABLE "Review" ALTER COLUMN "orderId" SET NOT NULL;

-- На случай удаления заказа отзывы должны уходить вместе с ним (каскад),
-- а не «отвязываться» от сделки и продолжать влиять на рейтинг.
ALTER TABLE "Review" DROP CONSTRAINT "Review_orderId_fkey";
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;