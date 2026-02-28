// image.js - 画像の取得とスクリーンショットのクロップ

export async function fetchImageAsDataUrl(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`画像の取得に失敗しました（ネットワークエラー）: ${err.message}`);
  }
  if (res.status === 403 || res.status === 401) {
    throw new Error(`画像へのアクセスが拒否されました（${res.status}）。認証が必要な画像の可能性があります。`);
  }
  if (!res.ok) throw new Error(`画像の取得に失敗: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const CHUNK_SIZE = 8192;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, bytes.length);
    chunks.push(String.fromCharCode(...bytes.subarray(i, end)));
  }

  const base64 = btoa(chunks.join(''));
  // image/* MIME タイプのみ許可し、パラメータ・改行を除去してインジェクションを防ぐ
  const rawContentType = res.headers.get('content-type') || 'image/jpeg';
  const mimeMatch = rawContentType.match(/^image\/[a-zA-Z0-9.+-]{1,20}/);
  const contentType = mimeMatch ? mimeMatch[0] : 'image/jpeg';
  return `data:${contentType};base64,${base64}`;
}

// captureVisibleTab のスクリーンショットを要素領域にクロップして返す
export async function cropScreenshot(dataUrl, rect) {
  const { x, y, width, height, dpr = 1 } = rect;

  // data URL → Blob → ImageBitmap
  const base64 = dataUrl.split(',')[1];
  const mimeMatch = dataUrl.match(/^data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const binStr = atob(base64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const bitmap = await createImageBitmap(blob);

  // CSS座標 → デバイスピクセル座標
  const sx = Math.round(x * dpr);
  const sy = Math.round(y * dpr);
  const sw = Math.round(width * dpr);
  const sh = Math.round(height * dpr);

  // ビットマップ境界内に収める
  const bx = Math.max(0, Math.min(sx, bitmap.width - 1));
  const by = Math.max(0, Math.min(sy, bitmap.height - 1));
  const bw = Math.max(1, Math.min(sw, bitmap.width - bx));
  const bh = Math.max(1, Math.min(sh, bitmap.height - by));

  const oc = new OffscreenCanvas(bw, bh);
  const ctx = oc.getContext('2d');
  ctx.drawImage(bitmap, bx, by, bw, bh, 0, 0, bw, bh);
  bitmap.close();

  const outBlob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const buffer = await outBlob.arrayBuffer();
  const outBytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  const chunks = [];
  for (let i = 0; i < outBytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...outBytes.subarray(i, i + CHUNK)));
  }
  return `data:image/jpeg;base64,${btoa(chunks.join(''))}`;
}
