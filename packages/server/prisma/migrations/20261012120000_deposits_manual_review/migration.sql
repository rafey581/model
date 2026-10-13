-- AlterTable
ALTER TABLE "CryptoDeposit" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "creditedAmount" DECIMAL(65,30),
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USDT',
ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "screenshot" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "CryptoDeposit_userId_createdAt_idx" ON "CryptoDeposit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CryptoDeposit_status_createdAt_idx" ON "CryptoDeposit"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoDeposit_txHash_key" ON "CryptoDeposit"("txHash");

-- AddForeignKey
ALTER TABLE "CryptoDeposit" ADD CONSTRAINT "CryptoDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoDeposit" ADD CONSTRAINT "CryptoDeposit_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;