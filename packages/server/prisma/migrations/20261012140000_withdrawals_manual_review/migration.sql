-- AlterTable
ALTER TABLE "CryptoWithdrawal" DROP COLUMN "reviewBy",
DROP COLUMN "txHash",
ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USDT',
ADD COLUMN     "deductedCr" DECIMAL(65,30),
ADD COLUMN     "matchHistory" JSONB,
ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "CryptoWithdrawal_userId_createdAt_idx" ON "CryptoWithdrawal"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CryptoWithdrawal_status_createdAt_idx" ON "CryptoWithdrawal"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "CryptoWithdrawal" ADD CONSTRAINT "CryptoWithdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoWithdrawal" ADD CONSTRAINT "CryptoWithdrawal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;