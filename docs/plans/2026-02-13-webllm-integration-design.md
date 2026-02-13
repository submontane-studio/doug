# WebLLM統合設計書

**作成日:** 2026-02-13
**対象:** Marvel Unlimited Translator Chrome拡張機能
**目的:** クラウドAPIをWebLLMに完全置き換え、ブラウザ内ローカル翻訳を実現

---

## 概要

既存のクラウドAPI（OpenAI/Anthropic/Gemini）を削除し、WebLLMによるブラウザ内ローカル翻訳に完全移行する。Phi-3.5-Vision-Instructモデルを使用して、OCR + bbox検出 + 翻訳を一括処理する。

---

## 要件

### 確定した要件

1. **完全置き換え**: クラウドAPIオプションを削除、WebLLMのみで動作
2. **使用モデル**: Phi-3.5-Vision-Instruct (4.2B, 2.4GB)
3. **処理方式**: WebLLMでOCR + bbox + 翻訳を一括処理
4. **初期化タイミング**: 初回翻訳実行時に自動ダウンロード、進捗表示あり

### 期待効果

- **コスト**: 完全無料（API料金ゼロ）
- **プライバシー**: 画像データが外部送信されない
- **速度**: キャッシュヒット時は即座に表示（<1秒）
- **トレードオフ**: 初回ダウンロード時間（2-3分）、推論時間（20-30秒）

---

## アーキテクチャ

### 全体構成

```
┌─────────────────────────────────────────────────────┐
│ Marvel Unlimited (Webページ)                        │
│  ┌───────────────────────────────────────────┐     │
│  │ content.js (Content Script)               │     │
│  │  - 翻訳ボタン表示                          │     │
│  │  - 画像キャプチャ                          │     │
│  │  - オーバーレイ描画                        │     │
│  │  - 進捗表示 "モデルロード中... 45%"        │     │
│  └───────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────┘
                     ↕ chrome.runtime.sendMessage
┌─────────────────────────────────────────────────────┐
│ background.js (Service Worker)                      │
│  ┌───────────────────────────────────────────┐     │
│  │ WebLLM Engine                             │     │
│  │  - Phi-3.5-Vision-Instruct                │     │
│  │  - モデル初期化（初回のみ、2.4GB DL）     │     │
│  │  - 推論実行（OCR+bbox+翻訳）              │     │
│  │  - 進捗通知                                │     │
│  └───────────────────────────────────────────┘     │
│                                                      │
│  - キャッシュ管理 (chrome.storage.local)            │
│  - メッセージハンドリング                            │
└─────────────────────────────────────────────────────┘
                     ↕ CDN (esm.sh)
┌─────────────────────────────────────────────────────┐
│ @mlc-ai/web-llm (WebLLM ライブラリ)                │
│  - 動的import                                        │
│  - WebGPU/WebAssembly でモデル実行                  │
└─────────────────────────────────────────────────────┐
```

### アプローチ: Service Worker統合 + CDN

- **配置場所**: background.js (Service Worker)
- **依存関係**: CDN（esm.sh）から動的import
- **既存コード**: OpenAI/Anthropic/Gemini関数を削除、WebLLM専用に書き換え

**選択理由:**
- 既存アーキテクチャを最大限維持
- 実装コストが最小
- Service Workerは長時間処理に適している
- CDNから自動取得、バージョン管理不要

---

## コンポーネント設計

### background.js

#### WebLLMマネージャー

```javascript
class WebLLMManager {
  constructor() {
    this.engine = null;
    this.isInitialized = false;
    this.isInitializing = false;
    this.initProgress = 0;
  }

  async initialize(progressCallback) {
    // 初回のみ実行
    // 1. WebLLMライブラリを動的import
    // 2. CreateMLCEngine() でモデル初期化
    // 3. 進捗を progressCallback で通知（0-100%）
    // 4. IndexedDBに自動キャッシュ
  }

  async translate(imageBase64, targetLang) {
    // 推論実行
    // 1. プロンプト構築
    // 2. engine.chat.completions.create() 呼び出し
    // 3. JSON応答をパース（既存のparseAIResponse流用）
  }
}
```

#### メッセージハンドラー

- **TRANSLATE_PAGE**: 翻訳リクエスト
  - キャッシュチェック → ヒットなら即座に返す
  - WebLLM未初期化なら初期化開始（進捗通知）
  - 推論実行 → キャッシュ保存 → 返却

- **GET_INIT_PROGRESS**: 進捗取得（content.jsからポーリング）

#### キャッシュ機能

既存のキャッシュロジックを維持:
- キー: `cache:${urlHash}:${targetLang}` (apiProviderを削除)
- TTL: 30日
- 容量管理: 9MB超過で古いキャッシュを削除

### content.js

#### 進捗表示の追加

- 翻訳ボタンクリック時に進捗バーを表示
- background.jsから進捗を500msごとに取得
- 表示例: 「モデルをダウンロード中... 45%」「翻訳中...」

#### 既存機能の維持

- 画像キャプチャ
- オーバーレイ描画
- ツールバーUI
- すべて変更なし

