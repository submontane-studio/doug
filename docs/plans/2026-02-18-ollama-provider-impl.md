# Ollama プロバイダー追加 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ollamaをローカル翻訳プロバイダーとして追加し、Qwen3-VLとGemma3を使って外部送信ゼロで翻訳できるようにする。

**Architecture:** background.js に `translateImageWithOllama()` を追加して既存のプロバイダー分岐に組み込む。popup は直接 Ollama REST API を fetch してステータス確認・モデル pull を行う（background 経由不要）。

**Tech Stack:** Chrome Extension MV3, Ollama REST API (`/api/chat`, `/api/tags`, `/api/pull`)

---

### Task 1: manifest.json に localhost を追加

**Files:**
- Modify: `manifest.json:14`

**Step 1: host_permissions に追加**

```json
"host_permissions": [
  "https://*.marvel.com/*",
  "https://generativelanguage.googleapis.com/*",
  "https://api.anthropic.com/*",
  "https://api.openai.com/*",
  "http://localhost:11434/*"
],
```

**Step 2: 動作確認**

Chrome で `chrome://extensions` を開き、拡張機能を再読み込みしてエラーが出ないことを確認。

**Step 3: コミット**

```bash
git add manifest.json
git commit -m "feat: manifest に Ollama localhost パーミッションを追加"
```

---

### Task 2: background.js — 設定・プロバイダーマップ拡張

**Files:**
- Modify: `background.js:99-106` (SETTINGS_DEFAULTS)
- Modify: `background.js:222-223` (PROVIDER_LABELS / PROVIDER_KEY_MAP)

**Step 1: SETTINGS_DEFAULTS に Ollama 設定を追加**

`background.js:99-106` の `SETTINGS_DEFAULTS` を以下に変更:

```javascript
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

**Step 2: PROVIDER_LABELS / PROVIDER_KEY_MAP に ollama を追加**

`background.js:222-223` を以下に変更:

```javascript
const PROVIDER_LABELS = { gemini: 'Gemini', claude: 'Claude', openai: 'ChatGPT', ollama: 'Ollama' };
const PROVIDER_KEY_MAP = { gemini: 'geminiApiKey', claude: 'claudeApiKey', openai: 'openaiApiKey', ollama: null };
```

**Step 3: コミット**

```bash
git add background.js
git commit -m "feat(bg): SETTINGS_DEFAULTS と PROVIDER マップに ollama を追加"
```

---

### Task 3: background.js — translateImageWithOllama 追加

**Files:**
- Modify: `background.js:501` (OpenAI関数の直後に挿入)

**Step 1: 関数を `cleanTranslatedText` の直前（L503の前）に挿入**

```javascript
// ============================================================
// Ollama API
// ============================================================
async function translateImageWithOllama(endpoint, model, imageData, prompt) {
  // data:image/jpeg;base64, プレフィックスを除去
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');

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
    throw new Error('Ollama が起動していません。起動してから再試行してください。');
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 404) {
      throw new Error(`モデル "${model}" がインストールされていません。設定画面でインストールしてください。`);
    }
    throw new Error(`Ollama エラー (${res.status}): ${errBody.substring(0, 150)}`);
  }

  const data = await res.json();
  const content = data.message?.content;
  if (!content) throw new Error('Ollama から応答がありません');

  return parseVisionResponse(content, null);
}
```

**Step 2: コミット**

```bash
git add background.js
git commit -m "feat(bg): translateImageWithOllama 関数を追加"
```

---

### Task 4: background.js — handleImageTranslation に ollama 分岐を追加

**Files:**
- Modify: `background.js:225-269` (handleImageTranslation 関数全体)

**Step 1: 関数を以下に置き換える**

```javascript
async function handleImageTranslation(imageData, imageUrl, imageDims, options) {
  const settings = await getSettings();
  const provider = settings.apiProvider || 'gemini';

  // キャッシュ確認
  if (imageUrl) {
    const cached = await getCachedTranslation(imageUrl, settings.targetLang);
    if (cached) {
      return { translations: cached, fromCache: true };
    }
  }

  // Ollama 以外はAPIキーをチェック
  let apiKey;
  if (provider !== 'ollama') {
    apiKey = settings[PROVIDER_KEY_MAP[provider]];
    if (!apiKey) {
      return { error: `${PROVIDER_LABELS[provider]} APIキーが設定されていません。拡張機能の設定画面でAPIキーを入力してください。` };
    }
  }

  try {
    let translations;
    // 先読み時かつGeminiの場合、軽量モデルを使用
    const prefetchModel = (options?.prefetch && provider === 'gemini')
      ? 'gemini-2.0-flash-lite'
      : undefined;

    const parsed = parseImageDataUrl(imageData);
    const prompt = buildTranslationPrompt(settings.targetLang);

    if (provider === 'ollama') {
      translations = await translateImageWithOllama(
        settings.ollamaEndpoint || 'http://localhost:11434',
        settings.ollamaModel || 'qwen3-vl:8b',
        imageData,
        prompt
      );
    } else if (provider === 'claude') {
      translations = await translateImageWithClaude(apiKey, parsed, prompt, imageDims);
    } else if (provider === 'openai') {
      translations = await translateImageWithOpenAI(apiKey, imageData, prompt, imageDims);
    } else {
      translations = await translateImageWithGemini(apiKey, parsed, prompt, imageDims, prefetchModel);
    }

    if (translations.length > 0 && imageUrl) {
      await saveCachedTranslation(imageUrl, settings.targetLang, translations);
    }

    return { translations };
  } catch (err) {
    return { error: `翻訳に失敗: ${err.message}` };
  }
}
```

**Step 2: コミット**

```bash
git add background.js
git commit -m "feat(bg): handleImageTranslation に ollama プロバイダー分岐を追加"
```

---

### Task 5: background.js — processPreloadQueue の API キーチェックを修正

**Files:**
- Modify: `background.js:564-565`

**Step 1: L564-565 を以下に変更**

変更前:
```javascript
    const apiKey = settings[PROVIDER_KEY_MAP[settings.apiProvider]];
    if (!apiKey) return;
