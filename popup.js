// popup.js - 設定画面ロジック

const $ = (id) => document.getElementById(id);

const PROVIDER_CONFIG = {
  gemini: { section: 'geminiKeySection', keyId: 'geminiApiKey', pattern: /^AIza[0-9A-Za-z_-]{30,}$/, hint: 'Gemini APIキーは "AIza" で始まる必要があります' },
  claude: { section: 'claudeKeySection', keyId: 'claudeApiKey', pattern: /^sk-ant-/, hint: 'Claude APIキーは "sk-ant-" で始まる必要があります' },
  openai: { section: 'openaiKeySection', keyId: 'openaiApiKey', pattern: /^sk-/, hint: 'OpenAI APIキーは "sk-" で始まる必要があります' },
};

function updateProviderUI(provider) {
  // すべてのAPIキーセクションを非表示
  Object.values(PROVIDER_CONFIG).forEach(c => {
    $(c.section).style.display = 'none';
  });
  // 選択されたプロバイダーのセクションを表示
  const config = PROVIDER_CONFIG[provider];
  if (config) {
    $(config.section).style.display = '';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.local.get({
    apiProvider: 'gemini',
    geminiApiKey: '',
    claudeApiKey: '',
    openaiApiKey: '',
    targetLang: 'ja',
    prefetch: true,
  });

  $('apiProvider').value = settings.apiProvider;
  $('geminiApiKey').value = settings.geminiApiKey;
  $('claudeApiKey').value = settings.claudeApiKey;
  $('openaiApiKey').value = settings.openaiApiKey;
  $('targetLang').value = settings.targetLang;
  $('prefetch').checked = settings.prefetch;

  updateProviderUI(settings.apiProvider);

  // プロバイダー切替
  $('apiProvider').addEventListener('change', () => {
    updateProviderUI($('apiProvider').value);
  });

  // APIキー表示/非表示トグル（全トグルボタン共通）
  document.querySelectorAll('.toggle-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // 保存ボタン
  $('saveBtn').addEventListener('click', async () => {
    const provider = $('apiProvider').value;
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
    await chrome.storage.local.set({
      apiProvider: provider,
      geminiApiKey: $('geminiApiKey').value.trim(),
      claudeApiKey: $('claudeApiKey').value.trim(),
      openaiApiKey: $('openaiApiKey').value.trim(),
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