### popup.html/popup.js

#### 削除

- APIプロバイダー選択ドロップダウン
- APIキー入力欄
- APIキーテストボタン
- chrome.storage関連のロジック（APIキー保存）

#### 維持

- 翻訳先言語の選択（日本語、韓国語など）

#### 追加

- モデル情報表示: 「使用モデル: Phi-3.5-Vision (2.4GB)」
- キャッシュクリアボタン（オプション）

### manifest.json

#### CSP (Content Security Policy) の調整

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' https://esm.sh; object-src 'self'"
}
```

esm.sh からのスクリプト読み込みを許可。

#### 権限

既存の permissions で十分（追加不要）:
- `activeTab`
- `storage`

---

## データフロー

### 初回翻訳時（モデル未初期化）

```
1. ユーザーが翻訳ボタンをクリック
   ↓
2. content.js: 画像をキャプチャ → background.jsへ送信
   chrome.runtime.sendMessage({
     type: 'TRANSLATE_PAGE',
     imageData: 'data:image/jpeg;base64,...',
     imageUrl: 'https://...'
   })
   ↓
3. background.js: キャッシュチェック → ミス
   ↓
4. background.js: WebLLM未初期化を検出
   → WebLLMManager.initialize() 開始
   ↓
5. 進捗通知ループ開始:
   background.js → content.js
   "initProgress: 12%" → 進捗バー更新
   "initProgress: 45%" → 進捗バー更新
   ...
   "initProgress: 100%" → "翻訳中..." に切り替え
   ↓
6. 初期化完了 → 推論実行（20-30秒）
   engine.chat.completions.create()
   ↓
7. JSON応答をパース → キャッシュ保存
   ↓
8. content.jsへ返却
   { translations: [...], fromCache: false }
   ↓
9. content.js: オーバーレイ描画
```

### 2回目以降（モデル初期化済み + キャッシュミス）

```
1-2. [同上]
   ↓
3. background.js: キャッシュチェック → ミス
   ↓
4. WebLLM初期化済み → すぐに推論実行（20-30秒）
   ↓
5. 結果をキャッシュ保存 → 返却
   ↓
6. content.js: オーバーレイ描画
```

### 2回目以降（キャッシュヒット）

```
1-2. [同上]
   ↓
3. background.js: キャッシュチェック → ヒット！
   ↓
4. 即座に返却（<100ms）
   { translations: [...], fromCache: true }
   ↓
5. content.js: オーバーレイ描画
   通知 "X件のテキストを表示しました（キャッシュ）"
```

### メッセージ構造

**TRANSLATE_PAGE リクエスト:**
```javascript
{
  type: 'TRANSLATE_PAGE',
  imageData: 'data:image/jpeg;base64,...',
  imageUrl: 'https://i.annihil.us/...'
}
```

**レスポンス:**
```javascript
{
  translations: [
    { bbox: {top, left, width, height}, original: "...", translated: "...", type: "speech" }
  ],
  fromCache: true/false,
  initProgress: 45  // 初期化中の場合のみ
}
```

---

## エラーハンドリング

### 1. WebLLMの初期化失敗

**エラー例:**
- WebGPU非対応ブラウザ
- モデルダウンロード失敗（ネットワークエラー）
- メモリ不足

**対処:**
```javascript
try {
  await webllmManager.initialize(progressCallback);
} catch (err) {
  return {
    error: `モデルの初期化に失敗しました: ${err.message}

ヒント:
- WebGPU対応ブラウザが必要です（Chrome 113+）
- 安定したネットワーク接続を確認してください
- メモリ不足の場合、他のタブを閉じてください`
  };
}
```

content.jsで通知表示（赤色、10秒表示）

### 2. 推論中のエラー

**エラー例:**
- タイムアウト（60秒超過）
- メモリ不足でクラッシュ
- 不正なJSON応答

**対処:**
```javascript
const INFERENCE_TIMEOUT = 60000; // 60秒

const timeoutPromise = new Promise((_, reject) =>
  setTimeout(() => reject(new Error('推論がタイムアウトしました')), INFERENCE_TIMEOUT)
);

