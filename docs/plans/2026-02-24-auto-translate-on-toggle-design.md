# 自動翻訳トグルON時の即時翻訳 設計ドキュメント

**日付**: 2026-02-24
**対象ファイル**: `content.js`

## 課題

自動翻訳トグルをONにしても、現在のページは翻訳されない。
翻訳が走るのはページ遷移・DOM変化が発生したときのみ。

## 設計

### 変更対象

`toggleAutoTranslate` 関数（`content.js:1034`）

### 変更内容

トグルをONにした直後、以下の条件を両方満たす場合に `scheduleAutoTranslate()` を呼ぶ：

- `!overlayContainer`：翻訳オーバーレイがひとつも表示されていない
- `!isTranslating`：現在翻訳処理が動いていない

### 実装差分

```diff
 function toggleAutoTranslate() {
   autoTranslate = !autoTranslate;
   const btn = document.getElementById('mut-btn-auto');
   if (!btn) return;
   btn.classList.toggle('mut-btn-active', autoTranslate);
   btn.title = autoTranslate ? '自動翻訳: ON（クリックでOFF）' : '自動翻訳: OFF（クリックでON）';
+  if (autoTranslate && !overlayContainer && !isTranslating) {
+    scheduleAutoTranslate();
+  }
 }
```

## 動作フロー

1. ユーザーが自動翻訳ボタンをクリック → `autoTranslate = true`
2. 条件チェック: 未翻訳かつ非翻訳中であれば
3. `scheduleAutoTranslate()` → 600ms後に `translateCurrentPage()` 実行
4. OFFにした時・既に翻訳済みの時は何もしない（副作用なし）

## 考慮事項

- 既存の `scheduleAutoTranslate()` を再利用することで、600ms の画像ロード待機が維持される
- 変更は3行のみ、既存ロジックへの影響なし
- OFFへの切り替え時は条件 `autoTranslate` が false になるため実行されない
