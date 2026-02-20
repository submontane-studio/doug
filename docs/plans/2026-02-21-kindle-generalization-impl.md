# Kindle対応 & 汎用化 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Marvel固有ロジックを削除して汎用化し、Kindleでもセーフモードで翻訳できるようにする。

**Architecture:** `findLargestVisibleImage()`でビューポート最大画像を自動検出。ページ遷移はURL変化＋Blob URL src変化で汎用検知。KindleのBlob URLはsession storageにキャッシュし、セッション終了で自動破棄。

**Tech Stack:** Chrome Extension MV3, chrome.storage.session, MutationObserver, PerformanceObserver

**Design Doc:** `docs/plans/2026-02-21-kindle-generalization-design.md`

---

## 事前確認

- Chrome拡張機能の管理ページ: `chrome://extensions/`
- 「デベロッパーモード」ON、「パッケージ化されていない拡張機能を読み込む」でdougフォルダを選択済み
- 変更後は拡張機能の「更新」ボタンを押してリロード

---

### Task 1: manifest.json — Amazonドメインを追加

**Files:**
- Modify: `manifest.json`

**Step 1: `host_permissions` と `content_scripts.matches` にAmazonドメインを追加**

```json
"host_permissions": [
  "https://*.marvel.com/*",
  "https://i.annihil.us/*",
  "https://*.amazon.co.jp/*",
  "https://*.amazon.com/*",
  "https://generativelanguage.googleapis.com/*",
  "https://api.anthropic.com/*",
  "https://api.openai.com/*",
  "http://localhost:11434/*"
],
"content_scripts": [
  {
    "matches": [
      "https://*.marvel.com/*",
      "https://*.amazon.co.jp/*",
      "https://*.amazon.com/*"
    ],
    "js": ["content.js"],
    "css": ["content.css"],
    "run_at": "document_idle"
  }
],
```

**Step 2: 手動確認**

拡張機能をリロード → `chrome://extensions/` でエラーが出ていないことを確認。

**Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat: manifest にAmazonドメインを追加"
```

---

### Task 2: background.js — 送信元制限をAmazonに拡張

**Files:**
- Modify: `background.js:5-6` （MARVEL_URL_RE の定義行）、および参照箇所 2箇所（38行目・62行目）

**Step 1: 定数名と正規表現を変更**

`MARVEL_URL_RE` の定義を以下に置き換え:

```js
const ALLOWED_SITES_RE = /^https:\/\/([^/]*\.marvel\.com|[^/]*\.amazon\.co\.jp|[^/]*\.amazon\.com)(\/|$)/;
```

**Step 2: 参照箇所を置換**

`MARVEL_URL_RE.test(` をすべて `ALLOWED_SITES_RE.test(` に置換（2箇所: Port接続ハンドラーとメッセージハンドラー）。

**Step 3: 手動確認**

拡張機能をリロード → `chrome://extensions/` でエラーなし。
Kindle（`read.amazon.co.jp`）のページを開いてコンソールを確認（エラーなし）。

**Step 4: Commit**

```bash
git add background.js
git commit -m "feat: background.js の送信元制限をAmazonに拡張"
```

---

### Task 3: background.js — Blob URL用のsessionキャッシュ分岐

**Files:**
- Modify: `background.js` （キャッシュ関連3関数）

**Step 1: `isSessionOnlyUrl` ヘルパーを追加**

`generateCacheKey` 関数の直前に追加:

```js
// Blob URL（Kindle等）はセッションのみ保存（セッション終了で自動破棄）
function isSessionOnlyUrl(url) {
  return typeof url === 'string' && url.startsWith('blob:');
}
```

**Step 2: `getCachedTranslation` を書き換え**

現在の `getCachedTranslation` 全体を以下に置き換え:

```js
async function getCachedTranslation(imageUrl, targetLang) {
  const cacheKey = await generateCacheKey(imageUrl, targetLang);
  try {
    const storage = isSessionOnlyUrl(imageUrl) ? chrome.storage.session : chrome.storage.local;
    const result = await storage.get(cacheKey);
    const cached = result[cacheKey];
    if (!cached) return null;
    if (cached.version !== CACHE_VERSION) {
      await storage.remove(cacheKey);
      return null;
    }
    // sessionキャッシュはTTL不要（セッション終了で自動破棄）
    if (!isSessionOnlyUrl(imageUrl) && Date.now() - cached.timestamp > CACHE_TTL) {
      await chrome.storage.local.remove(cacheKey);
      return null;
    }
    return cached.translations;
  } catch (err) {
    console.error('キャッシュ読み込みエラー:', err);
    return null;
  }
}
```

**Step 3: `saveCachedTranslation` を書き換え**

現在の `saveCachedTranslation` 全体を以下に置き換え:

```js
async function saveCachedTranslation(imageUrl, targetLang, translations) {
  const cacheKey = await generateCacheKey(imageUrl, targetLang);
  const cacheData = { translations, timestamp: Date.now(), version: CACHE_VERSION };
  const storage = isSessionOnlyUrl(imageUrl) ? chrome.storage.session : chrome.storage.local;
  try {
    await storage.set({ [cacheKey]: cacheData });
    if (!isSessionOnlyUrl(imageUrl)) {
      const usage = await chrome.storage.local.getBytesInUse();
      if (usage > 8 * 1024 * 1024) await cleanOldCache();
    }
  } catch {
    if (!isSessionOnlyUrl(imageUrl)) {
      await cleanOldCache();
      try { await chrome.storage.local.set({ [cacheKey]: cacheData }); } catch { /* 諦める */ }
    }
  }
}
```

**Step 4: 手動確認**

Kindleページで翻訳を実行 → 翻訳結果が表示される。
DevTools Application → Storage → Session Storage に `cache:...` キーが存在することを確認。
Local Storage には増えていないことを確認。

**Step 5: Commit**

```bash
git add background.js
git commit -m "feat: Blob URL（Kindle）はchrome.storage.sessionにキャッシュ"
```

---

### Task 4: background.js — prefetchデフォルトOFFとBlob URLフィルタ

**Files:**
- Modify: `background.js` （SETTINGS_DEFAULTS と handlePreloadQueue）

**Step 1: `SETTINGS_DEFAULTS.prefetch` を `false` に変更**

```js
// 変更前
prefetch: true,
// 変更後
prefetch: false,
```

**Step 2: `handlePreloadQueue` 内でBlob URLを除外**

`handlePreloadQueue` 関数内、`const clampedUrls = imageUrls.slice(0, PRELOAD_MAX_QUEUE);` の行を以下に置き換え:

```js
// Blob URLはbackground.jsからfetchできないため除外
const normalUrls = imageUrls.filter(u => !u.startsWith('blob:'));
if (normalUrls.length === 0) return;
const clampedUrls = normalUrls.slice(0, PRELOAD_MAX_QUEUE);
```

**Step 3: 手動確認**

拡張機能をリロード → popup を開いて「先読み」設定がOFFになっていることを確認。

**Step 4: Commit**

```bash
git add background.js
git commit -m "feat: 先読みデフォルトOFF & Blob URLをキューから除外"
```

---

### Task 5: content.js — findLargestVisibleImage（汎用画像検出）

**Files:**
- Modify: `content.js` （findComicImage 関数を置き換え）

**Step 1: `findComicImage` 関数全体を `findLargestVisibleImage` に置き換え**

> **【調査で確認済み】** KindleはBlob URL imgを3枚同時にDOMに持つ（前ページ: left=-1920, 現在: left=0, 次: left=+1920）。
> サイズが全て同一のため**ビューポート内チェック必須**（left < 0 や left >= innerWidth を除外する）。

```js
// ============================================================
// コミック画像の検出（汎用: Blob URL img優先・ビューポート内最大面積選択）
// ============================================================
function findLargestVisibleImage() {
  let best = null;
  let maxArea = 0;

  const candidates = [
    // 1. Blob URL img（Kindle等）
    ...[...document.querySelectorAll('img')].filter(el => el.src && el.src.startsWith('blob:')),
    // 2. 通常のimg
    ...[...document.querySelectorAll('img')].filter(el => el.src && !el.src.startsWith('blob:')),
    // 3. SVG image要素（Marvel Unlimited等）
    ...document.querySelectorAll('svg image'),
    // 4. canvas
    ...document.querySelectorAll('canvas'),
  ];

  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 200) continue;
    // ビューポート外（Kindleの前ページ・次ページ）を除外
    if (rect.left < 0 || rect.left >= window.innerWidth) continue;
    if (rect.top < -rect.height || rect.top >= window.innerHeight) continue;
    const area = rect.width * rect.height;
    if (area > maxArea) {
      maxArea = area;
      const isSvgImage = el.tagName.toLowerCase() === 'image';
      const isCanvas = el instanceof HTMLCanvasElement;
      best = {
        type: isSvgImage ? 'svg' : isCanvas ? 'canvas' : 'img',
        element: el,
      };
    }
  }

  return best;
}
```

**Step 2: `findComicImage()` の呼び出し箇所を `findLargestVisibleImage()` に変更**

`translateCurrentPage` 内の `const comicInfo = findComicImage();` を `findLargestVisibleImage()` に変更。

**Step 3: 手動確認**

- Marvelのリーダーで翻訳ボタンを押す → 画像が検出されて翻訳される
- Kindleのビューアで翻訳ボタンを押す → Blob URLのimgが検出されて翻訳される

**Step 4: Commit**

```bash
git add content.js
git commit -m "feat: findComicImage を汎用のfindLargestVisibleImage に置き換え"
```

---

### Task 6: content.js — UI配置の汎用化（Marvel dialog依存を削除）

**Files:**
- Modify: `content.js`

**Step 1: `getUIParent` を `document.body` 固定に変更**

`cachedUIParent` 変数と `getUIParent` 関数を以下に置き換え:

```js
function getUIParent() {
  return document.body;
}
```

**Step 2: 削除する関数・変数・コード**

以下を削除:
- `let cachedUIParent = null;` 変数
- `moveUIToReader()` 関数全体
- `moveUIToBody()` 関数全体
- `dialogObserver` の `new MutationObserver(...)` と `.observe()` のブロック全体
- `if (document.querySelector('dialog.ComicPurchasePaths__Reader[open]')) { startPageWatcher(); }` のブロック

**Step 3: `init()` 関数から `moveUIToReader()` 呼び出しを削除**

```js
// 変更前
function init() {
  createToolbar();
  moveUIToReader();
}

// 変更後
function init() {
  createToolbar();
}
```

**Step 4: 手動確認**

MarvelとKindle両方でツールバーが表示されることを確認（`document.body` に配置されるため、z-indexが適切なら問題なし）。

**Step 5: Commit**

```bash
git add content.js
git commit -m "feat: UI配置をdocument.body固定に変更、Marvel dialog依存を削除"
```

---

### Task 7: content.js — startUniversalPageWatcher（汎用ページ遷移検知）

**Files:**
- Modify: `content.js`

**Step 1: `startPageWatcher` / `stopPageWatcher` を削除し `startUniversalPageWatcher` に置き換え**

`lastPageHref` / `pageObserver` / `watchedImage` 変数と `startPageWatcher` / `stopPageWatcher` 関数全体を削除。

代わりに以下を追加（`init()` 関数の直前あたり）:

> **【調査で確認済み】** Kindleのページ遷移は既存imgのsrc変化ではなく、
> 新しいBlob URL imgの**DOM追加**（3〜4件）で発生する。
> URLは変化しない。`popstate`/`hashchange` は念のため残す。

```js
// ============================================================
// 汎用ページ遷移検知
// ============================================================
function startUniversalPageWatcher() {
  // URL変化を検知（念のため: Marvel等でのSPA遷移に対応）
  const onUrlChange = () => {
    clearOverlays();
    isTranslating = false;
  };
  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);

  // Blob URL imgの新規追加を監視（Kindleのページ遷移で発生）
  // ※ Kindleはページをめくるたびに新しいBlob URL imgを3〜4件DOM追加する
  let clearTimer = null;
  const bodyObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const hasBlobImg =
          (node.tagName === 'IMG' && node.src?.startsWith('blob:')) ||
          node.querySelector?.('img[src^="blob:"]');
        if (hasBlobImg) {
          // デバウンス: 複数追加を1回のclearにまとめる
          clearTimeout(clearTimer);
          clearTimer = setTimeout(() => {
            clearOverlays();
            isTranslating = false;
          }, 100);
          return;
        }
      }
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
}
```

**Step 2: `init()` から `startUniversalPageWatcher()` を呼ぶ**

```js
function init() {
  createToolbar();
  startUniversalPageWatcher();
}
```

**Step 3: `lastQueueKey` / `lastPageHref` のリセット処理を削除**

`stopPageWatcher()` を削除したことで参照されなくなった変数のリセット行も削除。

**Step 4: 手動確認**

- Marvelでページを進める → 前のページのオーバーレイがクリアされる
- Kindleでページを進める → 前のページのオーバーレイがクリアされる

**Step 5: Commit**

```bash
git add content.js
git commit -m "feat: startPageWatcher を汎用のstartUniversalPageWatcher に置き換え"
```

---

### Task 8: content.js — perfObserver の汎用化

**Files:**
- Modify: `content.js` （perfObserver のフィルタ条件）

**Step 1: PerformanceObserver のフィルタを汎用化**

現在のコード:
```js
if (entry.name.includes('/digitalcomic/') && entry.name.includes('/jpg_75/') && !entry.name.includes('/thumbnails/')) {
```

これを以下に変更:
```js
const url = entry.name;
// Blob URLはキャッシュキーに使えないためスキップ
if (url.startsWith('blob:')) continue;
// 画像系のリソースのみ収集（拡張子またはimageを含むパス）
if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url) && !url.includes('/image')) continue;
if (url.includes('/thumbnails/')) continue;
```

**Step 2: `getComicPageUrls()` の `comicPageUrls` Mapのキー・バリューは変更なし**

pathname → full URLの構造は維持。

**Step 3: 手動確認**

Marvelで数ページ読む → DevTools Console で `comicPageUrls` がCDN URLを収集していることを確認（PerformanceObserver が動作中）。

**Step 4: Commit**

```bash
git add content.js
git commit -m "feat: perfObserver のフィルタをMarvel固有から汎用化"
```

---

### Task 9: content.js — triggerPrefetch のセーフモード先読み分岐

**Files:**
- Modify: `content.js`

**Step 1: `findNextBlobImage` ヘルパーを追加**

`triggerPrefetch` 関数の直前に追加:

```js
// セーフモード先読み用：現在の最大imgの次のBlob URL imgを探す
function findNextBlobImage() {
  const blobImgs = [...document.querySelectorAll('img')]
    .filter(img => img.src && img.src.startsWith('blob:') && img.complete)
    .sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
  if (blobImgs.length < 2) return null;
  const currentEl = findLargestVisibleImage()?.element;
  if (!currentEl) return blobImgs[1] || null;
  const idx = blobImgs.indexOf(currentEl);
  if (idx === -1 || idx === blobImgs.length - 1) return null;
  return blobImgs[idx + 1];
}
```

**Step 2: `safeModePreloadTimer` 変数と `scheduleSafeModeNextPage` 関数を追加**

`triggerPrefetch` 関数の直前に追加:

```js
let safeModePreloadTimer = null;

async function scheduleSafeModeNextPage() {
  // prefetch設定を確認（デフォルトOFF）
  const { prefetch } = await chrome.storage.local.get({ prefetch: false });
  if (!prefetch) return;

  clearTimeout(safeModePreloadTimer);
  safeModePreloadTimer = setTimeout(async () => {
    try {
      const nextImg = findNextBlobImage();
      if (!nextImg) return;

      // Canvas変換してBase64取得（BlobURLはCORS制限なし）
      const imageData = captureRasterElement(nextImg);
      // background.jsに送信（内部でkeyャッシュチェック・session保存）
      const port = chrome.runtime.connect({ name: 'translate' });
      port.postMessage({ type: 'TRANSLATE_IMAGE', imageData, imageUrl: nextImg.src });
      port.onMessage.addListener(() => port.disconnect());
      port.onDisconnect.addListener(() => {});
    } catch {
      // セーフモード先読みの失敗は無視
    }
  }, 4200); // 4.2秒ディレイ（レート制限対応）
}
```

**Step 3: `triggerPrefetch` の先頭にBlob URL分岐を追加**

`triggerPrefetch` 関数の `try {` の直後（`const allPages = getComicPageUrls();` の前）に追加:

```js
// Blob URL（Kindle等）はセーフモード先読みフローへ
if (currentImageUrl && currentImageUrl.startsWith('blob:')) {
  scheduleSafeModeNextPage();
  return;
}
```

**Step 4: 手動確認（prefetchをONにして確認）**

1. popup で先読みをONにする
2. Kindleでページを翻訳
3. 4秒後に次のページの翻訳が裏で実行される（コンソールログで確認）
4. 次のページに進む → 翻訳ボタンを押す → 即座に表示される（キャッシュヒット）

**Step 5: Commit**

```bash
git add content.js
git commit -m "feat: Kindle用セーフモード先読み（1ページ、4.2秒ディレイ）"
```

---

### Task 10: 統合テスト

**Step 1: Marvelで動作確認**

1. `read.marvel.com` でコミックを開く
2. 翻訳ボタンを押す → 翻訳オーバーレイが表示される
3. ページを進める → オーバーレイがクリアされる
4. 再度翻訳 → 正常に動作する
5. 先読みONで、進捗バーが表示される

**Step 2: Kindleで動作確認**

1. `read.amazon.co.jp` でKindleコミックを開く
2. ツールバーが表示される
3. 翻訳ボタンを押す → Blob URLのページ画像が翻訳される
4. ページを進める（Kindleの操作）→ オーバーレイがクリアされる
5. DevTools → Application → Session Storage に翻訳キャッシュが保存される
6. 先読みONで、4秒後に次ページがバックグラウンド翻訳される

**Step 3: 最終コミット**

```bash
git add .
git commit -m "feat: Kindle対応 & 汎用化 完了"
```

---

## 注意事項

- SVG `image` 要素（Marvel）は `type: 'svg'` として引き続き `captureSvgImage()` で処理される（変更なし）
- `captureRasterElement()` はBlob URL imgに対してCORS制限なしでdrawImageできる（Blob URLは同一オリジン扱い）
- `chrome.storage.session` はChrome 102+で利用可能（MV3前提のため問題なし）
- MarvelのperfObserverは引き続き動作する（CDN URLは`/image`を含まないが`.jpg`を含むため収集される）
