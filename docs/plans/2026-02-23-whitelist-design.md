# ホワイトリスト機能 設計ドキュメント

**日付**: 2026-02-23
**バージョン**: v1.5.0 対象
**ステータス**: 承認済み

---

## 概要

現在の Doug は `manifest.json` にハードコードされた特定サイト（Marvel Unlimited, Kindle, Comic Book Plus）のみ対応している。本機能は、ユーザーが任意のコミックサイトをポップアップまたは右クリックメニューから登録し、翻訳を有効化できるホワイトリスト管理機能を追加する。

---

## 要件

| 項目 | 決定事項 |
|------|---------|
| 追加トリガー | ポップアップのボタン + 右クリックコンテキストメニュー（両方） |
| 登録スコープ | オリジン単位（`https://example.com`） |
| 保存先 | `chrome.storage.sync`（デバイス間同期） |
| 注入タイミング | 即時注入（登録直後） + 次回以降の訪問時に自動注入 |
| 権限方式 | per-origin 動的権限（`chrome.permissions.request`） |

---

## アーキテクチャ

### 権限モデル

Manifest V3 の動的権限（Optional Host Permissions）を利用する。

- `manifest.json` の `optional_host_permissions` に `"*://*/*"` を追加（per-origin 動的権限の親宣言として必須）
- 各サイト登録時に `chrome.permissions.request({ origins: ['https://example.com/*'] })` を呼び出し
- Chrome の標準権限ダイアログでユーザーが承認 → 以降はそのオリジンへのアクセス権を保持

### インメモリキャッシュ

Service Worker は随時停止・再起動するため、`storage.sync` から都度読み出すのを避けるためにインメモリキャッシュを使用する。

```
whitelistedOrigins: Set<string>
  - onInstalled / onStartup で storage.sync から復元
  - storage.onChanged で差分更新
```

### データフロー

```
① サイト追加（popup）
  ユーザークリック
  → popup.js: chrome.permissions.request({ origins: [origin + '/*'] })
  → 承認後: chrome.runtime.sendMessage({ type: 'ADD_TO_WHITELIST', origin, tabId })
  → background.js: injectToTab(tabId) + storage.sync 書込み + cache 更新

② サイト追加（右クリック）
  contextMenus.onClicked
  → background.js: chrome.permissions.request({ origins: [origin + '/*'] })
  → 承認後: injectToTab(tab.id) + storage.sync 書込み + cache 更新

③ 次回訪問の自動注入
  chrome.tabs.onUpdated (status: 'complete')
  → origin が whitelistedOrigins に含まれる場合
  → chrome.scripting.executeScript (content.js + content.css)

④ サイト削除
  popup 削除ボタン
  → chrome.runtime.sendMessage({ type: 'REMOVE_FROM_WHITELIST', origin })
  → background.js: chrome.permissions.remove + storage.sync 削除 + cache 更新
```

---

## ファイル別変更

### `manifest.json`

```diff
"permissions": [
  "activeTab",
  "storage",
+ "scripting",
+ "contextMenus",
+ "tabs"
],
+ "optional_host_permissions": ["*://*/*"],
```

### `background.js`

追加・変更:
- `whitelistedOrigins: Set` のインメモリキャッシュと初期化処理
- `loadWhitelist()`: startup/install 時に storage.sync から復元
- `storage.onChanged` リスナー: whitelist 変更時にキャッシュ更新
- `isSiteAllowed(url)`: ALLOWED_SITES_RE + ホワイトリストキャッシュの複合チェック
- `addToWhitelist(origin, tabId)`: 権限取得 → inject → storage 保存
- `removeFromWhitelist(origin)`: 権限削除 → storage 削除
- `injectToTab(tabId)`: executeScript で content.js + content.css を注入
- `chrome.tabs.onUpdated` リスナー: 次回訪問時の自動注入
- `chrome.contextMenus` の作成（install/startup）とクリックハンドラー
- メッセージハンドラー: `ADD_TO_WHITELIST`, `REMOVE_FROM_WHITELIST`, `GET_WHITELIST`

### `popup.html`

追加:
- 「現在のサイト」セクション（上部）: 現在のドメインと有効化/無効化ボタン
- 「カスタムサイト」セクション（下部）: 登録済みオリジン一覧と削除ボタン

### `popup.js`

追加:
- `chrome.tabs.query` で現在のタブ URL を取得
- 有効化ボタン: `chrome.permissions.request` を直接呼び出し（ユーザージェスチャー必須）
- 承認後: background.js にメッセージ送信（inject + 保存）
- ホワイトリスト一覧の表示と削除操作

### `content.js`

追加:
- 先頭に二重注入ガード:
  ```js
  if (window.__dougInitialized) return;
  window.__dougInitialized = true;
  ```

---

## ストレージスキーマ

```json
// chrome.storage.sync
{
  "whitelist": ["https://readcomiconline.li", "https://example.com"]
}
```

---

## セキュリティ考慮

- `ALLOWED_SITES_RE`（静的サイト）またはホワイトリストキャッシュに含まれるオリジンのみ、翻訳リクエストを受理
- `chrome.permissions.request` は必ずユーザージェスチャーから呼び出す（popup のクリックイベント、contextMenus.onClicked）
- 権限削除時は `chrome.permissions.remove` も呼び出して実際の権限も回収する

---

## バージョン

`1.4.0` → `1.5.0`（マイナーバージョンアップ：新機能追加）
