import { test, expect } from '@playwright/test';

test('home page loads with catalog', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Marketplace|Маркет/i);
  await expect(page.locator('body')).toContainText(/объявлени|каталог|поиск/i);
});

test('login page renders', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('input')).toHaveCount(2, { timeout: 5000 });
});
