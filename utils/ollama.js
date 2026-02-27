// utils/ollama.js
// content.js の IIFE 内にある Ollama 用 pure 関数のテスト専用コピー
// content.js が変更された場合はここも同期すること

/**
 * Ollama 翻訳テキストの後処理（「」除去・末尾。除去）
 * content.js の ollamaCleanText と同一ロジック
 */
export function ollamaCleanText(text) {
  if (!text) return text;
  let s = text;
  if (s.startsWith('「') && s.endsWith('」')) s = s.slice(1, -1);
  return s.replace(/。$/, '');
}

/**
 * Ollama レスポンス JSON 文字列を bbox 配列にパース
 * content.js の ollamaParseResponse と同一ロジック
 * Ollama は bbox の y 軸スケールに 1500 を使用（Vision API とは異なる）
 */
export function ollamaParseResponse(content) {
  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const sanitized = jsonMatch[0]
      .replace(/[\x00-\x1F\x7F]+/g, ' ')
      .replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
    const results = JSON.parse(sanitized);
    if (!Array.isArray(results)) return [];
    return results.filter(r => r.translated && (r.box || r.bbox)).map(r => {
      let top, left, width, height;
      if (r.box && Array.isArray(r.box) && r.box.length === 4) {
        const [yMin, xMin, yMax, xMax] = r.box;
        top = (yMin / 1000) * 100; left = (xMin / 1000) * 100;
        width = ((xMax - xMin) / 1000) * 100; height = ((yMax - yMin) / 1000) * 100;
      } else if (r.bbox) {
        const bx = r.bbox.x ?? r.bbox.left ?? 0, by = r.bbox.y ?? r.bbox.top ?? 0;
        const bw = r.bbox.w ?? r.bbox.width ?? 100, bh = r.bbox.h ?? r.bbox.height ?? 50;
        top = (by / 1500) * 100; left = (bx / 1000) * 100;
        width = (bw / 1000) * 100; height = (bh / 1500) * 100;
      }
      const result = {
        bbox: { top, left, width, height },
        original: r.original || '',
        translated: ollamaCleanText(r.translated),
        type: r.type || 'speech',
      };
      if (r.background) {
        result.background = typeof r.background === 'string'
          ? r.background
          : (r.background.top && r.background.bottom
            ? `linear-gradient(to bottom, ${r.background.bottom}, ${r.background.top})`
            : undefined);
      }
      if (r.border) result.border = r.border;
      return result;
    });
  } catch { return []; }
}
