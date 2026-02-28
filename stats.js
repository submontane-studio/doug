// stats.js - API 呼び出し統計の管理

export async function incrementApiStats(provider) {
  try {
    const { apiStats = {} } = await chrome.storage.local.get('apiStats');
    apiStats[provider] = (apiStats[provider] || 0) + 1;
    if (!apiStats.lastReset) apiStats.lastReset = Date.now();
    await chrome.storage.local.set({ apiStats });
  } catch { /* storage エラーは無視 */ }
}