```

変更後:
```javascript
    const provider = settings.apiProvider || 'gemini';
    if (provider !== 'ollama') {
      const apiKey = settings[PROVIDER_KEY_MAP[provider]];
      if (!apiKey) return;
    }
```

**Step 2: 動作確認**

拡張機能を再読み込みし、コンソールエラーがないことを確認。

**Step 3: コミット**

```bash
git add background.js
git commit -m "fix(bg): processPreloadQueue の API キーチェックを Ollama で正しくスキップ"
```

---

### Task 6: popup.html — Ollama UI セクションを追加

**Files:**
- Modify: `popup.html:15-19` (select に option 追加)
- Modify: `popup.html:53` (openaiKeySection の直後に挿入)

**Step 1: プロバイダー select に ollama を追加**

`popup.html:15-19` の `<select id="apiProvider">` に以下を追加:

```html
      <option value="gemini">Gemini</option>
      <option value="claude">Claude</option>
      <option value="openai">ChatGPT</option>
      <option value="ollama">Ollama (ローカル)</option>
```

**Step 2: openaiKeySection の閉じタグ直後（L53 の `</div>` の後）に Ollama セクションを挿入**

```html
    <div class="section api-key-section" id="ollamaSection" style="display:none">
      <div id="ollamaStatus" class="ollama-status"></div>
      <label for="ollamaModel">モデル:</label>
      <select id="ollamaModel">
        <option value="qwen3-vl:8b">qwen3-vl:8b（推奨）</option>
        <option value="qwen3-vl:4b">qwen3-vl:4b</option>
        <option value="qwen3-vl:2b">qwen3-vl:2b</option>
        <option value="gemma3:12b">gemma3:12b</option>
        <option value="gemma3:4b">gemma3:4b</option>
      </select>
      <label for="ollamaEndpoint" style="margin-top:8px">エンドポイント:</label>
      <input type="text" id="ollamaEndpoint" placeholder="http://localhost:11434">
      <button id="ollamaInstallBtn" class="btn-secondary" style="display:none;margin-top:8px"></button>
      <div id="ollamaProgress" style="display:none;margin-top:8px">
        <div class="ollama-progress-bar">
          <div id="ollamaProgressFill" class="ollama-progress-fill"></div>
        </div>
        <div id="ollamaProgressText" class="field-hint" style="margin-top:4px"></div>
      </div>
      <div id="ollamaDownloadHint" class="field-hint" style="display:none;margin-top:8px">
        <a href="https://ollama.com/download" target="_blank">Ollama をダウンロード</a>してから起動してください
      </div>
    </div>
