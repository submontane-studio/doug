// popup.js - ポップアップUI（サイト操作・言語設定）

const $ = (id) => document.getElementById(id);

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

document.addEventListener('DOMContentLoaded', async () => {
  await initCurrentSite();

  const { targetLang = 'ja' } = await chrome.storage.local.get({ targetLang: 'ja' });
  $('targetLang').value = targetLang;

  // 詳細設定を開く
  $('openOptionsBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  });

  // 現在のサイト 有効化/無効化ボタン
  $('toggleSiteBtn').addEventListener('click', async () => {
    if (!currentOrigin) return;
    const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
    const isWhitelisted = whitelist.includes(currentOrigin);

    if (isWhitelisted) {
      await chrome.runtime.sendMessage({ type: 'REMOVE_FROM_WHITELIST', origin: currentOrigin });
      showStatus('このサイトを無効化しました', 'ok');
      await initCurrentSite();
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

  // 翻訳先言語：変更時に即保存
  $('targetLang').addEventListener('change', async () => {
    await chrome.storage.local.set({ targetLang: $('targetLang').value });
    showStatus('言語を変更しました', 'ok');
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
