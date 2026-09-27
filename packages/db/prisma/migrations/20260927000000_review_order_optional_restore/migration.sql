-- Возврат свободных отзывов с профиля: orderId снова nullable.
-- Дубли без сделки (orderId IS NULL) контролируются на уровне приложения.
ALTER TABLE "Review" ALTER COLUMN "orderId" DROP NOT NULL;
