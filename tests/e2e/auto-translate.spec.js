// tests/e2e/auto-translate.spec.js
import { test, expect } from './fixtures.js';

const CBP_COMIC_URL = 'https://www.comicbookplus.com/?dlid=74171';

test.describe('自動翻訳トグル', () => {
  test('自動翻訳 ON → 翻訳が自動で開始される', async ({ page }) => {
    await page.goto(CBP_COMIC_URL, { waitUntil: 'load' });

    // ツールバーの自動翻訳トグルを ON にする
    const autoToggle = page.locator('#doug-toolbar').getByRole('checkbox', { name: /自動/ });
    await expect(autoToggle).toBeVisible({ timeout: 10_000 });

    // まだ OFF の場合のみ ON にする
    if (!await autoToggle.isChecked()) {
      await autoToggle.click();
    }

    // 自動翻訳が開始されてオーバーレイが表示されることを確認
    await expect(page.locator('#doug-overlay-container')).toBeAttached({ timeout: 30_000 });
    await expect(page.locator('.doug-overlay')).toHaveCount({ minimum: 1 }, { timeout: 30_000 });
  });
});
