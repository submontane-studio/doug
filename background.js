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
// メッセージハンドラー
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE_TEXTS') {
    handleTranslation(message.ocrResults, message.imageUrl)
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
    geminiApiKey: '',
    targetLang: 'ja',
  });
}

// ============================================================
// キャッシュ機能
// ============================================================
function generateCacheKey(imageUrl, targetLang) {
  if (!imageUrl) throw new Error('imageUrl is required');
  try {
    const urlHash = btoa(imageUrl).substring(0, 50);
    return `cache:${urlHash}:${targetLang}`;
  } catch {
    const urlHash = encodeURIComponent(imageUrl).substring(0, 50);
    return `cache:${urlHash}:${targetLang}`;
  }
}

async function getCachedTranslation(imageUrl, targetLang) {
  const cacheKey = generateCacheKey(imageUrl, targetLang);
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
  const cacheKey = generateCacheKey(imageUrl, targetLang);
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

async function handleTranslation(ocrResults, imageUrl) {
  const settings = await getSettings();

  // キャッシュ確認
  if (imageUrl) {
    const cached = await getCachedTranslation(imageUrl, settings.targetLang);
    if (cached) {
      console.log('キャッシュから翻訳を取得');
      return { translations: cached, fromCache: true };
    }
  }

  // OCR結果が空ならAPI不要
  if (!ocrResults || ocrResults.length === 0) {
    return { translations: [] };
  }

  // APIキー確認
  if (!settings.geminiApiKey) {
    return { error: 'Gemini APIキーが設定されていません。拡張機能の設定画面でAPIキーを入力してください。' };
  }

  // 全テキストを1回のAPIコールでバッチ翻訳
  try {
    const translations = await translateWithGemini(settings.geminiApiKey, ocrResults, settings.targetLang);

    // キャッシュ保存
    if (translations.length > 0 && imageUrl) {
      await saveCachedTranslation(imageUrl, settings.targetLang, translations);
    }

    return { translations };
  } catch (err) {
    return { error: `翻訳に失敗: ${err.message}` };
  }
}

async function translateWithGemini(apiKey, ocrResults, targetLang) {
  const langName = LANG_NAMES[targetLang] || targetLang;

  // OCRテキストをまとめて1回のプロンプトで翻訳
  const textList = ocrResults.map((r, i) => `[${i}] "${r.text}"`).join('\n');

  const prompt = `コミックの吹き出しテキストを${langName}に翻訳してください。
番号付きテキストが与えられます。各テキストを自然な${langName}に翻訳し、JSON配列で返してください。

入力テキスト:
${textList}

ルール:
- コミックの文脈に合った自然な翻訳にする
- 効果音は表現豊かに翻訳する（例: "BOOM" → "ドーン"）
- 感情やトーンを維持する

JSON配列のみ返してください（説明不要）:
[{"index":0,"translated":"翻訳文"},{"index":1,"translated":"翻訳文"}]`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2000,
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gemini API エラー (${res.status}): ${errBody.substring(0, 200)}`);
  }

  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini APIから応答がありません');

  return mergeTranslations(ocrResults, content);
}

function mergeTranslations(ocrResults, geminiResponse) {
  // JSONを抽出
  let cleaned = geminiResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const translated = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(translated)) return [];

    // OCR結果と翻訳をマージ
    return ocrResults.map((ocr, i) => {
      const match = translated.find(t => t.index === i);
      return {
        bbox: ocr.bbox,
        original: ocr.text,
        translated: match ? match.translated : ocr.text,
        type: 'speech',
      };
    });
  } catch {
    return [];
  }
}
