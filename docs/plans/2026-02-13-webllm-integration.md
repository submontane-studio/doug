# WebLLM統合 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** クラウドAPIをWebLLMに完全置き換え、ブラウザ内ローカル翻訳を実現

**Architecture:** Service Worker（background.js）でWebLLMを動的import、Phi-3.5-Vision-Instructモデルを使用してOCR+bbox+翻訳を一括処理。既存のOpenAI/Anthropic/Gemini APIコードを削除し、WebLLM専用に書き換え。

**Tech Stack:** @mlc-ai/web-llm (CDN経由)、Phi-3.5-Vision-Instruct、WebGPU、Chrome Extension Manifest V3

---

## タスク一覧

1. manifest.json の CSP 調整
2. popup.html の簡略化
3. popup.js の簡略化
4. background.js に WebLLMManager 追加
5. background.js の既存API関数削除
6. background.js のキャッシュキー修正
7. background.js のメッセージハンドラー更新
8. content.js に進捗表示ロジック追加
9. content.css に進捗バースタイル追加
10. 統合テスト

---

## Task 1: manifest.json の CSP 調整

**Files:**
- Modify: `manifest.json`

### Step 1: CSP を追加

manifest.json に Content Security Policy を追加して、esm.sh からのスクリプト読み込みを許可します。

**変更内容:**

```json
{
  "manifest_version": 3,
  "name": "Marvel Unlimited Translator",
  "version": "1.0.0",
  "description": "Marvel Unlimitedのコミックをリアルタイムで翻訳表示",
  "permissions": [
    "activeTab",
    "storage"
  ],
  "host_permissions": [
    "*://*.marvel.com/*"
  ],
  "content_scripts": [
    {
      "matches": ["*://*.marvel.com/*"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self' https://esm.sh; object-src 'self'"
  }
}
```

**変更点:**
- `host_permissions` から OpenAI/Anthropic/Gemini のURL削除
- `content_security_policy` を追加

### Step 2: 変更を確認

```bash
cat manifest.json
```

Expected: CSP が正しく追加されていることを確認

### Step 3: コミット

```bash
git add manifest.json
git commit -m "feat: esm.sh からのWebLLM読み込みを許可するCSP追加

- content_security_policy でesm.shを許可
- 既存のクラウドAPI用host_permissionsを削除

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 2: popup.html の簡略化

**Files:**
- Modify: `popup.html`

### Step 1: APIキー関連要素を削除、モデル情報を追加

popup.html を簡略化して、APIキー入力欄を削除し、モデル情報表示を追加します。

**変更内容:**

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Marvel Unlimited Translator 設定</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="container">
    <h1>Marvel Unlimited Translator</h1>

    <div class="section">
      <h2>使用モデル</h2>
      <div class="model-info">
        <div class="model-name">Phi-3.5-Vision (2.4GB)</div>
        <div class="model-desc">ローカル実行・完全無料</div>
      </div>
    </div>

    <div class="section">
      <label for="targetLang">翻訳先言語:</label>
      <select id="targetLang">
        <option value="ja">日本語 (Japanese)</option>
        <option value="ko">韓国語 (Korean)</option>
        <option value="zh-CN">簡体字中国語 (Simplified Chinese)</option>
        <option value="zh-TW">繁体字中国語 (Traditional Chinese)</option>
        <option value="es">スペイン語 (Spanish)</option>
        <option value="fr">フランス語 (French)</option>
        <option value="de">ドイツ語 (German)</option>
        <option value="pt">ポルトガル語 (Portuguese)</option>
      </select>
    </div>

    <div class="actions">
      <button id="saveBtn" class="btn-primary">保存</button>
      <button id="clearCacheBtn" class="btn-secondary">キャッシュをクリア</button>
    </div>

    <div id="status" class="status"></div>
  </div>

  <script src="popup.js"></script>
</body>
</html>
```

### Step 2: 変更を確認

