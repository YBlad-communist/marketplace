-- П.20 аудита: прокси /api/files ищет Message по ключу фото
-- (imageKey/imageThumbKey) для проверки доступа к приватным файлам чатов.
CREATE INDEX "Message_imageKey_idx" ON "Message"("imageKey");
CREATE INDEX "Message_imageThumbKey_idx" ON "Message"("imageThumbKey");
