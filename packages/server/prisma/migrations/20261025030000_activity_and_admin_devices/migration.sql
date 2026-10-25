-- Player activity for the admin dashboard, and staff phones registered for push
-- alerts. Guarded with IF NOT EXISTS for databases that received these via db push.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);

-- Seed activity from the last login so the first dashboard is not all zeros.
UPDATE "User" SET "lastSeenAt" = "lastLoginAt" WHERE "lastSeenAt" IS NULL AND "lastLoginAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_lastSeenAt_idx" ON "User"("lastSeenAt");

-- CreateTable
CREATE TABLE IF NOT EXISTS "AdminDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AdminDevice_token_key" ON "AdminDevice"("token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AdminDevice_userId_idx" ON "AdminDevice"("userId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "AdminDevice" ADD CONSTRAINT "AdminDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
