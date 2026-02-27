# CLAUDE.md — Doug プロジェクト

Chrome 拡張機能（Manifest V3）。Gemini / Claude / ChatGPT / Ollama の Vision API でコミックの吹き出しをリアルタイム翻訳する。

---

## ファイル構成

```
background.js      Service Worker（API 呼び出し・キャッシュ・ホワイトリスト管理）
content.js         コンテントスクリプト（オーバーレイ描画・ツールバー・自動翻訳）
popup.js/html      ポップアップ UI（有効化/無効化・言語設定）
options.js/html    設定ページ（API キー・モデル・Ollama 設定）
manifest.json      MV3 マニフェスト（v1.5.3）

utils/
  url-utils.js     URL 系 pure 関数（normalizeImageUrl / isSiteAllowed 等）
  parse-utils.js   Vision API レスポンスパーサー（parseVisionResponse 等）
  ollama.js        Ollama 用パーサー（content.js の test-only コピー）

tests/
  unit/            Vitest 単体テスト（url-utils / parse-utils / ollama）
  e2e/             Playwright E2E テスト（whitelist / translation / auto-translate）
```

---

## テスト

```bash
npm run test:unit        # 単体テスト（35件・高速）
npm run test:e2e         # E2E テスト（要: Chrome を閉じた状態で実行）
```

E2E テストは既存の Chrome プロファイル（`~/Library/Application Support/Google/Chrome/Default`）を使用する。プロファイルパスを変更したい場合は環境変数 `CHROME_PROFILE_DIR` を設定する。

---

## アーキテクチャの決定事項

### background.js は ES Module

`manifest.json` に `"type": "module"` を設定済み。`utils/` から `import` して使用する。

```js
// background.js の先頭
import { normalizeImageUrl, isSiteAllowed as _isSiteAllowedPure } from './utils/url-utils.js';
import { cleanTranslatedText, parseVisionResponse } from './utils/parse-utils.js';
```

### content.js は IIFE のまま（変更不可）

content.js は `chrome.scripting.executeScript` で動的注入される Classic Script のため、ES Module に変換しない。Ollama 用の pure 関数は `utils/ollama.js` にテスト専用コピーとして管理する。

**content.js の `ollamaCleanText` / `ollamaParseResponse` を変更した場合は `utils/ollama.js` も必ず同期すること。**

### isSiteAllowed の使い分け

- `utils/url-utils.js` の `isSiteAllowed(url, whitelist)` — pure 関数（テスト用）
- `background.js` 内では `_isSiteAllowedPure(url, whitelistedOrigins)` として呼び出す
- `whitelistedOrigins` はモジュールスコープの `Set`（Service Worker 再起動時に `loadWhitelist()` で復元）

---

## 重要な制約

- **`chrome.*` API は `utils/` に持ち込まない**（テスト可能性を維持するため）
- **`content.js` の IIFE 構造を崩さない**
- **`background.js` に `importScripts()` を使わない**（ES Module Service Worker は非対応）
- **E2E テスト実行中は Chrome を閉じておく**（プロファイルのロック競合を防ぐ）

---

## バージョニングルール

- **メジャー（X.0.0）**：設計変更（アーキテクチャ変更、抽象化など）
- **マイナー（1.X.0）**：機能追加（新機能、対応サイト追加など）
- **パッチ（1.2.X）**：小規模修正（バグ修正、スタイル調整など）
- manifest.json・package.json の両方を更新する

---

## 新機能追加時のチェックリスト

- [ ] pure 関数を追加した場合 → `utils/` に抽出してユニットテストを書く
- [ ] `content.js` の Ollama 関数を変更した場合 → `utils/ollama.js` を同期する
- [ ] background.js を変更した場合 → `chrome://extensions/` で再読み込みして動作確認
- [ ] E2E テストで使うセレクタを変更した場合 → `#doug-toolbar` / `#doug-overlay-container` / `.doug-overlay` が対象
