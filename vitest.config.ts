import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'vue-sfc-transformer': fileURLToPath(
        new URL('./src/index.ts', import.meta.url).href,
      ),
    },
  },
  test: {
    coverage: {
      enabled: true,
      include: ['src'],
      reporter: ['text', 'json', 'html'],
    },
  },
})
