// tests/e2e/translation.spec.js
import { test, expect } from './fixtures.js';

// Comic Book Plus の無料コミックページ（ログイン不要）
const CBP_COMIC_URL = 'https://www.comicbookplus.com/?dlid=74171';
// Marvel Unlimited（ログイン必要 → 既存 Chrome プロファイルのセッションを使用）
const MARVEL_COMIC_URL = 'https://www.marvel.com/unlimited/series/23602';

test.describe('翻訳機能', () => {
  test('Comic Book Plus: 翻訳ボタン押下で日本語オーバーレイが表示される', async ({ page }) => {
    await page.goto(CBP_COMIC_URL, { waitUntil: 'load' });

    // ツールバーの「翻訳」ボタンをクリック
    const translateBtn = page.locator('#doug-toolbar').getByRole('button', { name: /翻訳/ });
    await expect(translateBtn).toBeVisible({ timeout: 10_000 });
    await translateBtn.click();

    // 翻訳オーバーレイコンテナが DOM に現れることを確認（テキスト内容は検証しない）
    await expect(page.locator('#doug-overlay-container')).toBeAttached({ timeout: 30_000 });
    // 少なくとも 1 つのオーバーレイが表示される
    await expect(page.locator('.doug-overlay')).toHaveCount({ minimum: 1 }, { timeout: 30_000 });
  });

  test('Marvel Unlimited: 翻訳ボタン押下で日本語オーバーレイが表示される', async ({ page }) => {
    await page.goto(MARVEL_COMIC_URL, { waitUntil: 'load' });

    // Marvel のビューアが読み込まれるまで待機（重い）
    await page.waitForSelector('.comic-reader, [class*="reader"]', { timeout: 30_000 });

    const translateBtn = page.locator('#doug-toolbar').getByRole('button', { name: /翻訳/ });
    await expect(translateBtn).toBeVisible({ timeout: 15_000 });
    await translateBtn.click();

    await expect(page.locator('#doug-overlay-container')).toBeAttached({ timeout: 60_000 });
    await expect(page.locator('.doug-overlay')).toHaveCount({ minimum: 1 }, { timeout: 60_000 });
  });
});
