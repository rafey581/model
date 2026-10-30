-- Date of birth, asked at sign-up and checked by "forgot password".

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "dateOfBirth" DATE;
