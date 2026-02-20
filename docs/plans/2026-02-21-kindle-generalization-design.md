# Kindle対応 & 汎用化 設計書

作成日: 2026-02-21

## 概要

Marvel Unlimited専用だった拡張機能を汎用化し、Kindle（read.amazon.co.jp）でも動作させる。
Marvel固有のロジックを削除して「ビューポート最大画像の自動検出」方式に移行する。
Kindleではセーフモードで動作し、過度な自動処理を回避する。

---

## 方針

- サイト固有ロジック（Marvel向けSVG監視・dialog依存等）を削除し、汎用的な画像検出に統一
- KindleはBlob URL（`blob:https://read.amazon.co.jp/...`）でページ画像を表示 → Canvas変換でキャプチャ
- セーフモードを導入し、Kindleでは意図的・手動中心の挙動にする

---

## アーキテクチャ概要

```
manifest.json
  └─ content_scripts: *.marvel.com + *.amazon.co.jp + *.amazon.com

content.js（汎用化）
  ├─ 画像検出: findLargestVisibleImage()   ← Marvel固有削除
  ├─ ページ遷移: startUniversalPageWatcher()  ← SVG監視削除
  ├─ UI配置: document.body 固定            ← dialog依存削除
  └─ 先読み: サイトによって分岐
       ├─ 通常URL（Marvel）: 既存フロー（次5+前2ページ）
       └─ Blob URL（Kindle）: セーフモードフロー（次1ページ、content.js主導）

background.js
  ├─ 送信元制限: ALLOWED_SITES_RE（Marvel + Amazon）に拡張
  └─ キャッシュ:
       ├─ 通常URL: chrome.storage.local（30日TTL、従来通り）
       └─ Blob URL由来: chrome.storage.session（セッション終了で自動破棄）
```

---

## セーフモード仕様

Kindle（Blob URLのページ）では以下の挙動になる。

| 要素 | 通常モード（Marvel等） | セーフモード（Kindle） |
|---|---|---|
| 翻訳トリガー | 手動ボタン | 手動ボタン（同じ） |
| 先読みページ数 | 次5＋前2 | 次1ページのみ |
| 先読みディレイ | 4.2秒（Gemini RPM対応） | 4.2秒（同じ） |
| 先読み方法 | background.jsがURLをfetch | content.jsがCanvas→Base64→TRANSLATE_IMAGE |
| キャッシュ保存先 | chrome.storage.local（30日） | chrome.storage.session（セッション終了破棄） |
| 先読みON/OFF設定 | popup設定あり（従来はデフォルトON） | popup設定あり（デフォルトOFF） |

### セーフモードの先読みフロー（Kindle）

1. ユーザーが翻訳ボタンを押す
2. 現在ページを翻訳・表示
3. 4.2秒のディレイ
4. content.jsが「現在img要素の次のBlob URL img」を探す
5. Canvas変換してBase64を取得
6. `TRANSLATE_IMAGE` でbackground.jsに送信（既存の翻訳フロー）
7. 結果を `chrome.storage.session` にキャッシュ

---

## 変更ファイル詳細

### manifest.json

```diff
 "host_permissions": [
   "https://*.marvel.com/*",
   "https://i.annihil.us/*",
+  "https://*.amazon.co.jp/*",
+  "https://*.amazon.com/*",
   "https://generativelanguage.googleapis.com/*",
   "https://api.anthropic.com/*",
   "https://api.openai.com/*",
   "http://localhost:11434/*"
 ],
 "content_scripts": [
   {
-    "matches": ["https://*.marvel.com/*"],
+    "matches": [
+      "https://*.marvel.com/*",
+      "https://*.amazon.co.jp/*",
+      "https://*.amazon.com/*"
+    ],
     "js": ["content.js"],
     "css": ["content.css"],
     "run_at": "document_idle"
   }
 ],
```

### background.js

