-- Withdrawal holds: the requested amount is moved from available to locked when
-- the request is made, and the player may cancel a pending request. Existing rows
-- keep heldAmount NULL (nothing was held for them) and are debited from available
-- on approval, as before.

-- AlterTable
ALTER TABLE "CryptoWithdrawal" ADD COLUMN IF NOT EXISTS "heldAmount" DECIMAL(65,30),
ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
