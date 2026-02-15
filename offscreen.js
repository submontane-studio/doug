// offscreen.js - Tesseract.js OCR をオフスクリーンドキュメントで実行
// tesseract.min.jsはif(false)パッチ済みで、new Worker(url)を直接使用する

let ocrWorker = null;

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;

  console.log('[Doug offscreen] Tesseract worker 初期化中...');
  const base = chrome.runtime.getURL('');
  ocrWorker = await Tesseract.createWorker('eng', 1, {
    workerPath: base + 'lib/worker.min.js',
    corePath: base + 'lib/',
    langPath: base + 'lang/',
    cacheMethod: 'none',
  });
  console.log('[Doug offscreen] Tesseract worker 初期化完了');
  return ocrWorker;
}

// blocks階層からlinesを抽出するヘルパー
function extractLines(blocks) {
  if (!blocks || !blocks.length) return null;
  const lines = [];
  for (const block of blocks) {
    const paragraphs = block.paragraphs || [];
    for (const para of paragraphs) {
      const paraLines = para.lines || [];
      for (const line of paraLines) {
        lines.push(line);
      }
    }
  }
  return lines.length > 0 ? lines : null;
}

async function runOcr(imageDataUrl) {
  console.log('[Doug offscreen] OCR開始, データサイズ:', imageDataUrl.length);
  const worker = await getOcrWorker();
  // Tesseract.js v7: 第3引数で出力形式を明示指定（デフォルトは text のみ）
  const result = await worker.recognize(imageDataUrl, {}, { text: true, blocks: true });

  // blocks > paragraphs > lines > words の階層構造からlines抽出
  const lines = [];
  const dataLines = result.data?.lines
    || extractLines(result.data?.blocks)
    || [];

  const MIN_CONFIDENCE = 40; // 信頼度40%未満はノイズとして除外
  const MIN_TEXT_LENGTH = 3; // 3文字未満は除外

  for (const line of dataLines) {
    const text = (line.text || '').trim();
    if (!text || text.length < MIN_TEXT_LENGTH) continue;
    // 信頼度フィルタ
    const conf = line.confidence ?? 0;
    if (conf < MIN_CONFIDENCE) continue;
    // 純粋な記号・数字のみの行を除外
    if (/^[\s\d.,!?@#$%^&*()_\-+=<>[\]{}|\\/:;"'~`]+$/.test(text)) continue;

    lines.push({
      text: text,
      bbox: line.bbox,
      confidence: conf,
    });
  }
  console.log('[Doug offscreen] OCR完了, 検出行数:', lines.length,
    '(フィルタ前:', dataLines.length, ')');
  return lines;
}

// background と port 接続
const port = chrome.runtime.connect({ name: 'offscreen-ocr' });

port.onMessage.addListener((message) => {
  if (message.type === 'RUN_OCR') {
    console.log('[Doug offscreen] RUN_OCR受信 id:', message.requestId);
    runOcr(message.imageData)
      .then(results => {
        console.log('[Doug offscreen] OCR結果送信, 件数:', results.length);
        port.postMessage({
          type: 'OCR_RESULT',
          requestId: message.requestId,
          results: results,
        });
      })
      .catch(err => {
        console.error('[Doug offscreen] OCRエラー:', err);
        port.postMessage({
          type: 'OCR_RESULT',
          requestId: message.requestId,
          error: err.message,
        });
      });
  }
});

console.log('[Doug offscreen] port接続完了');
