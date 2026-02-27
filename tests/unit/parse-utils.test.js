// tests/unit/parse-utils.test.js
import { describe, it, expect } from 'vitest';
import { cleanTranslatedText, parseVisionResponse } from '../../utils/parse-utils.js';

describe('cleanTranslatedText', () => {
  it('「」で囲まれた文字列の括弧を除去する', () => {
    expect(cleanTranslatedText('「こんにちは」')).toBe('こんにちは');
  });
  it('末尾の。を除去する', () => {
    expect(cleanTranslatedText('こんにちは。')).toBe('こんにちは');
  });
  it('開き括弧のみ・閉じ括弧のみの場合は変換しない', () => {
    expect(cleanTranslatedText('「こんにちは')).toBe('「こんにちは');
    expect(cleanTranslatedText('こんにちは」')).toBe('こんにちは」');
  });
  it('null/undefined/空文字はそのまま返す', () => {
    expect(cleanTranslatedText(null)).toBe(null);
    expect(cleanTranslatedText('')).toBe('');
  });
});

describe('parseVisionResponse', () => {
  it('box 形式（[yMin,xMin,yMax,xMax]）を % に変換する', () => {
    const input = JSON.stringify([{
      original: 'Hello',
      translated: 'こんにちは',
      type: 'speech',
      box: [100, 200, 300, 600],
    }]);
    const result = parseVisionResponse(input, { width: 1000, height: 1000 });
    expect(result).toHaveLength(1);
    expect(result[0].bbox.top).toBeCloseTo(10);
    expect(result[0].bbox.left).toBeCloseTo(20);
    expect(result[0].bbox.width).toBeCloseTo(40);
    expect(result[0].bbox.height).toBeCloseTo(20);
    expect(result[0].translated).toBe('こんにちは');
    expect(result[0].type).toBe('speech');
  });
  it('bbox 形式（ピクセル座標）を % に変換する', () => {
    const input = JSON.stringify([{
      original: 'Hi',
      translated: 'やあ',
      type: 'caption',
      bbox: { x: 100, y: 150, w: 200, h: 100 },
    }]);
    const result = parseVisionResponse(input, { width: 1000, height: 1500 });
    expect(result[0].bbox.left).toBeCloseTo(10);
    expect(result[0].bbox.top).toBeCloseTo(10);
  });
  it('不正 JSON は [] を返す', () => {
    expect(parseVisionResponse('{broken json', {})).toEqual([]);
  });
  it('translated が空の要素は除外される', () => {
    const input = JSON.stringify([
      { original: 'A', translated: '', box: [0, 0, 100, 100] },
      { original: 'B', translated: 'ビー', box: [100, 0, 200, 100] },
    ]);
    const result = parseVisionResponse(input, {});
    expect(result).toHaveLength(1);
    expect(result[0].original).toBe('B');
  });
  it('background（文字列）が保存される', () => {
    const input = JSON.stringify([{
      original: 'X', translated: 'エックス', box: [0, 0, 100, 100],
      background: '#ffe082',
    }]);
    const result = parseVisionResponse(input, {});
    expect(result[0].background).toBe('#ffe082');
  });
  it('background（グラデーション）が linear-gradient に変換される', () => {
    const input = JSON.stringify([{
      original: 'X', translated: 'エックス', box: [0, 0, 100, 100],
      background: { top: '#fff', bottom: '#000' },
    }]);
    const result = parseVisionResponse(input, {});
    expect(result[0].background).toBe('linear-gradient(to bottom, #000, #fff)');
  });
  it('Markdown コードブロックを取り除く', () => {
    const inner = JSON.stringify([{ original: 'A', translated: 'エー', box: [0,0,100,100] }]);
    const input = '```json\n' + inner + '\n```';
    const result = parseVisionResponse(input, {});
    expect(result).toHaveLength(1);
  });
});
