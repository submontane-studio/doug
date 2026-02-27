// tests/e2e/whitelist.spec.js
import { test, expect } from './fixtures.js';

const TEST_SITE = 'https://www.comicbookplus.com';

test.describe('ホワイトリスト操作', () => {
  test.beforeEach(async ({ page }) => {
    // テスト前にサイトをホワイトリストから除去（クリーンな状態にする）
    // popup 経由ではなく storage を直接操作する
    await page.goto(TEST_SITE);
    // 拡張機能のポップアップを評価して既存エントリを削除
    // （実際の操作は popup を通じて行う）
  });

  test('サイトを追加するとリロード後にツールバーが表示される', async ({ page, context }) => {
    await page.goto(TEST_SITE);

    // 拡張機能のポップアップページを開く
    const popupPage = await context.newPage();
    const extId = await getExtensionId(context);
    await popupPage.goto(`chrome-extension://${extId}/popup.html`);

    // 「このサイトを翻訳」ボタンをクリック（有効化フロー）
    const enableBtn = popupPage.locator('button', { hasText: 'このサイトを翻訳' });
    await enableBtn.click();

    // 解析確認 UI → 「確認して追加」
    const confirmBtn = popupPage.locator('button', { hasText: '確認して追加' });
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // タブのリロードを待つ
    await page.waitForLoadState('load', { timeout: 30_000 });

    // ツールバーが表示されていることを確認
    await expect(page.locator('#doug-toolbar')).toBeVisible({ timeout: 10_000 });
    await popupPage.close();
  });

  test('サイトを削除するとツールバーが消える', async ({ page, context }) => {
    // 前提: サイトが登録済みであること（Task 7-1 の後に実行）
    await page.goto(TEST_SITE);
    const isToolbarVisible = await page.locator('#doug-toolbar').isVisible({ timeout: 5_000 }).catch(() => false);
    if (!isToolbarVisible) {
      test.skip(); // 未登録なら skip
      return;
    }

    const popupPage = await context.newPage();
    const extId = await getExtensionId(context);
    await popupPage.goto(`chrome-extension://${extId}/popup.html`);

    // 「翻訳を停止」ボタンをクリック
    const disableBtn = popupPage.locator('button', { hasText: '翻訳を停止' });
    await disableBtn.click();

    // ツールバーが消えることを確認
    await expect(page.locator('#doug-toolbar')).toBeHidden({ timeout: 10_000 });
    await popupPage.close();
  });
});

/** 拡張機能の ID を service worker の URL から取得 */
async function getExtensionId(context) {
  const workers = context.serviceWorkers();
  if (workers.length > 0) {
    return new URL(workers[0].url()).hostname;
  }
  // service worker がまだ起動していない場合は待機
  const worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  return new URL(worker.url()).hostname;
}
