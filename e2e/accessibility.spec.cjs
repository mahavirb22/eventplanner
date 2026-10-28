const { test, expect } = require('@playwright/test');

test.describe('Accessible planner shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('has skip navigation and landmarks', async ({ page }) => {
    await expect(page.locator('a[href="#main-content"]')).toBeAttached();
    await expect(page.locator('main#main-content')).toBeVisible();
    await expect(page.locator('nav[aria-label="Main navigation"]')).toBeVisible();
  });

  test('has labelled planning controls', async ({ page }) => {
    await expect(page.locator('label[for="event-type"]')).toBeVisible();
    await expect(page.locator('label[for="guest-count"]')).toBeVisible();
    await expect(page.locator('label[for="budget"]')).toBeVisible();
    await expect(page.locator('#chat-input')).toHaveAttribute('maxlength', '1000');
  });
});
