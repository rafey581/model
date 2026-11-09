-- Persisted sign-in failures. Replaces the in-memory staff counter and the
-- per-account columns as the source of truth, so a restart or a second process
-- does not hand an attacker a fresh set of guesses.

CREATE TABLE "LoginThrottle" (
    "id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginThrottle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoginThrottle_surface_kind_keyHash_key" ON "LoginThrottle"("surface", "kind", "keyHash");

CREATE INDEX "LoginThrottle_lockedUntil_idx" ON "LoginThrottle"("lockedUntil");
