# モデル選択機能 設計ドキュメント

**日付**: 2026-02-20
**ステータス**: 承認済み

## 概要

Gemini・Claude・ChatGPT の各プロバイダーに対してモデル選択ドロップダウンを追加する。
現状 Ollama のみモデル選択が可能で、他プロバイダーはモデルがハードコードされている。

## アプローチ

各プロバイダーのセクション内に `<select>` を追加する（Ollama と同じパターン）。

## 変更ファイル

### popup.html

- `#geminiKeySection` 末尾に `<select id="geminiModel">` を追加（5モデル）
- `#claudeKeySection` 末尾に `<select id="claudeModel">` を追加（3モデル）
- `#openaiKeySection` 末尾に `<select id="openaiModel">` を追加（2モデル）

### popup.js

- `chrome.storage.local.get()` のデフォルト値に3キーを追加
- DOMContentLoaded で各 select に値をセット
- saveBtn click ハンドラで3値を保存

### background.js

- `SETTINGS_DEFAULTS` に3キーを追加
- `handleImageTranslation()` で設定値を各翻訳関数に渡す

## モデル一覧

### Gemini

| モデルID | 表示名 | デフォルト |
|---|---|---|
| `gemini-2.5-pro-preview` | gemini-2.5-pro（最高品質） | |
| `gemini-2.5-flash-preview` | gemini-2.5-flash（バランス） | |
| `gemini-2.5-flash-lite` | gemini-2.5-flash-lite（高速）| ✓ |
| `gemini-3.1-pro-preview` | gemini-3.1-pro-preview | |
| `gemini-3-flash-preview` | gemini-3-flash-preview | |

### Claude

| モデルID | 表示名 | デフォルト |
|---|---|---|
| `claude-opus-4-6` | claude-opus-4-6（最高品質） | |
| `claude-sonnet-4-6` | claude-sonnet-4-6（推奨） | ✓ |
| `claude-haiku-4-5-20251001` | claude-haiku-4-5（高速） | |

### ChatGPT (OpenAI)

| モデルID | 表示名 | デフォルト |
|---|---|---|
| `gpt-5.2-2025-12-11` | GPT-5.2 | ✓ |
| `gpt-5.2-pro-2025-12-11` | GPT-5.2 Pro | |

## ストレージキー

| キー | デフォルト値 |
|---|---|
| `geminiModel` | `gemini-2.5-flash-lite` |
| `claudeModel` | `claude-sonnet-4-6` |
| `openaiModel` | `gpt-5.2-2025-12-11` |
