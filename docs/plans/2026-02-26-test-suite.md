# テストスイート導入 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Vitest（単体テスト）+ Playwright（E2E）のテストスイートを導入し、ロジック関数の回帰防止と主要フローの動作検証を実現する

**Architecture:**
- `utils/` ディレクトリに pure 関数を ES Module として抽出。Vitest でユニットテストを行う。background.js はモジュール化（`"type": "module"`）して utils/ を import する。content.js は IIFE のまま変更せず、ollama 用ユーティリティは test-only として utils/ に複製する。Playwright は既存 Chrome プロファイルの `launchPersistentContext` で Extension をロードして E2E テストを行う。

**Tech Stack:** Vitest ^2.x, @playwright/test ^1.x, Node.js 18+

---

## Task 1: Vitest セットアップ

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`

**Step 1: package.json に vitest を追加**

```json
{
  "name": "doug",
  "version": "1.5.3",
  "private": true,
  "description": "Dougはコミックをリアルタイムで翻訳表示する拡張機能です",
  "type": "module",
  "scripts": {
    "test:unit": "vitest run",
    "test:unit:watch": "vitest",
    "test:e2e": "playwright test",
    "test": "npm run test:unit && npm run test:e2e"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "@playwright/test": "^1.48.0"
  }
}
```

**Step 2: vitest.config.js を作成**

```js
// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
  },
});
```

**Step 3: 依存インストール**

```bash
npm install
```

Expected: `node_modules/` が作成され vitest が入る

**Step 4: 動作確認（まだテストはないが Vitest が起動するか確認）**

```bash
npx vitest run
```

Expected: `No test files found` のようなメッセージで正常終了（エラーなし）

**Step 5: コミット**

```bash
git add package.json vitest.config.js
git commit -m "chore: Vitest セットアップ"
```

---

## Task 2: utils/url-utils.js の作成（TDD）

background.js の URL 系 pure 関数を抽出してテストする。

**Files:**
- Create: `tests/unit/url-utils.test.js`
- Create: `utils/url-utils.js`

**Step 1: 失敗するテストを書く**

```js
// tests/unit/url-utils.test.js
import { describe, it, expect } from 'vitest';
import { normalizeImageUrl, isSessionOnlyUrl, isAllowedImageUrl, isSiteAllowed } from '../../utils/url-utils.js';

describe('normalizeImageUrl', () => {
  it('クエリパラメータを除去する', () => {
    expect(normalizeImageUrl('https://example.com/img.jpg?token=abc'))
      .toBe('https://example.com/img.jpg');
  });
  it('フラグメントを除去する', () => {
    expect(normalizeImageUrl('https://example.com/img.jpg#section'))
      .toBe('https://example.com/img.jpg');
  });
  it('null/undefined は空文字を返す', () => {
    expect(normalizeImageUrl(null)).toBe('');
    expect(normalizeImageUrl('')).toBe('');
  });
});

describe('isSessionOnlyUrl', () => {
  it('blob: URL は true', () => {
    expect(isSessionOnlyUrl('blob:https://example.com/abc')).toBe(true);
  });
  it('img-hash: URL は true', () => {
    expect(isSessionOnlyUrl('img-hash:abc123')).toBe(true);
  });
  it('通常の https URL は false', () => {
    expect(isSessionOnlyUrl('https://example.com/img.jpg')).toBe(false);
  });
  it('非文字列は false', () => {
    expect(isSessionOnlyUrl(null)).toBe(false);
    expect(isSessionOnlyUrl(undefined)).toBe(false);
  });
});

describe('isAllowedImageUrl', () => {
  it('https URL は true', () => {
    expect(isAllowedImageUrl('https://example.com/img.jpg')).toBe(true);
  });
  it('http URL は false', () => {
    expect(isAllowedImageUrl('http://example.com/img.jpg')).toBe(false);
  });
  it('不正 URL は false', () => {
    expect(isAllowedImageUrl('not-a-url')).toBe(false);
  });
});

