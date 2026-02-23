// popup.js - 設定画面ロジック

const $ = (id) => document.getElementById(id);

let isPulling = false;
let currentOrigin = null;
let currentTabId = null;

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

function isValidOllamaEndpoint(url) {
  return /^https?:\/\//i.test(url);
}

async function checkOllamaStatus() {
  if (isPulling) return;
  const endpoint = ($('ollamaEndpoint').value || 'http://localhost:11434').trim();
  const model = $('ollamaModel').value;
  const statusEl = $('ollamaStatus');
  const installBtn = $('ollamaInstallBtn');
  const downloadHint = $('ollamaDownloadHint');

  statusEl.textContent = '確認中...';
  statusEl.className = 'ollama-status';
  installBtn.style.display = 'none';
  downloadHint.style.display = 'none';

  if (!isValidOllamaEndpoint(endpoint)) {
    statusEl.textContent = '⚠ エンドポイントは http:// または https:// で始まる必要があります';
    statusEl.className = 'ollama-status err';
    return;
  }

  try {
    const res = await fetch(`${endpoint}/api/tags`);
    if (res.status === 403) {
      statusEl.textContent = '⚠ Ollama のアクセス拒否 (403) — OLLAMA_ORIGINS の設定が必要です';
      statusEl.className = 'ollama-status err';
      downloadHint.innerHTML = 'ターミナルで実行して Ollama を再起動:<br><code>launchctl setenv OLLAMA_ORIGINS "*"</code>';
      downloadHint.style.display = '';
      return;
    }
    if (!res.ok) throw new Error('接続エラー');
    const data = await res.json();
    const models = data.models || [];
    // モデル名の完全一致で判定
    const installed = models.some(m => m.name === model);

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

  if (!isValidOllamaEndpoint(endpoint)) {
    showStatus('エンドポイントは http:// または https:// で始まる必要があります', 'err');
    return;
  }

  isPulling = true;
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

    if (!res.body) throw new Error('レスポンスボディが取得できません');
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
    isPulling = false;
    installBtn.disabled = false;
    // pull 失敗時はプログレスエリアを非表示に戻す
    if (progressFill.style.width !== '100%') {
      progressEl.style.display = 'none';
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await initCurrentSite();
  await loadWhitelistUI();

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

  $('apiProvider').value = settings.apiProvider;
  $('geminiApiKey').value = settings.geminiApiKey;
  $('claudeApiKey').value = settings.claudeApiKey;
  $('openaiApiKey').value = settings.openaiApiKey;
  $('geminiModel').value = settings.geminiModel;
  $('claudeModel').value = settings.claudeModel;
  $('openaiModel').value = settings.openaiModel;
  $('ollamaModel').value = settings.ollamaModel;
  $('ollamaEndpoint').value = settings.ollamaEndpoint;
  $('targetLang').value = settings.targetLang;
  $('prefetch').checked = settings.prefetch;

  updateProviderUI(settings.apiProvider);

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

    const ollamaEndpoint = ($('ollamaEndpoint').value || 'http://localhost:11434').trim();
    if (!isValidOllamaEndpoint(ollamaEndpoint)) {
      showStatus('Ollama エンドポイントは http:// または https:// で始まる必要があります', 'err');
      return;
    }

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
