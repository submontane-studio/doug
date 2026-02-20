# モデル選択機能 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Gemini・Claude・ChatGPT の各プロバイダーにモデル選択ドロップダウンを追加し、ユーザーが使用モデルを切り替えられるようにする。

**Architecture:** 各プロバイダーのセクション内に `<select>` を追加（Ollama と同じパターン）。設定を `chrome.storage.local` に保存し、background.js の翻訳関数に渡す。

**Tech Stack:** Vanilla JS, Chrome Extension Manifest V3, chrome.storage.local

---

### Task 1: popup.html にモデル選択 `<select>` を追加

**Files:**
- Modify: `popup.html`（`#geminiKeySection`, `#claudeKeySection`, `#openaiKeySection` 各セクション内）

**Step 1: `#geminiKeySection` の `</div>` 閉じタグ直前（APIキーの `field-hint` の後）にモデル選択を追加**

対象箇所（現在の `#geminiKeySection` の末尾部分）:
```html
      <div class="field-hint">
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">APIキーを取得</a>（無料枠あり）
      </div>
    </div>
```

変更後:
```html
      <div class="field-hint">
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">APIキーを取得</a>（無料枠あり）
      </div>
      <label for="geminiModel" style="margin-top:8px">モデル:</label>
      <select id="geminiModel">
        <option value="gemini-2.5-pro-preview">gemini-2.5-pro-preview（最高品質）</option>
        <option value="gemini-2.5-flash-preview">gemini-2.5-flash-preview（バランス）</option>
        <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite（高速）</option>
        <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
        <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
      </select>
    </div>
```

**Step 2: `#claudeKeySection` の `</div>` 閉じタグ直前に追加**

対象箇所（現在の `#claudeKeySection` の末尾部分）:
```html
      <div class="field-hint">
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">APIキーを取得</a>
      </div>
    </div>
```

変更後:
```html
      <div class="field-hint">
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">APIキーを取得</a>
      </div>
      <label for="claudeModel" style="margin-top:8px">モデル:</label>
      <select id="claudeModel">
        <option value="claude-opus-4-6">claude-opus-4-6（最高品質）</option>
        <option value="claude-sonnet-4-6">claude-sonnet-4-6（推奨）</option>
        <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001（高速）</option>
      </select>
    </div>
```

**Step 3: `#openaiKeySection` の `</div>` 閉じタグ直前に追加**

対象箇所（現在の `#openaiKeySection` の末尾部分）:
```html
      <div class="field-hint">
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">APIキーを取得</a>
      </div>
    </div>
```

変更後:
```html
      <div class="field-hint">
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">APIキーを取得</a>
      </div>
      <label for="openaiModel" style="margin-top:8px">モデル:</label>
      <select id="openaiModel">
        <option value="gpt-5.2-2025-12-11">GPT-5.2</option>
        <option value="gpt-5.2-pro-2025-12-11">GPT-5.2 Pro</option>
      </select>
    </div>
```

**Step 4: 変更を確認**

Chrome拡張機能の設定ポップアップを開き、Gemini/Claude/OpenAI を選択したとき各セクションにモデル選択ドロップダウンが表示されることを確認。

**Step 5: コミット**

```bash
git add popup.html
git commit -m "feat: popup.htmlにGemini/Claude/OpenAIのモデル選択selectを追加"
```

---

### Task 2: popup.js にモデル設定の読み込み・保存を追加

**Files:**
- Modify: `popup.js`

**Step 1: `chrome.storage.local.get()` のデフォルト値に3キーを追加**

対象箇所（現在のコード）:
```js
  const settings = await chrome.storage.local.get({
    apiProvider: 'gemini',
    geminiApiKey: '',
    claudeApiKey: '',
    openaiApiKey: '',
    ollamaModel: 'qwen3-vl:8b',
    ollamaEndpoint: 'http://localhost:11434',
    targetLang: 'ja',
    prefetch: true,
  });
```

変更後:
```js
  const settings = await chrome.storage.local.get({
    apiProvider: 'gemini',
    geminiApiKey: '',
    claudeApiKey: '',
    openaiApiKey: '',
    geminiModel: 'gemini-2.5-flash-lite',
    claudeModel: 'claude-sonnet-4-6',
    openaiModel: 'gpt-5.2-2025-12-11',
    ollamaModel: 'qwen3-vl:8b',
    ollamaEndpoint: 'http://localhost:11434',
    targetLang: 'ja',
    prefetch: true,
  });
```

**Step 2: DOMContentLoaded 内で各 select に値をセット**

対象箇所（`$('ollamaModel').value = settings.ollamaModel;` の前後）:
```js
  $('ollamaModel').value = settings.ollamaModel;
```

変更後（この行の前に追加）:
```js
  $('geminiModel').value = settings.geminiModel;
  $('claudeModel').value = settings.claudeModel;
  $('openaiModel').value = settings.openaiModel;
  $('ollamaModel').value = settings.ollamaModel;
```

**Step 3: saveBtn の `chrome.storage.local.set()` に3キーを追加**

対象箇所（現在の set 呼び出し）:
```js
    await chrome.storage.local.set({
      apiProvider: provider,
      geminiApiKey: $('geminiApiKey').value.trim(),
      claudeApiKey: $('claudeApiKey').value.trim(),
      openaiApiKey: $('openaiApiKey').value.trim(),
      ollamaModel: $('ollamaModel').value,
      ollamaEndpoint,
      targetLang: $('targetLang').value,
      prefetch: $('prefetch').checked,
    });
```

