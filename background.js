import { normalizeImageUrl, isSessionOnlyUrl, isAllowedImageUrl, isSiteAllowed as _isSiteAllowedPure } from './utils/url-utils.js';
import { cleanTranslatedText, parseVisionResponse } from './utils/parse-utils.js';

// background.js - Gemini API テキスト翻訳 + キャッシュ管理

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30日
const CACHE_VERSION = '1.1';

// ============================================================
// ホワイトリスト（任意サイト対応）
// ============================================================
let whitelistedOrigins = new Set();

async function loadWhitelist() {
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  whitelistedOrigins = new Set(whitelist);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.whitelist) {
    whitelistedOrigins = new Set(changes.whitelist.newValue || []);
  }
});

async function injectToTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  } catch (err) {
    // タブが閉じられた・非対応ページの場合は静かに失敗
    console.warn('[doug] injectToTab 失敗:', err.message);
  }
}

async function saveToWhitelist(origin, tabId) {
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

async function removeFromWhitelist(origin) {
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

// ============================================================
// Port通信ハンドラー（TRANSLATE_IMAGE: 長時間処理のためタイムアウトなしのPortを使用）
// ============================================================
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name !== 'translate') return;
  const sender = port.sender;
  if (sender.id !== chrome.runtime.id) { port.disconnect(); return; }
  if (whitelistedOrigins.size === 0) await loadWhitelist();
  if (sender.tab && !_isSiteAllowedPure(sender.tab.url, whitelistedOrigins)) { port.disconnect(); return; }

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
    if (whitelistedOrigins.size === 0) await loadWhitelist();
    // タブからのメッセージはホワイトリスト登録済みドメインのみ許可
    // sender.tabがない場合 = popup等の拡張内ページ（自拡張IDチェックで十分）
    if (sender.tab && !_isSiteAllowedPure(sender.tab.url, whitelistedOrigins)) {
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
    if (whitelistedOrigins.size === 0) await loadWhitelist();
    const origin = new URL(tab.url).origin;
    if (!whitelistedOrigins.has(origin)) return;
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
    if (whitelistedOrigins.has(origin)) {
      await removeFromWhitelist(origin);
    } else {
      const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (granted) await saveToWhitelist(origin, tab.id);
    }
  } catch (err) {
    console.error('[doug] コンテキストメニュー処理エラー:', err.message);
  }
});

