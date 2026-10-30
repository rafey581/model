import { defineConfig } from 'vitest/config'

// The database-backed suites share one database and several of them assert on
// global figures (ledger invariance, dashboard totals). Running files one at a time
// keeps those assertions exact; the bot suite dominates the run time either way.
export default defineConfig({
  test: {
    fileParallelism: false,
    // The suites create many accounts from one address; security.test.ts turns the
    // limits back on to check them.
    env: { RATE_LIMIT_ENABLED: 'false' }
  }
})