describe('isSiteAllowed', () => {
  const whitelist = new Set(['https://example.com', 'https://marvel.com']);

  it('ホワイトリストにあるオリジンは true', () => {
    expect(isSiteAllowed('https://example.com/page', whitelist)).toBe(true);
  });
  it('サブパスが違っても同オリジンなら true', () => {
    expect(isSiteAllowed('https://example.com/comics/1', whitelist)).toBe(true);
  });
  it('未登録オリジンは false', () => {
    expect(isSiteAllowed('https://other.com/page', whitelist)).toBe(false);
  });
  it('不正 URL は false（例外を出さない）', () => {
    expect(isSiteAllowed('not-a-url', whitelist)).toBe(false);
  });
  it('null/undefined は false', () => {
    expect(isSiteAllowed(null, whitelist)).toBe(false);
    expect(isSiteAllowed(undefined, whitelist)).toBe(false);
  });
  it('空の whitelist は常に false', () => {
    expect(isSiteAllowed('https://example.com', new Set())).toBe(false);
  });
});
```

**Step 2: テストを実行して失敗することを確認**

```bash
npx vitest run tests/unit/url-utils.test.js
```

Expected: `Cannot find module '../../utils/url-utils.js'` でエラー

**Step 3: utils/url-utils.js を実装**

```js
// utils/url-utils.js

/**
 * URLからクエリパラメータ・フラグメント・認証情報を除去
 * @param {string} url
 * @returns {string}
 */
export function normalizeImageUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    const stripped = url.replace(/^[^:]+:\/\/[^@]*@/, '');
    return stripped.split('?')[0].split('#')[0];
  }
}

/**
 * Blob URL や img-hash: はセッション限定キャッシュを使用
 * @param {string} url
 * @returns {boolean}
 */
export function isSessionOnlyUrl(url) {
  return typeof url === 'string' && (url.startsWith('blob:') || url.startsWith('img-hash:'));
}

/**
 * FETCH_IMAGE で許可する画像URL（https のみ）
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowedImageUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * URL と whitelist Set でサイト許可を判定（pure 関数版）
 * background.js の isSiteAllowed は whitelistedOrigins を直接参照しているため、
 * テスト可能なようにホワイトリストを引数で受け取る
 * @param {string} url
 * @param {Set<string>} whitelist
 * @returns {boolean}
 */
export function isSiteAllowed(url, whitelist) {
  if (!url) return false;
  try {
    const origin = new URL(url).origin;
    return whitelist.has(origin);
  } catch { return false; }
}
```

**Step 4: テストを実行してすべてパスすることを確認**

```bash
npx vitest run tests/unit/url-utils.test.js
```

Expected: `✓ tests/unit/url-utils.test.js (11 tests)` 全パス

**Step 5: コミット**

```bash
git add utils/url-utils.js tests/unit/url-utils.test.js
git commit -m "test: url-utils の単体テストを追加"
```

---

## Task 3: utils/parse-utils.js の作成（TDD）

background.js の `cleanTranslatedText` と `parseVisionResponse` を抽出してテストする。

**Files:**
- Create: `tests/unit/parse-utils.test.js`
- Create: `utils/parse-utils.js`

**Step 1: 失敗するテストを書く**

```js
// tests/unit/parse-utils.test.js
import { describe, it, expect } from 'vitest';
import { cleanTranslatedText, parseVisionResponse } from '../../utils/parse-utils.js';

describe('cleanTranslatedText', () => {
  it('「」で囲まれた文字列の括弧を除去する', () => {
    expect(cleanTranslatedText('「こんにちは」')).toBe('こんにちは');
  });
  it('末尾の。を除去する', () => {
    expect(cleanTranslatedText('こんにちは。')).toBe('こんにちは');
  });
  it('開き括弧のみ・閉じ括弧のみの場合は変換しない', () => {
    expect(cleanTranslatedText('「こんにちは')).toBe('「こんにちは');
    expect(cleanTranslatedText('こんにちは」')).toBe('こんにちは」');
  });
  it('null/undefined/空文字はそのまま返す', () => {
    expect(cleanTranslatedText(null)).toBe(null);
    expect(cleanTranslatedText('')).toBe('');
  });
});

