// background.js - AI API によるOCR＋翻訳処理

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30日（ミリ秒）
const CACHE_VERSION = '1.0';

// ============================================================
// WebLLM Manager
// ============================================================

class WebLLMManager {
  constructor() {
    this.engine = null;
    this.isInitialized = false;
    this.isInitializing = false;
    this.initProgress = 0;
  }

  async initialize() {
    if (this.isInitialized) return;
    if (this.isInitializing) {
      // Wait for initialization to complete
      while (this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    this.isInitializing = true;
    this.initProgress = 0;

    try {
      // Dynamically import WebLLM library
      const { CreateMLCEngine } = await import('https://esm.sh/@mlc-ai/web-llm@0.2.66');

      // Initialize model
      this.engine = await CreateMLCEngine('Phi-3.5-vision-instruct-q4f16_1-MLC', {
        initProgressCallback: (progress) => {
          this.initProgress = Math.round(progress.progress * 100);
          console.log(`WebLLM初期化: ${this.initProgress}%`);
        }
      });

      this.isInitialized = true;
      this.initProgress = 100;
      console.log('WebLLM初期化完了');
    } catch (err) {
      this.isInitializing = false;
      throw new Error(`WebLLM初期化失敗: ${err.message}`);
    } finally {
      this.isInitializing = false;
    }
  }

  async translate(imageBase64, targetLang) {
    if (!this.isInitialized) {
      throw new Error('WebLLMが初期化されていません');
    }

    const prompt = buildPrompt(targetLang);

    try {
      const response = await this.engine.chat.completions.create({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
              }
            ]
          }
        ],
        max_tokens: 1500,
        temperature: 0.1
      });

      const content = response.choices[0].message.content;
      return parseAIResponse(content);
    } catch (err) {
      throw new Error(`WebLLM推論失敗: ${err.message}`);
    }
  }

  getInitProgress() {
    return this.initProgress;
  }

  isReady() {
    return this.isInitialized;
  }
}

// グローバルインスタンス
const webllmManager = new WebLLMManager();

