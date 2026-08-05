// @ts-check
import cloudflare from '@astrojs/cloudflare'
import { defineConfig } from 'astro/config'

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  devToolbar: { enabled: false },
})
