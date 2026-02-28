// translate.js - 翻訳処理・4プロバイダーAPI呼び出し・サイト解析

import { parseVisionResponse } from './utils/parse-utils.js';
import { getSettings } from './settings.js';
import { computeImageDataHash, getCachedTranslation, saveCachedTranslation } from './cache.js';
import { incrementApiStats } from './stats.js';

const LANG_NAMES = {
  ja: '日本語', ko: '韓国語', 'zh-CN': '簡体字中国語', 'zh-TW': '繁体字中国語',
  es: 'スペイン語', fr: 'フランス語', de: 'ドイツ語', pt: 'ポルトガル語',
};

const PROVIDER_LABELS = { gemini: 'Gemini', claude: 'Claude', openai: 'ChatGPT', ollama: 'Ollama' };
export const PROVIDER_KEY_MAP = { gemini: 'geminiApiKey', claude: 'claudeApiKey', openai: 'openaiApiKey', ollama: null };

export async function handleImageTranslation(imageData, imageUrl, imageDims, options) {
  const settings = await getSettings();
  const provider = settings.apiProvider || 'gemini';

  // キャッシュキー用：現在有効なモデル名を取得
  const MODEL_KEY_MAP = {
    gemini: settings.geminiModel || 'gemini-2.5-flash-lite',
    claude: settings.claudeModel || 'claude-sonnet-4-6',
    openai: settings.openaiModel || 'gpt-5.2-2025-12-11',
    ollama: settings.ollamaModel || 'qwen3-vl:8b',
  };
  const activeModel = MODEL_KEY_MAP[provider] || '';

  // BlobURLはページ遷移で変わるため、imageDataのコンテンツハッシュをキャッシュキーとして使用
  const cacheKey = (imageUrl && imageUrl.startsWith('blob:') && imageData)
    ? await computeImageDataHash(imageData)
    : imageUrl;

  // キャッシュ確認（forceRefresh 時はスキップ）
  if (cacheKey && !options?.forceRefresh) {
    const cached = await getCachedTranslation(cacheKey, settings.targetLang, provider, activeModel);
    if (cached) {
      return { translations: cached, fromCache: true };
    }
  }

  // Ollama 以外はAPIキーをチェック
  let apiKey;
  if (provider !== 'ollama') {
    apiKey = settings[PROVIDER_KEY_MAP[provider]];
    if (!apiKey) {
      return { error: `${PROVIDER_LABELS[provider]} APIキーが設定されていません。拡張機能の設定画面でAPIキーを入力してください。` };
    }
  }

  try {
    let translations;

    // parseは1回だけ実行して各API関数に渡す
    const parsed = parseImageDataUrl(imageData);
    // OpenAI は data URL をそのまま受け取るため parsed は Gemini/Claude のみ使用
    const prompt = buildTranslationPrompt(settings.targetLang);

    if (provider === 'ollama') {
      translations = await translateImageWithOllama(
        settings.ollamaEndpoint || 'http://localhost:11434',
        settings.ollamaModel || 'qwen3-vl:8b',
        imageData,
        prompt,
        imageDims
      );
    } else if (provider === 'claude') {
      translations = await translateImageWithClaude(apiKey, parsed, prompt, imageDims, settings.claudeModel);
    } else if (provider === 'openai') {
      translations = await translateImageWithOpenAI(apiKey, imageData, prompt, imageDims, settings.openaiModel);
    } else {
      translations = await translateImageWithGemini(apiKey, parsed, prompt, imageDims, settings.geminiModel);
    }

    if (translations.length > 0 && cacheKey) {
      await saveCachedTranslation(cacheKey, settings.targetLang, translations, provider, activeModel);
    }

    // 翻訳成功時のみカウント（キャッシュヒット・エラー時はカウントしない）
    await incrementApiStats(provider);
    return { translations };
  } catch (err) {
    // APIキー等の機密情報が含まれないようサニタイズしてから返す
    const safeMsg = err.message
      .replace(/key=[^&\s"]+/gi, 'key=***')
      .replace(/sk-[^\s"]+/g, 'sk-***')
      .substring(0, 200);
    return { error: safeMsg };
  }
}

// 画像データURLからbase64とMIMEタイプを抽出
function parseImageDataUrl(imageDataUrl) {
  const mimeMatch = imageDataUrl.match(/^data:(image\/\w+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
  return { mimeType, base64Data };
}

// 全プロバイダー共通の翻訳プロンプト
function buildTranslationPrompt(targetLang) {
  const langName = LANG_NAMES[targetLang] || targetLang;
  return `あなたはコミック翻訳の専門家です。この画像に含まれるすべてのテキストを検出・翻訳してください。

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
    - top: 吹き出しの上端の色
    - bottom: 吹き出しの下端の色
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
}

// レスポンスをパースする共通処理
function parseAndLogResults(providerName, content, imageDims) {
  return parseVisionResponse(content, imageDims);
}

// 429リトライ付きfetch（共通）
async function fetchWithRetry(url, options, providerName) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, options);
    if (res.status !== 429 && res.status !== 503) break;
    await res.text().catch(() => '');
    // Retry-After ヘッダーがあればそれを使用、なければ固定バックオフ
    // 503（高負荷）は短めに待機、429（レート制限）は長めに待機
    const retryAfter = res.headers.get('Retry-After');
    const baseWait = res.status === 503 ? 3000 : 10000;
    const retryAfterSec = Math.min(parseInt(retryAfter, 10) || 0, 60); // 上限60秒
    const wait = retryAfterSec > 0 ? retryAfterSec * 1000 : (attempt + 1) * baseWait;
    await new Promise(r => setTimeout(r, wait));
  }
  // 3回リトライしても失敗の場合、明示的なメッセージで通知
  if (res.status === 429) {
    throw new Error(`${providerName} APIがレート制限中です。しばらく時間をおいてから再度お試しください。`);
  }
  if (res.status === 503) {
    throw new Error(`${providerName} APIが高負荷状態です。しばらく時間をおいてから再度お試しください。`);
  }
  return res;
}

// APIエラーから機密情報を除去して安全なメッセージを抽出
function extractSafeErrorMessage(errBody) {
  try {
    const parsed = JSON.parse(errBody);
    const msg = parsed?.error?.message || parsed?.error?.type || '';
    if (msg) return msg.substring(0, 150);
  } catch { /* JSONでない場合はフォールバック */ }
  // 生テキストからAPIキーやURLを除去して短縮
  return errBody.replace(/key=[^&\s"]+/gi, 'key=***').replace(/sk-[^\s"]+/g, 'sk-***').substring(0, 150);
}

// ============================================================
// Gemini API
// ============================================================
async function translateImageWithGemini(apiKey, parsed, prompt, imageDims, model) {
  const { mimeType, base64Data } = parsed;

  const modelName = model || 'gemini-2.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  const body = JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 32000,
    },
  });

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body,
  }, 'Gemini');

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const safeMsg = extractSafeErrorMessage(errBody);
    console.error(`[Doug bg] Gemini APIエラー (${res.status}):`, safeMsg);
    throw new Error(`Gemini API エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini APIから応答がありません');

  return parseAndLogResults('Gemini', content, imageDims);
}

// ============================================================
// Claude (Anthropic) API
// ============================================================
async function translateImageWithClaude(apiKey, parsed, prompt, imageDims, model) {
  const { mimeType, base64Data } = parsed;

  const url = 'https://api.anthropic.com/v1/messages';
  const body = JSON.stringify({
    model: model || 'claude-sonnet-4-6',
    max_tokens: 32000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType,
            data: base64Data,
          },
        },
        {
          type: 'text',
          text: prompt,
        },
      ],
    }],
  });

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body,
  }, 'Claude');

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const safeMsg = extractSafeErrorMessage(errBody);
    console.error(`[Doug bg] Claude APIエラー (${res.status}):`, safeMsg);
    throw new Error(`Claude API エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.content?.[0]?.text;
  if (!content) throw new Error('Claude APIから応答がありません');

  return parseAndLogResults('Claude', content, imageDims);
}

// ============================================================
// OpenAI (ChatGPT) API
// ============================================================
async function translateImageWithOpenAI(apiKey, imageDataUrl, prompt, imageDims, model) {

  const url = 'https://api.openai.com/v1/chat/completions';
  const body = JSON.stringify({
    model: model || 'gpt-5.2-2025-12-11',
    max_tokens: 32000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: imageDataUrl,
          },
        },
        {
          type: 'text',
          text: prompt,
        },
      ],
    }],
  });

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
  }, 'ChatGPT');

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const safeMsg = extractSafeErrorMessage(errBody);
    console.error(`[Doug bg] OpenAI APIエラー (${res.status}):`, safeMsg);
    throw new Error(`ChatGPT API エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('ChatGPT APIから応答がありません');

  return parseAndLogResults('ChatGPT', content, imageDims);
}

