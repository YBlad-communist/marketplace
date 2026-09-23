-- Редактирование сообщений и фото в чате.
ALTER TABLE "Message" ADD COLUMN "editedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "imageKey" TEXT;
ALTER TABLE "Message" ADD COLUMN "imageThumbKey" TEXT;
