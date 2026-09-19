import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Интеграционные тесты создают пользователей с похожими телефонами
    // (Date.now-генерация) в одной БД: параллельные воркеры конфликтуют.
    fileParallelism: false,
  },
});
