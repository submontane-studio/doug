# テストスイート導入 設計ドキュメント

**日付**: 2026-02-26
**対象**: Doug Chrome 拡張機能 (Manifest V3)
**方針**: Vitest（単体テスト）+ Playwright（E2E テスト）

---

## 1. 目標

- ロジック関数の正確性を自動検証する（回帰防止）
- 実ブラウザで主要フローの動作を確認する
- ローカル実行のみ（CI 不要）

---

## 2. アーキテクチャ

```
tests/
  unit/                    # Vitest（純粋関数ロジック）
    ollamaParseResponse.test.js
    isSiteAllowed.test.js
    translationParse.test.js
    cache.test.js
  e2e/                     # Playwright（実ブラウザ動作）
    whitelist.spec.js
    translation.spec.js
    auto-translate.spec.js

utils/                     # content.js / background.js から抽出した純粋関数
  ollama.js                # ollamaCleanText / ollamaParseResponse
  translation.js           # 各 API レスポンスパーサー
  cache.js                 # キャッシュキー生成・TTL 判定

vitest.config.js
playwright.config.js
```

---

## 3. 単体テスト（Vitest）

### 3.1 対象関数

| 抽出元 | 関数 | 格納先 |
|--------|------|--------|
| `content.js` | `ollamaCleanText` | `utils/ollama.js` |
| `content.js` | `ollamaParseResponse` | `utils/ollama.js` |
| `content.js` | `geminiParseResponse` | `utils/translation.js` |
| `content.js` | `claudeParseResponse` | `utils/translation.js` |
| `background.js` | `isSiteAllowed` | `utils/cache.js` |
| `background.js` | `getCacheKey` | `utils/cache.js` |
| `background.js` | `isCacheExpired` | `utils/cache.js` |

### 3.2 テストケース

**`ollamaParseResponse`**
- 正常な JSON 配列をパースできる
- `box` 形式（`[yMin, xMin, yMax, xMax]`）を % に変換できる
- `bbox` 形式も正しく変換できる
- 不正 JSON は `[]` を返す
- `translated` が空の要素は除外される

**`isSiteAllowed`**
- ホワイトリストにあるオリジンは `true`
- サブパスが違っても同オリジンなら `true`
- 未登録オリジンは `false`
- 不正 URL は `false`（例外を出さない）

**`isCacheExpired`**
- TTL 内は `false`
- TTL 超過は `true`
- キャッシュバージョン不一致は `true`

### 3.3 設定

- `chrome.*` への依存なし → `vitest-chrome` 不要
- IIFE は維持したまま、内部から `utils/` の関数を呼び出す形に変更

---

## 4. E2E テスト（Playwright）

### 4.1 Chrome プロファイル設定

- `chromium.launchPersistentContext` + 既存プロファイルの `userDataDir` を使用
- Marvel Unlimited はログイン済みセッションを再利用（認証情報を保存しない）
- `headless: false`（Chrome 拡張機能は headless 非対応）

```js
// playwright.config.js（概要）
const userDataDir = process.env.CHROME_PROFILE_DIR
  || '/Users/Tsuyoshi/Library/Application Support/Google/Chrome/Default';
```

### 4.2 テストシナリオ

| ファイル | シナリオ |
|----------|----------|
| `whitelist.spec.js` | サイト追加 → リロード後にツールバーが表示される |
| `whitelist.spec.js` | サイト削除 → ツールバーが消える |
| `translation.spec.js` | Comic Book Plus で翻訳実行 → 日本語オーバーレイが表示される |
| `translation.spec.js` | Marvel Unlimited で翻訳実行 → 日本語オーバーレイが表示される |
| `auto-translate.spec.js` | 自動翻訳トグル ON → ページ遷移後に自動で翻訳が始まる |

### 4.3 アサーション方針

- 翻訳テキストの内容は AI 依存のため検証しない
- **「オーバーレイ要素が DOM に存在するか」のみをアサート**
- Marvel のページ描画は重いため `timeout: 60000` を設定

---

## 5. manifest.json への追加

`content_scripts` に `utils/` ファイルを追加する必要がある。

```json
"content_scripts": [{
  "js": [
    "utils/ollama.js",
    "utils/translation.js",
    "utils/cache.js",
    "content.js"
  ]
}]
```

---

## 6. package.json スクリプト

```json
{
  "scripts": {
    "test:unit": "vitest run",
    "test:unit:watch": "vitest",
    "test:e2e": "playwright test",
    "test": "npm run test:unit && npm run test:e2e"
  },
  "devDependencies": {
    "vitest": "^2.x",
    "@playwright/test": "^1.x"
  }
}
```

---

## 7. 実装上の注意

- `content.js` の IIFE 構造は維持。IIFE 内で `utils/` の関数を呼ぶ形に変更する
- `utils/` の各ファイルは ES Module（`export`）形式で記述
- 既存コードの動作は一切変えない（純粋関数の抽出のみ）
- `userDataDir` に本番プロファイルを直接指定するため、テスト実行中はブラウザを閉じておく

---

## 8. 今後の拡張候補（YAGNI のため今回は対象外）

- GitHub Actions 連携
- Kindle Unlimited E2E テスト
- API モックサーバーを使った翻訳レスポンスのスタブ化
