// whitelist.js - ホワイトリスト（任意サイト対応）の管理

let whitelistedOrigins = new Set();

export function getWhitelistedOrigins() {
  return whitelistedOrigins;
}

export async function loadWhitelist() {
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  whitelistedOrigins = new Set(whitelist);
}

// sync ストレージ変更時にインメモリの Set を更新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.whitelist) {
    whitelistedOrigins = new Set(changes.whitelist.newValue || []);
  }
});

export async function injectToTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  } catch (err) {
    // タブが閉じられた・非対応ページの場合は静かに失敗
    console.warn('[doug] injectToTab 失敗:', err.message);
  }
}

export async function saveToWhitelist(origin, tabId) {
  // origin の形式を検証（https://example.com 形式のみ許可）
  if (typeof origin !== 'string' || !/^https?:\/\/[^/]+$/.test(origin)) return;
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  if (!whitelist.includes(origin)) {
    whitelist.push(origin);
    await chrome.storage.sync.set({ whitelist });
    // storage.onChanged がキャッシュを更新する
  }
  // リロードで tabs.onUpdated → injectToTab の確実な経路を使う
  if (tabId != null) await chrome.tabs.reload(tabId);
}

export async function removeFromWhitelist(origin) {
  try {
    await chrome.permissions.remove({ origins: [origin + '/*'] });
  } catch { /* 権限がない場合は無視 */ }
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  await chrome.storage.sync.set({ whitelist: whitelist.filter(o => o !== origin) });
  // 無効化されたオリジンのタブにteardownを通知
  try {
    const tabs = await chrome.tabs.query({ url: origin + '/*' });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'SITE_DISABLED' }).catch(() => {});
    }
  } catch { /* タブが見つからない場合は無視 */ }
}
