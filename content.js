// content.js - Doug コミック翻訳オーバーレイ
// Tesseract.js OCR（offscreen） + Gemini API 翻訳

(function () {
  'use strict';

  let isTranslating = false;
  let overlayContainer = null;
  let toolbar = null;
  let overlaysVisible = true;

  // ============================================================
  // Gemini Vision 翻訳（画像を直接送信）
  // ============================================================
  // 画像の実サイズを取得
  function getImageDimensions(imageDataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = imageDataUrl;
    });
  }

  async function translateImage(imageDataUrl, imageUrl) {
    const dims = await getImageDimensions(imageDataUrl);
    const response = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_IMAGE',
      imageData: imageDataUrl,
      imageUrl: imageUrl,
      imageDims: dims,
    });
    if (!response) throw new Error('翻訳応答がありません');
    if (response.error) throw new Error(response.error);
    return response;
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
    const parent = getUIParent();
    parent.appendChild(toolbar);

    // 先読みプログレスバー（画面下部に固定）
    const bar = document.createElement('div');
    bar.id = 'mut-prefetch-bar';
    bar.className = 'mut-prefetch-bar';
    bar.style.display = 'none';
    bar.innerHTML = '<div id="mut-prefetch-fill" class="mut-prefetch-fill"></div>';
    parent.appendChild(bar);

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

      // Gemini Vision でOCR＋翻訳を一括処理
      showNotification('テキストを認識・翻訳中...', 'info');
      const response = await translateImage(imageData, imageUrl);

      if (!response || response.error) {
        showNotification(response?.error || '翻訳応答がありません', 'error');
        return;
      }

      if (!response.translations || !Array.isArray(response.translations) || response.translations.length === 0) {
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
  // 先読み翻訳
  // ============================================================
  function getComicPageUrls() {
    // performance APIから画像リソースURLを収集
    const entries = performance.getEntriesByType('resource');
    // Marvel reader のコミック画像URLパターン: /digitalcomic/...jpg_75/xxxx.jpg(?token=...)
    // サムネイル(thumbnails/)は除外
    const filtered = entries
      .filter(e => e.name.includes('/digitalcomic/') && e.name.includes('/jpg_75/') && !e.name.includes('/thumbnails/'));
    // パス名ベースで重複除去（トークン違いの同一画像を1つにまとめる）
    const seen = new Set();
    return filtered
      .filter(e => {
        try { var p = new URL(e.name).pathname; } catch { var p = e.name.split('?')[0]; }
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      })
      .map(e => e.name);
  }

  let lastQueueKey = '';  // 前回送信したキューのキー（重複送信防止）

  function triggerPrefetch(currentImageUrl) {
    try {
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
      // URLでマッチしない場合、SVG要素から取得
      if (currentIndex === -1) {
        const svgImage = document.querySelector('.rocket-reader image.pageImage');
        if (svgImage) {
          const href = svgImage.getAttribute('xlink:href') || svgImage.getAttribute('href') || '';
          const hrefFile = getFilename(href);
          currentIndex = allPages.findIndex(url => getFilename(url) === hrefFile);
        }
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
  // オーバーレイ描画
  // ============================================================
  // 背景色(CSS値)から少し暗くしたボーダー色を生成
  function darkenColor(cssValue) {
    // linear-gradient の場合、最初の色を抽出
    const gradMatch = cssValue.match(/#[0-9a-fA-F]{3,8}/);
    const hex = gradMatch ? gradMatch[0] : null;
    if (!hex) return null;
    // hex → RGB → 30%暗く → hex
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    const d = (v) => Math.round(v * 0.7).toString(16).padStart(2, '0');
    return `#${d(r)}${d(g)}${d(b)}`;
  }

  function renderOverlays(targetEl, translations) {
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
      overflow: 'visible',
    });

    // 各アイテムのbbox（%単位）を計算し、重なりを検出してから描画
    const expandRate = 0.1; // 上下左右10%拡大
    const layoutItems = translations
      .filter(item => item.bbox && item.bbox.top != null && item.bbox.left != null && item.type !== 'sfx')
      .map(item => {
        const expandX = (item.bbox.width || 5) * expandRate;
        const expandY = (item.bbox.height || 5) * expandRate;
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

    // 重なり検出：垂直方向に重なる場合、上下を縮小
    for (let i = 0; i < layoutItems.length; i++) {
      for (let j = i + 1; j < layoutItems.length; j++) {
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

    layoutItems.forEach((item) => {
      const overlay = document.createElement('div');
      overlay.className = `mut-overlay mut-type-${item.type || 'speech'}`;
      const { top, left, width, height } = item.layout;
      Object.assign(overlay.style, {
        position: 'absolute',
        top: top + '%',
        left: left + '%',
        width: width + '%',
        height: height + '%',
        pointerEvents: 'auto',
      });

      const textEl = document.createElement('div');
      textEl.className = 'mut-overlay-text';
      textEl.textContent = item.translated;
      if (item.background) {
        textEl.style.background = item.background;
        // 背景色からボーダー色を自動生成（少し暗くした色）
        const borderColor = item.border || darkenColor(item.background);
        if (borderColor) {
          textEl.style.border = `2px solid ${borderColor}`;
        }
      } else if (item.border) {
        textEl.style.border = `2px solid ${item.border}`;
      }
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
      const boxW = overlay.clientWidth;
      const boxH = overlay.clientHeight;
      if (boxW === 0 || boxH === 0) return;

      // 初期サイズを推定してから、実測で収まるまで縮小
      const text = textEl.textContent || '';
      const charCount = text.length;
      let fontSize = Math.min(Math.sqrt((boxW * boxH) / Math.max(charCount, 1)) * 0.65, 13);
      fontSize = Math.max(fontSize, 6);
      textEl.style.fontSize = fontSize + 'px';

      // 実測で枠内に収まるまで縮小（最大10回）
      for (let i = 0; i < 10; i++) {
        if (textEl.scrollWidth <= boxW + 1 && textEl.scrollHeight <= boxH + 1) break;
        fontSize -= 0.5;
        if (fontSize < 6) break;
        textEl.style.fontSize = fontSize + 'px';
      }

      // 最小フォントでも高さが足りない場合、ボックスを自動拡大
      if (fontSize <= 6 && textEl.scrollHeight > boxH + 1) {
        const neededH = textEl.scrollHeight + 4;
        overlay.style.height = neededH + 'px';
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
    if (type !== 'error') {
      notif._timer = setTimeout(() => notif.classList.remove('mut-notif-show'), 4000);
    }
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
    const bar = document.getElementById('mut-prefetch-bar');
    if (bar && bar.parentElement !== dialog) dialog.appendChild(bar);
  }

  function moveUIToBody() {
    if (toolbar && toolbar.parentElement !== document.body) document.body.appendChild(toolbar);
    const bar = document.getElementById('mut-prefetch-bar');
    if (bar && bar.parentElement !== document.body) document.body.appendChild(bar);
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

  // ページ遷移検知: hrefポーリング（Reactが属性ではなくプロパティで更新するため）
  let lastPageHref = '';
  let pageCheckInterval = null;

  function startPageWatcher() {
    if (pageCheckInterval) return;
    pageCheckInterval = setInterval(() => {
      const svgImage = document.querySelector('.rocket-reader image.pageImage');
      if (!svgImage) return;
      const href = svgImage.getAttribute('xlink:href') || svgImage.getAttribute('href') || '';
      if (href && href !== lastPageHref) {
        lastPageHref = href;
        clearOverlays();
        triggerPrefetch(href);
      }
    }, 500);
  }

  function stopPageWatcher() {
    if (pageCheckInterval) {
      clearInterval(pageCheckInterval);
      pageCheckInterval = null;
    }
    lastPageHref = '';
    lastQueueKey = '';
  }

  // dialog の開閉を監視
  const dialogObserver = new MutationObserver(() => {
    const dialog = document.querySelector('dialog.ComicPurchasePaths__Reader[open]');
    if (dialog) {
      moveUIToReader();
      startPageWatcher();
      // ダイアログopen直後に初回先読みをトリガー
      const svgImage = dialog.querySelector('.rocket-reader image.pageImage');
      if (svgImage) {
        const href = svgImage.getAttribute('xlink:href') || svgImage.getAttribute('href') || '';
        if (href) triggerPrefetch(href);
      }
    } else {
      stopPageWatcher();
      if (toolbar && toolbar.parentElement !== document.body) {
        moveUIToBody();
        clearOverlays();
      }
    }
  });
  dialogObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });

  // 初回: リーダーが既に開いていれば監視開始
  if (document.querySelector('dialog.ComicPurchasePaths__Reader[open]')) {
    startPageWatcher();
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
        bar.style.display = '';
        bar.style.opacity = '';
        bar.classList.add('mut-prefetch-active');
        const pct = Math.round((current / total) * 100);
        fill.style.width = Math.max(pct, 2) + '%';
      }

      if (state === 'done') {
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