// ============================================================
// マイグレーション: sync → local への移行
// ============================================================
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    try {
      // sync から設定を取得
      const syncData = await chrome.storage.sync.get(['apiKey', 'apiProvider', 'targetLang']);

      // 設定がある場合のみ移行
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE_PAGE') {
    handleTranslation(message.imageData, message.imageUrl)
      .then(result => {
        // Include progress if initializing
        if (webllmManager.isInitializing) {
          result.initProgress = webllmManager.getInitProgress();
        }
        sendResponse(result);
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'GET_INIT_PROGRESS') {
    sendResponse({
      progress: webllmManager.getInitProgress(),
      isInitializing: webllmManager.isInitializing,
      isReady: webllmManager.isReady()
    });
    return true;
  }

  if (message.type === 'FETCH_IMAGE') {
    fetchImageAsDataUrl(message.url)
      .then(imageData => sendResponse({ imageData }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

async function fetchImageAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`画像の取得に失敗: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // チャンク処理でメモリ効率を改善
  const CHUNK_SIZE = 8192;
  const chunks = [];

  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, bytes.length);
    const chunk = bytes.subarray(i, end);
    // スプレッド構文で安全に変換
    chunks.push(String.fromCharCode(...chunk));
  }

  const binary = chunks.join('');
  const base64 = btoa(binary);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  return `data:${contentType};base64,${base64}`;
}

async function getSettings() {
  return chrome.storage.local.get({
    targetLang: 'ja',
  });
}

// ============================================================
// キャッシュ機能
// ============================================================

function generateCacheKey(imageUrl, targetLang) {
  if (!imageUrl) {
    throw new Error('imageUrl is required for cache key generation');
  }
  // imageUrl をハッシュ化（簡易版：URLそのまま使用）
  try {
    const urlHash = btoa(imageUrl).substring(0, 50);
    return `cache:${urlHash}:${targetLang}`;
  } catch (err) {
    // btoa が失敗した場合は直接使用
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

    // バージョンチェック
    if (cached.version !== CACHE_VERSION) {
      await chrome.storage.local.remove(cacheKey);
      return null;
    }

    // TTLチェック
    const age = Date.now() - cached.timestamp;
    if (age > CACHE_TTL) {
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

  const cacheData = {
    translations,
    timestamp: Date.now(),
    version: CACHE_VERSION,
  };

  try {
    await chrome.storage.local.set({ [cacheKey]: cacheData });

    // ストレージ容量チェック（簡易版：エラー時に古いキャッシュを削除）
    const usage = await chrome.storage.local.getBytesInUse();
    const STORAGE_LIMIT = 9 * 1024 * 1024; // 9MB（10MBの90%）

    if (usage > STORAGE_LIMIT) {
      await cleanOldCache();
    }
  } catch (err) {
    console.error('キャッシュ保存エラー:', err);
    // エラー時は古いキャッシュを削除して再試行
    await cleanOldCache();
    try {
      await chrome.storage.local.set({ [cacheKey]: cacheData });
    } catch {
      // 再試行も失敗した場合は諦める
    }
  }
}

async function cleanOldCache() {
  try {
    const allData = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(allData).filter(key => key.startsWith('cache:'));

    // タイムスタンプでソート（古い順）
    const sorted = cacheKeys
      .map(key => ({ key, timestamp: allData[key].timestamp || 0 }))
      .sort((a, b) => a.timestamp - b.timestamp);

    // 古い順に半分削除
    const toDelete = sorted.slice(0, Math.ceil(sorted.length / 2)).map(item => item.key);

    if (toDelete.length > 0) {
      await chrome.storage.local.remove(toDelete);
      console.log(`古いキャッシュを${toDelete.length}件削除しました`);
    }
  } catch (err) {
    console.error('キャッシュクリーンアップエラー:', err);
  }
}

const LANG_NAMES = {
  ja: '日本語 (Japanese)',
  ko: '韓国語 (Korean)',
  'zh-CN': '簡体字中国語 (Simplified Chinese)',
  'zh-TW': '繁体字中国語 (Traditional Chinese)',
  es: 'スペイン語 (Spanish)',
  fr: 'フランス語 (French)',
  de: 'ドイツ語 (German)',
  pt: 'ポルトガル語 (Portuguese)',
};

function buildPrompt(targetLang) {
  const langName = LANG_NAMES[targetLang] || targetLang;
  return `You are a professional comic book translator. Analyze this comic page image carefully.

Identify ALL visible text: speech bubbles, thought bubbles, caption boxes, narration boxes, sound effects (SFX), and any other text.

For EACH text element, provide:
1. "bbox" - Bounding box as percentage of image dimensions: {"top", "left", "width", "height"} (0-100)
2. "original" - The original English text exactly as written
3. "translated" - Natural ${langName} translation appropriate for comics
4. "type" - One of: "speech", "thought", "caption", "narration", "sfx", "other"

Position guidelines:
- "top" and "left" are the top-left corner of the text area
- Estimate positions carefully based on where text appears in the image
- Include some padding around the text area

Translation guidelines:
- Translate naturally for a comic book context
- Keep sound effects expressive (e.g., "BOOM" → "ドーン")
- Maintain the tone and emotion of the original
- For Japanese: use appropriate mix of kanji, hiragana, katakana

Return ONLY a valid JSON array. No markdown, no explanation:
[{"bbox":{"top":10,"left":20,"width":15,"height":5},"original":"Hello!","translated":"こんにちは！","type":"speech"}]

If no text is found, return: []`;
}

async function handleTranslation(imageDataUrl, imageUrl = null) {
  const settings = await getSettings();

  // Check cache
  if (imageUrl) {
    const cached = await getCachedTranslation(imageUrl, settings.targetLang);
    if (cached) {
      console.log('キャッシュから翻訳を取得しました');
      return { translations: cached, fromCache: true };
    }
  }

  // Initialize WebLLM if not ready
  if (!webllmManager.isReady()) {
    try {
      await webllmManager.initialize();
    } catch (err) {
      return {
        error: `モデルの初期化に失敗しました: ${err.message}

ヒント:
- WebGPU対応ブラウザが必要です（Chrome 113+）
- 安定したネットワーク接続を確認してください
- メモリ不足の場合、他のタブを閉じてください`
      };
    }
  }

  // Run inference
  const base64 = imageDataUrl.split(',')[1];

  try {
    const INFERENCE_TIMEOUT = 60000; // 60秒

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('推論がタイムアウトしました（60秒）')), INFERENCE_TIMEOUT)
    );

    const result = await Promise.race([
      webllmManager.translate(base64, settings.targetLang),
      timeoutPromise
    ]);

    // Save to cache
    if (result.translations && result.translations.length > 0 && imageUrl) {
      await saveCachedTranslation(imageUrl, settings.targetLang, result.translations);
    }

    return result;
  } catch (err) {
    return { error: `翻訳に失敗しました: ${err.message}` };
  }
}

function parseAIResponse(content) {
  // マークダウンコードブロックを除去
  let cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');

  // JSON配列を抽出
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return { translations: [], error: 'JSON配列が見つかりません' };
  }

  try {
    const translations = JSON.parse(jsonMatch[0]);

    // 配列であることを確認
    if (!Array.isArray(translations)) {
      return { translations: [], error: 'JSONが配列形式ではありません' };
    }

    // 各要素に必須フィールドがあるか検証
    const valid = translations.every(item =>
      item.bbox && item.original && item.translated && item.type
    );

    if (!valid) {
      return { translations: [], error: '翻訳データの形式が不正です' };
    }

    return { translations };
  } catch (e) {
    return { translations: [], error: `JSONパースエラー: ${e.message}` };
  }
}
