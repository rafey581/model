import { defineConfig } from 'vitest/config'

// The database-backed suites share one database and several of them assert on
// global figures (ledger invariance, dashboard totals). Running files one at a time
// keeps those assertions exact; the bot suite dominates the run time either way.
export default defineConfig({
  test: {
    fileParallelism: false
  }
})
