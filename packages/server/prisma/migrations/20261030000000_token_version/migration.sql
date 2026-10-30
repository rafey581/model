-- Login tokens carry the account's tokenVersion; a password reset bumps it, which signs
-- the account out everywhere.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
