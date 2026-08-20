(async function loadLatestTransLensRuntime() {
  const cacheBuster = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const runtimeUrl = (path) => `${chrome.runtime.getURL(path)}?runtime=${cacheBuster}`;

  try {
    await import(runtimeUrl('src/core.js'));
    await import(runtimeUrl('src/local-model.js'));
    await import(runtimeUrl('src/content.js'));
  } catch (error) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'TRANSLENS_INJECT_RUNTIME' });
      if (!response?.ok) throw new Error(response?.error || 'INJECTION_FAILED');
    } catch (fallbackError) {
      console.error('[TransLens] 无法载入最新运行代码', error, fallbackError);
    }
  }
})();
