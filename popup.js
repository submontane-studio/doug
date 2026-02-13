// popup.js - 設定画面ロジック

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  // 言語設定の読み込み
  const settings = await chrome.storage.local.get({
    targetLang: 'ja',
  });

  $('targetLang').value = settings.targetLang;

  // 保存ボタン
  $('saveBtn').addEventListener('click', async () => {
    await chrome.storage.local.set({
      targetLang: $('targetLang').value,
    });
    showStatus('設定を保存しました', 'ok');
  });

  // キャッシュクリアボタン
  $('clearCacheBtn').addEventListener('click', async () => {
    // cache: で始まるキーを全て削除
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
