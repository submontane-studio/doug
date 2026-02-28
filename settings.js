// settings.js - アプリ設定の取得・キャッシュ管理

export const SETTINGS_DEFAULTS = {
  apiProvider: 'gemini',
  geminiApiKey: '',
  claudeApiKey: '',
  openaiApiKey: '',
  geminiModel: 'gemini-2.5-flash-lite',
  claudeModel: 'claude-sonnet-4-6',
  openaiModel: 'gpt-5.2-2025-12-11',
  ollamaModel: 'qwen3-vl:8b',
  ollamaEndpoint: 'http://localhost:11434',
  targetLang: 'ja',
  prefetch: false,
  imagePreprocess: true,
};

let settingsCache = null;

export async function getSettings() {
  if (settingsCache) return settingsCache;
  settingsCache = await chrome.storage.local.get(SETTINGS_DEFAULTS);
  return settingsCache;
}

export function invalidateSettingsCache() {
  settingsCache = null;
}
