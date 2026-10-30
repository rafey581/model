-- A player who leaves a match now loses after 30 seconds (was 120). Databases still on
-- the old default are moved to the new one; a value staff chose themselves is kept.
UPDATE "AppSetting" SET "value" = '30'::jsonb WHERE "key" = 'reconnectGraceSec' AND "value" = '120'::jsonb;
