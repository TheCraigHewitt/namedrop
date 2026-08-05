import type { D1Migration } from '@cloudflare/vitest-pool-workers'

declare global {
  namespace Cloudflare {
    interface Env {
      /** Migrations handed to the pool so each test file starts on the real schema. */
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}

export {}