```bash
cat popup.html | head -30
```

Expected: APIキー入力欄が削除され、モデル情報が表示されていることを確認

### Step 3: コミット

```bash
git add popup.html
git commit -m "feat: popup.htmlからAPIキー入力欄を削除、モデル情報を追加

- APIプロバイダー選択、APIキー入力、テストボタンを削除
- Phi-3.5-Vision モデル情報表示を追加
- キャッシュクリアボタンを追加

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 3: popup.js の簡略化

**Files:**
- Modify: `popup.js`

### Step 1: APIキー関連ロジックを削除

popup.js から APIキー保存・テスト機能を削除し、言語設定とキャッシュクリアのみに簡略化します。

**変更内容:**

```javascript
// popup.js - 設定画面ロジック

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  // 言語設定の読み込み
  const settings = await chrome.storage.local.get({
    targetLang: 'ja',
  });

  $('targetLang').value = settings.targetLang;

  // 保存ボタン
  $('saveBtn').addEventListener('click', async () => {
    await chrome.storage.local.set({
      targetLang: $('targetLang').value,
    });
    showStatus('設定を保存しました', 'ok');
  });

  // キャッシュクリアボタン
  $('clearCacheBtn').addEventListener('click', async () => {
    // cache: で始まるキーを全て削除
    const allData = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(allData).filter(key => key.startsWith('cache:'));

    if (cacheKeys.length === 0) {
      showStatus('キャッシュはありません', 'ok');
      return;
    }

    await chrome.storage.local.remove(cacheKeys);
    showStatus(`${cacheKeys.length}件のキャッシュを削除しました`, 'ok');
  });
});

function showStatus(msg, type) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = type === 'err' ? '#f44336' : '#4caf50';
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 5000);
}
```

### Step 2: 変更を確認

```bash
wc -l popup.js
```

Expected: 約40行（元の128行から大幅削減）

### Step 3: コミット

```bash
git add popup.js
git commit -m "refactor: popup.jsからAPIキー関連ロジックを削除

- APIキー保存・テスト機能を削除
- 言語設定の保存のみに簡略化
- キャッシュクリア機能を追加

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 4: background.js に WebLLMManager 追加

**Files:**
- Modify: `background.js`

### Step 1: WebLLMManager クラスを追加

background.js の先頭（CACHE_TTL定数の後）に WebLLMManager クラスを追加します。

**追加内容:**

```javascript
// ============================================================
// WebLLM Manager
// ============================================================

class WebLLMManager {
  constructor() {
    this.engine = null;
    this.isInitialized = false;
    this.isInitializing = false;
    this.initProgress = 0;
  }

  async initialize() {
    if (this.isInitialized) return;
    if (this.isInitializing) {
      // 初期化中の場合は完了を待つ
      while (this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    this.isInitializing = true;
    this.initProgress = 0;

    try {
      // WebLLMライブラリを動的import
      const { CreateMLCEngine } = await import('https://esm.sh/@mlc-ai/web-llm@0.2.66');

      // モデル初期化
      this.engine = await CreateMLCEngine('Phi-3.5-vision-instruct-q4f16_1-MLC', {
        initProgressCallback: (progress) => {
          this.initProgress = Math.round(progress.progress * 100);
          console.log(`WebLLM初期化: ${this.initProgress}%`);
        }
      });

      this.isInitialized = true;
      this.initProgress = 100;
      console.log('WebLLM初期化完了');
    } catch (err) {
      this.isInitializing = false;
      throw new Error(`WebLLM初期化失敗: ${err.message}`);
    } finally {
      this.isInitializing = false;
    }
  }

  async translate(imageBase64, targetLang) {
    if (!this.isInitialized) {
      throw new Error('WebLLMが初期化されていません');
    }

    const prompt = buildPrompt(targetLang);

    try {
      const response = await this.engine.chat.completions.create({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
              }
            ]
          }
        ],
        max_tokens: 1500,
        temperature: 0.1
      });

      const content = response.choices[0].message.content;
      return parseAIResponse(content);
    } catch (err) {
      throw new Error(`WebLLM推論失敗: ${err.message}`);
    }
  }

  getInitProgress() {
    return this.initProgress;
  }

  isReady() {
    return this.isInitialized;
  }
}

// グローバルインスタンス
const webllmManager = new WebLLMManager();
```

