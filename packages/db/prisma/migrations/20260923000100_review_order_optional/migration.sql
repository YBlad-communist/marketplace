-- Отзыв с профиля (без привязки к сделке): orderId снова nullable.
-- Дубли без сделки (orderId IS NULL) контролируются на уровне приложения,
-- уникальность (authorId, revieweeId, orderId) для NULL в Postgres не работает.
ALTER TABLE "Review" ALTER COLUMN "orderId" DROP NOT NULL;
