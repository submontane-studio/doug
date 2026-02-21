// content.js - Doug コミック翻訳オーバーレイ
// Gemini/Claude/ChatGPT Vision API 翻訳

(function () {
  'use strict';

  let isTranslating = false;
  let overlayContainer = null;
  let toolbar = null;
  let overlaysVisible = true;

  // ============================================================
  // Ollama 直接呼び出し（Service Worker タイムアウト回避）
  // content script はページ側で動くため長時間処理でも停止しない
  // ============================================================
  const OLLAMA_LANG_NAMES = {
    ja: '日本語', ko: '韓国語', 'zh-CN': '簡体字中国語', 'zh-TW': '繁体字中国語',
    es: 'スペイン語', fr: 'フランス語', de: 'ドイツ語', pt: 'ポルトガル語',
  };

  function ollamaCleanText(text) {
    if (!text) return text;
    let s = text;
    if (s.startsWith('「') && s.endsWith('」')) s = s.slice(1, -1);
    return s.replace(/。$/, '');
  }

  function ollamaParseResponse(content) {
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
        const result = { bbox: { top, left, width, height }, original: r.original || '', translated: ollamaCleanText(r.translated), type: r.type || 'speech' };
        if (r.background) {
          result.background = typeof r.background === 'string'
            ? r.background
            : (r.background.top && r.background.bottom ? `linear-gradient(to bottom, ${r.background.bottom}, ${r.background.top})` : undefined);
        }
        if (r.border) result.border = r.border;
        return result;
      });
    } catch { return []; }
  }

  async function translateWithOllamaDirect(imageDataUrl) {
    const settings = await chrome.storage.local.get({
      ollamaModel: 'qwen3-vl:8b',
      ollamaEndpoint: 'http://localhost:11434',
      targetLang: 'ja',
    });
    const { ollamaModel: model, ollamaEndpoint: endpoint, targetLang } = settings;
    // http/https スキームのみ許可（file:// 等によるローカルファイル読み取りを防ぐ）
    if (!/^https?:\/\//i.test(endpoint)) {
      throw new Error('Ollama エンドポイントは http:// または https:// で始まる必要があります。');
    }
    const langName = OLLAMA_LANG_NAMES[targetLang] || targetLang;
    const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const prompt = `あなたはコミック翻訳の専門家です。この画像に含まれるすべてのテキストを検出・翻訳してください。

【検出ルール】
- 各パネルを上から下、左から右の順にスキャンする
- すべての吹き出し（speech balloon）、キャプション（caption box）、ナレーション、効果音を漏らさず検出する
- 小さな吹き出し、暗い背景上の吹き出し、パネルの端にある吹き出しも見逃さない

各テキスト領域についてJSON配列で返してください:
- original: 元の英語テキスト
- translated: ${langName}への自然な翻訳（短く簡潔に）
- type: "speech" / "caption" / "sfx"
- box: [y_min, x_min, y_max, x_max] — 0〜1000の正規化座標で、テキスト領域の境界を示す
  - y_min: テキスト領域の上端（0=画像上端, 1000=画像下端）
  - x_min: テキスト領域の左端（0=画像左端, 1000=画像右端）
  - y_max: テキスト領域の下端
  - x_max: テキスト領域の右端
- background: 吹き出し/キャプションの背景色情報（白い吹き出しは省略可）
  - 単色の場合: 文字列で返す（例: "#ffe082"）
  - グラデーションの場合: オブジェクトで上端と下端の色を返す
    例: {"top": "#d4edda", "bottom": "#ffffff"}
- border: 吹き出し/キャプションの枠線の色（例: "#4a7c59"）。枠線がある場合のみ返す

翻訳ルール:
- コミックの文脈に合った自然な${langName}にする
- 効果音は表現豊かに翻訳（例: "BOOM" → "ドーン"）
- 感情・トーンを維持する
- 翻訳文は簡潔に。吹き出しに収まる長さにする

boxルール:
- 吹き出し内のテキスト部分を正確に囲む（尻尾は含めない）
- 隣接する吹き出しのboxが重ならないようにする
- テキストが複数行でも1つの吹き出しは1つのエントリにまとめる

JSON配列のみ返してください:
[{"original":"FIVE...?","translated":"5人…？","type":"speech","box":[20,30,80,180]},{"original":"ROYAL CONSUL...","translated":"王室顧問…","type":"caption","box":[5,10,120,480],"background":{"top":"#d4edda","bottom":"#f0f8e8"},"border":"#4a7c59"}]`;

    let res;
    try {
      res = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt, images: [base64Data] }], stream: false }),
      });
    } catch (err) {
      throw new Error(`Ollama への接続に失敗しました（${err.message}）。起動しているか・エンドポイント設定を確認してください。`);
    }
    if (res.status === 403) throw new Error('Ollama のアクセスが拒否されました (403)。OLLAMA_ORIGINS の設定が必要です。');
    if (res.status === 404) throw new Error(`モデル "${model}" がインストールされていません。設定画面でインストールしてください。`);
    if (!res.ok) throw new Error(`Ollama エラー (${res.status})`);
    const data = await res.json();
    const text = data.message?.content;
    if (!text) throw new Error('Ollama から応答がありません');
    return { translations: ollamaParseResponse(text) };
  }

  // ============================================================
  // Vision API 翻訳（画像を直接送信）
  // ============================================================
  async function translateImage(imageDataUrl, imageUrl) {
    // Ollama は content script から直接呼び出す（Service Worker タイムアウト回避）
    const { apiProvider } = await chrome.storage.local.get({ apiProvider: 'gemini' });
    if (apiProvider === 'ollama') {
      return translateWithOllamaDirect(imageDataUrl);
    }

    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'translate' });
      // Service Worker が 30 秒でスリープするのを防ぐため 10 秒ごとに ping
      const keepAliveId = setInterval(() => {
        try { chrome.runtime.sendMessage({ type: 'KEEP_ALIVE' }).catch(() => {}); }
        catch { clearInterval(keepAliveId); handleContextInvalidated(); }
      }, 10000);
      port.postMessage({ type: 'TRANSLATE_IMAGE', imageData: imageDataUrl, imageUrl: imageUrl });
      port.onMessage.addListener((response) => {
        clearInterval(keepAliveId);
        port.disconnect();
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
      port.onDisconnect.addListener(() => {
        clearInterval(keepAliveId);
        const err = chrome.runtime.lastError;
        reject(new Error(err?.message || '翻訳接続が切断されました'));
      });
    });
  }

  // ============================================================
  // ツールバー
  // ============================================================
  function createToolbar() {
    if (toolbar) return;

    toolbar = document.createElement('div');
    toolbar.id = 'mut-toolbar';

    // ツールバーボタンをDOM APIで構築（innerHTML回避）
    const translateBtn = document.createElement('button');
    translateBtn.id = 'mut-btn-translate';
    translateBtn.className = 'mut-btn mut-btn-primary';
    translateBtn.title = 'このページを翻訳';
    translateBtn.insertAdjacentHTML('afterbegin',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2l1 3"/>' +
      '<path d="M14 14l3 6 3-6M15.5 18h5"/></svg>');
    translateBtn.append(' 翻訳');

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'mut-btn-toggle';
    toggleBtn.className = 'mut-btn';
    toggleBtn.title = '翻訳の表示/非表示';
    toggleBtn.style.display = 'none';
    toggleBtn.insertAdjacentHTML('afterbegin',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
      '<circle cx="12" cy="12" r="3"/></svg>');

    const clearBtn = document.createElement('button');
    clearBtn.id = 'mut-btn-clear';
    clearBtn.className = 'mut-btn';
    clearBtn.title = '翻訳をクリア';
    clearBtn.style.display = 'none';
    clearBtn.insertAdjacentHTML('afterbegin',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>');

    toolbar.append(translateBtn, toggleBtn, clearBtn);
    const parent = getUIParent();
    parent.appendChild(toolbar);

    // 先読みプログレスバー（画面下部に固定）
    const bar = document.createElement('div');
    bar.id = 'mut-prefetch-bar';
    bar.className = 'mut-prefetch-bar';
    bar.style.display = 'none';
    const fill = document.createElement('div');
    fill.id = 'mut-prefetch-fill';
    fill.className = 'mut-prefetch-fill';
    bar.appendChild(fill);
    parent.appendChild(bar);

    document.getElementById('mut-btn-translate').addEventListener('click', translateCurrentPage);
    document.getElementById('mut-btn-toggle').addEventListener('click', toggleOverlays);
    document.getElementById('mut-btn-clear').addEventListener('click', clearOverlays);

    makeDraggable(toolbar);
  }

  function makeDraggable(el) {
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.mut-btn')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const origX = rect.left, origY = rect.top;
      const onMove = (e) => {
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = origX + (e.clientX - startX) + 'px';
        el.style.top = origY + (e.clientY - startY) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function showExtraButtons() {
    document.getElementById('mut-btn-toggle').style.display = '';
    document.getElementById('mut-btn-clear').style.display = '';
  }

  // ============================================================
  // コミック画像の検出（汎用: Blob URL img優先・ビューポート内最大面積選択）
  // ============================================================
  function findLargestVisibleImage() {
    let best = null;
    let maxArea = 0;

    const candidates = [
      // 1. Blob URL img（Kindle等）
      ...[...document.querySelectorAll('img')].filter(el => el.src && el.src.startsWith('blob:')),
      // 2. 通常のimg
      ...[...document.querySelectorAll('img')].filter(el => el.src && !el.src.startsWith('blob:')),
      // 3. SVG image要素
      ...document.querySelectorAll('svg image'),
      // 4. canvas
      ...document.querySelectorAll('canvas'),
    ];

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 200) continue;
      // ビューポート外（Kindleの前ページ・次ページ）を除外
      if (rect.left < 0 || rect.left >= window.innerWidth) continue;
      if (rect.top < -rect.height || rect.top >= window.innerHeight) continue;
      const area = rect.width * rect.height;
      // ビューポートの10%未満の要素（バナー等）を除外
      const minArea = Math.max(200 * 200, window.innerWidth * window.innerHeight * 0.1);
      if (area < minArea) continue;
      if (area > maxArea) {
        maxArea = area;
        const isSvgImage = el.tagName.toLowerCase() === 'image';
        const isCanvas = el instanceof HTMLCanvasElement;
        best = {
          type: isSvgImage ? 'svg' : isCanvas ? 'canvas' : 'img',
          element: el,
        };
      }
    }

    return best;
  }

  // ============================================================
  // 画像キャプチャ
  // ============================================================
  async function captureSvgImage(info) {
    const imageEl = info.element;

    // まずCanvasで既レンダリング済み画像をキャプチャ（URLトークン失効でも動作する）
    try {
      const bitmap = await createImageBitmap(imageEl);
      const MAX_DIM = 1024;
      let w = bitmap.width, h = bitmap.height;
      if (w > MAX_DIM || h > MAX_DIM) {
        const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      return canvas.toDataURL('image/webp', 0.65);
    } catch {
      // SecurityError (CORS) 等 → URLフェッチにフォールバック
    }

    // URLからフェッチ（フォールバック）
    const imageUrl = imageEl.getAttribute('xlink:href') || imageEl.getAttribute('href');
    if (!imageUrl) throw new Error('コミック画像のURLが取得できません');

    const response = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: imageUrl });
    if (response.error) {
      if (response.error.includes('401') || response.error.includes('403') || response.error.includes('認証')) {
        throw new Error('画像の認証が切れています。ページを更新（F5）してから再度お試しください。');
      }
      throw new Error(response.error);
    }
    return response.imageData;
  }

  function captureRasterElement(element) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const srcW = element instanceof HTMLCanvasElement ? element.width : (element.naturalWidth || element.width);
    const srcH = element instanceof HTMLCanvasElement ? element.height : (element.naturalHeight || element.height);

    const MAX_DIM = 1024;
    let w = srcW, h = srcH;
    if (w > MAX_DIM || h > MAX_DIM) {
      const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    canvas.width = w;
    canvas.height = h;
    try {
      ctx.drawImage(element, 0, 0, w, h);
      return canvas.toDataURL('image/webp', 0.65);
    } catch (err) {
      if (err.name === 'SecurityError') {
        throw new Error('セキュリティ制約により画像を取得できません（CORS制限）。別の方法で画像を取得しています...');
      }
      throw new Error(`画像の変換に失敗しました: ${err.message}`);
    }
  }

  async function captureComic(info) {
    if (info.type === 'svg') return captureSvgImage(info);
    return captureRasterElement(info.element);
  }

  function getOverlayTarget(info) {
    return info.element;
  }

  // ============================================================
  // 翻訳メイン処理
  // ============================================================
  async function translateCurrentPage() {
    if (isTranslating) return;

    const comicInfo = findLargestVisibleImage();
    if (!comicInfo) {
      showNotification('コミック画像が見つかりません', 'error');
      return;
    }

    isTranslating = true;
    const btn = document.getElementById('mut-btn-translate');
    btn.classList.add('loading');
    btn.querySelector('svg').style.display = 'none';

    // 翻訳中プログレスバー（赤）を表示
    const bar = document.getElementById('mut-prefetch-bar');
    const fill = document.getElementById('mut-prefetch-fill');
    if (bar && fill) {
      fill.style.background = '#e23636';
      fill.style.width = '0%';
      bar.style.display = '';
      bar.style.opacity = '';
      bar.classList.add('mut-prefetch-active');
    }

    try {
      showNotification('画像をキャプチャ中...', 'info');
      if (fill) fill.style.width = '30%';
      const imageData = await captureComic(comicInfo);

      let imageUrl = null;
      if (comicInfo.type === 'svg' && comicInfo.element) {
        imageUrl = comicInfo.element.getAttribute('xlink:href') || comicInfo.element.getAttribute('href');
      } else if (comicInfo.type === 'img' && comicInfo.element) {
        imageUrl = comicInfo.element.src || null;
      }

      // Gemini Vision でOCR＋翻訳を一括処理
      showNotification('テキストを認識・翻訳中...', 'info');
      if (fill) fill.style.width = '60%';
      const response = await translateImage(imageData, imageUrl);

      if (!response || response.error) {
        showNotification(response?.error || '翻訳応答がありません', 'error');
        return;
      }

      if (!response.translations || !Array.isArray(response.translations) || response.translations.length === 0) {
        showNotification('翻訳結果がありません', 'warn');
        return;
      }

      if (fill) fill.style.width = '90%';
      const adjustments = imageUrl ? await loadAdjustments(imageUrl) : {};
      const onAdjusted = imageUrl ? (idx, style) => saveAdjustment(imageUrl, idx, style) : null;
      renderOverlays(getOverlayTarget(comicInfo), response.translations, adjustments, onAdjusted);
      showExtraButtons();

      const message = response.fromCache
        ? `${response.translations.length}件のテキストを表示しました（キャッシュ）`
        : `${response.translations.length}件のテキストを翻訳しました`;
      showNotification(message, 'success');
      // 翻訳・表示完了後に先読みをトリガー（現在ページのAPI処理が終わってから）
      triggerPrefetch(imageUrl);
    } catch (err) {
      showNotification('翻訳に失敗: ' + err.message, 'error');
    } finally {
      isTranslating = false;
      btn.classList.remove('loading');
      btn.querySelector('svg').style.display = '';
      // プログレスバー完了→フェードアウト→色をリセット
      if (bar && fill) {
        fill.style.width = '100%';
        bar.classList.remove('mut-prefetch-active');
        setTimeout(() => {
          bar.style.opacity = '0';
          setTimeout(() => {
            bar.style.display = 'none';
            bar.style.opacity = '';
            fill.style.width = '0%';
            fill.style.background = '';
          }, 400);
        }, 800);
      }
    }
  }

  // ============================================================
  // 先読み翻訳
  // ============================================================
  // PerformanceObserverでコミック画像URLを増分収集
  const comicPageUrls = new Map(); // pathname → full URL

  const perfObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const url = entry.name;
      // Blob URLはキャッシュキーに使えないためスキップ
      if (url.startsWith('blob:')) continue;
      // 画像系の拡張子のみ収集
      if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)) continue;
      if (url.includes('/thumbnails/')) continue;
      let p;
      try { p = new URL(url).pathname; } catch { p = url.split('?')[0]; }
      if (!comicPageUrls.has(p)) comicPageUrls.set(p, url);
    }
  });
  perfObserver.observe({ type: 'resource', buffered: true });

  function getComicPageUrls() {
    return Array.from(comicPageUrls.values());
  }

  let lastQueueKey = '';  // 前回送信したキューのキー（重複送信防止）

  // セーフモード先読み用：現在の最大imgの次のBlob URL imgを探す
  function findNextBlobImage() {
    const blobImgs = [...document.querySelectorAll('img')]
      .filter(img => img.src && img.src.startsWith('blob:') && img.complete)
      .sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
    if (blobImgs.length < 2) return null;
    const currentEl = findLargestVisibleImage()?.element;
    if (!currentEl) return blobImgs[1] || null;
    const idx = blobImgs.indexOf(currentEl);
    if (idx === -1 || idx === blobImgs.length - 1) return null;
    return blobImgs[idx + 1];
  }

  let safeModePreloadTimer = null;

  async function scheduleSafeModeNextPage() {
    clearTimeout(safeModePreloadTimer);
    // prefetch設定を確認（デフォルトOFF）
    const { prefetch } = await chrome.storage.local.get({ prefetch: false });
    if (!prefetch) return;
    safeModePreloadTimer = setTimeout(async () => {
      try {
        const nextImg = findNextBlobImage();
        if (!nextImg) return;

        // Canvas変換してBase64取得（Blob URLはCORS制限なし）
        // captureRasterElement はエラー時にthrowするため、失敗は外側のcatchで捕捉される
        const imageData = captureRasterElement(nextImg);
        // background.jsに送信（内部でキャッシュチェック・session保存）
        const port = chrome.runtime.connect({ name: 'translate' });
        port.postMessage({ type: 'TRANSLATE_IMAGE', imageData, imageUrl: nextImg.src });
        port.onMessage.addListener(() => port.disconnect());
        port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
      } catch {
        // セーフモード先読みの失敗は無視
      }
    }, 4200); // 4.2秒ディレイ（レート制限対応）
  }

  function triggerPrefetch(currentImageUrl) {
    try {
      // Blob URL（Kindle等）はセーフモード先読みフローへ
      if (currentImageUrl && currentImageUrl.startsWith('blob:')) {
        scheduleSafeModeNextPage();
        return;
      }

      const allPages = getComicPageUrls();
      if (allPages.length === 0) return;

      // URLからファイル名部分を抽出（トークンを除去して比較）
      const getFilename = (url) => {
        try { return new URL(url).pathname.split('/').pop(); }
        catch { return url.split('/').pop().split('?')[0]; }
      };

      // 現在のページのindexを特定
      let currentIndex = -1;
      const currentFile = currentImageUrl ? getFilename(currentImageUrl) : null;
      if (currentFile) {
        currentIndex = allPages.findIndex(url => getFilename(url) === currentFile);
      }
      if (currentIndex === -1) return;

      // 優先度付きキュー: 現在ページ → 次5 → 前2（最大8ページ）
      const queueUrls = [];
      const addIfValid = (idx) => {
        if (idx >= 0 && idx < allPages.length) {
          queueUrls.push(allPages[idx]);
        }
      };

      // 1. 現在ページ
      addIfValid(currentIndex);
      // 2. 次ページ × 5
      for (let i = 1; i <= 5; i++) addIfValid(currentIndex + i);
      // 3. 前ページ × 2
      for (let i = 1; i <= 2; i++) addIfValid(currentIndex - i);

      if (queueUrls.length === 0) return;

      // 前回と同じキューなら送信スキップ（ファイル名ベースで比較）
      const queueKey = queueUrls.map(u => getFilename(u)).join(',');
      if (queueKey === lastQueueKey) return;
      lastQueueKey = queueKey;

      chrome.runtime.sendMessage({
        type: 'PRELOAD_QUEUE',
        imageUrls: queueUrls,
      }).catch(() => {});
    } catch {
      // 先読みトリガーの失敗は無視
    }
  }

  // ============================================================
  // 吹き出し位置・サイズ調整値の保存・復元
  // ============================================================
  async function getAdjKey(imageUrl) {
    if (!imageUrl) return null;
    let normalized;
    try { const u = new URL(imageUrl); normalized = u.origin + u.pathname; }
    catch { normalized = imageUrl.split('?')[0]; }
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `adj:${hex.substring(0, 32)}`;
  }

  async function loadAdjustments(imageUrl) {
    try {
      const key = await getAdjKey(imageUrl);
      if (!key) return {};
      const result = await chrome.storage.local.get(key);
      return result[key] || {};
    } catch { return {}; }
  }

  async function saveAdjustment(imageUrl, index, style) {
    try {
      const key = await getAdjKey(imageUrl);
      if (!key) return;
      const result = await chrome.storage.local.get(key);
      const adjs = result[key] || {};
      adjs[index] = style;
      await chrome.storage.local.set({ [key]: adjs });
    } catch { /* context invalidated 等は無視 */ }
  }

  // ============================================================
  // オーバーレイ描画
  // ============================================================
  // LLM が返す CSS 値から url() を除去してネットワーク要求を防ぐ
  function sanitizeCssValue(value) {
    if (typeof value !== 'string') return null;
    if (/url\s*\(/i.test(value)) return null;
    return value;
  }

  // 背景色(CSS値)から少し暗くしたボーダー色を生成
  // 背景色から適切なテキスト色（白 or 黒）を返す
  function getContrastColor(cssValue) {
    const match = cssValue.match(/#[0-9a-fA-F]{3,8}/);
    if (!match) return null;
    const hex = match[0];
    const hex6 = hex.length === 4
      ? '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
      : hex;
    const r = parseInt(hex6.slice(1, 3), 16);
    const g = parseInt(hex6.slice(3, 5), 16);
    const b = parseInt(hex6.slice(5, 7), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    // WCAG相対輝度（0.299/0.587/0.114 近似）
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance < 128 ? 'white' : 'black';
  }

  function darkenColor(cssValue) {
    // linear-gradient の場合、最初の色を抽出
    const gradMatch = cssValue.match(/#[0-9a-fA-F]{3,8}/);
    const hex = gradMatch ? gradMatch[0] : null;
    if (!hex) return null;
    // 3文字HEX（#abc）を6文字（#aabbcc）に展開
    const hex6 = hex.length === 4
      ? '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
      : hex;
    // hex → RGB → 30%暗く → hex
    const r = parseInt(hex6.slice(1, 3), 16);
    const g = parseInt(hex6.slice(3, 5), 16);
    const b = parseInt(hex6.slice(5, 7), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    const d = (v) => Math.round(v * 0.7).toString(16).padStart(2, '0');
    return `#${d(r)}${d(g)}${d(b)}`;
  }

  function renderOverlays(targetEl, translations, adjustments = {}, onAdjusted = null) {
    if (!targetEl || !translations) return;
    clearOverlays();
    const rect = targetEl.getBoundingClientRect();

    overlayContainer = document.createElement('div');
    overlayContainer.id = 'mut-overlay-container';
    Object.assign(overlayContainer.style, {
      position: 'fixed',
      top: rect.top + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      pointerEvents: 'none',
      zIndex: '99998',
      overflow: 'hidden',
    });

    // 各アイテムのbbox（%単位）を計算し、重なりを検出してから描画
    const expandRateX = 0.20; // 左右20%拡大
    const expandRateY = 0.35; // 上下35%拡大（日本語は縦に長くなりやすいため多めに確保）
    const layoutItems = translations
      .filter(item => item.bbox && item.bbox.top != null && item.bbox.left != null && item.type !== 'sfx')
      .map(item => {
        const expandX = (item.bbox.width || 5) * expandRateX;
        const expandY = (item.bbox.height || 5) * expandRateY;
        let top = (item.bbox.top || 0) - expandY;
        let left = (item.bbox.left || 0) - expandX;
        let bboxW = (item.bbox.width || 5) + expandX * 2;
        let bboxH = (item.bbox.height || 5) + expandY * 2;
        // 画像範囲内にクランプ
        if (top < 0) { bboxH += top; top = 0; }
        if (left < 0) { bboxW += left; left = 0; }
        if (left + bboxW > 100) bboxW = 100 - left;
        if (top + bboxH > 100) bboxH = 100 - top;
        return { ...item, layout: { top, left, width: bboxW, height: bboxH } };
      });

    // 重なり検出：垂直方向に重なる場合、上下を縮小（O(n²)のため50件で打ち切り、最大3パス）
    const overlapLimit = Math.min(layoutItems.length, 50);
    for (let pass = 0; pass < 3; pass++) {
      let hadOverlap = false;
      for (let i = 0; i < overlapLimit; i++) {
        for (let j = i + 1; j < overlapLimit; j++) {
          const a = layoutItems[i].layout;
          const b = layoutItems[j].layout;
          // 水平方向に重なりがあるか
          const hOverlap = a.left < b.left + b.width && a.left + a.width > b.left;
          if (!hOverlap) continue;
          // 垂直方向の重なり量
          const aBottom = a.top + a.height;
          const bBottom = b.top + b.height;
          const vOverlap = Math.min(aBottom, bBottom) - Math.max(a.top, b.top);
          if (vOverlap <= 0) continue;
          hadOverlap = true;
          // 重なりを半分ずつ縮小
          const half = vOverlap / 2 + 0.3; // 0.3%の余白
          if (a.top < b.top) {
            a.height -= half;
            b.top += half;
            b.height -= half;
          } else {
            b.height -= half;
            a.top += half;
            a.height -= half;
          }
        }
      }
      if (!hadOverlap) break;
    }

    layoutItems.forEach((item, index) => {
      const overlay = document.createElement('div');
      // type を英数字・ハイフンのみに制限してクラス名インジェクションを防ぐ
      const safeType = (item.type || 'speech').replace(/[^a-z0-9-]/gi, '') || 'speech';
      overlay.className = `mut-overlay mut-type-${safeType}`;
      const { top, left, width, height } = item.layout;
      Object.assign(overlay.style, {
        position: 'absolute',
        top: top + '%',
        left: left + '%',
        width: width + '%',
        height: height + '%',
        pointerEvents: 'auto',
      });
      // 保存済み調整値があれば上書き適用
      const adj = adjustments[index];
      if (adj) {
        if (adj.top != null)    overlay.style.top    = adj.top;
        if (adj.left != null)   overlay.style.left   = adj.left;
        if (adj.width != null)  overlay.style.width  = adj.width;
        if (adj.height != null) overlay.style.height = adj.height;
      }

      const textEl = document.createElement('div');
      textEl.className = 'mut-overlay-text';
      textEl.textContent = item.translated;
      // LLM 応答の CSS 値を sanitize（url() によるネットワーク要求を防ぐ）
      const safeBg = sanitizeCssValue(item.background);
      const safeBorder = sanitizeCssValue(item.border);
      if (safeBg) {
        textEl.style.background = safeBg;
        // 背景色のコントラストに応じてテキスト色を設定（黒背景→白文字）
        const contrastColor = getContrastColor(safeBg);
        if (contrastColor) textEl.style.color = contrastColor;
        // 背景色からボーダー色を自動生成（少し暗くした色）
        const borderColor = safeBorder || darkenColor(safeBg);
        if (borderColor) {
          textEl.style.border = `2px solid ${borderColor}`;
        }
      } else if (safeBorder) {
        textEl.style.border = `2px solid ${safeBorder}`;
      }
      overlay.appendChild(textEl);

      const origEl = document.createElement('div');
      origEl.className = 'mut-overlay-original';
      origEl.textContent = item.original;
      overlay.appendChild(origEl);

      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'mut-resize-handle';
      overlay.appendChild(resizeHandle);

      makeDraggableResizable(overlay, resizeHandle, index, onAdjusted);
      overlayContainer.appendChild(overlay);
    });

    getUIParent().appendChild(overlayContainer);
    overlaysVisible = true;
    // ブラウザのレイアウト確定後にフォントフィットを実行
    requestAnimationFrame(() => fitAllOverlayText());
    observePosition(targetEl);
  }

  function makeDraggableResizable(overlay, resizeHandle, index = 0, onAdjusted = null) {
    const getContainerRect = () => overlayContainer.getBoundingClientRect();

    // ドラッグで移動
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === resizeHandle) return;
      e.preventDefault();
      e.stopPropagation();
      overlay.dataset.dragging = '1';
      const rect = getContainerRect();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = parseFloat(overlay.style.left);
      const startTop = parseFloat(overlay.style.top);
      const onMove = (e) => {
        overlay.style.left = Math.max(0, startLeft + (e.clientX - startX) / rect.width * 100) + '%';
        overlay.style.top  = Math.max(0, startTop  + (e.clientY - startY) / rect.height * 100) + '%';
      };
      const onUp = () => {
        delete overlay.dataset.dragging;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (onAdjusted) onAdjusted(index, {
          top: overlay.style.top, left: overlay.style.left,
          width: overlay.style.width, height: overlay.style.height,
        });
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // 右下ハンドルでリサイズ
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = getContainerRect();
      const startX = e.clientX, startY = e.clientY;
      const startW = parseFloat(overlay.style.width);
      const startH = parseFloat(overlay.style.height);
      const onMove = (e) => {
        overlay.style.width  = Math.max(5, startW + (e.clientX - startX) / rect.width  * 100) + '%';
        overlay.style.height = Math.max(3, startH + (e.clientY - startY) / rect.height * 100) + '%';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        requestAnimationFrame(() => fitAllOverlayText());
        if (onAdjusted) onAdjusted(index, {
          top: overlay.style.top, left: overlay.style.left,
          width: overlay.style.width, height: overlay.style.height,
        });
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function fitAllOverlayText() {
    if (!overlayContainer) return;
    const overlays = overlayContainer.querySelectorAll('.mut-overlay');

    // フェーズ1: 読み取り（ボックスサイズ取得）+ 初期フォントサイズ設定
    const items = [];
    overlays.forEach((overlay) => {
      const textEl = overlay.querySelector('.mut-overlay-text');
      if (!textEl) return;
      const boxW = overlay.clientWidth;
      const boxH = overlay.clientHeight;
      if (boxW === 0 || boxH === 0) return;
      // padding(5px*2)+border(2px*2)=14px 水平、padding(5px*2)+border(2px*2)=14px 垂直
      const innerW = Math.max(boxW - 18, 10);
      const innerH = Math.max(boxH - 14, 10);
      const charCount = (textEl.textContent || '').length;
      // 0.58: 日本語は英語より文字幅が大きいため保守的な初期値にする
      let fontSize = Math.min(Math.sqrt((innerW * innerH) / Math.max(charCount, 1)) * 0.58, 16);
      fontSize = Math.max(fontSize, 11);
      textEl.style.fontSize = fontSize + 'px';
      items.push({ overlay, textEl, boxW, boxH, fontSize });
    });

    // フェーズ2: 読み取り→書き込みを要素ごとに縮小（バッチ化で最小限のリフロー）
    for (const item of items) {
      for (let i = 0; i < 30; i++) {
        if (item.textEl.scrollWidth <= item.boxW + 1 && item.textEl.scrollHeight <= item.boxH + 1) break;
        item.fontSize -= 0.3;
        if (item.fontSize < 11) break;
        item.textEl.style.fontSize = item.fontSize + 'px';
      }
      // フィット後に15%縮小して余裕を確保（最低11px）
      const relaxed = Math.max(item.fontSize * 0.85, 11);
      item.textEl.style.fontSize = relaxed + 'px';
    }

    // フェーズ3: テキストがボックスに収まらない場合にボックスを拡大
    const cW = overlayContainer.clientWidth || 1;
    const cH = overlayContainer.clientHeight || 1;
    for (const item of items) {
      // 現在の left/top を取得（%文字列→数値）
      const curLeft = parseFloat(item.overlay.style.left) || 0;
      const curTop  = parseFloat(item.overlay.style.top)  || 0;
      // 高さ拡大: height:auto でテキストが増えた場合は常に拡大
      if (item.textEl.scrollHeight > item.boxH + 1) {
        const newH = (item.textEl.scrollHeight + 8) / cH * 100;
        item.overlay.style.height = Math.min(newH, 100 - curTop) + '%';
      }
      // 幅拡大: 最小フォントでも幅が足りない場合のみ拡大
      if (item.fontSize <= 12 && item.textEl.scrollWidth > item.boxW + 1) {
        const newW = (item.textEl.scrollWidth + 8) / cW * 100;
        item.overlay.style.width = Math.min(newW, 100 - curLeft) + '%';
      }
      // 折り返し過多チェック: 1行に伸ばしたときの自然幅がボックスの2倍を超える場合は幅を広げる
      item.textEl.style.whiteSpace = 'nowrap';
      const naturalW = item.textEl.scrollWidth;
      item.textEl.style.whiteSpace = '';
      if (naturalW > item.boxW * 1.5) {
        const targetW = Math.min(naturalW + 10, cW * 0.30, cW - item.overlay.offsetLeft);
        item.overlay.style.width = (targetW / cW * 100) + '%';
      }
    }
  }

  function observePosition(targetEl) {
    function updatePosition() {
      if (!overlayContainer) return;
      const rect = targetEl.getBoundingClientRect();
      Object.assign(overlayContainer.style, {
        top: rect.top + 'px',
        left: rect.left + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
      });
    }
    updatePosition();
    const resizeObserver = new ResizeObserver(() => updatePosition());
    resizeObserver.observe(targetEl);
    const scrollHandler = () => updatePosition();
    window.addEventListener('scroll', scrollHandler, { passive: true });
    window.addEventListener('resize', scrollHandler, { passive: true });
    overlayContainer._cleanup = () => {
      resizeObserver.disconnect();
      window.removeEventListener('scroll', scrollHandler);
      window.removeEventListener('resize', scrollHandler);
    };
  }

  function toggleOverlays() {
    if (!overlayContainer) return;
    overlaysVisible = !overlaysVisible;
    overlayContainer.style.display = overlaysVisible ? '' : 'none';
  }

  function clearOverlays() {
    if (overlayContainer) {
      if (overlayContainer._cleanup) overlayContainer._cleanup();
      overlayContainer.remove();
      overlayContainer = null;
    }
    const toggleBtn = document.getElementById('mut-btn-toggle');
    const clearBtn = document.getElementById('mut-btn-clear');
    if (toggleBtn) toggleBtn.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
  }

  // ============================================================
  // 通知
  // ============================================================
  let contextInvalidatedShown = false;
  function handleContextInvalidated() {
    if (contextInvalidatedShown) return;
    contextInvalidatedShown = true;
    stopPrefetchKeepAlive();
    showNotification('拡張機能が更新されました。ページを再読み込みしてください。', 'error');
  }

  function showNotification(message, type = 'info') {
    let notif = document.getElementById('mut-notification');
    if (!notif) {
      notif = document.createElement('div');
      notif.id = 'mut-notification';
      getUIParent().appendChild(notif);
    }
    notif.textContent = message;
    notif.className = `mut-notif-${type}`;
    notif.classList.add('mut-notif-show');
    clearTimeout(notif._timer);
    if (type !== 'error') {
      notif._timer = setTimeout(() => notif.classList.remove('mut-notif-show'), 4000);
    }
  }

  // ============================================================
  // UI配置
  // ============================================================
  function getUIParent() {
    // showModal()で開いたdialogはtop-layerを使うため、body配置のUIが隠れる
    return document.querySelector('dialog[open]') || document.body;
  }

  // ============================================================
  // 汎用ページ遷移検知
  // ============================================================
  function startUniversalPageWatcher() {
    // URL変化を検知（念のため: Marvel等でのSPA遷移に対応）
    const onUrlChange = () => {
      clearOverlays();
      isTranslating = false;
      lastQueueKey = '';
    };
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);

    // Blob URL imgの新規追加を監視（Kindleのページ遷移で発生）
    // ※ Kindleはページをめくるたびに新しいBlob URL imgを3〜4件DOM追加する
    let clearTimer = null;
    const bodyObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const hasBlobImg =
            (node.tagName === 'IMG' && node.src?.startsWith('blob:')) ||
            node.querySelector?.('img[src^="blob:"]');
          if (hasBlobImg) {
            // デバウンス: 複数追加を1回のclearにまとめる
            clearTimeout(clearTimer);
            clearTimer = setTimeout(() => {
              clearOverlays();
              isTranslating = false;
              lastQueueKey = '';
            }, 100);
            return;
          }
        }
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    // SVG image要素のhref変化を監視（Marvel等でのSPA内ページ遷移に対応）
    // ※ MutationObserver の attributeFilter は xlink:href を直接監視できないブラウザもあるため
    //   href と xlink:href の両方を指定し、SVG image要素のみでclearする
    const svgObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.target.tagName?.toLowerCase() === 'image') {
          clearOverlays();
          isTranslating = false;
          lastQueueKey = '';
          return;
        }
      }
    });
    svgObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'xlink:href'],
    });

    // dialog[open]の変化を監視してtoolbarを適切な親に移動
    // ※ showModal()で開いたdialogはtop-layerを使うためbody配置のUIが隠れる
    const dialogWatcher = new MutationObserver(() => {
      if (!toolbar) return;
      const parent = document.querySelector('dialog[open]') || document.body;
      if (toolbar.parentElement !== parent) {
        parent.appendChild(toolbar);
      }
    });
    dialogWatcher.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
  }

  // ============================================================
  // 初期化
  // ============================================================
  function init() {
    createToolbar();
    startUniversalPageWatcher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 先読み中のService Worker Keepalive（4.2秒待機中のスリープ防止）
  let prefetchKeepAliveId = null;
  let prefetchKeepAliveTimeout = null;

  function startPrefetchKeepAlive() {
    if (prefetchKeepAliveId) return;
    prefetchKeepAliveId = setInterval(() => {
      try { chrome.runtime.sendMessage({ type: 'KEEP_ALIVE' }).catch(() => {}); }
      catch { stopPrefetchKeepAlive(); handleContextInvalidated(); }
    }, 10000);
    // 安全弁: 5分後に強制停止
    prefetchKeepAliveTimeout = setTimeout(stopPrefetchKeepAlive, 5 * 60 * 1000);
  }

  function stopPrefetchKeepAlive() {
    clearInterval(prefetchKeepAliveId);
    clearTimeout(prefetchKeepAliveTimeout);
    prefetchKeepAliveId = null;
    prefetchKeepAliveTimeout = null;
  }

  // 先読み進捗の受信
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PRELOAD_PROGRESS') {
      const bar = document.getElementById('mut-prefetch-bar');
      const fill = document.getElementById('mut-prefetch-fill');
      if (!bar || !fill) return;

      const { state, current, total } = message;
      if (total <= 0) return;

      if (state === 'active') {
        startPrefetchKeepAlive();
        fill.style.background = '';  // 白（CSS既定）に戻す
        bar.style.display = '';
        bar.style.opacity = '';
        bar.classList.add('mut-prefetch-active');
        const pct = Math.round((current / total) * 100);
        fill.style.width = Math.max(pct, 2) + '%';
      }

      if (state === 'done') {
        stopPrefetchKeepAlive();
        fill.style.width = '100%';
        bar.classList.remove('mut-prefetch-active');
        setTimeout(() => {
          bar.style.opacity = '0';
          setTimeout(() => {
            bar.style.display = 'none';
            bar.style.opacity = '';
            fill.style.width = '0%';
          }, 400);
        }, 800);
      }
    }
  });
})();
