# ホワイトリスト機能 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** ポップアップと右クリックメニューから任意サイトをオリジン単位でホワイトリスト登録し、即時注入＋次回以降の自動注入を実現する

**Architecture:** per-origin 動的権限（`chrome.permissions.request`）で各サイトの権限を取得。`chrome.storage.sync` にホワイトリストを保存し `background.js` のインメモリ Set でキャッシュ。`tabs.onUpdated` で次回訪問時に自動注入。

**Tech Stack:** Chrome Extensions MV3, chrome.scripting, chrome.permissions, chrome.contextMenus, chrome.storage.sync

---

## Task 1: content.js — 二重注入ガード追加

**Files:**
- Modify: `content.js:5`（`'use strict';` の直後）

**Step 1: 変更を加える**

`content.js` の `'use strict';` の直後に以下を挿入:

```js
  if (window.__dougInitialized) return;
  window.__dougInitialized = true;
```

結果（4〜9行目）:
```js
(function () {
  'use strict';

  if (window.__dougInitialized) return;
  window.__dougInitialized = true;

  let isTranslating = false;
```

**Step 2: 動作確認**

chrome://extensions でリロード → Marvel Unlimited 等を開いて翻訳が正常に動くことを確認（動作変化なし）

**Step 3: コミット**

```bash
git add content.js
git commit -m "fix: content.js 二重注入ガードを追加"
```

---

## Task 2: manifest.json — 権限追加

**Files:**
- Modify: `manifest.json`

**Step 1: 変更を加える**

```diff
  "permissions": [
    "activeTab",
-   "storage"
+   "storage",
+   "scripting",
+   "contextMenus",
+   "tabs"
  ],
+  "optional_host_permissions": ["*://*/*"],
```

**Step 2: 動作確認**

chrome://extensions でリロード → エラーが出ないことを確認

**Step 3: コミット**

```bash
git add manifest.json
git commit -m "feat: manifest に scripting/contextMenus/tabs 権限と optional_host_permissions を追加"
```

---

## Task 3: background.js — ホワイトリストキャッシュ基盤

**Files:**
- Modify: `background.js`（先頭〜 onInstalled ハンドラーまで）

**Step 1: `ALLOWED_SITES_RE` 定義の直後にキャッシュ変数と関連関数を追加**

`background.js` の `const ALLOWED_SITES_RE = ...` の直後（6行目以降）に挿入:

```js
// ============================================================
// ホワイトリスト（任意サイト対応）
// ============================================================
let whitelistedOrigins = new Set();

async function loadWhitelist() {
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  whitelistedOrigins = new Set(whitelist);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.whitelist) {
    whitelistedOrigins = new Set(changes.whitelist.newValue || []);
  }
});

function isSiteAllowed(url) {
  if (!url) return false;
  if (ALLOWED_SITES_RE.test(url)) return true;
  try {
    const origin = new URL(url).origin;
    return whitelistedOrigins.has(origin);
  } catch { return false; }
}
```

**Step 2: `onInstalled` ハンドラーの先頭に `loadWhitelist()` 呼び出しを追加**

既存の `chrome.runtime.onInstalled.addListener(async (details) => {` の中の先頭（`if (details.reason ===` の前）に:

```js
  await loadWhitelist();
```

そして onInstalled の直後（`});` の後）に onStartup ハンドラーを追加:

```js
chrome.runtime.onStartup.addListener(async () => {
  await loadWhitelist();
});
```

**Step 3: `ALLOWED_SITES_RE.test` を `isSiteAllowed` に置き換える**

Port ハンドラー（38行目付近）:
```diff
- if (sender.tab && !ALLOWED_SITES_RE.test(sender.tab.url || '')) { port.disconnect(); return; }
+ if (sender.tab && !isSiteAllowed(sender.tab.url)) { port.disconnect(); return; }
```

メッセージハンドラー（64行目付近）:
```diff
- if (sender.tab && !ALLOWED_SITES_RE.test(sender.tab.url || '')) {
+ if (sender.tab && !isSiteAllowed(sender.tab.url)) {
```

**Step 4: 動作確認**

