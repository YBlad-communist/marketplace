-- DropIndex
DROP INDEX "Listing_searchTs_idx";

-- DropIndex
DROP INDEX "Order_yookassaPaymentId_idx";

-- AlterTable
ALTER TABLE "Category" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "City" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "address" TEXT;

-- AlterTable
ALTER TABLE "Region" ALTER COLUMN "updatedAt" DROP DEFAULT;
