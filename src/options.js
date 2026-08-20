const defaults = {
  translationUnit: 'phrase',
  hoverDelay: 220,
  inkSize: 120,
  brushSize: 24,
  inkStyleVersion: 3,
  hoverUnitStyleVersion: 2,
  engine: 'local',
  localModelStatus: 'unknown',
  localModelProgress: 0,
  sourceLanguage: 'auto',
  targetLanguage: 'zh',
  languageSettingsVersion: 1
};

const {
  STATUS,
  inspect: inspectLocalModel,
  prepare: prepareLocalModel
} = globalThis.TransLensLocalModel;
const languages = globalThis.TransLensLanguages?.SUPPORTED_LANGUAGES || [];
const translationUnit = document.querySelector('#translationUnit');
const sourceLanguage = document.querySelector('#sourceLanguage');
const targetLanguage = document.querySelector('#targetLanguage');
const languagePairLabel = document.querySelector('#languagePairLabel');
const languageSupport = document.querySelector('#languageSupport');
const hoverDelay = document.querySelector('#hoverDelay');
const hoverDelayValue = document.querySelector('#hoverDelayValue');
const inkSize = document.querySelector('#inkSize');
const inkSizeValue = document.querySelector('#inkSizeValue');
const brushSize = document.querySelector('#brushSize');
const brushSizeValue = document.querySelector('#brushSizeValue');
const localRadio = document.querySelector('input[name="engine"][value="local"]');
const mockRadio = document.querySelector('input[name="engine"][value="mock"]');
const localModelStatus = document.querySelector('#localModelStatus');
const localModelDetail = document.querySelector('#localModelDetail');
const localModelProgress = document.querySelector('#localModelProgress');
const localModelProgressBar = localModelProgress.querySelector('span');
const prepareLocal = document.querySelector('#prepareLocal');
const saved = document.querySelector('#saved');
const quickStartStatus = document.querySelector('#quickStartStatus');

let settings = { ...defaults };
let currentModelStatus = STATUS.UNKNOWN;
let currentModelProgress = 0;

populateLanguageOptions();

load();

async function load() {
  updateModifierKeyLabels();
  settings = await chrome.storage.local.get(defaults);
  if (Number(settings.languageSettingsVersion) < 1) {
    settings.sourceLanguage = 'auto';
    settings.languageSettingsVersion = 1;
    await chrome.storage.local.set({
      sourceLanguage: settings.sourceLanguage,
      languageSettingsVersion: settings.languageSettingsVersion
    });
  }
  // 悬停模式固定为局部短语；句子仍可通过 Alt/Option 轻点固定。
  translationUnit.value = 'phrase';
  settings.sourceLanguage = languageOptionValue(settings.sourceLanguage, 'auto');
  settings.targetLanguage = languageOptionValue(settings.targetLanguage, 'zh');
  sourceLanguage.value = settings.sourceLanguage;
  targetLanguage.value = settings.targetLanguage;
  updateLanguageLabels();
  hoverDelay.value = settings.hoverDelay;
  inkSize.value = settings.inkSize;
  brushSize.value = settings.brushSize;
  const engineRadio = document.querySelector(`input[name="engine"][value="${settings.engine}"]`);
  (engineRadio || mockRadio).checked = true;
  updateRangeValues();
  await refreshLocalModelStatus();
}

async function refreshLocalModelStatus() {
  renderModelStatus(STATUS.CHECKING, currentModelProgress);
  const checkSourceLanguage = settings.sourceLanguage === 'auto'
    ? 'en'
    : settings.sourceLanguage;
  const result = await inspectLocalModel({
    sourceLanguage: checkSourceLanguage,
    targetLanguage: settings.targetLanguage
  });
  currentModelStatus = result.status;
  if (result.status === STATUS.READY) currentModelProgress = 100;
  else if (result.status === STATUS.DOWNLOADABLE) currentModelProgress = 0;
  renderModelStatus(currentModelStatus, currentModelProgress);
  if (result.status !== STATUS.ERROR) {
    await chrome.storage.local.set({
      localModelStatus: currentModelStatus,
      localModelProgress: currentModelProgress
    });
  }
}

