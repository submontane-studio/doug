// tests/unit/ollama.test.js
import { describe, it, expect } from 'vitest';
import { ollamaCleanText, ollamaParseResponse } from '../../utils/ollama.js';

describe('ollamaCleanText', () => {
  it('「」で囲まれた文字列の括弧を除去する', () => {
    expect(ollamaCleanText('「こんにちは」')).toBe('こんにちは');
  });
  it('末尾の。を除去する', () => {
    expect(ollamaCleanText('こんにちは。')).toBe('こんにちは');
  });
  it('null/falsy はそのまま返す', () => {
    expect(ollamaCleanText(null)).toBe(null);
    expect(ollamaCleanText('')).toBeFalsy();
  });
});

describe('ollamaParseResponse', () => {
  it('box 形式を % に変換する（Ollama は固定 1000x1000 スケール）', () => {
    const input = JSON.stringify([{
      original: 'BOOM',
      translated: 'ドーン',
      type: 'sfx',
      box: [500, 250, 750, 750],
    }]);
    const result = ollamaParseResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].bbox.top).toBeCloseTo(50);
    expect(result[0].bbox.left).toBeCloseTo(25);
    expect(result[0].bbox.width).toBeCloseTo(50);
    expect(result[0].bbox.height).toBeCloseTo(25);
  });
  it('bbox 形式（Ollama フォールバック）も動作する', () => {
    const input = JSON.stringify([{
      original: 'Hi',
      translated: 'やあ',
      type: 'speech',
      bbox: { x: 100, y: 150, w: 200, h: 100 },
    }]);
    const result = ollamaParseResponse(input);
    expect(result[0].bbox.left).toBeCloseTo(10);
  });
  it('不正 JSON は [] を返す', () => {
    expect(ollamaParseResponse('broken')).toEqual([]);
  });
  it('translated が空の要素は除外される', () => {
    const input = JSON.stringify([
      { original: 'A', translated: '', box: [0, 0, 100, 100] },
      { original: 'B', translated: 'ビー', box: [100, 0, 200, 100] },
    ]);
    expect(ollamaParseResponse(input)).toHaveLength(1);
  });
  it('translated テキストに ollamaCleanText が適用される', () => {
    const input = JSON.stringify([{
      original: 'Hello',
      translated: '「こんにちは」',
      box: [0, 0, 100, 100],
    }]);
    expect(ollamaParseResponse(input)[0].translated).toBe('こんにちは');
  });
});
