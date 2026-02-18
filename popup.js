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
