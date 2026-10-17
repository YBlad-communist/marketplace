-- Аудит п.17: частичный уникальный индекс для свободных отзывов (без сделки).
-- NULL-уникальность в PostgreSQL не работает ((authorId, revieweeId, orderId)
-- пропускает неограниченное число строк с orderId IS NULL), поэтому дубли
-- без сделки контролировались только read-then-write в приложении и проигрывали
-- гонке параллельных POST /api/reviews.

-- Дедупликация перед созданием индекса: из пары (authorId, revieweeId) с
-- несколькими NULL-orderId отзывами оставляем один (с наименьшим id).
DELETE FROM "Review" r
WHERE r."orderId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "Review" d
    WHERE d."orderId" IS NULL
      AND d."authorId" = r."authorId"
      AND d."revieweeId" = r."revieweeId"
      AND d."id" < r."id"
  );

-- В schema.prisma индекс намеренно НЕ объявлен: Prisma не видит индексы с
-- WHERE-предикатом, и любая декларация дала бы drift при следующем
-- migrate dev (см. комментарий в 20261008000001_active_order_partial_index).
CREATE UNIQUE INDEX "Review_authorId_revieweeId_no_order_key"
ON "Review"("authorId", "revieweeId")
WHERE "orderId" IS NULL;