変更後:
```js
    await chrome.storage.local.set({
      apiProvider: provider,
      geminiApiKey: $('geminiApiKey').value.trim(),
      claudeApiKey: $('claudeApiKey').value.trim(),
      openaiApiKey: $('openaiApiKey').value.trim(),
      geminiModel: $('geminiModel').value,
      claudeModel: $('claudeModel').value,
      openaiModel: $('openaiModel').value,
      ollamaModel: $('ollamaModel').value,
      ollamaEndpoint,
      targetLang: $('targetLang').value,
      prefetch: $('prefetch').checked,
    });
```

**Step 4: コミット**

```bash
git add popup.js
git commit -m "feat: popup.jsにGemini/Claude/OpenAIモデル設定の読み込み・保存を追加"
```

---

### Task 3: background.js にモデル設定の利用を追加

**Files:**
- Modify: `background.js`

**Step 1: `SETTINGS_DEFAULTS` に3キーを追加**

対象箇所（現在のコード）:
```js
const SETTINGS_DEFAULTS = {
  apiProvider: 'gemini',
  geminiApiKey: '',
  claudeApiKey: '',
  openaiApiKey: '',
  ollamaModel: 'qwen3-vl:8b',
  ollamaEndpoint: 'http://localhost:11434',
  targetLang: 'ja',
  prefetch: true,
};
```

変更後:
```js
const SETTINGS_DEFAULTS = {
  apiProvider: 'gemini',
  geminiApiKey: '',
  claudeApiKey: '',
  openaiApiKey: '',
  geminiModel: 'gemini-2.5-flash-lite',
  claudeModel: 'claude-sonnet-4-6',
  openaiModel: 'gpt-5.2-2025-12-11',
  ollamaModel: 'qwen3-vl:8b',
  ollamaEndpoint: 'http://localhost:11434',
  targetLang: 'ja',
  prefetch: true,
};
```

**Step 2: `handleImageTranslation()` の Gemini 呼び出しでモデルを渡す**

対象箇所（現在のコード）:
```js
    const prefetchModel = undefined;

    // parseは1回だけ実行して各API関数に渡す
    const parsed = parseImageDataUrl(imageData);
    const prompt = buildTranslationPrompt(settings.targetLang);

    if (provider === 'ollama') {
      translations = await translateImageWithOllama(
        settings.ollamaEndpoint || 'http://localhost:11434',
        settings.ollamaModel || 'qwen3-vl:8b',
        imageData,
        prompt,
        imageDims
      );
    } else if (provider === 'claude') {
      translations = await translateImageWithClaude(apiKey, parsed, prompt, imageDims);
    } else if (provider === 'openai') {
      translations = await translateImageWithOpenAI(apiKey, imageData, prompt, imageDims);
    } else {
      translations = await translateImageWithGemini(apiKey, parsed, prompt, imageDims, prefetchModel);
    }
```

変更後（`prefetchModel` 行を削除し、各呼び出しにモデルを渡す）:
```js
    // parseは1回だけ実行して各API関数に渡す
    const parsed = parseImageDataUrl(imageData);
    const prompt = buildTranslationPrompt(settings.targetLang);

    if (provider === 'ollama') {
      translations = await translateImageWithOllama(
        settings.ollamaEndpoint || 'http://localhost:11434',
        settings.ollamaModel || 'qwen3-vl:8b',
        imageData,
        prompt,
        imageDims
      );
    } else if (provider === 'claude') {
      translations = await translateImageWithClaude(apiKey, parsed, prompt, imageDims, settings.claudeModel);
    } else if (provider === 'openai') {
      translations = await translateImageWithOpenAI(apiKey, imageData, prompt, imageDims, settings.openaiModel);
    } else {
      translations = await translateImageWithGemini(apiKey, parsed, prompt, imageDims, settings.geminiModel);
    }
```

**Step 3: `translateImageWithClaude()` でモデル引数を使う**

対象箇所（現在の関数シグネチャと model 定義）:
```js
async function translateImageWithClaude(apiKey, parsed, prompt, imageDims) {
  const { mimeType, base64Data } = parsed;

  const url = 'https://api.anthropic.com/v1/messages';
  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
```

変更後:
```js
async function translateImageWithClaude(apiKey, parsed, prompt, imageDims, model) {
  const { mimeType, base64Data } = parsed;

  const url = 'https://api.anthropic.com/v1/messages';
  const body = JSON.stringify({
    model: model || 'claude-sonnet-4-6',
```

**Step 4: `translateImageWithOpenAI()` でモデル引数を使う**

対象箇所（現在の関数シグネチャと model 定義）:
```js
async function translateImageWithOpenAI(apiKey, imageDataUrl, prompt, imageDims) {

  const url = 'https://api.openai.com/v1/chat/completions';
  const body = JSON.stringify({
    model: 'gpt-4o',
```

変更後:
```js
async function translateImageWithOpenAI(apiKey, imageDataUrl, prompt, imageDims, model) {

  const url = 'https://api.openai.com/v1/chat/completions';
  const body = JSON.stringify({
    model: model || 'gpt-5.2-2025-12-11',
```

**Step 5: 動作確認**

1. Chrome で拡張機能をリロード（`chrome://extensions` → 更新ボタン）
2. ポップアップを開き、各プロバイダーを選択してモデル選択が表示されることを確認
3. モデルを選んで「保存」→ ポップアップを再開して選択が保持されることを確認
4. Marvel Unlimited でコミックを開き、翻訳が正常に動作することを確認

**Step 6: コミット**

```bash
git add background.js
git commit -m "feat: background.jsでGemini/Claude/OpenAIのモデルを設定から取得するよう変更"
```
