-- Add the match-challenge table: the broadcast/friend invitation that sits on top
-- of the create/join one-v-one flow. A challenge is OPEN until someone accepts,
-- is cancelled by its challenger, or expires; nothing is staked until accept.

-- CreateTable
CREATE TABLE "MatchChallenge" (
    "id" TEXT NOT NULL,
    "challengerId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'PUBLIC',
    "stakeTier" TEXT NOT NULL,
    "stakePerPlayer" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "format" TEXT NOT NULL DEFAULT 'BO3',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "matchId" TEXT,
    "responderId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchChallenge_status_createdAt_idx" ON "MatchChallenge"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MatchChallenge_targetUserId_status_idx" ON "MatchChallenge"("targetUserId", "status");

-- CreateIndex
CREATE INDEX "MatchChallenge_challengerId_status_idx" ON "MatchChallenge"("challengerId", "status");

-- AddForeignKey
ALTER TABLE "MatchChallenge" ADD CONSTRAINT "MatchChallenge_challengerId_fkey" FOREIGN KEY ("challengerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchChallenge" ADD CONSTRAINT "MatchChallenge_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchChallenge" ADD CONSTRAINT "MatchChallenge_responderId_fkey" FOREIGN KEY ("responderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
