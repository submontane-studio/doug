# Ollama プロバイダー追加設計

**日付**: 2026-02-18
**ブランチ**: feature/ollama-provider
**対象モデル**: Qwen3-VL（推奨）、Gemma3

---

## 目的

クラウドAPIに依存せず、ローカルで動作するOllamaを翻訳プロバイダーとして追加する。
コミック画像はローカルで完結し、外部送信ゼロを実現する。

---

## 変更ファイル

| ファイル | 変更概要 |
|---------|---------|
| `manifest.json` | `host_permissions` に `http://localhost:11434/*` 追加 |
| `background.js` | Ollama翻訳・状態確認・pull関数を追加、プロバイダー分岐拡張 |
| `popup.html` | Ollamaセクション追加（モデルselect、エンドポイント入力、状態表示、pullボタン） |
| `popup.js` | Ollama状態チェック・pull進捗・保存/読み込みロジック追加 |

---

## 設定キー

```javascript
// chrome.storage.local に追加
ollamaModel:    'qwen3-vl:8b'             // 選択中モデル
ollamaEndpoint: 'http://localhost:11434'  // Ollamaエンドポイント
```

---

## popup UI フロー

### ① Ollama 未起動

```
⚠ Ollama が起動していません
[Ollama をダウンロード]  → https://ollama.com を新タブで開く
```

### ② 起動中 / モデル未インストール

```
✓ Ollama 起動中
モデル: [qwen3-vl:8b ▼]
[qwen3-vl:8b をインストール]
→ クリック後: ▓▓▓░░░░░░░ 42%  2.3 GB / 5.4 GB
```

### ③ 起動中 / モデル準備完了

```
✓ Ollama 起動中  ✓ qwen3-vl:8b 準備完了
モデル: [qwen3-vl:8b ▼]
エンドポイント: [http://localhost:11434]
```

---

## モデル選択肢

| モデル名 | サイズ目安 | 用途 |
|---------|-----------|------|
| `qwen3-vl:8b` | ~5.4GB | 推奨・高品質 |
| `qwen3-vl:4b` | ~3.2GB | バランス |
| `qwen3-vl:2b` | ~1.8GB | 軽量 |
| `gemma3:12b` | ~8.1GB | Google製・高品質 |
| `gemma3:4b` | ~3.3GB | Google製・軽量 |

---

## background.js 追加関数

### `translateImageWithOllama(endpoint, model, imageData, prompt)`

```
POST {endpoint}/api/chat
{
  "model": "<model>",
  "messages": [{
    "role": "user",
    "content": "<prompt>",
    "images": ["<base64_without_prefix>"]
  }],
  "stream": false
}
→ response.message.content をパース
```

- base64のdata URLプレフィックス（`data:image/jpeg;base64,`）を除去して送信
- レスポンスは既存の `parseVisionResponse()` で処理（共通）

### `checkOllamaStatus(endpoint, model)`

```
GET {endpoint}/api/tags
→ { models: [{ name, ... }] }
→ 対象モデルがリストに含まれるか確認
```

戻り値:
```javascript
{ running: true, modelInstalled: true }
{ running: true, modelInstalled: false }
{ running: false }
```

### `pullOllamaModel(endpoint, model)`

```
POST {endpoint}/api/pull
{ "model": "<model>", "stream": true }
→ NDJSON ストリームを ReadableStream で読む
→ { status, total, completed } を都度 sendResponse で通知
```

メッセージ型: `OLLAMA_PULL_PROGRESS`
```javascript
{ type: 'OLLAMA_PULL_PROGRESS', status, total, completed, done }
```

---

## エラーハンドリング

| ケース | ユーザー向けメッセージ |
|--------|---------------------|
| Ollama 未起動（fetch失敗） | 「Ollama が起動していません。起動してから再試行してください」 |
| モデル未インストール（翻訳時） | 「モデルがインストールされていません。設定画面でインストールしてください」 |
| pull 失敗 | 「モデルのダウンロードに失敗しました: {詳細}」 |
| Ollama応答不正 | 既存の `parseVisionResponse()` のフォールバックで空配列を返す |

---

## APIキー不要の扱い

- `PROVIDER_KEY_MAP['ollama'] = null`
- `handleImageTranslation` でプロバイダーが `ollama` の場合はAPIキーチェックをスキップ
- `processPreloadQueue` でも同様にスキップ

---

## 先読み（prefetch）

- Geminiの lite モデル自動切替（`gemini-2.0-flash-lite`）は Gemini 専用のまま維持
- Ollama prefetch は同一モデルを使用（lite 切替なし）
- 推論速度がクラウドより遅いため、先読み有効時はユーザーの体感速度が落ちる可能性あり（設計上許容）

---

## セキュリティ

- `manifest.json` の `host_permissions` に `http://localhost:11434/*` を追加
- カスタムエンドポイントは host_permissions 外になる可能性があるが、Ollama はデフォルトで `Access-Control-Allow-Origin: *` を返すため Service Worker からのアクセスは可能
- コミック画像は一切外部送信されない
