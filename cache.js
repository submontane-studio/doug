// cache.js - 翻訳結果のキャッシュ管理

import { normalizeImageUrl, isSessionOnlyUrl } from './utils/url-utils.js';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30日
const CACHE_VERSION = '1.1';

// 翻訳結果に影響する設定キー（変更時に古いキャッシュを削除）
export const CACHE_AFFECTING_KEYS = ['apiProvider', 'geminiModel', 'claudeModel', 'openaiModel', 'ollamaModel', 'targetLang'];

// Blob画像のコンテンツからSHA-256ハッシュを生成（BlobURLはページ遷移で変わるため内容で同一性を判定）
export async function computeImageDataHash(imageData) {
  const base64 = imageData.indexOf(',') >= 0 ? imageData.slice(imageData.indexOf(',') + 1) : imageData;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(base64);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'img-hash:' + Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateCacheKey(imageUrl, targetLang, provider = '', model = '') {
  if (!imageUrl) throw new Error('imageUrl is required');
  // トークン等を除去したURLでハッシュ生成（先読みと通常翻訳でキャッシュを共有）
  const normalized = normalizeImageUrl(imageUrl);
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `cache:${hashHex.substring(0, 32)}:${targetLang}:${provider}:${model}`;
}

export async function getCachedTranslation(imageUrl, targetLang, provider = '', model = '') {
  const cacheKey = await generateCacheKey(imageUrl, targetLang, provider, model);
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

export async function saveCachedTranslation(imageUrl, targetLang, translations, provider = '', model = '') {
  const cacheKey = await generateCacheKey(imageUrl, targetLang, provider, model);
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

export async function cleanOldCache() {
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