// ============================================================
// 画像fetch
// ============================================================
async function fetchImageAsDataUrl(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`画像の取得に失敗しました（ネットワークエラー）: ${err.message}`);
  }
  if (res.status === 403 || res.status === 401) {
    throw new Error(`画像へのアクセスが拒否されました（${res.status}）。認証が必要な画像の可能性があります。`);
  }
  if (!res.ok) throw new Error(`画像の取得に失敗: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const CHUNK_SIZE = 8192;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, bytes.length);
    chunks.push(String.fromCharCode(...bytes.subarray(i, end)));
  }

  const base64 = btoa(chunks.join(''));
  // image/* MIME タイプのみ許可し、パラメータ・改行を除去してインジェクションを防ぐ
  const rawContentType = res.headers.get('content-type') || 'image/jpeg';
  const mimeMatch = rawContentType.match(/^image\/[a-zA-Z0-9.+-]{1,20}/);
  const contentType = mimeMatch ? mimeMatch[0] : 'image/jpeg';
  return `data:${contentType};base64,${base64}`;
}

// captureVisibleTab のスクリーンショットを要素領域にクロップして返す
async function cropScreenshot(dataUrl, rect) {
  const { x, y, width, height, dpr = 1 } = rect;

  // data URL → Blob → ImageBitmap
  const base64 = dataUrl.split(',')[1];
  const mimeMatch = dataUrl.match(/^data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const binStr = atob(base64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const bitmap = await createImageBitmap(blob);

  // CSS座標 → デバイスピクセル座標
  const sx = Math.round(x * dpr);
  const sy = Math.round(y * dpr);
  const sw = Math.round(width * dpr);
  const sh = Math.round(height * dpr);

  // ビットマップ境界内に収める
  const bx = Math.max(0, Math.min(sx, bitmap.width - 1));
  const by = Math.max(0, Math.min(sy, bitmap.height - 1));
  const bw = Math.max(1, Math.min(sw, bitmap.width - bx));
  const bh = Math.max(1, Math.min(sh, bitmap.height - by));

  const oc = new OffscreenCanvas(bw, bh);
  const ctx = oc.getContext('2d');
  ctx.drawImage(bitmap, bx, by, bw, bh, 0, 0, bw, bh);
  bitmap.close();

  const outBlob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const buffer = await outBlob.arrayBuffer();
  const outBytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  const chunks = [];
  for (let i = 0; i < outBytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...outBytes.subarray(i, i + CHUNK)));
  }
  return `data:image/jpeg;base64,${btoa(chunks.join(''))}`;
}

// ============================================================
// 設定取得（メモリキャッシュ）
// ============================================================
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
  prefetch: false,
  imagePreprocess: true,
};
let settingsCache = null;

async function getSettings() {
  if (settingsCache) return settingsCache;
  settingsCache = await chrome.storage.local.get(SETTINGS_DEFAULTS);
  return settingsCache;
}

// 設定変更時にキャッシュを無効化
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    const settingKeys = Object.keys(SETTINGS_DEFAULTS);
    if (settingKeys.some(key => key in changes)) {
      settingsCache = null;
    }
  }
});

// ============================================================
// キャッシュ機能
// ============================================================
// Blob画像のコンテンツからSHA-256ハッシュを生成（BlobURLはページ遷移で変わるため内容で同一性を判定）
async function computeImageDataHash(imageData) {
  const base64 = imageData.indexOf(',') >= 0 ? imageData.slice(imageData.indexOf(',') + 1) : imageData;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(base64);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'img-hash:' + Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateCacheKey(imageUrl, targetLang) {
  if (!imageUrl) throw new Error('imageUrl is required');
  // トークン等を除去したURLでハッシュ生成（先読みと通常翻訳でキャッシュを共有）
  const normalized = normalizeImageUrl(imageUrl);
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `cache:${hashHex.substring(0, 32)}:${targetLang}`;
}

async function getCachedTranslation(imageUrl, targetLang) {
  const cacheKey = await generateCacheKey(imageUrl, targetLang);
  try {
    const storage = isSessionOnlyUrl(imageUrl) ? chrome.storage.session : chrome.storage.local;
    const result = await storage.get(cacheKey);
    const cached = result[cacheKey];
    if (!cached) return null;
    if (cached.version !== CACHE_VERSION) {
      await storage.remove(cacheKey);
      return null;
    }
    // sessionキャッシュはTTL不要（セッション終了で自動破棄）
    if (!isSessionOnlyUrl(imageUrl) && Date.now() - cached.timestamp > CACHE_TTL) {
      await chrome.storage.local.remove(cacheKey);
      return null;
    }
    return cached.translations;
  } catch (err) {
    console.error('キャッシュ読み込みエラー:', err);
    return null;
  }
}

async function saveCachedTranslation(imageUrl, targetLang, translations) {
  const cacheKey = await generateCacheKey(imageUrl, targetLang);
  const cacheData = { translations, timestamp: Date.now(), version: CACHE_VERSION };
  const storage = isSessionOnlyUrl(imageUrl) ? chrome.storage.session : chrome.storage.local;
  try {
    await storage.set({ [cacheKey]: cacheData });
    if (!isSessionOnlyUrl(imageUrl)) {
      const usage = await chrome.storage.local.getBytesInUse();
      if (usage > 8 * 1024 * 1024) await cleanOldCache();
    }
  } catch {
    if (!isSessionOnlyUrl(imageUrl)) {
      await cleanOldCache();
      try { await chrome.storage.local.set({ [cacheKey]: cacheData }); } catch { /* 諦める */ }
    }
  }
}

async function cleanOldCache() {
  try {
    const allData = await chrome.storage.local.get(null);
    const cacheEntries = Object.keys(allData)
      .filter(key => key.startsWith('cache:'))
      .map(key => ({ key, timestamp: allData[key].timestamp || 0 }));

    // まずTTL超過のキーを削除
    const now = Date.now();
    const expired = cacheEntries.filter(e => now - e.timestamp > CACHE_TTL).map(e => e.key);
    if (expired.length > 0) {
      await chrome.storage.local.remove(expired);
      return;
    }

    // TTL超過がなければ古い半分を削除
    const sorted = cacheEntries.sort((a, b) => a.timestamp - b.timestamp);
    const toDelete = sorted.slice(0, Math.ceil(sorted.length / 2)).map(e => e.key);
    if (toDelete.length > 0) {
      await chrome.storage.local.remove(toDelete);
    }
  } catch (err) {
    console.error('キャッシュクリーンアップエラー:', err);
  }
}

// ============================================================
// 翻訳処理（Gemini API）
// ============================================================

const LANG_NAMES = {
  ja: '日本語', ko: '韓国語', 'zh-CN': '簡体字中国語', 'zh-TW': '繁体字中国語',
  es: 'スペイン語', fr: 'フランス語', de: 'ドイツ語', pt: 'ポルトガル語',
};

const PROVIDER_LABELS = { gemini: 'Gemini', claude: 'Claude', openai: 'ChatGPT', ollama: 'Ollama' };
const PROVIDER_KEY_MAP = { gemini: 'geminiApiKey', claude: 'claudeApiKey', openai: 'openaiApiKey', ollama: null };

async function incrementApiStats(provider) {
  try {
    const { apiStats = {} } = await chrome.storage.local.get('apiStats');
    apiStats[provider] = (apiStats[provider] || 0) + 1;
    if (!apiStats.lastReset) apiStats.lastReset = Date.now();
    await chrome.storage.local.set({ apiStats });
  } catch { /* storage エラーは無視 */ }
}

async function handleImageTranslation(imageData, imageUrl, imageDims, options) {
  const settings = await getSettings();
  const provider = settings.apiProvider || 'gemini';

  // BlobURLはページ遷移で変わるため、imageDataのコンテンツハッシュをキャッシュキーとして使用
  const cacheKey = (imageUrl && imageUrl.startsWith('blob:') && imageData)
    ? await computeImageDataHash(imageData)
    : imageUrl;

  // キャッシュ確認（forceRefresh 時はスキップ）
  if (cacheKey && !options?.forceRefresh) {
    const cached = await getCachedTranslation(cacheKey, settings.targetLang);
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

    if (translations.length > 0 && cacheKey) {
      await saveCachedTranslation(cacheKey, settings.targetLang, translations);
    }

    // 翻訳成功時のみカウント（キャッシュヒット・エラー時はカウントしない）
    await incrementApiStats(provider);
    return { translations };
  } catch (err) {
    // APIキー等の機密情報が含まれないようサニタイズしてから返す
    const safeMsg = err.message
      .replace(/key=[^&\s"]+/gi, 'key=***')
      .replace(/sk-[^\s"]+/g, 'sk-***')
      .substring(0, 200);
    return { error: safeMsg };
  }
}

// 画像データURLからbase64とMIMEタイプを抽出
function parseImageDataUrl(imageDataUrl) {
  const mimeMatch = imageDataUrl.match(/^data:(image\/\w+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
  return { mimeType, base64Data };
}

// 全プロバイダー共通の翻訳プロンプト
function buildTranslationPrompt(targetLang) {
  const langName = LANG_NAMES[targetLang] || targetLang;
  return `あなたはコミック翻訳の専門家です。この画像に含まれるすべてのテキストを検出・翻訳してください。

【検出ルール】
- 各パネルを上から下、左から右の順にスキャンする
- すべての吹き出し（speech balloon）、キャプション（caption box）、ナレーション、効果音を漏らさず検出する
- 小さな吹き出し、暗い背景上の吹き出し、パネルの端にある吹き出しも見逃さない

各テキスト領域についてJSON配列で返してください:
- original: 元の英語テキスト
- translated: ${langName}への自然な翻訳（短く簡潔に）
- type: "speech" / "caption" / "sfx"
- box: [y_min, x_min, y_max, x_max] — 0〜1000の正規化座標で、テキスト領域の境界を示す
  - y_min: テキスト領域の上端（0=画像上端, 1000=画像下端）
  - x_min: テキスト領域の左端（0=画像左端, 1000=画像右端）
  - y_max: テキスト領域の下端
  - x_max: テキスト領域の右端
- background: 吹き出し/キャプションの背景色情報（白い吹き出しは省略可）
  - 単色の場合: 文字列で返す（例: "#ffe082"）
  - グラデーションの場合: オブジェクトで上端と下端の色を返す
    例: {"top": "#d4edda", "bottom": "#ffffff"}
    - top: 吹き出しの上端の色
    - bottom: 吹き出しの下端の色
- border: 吹き出し/キャプションの枠線の色（例: "#4a7c59"）。枠線がある場合のみ返す

翻訳ルール:
- コミックの文脈に合った自然な${langName}にする
- 効果音は表現豊かに翻訳（例: "BOOM" → "ドーン"）
- 感情・トーンを維持する
- 翻訳文は簡潔に。吹き出しに収まる長さにする

boxルール:
- 吹き出し内のテキスト部分を正確に囲む（尻尾は含めない）
- 隣接する吹き出しのboxが重ならないようにする
- テキストが複数行でも1つの吹き出しは1つのエントリにまとめる

JSON配列のみ返してください:
[{"original":"FIVE...?","translated":"5人…？","type":"speech","box":[20,30,80,180]},{"original":"ROYAL CONSUL...","translated":"王室顧問…","type":"caption","box":[5,10,120,480],"background":{"top":"#d4edda","bottom":"#f0f8e8"},"border":"#4a7c59"}]`;
}

// レスポンスをパースする共通処理
function parseAndLogResults(providerName, content, imageDims) {
  return parseVisionResponse(content, imageDims);
}

// 429リトライ付きfetch（共通）
async function fetchWithRetry(url, options, providerName) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, options);
    if (res.status !== 429 && res.status !== 503) break;
    await res.text().catch(() => '');
    // Retry-After ヘッダーがあればそれを使用、なければ固定バックオフ
    // 503（高負荷）は短めに待機、429（レート制限）は長めに待機
    const retryAfter = res.headers.get('Retry-After');
    const baseWait = res.status === 503 ? 3000 : 10000;
    const retryAfterSec = Math.min(parseInt(retryAfter, 10) || 0, 60); // 上限60秒
    const wait = retryAfterSec > 0 ? retryAfterSec * 1000 : (attempt + 1) * baseWait;
    await new Promise(r => setTimeout(r, wait));
  }
  // 3回リトライしても失敗の場合、明示的なメッセージで通知
  if (res.status === 429) {
    throw new Error(`${providerName} APIがレート制限中です。しばらく時間をおいてから再度お試しください。`);
  }
  if (res.status === 503) {
    throw new Error(`${providerName} APIが高負荷状態です。しばらく時間をおいてから再度お試しください。`);
  }
  return res;
}

// APIエラーから機密情報を除去して安全なメッセージを抽出
function extractSafeErrorMessage(errBody) {
  try {
    const parsed = JSON.parse(errBody);
    const msg = parsed?.error?.message || parsed?.error?.type || '';
    if (msg) return msg.substring(0, 150);
  } catch { /* JSONでない場合はフォールバック */ }
  // 生テキストからAPIキーやURLを除去して短縮
  return errBody.replace(/key=[^&\s"]+/gi, 'key=***').replace(/sk-[^\s"]+/g, 'sk-***').substring(0, 150);
}

// ============================================================
// Gemini API
// ============================================================
async function translateImageWithGemini(apiKey, parsed, prompt, imageDims, model) {
  const { mimeType, base64Data } = parsed;

  const modelName = model || 'gemini-2.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  const body = JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 32000,
    },
  });

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body,
  }, 'Gemini');

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const safeMsg = extractSafeErrorMessage(errBody);
    console.error(`[Doug bg] Gemini APIエラー (${res.status}):`, safeMsg);
    throw new Error(`Gemini API エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini APIから応答がありません');

  return parseAndLogResults('Gemini', content, imageDims);
}

