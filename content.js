// content.js - Doug コミック翻訳オーバーレイ
// Gemini/Claude/ChatGPT Vision API 翻訳

(function () {
  'use strict';

  let isTranslating = false;
  let overlayContainer = null;
  let toolbar = null;
  let overlaysVisible = true;

  // ============================================================
  // Vision API 翻訳（画像を直接送信）
  // ============================================================
  async function translateImage(imageDataUrl, imageUrl) {
    const response = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_IMAGE',
      imageData: imageDataUrl,
      imageUrl: imageUrl,
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
      if (entry.name.includes('/digitalcomic/') && entry.name.includes('/jpg_75/') && !entry.name.includes('/thumbnails/')) {
        try { var p = new URL(entry.name).pathname; } catch { var p = entry.name.split('?')[0]; }
        if (!comicPageUrls.has(p)) comicPageUrls.set(p, entry.name);
      }
    }
  });
  perfObserver.observe({ type: 'resource', buffered: true });

  function getComicPageUrls() {
    return Array.from(comicPageUrls.values());
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
    const expandRate = 0.15; // 上下左右15%拡大（日本語は英語より幅を要する）
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

    // 重なり検出：垂直方向に重なる場合、上下を縮小（O(n²)のため50件で打ち切り）
    const overlapLimit = Math.min(layoutItems.length, 50);
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
    const overlays = overlayContainer.querySelectorAll('.mut-overlay');

    // フェーズ1: 読み取り（ボックスサイズ取得）+ 初期フォントサイズ設定
    const items = [];
    overlays.forEach((overlay) => {
      const textEl = overlay.querySelector('.mut-overlay-text');
      if (!textEl) return;
      const boxW = overlay.clientWidth;
      const boxH = overlay.clientHeight;
      if (boxW === 0 || boxH === 0) return;
      // padding(4px*2)+border(2px*2)=12px を差し引いた実効領域で計算
      const innerW = Math.max(boxW - 12, 10);
      const innerH = Math.max(boxH - 12, 10);
      const charCount = (textEl.textContent || '').length;
      let fontSize = Math.min(Math.sqrt((innerW * innerH) / Math.max(charCount, 1)) * 0.7, 16);
      fontSize = Math.max(fontSize, 6);
      textEl.style.fontSize = fontSize + 'px';
      items.push({ overlay, textEl, boxW, boxH, fontSize });
    });

    // フェーズ2: 読み取り→書き込みを要素ごとに縮小（バッチ化で最小限のリフロー）
    for (const item of items) {
      for (let i = 0; i < 10; i++) {
        if (item.textEl.scrollWidth <= item.boxW + 1 && item.textEl.scrollHeight <= item.boxH + 1) break;
        item.fontSize -= 0.5;
        if (item.fontSize < 6) break;
        item.textEl.style.fontSize = item.fontSize + 'px';
      }
    }

    // フェーズ3: 最小フォントでも収まらない場合、ボックスを拡大
    for (const item of items) {
      if (item.fontSize <= 6) {
        if (item.textEl.scrollHeight > item.boxH + 1) {
          item.overlay.style.height = (item.textEl.scrollHeight + 8) + 'px';
        }
        if (item.textEl.scrollWidth > item.boxW + 1) {
          item.overlay.style.width = (item.textEl.scrollWidth + 8) + 'px';
        }
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
  let cachedUIParent = null;

  function getUIParent() {
    if (cachedUIParent && cachedUIParent.isConnected) return cachedUIParent;
    cachedUIParent = document.querySelector('dialog.ComicPurchasePaths__Reader[open]') || document.body;
    return cachedUIParent;
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

  // ページ遷移検知: SVG image要素のhref属性変更をMutationObserverで監視
  let lastPageHref = '';
  let pageObserver = null;
  let watchedImage = null;

  function startPageWatcher() {
    if (pageObserver) return;
    const svgImage = document.querySelector('.rocket-reader image.pageImage');
    if (!svgImage) return;
    watchedImage = svgImage;

    // 初回チェック
    const href = svgImage.getAttribute('xlink:href') || svgImage.getAttribute('href') || '';
    if (href && href !== lastPageHref) {
      lastPageHref = href;
      triggerPrefetch(href);
    }

    pageObserver = new MutationObserver(() => {
      const href = watchedImage.getAttribute('xlink:href') || watchedImage.getAttribute('href') || '';
      if (href && href !== lastPageHref) {
        lastPageHref = href;
        clearOverlays();
        triggerPrefetch(href);
      }
    });
    pageObserver.observe(svgImage, {
      attributes: true,
      attributeFilter: ['href', 'xlink:href'],
    });
  }

  function stopPageWatcher() {
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
      watchedImage = null;
    }
    lastPageHref = '';
    lastQueueKey = '';
  }

  // dialog の開閉を監視
  const dialogObserver = new MutationObserver(() => {
    cachedUIParent = null; // dialog状態変更時にキャッシュ無効化
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
  // dialogのopen属性変更と追加/削除を監視
  dialogObserver.observe(document.body, {
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
        fill.style.background = '';  // 白（CSS既定）に戻す
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