```

**Step 3: コミット**

```bash
git add popup.html
git commit -m "feat(popup): Ollama UI セクションを追加"
```

---

### Task 7: popup.css — Ollama ステータス・プログレスバーのスタイルを追加

**Files:**
- Modify: `popup.css` (末尾に追記)

**Step 1: popup.css の末尾に追加**

```css
/* Ollama ステータス */
.ollama-status { font-size: 12px; margin-bottom: 8px; min-height: 16px; }
.ollama-status.ok   { color: #4caf50; }
.ollama-status.warn { color: #ff9800; }
.ollama-status.err  { color: #f44336; }

/* Ollama プログレスバー */
.ollama-progress-bar {
  height: 6px;
  background: rgba(255,255,255,0.15);
  border-radius: 3px;
  overflow: hidden;
}
.ollama-progress-fill {
  height: 100%;
  width: 0%;
  background: #4caf50;
  border-radius: 3px;
  transition: width 0.3s ease;
}
```

**Step 2: コミット**

```bash
git add popup.css
git commit -m "feat(popup): Ollama ステータス・プログレスバーのスタイルを追加"
```

---

### Task 8: popup.js — Ollama 対応を全面追加

**Files:**
- Modify: `popup.js` (全体を置き換え)

**Step 1: popup.js 全体を以下に置き換える**

```javascript
// popup.js - 設定画面ロジック

const $ = (id) => document.getElementById(id);

const PROVIDER_CONFIG = {
  gemini: { section: 'geminiKeySection', keyId: 'geminiApiKey', pattern: /^AIza[0-9A-Za-z_-]{30,256}$/, hint: 'Gemini APIキーは "AIza" で始まる39文字程度の英数字です' },
  claude: { section: 'claudeKeySection', keyId: 'claudeApiKey', pattern: /^sk-ant-[0-9A-Za-z_-]{20,256}$/, hint: 'Claude APIキーは "sk-ant-" で始まる英数字です' },
  openai: { section: 'openaiKeySection', keyId: 'openaiApiKey', pattern: /^sk-[0-9A-Za-z_-]{20,256}$/, hint: 'OpenAI APIキーは "sk-" で始まる英数字です' },
  ollama: { section: 'ollamaSection', keyId: null, pattern: null, hint: null },
};

function updateProviderUI(provider) {
  Object.values(PROVIDER_CONFIG).forEach(c => {
    $(c.section).style.display = 'none';
  });
  const config = PROVIDER_CONFIG[provider];
  if (config) {
    $(config.section).style.display = '';
  }
  if (provider === 'ollama') {
    checkOllamaStatus();
  }
}

async function checkOllamaStatus() {
  const endpoint = ($('ollamaEndpoint').value || 'http://localhost:11434').trim();
  const model = $('ollamaModel').value;
  const statusEl = $('ollamaStatus');
  const installBtn = $('ollamaInstallBtn');
  const downloadHint = $('ollamaDownloadHint');

  statusEl.textContent = '確認中...';
  statusEl.className = 'ollama-status';
  installBtn.style.display = 'none';
  downloadHint.style.display = 'none';

  try {
    const res = await fetch(`${endpoint}/api/tags`);
    if (!res.ok) throw new Error('接続エラー');
    const data = await res.json();
    const models = data.models || [];
    // モデル名の前方一致で判定（:タグ違いも許容）
    const installed = models.some(m => m.name === model || m.name.startsWith(model.split(':')[0] + ':'));

    if (installed) {
      statusEl.textContent = `✓ Ollama 起動中 / ✓ ${model} 準備完了`;
      statusEl.className = 'ollama-status ok';
    } else {
      statusEl.textContent = `✓ Ollama 起動中 / ${model} 未インストール`;
      statusEl.className = 'ollama-status warn';
      installBtn.textContent = `${model} をインストール`;
      installBtn.style.display = '';
    }
  } catch {
    statusEl.textContent = '⚠ Ollama が起動していません';
    statusEl.className = 'ollama-status err';
    downloadHint.style.display = '';
  }
}

async function pullModel() {
  const endpoint = ($('ollamaEndpoint').value || 'http://localhost:11434').trim();
  const model = $('ollamaModel').value;
  const progressEl = $('ollamaProgress');
  const progressFill = $('ollamaProgressFill');
  const progressText = $('ollamaProgressText');
  const installBtn = $('ollamaInstallBtn');

  installBtn.disabled = true;
  progressEl.style.display = '';
  progressFill.style.width = '0%';
  progressText.textContent = 'ダウンロード準備中...';

  try {
    const res = await fetch(`${endpoint}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value, { stream: true }).split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.total && obj.completed) {
            const pct = Math.round((obj.completed / obj.total) * 100);
            progressFill.style.width = pct + '%';
            const gb = (obj.total / 1e9).toFixed(1);
            const doneGb = (obj.completed / 1e9).toFixed(1);
            progressText.textContent = `${doneGb} GB / ${gb} GB (${pct}%)`;
          } else if (obj.status) {
            progressText.textContent = obj.status;
          }
        } catch { /* NDJSON の不完全行は無視 */ }
      }
    }

    progressFill.style.width = '100%';
    progressText.textContent = 'インストール完了！';
    installBtn.style.display = 'none';
    await checkOllamaStatus();
  } catch (err) {
    showStatus(`インストールに失敗しました: ${err.message}`, 'err');
  } finally {
    installBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
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

  $('apiProvider').value = settings.apiProvider;
  $('geminiApiKey').value = settings.geminiApiKey;
  $('claudeApiKey').value = settings.claudeApiKey;
  $('openaiApiKey').value = settings.openaiApiKey;
  $('ollamaModel').value = settings.ollamaModel;
  $('ollamaEndpoint').value = settings.ollamaEndpoint;
  $('targetLang').value = settings.targetLang;
  $('prefetch').checked = settings.prefetch;

  updateProviderUI(settings.apiProvider);

  // プロバイダー切替
  $('apiProvider').addEventListener('change', () => {
    updateProviderUI($('apiProvider').value);
  });

  // APIキー表示/非表示トグル
  document.querySelectorAll('.toggle-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // Ollama: モデル変更・エンドポイント変更で再チェック
  $('ollamaModel').addEventListener('change', checkOllamaStatus);
  $('ollamaEndpoint').addEventListener('blur', checkOllamaStatus);

  // Ollama: インストールボタン
  $('ollamaInstallBtn').addEventListener('click', pullModel);

  // 保存ボタン
  $('saveBtn').addEventListener('click', async () => {
    const provider = $('apiProvider').value;

    // Ollama 以外は API キーをバリデーション
    if (provider !== 'ollama') {
      const config = PROVIDER_CONFIG[provider];
      const apiKey = $(config.keyId).value.trim();
      if (!apiKey) {
        showStatus('APIキーを入力してください', 'err');
        return;
      }
      if (config.pattern && !config.pattern.test(apiKey)) {
        showStatus(config.hint, 'err');
        return;
      }
    }

    await chrome.storage.local.set({
      apiProvider: provider,
      geminiApiKey: $('geminiApiKey').value.trim(),
      claudeApiKey: $('claudeApiKey').value.trim(),
      openaiApiKey: $('openaiApiKey').value.trim(),
      ollamaModel: $('ollamaModel').value,
      ollamaEndpoint: ($('ollamaEndpoint').value || 'http://localhost:11434').trim(),
      targetLang: $('targetLang').value,
      prefetch: $('prefetch').checked,
    });
    showStatus('設定を保存しました', 'ok');
  });

  // キャッシュクリアボタン
  $('clearCacheBtn').addEventListener('click', async () => {
    const allData = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(allData).filter(key => key.startsWith('cache:'));
    if (cacheKeys.length === 0) {
      showStatus('キャッシュはありません', 'ok');
      return;
    }
    await chrome.storage.local.remove(cacheKeys);
    showStatus(`${cacheKeys.length}件のキャッシュを削除しました`, 'ok');
  });
});

function showStatus(msg, type) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = type === 'err' ? '#f44336' : '#4caf50';
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 5000);
}
```

**Step 2: コミット**

```bash
git add popup.js
git commit -m "feat(popup): Ollama ステータスチェック・モデル pull・設定保存を実装"
```

---

### Task 9: 手動動作確認

**確認手順:**

1. Chrome で `chrome://extensions` → 拡張機能を再読み込み
2. popup を開き、プロバイダーを「Ollama (ローカル)」に切り替える

**Ollama 未起動の場合:**
- `⚠ Ollama が起動していません` と表示される
- 「Ollama をダウンロード」リンクが表示される

**Ollama 起動済み・モデルなしの場合:**
- `✓ Ollama 起動中 / qwen3-vl:8b 未インストール` と表示
- 「qwen3-vl:8b をインストール」ボタンが表示される
- ボタンを押すとプログレスバーが進む

**Ollama 起動済み・モデルインストール済みの場合:**
- `✓ Ollama 起動中 / ✓ qwen3-vl:8b 準備完了` と表示
- 保存ボタンでエラーなく保存できる
- Marvel Unlimited で翻訳ボタンを押すと翻訳が動作する

---

### Task 10: 最終コミット・プッシュ

```bash
git log --oneline feature/ollama-provider ^master
# 全コミットを確認

git push -u origin feature/ollama-provider
```
