import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      include: ['src'],
      reporter: ['text', 'json', 'html'],
    },
  },
})
