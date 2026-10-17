-- CreateEnum
CREATE TYPE "PayoutMode" AS ENUM ('ACCOUNT', 'CARD', 'NPD');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "payoutMode" "PayoutMode" NOT NULL DEFAULT 'ACCOUNT';