describe('parseVisionResponse', () => {
  it('box 形式（[yMin,xMin,yMax,xMax]）を % に変換する', () => {
    const input = JSON.stringify([{
      original: 'Hello',
      translated: 'こんにちは',
      type: 'speech',
      box: [100, 200, 300, 600],
    }]);
    const result = parseVisionResponse(input, { width: 1000, height: 1000 });
    expect(result).toHaveLength(1);
    expect(result[0].bbox.top).toBeCloseTo(10);
    expect(result[0].bbox.left).toBeCloseTo(20);
    expect(result[0].bbox.width).toBeCloseTo(40);
    expect(result[0].bbox.height).toBeCloseTo(20);
    expect(result[0].translated).toBe('こんにちは');
    expect(result[0].type).toBe('speech');
  });
  it('bbox 形式（ピクセル座標）を % に変換する', () => {
    const input = JSON.stringify([{
      original: 'Hi',
      translated: 'やあ',
      type: 'caption',
      bbox: { x: 100, y: 150, w: 200, h: 100 },
    }]);
    const result = parseVisionResponse(input, { width: 1000, height: 1500 });
    expect(result[0].bbox.left).toBeCloseTo(10);
    expect(result[0].bbox.top).toBeCloseTo(10);
  });
  it('不正 JSON は [] を返す', () => {
    expect(parseVisionResponse('{broken json', {})).toEqual([]);
  });
  it('translated が空の要素は除外される', () => {
    const input = JSON.stringify([
      { original: 'A', translated: '', box: [0, 0, 100, 100] },
      { original: 'B', translated: 'ビー', box: [100, 0, 200, 100] },
    ]);
    const result = parseVisionResponse(input, {});
    expect(result).toHaveLength(1);
    expect(result[0].original).toBe('B');
  });
  it('background（文字列）が保存される', () => {
    const input = JSON.stringify([{
      original: 'X', translated: 'エックス', box: [0, 0, 100, 100],
      background: '#ffe082',
    }]);
    const result = parseVisionResponse(input, {});
    expect(result[0].background).toBe('#ffe082');
  });
  it('background（グラデーション）が linear-gradient に変換される', () => {
    const input = JSON.stringify([{
      original: 'X', translated: 'エックス', box: [0, 0, 100, 100],
      background: { top: '#fff', bottom: '#000' },
    }]);
    const result = parseVisionResponse(input, {});
    expect(result[0].background).toBe('linear-gradient(to bottom, #000, #fff)');
  });
  it('Markdown コードブロックを取り除く', () => {
    const inner = JSON.stringify([{ original: 'A', translated: 'エー', box: [0,0,100,100] }]);
    const input = '```json\n' + inner + '\n```';
    const result = parseVisionResponse(input, {});
    expect(result).toHaveLength(1);
  });
});
```

**Step 2: テストを実行して失敗することを確認**

```bash
npx vitest run tests/unit/parse-utils.test.js
```

Expected: `Cannot find module '../../utils/parse-utils.js'` でエラー

**Step 3: utils/parse-utils.js を実装**

background.js の `cleanTranslatedText`（line 1008）と `parseVisionResponse`（line 1162）をそのままコピーして export を付ける。

```js
// utils/parse-utils.js

/**
 * 翻訳テキストの後処理（「」除去・末尾。除去）
 * background.js の cleanTranslatedText と同一ロジック
 * @param {string} text
 * @returns {string}
 */
export function cleanTranslatedText(text) {
  if (!text) return text;
  let s = text;
  if (s.startsWith('「') && s.endsWith('」')) {
    s = s.slice(1, -1);
  }
  s = s.replace(/。$/, '');
  return s;
}

