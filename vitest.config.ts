import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'src/__tests__/capability/boundary-container-isolation.test.ts',
      'src/__tests__/capability/boundary-container-workspace-mount.test.ts',
      'src/__tests__/capability/boundary-driver-container.test.ts',
      'src/__tests__/contained-execution-docker.integration.test.ts',
      'src/__tests__/verdict/llm/judge-accuracy.test.ts',
    ],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
})
