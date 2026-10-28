const { test, expect } = require('@playwright/test');

test.describe('Planner flow', () => {
  test('creates and displays a plan', async ({ page }) => {
    await page.goto('/');
    await page.selectOption('#event-type', { label: 'Birthday' });
    await page.fill('#guest-count', '25');
    await page.fill('#budget', '1500');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/preview-plan') && response.status() === 200),
      page.click('#planner-form button[type="submit"]'),
    ]);
    await expect(page.locator('#plan-results')).toBeVisible();
    await expect(page.locator('#budget-breakdown .budget-item')).toHaveCount(6);
    await expect(page.locator('#checklist .check-item')).not.toHaveCount(0);
  });

  test('shows demo assistant response', async ({ page }) => {
    await page.goto('/');
    await page.fill('#chat-input', 'Help me choose my next step.');
    await page.click('#chat-form button[type="submit"]');
    await expect(page.locator('.chat-model')).toHaveCount(2);
    await expect(page.locator('.chat-model').last()).toContainText('celebration plan');
  });

  test('exposes Google planning tools', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#translate-form')).toBeVisible();
    await expect(page.locator('#calendar-link')).toHaveAttribute('rel', /noopener/);
    await expect(page.locator('#maps-link')).toHaveAttribute('target', '_blank');
  });
});
