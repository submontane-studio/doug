// tests/e2e/fixtures.js
import { test as base, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 拡張機能のルートディレクトリ（manifest.json がある場所）
const extensionPath = path.join(__dirname, '..', '..');

export const test = base.extend({
  context: async ({}, use) => {
    // 環境変数 CHROME_PROFILE_DIR で上書き可能
    // デフォルトは macOS の Chrome Default プロファイル
    const userDataDir = process.env.CHROME_PROFILE_DIR
      || path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default');

    // ⚠️ 実行中は Chrome を閉じておくこと（プロファイルのロック競合を防ぐ）
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await use(context);
    await context.close();
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';
