// utils/url-utils.js

/**
 * URLからクエリパラメータ・フラグメント・認証情報を除去
 * @param {string} url
 * @returns {string}
 */
export function normalizeImageUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    const stripped = url.replace(/^[^:]+:\/\/[^@]*@/, '');
    return stripped.split('?')[0].split('#')[0];
  }
}

/**
 * Blob URL や img-hash: はセッション限定キャッシュを使用
 * @param {string} url
 * @returns {boolean}
 */
export function isSessionOnlyUrl(url) {
  return typeof url === 'string' && (url.startsWith('blob:') || url.startsWith('img-hash:'));
}

/**
 * FETCH_IMAGE で許可する画像URL（https のみ）
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowedImageUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * URL と whitelist Set でサイト許可を判定（pure 関数版）
 * background.js の isSiteAllowed は whitelistedOrigins を直接参照しているため、
 * テスト可能なようにホワイトリストを引数で受け取る
 * @param {string} url
 * @param {Set<string>} whitelist
 * @returns {boolean}
 */
export function isSiteAllowed(url, whitelist) {
  if (!url) return false;
  try {
    const origin = new URL(url).origin;
    return whitelist.has(origin);
  } catch { return false; }
}