**送信元制限の拡張**
```js
// 変更前
const MARVEL_URL_RE = /^https:\/\/[^/]*\.marvel\.com(\/|$)/;

// 変更後
const ALLOWED_SITES_RE = /^https:\/\/([^/]*\.marvel\.com|[^/]*\.amazon\.co\.jp|[^/]*\.amazon\.com)(\/|$)/;
```

**キャッシュ分岐（Blob URL判定）**
```js
// imageUrlが "blob:" で始まる場合は chrome.storage.session を使用
function isSessionOnlyUrl(url) {
  return typeof url === 'string' && url.startsWith('blob:');
}
```

**prefetchデフォルト変更**
```js
const SETTINGS_DEFAULTS = {
  ...
  prefetch: false,  // 変更前: true
};
```

**PRELOAD_QUEUEのBlob URL除外**
```js
// handlePreloadQueue内でBlob URLをフィルタ（background.jsはfetchできない）
const normalUrls = imageUrls.filter(u => !u.startsWith('blob:'));
```

### content.js

**削除する Marvel 固有コード**
- `.rocket-reader image.pageImage` / `.rocket-reader svg.svg-el` のquerySelector
- `xlink:href` / `href` でのSVG img属性監視
- `dialog.ComicPurchasePaths__Reader` の参照
- `moveUIToReader()` / `moveUIToBody()` 関数
- `dialogObserver`（Marvelのdialog開閉監視）
- `img[src*="i.annihil.us"]` のURLフィルタ

**追加・変更する汎用コード**

`findLargestVisibleImage()`:
```
優先順位:
1. blob: で始まるsrcのimg（最大面積）
2. 通常のimg（200px以上、最大面積）
3. canvas（200px以上、最大面積）
```

`startUniversalPageWatcher()`:
```
2つの監視を並行:
1. window.addEventListener('popstate' / 'hashchange') → URL変化でclearOverlays()
2. MutationObserver → blob:imgのsrc属性変化でclearOverlays()
```

`getUIParent()`:
```js
// 常に document.body を返す（Marvel dialog依存を削除）
function getUIParent() { return document.body; }
```

`triggerPrefetch(currentImageUrl)`:
```
- Blob URLの場合: セーフモード先読みフロー（次のBlob URL imgを探してTRANSLATE_IMAGE）
- 通常URLの場合: 既存のPRELOAD_QUEUEフロー（次5+前2）
```

`perfObserver`のフィルタ:
```
- Marvel CDN（i.annihil.us）の限定フィルタを削除
- 代わりに汎用的なリソース収集（Blob URL以外の画像URLを収集）
```

### popup.html / popup.js

- 先読み設定のデフォルトを `false` に変更（既存のprefetchトグルのデフォルト値）

---

## 削除されるコード（Marvel固有）

| コード | 理由 |
|---|---|
| `MARVEL_URL_RE` | `ALLOWED_SITES_RE` に置き換え |
| `.rocket-reader image.pageImage` の検出 | 汎用検出に置き換え |
| `.rocket-reader svg.svg-el` の検出 | 汎用検出に置き換え |
| `img[src*="i.annihil.us"]` の検出 | 汎用検出に置き換え |
| `dialog.ComicPurchasePaths__Reader` 参照 | `document.body` 固定に |
| `moveUIToReader()` | 不要になる |
| `moveUIToBody()` | 不要になる |
| `dialogObserver` | 不要になる |
| SVG `xlink:href` 属性監視 | `startUniversalPageWatcher` に置き換え |

---

## エラーハンドリング

- Blob URL imgが `toDataURL()` で失敗 → 既存の `captureRasterElement()` SecurityErrorハンドリングでカバー
- 次のBlob URL imgが見つからない → セーフモード先読みをスキップ（エラー通知なし）
- Kindleでページ画像が見つからない → 既存の「コミック画像が見つかりません」通知

---

## 非対応事項（今回のスコープ外）

- Kindleでの複数ページ先読み（Blob URLのキャッシュキー問題）
- PDF.jsによるローカルPDF対応（別タスク）
- Kindle以外のサイト固有チューニング