### Step 2: 変更を確認

```bash
grep -n "class WebLLMManager" background.js
```

Expected: WebLLMManagerクラスが追加されていることを確認

### Step 3: コミット

```bash
git add background.js
git commit -m "feat: WebLLMManager クラスを追加

- Phi-3.5-Vision-Instruct モデルの初期化
- 進捗トラッキング機能
- 推論実行メソッド
- グローバルインスタンス作成

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 5: background.js の既存API関数削除

**Files:**
- Modify: `background.js`

### Step 1: OpenAI/Anthropic/Gemini 関数を削除

`translateWithOpenAI`, `translateWithAnthropic`, `translateWithGemini` 関数を削除します。

**削除する関数:**
- `translateWithOpenAI()` (約36行)
- `translateWithAnthropic()` (約36行)
- `translateWithGemini()` (約37行)

### Step 2: getSettings() を簡略化

APIキー、APIプロバイダーを削除し、言語設定のみ残します。

**変更後:**

```javascript
async function getSettings() {
  return chrome.storage.local.get({
    targetLang: 'ja',
  });
}
```

### Step 3: 変更を確認

```bash
grep -c "translateWith" background.js
```

Expected: 0 (すべて削除されている)

### Step 4: コミット

```bash
git add background.js
git commit -m "refactor: クラウドAPI関数を削除、getSettings簡略化

- translateWithOpenAI/Anthropic/Gemini を削除
- getSettings から apiKey, apiProvider を削除

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 6: background.js のキャッシュキー修正

**Files:**
- Modify: `background.js`

### Step 1: generateCacheKey() を修正

apiProvider を削除し、`cache:${urlHash}:${targetLang}` の形式に変更します。

**変更後:**

```javascript
function generateCacheKey(imageUrl, targetLang) {
  if (!imageUrl) {
    throw new Error('imageUrl is required for cache key generation');
  }
  try {
    const urlHash = btoa(imageUrl).substring(0, 50);
    return `cache:${urlHash}:${targetLang}`;
  } catch (err) {
    const urlHash = encodeURIComponent(imageUrl).substring(0, 50);
    return `cache:${urlHash}:${targetLang}`;
  }
}
```

### Step 2: getCachedTranslation() を修正

apiProvider 引数を削除します。

**変更後:**

```javascript
async function getCachedTranslation(imageUrl, targetLang) {
  const cacheKey = generateCacheKey(imageUrl, targetLang);
  // ... (残りは同じ)
}
```

### Step 3: saveCachedTranslation() を修正

apiProvider 引数を削除します。

**変更後:**

```javascript
async function saveCachedTranslation(imageUrl, targetLang, translations) {
  const cacheKey = generateCacheKey(imageUrl, targetLang);
  // ... (残りは同じ)
}
```

### Step 4: コミット

