-- OAuth identities (Google) + a second factor for admin logins.
--
-- The two NOT NULL drops are what make OAuth possible at all:
--   * a Google sign-in has no password to bcrypt
--   * a wallet-only provider (Photon, deferred) has no email
-- Both are nullable rather than defaulted because there is no honest value to
-- invent, and every reader of these columns has to handle the null anyway.

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "authProvider" TEXT NOT NULL DEFAULT 'PASSWORD';
ALTER TABLE "User" ADD COLUMN "providerAccountId" TEXT;
ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "totpEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'USER';
ALTER TABLE "Session" ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Session" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
--
-- A Google `sub` may only ever map to one local account, otherwise a shared
-- Google identity could be raced into creating duplicates. Postgres treats NULLs
-- as distinct, so the PASSWORD accounts (all null here) do not collide.
CREATE UNIQUE INDEX "User_authProvider_providerAccountId_key" ON "User"("authProvider", "providerAccountId");

-- CreateIndex
--
-- The pre-existing unique index on "username" is case-SENSITIVE, so it happily
-- accepted both `Player` and `player`. Since a username is a player's public
-- handle in the lobby, that has to be case-insensitively unique. lower() is
-- immutable, so it is legal inside an index expression.
CREATE UNIQUE INDEX "User_username_lower_key" ON "User"(lower("username"));

-- CreateIndex
CREATE INDEX "Session_userId_purpose_idx" ON "Session"("userId", "purpose");

-- CreateIndex
--
-- Lets the admin session sweeper expire stale records without a sequential scan.
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
