import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'vmThreads',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
      include: ['src/tools/**/*.js', 'src/utils/**/*.js'],
      exclude: [
        'src/tools/web_scraper.js',
        'src/tools/web_search.js',
        'src/utils/logger.js',
      ],
      thresholds: {
        lines: 75,
        statements: 75,
        functions: 75,
        branches: 75,
      },
    },
  },
});