chrome://extensions でリロード → 既存サイト（Marvel Unlimited 等）で翻訳が正常に動くことを確認（動作変化なし）

**Step 5: コミット**

```bash
git add background.js
git commit -m "feat: background.js にホワイトリストキャッシュ基盤を追加"
```

---

## Task 4: background.js — inject / whitelist 操作関数

**Files:**
- Modify: `background.js`（Task 3 で追加したホワイトリストセクションの末尾に追記）

**Step 1: 以下の関数を追加**

`isSiteAllowed` 関数の直後に追加:

```js
async function injectToTab(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
}

async function saveToWhitelist(origin, tabId) {
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  if (!whitelist.includes(origin)) {
    whitelist.push(origin);
    await chrome.storage.sync.set({ whitelist });
    // storage.onChanged がキャッシュを更新する
  }
  if (tabId != null) await injectToTab(tabId);
}

async function removeFromWhitelist(origin) {
  try {
    await chrome.permissions.remove({ origins: [origin + '/*'] });
  } catch { /* 権限がない場合は無視 */ }
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  await chrome.storage.sync.set({ whitelist: whitelist.filter(o => o !== origin) });
}
```

**Step 2: 動作確認**

コンソールエラーがないことを確認（chrome://extensions → Service Worker の "Inspect views" から）

**Step 3: コミット**

```bash
git add background.js
git commit -m "feat: background.js に injectToTab / saveToWhitelist / removeFromWhitelist を追加"
```

---

## Task 5: background.js — tabs.onUpdated 自動注入

**Files:**
- Modify: `background.js`（メッセージハンドラーの直後に追加）

**Step 1: `tabs.onUpdated` リスナーを追加**

`chrome.runtime.onMessage.addListener(...)` の `});` の直後に追加:

```js
// ============================================================
// ホワイトリストサイトへの自動注入（次回訪問時）
// ============================================================
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;
  try {
    const origin = new URL(tab.url).origin;
    if (!whitelistedOrigins.has(origin)) return;
    await injectToTab(tabId);
  } catch { /* 無効なURL等は無視 */ }
});
```

**Step 2: 動作確認**（Task 8 完了後に最終確認）

現時点ではホワイトリストが空なので動作変化なし。

**Step 3: コミット**

```bash
git add background.js
git commit -m "feat: background.js に tabs.onUpdated 自動注入リスナーを追加"
```

---

## Task 6: background.js — コンテキストメニュー

**Files:**
- Modify: `background.js`（Task 5 の直後に追加）

**Step 1: コンテキストメニュー作成関数を追加**

Task 5 の `tabs.onUpdated` セクションの直後に追加:

```js
// ============================================================
// コンテキストメニュー（右クリック: このサイトで翻訳 ON/OFF）
// ============================================================
function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'doug-toggle-site',
      title: 'Doug: このサイトで翻訳 ON/OFF',
      contexts: ['page'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'doug-toggle-site') return;
  if (!tab?.url) return;
  try {
    const origin = new URL(tab.url).origin;
    if (['chrome:', 'chrome-extension:', 'about:'].includes(new URL(tab.url).protocol)) return;
    if (whitelistedOrigins.has(origin)) {
      await removeFromWhitelist(origin);
    } else {
      const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (granted) await saveToWhitelist(origin, tab.id);
    }
  } catch (err) {
    console.error('[doug] コンテキストメニュー処理エラー:', err.message);
  }
});
```

**Step 2: `onInstalled` と `onStartup` で `createContextMenu()` を呼ぶ**

`onInstalled` ハンドラー（`await loadWhitelist();` の直後）に追加:

```js
  createContextMenu();
```

`onStartup` ハンドラーに追加:

```js
chrome.runtime.onStartup.addListener(async () => {
  await loadWhitelist();
  createContextMenu();  // ← 追加
});
```

**Step 3: 動作確認**

chrome://extensions でリロード → 任意のページで右クリック → "Doug: このサイトで翻訳 ON/OFF" が表示されることを確認

**Step 4: コミット**

```bash
git add background.js
git commit -m "feat: background.js にコンテキストメニューによるホワイトリスト ON/OFF を追加"
```

---

## Task 7: background.js — popup 向けメッセージハンドラー