// ============================================================
// Claude (Anthropic) API
// ============================================================
async function translateImageWithClaude(apiKey, parsed, prompt, imageDims, model) {
  const { mimeType, base64Data } = parsed;

  const url = 'https://api.anthropic.com/v1/messages';
  const body = JSON.stringify({
    model: model || 'claude-sonnet-4-6',
    max_tokens: 32000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType,
            data: base64Data,
          },
        },
        {
          type: 'text',
          text: prompt,
        },
      ],
    }],
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

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const safeMsg = extractSafeErrorMessage(errBody);
    console.error(`[Doug bg] Claude APIエラー (${res.status}):`, safeMsg);
    throw new Error(`Claude API エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.content?.[0]?.text;
  if (!content) throw new Error('Claude APIから応答がありません');

  return parseAndLogResults('Claude', content, imageDims);
}

// ============================================================
// OpenAI (ChatGPT) API
// ============================================================
async function translateImageWithOpenAI(apiKey, imageDataUrl, prompt, imageDims, model) {

  const url = 'https://api.openai.com/v1/chat/completions';
  const body = JSON.stringify({
    model: model || 'gpt-5.2-2025-12-11',
    max_tokens: 32000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: imageDataUrl,
          },
        },
        {
          type: 'text',
          text: prompt,
        },
      ],
    }],
  });

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
  }, 'ChatGPT');

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const safeMsg = extractSafeErrorMessage(errBody);
    console.error(`[Doug bg] OpenAI APIエラー (${res.status}):`, safeMsg);
    throw new Error(`ChatGPT API エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('ChatGPT APIから応答がありません');

  return parseAndLogResults('ChatGPT', content, imageDims);
}

