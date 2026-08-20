const elements = {
  globalEnabled: document.querySelector('#globalEnabled'),
  engine: document.querySelector('#engine'),
  engineState: document.querySelector('#engineState'),
  prepareLocal: document.querySelector('#prepareLocal'),
  toggleSite: document.querySelector('#toggleSite'),
  pageState: document.querySelector('#pageState'),
  openOptions: document.querySelector('#openOptions')
};
const {
  STATUS,
  inspect: inspectLocalModel
} = globalThis.TransLensLocalModel;

let hostname = '';
let activeTab = null;
let runtimeError = '';
let settings = {};

initialize();

async function initialize() {
  settings = await chrome.storage.local.get({
    globalEnabled: true,
    engine: 'local',
    localModelStatus: 'unknown',
    localModelProgress: 0,
    sourceLanguage: 'auto',
    targetLanguage: 'zh',
    siteRules: {}
  });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  try {
    const url = tab?.url ? new URL(tab.url) : null;
    hostname = url && ['http:', 'https:'].includes(url.protocol) ? url.hostname : '';
  } catch {
    hostname = '';
  }
  updateModifierKeyLabels();
  if (hostname) {
    const disabled = settings.siteRules?.[hostname] === 'disabled';
    if (settings.globalEnabled && !disabled) await ensureRuntimeForActiveTab();
  }
  render();
  const model = await inspectLocalModel({
    sourceLanguage: settings.sourceLanguage === 'auto' ? 'en' : settings.sourceLanguage,
    targetLanguage: settings.targetLanguage
  });
  if (model.status !== STATUS.ERROR) {
    settings.localModelStatus = model.status;
    settings.localModelProgress = model.status === STATUS.READY ? 100 : 0;
    await chrome.storage.local.set({
      localModelStatus: settings.localModelStatus,
      localModelProgress: settings.localModelProgress
    });
  } else settings.localModelStatus = STATUS.ERROR;
  render();
}

function render() {
  elements.globalEnabled.checked = settings.globalEnabled;
  elements.engine.value = settings.engine;
  renderEngineState();

  if (!hostname) {
    elements.pageState.textContent = '此类 Chrome 页面无法使用译镜';
    elements.toggleSite.disabled = true;
    return;
  }
  if (runtimeError) {
    elements.pageState.textContent = runtimeError;
    elements.toggleSite.disabled = true;
    return;
  }
  elements.toggleSite.disabled = false;
  const disabled = settings.siteRules?.[hostname] === 'disabled';
  elements.pageState.textContent = disabled
    ? `${hostname} 已禁用`
    : `${hostname} 已就绪，点按 ${modifierKeyLabel()} 开启`;
  elements.toggleSite.textContent = disabled ? '在此网站启用' : '在此网站禁用';
}

function renderEngineState() {
  const status = settings.localModelStatus;
  elements.prepareLocal.hidden = status === STATUS.READY;
  if (settings.engine === 'mock') {
    elements.engineState.textContent = status === STATUS.READY
      ? '本地翻译已就绪；当前仍在使用演示翻译。'
      : '当前是演示翻译，普通短语只会显示占位译文。';
    return;
  }
  if (status === STATUS.READY) {
    elements.engineState.textContent = 'Chrome 本地翻译已就绪，悬停文字不会上传。';
  } else if (status === STATUS.UNSUPPORTED) {
    elements.engineState.textContent = '当前 Chrome 不支持本地翻译。';
  } else if (status === STATUS.UNAVAILABLE) {
    elements.engineState.textContent = '这台设备暂时无法使用本地翻译。';
  } else if (status === STATUS.ERROR) {
    elements.engineState.textContent = '暂时无法检查本地翻译状态，请稍后重试。';
  } else {
    elements.engineState.textContent = '本地翻译尚未准备，请先完成模型准备。';
  }
}

elements.globalEnabled.addEventListener('change', async () => {
  settings.globalEnabled = elements.globalEnabled.checked;
  await chrome.storage.local.set({ globalEnabled: settings.globalEnabled });
  if (settings.globalEnabled) await ensureRuntimeForActiveTab();
  render();
});

elements.engine.addEventListener('change', async () => {
  const requestedEngine = elements.engine.value;
  if (requestedEngine === 'local' && settings.localModelStatus !== STATUS.READY) {
    elements.engine.value = settings.engine;
    await chrome.runtime.openOptionsPage();
    return;
  }
  settings.engine = requestedEngine;
  await chrome.storage.local.set({ engine: settings.engine });
  renderEngineState();
});

elements.prepareLocal.addEventListener('click', () => chrome.runtime.openOptionsPage());

elements.toggleSite.addEventListener('click', async () => {
  if (!hostname) return;
  const siteRules = { ...(settings.siteRules || {}) };
  if (siteRules[hostname] === 'disabled') delete siteRules[hostname];
  else siteRules[hostname] = 'disabled';
  settings.siteRules = siteRules;
  await chrome.storage.local.set({ siteRules });
  if (siteRules[hostname] !== 'disabled') await ensureRuntimeForActiveTab();
  render();
});

elements.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

async function ensureRuntimeForActiveTab() {
  if (!activeTab?.id || !hostname) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['src/core.js', 'src/local-model.js', 'src/content.js']
    });
    runtimeError = '';
    return true;
  } catch {
    runtimeError = '当前页面不允许运行译镜';
    return false;
  }
}

function updateModifierKeyLabels() {
  const label = modifierKeyLabel();
  for (const element of document.querySelectorAll('[data-modifier-key]')) {
    element.textContent = label;
  }
}

function modifierKeyLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  return /mac/i.test(platform) ? '⌥ Option' : 'Alt';
}
