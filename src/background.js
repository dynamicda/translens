const DEFAULT_SETTINGS = {
  globalEnabled: true,
  triggerMode: 'hover',
  translationUnit: 'phrase',
  displayMode: 'lens',
  inkSize: 120,
  brushSize: 24,
  inkStyleVersion: 3,
  hoverUnitStyleVersion: 2,
  engine: 'local',
  localModelStatus: 'unknown',
  localModelProgress: 0,
  sourceLanguage: 'auto',
  targetLanguage: 'zh',
  languageSettingsVersion: 1,
  hoverDelay: 220,
  minLength: 6,
  maxLength: 500,
  onboardingVersion: 1,
  shortcutHintCount: 0,
  siteRules: {}
};

const RUNTIME_FILES = ['src/core.js', 'src/local-model.js', 'src/content.js'];

cleanupLegacySiteScripts();

chrome.runtime.onInstalled.addListener(async (details) => {
  await cleanupLegacySiteScripts();
  const existing = await chrome.storage.local.get(null);
  const missing = {};
  const shouldShowOnboarding = Number(existing.onboardingVersion) < 1;
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[key] === undefined) missing[key] = value;
  }
  if (Number(existing.inkStyleVersion) < 3) {
    Object.assign(missing, {
      inkSize: existing.inkSize === undefined || [160, 210].includes(Number(existing.inkSize))
        ? 120
        : existing.inkSize,
      inkStyleVersion: 3,
      triggerMode: 'hover',
      hoverDelay: [120, 300].includes(Number(existing.hoverDelay))
        ? 220
        : (existing.hoverDelay ?? 220)
    });
  }
  if (Number(existing.hoverUnitStyleVersion) < 2) {
    Object.assign(missing, {
      translationUnit: 'phrase',
      hoverUnitStyleVersion: 2
    });
  }
  if (Number(existing.languageSettingsVersion) < 1) {
    Object.assign(missing, {
      sourceLanguage: 'auto',
      languageSettingsVersion: 1
    });
  }
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  if (details.reason === 'install' || shouldShowOnboarding) {
    await chrome.runtime.openOptionsPage();
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-translens' || !tab?.id) return;
  try {
    await injectRuntime(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLENS_TOGGLE_PERSISTENT' });
  } catch {
    // Chrome internal pages do not allow content scripts.
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'TRANSLENS_INJECT_RUNTIME' || !sender.tab?.id) return;

  chrome.scripting.executeScript({
    target: {
      tabId: sender.tab.id,
      frameIds: [sender.frameId]
    },
    files: RUNTIME_FILES
  }).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: error?.message || 'INJECTION_FAILED' })
  );
  return true;
});

async function injectRuntime(tabId, frameIds) {
  await chrome.scripting.executeScript({
    target: frameIds?.length ? { tabId, frameIds } : { tabId },
    files: RUNTIME_FILES
  });
}

async function cleanupLegacySiteScripts() {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const ids = scripts
      .map((script) => script.id)
      .filter((id) => id.startsWith('translens-site-'));
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  } catch {
    // Older development builds may not have registered dynamic scripts.
  }
}
