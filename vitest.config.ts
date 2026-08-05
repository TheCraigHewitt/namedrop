import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Tests run the real Worker in workerd against a real local D1, so parsing,
// SQL, page rendering and CSV output are all exercised for real. The only
// fake is the HTTP boundary to the AI providers (see test/fixtures).
// `npm test` builds first: the pool loads the built Worker from dist/server.
const migrations = await readD1Migrations('./migrations')

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './dist/server/wrangler.json' },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
})