// ============================================================
// Ollama API
// ============================================================
async function translateImageWithOllama(endpoint, model, imageData, prompt, imageDims) {
  // data:image/jpeg;base64, プレフィックスを除去
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');

  let res;
  try {
    res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt, images: [base64Data] }],
        stream: false,
      }),
    });
  } catch {
    throw new Error('Ollama が起動していません。起動してから再試行してください。');
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error('Ollama のアクセスが拒否されました (403)。ターミナルで「launchctl setenv OLLAMA_ORIGINS "*"」を実行して Ollama を再起動してください。');
    }
    if (res.status === 404) {
      throw new Error(`モデル "${model}" がインストールされていません。設定画面でインストールしてください。`);
    }
    const safeMsg = extractSafeErrorMessage(errBody);
    throw new Error(`Ollama エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.message?.content;
  if (!content) throw new Error('Ollama から応答がありません');

  return parseVisionResponse(content, imageDims);
}

// ============================================================
// コミック解析（ホワイトリスト登録前の事前判定）
// ============================================================

// 現在選択中プロバイダーの最軽量モデルを返す
function getLightestModel(settings) {
  const p = settings.apiProvider;
  if (p === 'gemini' && settings.geminiApiKey)
    return { provider: 'gemini', apiKey: settings.geminiApiKey, model: 'gemini-2.0-flash-lite' };
  if (p === 'claude' && settings.claudeApiKey)
    return { provider: 'claude', apiKey: settings.claudeApiKey, model: 'claude-haiku-4-5-20251001' };
  if (p === 'openai' && settings.openaiApiKey)
    return { provider: 'openai', apiKey: settings.openaiApiKey, model: 'gpt-4o-mini' };
  if (p === 'ollama')
    return { provider: 'ollama', endpoint: settings.ollamaEndpoint || 'http://localhost:11434', model: settings.ollamaModel };
  return null;
}

// 各API：画像を送ってテキスト応答を得る（YES/NO判定用）
async function callGeminiText(apiKey, parsed, prompt, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts: [
      { inline_data: { mime_type: parsed.mimeType, data: parsed.base64Data } },
      { text: prompt },
    ]}],
    generationConfig: { temperature: 0, maxOutputTokens: 10 },
  });
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body,
  }, 'Gemini');
  if (!res.ok) throw new Error(`Gemini API エラー (${res.status})`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callClaudeText(apiKey, parsed, prompt, model) {
  const url = 'https://api.anthropic.com/v1/messages';
  const body = JSON.stringify({
    model,
    max_tokens: 10,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: parsed.mimeType, data: parsed.base64Data } },
      { type: 'text', text: prompt },
    ]}],
  });
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body,
  }, 'Claude');
  if (!res.ok) throw new Error(`Claude API エラー (${res.status})`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function callOpenAIText(apiKey, imageDataUrl, prompt, model) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = JSON.stringify({
    model,
    max_tokens: 10,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: imageDataUrl } },
      { type: 'text', text: prompt },
    ]}],
  });
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body,
  }, 'ChatGPT');
  if (!res.ok) throw new Error(`OpenAI API エラー (${res.status})`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callOllamaText(endpoint, model, imageDataUrl, prompt) {
  const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
  let res;
  try {
    res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt, images: [base64Data] }],
        stream: false,
      }),
    });
  } catch {
    throw new Error('Ollama が起動していません');
  }
  if (!res.ok) throw new Error(`Ollama エラー (${res.status})`);
  const data = await res.json();
  return data.message?.content || '';
}

// スクリーンショットを撮ってAIにコミック判定させる
export async function analyzeScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });

  const settings = await getSettings();
  const modelInfo = getLightestModel(settings);
  if (!modelInfo) throw new Error('利用可能なAIプロバイダーがありません。設定画面でAPIキーを入力してください。');

  const prompt = 'この画像はコミックまたはマンガのページですか？吹き出しやセリフが含まれていますか？"YES"または"NO"のみで答えてください。';
  const parsed = parseImageDataUrl(dataUrl);

  let answer;
  if (modelInfo.provider === 'gemini') {
    answer = await callGeminiText(modelInfo.apiKey, parsed, prompt, modelInfo.model);
  } else if (modelInfo.provider === 'claude') {
    answer = await callClaudeText(modelInfo.apiKey, parsed, prompt, modelInfo.model);
  } else if (modelInfo.provider === 'openai') {
    answer = await callOpenAIText(modelInfo.apiKey, dataUrl, prompt, modelInfo.model);
  } else {
    answer = await callOllamaText(modelInfo.endpoint, modelInfo.model, dataUrl, prompt);
  }

  return { isComic: /yes/i.test(answer) };
}
