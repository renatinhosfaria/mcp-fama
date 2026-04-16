import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        'src/vault/**': { lines: 80, branches: 80, functions: 80, statements: 80 },
        '**': { lines: 60, branches: 60, functions: 60, statements: 60 }
      }
    }
  }
});