/**
 * Gemini/Claude/OpenAI Vision API レスポンスを bbox 配列にパース
 * background.js の parseVisionResponse と同一ロジック
 * @param {string} geminiResponse - LLM が返した JSON 文字列
 * @param {{ width?: number, height?: number }} imageDims - 画像サイズ（bbox 形式の場合に使用）
 * @returns {Array<{ bbox: object, original: string, translated: string, type: string }>}
 */
export function parseVisionResponse(geminiResponse, imageDims) {
  let cleaned = geminiResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const imgW = imageDims?.width || 1000;
  const imgH = imageDims?.height || 1500;

  const sanitized = jsonMatch[0]
    .replace(/(?<!:)\/\/.*$/gm, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/\\(?!["\\\/bfnrtu])/g, '\\\\')
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/([}\]])\s*(["{[])/g, '$1,$2');

  const candidates = [sanitized, sanitized + '}]', sanitized + '"}]'];
  const lastObj = sanitized.lastIndexOf('},');
  if (lastObj > 0) candidates.push(sanitized.substring(0, lastObj + 1) + ']');

  let results = null;
  let parseErr = null;
  for (const candidate of candidates) {
    try { results = JSON.parse(candidate); break; } catch (e) { parseErr = parseErr ?? e; }
  }

  if (!Array.isArray(results)) return [];

  try {
    return results
      .filter(r => r.translated && (r.box || r.bbox))
      .map(r => {
        let top, left, width, height;
        if (r.box && Array.isArray(r.box) && r.box.length === 4) {
          const [yMin, xMin, yMax, xMax] = r.box;
          top = (yMin / 1000) * 100;
          left = (xMin / 1000) * 100;
          width = ((xMax - xMin) / 1000) * 100;
          height = ((yMax - yMin) / 1000) * 100;
        } else if (r.bbox) {
          const bx = r.bbox.x ?? r.bbox.left ?? 0;
          const by = r.bbox.y ?? r.bbox.top ?? 0;
          const bw = r.bbox.w ?? r.bbox.width ?? 100;
          const bh = r.bbox.h ?? r.bbox.height ?? 50;
          top = (by / imgH) * 100;
          left = (bx / imgW) * 100;
          width = (bw / imgW) * 100;
          height = (bh / imgH) * 100;
        }
        const result = {
          bbox: { top, left, width, height },
          original: r.original || '',
          translated: cleanTranslatedText(r.translated),
          type: r.type || 'speech',
        };
        if (r.background) {
          if (typeof r.background === 'string') {
            result.background = r.background;
          } else if (r.background.top && r.background.bottom) {
            result.background = `linear-gradient(to bottom, ${r.background.bottom}, ${r.background.top})`;
          }
        }
        if (r.border) result.border = r.border;
        return result;
      });
  } catch {
    return [];
  }
}
```

**Step 4: テストを実行してすべてパスすることを確認**

```bash
npx vitest run tests/unit/parse-utils.test.js
```

Expected: `✓ tests/unit/parse-utils.test.js (10 tests)` 全パス

**Step 5: コミット**

```bash
git add utils/parse-utils.js tests/unit/parse-utils.test.js
git commit -m "test: parse-utils の単体テストを追加"
```

---

## Task 4: utils/ollama.js の作成（TDD）

content.js の IIFE 内にある Ollama 用 pure 関数をテスト専用として複製する。

**Files:**
- Create: `tests/unit/ollama.test.js`
- Create: `utils/ollama.js`

**Step 1: 失敗するテストを書く**

```js
// tests/unit/ollama.test.js
import { describe, it, expect } from 'vitest';
import { ollamaCleanText, ollamaParseResponse } from '../../utils/ollama.js';

describe('ollamaCleanText', () => {
  it('「」で囲まれた文字列の括弧を除去する', () => {
    expect(ollamaCleanText('「こんにちは」')).toBe('こんにちは');
  });
  it('末尾の。を除去する', () => {
    expect(ollamaCleanText('こんにちは。')).toBe('こんにちは');
  });
  it('null/falsy はそのまま返す', () => {
    expect(ollamaCleanText(null)).toBe(null);
    expect(ollamaCleanText('')).toBeFalsy();
  });
});

describe('ollamaParseResponse', () => {
  it('box 形式を % に変換する（Ollama は固定 1000x1000 スケール）', () => {
    const input = JSON.stringify([{
      original: 'BOOM',
      translated: 'ドーン',
      type: 'sfx',
      box: [500, 250, 750, 750],
    }]);
    const result = ollamaParseResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].bbox.top).toBeCloseTo(50);
    expect(result[0].bbox.left).toBeCloseTo(25);
    expect(result[0].bbox.width).toBeCloseTo(50);
    expect(result[0].bbox.height).toBeCloseTo(25);
  });
  it('bbox 形式（Ollama フォールバック）も動作する', () => {
    const input = JSON.stringify([{
      original: 'Hi',
      translated: 'やあ',
      type: 'speech',
      bbox: { x: 100, y: 150, w: 200, h: 100 },
    }]);
    const result = ollamaParseResponse(input);
    expect(result[0].bbox.left).toBeCloseTo(10);
  });
  it('不正 JSON は [] を返す', () => {
    expect(ollamaParseResponse('broken')).toEqual([]);
  });
  it('translated が空の要素は除外される', () => {
    const input = JSON.stringify([
      { original: 'A', translated: '', box: [0, 0, 100, 100] },
      { original: 'B', translated: 'ビー', box: [100, 0, 200, 100] },
    ]);
    expect(ollamaParseResponse(input)).toHaveLength(1);
  });
  it('translated テキストに ollamaCleanText が適用される', () => {
    const input = JSON.stringify([{
      original: 'Hello',
      translated: '「こんにちは」',
      box: [0, 0, 100, 100],
    }]);
    expect(ollamaParseResponse(input)[0].translated).toBe('こんにちは');
  });
});
```

**Step 2: テストを実行して失敗することを確認**

```bash
npx vitest run tests/unit/ollama.test.js
```

Expected: `Cannot find module '../../utils/ollama.js'` でエラー

**Step 3: utils/ollama.js を実装**

content.js の `ollamaCleanText`（line 26）と `ollamaParseResponse`（line 33）をそのままコピーして export を付ける。

```js
// utils/ollama.js
// content.js の IIFE 内にある Ollama 用 pure 関数のテスト専用コピー
// content.js が変更された場合はここも同期すること

/**
 * Ollama 翻訳テキストの後処理（「」除去・末尾。除去）
 * content.js の ollamaCleanText と同一ロジック
 */
export function ollamaCleanText(text) {
  if (!text) return text;
  let s = text;
  if (s.startsWith('「') && s.endsWith('」')) s = s.slice(1, -1);
  return s.replace(/。$/, '');
}

/**
 * Ollama レスポンス JSON 文字列を bbox 配列にパース
 * content.js の ollamaParseResponse と同一ロジック
 * Ollama は bbox の y 軸スケールに 1500 を使用（Vision API とは異なる）
 */
export function ollamaParseResponse(content) {
  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const sanitized = jsonMatch[0]
      .replace(/[\x00-\x1F\x7F]+/g, ' ')
      .replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
    const results = JSON.parse(sanitized);
    if (!Array.isArray(results)) return [];
    return results.filter(r => r.translated && (r.box || r.bbox)).map(r => {
      let top, left, width, height;
      if (r.box && Array.isArray(r.box) && r.box.length === 4) {
        const [yMin, xMin, yMax, xMax] = r.box;
        top = (yMin / 1000) * 100; left = (xMin / 1000) * 100;
        width = ((xMax - xMin) / 1000) * 100; height = ((yMax - yMin) / 1000) * 100;
      } else if (r.bbox) {
        const bx = r.bbox.x ?? r.bbox.left ?? 0, by = r.bbox.y ?? r.bbox.top ?? 0;
        const bw = r.bbox.w ?? r.bbox.width ?? 100, bh = r.bbox.h ?? r.bbox.height ?? 50;
        top = (by / 1500) * 100; left = (bx / 1000) * 100;
        width = (bw / 1000) * 100; height = (bh / 1500) * 100;
      }
      const result = {
        bbox: { top, left, width, height },
        original: r.original || '',
        translated: ollamaCleanText(r.translated),
        type: r.type || 'speech',
      };
      if (r.background) {
        result.background = typeof r.background === 'string'
          ? r.background
          : (r.background.top && r.background.bottom
            ? `linear-gradient(to bottom, ${r.background.bottom}, ${r.background.top})`
            : undefined);
      }
      if (r.border) result.border = r.border;
      return result;
    });
  } catch { return []; }
}
```

**Step 4: テストを実行してすべてパスすることを確認**

```bash
npx vitest run tests/unit/ollama.test.js
```

Expected: `✓ tests/unit/ollama.test.js (8 tests)` 全パス

**Step 5: ユニットテスト全体をまとめて実行**

```bash
npx vitest run
```

Expected: 全テスト（url-utils + parse-utils + ollama）がパス

**Step 6: コミット**

```bash
git add utils/ollama.js tests/unit/ollama.test.js
git commit -m "test: ollama-utils の単体テストを追加"
```

---

## Task 5: background.js をモジュール化して utils/ を import

background.js を ES Module に変換し、重複関数を utils/ 参照に置き換える。

**Files:**
- Modify: `manifest.json`
- Modify: `background.js`

> ⚠️ この変更後は必ず拡張機能を再ロードして動作確認すること
> `chrome://extensions/` → Doug の「再読み込み」ボタン

