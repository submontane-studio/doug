// background.js - Service Worker エントリポイント・イベントリスナー

import { isSiteAllowed as _isSiteAllowedPure, isAllowedImageUrl } from './utils/url-utils.js';
import { SETTINGS_DEFAULTS, invalidateSettingsCache } from './settings.js';
import { CACHE_AFFECTING_KEYS, cleanOldCache } from './cache.js';
import { cropScreenshot } from './image.js';
import { fetchImageAsDataUrl } from './image.js';
import {
  loadWhitelist, getWhitelistedOrigins,
  saveToWhitelist, removeFromWhitelist, injectToTab,
} from './whitelist.js';
import { handleImageTranslation, analyzeScreenshot } from './translate.js';
import { handlePreloadQueue } from './preload.js';

// ============================================================
// マイグレーション: sync → local への移行
// ============================================================
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadWhitelist();
  createContextMenu();
  if (details.reason === 'install' || details.reason === 'update') {
    try {
      const syncData = await chrome.storage.sync.get(['apiKey', 'apiProvider', 'targetLang']);
      if (syncData.apiKey || syncData.apiProvider || syncData.targetLang) {
        // 旧 apiKey → プロバイダーに応じた新キーに変換
        if (syncData.apiKey) {
          const provider = syncData.apiProvider || 'gemini';
          const keyMap = { gemini: 'geminiApiKey', claude: 'claudeApiKey', openai: 'openaiApiKey' };
          syncData[keyMap[provider] || 'geminiApiKey'] = syncData.apiKey;
          delete syncData.apiKey;
        }
        await chrome.storage.local.set(syncData);
        await chrome.storage.sync.remove(['apiKey', 'apiProvider', 'targetLang']);
      }
    } catch (err) {
      console.error('設定の移行に失敗:', err);
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadWhitelist();
  createContextMenu();
});

// 設定変更時にキャッシュを無効化
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    const settingKeys = Object.keys(SETTINGS_DEFAULTS);
    if (settingKeys.some(key => key in changes)) {
      invalidateSettingsCache();
    }
    // プロバイダー・モデル・言語が変わったら古い翻訳キャッシュを整理
    if (CACHE_AFFECTING_KEYS.some(key => key in changes)) {
      cleanOldCache().catch(() => {});
    }
  }
});

// ============================================================
// Port通信ハンドラー（TRANSLATE_IMAGE: 長時間処理のためタイムアウトなしのPortを使用）
// ============================================================
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name !== 'translate') return;
  const sender = port.sender;
  if (sender.id !== chrome.runtime.id) { port.disconnect(); return; }
  if (getWhitelistedOrigins().size === 0) await loadWhitelist();
  if (sender.tab && !_isSiteAllowedPure(sender.tab.url, getWhitelistedOrigins())) { port.disconnect(); return; }

  let portDisconnected = false;
  port.onDisconnect.addListener(() => { portDisconnected = true; void chrome.runtime.lastError; });

  port.onMessage.addListener(async (message) => {
    if (message.type !== 'TRANSLATE_IMAGE') return;
    try {
      const result = await handleImageTranslation(
        message.imageData,
        message.imageUrl,
        message.imageDims,
        { forceRefresh: !!message.forceRefresh }
      );
      if (!portDisconnected) port.postMessage(result);
    } catch (err) {
      if (!portDisconnected) port.postMessage({ error: err.message });
    }
  });
});

// ============================================================
// メッセージハンドラー
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 送信元検証: 自拡張IDを確認（同期・高速パス）
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: '不正な送信元です' });
    return false;
  }

  // Service Worker再起動後にwhitelistedOriginsが空になる場合を考慮して非同期で処理
  (async () => {
    if (getWhitelistedOrigins().size === 0) await loadWhitelist();
    // タブからのメッセージはホワイトリスト登録済みドメインのみ許可
    // sender.tabがない場合 = popup等の拡張内ページ（自拡張IDチェックで十分）
    if (sender.tab && !_isSiteAllowedPure(sender.tab.url, getWhitelistedOrigins())) {
      sendResponse({ error: '不正な送信元です' });
      return;
    }

    if (message.type === 'KEEP_ALIVE') {
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'FETCH_IMAGE') {
      if (!isAllowedImageUrl(message.url)) {
        sendResponse({ error: '許可されていない画像URLです' });
        return;
      }
      try {
        const imageData = await fetchImageAsDataUrl(message.url);
        sendResponse({ imageData });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }

    // CAPTURE_REGION: content.js が FETCH_IMAGE で SecurityError を受け取った場合のフォールバック。
    // captureVisibleTab は「<all_urls> 権限」または「能動的な activeTab」が必要。
    // ホスト権限（例: comicbookplus.com/*）だけでは不十分なため、
    // popup.js で *://*/* 権限を取得してからこのハンドラーが有効になる。
    // フロー: content.js SecurityError → CAPTURE_REGION → captureVisibleTab + OffscreenCanvas クロップ
    if (message.type === 'CAPTURE_REGION') {
      if (!sender.tab) {
        sendResponse({ error: 'タブ情報が取得できません' });
        return;
      }
      try {
        const screenshotData = await chrome.tabs.captureVisibleTab(
          sender.tab.windowId,
          { format: 'jpeg', quality: 92 }
        );
        const imageData = message.elementRect
          ? await cropScreenshot(screenshotData, message.elementRect)
          : screenshotData;
        sendResponse({ imageData });
      } catch (err) {
        console.warn('[doug] CAPTURE_REGION 失敗:', err.message);
        sendResponse({ error: `スクリーンキャプチャに失敗しました: ${err.message}` });
      }
      return;
    }

    if (message.type === 'PRELOAD_QUEUE') {
      handlePreloadQueue(message.imageUrls, sender.tab?.id);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'ADD_TO_WHITELIST') {
      // chrome.permissions.request は popup.js 側で完了済み
      try {
        await saveToWhitelist(message.origin, message.tabId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }

    if (message.type === 'REMOVE_FROM_WHITELIST') {
      try {
        await removeFromWhitelist(message.origin);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }

    if (message.type === 'GET_WHITELIST') {
      try {
        const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
        sendResponse({ whitelist });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }

    if (message.type === 'ANALYZE_SITE') {
      try {
        const result = await analyzeScreenshot(message.tabId);
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }
  })();
  return true; // 非同期応答のためチャネルを保持
});

// ============================================================
// ホワイトリストサイトへの自動注入（次回訪問時）
// ============================================================
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;
  try {
    // Service Worker 中間起動時に whitelistedOrigins が空になる場合を考慮して復元
    if (getWhitelistedOrigins().size === 0) await loadWhitelist();
    const origin = new URL(tab.url).origin;
    if (!getWhitelistedOrigins().has(origin)) return;
    await injectToTab(tabId);
  } catch { /* 無効なURL等は無視 */ }
});

// ============================================================
// コンテキストメニュー（右クリック: このサイトで翻訳 ON/OFF）
// ============================================================
function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'doug-toggle-site',
      title: 'Doug: このサイトで翻訳 ON/OFF',
      contexts: ['page'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'doug-toggle-site') return;
  if (!tab?.url) return;
  try {
    const origin = new URL(tab.url).origin;
    if (['chrome:', 'chrome-extension:', 'about:'].includes(new URL(tab.url).protocol)) return;
    if (getWhitelistedOrigins().has(origin)) {
      await removeFromWhitelist(origin);
    } else {
      const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (granted) await saveToWhitelist(origin, tab.id);
    }
  } catch (err) {
    console.error('[doug] コンテキストメニュー処理エラー:', err.message);
  }
});
