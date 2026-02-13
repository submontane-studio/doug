// content.js - Marvel Unlimited コミック翻訳オーバーレイ
// Tesseract.js OCR（ローカル） + Gemini API 翻訳

(function () {
  'use strict';

  let isTranslating = false;
  let overlayContainer = null;
  let toolbar = null;
  let overlaysVisible = true;
  let ocrWorker = null;

  // ============================================================
  // Tesseract.js OCR 初期化
  // ============================================================
  async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;

    const extUrl = chrome.runtime.getURL('');
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      workerPath: extUrl + 'lib/worker.min.js',
      corePath: extUrl + 'lib/',
      langPath: extUrl + 'lang/',
      cacheMethod: 'none',
    });
    return ocrWorker;
  }

  async function runOcr(imageDataUrl) {
    const worker = await getOcrWorker();
    const result = await worker.recognize(imageDataUrl);

    // word レベルで bbox + テキストを抽出
    const words = [];
    if (result.data && result.data.lines) {
      for (const line of result.data.lines) {
        // 行単位でまとめる（吹き出しのテキストは行単位が適切）
        const text = line.text.trim();
        if (!text || text.length < 2) continue; // 短すぎるテキストはスキップ

        const bbox = line.bbox;
        words.push({
          text: text,
          bbox: bbox, // {x0, y0, x1, y1} ピクセル座標
        });
      }
    }
    return words;
  }

  // OCR結果のbboxをパーセンテージに変換
  function convertBboxToPercent(ocrResults, imgWidth, imgHeight) {
    return ocrResults.map(item => ({
      text: item.text,
      bbox: {
        top: (item.bbox.y0 / imgHeight) * 100,
        left: (item.bbox.x0 / imgWidth) * 100,
        width: ((item.bbox.x1 - item.bbox.x0) / imgWidth) * 100,
        height: ((item.bbox.y1 - item.bbox.y0) / imgHeight) * 100,
      },
    }));
  }

  // ============================================================
  // ツールバー
  // ============================================================
  function createToolbar() {
    if (toolbar) return;

    toolbar = document.createElement('div');
    toolbar.id = 'mut-toolbar';
    toolbar.innerHTML = `
      <button id="mut-btn-translate" class="mut-btn mut-btn-primary" title="このページを翻訳">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2l1 3"/>
          <path d="M14 14l3 6 3-6M15.5 18h5"/>
        </svg>
        翻訳
      </button>
      <button id="mut-btn-toggle" class="mut-btn" title="翻訳の表示/非表示" style="display:none">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      <button id="mut-btn-clear" class="mut-btn" title="翻訳をクリア" style="display:none">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;
    getUIParent().appendChild(toolbar);

    document.getElementById('mut-btn-translate').addEventListener('click', translateCurrentPage);
    document.getElementById('mut-btn-toggle').addEventListener('click', toggleOverlays);
    document.getElementById('mut-btn-clear').addEventListener('click', clearOverlays);

    makeDraggable(toolbar);
  }

  function makeDraggable(el) {
    let isDragging = false;
    let startX, startY, origX, origY;

    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.mut-btn')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = origX + (e.clientX - startX) + 'px';
      el.style.top = origY + (e.clientY - startY) + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  function showExtraButtons() {
    document.getElementById('mut-btn-toggle').style.display = '';
    document.getElementById('mut-btn-clear').style.display = '';
  }

  // ============================================================
  // コミック画像の検出
  // ============================================================
  function findComicImage() {
    const svgImage = document.querySelector('.rocket-reader image.pageImage');
    if (svgImage) {
      const svg = svgImage.closest('svg');
      return { type: 'svg', element: svgImage, svg: svg };
    }

    const rocketSvg = document.querySelector('.rocket-reader svg.svg-el');
    if (rocketSvg) {
      const img = rocketSvg.querySelector('image');
      if (img) return { type: 'svg', element: img, svg: rocketSvg };
    }

    let best = null;
    let maxArea = 0;
    const candidates = [
      ...document.querySelectorAll('canvas'),
      ...document.querySelectorAll('.rocket-reader img'),
      ...document.querySelectorAll('img[src*="i.annihil.us"]'),
    ];
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 200) continue;
      const area = rect.width * rect.height;
      if (area > maxArea) { maxArea = area; best = el; }
    }
    if (best) {
      return { type: best instanceof HTMLCanvasElement ? 'canvas' : 'img', element: best };
    }
    return null;
  }

  // ============================================================
  // 画像キャプチャ
  // ============================================================
  async function captureSvgImage(info) {
    const imageEl = info.element;
    const imageUrl = imageEl.getAttribute('xlink:href') || imageEl.getAttribute('href');
    if (!imageUrl) throw new Error('コミック画像のURLが取得できません');

    const response = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: imageUrl });
    if (response.error) throw new Error(response.error);
    return response.imageData;
  }

  function captureRasterElement(element) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const srcW = element instanceof HTMLCanvasElement ? element.width : (element.naturalWidth || element.width);
    const srcH = element instanceof HTMLCanvasElement ? element.height : (element.naturalHeight || element.height);

    const MAX_DIM = 2000;
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
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch {
      return null;
    }
  }

  async function captureComic(info) {
    if (info.type === 'svg') return captureSvgImage(info);
    const direct = captureRasterElement(info.element);
    if (direct) return direct;
    throw new Error('画像のキャプチャに失敗しました');
  }

  // 画像の実サイズを取得
  function getImageDimensions(imageDataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 1000, height: 1500 }); // フォールバック
      img.src = imageDataUrl;
    });
  }

  function getOverlayTarget(info) {
    if (info.type === 'svg') return info.element;
    return info.element;
  }

  // ============================================================
  // 翻訳メイン処理
  // ============================================================
  async function translateCurrentPage() {
    if (isTranslating) return;

    const comicInfo = findComicImage();
    if (!comicInfo) {
      showNotification('コミック画像が見つかりません', 'error');
      return;
    }

    isTranslating = true;
    const btn = document.getElementById('mut-btn-translate');
    btn.classList.add('loading');
    btn.querySelector('svg').style.display = 'none';

    try {
      showNotification('画像をキャプチャ中...', 'info');
      const imageData = await captureComic(comicInfo);

      let imageUrl = null;
      if (comicInfo.type === 'svg' && comicInfo.element) {
        imageUrl = comicInfo.element.getAttribute('xlink:href') || comicInfo.element.getAttribute('href');
      }

      // Step 1: ローカルOCR（API不使用）
      showNotification('テキストを認識中（ローカルOCR）...', 'info');
      const rawOcrResults = await runOcr(imageData);

      if (rawOcrResults.length === 0) {
        showNotification('テキストが検出されませんでした', 'warn');
        return;
      }

      // bbox をパーセンテージに変換
      const dims = await getImageDimensions(imageData);
      const ocrResults = convertBboxToPercent(rawOcrResults, dims.width, dims.height);

      // Step 2: Gemini API でバッチ翻訳（1回のAPI呼び出し）
      showNotification(`${ocrResults.length}件のテキストを翻訳中...`, 'info');
      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_TEXTS',
        ocrResults: ocrResults,
        imageUrl: imageUrl,
      });

      if (response.error) {
        showNotification(response.error, 'error');
        return;
      }

      if (!response.translations || response.translations.length === 0) {
        showNotification('翻訳結果がありません', 'warn');
        return;
      }

      renderOverlays(getOverlayTarget(comicInfo), response.translations);
      showExtraButtons();

      const message = response.fromCache
        ? `${response.translations.length}件のテキストを表示しました（キャッシュ）`
        : `${response.translations.length}件のテキストを翻訳しました`;
      showNotification(message, 'success');
    } catch (err) {
      showNotification('翻訳に失敗: ' + err.message, 'error');
    } finally {
      isTranslating = false;
      btn.classList.remove('loading');
      btn.querySelector('svg').style.display = '';
    }
  }

  // ============================================================
  // オーバーレイ描画
  // ============================================================
  function renderOverlays(targetEl, translations) {
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

    translations.forEach((item) => {
      const overlay = document.createElement('div');
      overlay.className = `mut-overlay mut-type-${item.type || 'speech'}`;
      Object.assign(overlay.style, {
        position: 'absolute',
        top: item.bbox.top + '%',
        left: item.bbox.left + '%',
        width: item.bbox.width + '%',
        height: item.bbox.height + '%',
        pointerEvents: 'auto',
      });

      const textEl = document.createElement('div');
      textEl.className = 'mut-overlay-text';
      textEl.textContent = item.translated;
      overlay.appendChild(textEl);

      const origEl = document.createElement('div');
      origEl.className = 'mut-overlay-original';
      origEl.textContent = item.original;
      overlay.appendChild(origEl);

      overlayContainer.appendChild(overlay);
    });

    getUIParent().appendChild(overlayContainer);
    overlaysVisible = true;
    fitAllOverlayText();
    observePosition(targetEl);
  }

  function fitAllOverlayText() {
    if (!overlayContainer) return;
    overlayContainer.querySelectorAll('.mut-overlay').forEach((overlay) => {
      const textEl = overlay.querySelector('.mut-overlay-text');
      if (!textEl) return;
      const maxW = overlay.clientWidth;
      const maxH = overlay.clientHeight;
      if (maxW === 0 || maxH === 0) return;
      let fontSize = Math.min(maxW / 4, maxH / 2, 20);
      textEl.style.fontSize = fontSize + 'px';
      while (fontSize > 6 && (textEl.scrollHeight > maxH || textEl.scrollWidth > maxW)) {
        fontSize -= 0.5;
        textEl.style.fontSize = fontSize + 'px';
      }
    });
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
    notif._timer = setTimeout(() => notif.classList.remove('mut-notif-show'), 4000);
  }

  // ============================================================
  // UI配置
  // ============================================================
  function getUIParent() {
    const dialog = document.querySelector('dialog.ComicPurchasePaths__Reader[open]');
    return dialog || document.body;
  }

  function moveUIToReader() {
    const dialog = document.querySelector('dialog.ComicPurchasePaths__Reader[open]');
    if (!dialog) return;
    if (toolbar && toolbar.parentElement !== dialog) dialog.appendChild(toolbar);
    if (overlayContainer && overlayContainer.parentElement !== dialog) dialog.appendChild(overlayContainer);
  }

  function moveUIToBody() {
    if (toolbar && toolbar.parentElement !== document.body) document.body.appendChild(toolbar);
  }

  // ============================================================
  // 初期化
  // ============================================================
  function init() {
    createToolbar();
    moveUIToReader();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  const pageObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.target.classList?.contains('pageImage')) {
        clearOverlays();
        return;
      }
    }
    const dialog = document.querySelector('dialog.ComicPurchasePaths__Reader[open]');
    if (dialog) {
      moveUIToReader();
    } else if (toolbar && toolbar.parentElement !== document.body) {
      moveUIToBody();
      clearOverlays();
    }
  });
  pageObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'xlink:href', 'open'],
  });
})();
