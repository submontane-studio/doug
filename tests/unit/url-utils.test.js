// tests/unit/url-utils.test.js
import { describe, it, expect } from 'vitest';
import { normalizeImageUrl, isSessionOnlyUrl, isAllowedImageUrl, isSiteAllowed } from '../../utils/url-utils.js';

describe('normalizeImageUrl', () => {
  it('クエリパラメータを除去する', () => {
    expect(normalizeImageUrl('https://example.com/img.jpg?token=abc'))
      .toBe('https://example.com/img.jpg');
  });
  it('フラグメントを除去する', () => {
    expect(normalizeImageUrl('https://example.com/img.jpg#section'))
      .toBe('https://example.com/img.jpg');
  });
  it('null/undefined は空文字を返す', () => {
    expect(normalizeImageUrl(null)).toBe('');
    expect(normalizeImageUrl('')).toBe('');
  });
});

describe('isSessionOnlyUrl', () => {
  it('blob: URL は true', () => {
    expect(isSessionOnlyUrl('blob:https://example.com/abc')).toBe(true);
  });
  it('img-hash: URL は true', () => {
    expect(isSessionOnlyUrl('img-hash:abc123')).toBe(true);
  });
  it('通常の https URL は false', () => {
    expect(isSessionOnlyUrl('https://example.com/img.jpg')).toBe(false);
  });
  it('非文字列は false', () => {
    expect(isSessionOnlyUrl(null)).toBe(false);
    expect(isSessionOnlyUrl(undefined)).toBe(false);
  });
});

describe('isAllowedImageUrl', () => {
  it('https URL は true', () => {
    expect(isAllowedImageUrl('https://example.com/img.jpg')).toBe(true);
  });
  it('http URL は false', () => {
    expect(isAllowedImageUrl('http://example.com/img.jpg')).toBe(false);
  });
  it('不正 URL は false', () => {
    expect(isAllowedImageUrl('not-a-url')).toBe(false);
  });
});

describe('isSiteAllowed', () => {
  const whitelist = new Set(['https://example.com', 'https://marvel.com']);

  it('ホワイトリストにあるオリジンは true', () => {
    expect(isSiteAllowed('https://example.com/page', whitelist)).toBe(true);
  });
  it('サブパスが違っても同オリジンなら true', () => {
    expect(isSiteAllowed('https://example.com/comics/1', whitelist)).toBe(true);
  });
  it('未登録オリジンは false', () => {
    expect(isSiteAllowed('https://other.com/page', whitelist)).toBe(false);
  });
  it('不正 URL は false（例外を出さない）', () => {
    expect(isSiteAllowed('not-a-url', whitelist)).toBe(false);
  });
  it('null/undefined は false', () => {
    expect(isSiteAllowed(null, whitelist)).toBe(false);
    expect(isSiteAllowed(undefined, whitelist)).toBe(false);
  });
  it('空の whitelist は常に false', () => {
    expect(isSiteAllowed('https://example.com', new Set())).toBe(false);
  });
});