const result = await Promise.race([
  webllmManager.translate(imageBase64, targetLang),
  timeoutPromise
]);
```

### 3. JSONパースエラー

既存の `parseAIResponse()` を流用:
- マークダウンコードブロック除去
- 配列形式チェック
- 必須フィールド検証

### 4. キャッシュエラー

- 失敗しても翻訳自体は成功として扱う
- コンソールに警告ログ出力
- 次回は古いキャッシュを自動削除

### 5. Service Workerの30秒制限

**対処:**
- WebLLM推論中はService Workerがアクティブなので問題なし
- 初期化中もメッセージパッシングで継続
- `chrome.runtime.onMessage` で自動起動

---

## パフォーマンス最適化

### モデルの永続化

WebLLMは初回ダウンロード後、モデルをIndexedDBにキャッシュ:
- 2回目以降の起動は数秒（ダウンロード不要）
- ブラウザを閉じても永続化
- 手動削除しない限り残る

### 推論の最適化

1. **画像サイズの制限**: MAX_DIM = 2000px（既存）
2. **プロンプトの簡潔化**: WebLLM向けに最適化
3. **max_tokens**: 1500（既存のまま）

### メモリ管理

- Phi-3.5-Vision: 約3-4GB（推論時のピーク）
- モデルは一度だけ読み込み、使い回す
- Service Worker停止後も、次回起動時に数秒で再初期化

### キャッシュ戦略

- 同じページは即座に表示（推論なし）
- TTL: 30日
- 容量管理: 9MB超過で自動削除

### 進捗表示の最適化

- 初期化中: 500msごとに進捗取得
- 推論中: スピナー表示のみ

---

## UI/UX設計

### 進捗表示

**初回翻訳時（モデル初期化）:**
```
┌─────────────────────────────────────────┐
│  Marvel Unlimited Translator            │
│                                         │
│  モデルをダウンロード中...              │
│  ━━━━━━━━━━━━━━━━━━━━  45%            │
│  (残り約90秒)                           │
│                                         │
│  Phi-3.5-Vision (2.4GB)                │
│  ※初回のみ、次回からは数秒で起動します  │
└─────────────────────────────────────────┘
```

**推論中:**
```
┌─────────────────────────────────────────┐
│  翻訳中...                              │
│  ⟳ (スピナー)                          │
└─────────────────────────────────────────┘
```

### popup.html の簡略化

**変更後:**
```
┌─────────────────────────────────┐
│ Marvel Unlimited Translator     │
├─────────────────────────────────┤
│ 使用モデル:                     │
│ Phi-3.5-Vision (2.4GB)          │
│ ローカル実行・完全無料          │
│                                 │
│ 翻訳先言語:                     │
│ [▼ 日本語  ▼]                  │
│ [保存]                          │
│                                 │
│ [キャッシュをクリア]            │
└─────────────────────────────────┘
```

### エラー表示

**初期化失敗（10秒表示）:**
```
❌ モデルの初期化に失敗しました

エラー: WebGPU is not supported

解決方法:
• Chrome 113以降を使用してください
• chrome://flags で WebGPU を有効化
• ネットワーク接続を確認してください
```

**推論失敗（5秒表示）:**
```
⚠ 翻訳に失敗しました
もう一度お試しください
```

### 既存UIの維持

以下は変更なし:
- 翻訳ボタン（ツールバー）
- 表示/非表示ボタン
- クリアボタン
- オーバーレイのスタイル
- ドラッグ可能なツールバー

---

## ユーザー体験のタイムライン

### 初回使用

1. 拡張機能をインストール（即座に完了）
2. Marvel Unlimitedでコミックを開く
3. 翻訳ボタンをクリック
4. 「モデルをダウンロード中... 45%」（2-3分待機）
5. 「翻訳中...」（20-30秒待機）
6. 翻訳オーバーレイ表示

### 2回目以降

1. 翻訳ボタンをクリック
2. 「翻訳中...」（20-30秒待機）
3. 翻訳オーバーレイ表示

### キャッシュヒット時

1. 翻訳ボタンをクリック
2. 即座に翻訳オーバーレイ表示（<1秒）

---

## 実装規模の見積もり

### 変更ファイル

| ファイル | 変更量 | 内容 |
|---------|--------|------|
| background.js | 約200行変更 | WebLLMマネージャー追加、既存API削除 |
| content.js | 約50行追加 | 進捗表示ロジック追加 |
| content.css | 約30行追加 | 進捗バースタイル |
| popup.html | 約20行削減 | APIキー欄削除、モデル情報追加 |
| popup.js | 約50行削減 | APIキー保存ロジック削除 |
| manifest.json | 約5行追加 | CSP調整 |

### 実装期間

- 実装: 4-6時間
- テスト: 2-3時間
- ドキュメント: 1時間

**合計: 1日**

---

## リスクと対策

### リスク1: WebGPU非対応環境

**影響:** ユーザーが拡張機能を使用できない

**対策:**
- エラーメッセージで明確に案内
- Chrome 113+ を推奨として明示
- 将来的にWebAssembly fallback を検討

### リスク2: 推論精度の低下

**影響:** クラウドAPIより翻訳品質が劣る可能性

**対策:**
- プロンプトチューニングで精度向上
- ユーザーフィードバックを収集
- 必要に応じて別モデルに切り替え（Llama-3.2-11B-Vision）

### リスク3: 初回ダウンロード時間

**影響:** 初回ユーザー体験が悪化

**対策:**
- 進捗表示で不安を軽減
- 「次回からは数秒」と明示
- 代替案: 軽量モデル（Qwen2-VL-2B）も検討

### リスク4: メモリ不足

**影響:** 低スペックPCで動作しない

**対策:**
- エラーメッセージで「他のタブを閉じる」を案内
- 推奨スペックを明示（8GB RAM以上）

---

## 次のステップ

1. **実装計画の作成** (`writing-plans` スキルを使用)
2. **実装**
3. **テスト**
4. **ドキュメント更新**（README.md）

---

## 承認

この設計は 2026-02-13 にユーザーによって承認されました。
