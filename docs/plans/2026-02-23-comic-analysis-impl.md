# コミック解析付きホワイトリスト登録 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** ホワイトリスト登録時にスクリーンショットをAIで解析し、コミックページなら自動登録、違えばユーザーに選択肢を提示する

**Architecture:** popup.js からスクリーンショット取得+AI判定を background.js に依頼（`ANALYZE_SITE` メッセージ）。判定に使うモデルは現在選択プロバイダーの最軽量モデルを使用。判定結果に応じてポップアップ内UIを切り替える。

**Tech Stack:** chrome.tabs.captureVisibleTab, 既存の各AI API関数群（Gemini/Claude/OpenAI/Ollama）

---

## 現状の確認事項

- `fetchWithRetry(url, options, providerName)` — background.js 545行目付近に定義済み
- `parseImageDataUrl(imageDataUrl)` — background.js 490行目付近に定義済み（→ `{mimeType, base64Data}` を返す）
- `getSettings()` — background.js 287行目付近に定義済み（storage.local から全設定を返す）
- Ollama の応答は `data.message?.content`（`/api/chat` エンドポイント）
- Claude ヘッダーに `'anthropic-dangerous-direct-browser-access': 'true'` が必要

---

## Task 1: background.js — getLightestModel + 各API テキスト取得関数 + analyzeScreenshot

**Files:**
- Modify: `background.js`（`translateImageWithOllama` 関数の直後に追加）

**Step 1: 以下を `translateImageWithOllama` の閉じ括弧 `}` の直後に挿入**

```js
// ============================================================
// コミック解析（ホワイトリスト登録前の事前判定）
// ============================================================

// 現在選択中プロバイダーの最軽量モデルを返す
function getLightestModel(settings) {
  const p = settings.apiProvider;
  if (p === 'gemini' && settings.geminiApiKey)
    return { provider: 'gemini', apiKey: settings.geminiApiKey, model: 'gemini-2.0-flash-lite' };
  if (p === 'claude' && settings.claudeApiKey)
    return { provider: 'claude', apiKey: settings.claudeApiKey, model: 'claude-haiku-4-5-20251001' };
  if (p === 'openai' && settings.openaiApiKey)
    return { provider: 'openai', apiKey: settings.openaiApiKey, model: 'gpt-4o-mini' };
  if (p === 'ollama')
    return { provider: 'ollama', endpoint: settings.ollamaEndpoint || 'http://localhost:11434', model: settings.ollamaModel };
  return null;
}

// 各API：画像を送ってテキスト応答を得る（YES/NO判定用）
async function callGeminiText(apiKey, parsed, prompt, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts: [
      { inline_data: { mime_type: parsed.mimeType, data: parsed.base64Data } },
      { text: prompt },
    ]}],
    generationConfig: { temperature: 0, maxOutputTokens: 10 },
  });
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body,
  }, 'Gemini');
  if (!res.ok) throw new Error(`Gemini API エラー (${res.status})`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callClaudeText(apiKey, parsed, prompt, model) {
  const url = 'https://api.anthropic.com/v1/messages';
  const body = JSON.stringify({
    model,
    max_tokens: 10,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: parsed.mimeType, data: parsed.base64Data } },
      { type: 'text', text: prompt },
    ]}],
  });
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body,
  }, 'Claude');
  if (!res.ok) throw new Error(`Claude API エラー (${res.status})`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function callOpenAIText(apiKey, imageDataUrl, prompt, model) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = JSON.stringify({
    model,
    max_tokens: 10,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: imageDataUrl } },
      { type: 'text', text: prompt },
    ]}],
  });
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body,
  }, 'ChatGPT');
  if (!res.ok) throw new Error(`OpenAI API エラー (${res.status})`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callOllamaText(endpoint, model, imageDataUrl, prompt) {
  const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
  let res;
  try {
    res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt, images: [base64Data] }],
        stream: false,
      }),
    });
  } catch {
    throw new Error('Ollama が起動していません');
  }
  if (!res.ok) throw new Error(`Ollama エラー (${res.status})`);
  const data = await res.json();
  return data.message?.content || '';
}

// スクリーンショットを撮ってAIにコミック判定させる
async function analyzeScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });

  const settings = await getSettings();
  const modelInfo = getLightestModel(settings);
  if (!modelInfo) throw new Error('利用可能なAIプロバイダーがありません。設定画面でAPIキーを入力してください。');

  const prompt = 'この画像はコミックまたはマンガのページですか？吹き出しやセリフが含まれていますか？"YES"または"NO"のみで答えてください。';
  const parsed = parseImageDataUrl(dataUrl);

  let answer;
  if (modelInfo.provider === 'gemini') {
    answer = await callGeminiText(modelInfo.apiKey, parsed, prompt, modelInfo.model);
  } else if (modelInfo.provider === 'claude') {
    answer = await callClaudeText(modelInfo.apiKey, parsed, prompt, modelInfo.model);
  } else if (modelInfo.provider === 'openai') {
    answer = await callOpenAIText(modelInfo.apiKey, dataUrl, prompt, modelInfo.model);
  } else {
    answer = await callOllamaText(modelInfo.endpoint, modelInfo.model, dataUrl, prompt);
  }

  return { isComic: /yes/i.test(answer) };
}
```