function renderModelStatus(status, progress = 0) {
  currentModelStatus = status;
  currentModelProgress = progress;
  localModelStatus.className = 'status-pill';
  localModelProgress.hidden = status !== STATUS.DOWNLOADING;
  localModelProgressBar.style.width = `${progress}%`;
  prepareLocal.disabled = false;
  prepareLocal.hidden = false;
  localRadio.disabled = status !== STATUS.READY;

  if (status === STATUS.READY) {
    localModelStatus.textContent = '已就绪';
    localModelStatus.classList.add('ready');
    localModelDetail.textContent = settings.sourceLanguage === 'auto'
      ? '源语言自动检测；翻译在 Chrome 内完成，悬停文字不会上传。'
      : '翻译在 Chrome 内完成，悬停文字不会上传。';
    prepareLocal.textContent = '重新检查';
    quickStartStatus.textContent = '本地翻译已就绪。现在打开外语网页并点击译镜图标即可使用。';
    quickStartStatus.className = 'onboarding-status ready';
    return;
  }
  if (status === STATUS.DOWNLOADING) {
    localModelStatus.textContent = `准备中 ${progress}%`;
    localModelStatus.classList.add('warning');
    localModelDetail.textContent = `Chrome 正在准备${languagePairText()}本地语言包，请保持此页面打开。`;
    prepareLocal.textContent = '正在准备…';
    prepareLocal.disabled = true;
    quickStartStatus.textContent = `正在准备本地翻译：${progress}%`;
    quickStartStatus.className = 'onboarding-status warning';
    return;
  }
  if (status === STATUS.DOWNLOADABLE) {
    localModelStatus.textContent = '尚未准备';
    localModelStatus.classList.add('warning');
    localModelDetail.textContent = `首次使用需要由 Chrome 下载${languagePairText()}本地语言包。`;
    prepareLocal.textContent = '准备本地翻译';
    quickStartStatus.textContent = settings.sourceLanguage === 'auto'
      ? '自动检测会在首次悬停时确定源语言，并按语言对准备本地语言包。'
      : `完成${languagePairText()}语言包准备后，译镜才能提供译文。`;
    quickStartStatus.className = 'onboarding-status warning';
    return;
  }
  if (status === STATUS.UNSUPPORTED) {
    localModelStatus.textContent = '浏览器不支持';
    localModelStatus.classList.add('error');
    localModelDetail.textContent = '需要桌面版 Chrome 138 或更高版本，并支持所选语言对。';
    prepareLocal.textContent = '无法准备';
    prepareLocal.disabled = true;
    quickStartStatus.textContent = '当前浏览器无法使用本地翻译；交互演示仍可用于测试项目效果。';
    quickStartStatus.className = 'onboarding-status error';
    return;
  }
  if (status === STATUS.UNAVAILABLE) {
    localModelStatus.textContent = '当前不可用';
    localModelStatus.classList.add('error');
    localModelDetail.textContent = `这台设备暂时无法使用${languagePairText()}的 Chrome 本地翻译。`;
    prepareLocal.textContent = '无法准备';
    prepareLocal.disabled = true;
    quickStartStatus.textContent = `当前设备暂不支持${languagePairText()}本地翻译。`;
    quickStartStatus.className = 'onboarding-status error';
    return;
  }
  if (status === STATUS.ERROR) {
    localModelStatus.textContent = '检查失败';
    localModelStatus.classList.add('error');
    localModelDetail.textContent = '暂时无法读取本地翻译状态，可以稍后重试。';
    prepareLocal.textContent = '重新检查';
    quickStartStatus.textContent = '状态检查失败，请稍后点击“重新检查”。';
    quickStartStatus.className = 'onboarding-status error';
    return;
  }
  localModelStatus.textContent = '检查中';
  localModelDetail.textContent = '正在检查这台电脑的本地翻译能力…';
  prepareLocal.textContent = '检查中…';
  prepareLocal.disabled = true;
  quickStartStatus.textContent = '正在检查本地翻译能力…';
  quickStartStatus.className = 'onboarding-status';
}

function updateRangeValues() {
  hoverDelayValue.textContent = `${hoverDelay.value} ms`;
  inkSizeValue.textContent = `${inkSize.value} px`;
  brushSizeValue.textContent = `${brushSize.value} px`;
}

function populateLanguageOptions() {
  sourceLanguage.replaceChildren(new Option('自动检测', 'auto'));
  targetLanguage.replaceChildren();
  for (const language of languages) {
    const label = `${language.name} (${language.englishName})`;
    sourceLanguage.append(new Option(label, language.code));
    targetLanguage.append(new Option(label, language.code));
  }
}

function languageOptionValue(value, fallback) {
  const candidate = String(value || fallback);
  return candidate === 'auto' || languages.some((language) => language.code === candidate)
    ? candidate
    : fallback;
}