**Step 1: manifest.json に `"type": "module"` を追加**

background セクションを以下に変更（行 20-22）：

```json
"background": {
  "service_worker": "background.js",
  "type": "module"
},
```

**Step 2: background.js のトップに import 文を追加**

ファイル先頭（1行目の前）に以下を追加：

```js
import { normalizeImageUrl, isSessionOnlyUrl, isAllowedImageUrl, isSiteAllowed as _isSiteAllowedPure } from './utils/url-utils.js';
import { cleanTranslatedText, parseVisionResponse } from './utils/parse-utils.js';
```

**Step 3: background.js の重複関数を削除**

以下の関数定義を background.js から削除する（utils/ の実装に置き換えるため）：

- `normalizeImageUrl`（line 405-415）
- `isSessionOnlyUrl`（line 418-421）
- `isAllowedImageUrl`（line 287-293）
- `cleanTranslatedText`（line 1008-1018）
- `parseVisionResponse`（line 1162-1261）

**Step 4: isSiteAllowed の呼び出しを修正**

background.js 内の `isSiteAllowed(url)` の呼び出し（2箇所）を変更：

- line 107: `isSiteAllowed(sender.tab.url)` → `_isSiteAllowedPure(sender.tab.url, whitelistedOrigins)`
- line 143: `isSiteAllowed(sender.tab.url)` → `_isSiteAllowedPure(sender.tab.url, whitelistedOrigins)`

