// utils/parse-utils.js

/**
 * 翻訳テキストの後処理（「」除去・末尾。除去）
 * background.js の cleanTranslatedText と同一ロジック
 * @param {string} text
 * @returns {string}
 */
export function cleanTranslatedText(text) {
  if (!text) return text;
  let s = text;
  if (s.startsWith('「') && s.endsWith('」')) {
    s = s.slice(1, -1);
  }
  s = s.replace(/。$/, '');
  return s;
}

/**
 * Gemini/Claude/OpenAI Vision API レスポンスを bbox 配列にパース
 * background.js の parseVisionResponse と同一ロジック
 * @param {string} geminiResponse - LLM が返した JSON 文字列
 * @param {{ width?: number, height?: number }} imageDims - 画像サイズ（bbox 形式の場合に使用）
 * @returns {Array<{ bbox: object, original: string, translated: string, type: string }>}
 */
export function parseVisionResponse(geminiResponse, imageDims) {
  let cleaned = geminiResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const imgW = imageDims?.width || 1000;
  const imgH = imageDims?.height || 1500;

  const sanitized = jsonMatch[0]
    .replace(/(?<!:)\/\/.*$/gm, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/\\(?!["\\\/bfnrtu])/g, '\\\\')
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/([}\]])\s*(["{[])/g, '$1,$2');

  const candidates = [sanitized, sanitized + '}]', sanitized + '"}]'];
  const lastObj = sanitized.lastIndexOf('},');
  if (lastObj > 0) candidates.push(sanitized.substring(0, lastObj + 1) + ']');

  let results = null;
  let parseErr = null;
  for (const candidate of candidates) {
    try { results = JSON.parse(candidate); break; } catch (e) { parseErr = parseErr ?? e; }
  }

  if (!Array.isArray(results)) return [];

  try {
    return results
      .filter(r => r.translated && (r.box || r.bbox))
      .map(r => {
        let top, left, width, height;
        if (r.box && Array.isArray(r.box) && r.box.length === 4) {
          const [yMin, xMin, yMax, xMax] = r.box;
          top = (yMin / 1000) * 100;
          left = (xMin / 1000) * 100;
          width = ((xMax - xMin) / 1000) * 100;
          height = ((yMax - yMin) / 1000) * 100;
        } else if (r.bbox) {
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
            result.background = `linear-gradient(to bottom, ${r.background.bottom}, ${r.background.top})`;
          }
        }
        if (r.border) result.border = r.border;
        return result;
      });
  } catch {
    return [];
  }
}