function languageLabel(code) {
  if (code === 'auto') return '自动检测';
  return languages.find((language) => language.code === code)?.name || code;
}

function languagePairText() {
  return `${languageLabel(settings.sourceLanguage)} → ${languageLabel(settings.targetLanguage)}`;
}

function updateLanguageLabels() {
  languagePairLabel.textContent = languagePairText();
  languageSupport.textContent = settings.sourceLanguage === 'auto'
    ? '自动检测会根据鼠标所在句子的上下文判断源语言；Chrome 会按语言对按需准备本地语言包。'
    : `当前固定为${languageLabel(settings.sourceLanguage)} → ${languageLabel(settings.targetLanguage)}；Chrome 会按需准备对应本地语言包。`;
}

function showSaved(message) {
  saved.textContent = message;
  window.setTimeout(() => { saved.textContent = ''; }, 1800);
}

function updateModifierKeyLabels() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const label = /mac/i.test(platform) ? '⌥ Option' : 'Alt';
  for (const element of document.querySelectorAll('[data-modifier-key]')) {
    element.textContent = label;
  }
}

hoverDelay.addEventListener('input', updateRangeValues);
inkSize.addEventListener('input', updateRangeValues);
brushSize.addEventListener('input', updateRangeValues);

prepareLocal.addEventListener('click', async () => {
  if (currentModelStatus === STATUS.READY) {
    await refreshLocalModelStatus();
    return;
  }
  try {
    renderModelStatus(STATUS.DOWNLOADING, 0);
    const prepareSourceLanguage = settings.sourceLanguage === 'auto'
      ? 'en'
      : settings.sourceLanguage;
    await prepareLocalModel({
      sourceLanguage: prepareSourceLanguage,
      targetLanguage: settings.targetLanguage,
      onProgress(progress) {
        renderModelStatus(STATUS.DOWNLOADING, progress);
      }
    });
    currentModelProgress = 100;
    settings.engine = 'local';
    settings.localModelStatus = STATUS.READY;
    localRadio.disabled = false;
    localRadio.checked = true;
    renderModelStatus(STATUS.READY, 100);
    await chrome.storage.local.set({
      engine: 'local',
      localModelStatus: STATUS.READY,
      localModelProgress: 100
    });
    showSaved('本地翻译已准备好');
  } catch (error) {
    const status = error?.message === 'TRANSLATOR_API_UNSUPPORTED'
      ? STATUS.UNSUPPORTED
      : error?.message === 'LANGUAGE_PAIR_UNAVAILABLE'
        ? STATUS.UNAVAILABLE
        : STATUS.ERROR;
    renderModelStatus(status, 0);
    await chrome.storage.local.set({
      localModelStatus: status,
      localModelProgress: 0
    });
  }
});

document.querySelector('#save').addEventListener('click', async () => {
  const selectedEngine = document.querySelector('input[name="engine"]:checked')?.value || 'mock';
  const localModelPending = selectedEngine === 'local' && currentModelStatus !== STATUS.READY;
  settings = {
    ...settings,
    translationUnit: 'phrase',
    hoverDelay: Number(hoverDelay.value),
    inkSize: Number(inkSize.value),
    brushSize: Number(brushSize.value),
    inkStyleVersion: 3,
    engine: selectedEngine,
    sourceLanguage: sourceLanguage.value,
    targetLanguage: targetLanguage.value,
    languageSettingsVersion: 1
  };
  await chrome.storage.local.set({
    translationUnit: 'phrase',
    hoverUnitStyleVersion: 2,
    hoverDelay: settings.hoverDelay,
    inkSize: settings.inkSize,
    brushSize: settings.brushSize,
    inkStyleVersion: settings.inkStyleVersion,
    engine: settings.engine,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    languageSettingsVersion: settings.languageSettingsVersion
  });
  showSaved(localModelPending ? '已保存；使用前请准备本地翻译' : '已保存');
});

sourceLanguage.addEventListener('change', async () => {
  settings.sourceLanguage = sourceLanguage.value;
  updateLanguageLabels();
  await refreshLocalModelStatus();
});

targetLanguage.addEventListener('change', async () => {
  settings.targetLanguage = targetLanguage.value;
  updateLanguageLabels();
  await refreshLocalModelStatus();
});

document.querySelector('#reset').addEventListener('click', async () => {
  await chrome.storage.local.set(defaults);
  await load();
  showSaved('已恢复默认设置');
});