また、background.js の既存の `function isSiteAllowed(url)` 定義（line 22-28）も削除する。

**Step 5: 手動動作確認**

1. `chrome://extensions/` を開く
2. Doug の「再読み込み」ボタンをクリック
3. エラーが表示されないことを確認
4. ホワイトリスト登録済みのサイトを開き、ツールバーが表示されることを確認

**Step 6: コミット**

```bash
git add manifest.json background.js
git commit -m "refactor: background.js を ES Module 化して utils/ を import"
```

---

## Task 6: Playwright セットアップ

**Files:**
- Create: `playwright.config.js`
- Create: `tests/e2e/fixtures.js`

**Step 1: Playwright Chromium をインストール**

```bash
npx playwright install chromium
```

Expected: Chromium がダウンロードされる（数分かかる場合あり）

**Step 2: playwright.config.js を作成**

```js
// playwright.config.js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,        // Marvel の描画が重いため 60 秒
  retries: 0,
  use: {
    headless: false,      // Chrome 拡張機能は headless 非対応
    viewport: { width: 1280, height: 800 },
  },
  reporter: [['list']],
});
```

**Step 3: tests/e2e/fixtures.js を作成**

```js
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
```

**Step 4: 動作確認（空の E2E テストを一時的に作成して確認）**

```js
// tests/e2e/smoke.spec.js（確認後削除）
import { test, expect } from './fixtures.js';

test('拡張機能がロードされる', async ({ context }) => {
  const backgroundPages = context.backgroundPages();
  // MV3 では background pages は空（service worker のため）
  expect(backgroundPages).toBeDefined();
});
```

