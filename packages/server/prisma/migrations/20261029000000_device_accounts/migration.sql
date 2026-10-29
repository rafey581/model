-- One account per phone: which accounts have been used from which device.

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeviceAccount" (
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdHere" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DeviceAccount_pkey" PRIMARY KEY ("deviceId","userId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeviceAccount_userId_idx" ON "DeviceAccount"("userId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "DeviceAccount" ADD CONSTRAINT "DeviceAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