**Files:**
- Modify: `background.js`（`PRELOAD_QUEUE` ハンドラーの直後に追加）

**Step 1: メッセージハンドラーに追加**

既存の `chrome.runtime.onMessage.addListener` 内の `PRELOAD_QUEUE` ブロックの直後に追加:

```js
  if (message.type === 'ADD_TO_WHITELIST') {
    // chrome.permissions.request は popup.js 側で完了済み
    saveToWhitelist(message.origin, message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'REMOVE_FROM_WHITELIST') {
    removeFromWhitelist(message.origin)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'GET_WHITELIST') {
    chrome.storage.sync.get('whitelist')
      .then(({ whitelist = [] }) => sendResponse({ whitelist }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
```

**Step 2: 動作確認**

コンソールエラーなし。

**Step 3: コミット**

```bash
git add background.js
git commit -m "feat: background.js に ADD/REMOVE/GET_WHITELIST メッセージハンドラーを追加"
```

---

## Task 8: popup.html + popup.css — ホワイトリスト UI

**Files:**
- Modify: `popup.html`
- Modify: `popup.css`

**Step 1: `popup.html` に「現在のサイト」セクションを追加**

`<h1>Doug</h1>` の直後に挿入:

```html
    <div class="section current-site-section" id="currentSiteSection" style="display:none">
      <label>現在のサイト</label>
      <div class="current-site-row">
        <span id="currentSiteHost" class="current-site-host">—</span>
        <button id="toggleSiteBtn" class="btn-primary" style="display:none"></button>
      </div>
    </div>
```

**Step 2: `popup.html` に「カスタムサイト」セクションを追加**

`<div class="actions">` の直前に挿入:

```html
    <div class="section" id="whitelistSection" style="display:none">
      <label>カスタムサイト</label>
      <ul id="whitelistItems" class="whitelist-list"></ul>
    </div>
```

**Step 3: `popup.css` にスタイルを追加**

ファイル末尾に追加:

```css
/* 現在のサイト行 */
.current-site-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.current-site-host {
  font-size: 13px;
  color: #e0e0e0;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.current-site-row .btn-primary,
.current-site-row .btn-secondary {
  width: auto;
  padding: 6px 10px;
  font-size: 11px;
  flex-shrink: 0;
}

/* カスタムサイトリスト */
.whitelist-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.whitelist-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  background: #16213e;
  border: 1px solid #333;
  border-radius: 6px;
}
.whitelist-origin {
  font-size: 12px;
  color: #ccc;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.whitelist-remove-btn {
  position: static;
  transform: none;
  font-size: 11px;
  color: #888;
  padding: 2px 6px;
}
.whitelist-remove-btn:hover {
  color: #f44336;
  opacity: 1;
}
```

**Step 4: 動作確認**

ポップアップを開いて UI レイアウトが崩れていないことを確認（まだボタンは非表示）

**Step 5: コミット**

```bash
git add popup.html popup.css
git commit -m "feat: popup にホワイトリスト UI（現在のサイト＋カスタムサイト一覧）を追加"
```

---

## Task 9: popup.js — ホワイトリストロジック

**Files:**
- Modify: `popup.js`

**Step 1: ファイル先頭付近に変数を追加**

`let isPulling = false;` の直後に追加:

```js
let currentOrigin = null;
let currentTabId = null;
```

**Step 2: `initCurrentSite` 関数を追加**

`PROVIDER_CONFIG` 定義の前に追加:

```js
async function initCurrentSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    currentOrigin = url.origin;
    currentTabId = tab.id;

    $('currentSiteHost').textContent = url.hostname;

    const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
    const isWhitelisted = whitelist.includes(currentOrigin);
    const btn = $('toggleSiteBtn');
    btn.textContent = isWhitelisted ? 'このサイトを無効化' : 'このサイトで翻訳を有効化';
    btn.className = isWhitelisted ? 'btn-secondary' : 'btn-primary';
    btn.style.display = '';
    $('currentSiteSection').style.display = '';
  } catch { /* 無効なURLは無視 */ }
}

async function loadWhitelistUI() {
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  const ul = $('whitelistItems');
  ul.innerHTML = '';
  if (whitelist.length === 0) {
    $('whitelistSection').style.display = 'none';
    return;
  }
  $('whitelistSection').style.display = '';
  whitelist.forEach(origin => {
    const li = document.createElement('li');
    li.className = 'whitelist-item';
    const span = document.createElement('span');
    span.className = 'whitelist-origin';
    span.textContent = origin.replace(/^https?:\/\//, '');
    const btn = document.createElement('button');
    btn.className = 'btn-icon whitelist-remove-btn';
    btn.title = '削除';
    btn.textContent = '✕';
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'REMOVE_FROM_WHITELIST', origin });
      await loadWhitelistUI();
      if (origin === currentOrigin) await initCurrentSite();
    });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}
```