// ============================================================
// Ollama API
// ============================================================
async function translateImageWithOllama(endpoint, model, imageData, prompt, imageDims) {
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
    if (res.status === 403) {
      throw new Error('Ollama のアクセスが拒否されました (403)。ターミナルで「launchctl setenv OLLAMA_ORIGINS "*"」を実行して Ollama を再起動してください。');
    }
    if (res.status === 404) {
      throw new Error(`モデル "${model}" がインストールされていません。設定画面でインストールしてください。`);
    }
    const safeMsg = extractSafeErrorMessage(errBody);
    throw new Error(`Ollama エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.message?.content;
  if (!content) throw new Error('Ollama から応答がありません');

  return parseVisionResponse(content, imageDims);
}

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

// ============================================================
// 先読み翻訳（キュー制御）
// ============================================================
let preloadQueue = [];         // 翻訳待ちURL配列
let preloadProcessing = false; // 処理ループ実行中フラグ
let preloadTabId = null;       // 先読みリクエスト元のタブID
let preloadTotal = 0;          // キュー全体の件数
let preloadProcessed = 0;      // 処理済み件数
const prefetchedImages = new Map(); // 先行fetch済み画像 Map<url, dataUrl>
const PRELOAD_CONCURRENCY = 1;      // 並列翻訳数（Gemini無料枠15RPM対応のため直列）
const PRELOAD_MAX_QUEUE = 50;       // キュー上限
let preloadDebounceTimer = null;    // デバウンス用タイマー

async function handlePreloadQueue(imageUrls, tabId) {
  if (!imageUrls || imageUrls.length === 0) return;
  // prefetch OFF なら何もしない（進捗バーも表示しない）
  const settings = await getSettings();
  if (!settings.prefetch) {
    clearTimeout(preloadDebounceTimer);
    return;
  }
  // Blob URLはbackground.jsからfetchできないため除外
  const normalUrls = imageUrls.filter(u => !u.startsWith('blob:'));
  if (normalUrls.length === 0) return;
  // キュー上限を超えるURLは切り捨て
  const clampedUrls = normalUrls.slice(0, PRELOAD_MAX_QUEUE);
  // デバウンス: 短時間の連続呼び出しを抑制（最後の呼び出しから500ms後に実行）
  clearTimeout(preloadDebounceTimer);
  preloadDebounceTimer = setTimeout(() => {
    // キューを置換 + 進捗リセット + 先行fetchキャッシュクリア
    preloadQueue = clampedUrls;
    preloadTabId = tabId;
    preloadTotal = clampedUrls.length;
    preloadProcessed = 0;
    prefetchedImages.clear();
    sendPreloadProgress('active');
    // 処理ループ未実行なら開始（実行中なら既存ループが新キューを処理）
    if (!preloadProcessing) {
      preloadProcessing = true; // 二重起動を確実に防ぐため呼び出し前にセット
      processPreloadQueue();
    }
  }, 500);
}

async function processPreloadQueue() {
  preloadProcessing = true;

  try {
    const settings = await getSettings();
    if (!settings.prefetch) return;

    const provider = settings.apiProvider || 'gemini';
    if (provider !== 'ollama') {
      const apiKey = settings[PROVIDER_KEY_MAP[provider]];
      if (!apiKey) return;
    }

    let batchIndex = 0;

    while (preloadQueue.length > 0) {
      // キューから最大2件を取り出す
      const batch = preloadQueue.splice(0, PRELOAD_CONCURRENCY);

      // 次のバッチの画像を先行fetchする（現在処理中でないもの）
      const nextUrls = preloadQueue.slice(0, PRELOAD_CONCURRENCY);
      for (const nextUrl of nextUrls) {
        if (!prefetchedImages.has(nextUrl)) {
          // 先行fetchを非同期で開始（awaitしない）
          fetchImageAsDataUrl(nextUrl)
            .then(dataUrl => { prefetchedImages.set(nextUrl, dataUrl); })
            .catch(() => { /* 先行fetchの失敗は無視 */ });
        }
      }

      // リクエスト間ディレイ（初回以外）: Gemini無料枠15RPM制限に対応（4200ms = 余裕を持って14RPM）
      if (batchIndex > 0) {
        await new Promise(r => setTimeout(r, 4200));
      }

      // バッチ内の各アイテムを並列実行
      const promises = batch.map(url => processPreloadItem(url, settings));
      await Promise.allSettled(promises);

      batchIndex++;
    }

  } finally {
    prefetchedImages.clear();
    preloadProcessed = preloadTotal; // キュー置換によるカウントズレを補正して必ず100%で終了
    sendPreloadProgress('done');
    preloadProcessing = false;
  }
}

// 先読みキューの1アイテムを処理
async function processPreloadItem(url, settings) {
  const shortUrl = url.split('/').pop()?.split('?')[0] || url;
  try {
    // キャッシュ済みならスキップ（進捗は進める）
    const existing = await getCachedTranslation(url, settings.targetLang);
    if (existing) {
      preloadProcessed++;
      sendPreloadProgress('active');
      return;
    }

    // 先行fetch済みの画像があればそれを使う、なければfetch
    let imageData;
    if (prefetchedImages.has(url)) {
      imageData = prefetchedImages.get(url);
      prefetchedImages.delete(url);
    } else {
      imageData = await fetchImageAsDataUrl(url);
    }

    const dims = getImageDimsFromDataUrl(imageData);
    await handleImageTranslation(imageData, url, dims, { prefetch: true });
  } catch (err) {
    console.warn(`[Doug preload] エラー: ${shortUrl}`, err.message);
  }

  preloadProcessed++;
  sendPreloadProgress('active');
}

function sendPreloadProgress(state) {
  if (!preloadTabId) return;
  chrome.tabs.sendMessage(preloadTabId, {
    type: 'PRELOAD_PROGRESS',
    state,
    current: preloadProcessed,
    total: preloadTotal,
  }).catch(() => {});
}

// base64画像データからサイズを取得（Service Worker用）
function getImageDimsFromDataUrl(dataUrl) {
  // Service Workerにはnew Image()がないため、ヘッダーからサイズを推定
  // 実際のサイズはAPI側で認識するため、デフォルト値を返す
  return { width: 1024, height: 1536 };
}