```bash
git add background.js
git commit -m "refactor: キャッシュキーからapiProviderを削除

- generateCacheKey: apiProvider引数削除
- getCachedTranslation: apiProvider引数削除
- saveCachedTranslation: apiProvider引数削除

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 7: background.js のメッセージハンドラー更新

**Files:**
- Modify: `background.js`

### Step 1: handleTranslation() を WebLLM 用に書き換え

既存の handleTranslation() を WebLLM を使用するように完全に書き換えます。

**変更後:**

```javascript
async function handleTranslation(imageDataUrl, imageUrl = null) {
  const settings = await getSettings();

  // キャッシュチェック
  if (imageUrl) {
    const cached = await getCachedTranslation(imageUrl, settings.targetLang);
    if (cached) {
      console.log('キャッシュから翻訳を取得しました');
      return { translations: cached, fromCache: true };
    }
  }

  // WebLLM初期化（未初期化の場合）
  if (!webllmManager.isReady()) {
    try {
      await webllmManager.initialize();
    } catch (err) {
      return {
        error: `モデルの初期化に失敗しました: ${err.message}

ヒント:
- WebGPU対応ブラウザが必要です（Chrome 113+）
- 安定したネットワーク接続を確認してください
- メモリ不足の場合、他のタブを閉じてください`
      };
    }
  }

  // 推論実行
  const base64 = imageDataUrl.split(',')[1];

  try {
    const INFERENCE_TIMEOUT = 60000; // 60秒

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('推論がタイムアウトしました（60秒）')), INFERENCE_TIMEOUT)
    );

    const result = await Promise.race([
      webllmManager.translate(base64, settings.targetLang),
      timeoutPromise
    ]);

    // キャッシュ保存
    if (result.translations && result.translations.length > 0 && imageUrl) {
      await saveCachedTranslation(imageUrl, settings.targetLang, result.translations);
    }

    return result;
  } catch (err) {
    return { error: `翻訳に失敗しました: ${err.message}` };
  }
}
```

### Step 2: GET_INIT_PROGRESS メッセージハンドラーを追加

content.js からの進捗取得リクエストに応答します。

**追加内容:**

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE_PAGE') {
    handleTranslation(message.imageData, message.imageUrl)
      .then(result => {
        // 初期化中の場合は進捗も含める
        if (webllmManager.isInitializing) {
          result.initProgress = webllmManager.getInitProgress();
        }
        sendResponse(result);
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'GET_INIT_PROGRESS') {
    sendResponse({
      progress: webllmManager.getInitProgress(),
      isInitializing: webllmManager.isInitializing,
      isReady: webllmManager.isReady()
    });
    return true;
  }

  if (message.type === 'FETCH_IMAGE') {
    fetchImageAsDataUrl(message.url)
      .then(imageData => sendResponse({ imageData }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});
```

### Step 3: コミット