**Step 2: 動作確認**

chrome://extensions の「Service Worker の詳細」→ コンソールでエラーなし

**Step 3: コミット**

```bash
git add background.js
git commit -m "feat: コミック解析用 getLightestModel / callXxxText / analyzeScreenshot を追加"
```

---

## Task 2: background.js — ANALYZE_SITE メッセージハンドラー追加

**Files:**
- Modify: `background.js`（onMessage 内の `GET_WHITELIST` ブロックの直後に追加）

**Step 1: `GET_WHITELIST` ブロック（`return true; }` の閉じ）の直後に挿入**

```js
  if (message.type === 'ANALYZE_SITE') {
    analyzeScreenshot(message.tabId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
```

**Step 2: コミット**

```bash
git add background.js
git commit -m "feat: background.js に ANALYZE_SITE メッセージハンドラーを追加"
```

---

## Task 3: popup.html + popup.css — 解析結果UI追加

**Files:**
- Modify: `popup.html`
- Modify: `popup.css`

**Step 1: popup.html の `currentSiteSection` div の閉じタグ `</div>` の直後に挿入**

```html
    <div id="analyzeResultSection" class="section" style="display:none">
      <p id="analyzeResultMsg" class="field-hint" style="margin-bottom:8px"></p>
      <div class="analyze-actions">
        <button id="forceRegisterBtn" class="btn-secondary">解析を無視して登録</button>
        <button id="cancelRegisterBtn" class="btn-secondary">キャンセル</button>
      </div>
    </div>
```

**Step 2: popup.css 末尾に追加**

```css
/* 解析結果アクションボタン */
.analyze-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.analyze-actions .btn-secondary {
  flex: 1;
  padding: 7px 6px;
  font-size: 11px;
}
```

**Step 3: コミット**

```bash
git add popup.html popup.css
git commit -m "feat: popup に解析結果UI（解析を無視して登録／キャンセル）を追加"
```

---

## Task 4: popup.js — toggleSiteBtn を解析フロー対応に変更

**Files:**
- Modify: `popup.js`

**Step 1: 既存の `toggleSiteBtn` クリックハンドラー全体を以下で置き換える**

現在の該当箇所（`$('toggleSiteBtn').addEventListener('click', async () => {` から始まる約25行）を以下に置き換え:

```js
  // 現在のサイト 有効化/無効化ボタン
  $('toggleSiteBtn').addEventListener('click', async () => {
    if (!currentOrigin) return;
    const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
    const isWhitelisted = whitelist.includes(currentOrigin);

    if (isWhitelisted) {
      await chrome.runtime.sendMessage({ type: 'REMOVE_FROM_WHITELIST', origin: currentOrigin });
      showStatus('このサイトを無効化しました', 'ok');
      await initCurrentSite();
      await loadWhitelistUI();
      return;
    }

    // 権限取得（ユーザージェスチャー内で直接呼ぶ必要あり）
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

    // 解析中表示
    const btn = $('toggleSiteBtn');
    btn.textContent = '解析中...';
    btn.disabled = true;

    let isComic = false;
    let analyzeErrorMsg = null;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'ANALYZE_SITE', tabId: currentTabId });
      if (result.error) throw new Error(result.error);
      isComic = result.isComic;
    } catch (err) {
      analyzeErrorMsg = err.message;
    }

    btn.textContent = 'このサイトで翻訳を有効化';
    btn.disabled = false;

    if (isComic) {
      // YES → 自動登録
      await chrome.runtime.sendMessage({ type: 'ADD_TO_WHITELIST', origin: currentOrigin, tabId: currentTabId });
      showStatus('このサイトで翻訳を有効化しました', 'ok');
      await initCurrentSite();
      await loadWhitelistUI();
    } else {
      // NO or エラー → 選択肢を表示
      $('analyzeResultMsg').textContent = analyzeErrorMsg
        ? `解析中にエラーが発生しました: ${analyzeErrorMsg}`
        : 'コミックページが検出されませんでした。';
      $('analyzeResultSection').style.display = '';
      btn.style.display = 'none';
    }
  });

  // 解析を無視して登録ボタン
  $('forceRegisterBtn').addEventListener('click', async () => {
    $('analyzeResultSection').style.display = 'none';
    $('toggleSiteBtn').style.display = '';
    await chrome.runtime.sendMessage({ type: 'ADD_TO_WHITELIST', origin: currentOrigin, tabId: currentTabId });
    showStatus('このサイトで翻訳を有効化しました', 'ok');
    await initCurrentSite();
    await loadWhitelistUI();
  });

  // キャンセルボタン
  $('cancelRegisterBtn').addEventListener('click', async () => {
    $('analyzeResultSection').style.display = 'none';
    $('toggleSiteBtn').style.display = '';
    // 取得した権限を解放
    try {
      await chrome.permissions.remove({ origins: [currentOrigin + '/*'] });
    } catch { /* 無視 */ }
    showStatus('キャンセルしました', 'ok');
  });
```

**Step 2: 動作確認**

1. chrome://extensions でリロード
2. 未登録の普通のWebページ（例: google.com）でポップアップを開く
3. 「このサイトで翻訳を有効化」クリック → 権限ダイアログ → 承認
4. ボタンが「解析中...」になることを確認（1〜2秒）
5. 「コミックページが検出されませんでした。」と「解析を無視して登録」「キャンセル」が出ることを確認
6. 「キャンセル」を押すと元のボタンに戻ることを確認
7. 「解析を無視して登録」を押すと登録されることを確認
8. コミックサイト（例: readcomiconline.li）で同じ操作 → 自動登録されることを確認（YES判定）

**Step 3: コミット**

```bash
git add popup.js
git commit -m "feat: popup.js のホワイトリスト登録にコミック解析フローを追加"
```

---

## Task 5: バージョン更新

**Files:**
- Modify: `manifest.json`

**Step 1: バージョンを更新**

```diff
- "version": "1.5.0",
+ "version": "1.5.1",
```

**Step 2: コミット**

```bash
git add manifest.json
git commit -m "chore: バージョンを1.5.1に更新（コミック解析機能追加）"
```

---

## 完了チェックリスト

- [ ] `getLightestModel` が現在選択中プロバイダーのAPIキーを確認して最軽量モデルを返す
- [ ] `analyzeScreenshot` が captureVisibleTab → AI判定 → `{ isComic: boolean }` を返す
- [ ] `ANALYZE_SITE` メッセージハンドラーが background.js の onMessage 内にある
- [ ] popup に `analyzeResultSection`（解析を無視して登録 / キャンセル）が追加されている
- [ ] YES判定時は自動登録（ポップアップは登録完了表示のまま）
- [ ] NO判定時は選択肢が表示され、「解析を無視して登録」で登録、「キャンセル」で権限解放
- [ ] 解析エラー時もNOと同じ選択肢が表示（エラーメッセージ付き）
