-- Local OTP auth: replace provider identities with a verified local account.
--
-- The Google/Phantom sign-in code is gone, so the provider columns go with it. What
-- replaces them is a local identity: a display name, an email and a phone number (both
-- unique - neither may be reused across accounts), a date of birth, and a per-address
-- verified flag. OTP challenges live in their own table because a signup challenge
-- exists before the account it will create.

-- DropIndex
DROP INDEX "User_authProvider_providerAccountId_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "providerAccountId",
ADD COLUMN     "dateOfBirth" TIMESTAMP(3),
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phoneVerified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OtpChallenge" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OtpChallenge_identifier_purpose_idx" ON "OtpChallenge"("identifier", "purpose");

-- CreateIndex
CREATE INDEX "OtpChallenge_expiresAt_idx" ON "OtpChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