```bash
git add background.js
git commit -m "feat: handleTranslationをWebLLM用に書き換え

- WebLLM初期化とエラーハンドリング
- タイムアウト処理（60秒）
- GET_INIT_PROGRESS メッセージハンドラー追加

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 8: content.js に進捗表示ロジック追加

**Files:**
- Modify: `content.js`

### Step 1: 進捗表示用の通知関数を拡張

showNotification() を拡張して、進捗バー表示に対応します。

**追加内容:**

translateCurrentPage() 関数内に進捗ポーリングロジックを追加します。

**変更後:**

```javascript
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
    const imageData = await captureComic(comicInfo);

    // SVGの場合はimageUrlを取得
    let imageUrl = null;
    if (comicInfo.type === 'svg' && comicInfo.element) {
      imageUrl = comicInfo.element.getAttribute('xlink:href') || comicInfo.element.getAttribute('href');
    }

    // 進捗ポーリング開始
    let progressInterval = null;
    const startProgressPolling = () => {
      progressInterval = setInterval(async () => {
        const progressResponse = await chrome.runtime.sendMessage({ type: 'GET_INIT_PROGRESS' });
        if (progressResponse.isInitializing) {
          showNotification(`モデルをダウンロード中... ${progressResponse.progress}%`, 'progress');
        } else if (progressResponse.isReady) {
          showNotification('翻訳中...', 'info');
          clearInterval(progressInterval);
        }
      }, 500);
    };

    startProgressPolling();

    const response = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_PAGE',
      imageData: imageData,
      imageUrl: imageUrl,
    });

    // 進捗ポーリング停止
    if (progressInterval) clearInterval(progressInterval);

    if (response.error) {
      showNotification(response.error, 'error');
      return;
    }

    if (!response.translations || response.translations.length === 0) {
      showNotification('テキストが検出されませんでした', 'warn');
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
```

### Step 2: コミット

```bash
git add content.js
git commit -m "feat: WebLLM初期化進捗表示ロジックを追加

- GET_INIT_PROGRESS メッセージで進捗取得
- 500msごとにポーリング
- 進捗バー通知表示

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 9: content.css に進捗バースタイル追加

**Files:**
- Modify: `content.css`

### Step 1: 進捗バー用のスタイルを追加

content.css に進捗バー表示用のスタイルを追加します。

**追加内容:**

```css
/* 進捗バー通知 */
.mut-notif-progress {
  background: #1a1a2e;
  color: #e0e0e0;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
  min-width: 300px;
}

.mut-notif-progress::after {
  content: '';
  display: block;
  margin-top: 8px;
  height: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}
```

### Step 2: コミット

```bash
git add content.css
git commit -m "style: 進捗バー表示用のスタイルを追加

- mut-notif-progress クラス追加
- プログレスバー風の装飾

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 10: 統合テスト

**Files:**
- None (manual testing)

### Step 1: 拡張機能を再読み込み

```bash
echo "Chrome拡張機能ページ（chrome://extensions）で「更新」ボタンをクリック"
```

### Step 2: Marvel Unlimited で動作確認

**テストケース:**

1. **初回翻訳**
   - Marvel Unlimited でコミックを開く
   - 翻訳ボタンをクリック
   - 「モデルをダウンロード中... X%」が表示される
   - 進捗が100%になり「翻訳中...」に切り替わる
   - 翻訳オーバーレイが表示される

2. **2回目の翻訳（キャッシュミス）**
   - 別のページに移動
   - 翻訳ボタンをクリック
   - 「翻訳中...」が表示される（ダウンロードなし）
   - 翻訳オーバーレイが表示される

3. **キャッシュヒット**
   - 同じページで翻訳ボタンをクリック
   - 即座に翻訳オーバーレイが表示される
   - 「X件のテキストを表示しました（キャッシュ）」と表示

4. **popup 動作確認**
   - 拡張機能アイコンをクリック
   - モデル情報「Phi-3.5-Vision (2.4GB)」が表示される
   - 言語選択が機能する
   - キャッシュクリアボタンが機能する

5. **エラーハンドリング**
   - WebGPU非対応環境（該当する場合）でエラーメッセージが表示される

### Step 3: 問題がなければ最終コミット

```bash
git add -A
git commit -m "test: WebLLM統合の統合テスト完了

- 初回翻訳（モデルダウンロード）
- 2回目の翻訳（キャッシュミス）
- キャッシュヒット
- popup動作確認
- エラーハンドリング

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## 実装完了後のチェックリスト

- [ ] すべてのタスクが完了
- [ ] 初回翻訳が動作する（進捗表示あり）
- [ ] 2回目以降の翻訳が動作する
- [ ] キャッシュが機能する
- [ ] popup が正しく表示される
- [ ] エラーメッセージが適切に表示される
- [ ] コミットメッセージが適切

---

## トラブルシューティング

### WebLLM初期化エラー

**症状:** 「WebGPU is not supported」

**対処:**
- Chrome 113以降を使用
- chrome://flags で WebGPU を有効化
- ハードウェアアクセラレーションが有効か確認

### CSPエラー

**症状:** 「Refused to load the script」

**対処:**
- manifest.json の CSP が正しく設定されているか確認
- esm.sh が許可されているか確認

### メモリ不足

**症状:** 推論中にクラッシュ

**対処:**
- 他のタブを閉じる
- メモリ8GB以上を推奨

---

## 次のステップ

実装完了後:
1. README.md の更新（WebLLM使用方法、システム要件）
2. ユーザーフィードバック収集
3. 翻訳精度の評価とプロンプトチューニング
