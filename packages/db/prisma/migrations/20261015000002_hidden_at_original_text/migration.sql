-- П.30: мягкое скрытие чата инициатором (hard delete — когда скрыли оба)
ALTER TABLE "ConversationParticipant" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- П.31: история правок сообщения (оригинальный текст при первой правке)
ALTER TABLE "Message" ADD COLUMN "originalText" TEXT;
