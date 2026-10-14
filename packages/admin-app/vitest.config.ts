import { defineConfig } from 'vitest/config'

// The app's screens are React Native components and are covered by `tsc`, not by a
// renderer. What runs here is the pure logic the screens lean on - URL resolution,
// value formatting and the replay frame walk - none of which touch a native module,
// so vitest's plain Node environment is enough.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
