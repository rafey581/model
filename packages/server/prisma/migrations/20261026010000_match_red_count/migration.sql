-- The red count a match is played with (6 or 10 by stake). Null for matches played
-- before this, which were all racked with 15 reds.

-- AlterTable
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "reds" INTEGER;
