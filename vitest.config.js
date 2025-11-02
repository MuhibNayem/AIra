import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
      include: ['src/tools/**/*.js', 'src/utils/**/*.js', 'src/indexer/**/*.js'],
      exclude: [
        'src/tools/web_scraper.js',
        'src/tools/web_search.js',
        'src/utils/logger.js',
      ],
      thresholds: {
        lines: 55,
        statements: 55,
        functions: 55,
        branches: 40,
      },
    },
  },
});