**Step 3: `DOMContentLoaded` ハンドラー内に呼び出しを追加**

`popup.js` の `document.addEventListener('DOMContentLoaded', async () => {` 内の先頭（`const settings = await ...` の前）に追加:

```js
  await initCurrentSite();
  await loadWhitelistUI();
```

**Step 4: `toggleSiteBtn` のイベントリスナーを追加**

`DOMContentLoaded` の中、`$('apiProvider').addEventListener(...)` の直前に追加:

```js
  // 現在のサイト 有効化/無効化ボタン
  $('toggleSiteBtn').addEventListener('click', async () => {
    if (!currentOrigin) return;
    const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
    const isWhitelisted = whitelist.includes(currentOrigin);

    if (isWhitelisted) {
      await chrome.runtime.sendMessage({ type: 'REMOVE_FROM_WHITELIST', origin: currentOrigin });
      showStatus('このサイトを無効化しました', 'ok');
    } else {
      // chrome.permissions.request はユーザージェスチャー（クリック）内で直接呼ぶ必要あり
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [currentOrigin + '/*'] });
      } catch (err) {
        showStatus('権限の取得に失敗しました: ' + err.message, 'err');
        return;
      }
      if (!granted) {
        showStatus('権限が拒否されました', 'err');
        return;
      }
      await chrome.runtime.sendMessage({ type: 'ADD_TO_WHITELIST', origin: currentOrigin, tabId: currentTabId });
      showStatus('このサイトで翻訳を有効化しました', 'ok');
    }

    await initCurrentSite();
    await loadWhitelistUI();
  });
```

**Step 5: 動作確認**

1. chrome://extensions でリロード
2. 未登録のサイト（例: `https://readcomiconline.li`）でポップアップを開く
3. 「このサイトで翻訳を有効化」ボタンが表示されることを確認
4. クリック → 権限ダイアログが出ることを確認
5. 承認 → ボタンが「このサイトを無効化」に変わることを確認
6. ポップアップを閉じて再度開く → カスタムサイトセクションにオリジンが表示されることを確認
7. 右クリックメニュー「Doug: このサイトで翻訳 ON/OFF」で同様に動作確認
8. タブを閉じて再訪問 → 翻訳オーバーレイが自動で出ることを確認
9. 削除ボタン（✕）で削除 → 次回訪問では注入されないことを確認

**Step 6: コミット**

```bash
git add popup.js
git commit -m "feat: popup.js にホワイトリスト有効化/無効化ロジックを追加"
```

---

## Task 10: バージョン更新

**Files:**
- Modify: `manifest.json`

**Step 1: バージョンを更新**

```diff
- "version": "1.4.0",
+ "version": "1.5.0",
```

**Step 2: コミット**

```bash
git add manifest.json
git commit -m "chore: バージョンを1.5.0に更新（ホワイトリスト機能追加）"
```

---

## 完了チェックリスト

- [ ] content.js に二重注入ガードがある
- [ ] manifest.json に scripting / contextMenus / tabs / optional_host_permissions がある
- [ ] background.js で isSiteAllowed がホワイトリストキャッシュを参照している
- [ ] ポップアップからサイトを追加できる（権限ダイアログ→即時注入）
- [ ] 右クリックメニューからサイトを追加/削除できる
- [ ] タブを再訪問すると自動で content.js が注入される
- [ ] ポップアップのカスタムサイト一覧から削除できる
- [ ] 削除後は次回訪問で注入されない