```bash
npx playwright test tests/e2e/smoke.spec.js
```

Expected: ブラウザが起動してテストがパスする（1〜2秒）

確認できたら `tests/e2e/smoke.spec.js` を削除する。

**Step 5: コミット**

```bash
git add playwright.config.js tests/e2e/fixtures.js
git commit -m "chore: Playwright E2E セットアップ"
```

---

## Task 7: ホワイトリスト E2E テスト

**Files:**
- Create: `tests/e2e/whitelist.spec.js`

**Step 1: テストを書く**

```js
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
```

**Step 2: テストを実行**

```bash
npx playwright test tests/e2e/whitelist.spec.js
```

Expected: ブラウザが起動してテストが実行される。パスしない場合は `--headed` でデバッグ

**Step 3: コミット**

```bash
git add tests/e2e/whitelist.spec.js
git commit -m "test: ホワイトリスト E2E テストを追加"
```

---

## Task 8: 翻訳 E2E テスト（Comic Book Plus）

**Files:**
- Create: `tests/e2e/translation.spec.js`

**Step 1: テストを書く**

```js
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
```

**Step 2: テストを実行（Comic Book Plus のみ）**

```bash
npx playwright test tests/e2e/translation.spec.js --grep "Comic Book Plus"
```

Expected: ブラウザで Comic Book Plus が開き、翻訳オーバーレイが表示される

**Step 3: Marvel のテストも実行（Chrome にログイン済みであることが前提）**

```bash
npx playwright test tests/e2e/translation.spec.js --grep "Marvel"
```

**Step 4: コミット**

```bash
git add tests/e2e/translation.spec.js
git commit -m "test: 翻訳フロー E2E テストを追加（Comic Book Plus / Marvel Unlimited）"
```

---

## Task 9: 自動翻訳 E2E テスト

**Files:**
- Create: `tests/e2e/auto-translate.spec.js`

**Step 1: テストを書く**

```js
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
```

**Step 2: テストを実行**

```bash
npx playwright test tests/e2e/auto-translate.spec.js
```

**Step 3: 全 E2E テストをまとめて実行**

```bash
npx playwright test
```

**Step 4: 全ユニットテストも確認**

```bash
npx vitest run
```

**Step 5: コミット**

```bash
git add tests/e2e/auto-translate.spec.js
git commit -m "test: 自動翻訳 E2E テストを追加"
```

---

## 最終確認

```bash
# ユニットテスト
npm run test:unit
# Expected: 全テスト（url-utils + parse-utils + ollama）パス

# E2E テスト
npm run test:e2e
# Expected: whitelist / translation / auto-translate がパス
```

## 注意事項

- **E2E テスト実行中は Chrome を閉じておくこと**（プロファイルのロック競合を防ぐ）
- Marvel Unlimited テストは Chrome の Default プロファイルでログイン済みであることが前提
- Chrome プロファイルパスを変更したい場合は `CHROME_PROFILE_DIR` 環境変数を設定
- `utils/ollama.js` は content.js の複製のため、**content.js の関数を変更した場合は utils/ollama.js も同期すること**
