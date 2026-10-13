-- Switch the in-game currency from virtual credits (CR) to real USDT at 1:1.
-- The game now stores and stakes USDT directly (1 USDT = 1 unit) instead of
-- credits at 100 CR = 1 USDT. Existing rows are not rescaled: this change lands
-- with a reset (and re-seed) of the development database.
ALTER TABLE "Wallet" ALTER COLUMN "currency" SET DEFAULT 'USDT';
ALTER TABLE "WalletTransaction" ALTER COLUMN "currency" SET DEFAULT 'USDT';
ALTER TABLE "Match" ALTER COLUMN "currency" SET DEFAULT 'USDT';

-- `deductedCr` held "credits debited"; with a 1:1 model it is simply the USDT
-- amount debited, so the column is renamed to match.
ALTER TABLE "CryptoWithdrawal" RENAME COLUMN "deductedCr" TO "deducted";
