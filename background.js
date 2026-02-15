// background.js - Gemini API テキスト翻訳 + キャッシュ管理

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30日
const CACHE_VERSION = '1.1';

// ============================================================
// マイグレーション: sync → local への移行
// ============================================================
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    try {
      const syncData = await chrome.storage.sync.get(['apiKey', 'apiProvider', 'targetLang']);
      if (syncData.apiKey || syncData.apiProvider || syncData.targetLang) {
        await chrome.storage.local.set(syncData);
        await chrome.storage.sync.remove(['apiKey', 'apiProvider', 'targetLang']);
        console.log('設定を sync から local に移行しました');
      }
    } catch (err) {
      console.error('設定の移行に失敗:', err);
    }
  }
});

// ============================================================
// Offscreen Document 管理（port ベース通信）
// ============================================================
let offscreenCreating = null;
let offscreenPort = null;
let ocrRequestId = 0;
const ocrCallbacks = new Map();

// offscreen から port 接続を受け取る
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen-ocr') {
    console.log('[Doug bg] offscreen port 接続');
    offscreenPort = port;

    port.onMessage.addListener((message) => {
      if (message.type === 'OCR_RESULT') {
        const cb = ocrCallbacks.get(message.requestId);
        if (cb) {
          ocrCallbacks.delete(message.requestId);
          clearTimeout(cb.timeout);
          if (message.error) {
            cb.resolve({ error: message.error });
          } else {
            cb.resolve({ results: message.results });
          }
        }
      }
    });

    port.onDisconnect.addListener(() => {
      console.log('[Doug bg] offscreen port 切断');
      offscreenPort = null;
    });
  }
});

async function ensureOffscreenDocument() {
  if (offscreenPort) return;

  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length === 0) {
    if (offscreenCreating) {
      await offscreenCreating;
    } else {
      offscreenCreating = chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Tesseract.js OCR にWeb Workerが必要',
      });
      await offscreenCreating;
      offscreenCreating = null;
    }
  }

  // port 接続を待機
  for (let i = 0; i < 50; i++) {
    if (offscreenPort) {
      console.log('[Doug bg] offscreen 準備完了');
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Offscreen document の起動がタイムアウトしました');
}

async function runOcrViaOffscreen(imageData) {
  await ensureOffscreenDocument();

  const requestId = ++ocrRequestId;
  console.log('[Doug bg] RUN_OCR送信 id:', requestId, 'データサイズ:', imageData.length);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ocrCallbacks.delete(requestId);
      reject(new Error('OCR処理がタイムアウトしました（60秒）'));
    }, 60000);

    ocrCallbacks.set(requestId, { resolve, reject, timeout });

    offscreenPort.postMessage({
      type: 'RUN_OCR',
      imageData: imageData,
      requestId: requestId,
    });
  });
}

