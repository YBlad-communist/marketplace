-- Откат временных отзывов без сделки: удаляем строки с orderId IS NULL,
-- возвращаем NOT NULL и пересчитываем рейтинг/число отзывов всех пользователей.
DELETE FROM "Review" WHERE "orderId" IS NULL;
ALTER TABLE "Review" ALTER COLUMN "orderId" SET NOT NULL;
UPDATE "User" u SET rating = COALESCE((SELECT AVG(rating) FROM "Review" WHERE "revieweeId" = u.id), 0),
  "ratingCount" = (SELECT COUNT(*) FROM "Review" WHERE "revieweeId" = u.id);
