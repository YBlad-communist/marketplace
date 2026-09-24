-- Личные чаты без привязки к объявлению: listingId nullable.
ALTER TABLE "Conversation" ALTER COLUMN "listingId" DROP NOT NULL;