// ============================================================
// メッセージハンドラー
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE_IMAGE') {
    handleImageTranslation(message.imageData, message.imageUrl, message.imageDims)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'FETCH_IMAGE') {
    fetchImageAsDataUrl(message.url)
      .then(imageData => sendResponse({ imageData }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ============================================================
// 画像fetch
// ============================================================
async function fetchImageAsDataUrl(url) {
  const res = await fetch(url);
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
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  return `data:${contentType};base64,${base64}`;
}

// ============================================================
// 設定取得
// ============================================================
async function getSettings() {
  return chrome.storage.local.get({
    apiProvider: 'gemini',
    geminiApiKey: '',
    claudeApiKey: '',
    openaiApiKey: '',
    targetLang: 'ja',
  });
}

// ============================================================
// キャッシュ機能
// ============================================================
async function generateCacheKey(imageUrl, targetLang) {
  if (!imageUrl) throw new Error('imageUrl is required');
  // SHA-256でURL全体をハッシュ化（先頭切り詰めによる衝突を防止）
  const encoder = new TextEncoder();
  const data = encoder.encode(imageUrl);
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
    if (usage > 9 * 1024 * 1024) await cleanOldCache();
  } catch {
    await cleanOldCache();
    try { await chrome.storage.local.set({ [cacheKey]: cacheData }); } catch { /* 諦める */ }
  }
}

async function cleanOldCache() {
  try {
    const allData = await chrome.storage.local.get(null);
    const sorted = Object.keys(allData)
      .filter(key => key.startsWith('cache:'))
      .map(key => ({ key, timestamp: allData[key].timestamp || 0 }))
      .sort((a, b) => a.timestamp - b.timestamp);
    const toDelete = sorted.slice(0, Math.ceil(sorted.length / 2)).map(item => item.key);
    if (toDelete.length > 0) {
      await chrome.storage.local.remove(toDelete);
      console.log(`古いキャッシュを${toDelete.length}件削除`);
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

const PROVIDER_LABELS = { gemini: 'Gemini', claude: 'Claude', openai: 'ChatGPT' };
const PROVIDER_KEY_MAP = { gemini: 'geminiApiKey', claude: 'claudeApiKey', openai: 'openaiApiKey' };

async function handleImageTranslation(imageData, imageUrl, imageDims) {
  const settings = await getSettings();
  const provider = settings.apiProvider || 'gemini';

  // キャッシュ確認
  if (imageUrl) {
    const cached = await getCachedTranslation(imageUrl, settings.targetLang);
    if (cached) {
      console.log('[Doug bg] キャッシュから翻訳を取得');
      return { translations: cached, fromCache: true };
    }
  }

  const apiKey = settings[PROVIDER_KEY_MAP[provider]];
  if (!apiKey) {
    return { error: `${PROVIDER_LABELS[provider]} APIキーが設定されていません。拡張機能の設定画面でAPIキーを入力してください。` };
  }

  try {
    let translations;
    if (provider === 'claude') {
      translations = await translateImageWithClaude(apiKey, imageData, settings.targetLang, imageDims);
    } else if (provider === 'openai') {
      translations = await translateImageWithOpenAI(apiKey, imageData, settings.targetLang, imageDims);
    } else {
      translations = await translateImageWithGemini(apiKey, imageData, settings.targetLang, imageDims);
    }

    if (translations.length > 0 && imageUrl) {
      await saveCachedTranslation(imageUrl, settings.targetLang, translations);
    }

    return { translations };
  } catch (err) {
    return { error: `翻訳に失敗: ${err.message}` };
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

// レスポンスをパースしてログ出力する共通処理
function parseAndLogResults(providerName, content, imageDims) {
  console.log(`[Doug bg] ${providerName}応答（全文）:`, content);
  const results = parseVisionResponse(content, imageDims);
  results.forEach((r, i) => {
    console.log(`[Doug bg] 結果[${i}]: "${r.original}" → "${r.translated}" bbox:`, JSON.stringify(r.bbox));
  });
  return results;
}

// 429リトライ付きfetch（共通）
async function fetchWithRetry(url, options, providerName) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, options);
    if (res.status !== 429) break;
    const errDetail = await res.text().catch(() => '');
    console.log(`[Doug bg] ${providerName} 429 詳細:`, errDetail.substring(0, 300));
    const wait = (attempt + 1) * 10000;
    console.log(`[Doug bg] ${wait / 1000}秒後にリトライ (${attempt + 1}/3)`);
    await new Promise(r => setTimeout(r, wait));
  }
  return res;
}

// ============================================================
// Gemini API
// ============================================================
async function translateImageWithGemini(apiKey, imageDataUrl, targetLang, imageDims) {
  const { mimeType, base64Data } = parseImageDataUrl(imageDataUrl);
  const prompt = buildTranslationPrompt(targetLang);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;
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
    headers: { 'Content-Type': 'application/json' },
    body,
  }, 'Gemini');

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[Doug bg] Gemini APIエラー全文:', errBody);
    throw new Error(`Gemini API エラー (${res.status}): ${errBody.substring(0, 200)}`);
  }

  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini APIから応答がありません');

  return parseAndLogResults('Gemini', content, imageDims);
}

// ============================================================
// Claude (Anthropic) API
// ============================================================
async function translateImageWithClaude(apiKey, imageDataUrl, targetLang, imageDims) {
  const { mimeType, base64Data } = parseImageDataUrl(imageDataUrl);
  const prompt = buildTranslationPrompt(targetLang);

  const url = 'https://api.anthropic.com/v1/messages';
  const body = JSON.stringify({
    model: 'claude-sonnet-4-5-20250929',
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
    console.error('[Doug bg] Claude APIエラー全文:', errBody);
    throw new Error(`Claude API エラー (${res.status}): ${errBody.substring(0, 200)}`);
  }

  const data = await res.json();
  const content = data.content?.[0]?.text;
  if (!content) throw new Error('Claude APIから応答がありません');

  return parseAndLogResults('Claude', content, imageDims);
}

// ============================================================
// OpenAI (ChatGPT) API
// ============================================================
async function translateImageWithOpenAI(apiKey, imageDataUrl, targetLang, imageDims) {
  const prompt = buildTranslationPrompt(targetLang);

  const url = 'https://api.openai.com/v1/chat/completions';
  const body = JSON.stringify({
    model: 'gpt-4o',
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
    console.error('[Doug bg] OpenAI APIエラー全文:', errBody);
    throw new Error(`ChatGPT API エラー (${res.status}): ${errBody.substring(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('ChatGPT APIから応答がありません');

  return parseAndLogResults('ChatGPT', content, imageDims);
}

function parseVisionResponse(geminiResponse, imageDims) {
  let cleaned = geminiResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const imgW = imageDims?.width || 1000;
  const imgH = imageDims?.height || 1500;

  try {
    const results = JSON.parse(jsonMatch[0]);
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
          translated: r.translated,
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
    return [];
  }
}
