// background.js - Gemini API テキスト翻訳 + キャッシュ管理

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30日
const CACHE_VERSION = '1.1';
const MARVEL_URL_RE = /^https:\/\/[^/]*\.marvel\.com(\/|$)/;

// ============================================================
// マイグレーション: sync → local への移行
// ============================================================
chrome.runtime.onInstalled.addListener(async (details) => {
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

// ============================================================
// Port通信ハンドラー（TRANSLATE_IMAGE: 長時間処理のためタイムアウトなしのPortを使用）
// ============================================================
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate') return;
  const sender = port.sender;
  if (sender.id !== chrome.runtime.id) { port.disconnect(); return; }
  if (sender.tab && !MARVEL_URL_RE.test(sender.tab.url || '')) { port.disconnect(); return; }

  port.onMessage.addListener(async (message) => {
    if (message.type !== 'TRANSLATE_IMAGE') return;
    try {
      const result = await handleImageTranslation(message.imageData, message.imageUrl, message.imageDims);
      port.postMessage(result);
    } catch (err) {
      port.postMessage({ error: err.message });
    }
  });
});

// ============================================================
// メッセージハンドラー
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 送信元検証: 自拡張IDを確認 + タブからのメッセージはmarvel.comドメインのみ許可
  // sender.tabがない場合 = popup等の拡張内ページ（自拡張IDチェックで十分）
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: '不正な送信元です' });
    return false;
  }
  if (sender.tab && !MARVEL_URL_RE.test(sender.tab.url || '')) {
    sendResponse({ error: '不正な送信元です' });
    return false;
  }

  if (message.type === 'KEEP_ALIVE') {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'FETCH_IMAGE') {
    if (!isAllowedImageUrl(message.url)) {
      sendResponse({ error: '許可されていない画像URLです' });
      return false;
    }
    fetchImageAsDataUrl(message.url)
      .then(imageData => sendResponse({ imageData }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'PRELOAD_QUEUE') {
    handlePreloadQueue(message.imageUrls, sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }
});

// ============================================================
// 画像fetch
// ============================================================
// FETCH_IMAGE で許可する画像ホスト（Marvel CDN と marvel.com サブドメインのみ）
function isAllowedImageUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (
      u.hostname === 'i.annihil.us' ||
      u.hostname === 'marvel.com' ||
      u.hostname.endsWith('.marvel.com')
    );
  } catch {
    return false;
  }
}

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
  prefetch: true,
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
// URLからクエリパラメータ・fragment・認証情報を除去（トークン等の変動部分を無視してキャッシュ一致させる）
function normalizeImageUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    // 認証情報(@以前)を除去してからクエリ・fragmentを除去
    const stripped = url.replace(/^[^:]+:\/\/[^@]*@/, '');
    return stripped.split('?')[0].split('#')[0];
  }
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
    const result = await chrome.storage.local.get(cacheKey);
    const cached = result[cacheKey];
    if (!cached) return null;
    if (cached.version !== CACHE_VERSION) {
      await chrome.storage.local.remove(cacheKey);
      return null;
    }
    if (Date.now() - cached.timestamp > CACHE_TTL) {
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
  try {
    await chrome.storage.local.set({ [cacheKey]: cacheData });
    const usage = await chrome.storage.local.getBytesInUse();
    if (usage > 8 * 1024 * 1024) await cleanOldCache();
  } catch {
    await cleanOldCache();
    try { await chrome.storage.local.set({ [cacheKey]: cacheData }); } catch { /* 諦める */ }
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

    if (translations.length > 0 && imageUrl) {
      await saveCachedTranslation(imageUrl, settings.targetLang, translations);
    }

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
      maxOutputTokens: 8000,
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
    max_tokens: 8000,
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
    max_tokens: 8000,
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

// 翻訳テキストから「」と末尾の。を除去
function cleanTranslatedText(text) {
  if (!text) return text;
  let s = text;
  // 文頭の「と文末の」を除去
  if (s.startsWith('「') && s.endsWith('」')) {
    s = s.slice(1, -1);
  }
  // 末尾の。を除去
  s = s.replace(/。$/, '');
  return s;
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
  // キュー上限を超えるURLは切り捨て
  const clampedUrls = imageUrls.slice(0, PRELOAD_MAX_QUEUE);
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

function parseVisionResponse(geminiResponse, imageDims) {
  let cleaned = geminiResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const imgW = imageDims?.width || 1000;
  const imgH = imageDims?.height || 1500;

  // LLM出力のJSON修復:
  // 1. 制御文字を空白に正規化（生改行・タブ等）
  // 2. 不正なエスケープシーケンスを修復（\p, \a 等 → \\p, \\a）
  // catchブロックで診断ログに使うためtryブロック外で宣言
  const sanitized = jsonMatch[0]
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');

  try {
    const results = JSON.parse(sanitized);
    if (!Array.isArray(results)) return [];

    return results
      .filter(r => r.translated && (r.box || r.bbox))
      .map(r => {
        let top, left, width, height;

        if (r.box && Array.isArray(r.box) && r.box.length === 4) {
          // 正規化座標 [y_min, x_min, y_max, x_max] (0-1000) → パーセンテージ
          const [yMin, xMin, yMax, xMax] = r.box;
          top = (yMin / 1000) * 100;
          left = (xMin / 1000) * 100;
          width = ((xMax - xMin) / 1000) * 100;
          height = ((yMax - yMin) / 1000) * 100;
        } else if (r.bbox) {
          // フォールバック: ピクセル座標
          const bx = r.bbox.x ?? r.bbox.left ?? 0;
          const by = r.bbox.y ?? r.bbox.top ?? 0;
          const bw = r.bbox.w ?? r.bbox.width ?? 100;
          const bh = r.bbox.h ?? r.bbox.height ?? 50;
          top = (by / imgH) * 100;
          left = (bx / imgW) * 100;
          width = (bw / imgW) * 100;
          height = (bh / imgH) * 100;
        }

        const result = {
          bbox: { top, left, width, height },
          original: r.original || '',
          translated: cleanTranslatedText(r.translated),
          type: r.type || 'speech',
        };
        if (r.background) {
          if (typeof r.background === 'string') {
            result.background = r.background;
          } else if (r.background.top && r.background.bottom) {
            // グラデーション: APIは色順を逆に返す傾向があるため反転して適用
            result.background = `linear-gradient(to bottom, ${r.background.bottom}, ${r.background.top})`;
          }
        }
        if (r.border) {
          result.border = r.border;
        }
        return result;
      });
  } catch (err) {
    console.error('[Doug bg] Vision応答のパースに失敗:', err);
    // 失敗箇所を特定するための診断ログ
    const pos = parseInt(err.message?.match(/position (\d+)/)?.[1] || '0', 10);
    if (pos > 0) {
      console.error('[Doug bg] 問題箇所 (前後50文字):', JSON.stringify(sanitized.substring(Math.max(0, pos - 50), pos + 50)));
    }
    return [];
  }
}
