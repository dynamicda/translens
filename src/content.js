(function startTransLens() {
  if (
    location.pathname.includes('/demo/')
    && chrome.runtime?.id
  ) return;

  if (globalThis.__TRANSLENS_RUNTIME_ACTIVE__) return;
  globalThis.__TRANSLENS_RUNTIME_ACTIVE__ = true;

  const {
    BLOCK_SELECTOR,
    brushSegmentPolygon,
    calculateTextFitScale,
    DEFAULT_SETTINGS,
    findPhrase,
    findSentence,
    isSiteEnabled,
    isSkippableElement,
    isIntentionalDrag,
    isMeaningfulHoverWord,
    isOptionTap,
    looksTranslatable,
    mergeSettings,
    normalizeText,
    resolveHoverDelay,
    splitTranslationChunks
  } = globalThis.TransLensCore;
  const HOVER_LEAVE_DELAY = 160;
  const HOVER_UNIT_STYLE_VERSION = 2;
  const localModelApi = globalThis.TransLensLocalModel || createLocalModelFallback();
  const {
    STATUS: LOCAL_MODEL_STATUS,
    createLanguageDetector,
    createTranslator,
    detectLanguage,
    inspect: inspectLocalModel
  } = localModelApi;

  function createLocalModelFallback() {
    const STATUS = {
      UNSUPPORTED: 'unsupported',
      UNAVAILABLE: 'unavailable',
      DOWNLOADABLE: 'downloadable',
      READY: 'ready',
      ERROR: 'error'
    };
    return {
      STATUS,
      async inspect(options = {}) {
        const translatorApi = options.translatorApi ?? globalThis.Translator;
        if (!translatorApi?.availability || !translatorApi?.create) {
          return { status: STATUS.UNSUPPORTED };
        }
        try {
          const availability = await translatorApi.availability({
            sourceLanguage: options.sourceLanguage || 'en',
            targetLanguage: options.targetLanguage || 'zh'
          });
          if (availability === 'available' || availability === 'readily') {
            return { status: STATUS.READY };
          }
          if (availability === 'downloadable' || availability === 'after-download') {
            return { status: STATUS.DOWNLOADABLE };
          }
          return { status: STATUS.UNAVAILABLE };
        } catch (error) {
          return { status: STATUS.ERROR, error };
        }
      },
      async createTranslator(options = {}) {
        const translatorApi = options.translatorApi ?? globalThis.Translator;
        if (!translatorApi?.create) throw new Error('TRANSLATOR_API_UNSUPPORTED');
        const translator = await translatorApi.create({
          sourceLanguage: options.sourceLanguage || 'en',
          targetLanguage: options.targetLanguage || 'zh',
          monitor(monitor) {
            monitor.addEventListener('downloadprogress', (event) => {
              options.onProgress?.(
                Math.max(0, Math.min(100, Math.round(Number(event.loaded) * 100)))
              );
            });
          }
        });
        if (translator.ready && typeof translator.ready.then === 'function') {
          await translator.ready;
        }
        return translator;
      },
      async createLanguageDetector(options = {}) {
        const detectorApi = options.detectorApi ?? globalThis.LanguageDetector;
        if (!detectorApi?.create) throw new Error('LANGUAGE_DETECTOR_UNSUPPORTED');
        return detectorApi.create(options);
      },
      async detectLanguage(text, options = {}) {
        const detectorApi = options.detectorApi ?? globalThis.LanguageDetector;
        const detector = options.detector || await detectorApi.create(options);
        const results = await detector.detect(String(text || ''));
        const best = Array.isArray(results) ? results[0] : null;
        return best?.detectedLanguage
          ? { language: best.detectedLanguage, confidence: Number(best.confidence) || 0 }
          : null;
      }
    };
  }

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    altDown: false,
    hoverEnabled: false,
    optionPressStartedAt: 0,
    optionChordUsed: false,
    optionPointerUsed: false,
    optionPreviousHoverEnabled: true,
    lastPoint: null,
    candidatePoint: null,
    candidateKey: '',
    candidate: null,
    lensCandidates: [],
    hoverTimer: 0,
    leaveTimer: 0,
    loadingTimer: 0,
    requestId: 0,
    statusRequestId: 0,
    framePending: false,
    lastEvaluationAt: 0,
    translator: null,
    translatorKey: '',
    languageDetector: null,
    languageDetectionCache: new Map(),
    overlayMode: '',
    inkFrame: 0,
    inkTarget: null,
    inkCurrent: null,
    inkPhase: 0,
    inkLastFrameTime: 0,
    inkLastPaintTime: 0,
    inkEnergy: 0,
    inkPaintCount: 0,
    brushPoints: [],
    brushWidth: 22,
    selectionDraft: null,
    selectionPinned: false,
    ignoreClickUntil: 0,
    cache: new Map()
  };

  const ui = createOverlay();

  bindEvents();
  initialize();

  async function initialize() {
    const stored = await chrome.storage.local.get(null);
    if (Number(stored.inkStyleVersion) < 3) {
      Object.assign(stored, {
        inkSize: stored.inkSize === undefined || [160, 210].includes(Number(stored.inkSize))
          ? 120
          : stored.inkSize,
        inkStyleVersion: 3,
        triggerMode: 'hover',
        hoverDelay: [120, 300].includes(Number(stored.hoverDelay))
          ? 220
          : (stored.hoverDelay ?? 220)
      });
      await chrome.storage.local.set({
        inkSize: stored.inkSize,
        inkStyleVersion: stored.inkStyleVersion,
        triggerMode: stored.triggerMode,
        hoverDelay: stored.hoverDelay
      });
    }
    if (Number(stored.hoverUnitStyleVersion) < HOVER_UNIT_STYLE_VERSION) {
      // 悬停模式只负责解释鼠标命中的单词/附近短语。
      // 旧版本把 sentence/paragraph 存在了同一个字段里，升级后仍会走整句布局。
      stored.translationUnit = 'phrase';
      stored.hoverUnitStyleVersion = HOVER_UNIT_STYLE_VERSION;
      await chrome.storage.local.set({
        translationUnit: stored.translationUnit,
        hoverUnitStyleVersion: stored.hoverUnitStyleVersion
      });
    }
    if (Number(stored.languageSettingsVersion) < 1) {
      stored.sourceLanguage = 'auto';
      stored.languageSettingsVersion = 1;
      await chrome.storage.local.set({
        sourceLanguage: stored.sourceLanguage,
        languageSettingsVersion: stored.languageSettingsVersion
      });
    }
    state.settings = mergeSettings(stored);
    updateBadge();
    const hintCount = Math.max(0, Number(stored.shortcutHintCount) || 0);
    if (isActiveForPage() && hintCount < 3) {
      flashBadge(`点按 ${modifierKeyLabel()} 开启译镜`);
      await chrome.storage.local.set({ shortcutHintCount: hintCount + 1 });
    }
  }

  function bindEvents() {
    window.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('click', onPageClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', resetInteraction, true);
    document.documentElement.addEventListener('pointerleave', resetInteraction, { passive: true });
    window.addEventListener('scroll', hideOverlay, { passive: true, capture: true });
    window.addEventListener('resize', hideOverlay, { passive: true });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const next = { ...state.settings };
      for (const [key, change] of Object.entries(changes)) next[key] = change.newValue;
      state.settings = mergeSettings(next);
      const changedKeys = Object.keys(changes);
      if (changedKeys.some((key) => ['engine', 'sourceLanguage', 'targetLanguage'].includes(key))) {
        state.translator?.destroy?.();
        state.translator = null;
        state.translatorKey = '';
        state.languageDetectionCache.clear();
      }
      if (changedKeys.some((key) => !['localModelStatus', 'localModelProgress'].includes(key))) {
        hideOverlay();
      }
      updateBadge();
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'TRANSLENS_TOGGLE_PERSISTENT') {
        state.hoverEnabled = !state.hoverEnabled;
        hideOverlay();
        showHoverToggleBadge();
        if (state.hoverEnabled) resumeHoverAtLastPoint();
        sendResponse({ persistentMode: state.hoverEnabled, hoverEnabled: state.hoverEnabled });
        return;
      }
      if (message?.type === 'TRANSLENS_GET_STATUS') {
        sendResponse({
          persistentMode: state.hoverEnabled,
          hoverEnabled: state.hoverEnabled,
          active: isActiveForPage()
        });
      }
    });
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      hideOverlay();
      clearNativeSelection();
      return;
    }
    if (!isOptionEvent(event)) {
      if (state.altDown) state.optionChordUsed = true;
      return;
    }
    if (event.repeat || state.altDown || !isActiveForPage() || isTypingTarget(event.target)) return;
    state.altDown = true;
    state.optionPressStartedAt = performance.now();
    state.optionChordUsed = false;
    state.optionPointerUsed = false;
    state.optionPreviousHoverEnabled = state.hoverEnabled;
    hideOverlay();
  }

  function onKeyUp(event) {
    if (!isOptionEvent(event) || !state.altDown) return;
    const duration = performance.now() - state.optionPressStartedAt;
    const shouldToggle = isOptionTap(
      duration,
      state.optionChordUsed,
      state.optionPointerUsed
    );
    state.altDown = false;
    if (shouldToggle) {
      state.hoverEnabled = !state.optionPreviousHoverEnabled;
      hideOverlay();
      showHoverToggleBadge();
    } else {
      state.hoverEnabled = state.optionPreviousHoverEnabled;
    }
    resetOptionPress();
    if (state.hoverEnabled && !state.selectionDraft && !state.selectionPinned) {
      resumeHoverAtLastPoint();
    }
  }

  function onPointerDown(event) {
    if (
      event.button !== 0
      || !(event.altKey || state.altDown)
      || !isActiveForPage()
      || isSkippableElement(event.target)
    ) return;

    state.optionPointerUsed = true;

    const anchor = getTextCaret(event.clientX, event.clientY);
    if (!anchor) return;

    event.preventDefault();
    hideOverlay();
    clearNativeSelection();
    const anchorContainer = anchor.node.parentElement.closest(BLOCK_SELECTOR)
      || anchor.node.parentElement;
    state.selectionDraft = {
      anchor,
      anchorContainer,
      extentStart: anchor,
      extentEnd: anchor,
      candidate: null,
      startX: event.clientX,
      startY: event.clientY,
      maxDistance: 0
    };
    state.lastPoint = { x: event.clientX, y: event.clientY };
    beginBrushStroke(event.clientX, event.clientY, event.target);
  }

  function onPointerMove(event) {
    state.lastPoint = { x: event.clientX, y: event.clientY };

    if (state.selectionDraft) {
      event.preventDefault();
      updateSelectionDistance(event.clientX, event.clientY);
      extendBrushStroke(event.clientX, event.clientY);
      updateSelectionDraft(event.clientX, event.clientY);
      return;
    }

    if (state.selectionPinned) return;

    if (state.altDown || event.altKey) {
      if (state.overlayMode || state.candidateKey) hideOverlay();
      return;
    }

    if (!isInteractionEnabled()) {
      hideOverlay();
      return;
    }

    if (state.overlayMode === 'lens' && state.candidateKey) {
      positionLens(state.lastPoint);
    }

    if (state.framePending) return;
    state.framePending = true;
    requestAnimationFrame(() => {
      state.framePending = false;
      const now = performance.now();
      if (now - state.lastEvaluationAt < 32) return;
      state.lastEvaluationAt = now;
      if (state.lastPoint) evaluatePoint(state.lastPoint.x, state.lastPoint.y);
    });
  }

  function onPointerUp(event) {
    if (!state.selectionDraft) return;
    event.preventDefault();
    updateSelectionDistance(event.clientX, event.clientY);
    extendBrushStroke(event.clientX, event.clientY);
    updateSelectionDraft(event.clientX, event.clientY);

    const draft = state.selectionDraft;
    const preciseSelection = isIntentionalDrag(draft.maxDistance);
    const candidate = preciseSelection
      ? draft.candidate
      : sentenceCandidateAtCaret(draft.anchor);
    state.selectionDraft = null;
    state.ignoreClickUntil = Date.now() + 250;

    if (!candidate) {
      clearNativeSelection();
      hideOverlay();
      return;
    }

    state.selectionPinned = true;
    state.candidateKey = candidate.key;
    state.candidate = candidate;
    candidate.selectionMode = preciseSelection ? 'precise' : 'sentence';
    if (!preciseSelection) flashBadge('已吸附完整句子');
    beginTranslation(candidate, 'brush');
  }

  function onPageClick() {
    if (Date.now() < state.ignoreClickUntil) return;
    if (state.selectionPinned) {
      hideOverlay();
      clearNativeSelection();
    }
  }

  function isOptionEvent(event) {
    return event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight';
  }

  function isTypingTarget(target) {
    const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
    return Boolean(element?.closest('input, textarea, select, [contenteditable], [role="textbox"]'));
  }

  function resetOptionPress() {
    state.optionPressStartedAt = 0;
    state.optionChordUsed = false;
    state.optionPointerUsed = false;
    state.optionPreviousHoverEnabled = state.hoverEnabled;
  }

  function resumeHoverAtLastPoint() {
    if (!state.lastPoint || !isInteractionEnabled() || state.selectionPinned) return;
    requestAnimationFrame(() => {
      if (state.lastPoint && isInteractionEnabled() && !state.selectionPinned) {
        evaluatePoint(state.lastPoint.x, state.lastPoint.y);
      }
    });
  }

  function isInteractionEnabled() {
    if (!isActiveForPage()) return false;
    return state.hoverEnabled && !state.altDown;
  }

  function isActiveForPage() {
    return isSiteEnabled(state.settings, location.hostname);
  }

  function evaluatePoint(x, y) {
    if (!isInteractionEnabled() || state.selectionPinned) return;
    const candidates = getCandidatesInInk(x, y);
    if (!candidates.length) {
      window.clearTimeout(state.hoverTimer);
      if ((state.overlayMode || state.candidateKey) && !state.leaveTimer) {
        state.leaveTimer = window.setTimeout(() => {
          state.leaveTimer = 0;
          hideOverlay();
        }, HOVER_LEAVE_DELAY);
      }
      return;
    }
    window.clearTimeout(state.leaveTimer);
    state.leaveTimer = 0;
    const combinedKey = candidates.map((candidate) => candidate.key).sort().join('\n');
    if (combinedKey === state.candidateKey) {
      if (state.overlayMode === 'lens') positionLens({ x, y });
      return;
    }

    clearTimers();
    state.requestId += 1;
    ui.status.hidden = true;
    state.statusRequestId = 0;
    if (state.overlayMode !== 'lens') hideVisuals();
    state.candidateKey = combinedKey;
    state.candidate = candidates[0];
    state.lensCandidates = candidates;
    state.candidatePoint = { x, y };
    const currentKey = combinedKey;
    state.hoverTimer = window.setTimeout(() => {
      if (state.candidateKey === currentKey) beginLensTranslations(candidates, currentKey);
    }, resolveHoverDelay(state.settings.hoverDelay));
  }

  function getCandidatesInInk(x, y) {
    const blockCache = new Map();
    const candidate = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight
      ? getCandidateAtPoint(x, y, blockCache)
      : null;
    ui.host.dataset.translensLastScanSamples = '1';
    ui.host.dataset.translensLastScanBlocks = String(blockCache.size);
    return candidate ? [candidate] : [];
  }

  function getCandidateAtPoint(x, y, blockCache = new Map()) {
    const caret = getTextCaret(x, y);
    if (!caret) return null;
    if (!isPointOverTextCharacter(caret, x, y)) return null;
    const { node: textNode } = caret;
    const container = textNode.parentElement.closest(BLOCK_SELECTOR) || textNode.parentElement;
    if (!container || isSkippableElement(container)) return null;

    const maxLength = Math.max(40, Number(state.settings.maxLength) || 500);
    let block = blockCache.get(container);
    if (!blockCache.has(container)) {
      const mapping = collectTextMapping(container, Math.max(2000, maxLength * 12));
      block = mapping.entries.length ? { mapping, candidates: new Map() } : null;
      blockCache.set(container, block);
    }
    if (!block) return null;

    const entry = block.mapping.entries.find((item) => item.node === textNode);
    if (!entry) return null;
    const offset = Math.min(block.mapping.text.length, entry.start + caret.offset);
    // 悬停翻译与 Alt/Option 轻点固定整句是两条路径。
    // 无论旧设置里保存过 sentence 还是 paragraph，悬停都必须只取局部短语。
    const unit = 'phrase';
    const fontSize = Number.parseFloat(getComputedStyle(container).fontSize) || 16;
    const inkSize = Math.max(40, Math.min(300, Number(state.settings.inkSize) || 120));
    const phraseWordLimit = Math.max(2, Math.min(4, Math.floor(inkSize / fontSize)));
    const segment = unit === 'paragraph'
      ? { start: 0, end: block.mapping.text.length, text: normalizeText(block.mapping.text) }
      : unit === 'sentence'
        ? findSentence(block.mapping.text, offset, configuredSourceLanguage())
        : findPhrase(
          block.mapping.text,
          offset,
          configuredSourceLanguage(),
          phraseWordLimit
        );
    const singleWord = !/\s/.test(segment?.text || '');
    const hoverMinLength = singleWord ? 1 : 3;
    if (!segment || !looksTranslatable(segment.text, hoverMinLength, maxLength)) return null;
    if (singleWord && !isMeaningfulHoverWord(segment.text)) return null;

    const segmentKey = `${unit}|${segment.start}:${segment.end}`;
    if (block.candidates.has(segmentKey)) {
      const cachedCandidate = block.candidates.get(segmentKey);
      return cachedCandidate && isPointOverTextRects(x, y, cachedCandidate.rects)
        ? cachedCandidate
        : null;
    }
    const range = rangeFromOffsets(block.mapping.entries, segment.start, segment.end);
    if (!range) {
      block.candidates.set(segmentKey, null);
      return null;
    }
    const candidate = candidateFromRange(range, segment.text, container, `lens-${unit}`);
    if (!candidate) {
      block.candidates.set(segmentKey, null);
      return null;
    }
    candidate.detectionText = findSentence(
      block.mapping.text,
      offset,
      configuredSourceLanguage()
    )?.text || block.mapping.text;
    if (unit === 'paragraph') {
      candidate.translationChunks = splitTranslationChunks(
        segment.text,
        maxLength,
        configuredSourceLanguage()
      );
    }
    candidate.phraseWordLimit = phraseWordLimit;
    block.candidates.set(segmentKey, candidate);
    return isPointOverTextRects(x, y, candidate.rects) ? candidate : null;
  }

  function isPointOverTextRects(x, y, rects) {
    return rects.some((rect) => (
      x >= rect.left - 3
      && x <= rect.right + 3
      && y >= rect.top - 4
      && y <= rect.bottom + 4
    ));
  }

  function isPointOverTextCharacter(caret, x, y) {
    const node = caret?.node;
    if (!node?.data) return false;
    const offset = Math.max(0, Math.min(Number(caret.offset) || 0, node.data.length));
    const offsets = [...new Set([offset, offset - 1])]
      .filter((index) => index >= 0 && index < node.data.length);
    for (const index of offsets) {
      if (!/[\p{L}\p{N}]/u.test(node.data[index])) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const hit = [...range.getClientRects()].some((rect) => (
        x >= rect.left - 1
        && x <= rect.right + 1
        && y >= rect.top - 2
        && y <= rect.bottom + 2
      ));
      if (hit) return true;
    }
    return false;
  }

  function getTextCaret(x, y) {
    const caret = getCaret(x, y);
    if (!caret?.node) return null;
    const textNode = caret.node.nodeType === Node.TEXT_NODE
      ? caret.node
      : findTextNode(caret.node, caret.offset);
    if (!textNode || !textNode.parentElement || isSkippableElement(textNode.parentElement)) {
      return null;
    }
    return {
      node: textNode,
      offset: Math.min(caret.offset, textNode.data.length)
    };
  }

  function getCaret(x, y) {
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      return position ? { node: position.offsetNode, offset: position.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      return range ? { node: range.startContainer, offset: range.startOffset } : null;
    }
    return null;
  }

  function findTextNode(node, childOffset) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    const child = node.childNodes[Math.min(childOffset, node.childNodes.length - 1)];
    const walker = document.createTreeWalker(child || node, NodeFilter.SHOW_TEXT);
    return walker.nextNode();
  }

  function collectTextMapping(container, maxChars = Number(state.settings.maxLength) * 4) {
    const entries = [];
    let text = '';
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data || !node.data.trim() || !node.parentElement) {
          return NodeFilter.FILTER_REJECT;
        }
        if (isSkippableElement(node.parentElement)) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(node.parentElement);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const start = text.length;
      text += node.data;
      entries.push({ node, start, end: text.length });
      if (text.length > maxChars) break;
    }
    return { text, entries };
  }

  function rangeFromOffsets(entries, start, end) {
    const first = entries.find((entry) => start >= entry.start && start <= entry.end);
    const last = [...entries].reverse().find((entry) => end >= entry.start && end <= entry.end);
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, Math.max(0, start - first.start));
    range.setEnd(last.node, Math.min(last.node.data.length, end - last.start));
    return range;
  }

  function updateSelectionDraft(x, y) {
    const focus = getTextCaret(x, y);
    if (!focus) return;
    const draft = state.selectionDraft;
    if (!draft.anchorContainer?.contains(focus.node)) return;
    if (isPointBefore(focus, draft.extentStart)) draft.extentStart = focus;
    if (isPointBefore(draft.extentEnd, focus)) draft.extentEnd = focus;
    const range = rangeBetween(draft.extentStart, draft.extentEnd);
    if (!range || range.collapsed) return;

    const text = normalizeText(range.toString());
    if (!looksTranslatable(text, Number(state.settings.minLength), Number(state.settings.maxLength))) {
      draft.candidate = null;
      return;
    }

    const candidate = candidateFromRange(range, text, draft.anchorContainer, 'selection');
    if (!candidate) return;

    draft.candidate = candidate;
  }

  function updateSelectionDistance(x, y) {
    if (!state.selectionDraft) return;
    const distance = Math.hypot(
      x - state.selectionDraft.startX,
      y - state.selectionDraft.startY
    );
    state.selectionDraft.maxDistance = Math.max(state.selectionDraft.maxDistance, distance);
  }

  function sentenceCandidateAtCaret(caret) {
    if (!caret?.node?.parentElement) return null;
    const container = caret.node.parentElement.closest(BLOCK_SELECTOR) || caret.node.parentElement;
    if (!container || isSkippableElement(container)) return null;

    const mapping = collectTextMapping(container, 6000);
    const entry = mapping.entries.find((item) => item.node === caret.node);
    if (!entry || !mapping.text) return null;

    let offset = Math.min(mapping.text.length, entry.start + caret.offset);
    if (offset === mapping.text.length && offset > 0) offset -= 1;
    while (offset > 0 && /\s/.test(mapping.text[offset])) offset -= 1;
    const sentence = findSentence(
      mapping.text,
      offset,
      configuredSourceLanguage()
    );
    if (!sentence || !looksTranslatable(
      sentence.text,
      Number(state.settings.minLength),
      Number(state.settings.maxLength)
    )) return null;

    const range = rangeFromOffsets(mapping.entries, sentence.start, sentence.end);
    if (!range) return null;
    return candidateFromRange(range, sentence.text, container, 'selection-sentence');
  }

  function rangeBetween(anchor, focus) {
    const anchorBeforeFocus = isPointBefore(anchor, focus);
    const start = anchorBeforeFocus ? anchor : focus;
    const end = anchorBeforeFocus ? focus : anchor;
    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    } catch {
      return null;
    }
  }

  function isPointBefore(a, b) {
    if (a.node === b.node) return a.offset <= b.offset;
    return Boolean(a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function candidateFromRange(range, text, container, kind) {
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1);
    if (!rects.length || !container) return null;
    const key = `${kind}|${location.href}|${text}|${rects[0].left}:${rects[0].top}`;
    return {
      key,
      kind,
      text,
      detectionText: text,
      range: range.cloneRange(),
      rects,
      container
    };
  }

  async function resolveSourceLanguage(candidate, requestId) {
    const configured = state.settings.sourceLanguage || 'auto';
    if (configured !== 'auto') {
      candidate.resolvedSourceLanguage = configured;
      ui.host.dataset.translensSourceLanguage = configured;
      return configured;
    }
    if (candidate.resolvedSourceLanguage) return candidate.resolvedSourceLanguage;
    const context = normalizeText(candidate.detectionText || candidate.text).slice(0, 1800);
    const cacheKey = context;
    const cached = state.languageDetectionCache.get(cacheKey);
    if (cached) {
      candidate.resolvedSourceLanguage = cached.language;
      ui.host.dataset.translensSourceLanguage = cached.language;
      return cached.language;
    }
    if (!context) throw new Error('LANGUAGE_DETECTION_FAILED');

    const detected = await detectSourceLanguage(context);
    if (requestId !== state.requestId) throw new Error('STALE_REQUEST');
    if (!detected?.language || detected.confidence < 0.55) {
      throw new Error('LANGUAGE_DETECTION_FAILED');
    }
    state.languageDetectionCache.set(cacheKey, detected);
    candidate.resolvedSourceLanguage = detected.language;
    ui.host.dataset.translensSourceLanguage = detected.language;
    return detected.language;
  }

  async function detectSourceLanguage(text) {
    const extensionResult = await detectWithChromeI18n(text);
    if (extensionResult?.confidence >= 0.55) return extensionResult;

    if (state.languageDetector !== false) {
      try {
        if (!state.languageDetector) {
          state.languageDetector = await createLanguageDetector({
            detectorApi: globalThis.LanguageDetector
          });
        }
        const result = await detectLanguage(text, { detector: state.languageDetector });
        if (result?.language) return normalizeDetectedLanguage(result);
      } catch {
        state.languageDetector = false;
      }
    }

    return inferDetectedLanguage(text);
  }

  function detectWithChromeI18n(text) {
    if (!chrome.i18n?.detectLanguage) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.i18n.detectLanguage(text, (result) => {
          const best = result?.languages?.[0];
          resolve(best?.language
            ? {
              language: normalizeLanguageCode(best.language),
              confidence: Math.max(0, Math.min(1, Number(best.percentage || 0) / 100))
            }
            : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function normalizeDetectedLanguage(result) {
    return {
      language: normalizeLanguageCode(result.language),
      confidence: Number(result.confidence) || 0
    };
  }

  function normalizeLanguageCode(value) {
    const language = String(value || '').replace('_', '-');
    if (/^zh-(?:tw|hk|hant)/i.test(language)) return 'zh-Hant';
    if (/^iw$/i.test(language)) return 'he';
    return language.split('-')[0].toLowerCase();
  }

  function inferDetectedLanguage(text) {
    if (/[぀-ヿ]/u.test(text)) return { language: 'ja', confidence: 0.82 };
    if (/[가-힯]/u.test(text)) return { language: 'ko', confidence: 0.82 };
    if (/[฀-๿]/u.test(text)) return { language: 'th', confidence: 0.82 };
    if (/[؀-ۿ]/u.test(text)) return { language: 'ar', confidence: 0.82 };
    if (/[ऀ-ॿ]/u.test(text)) return { language: 'hi', confidence: 0.82 };
    if (/[Ѐ-ӿ]/u.test(text)) return { language: 'ru', confidence: 0.68 };
    if (/[一-鿿]/u.test(text)) return { language: 'zh', confidence: 0.82 };
    if (/[A-Za-z]/u.test(text)) return { language: 'en', confidence: 0.56 };
    return null;
  }

  async function beginTranslation(candidate, mode) {
    const requestId = ++state.requestId;
    state.loadingTimer = window.setTimeout(() => showLoading(candidate.rects, requestId), 150);
    try {
      const sourceLanguage = await resolveSourceLanguage(candidate, requestId);
      const cacheKey = translationCacheKey(candidate.text, sourceLanguage);
      let translation = state.cache.get(cacheKey);
      if (!translation) {
        translation = await translate(candidate.text, requestId, sourceLanguage);
        remember(cacheKey, translation);
      }
      if (requestId !== state.requestId || candidate.key !== state.candidateKey) {
        hideStatusForRequest(requestId);
        return;
      }
      window.clearTimeout(state.loadingTimer);
      hideStatusForRequest(requestId);
      if (mode === 'inline') {
        showInlineReplacement(candidate, translation);
        clearNativeSelection();
      } else if (mode === 'brush') {
        showBrushReveal(candidate, translation);
        clearNativeSelection();
      } else {
        showLens(candidate, translation);
      }
    } catch (error) {
      if (requestId !== state.requestId) {
        hideStatusForRequest(requestId);
        return;
      }
      window.clearTimeout(state.loadingTimer);
      showError(candidate.rects, friendlyError(error), requestId);
    }
  }

  async function beginLensTranslations(candidates, combinedKey) {
    const requestId = ++state.requestId;
    const resolved = new Map();
    const pending = [];
    let lastRecoverableError = null;

    const failed = [];
    for (const candidate of candidates) {
      try {
        const sourceLanguage = await resolveSourceLanguage(candidate, requestId);
        const translation = state.cache.get(translationCacheKey(candidate.text, sourceLanguage));
        if (translation) resolved.set(candidate.key, { candidate, translation });
        else pending.push(candidate);
      } catch (error) {
        if (error?.message === 'STALE_REQUEST') return;
        lastRecoverableError = error;
        failed.push(candidate);
      }
    }

    if (!isCurrentLensRequest(requestId, combinedKey)) return;
    if (resolved.size) showLensEntries(orderedResolvedEntries(candidates, resolved));

    if (pending.length) {
      const statusRects = [...pending, ...failed].flatMap((candidate) => candidate.rects);
      state.loadingTimer = window.setTimeout(() => showLoading(statusRects, requestId), 150);
    }

    try {
      for (const candidate of pending) {
        let translation;
        try {
          translation = await translateLensCandidate(candidate, requestId);
        } catch (error) {
          if (error?.message === 'DEMO_TRANSLATION_UNAVAILABLE') {
            lastRecoverableError = error;
            continue;
          }
          throw error;
        }
        remember(translationCacheKey(candidate.text, candidate.resolvedSourceLanguage), translation);
        if (!isCurrentLensRequest(requestId, combinedKey)) {
          hideStatusForRequest(requestId);
          return;
        }
        resolved.set(candidate.key, { candidate, translation });
        showLensEntries(orderedResolvedEntries(candidates, resolved));
      }
      window.clearTimeout(state.loadingTimer);
      if (!resolved.size && lastRecoverableError) {
        showError(
          failed[0]?.rects || pending[0]?.rects || candidates[0].rects,
          friendlyError(lastRecoverableError),
          requestId
        );
        return;
      }
      hideStatusForRequest(requestId);
    } catch (error) {
      if (!isCurrentLensRequest(requestId, combinedKey)) {
        hideStatusForRequest(requestId);
        return;
      }
      window.clearTimeout(state.loadingTimer);
      if (resolved.size) {
        hideStatusForRequest(requestId);
        return;
      }
      showError(failed[0]?.rects || pending[0]?.rects || candidates[0].rects, friendlyError(error), requestId);
    }
  }

  function isCurrentLensRequest(requestId, combinedKey) {
    return requestId === state.requestId
      && combinedKey === state.candidateKey
      && !state.selectionPinned;
  }

  function orderedResolvedEntries(candidates, resolved) {
    return candidates.map((candidate) => resolved.get(candidate.key)).filter(Boolean);
  }

  function translationCacheKey(text, sourceLanguage = state.settings.sourceLanguage || 'auto') {
    return `${state.settings.engine}|${sourceLanguage}|`
      + `${state.settings.targetLanguage}|${text}`;
  }

  async function translateLensCandidate(candidate, requestId) {
    const chunks = candidate.translationChunks?.length
      ? candidate.translationChunks
      : [candidate.text];
    const translations = [];
    for (const chunk of chunks) {
      if (requestId !== state.requestId) throw new Error('STALE_REQUEST');
      const cacheKey = translationCacheKey(chunk, candidate.resolvedSourceLanguage);
      let translation = state.cache.get(cacheKey);
      if (!translation) {
        translation = await translate(chunk, requestId, candidate.resolvedSourceLanguage);
        remember(cacheKey, translation);
      }
      translations.push(translation);
    }
    return translations.join(' ');
  }

  async function translate(text, requestId, sourceLanguage) {
    const targetLanguage = state.settings.targetLanguage || 'zh';
    if (normalizeLanguageCode(sourceLanguage) === normalizeLanguageCode(targetLanguage)) {
      return text;
    }
    if (state.settings.engine === 'local') {
      return translateLocally(text, requestId, sourceLanguage);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    return mockTranslate(text);
  }

  async function translateLocally(text, requestId, sourceLanguage) {
    const targetLanguage = state.settings.targetLanguage || 'zh';
    const key = `${sourceLanguage}:${targetLanguage}`;
    if (!state.translator || state.translatorKey !== key) {
      const model = await inspectLocalModel({
        translatorApi: globalThis.Translator,
        sourceLanguage,
        targetLanguage
      });
      if (model.status === LOCAL_MODEL_STATUS.UNSUPPORTED) {
        throw new Error('TRANSLATOR_API_UNSUPPORTED');
      }
      if (model.status === LOCAL_MODEL_STATUS.UNAVAILABLE) {
        throw new Error('LANGUAGE_PAIR_UNAVAILABLE');
      }
      if (model.status === LOCAL_MODEL_STATUS.ERROR) {
        throw model.error || new Error('MODEL_CHECK_FAILED');
      }
      if (
        model.status === LOCAL_MODEL_STATUS.DOWNLOADABLE
        && state.settings.sourceLanguage !== 'auto'
        && state.settings.localModelStatus !== LOCAL_MODEL_STATUS.READY
      ) {
        throw new Error('MODEL_NOT_READY');
      }
      showPreparing(undefined, requestId);
      try {
        state.translator = await createTranslator({
          translatorApi: globalThis.Translator,
          sourceLanguage,
          targetLanguage,
          onProgress(progress) {
            showPreparing(progress, requestId);
          }
        });
      } catch (error) {
        if (error?.name === 'NotAllowedError') {
          await chrome.storage.local.set({
            localModelStatus: LOCAL_MODEL_STATUS.DOWNLOADABLE,
            localModelProgress: 0
          });
          throw new Error('MODEL_NOT_READY');
        }
        throw error;
      }
      state.translatorKey = key;
      await chrome.storage.local.set({
        localModelStatus: LOCAL_MODEL_STATUS.READY,
        localModelProgress: 100
      });
    }
    return state.translator.translate(text);
  }

  function mockTranslate(text) {
    const known = new Map([
      ['The company plans to release the product later this year.',
        '该公司计划于今年晚些时候发布这款产品。'],
      ['company', '公司'],
      ['plans', '计划'],
      ['release', '发布'],
      ['product', '产品'],
      ['later', '之后'],
      ['year', '年份'],
      ['assistant', '助手'],
      ['the form', '这种形式'],
      ['a user', '一名用户'],
      ['an assistant', '一名助手'],
      ['for chat', '用于聊天'],
      ['The company plans to release',
        '该公司计划发布'],
      ['the product later this year',
        '这款产品将在今年晚些时候推出'],
      ['and an assistant',
        '以及一名助手'],
      ['an assistant',
        '一名助手'],
      ['a user and an assistant',
        '一名用户和一名助手'],
      ['Hover over this sentence while holding the Alt key.',
        '按住 Option 键，将鼠标悬停在这个句子上。'],
      ['Moving the pointer away restores the original English text.',
        '移开鼠标后，原始英文会立即恢复。'],
      ['TransLens only translates the sentence you are currently reading.',
        '译镜只翻译你当前正在阅读的句子。'],
      ['TransLens only translates the sentence',
        '译镜只翻译这个句子'],
      ['you are currently reading',
        '你当前正在阅读的内容'],
      ['for chat and Cowork conversations',
        '聊天和 Cowork 对话'],
      ['across longer sessions',
        '跨越更长的会话'],
      ['A Layered Reading Experience',
        '分层式阅读体验'],
      ['The original article stays on the surface.',
        '原始文章保留在表层。'],
      ['Move the ink across this boundary to reveal both translated blocks at once.',
        '让墨迹扫过这条分界线，即可同时揭开两块译文。'],
      ['Nearby translated passages are prepared only when the lens approaches them.',
        '附近的段落只会在墨迹接近时按需准备译文。'],
      ['One year ago, most Claude usage took the form of individual conversations. With the rapid growth of Claude Code and Cowork, people are increasingly coordinating complex projects across longer sessions. Those workflows no longer fully capture how people are using AI, so our measures of economic impact have had to adapt.',
        '一年前，Claude 的使用大多是独立对话。随着 Claude Code 和 Cowork 的快速增长，人们越来越多地在更长的会话中协调复杂项目。原有方式已无法完整反映人们使用人工智能的方式，因此我们衡量经济影响的方法也必须随之调整。'],
      ['To keep pace, we made several changes to our methodology.',
        '为了跟上变化，我们对研究方法作出了多项调整。'],
      ['Small title',
        '面向复杂产品团队的设计系统'],
      ['A concise English sentence.',
        '用于验证狭窄内容区域的中文译文。'],
      ['Right aligned product update.',
        '这是用于确认右对齐译文仍然遵循原始内容区域的产品更新说明。'],
      ['This sentence wraps across multiple lines so the prototype can verify that a longer sentence is still located as one continuous translation target when the browser lays it out over more than one visual line.',
        '这个句子会自动换成多行，用来验证浏览器完成排版后，较长的句子仍然能够作为一个连续且完整的翻译目标被识别。'],
      ['Hold Alt or Option and drag across part of this sentence to replace only the selected passage in place.',
        '按住 Alt 或 Option 键并拖过句子的一部分，即可只在原位置替换所选文字。'],
      ['Sample data at a higher frequency so we can inspect the hourly usage pattern without leaving fragments of the original sentence visible at either edge.',
        '以更高的频率对数据进行采样，让我们能够查看每小时的使用模式。']
    ]);
    const translation = known.get(text);
    if (!translation) throw new Error('DEMO_TRANSLATION_UNAVAILABLE');
    return translation;
  }

  function remember(key, value) {
    state.cache.set(key, value);
    if (state.cache.size > 300) state.cache.delete(state.cache.keys().next().value);
  }

  function showLens(candidate, translation) {
    showLensEntries([{ candidate, translation }]);
  }

  function showLensEntries(entries) {
    if (!entries.length) return;
    if (state.overlayMode !== 'lens') hideVisuals();
    state.overlayMode = 'lens';
    ui.host.dataset.translensOverlayMode = 'lens';
    ui.host.dataset.translensHoverUnit = entries[0].candidate.kind.replace('lens-', '');
    ui.host.dataset.translensSourceLanguage = entries[0].candidate.resolvedSourceLanguage || '';
    ui.host.dataset.translensTargetLanguage = state.settings.targetLanguage || 'zh';
    ui.host.dataset.translensPhraseWordLimit = String(entries[0].candidate.phraseWordLimit || '');
    ui.host.dataset.translensCoverStrategy = entries[0].candidate.kind === 'lens-phrase'
      ? 'active-source-and-translated-line'
      : 'source-block';
    ui.lens.hidden = false;
    renderTranslatedLayers(entries);
    const themeCandidate = findNearestCandidate(
      entries.map((entry) => entry.candidate),
      state.lastPoint
    ) || entries[0].candidate;
    const inkTheme = buildInkTheme(themeCandidate.container);
    if (!state.inkPhase) state.inkPhase = stableInkPhase(themeCandidate.key);
    ui.lensGlass.style.setProperty('--ink-wash', inkTheme.wash);
    ui.lensGlass.style.setProperty('--ink-edge', inkTheme.edge);
    ui.inkCursor.style.setProperty('--ink-cursor', inkTheme.cursor);
    ui.inkCursor.hidden = false;
    positionLens(state.lastPoint || {
      x: themeCandidate.rects[0].left + themeCandidate.rects[0].width / 2,
      y: themeCandidate.rects[0].top + themeCandidate.rects[0].height / 2
    });
  }

  function findNearestCandidate(candidates, point) {
    if (!point) return candidates[0] || null;
    return candidates.reduce((nearest, candidate) => {
      const bounds = unionRects(candidate.rects);
      const centerX = bounds.left + bounds.width / 2;
      const centerY = bounds.top + bounds.height / 2;
      const distance = Math.hypot(point.x - centerX, point.y - centerY);
      return !nearest || distance < nearest.distance ? { candidate, distance } : nearest;
    }, null)?.candidate || null;
  }

  function renderTranslatedLayers(entries) {
    ui.inkCovers.replaceChildren();
    ui.lensTexts.replaceChildren();
    for (const entry of entries) {
      populateTranslatedLayer(
        entry.candidate,
        entry.translation,
        true,
        entry.candidate.kind === 'lens-phrase' ? 'source-lines' : 'block'
      );
    }
  }

  function populateTranslatedLayer(candidate, translation, append = false, coverMode = 'block') {
    const computed = getComputedStyle(candidate.container);
    const textBounds = unionRects(candidate.rects);
    const layout = translatedLayout(candidate, computed, textBounds);
    const background = findBackground(candidate.container, 1);

    if (!append) {
      ui.inkCovers.replaceChildren();
      ui.lensTexts.replaceChildren();
    }

    const lensText = document.createElement('div');
    lensText.className = 'lens-text';
    lensText.textContent = translation;
    lensText.lang = state.settings.targetLanguage === 'zh' ? 'zh-CN' : state.settings.targetLanguage;
    Object.assign(lensText.style, {
      left: `${layout.left}px`,
      top: `${layout.top}px`,
      width: `${layout.width}px`,
      height: `${layout.height}px`,
      minHeight: '0',
      color: computed.color,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      fontStyle: computed.fontStyle,
      fontStretch: computed.fontStretch,
      fontVariant: computed.fontVariant,
      letterSpacing: computed.letterSpacing,
      wordSpacing: computed.wordSpacing,
      lineHeight: computed.lineHeight === 'normal' ? '1.45' : computed.lineHeight,
      textAlign: candidate.kind === 'lens-phrase' ? 'center' : computed.textAlign,
      direction: computed.direction,
      writingMode: computed.writingMode,
      background: 'transparent'
    });
    ui.lensTexts.appendChild(lensText);
    fitTranslatedText(lensText, layout, computed, candidate);
    const translatedRects = ['lines', 'source-lines'].includes(coverMode)
      ? textClientRects(lensText)
      : [];
    const coverRects = coverMode === 'lines'
      ? mergeLineRects([...candidate.rects, ...translatedRects])
      : coverMode === 'source-lines' && candidate.kind === 'lens-phrase'
        ? mergeLineRects([layout.sourceRect || candidate.rects[0], ...translatedRects])
        : coverMode === 'source-lines'
          ? mergeLineRects([...candidate.rects, ...translatedRects])
          : [textBounds];
    const lineCover = ['lines', 'source-lines'].includes(coverMode);
    for (const rect of coverRects) {
      const cover = document.createElement('span');
      cover.className = `ink-cover${coverMode === 'lines' ? ' brush-line-cover' : ''}`;
      const horizontalPadding = lineCover ? 3 : 1;
      const verticalPadding = lineCover ? 1.5 : 1;
      Object.assign(cover.style, {
        left: `${rect.left - horizontalPadding}px`,
        top: `${rect.top - verticalPadding}px`,
        width: `${rect.width + horizontalPadding * 2}px`,
        height: `${rect.height + verticalPadding * 2}px`,
        background
      });
      ui.inkCovers.appendChild(cover);
    }
  }

  function textClientRects(element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1);
  }

  function translatedLayout(candidate, computed, textBounds) {
    const containerBounds = candidate.container.getBoundingClientRect();
    const borderLeft = Number.parseFloat(computed.borderLeftWidth) || 0;
    const borderRight = Number.parseFloat(computed.borderRightWidth) || 0;
    const paddingLeft = Number.parseFloat(computed.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(computed.paddingRight) || 0;
    const contentLeft = containerBounds.left + borderLeft + paddingLeft;
    const contentRight = containerBounds.right - borderRight - paddingRight;
    const contentWidth = contentRight - contentLeft;
    const blockLike = !['inline', 'contents'].includes(computed.display)
      && contentWidth > 4
      && containerBounds.height > 0;
    const centered = ['center', '-webkit-center'].includes(computed.textAlign);
    const rightAligned = ['right', 'end', '-webkit-right'].includes(computed.textAlign);
    if (candidate.kind === 'lens-phrase' && blockLike) {
      const anchorPoint = state.candidatePoint || state.lastPoint;
      const anchorRect = candidateAnchorRect(candidate.rects, anchorPoint)
        || candidate.rects[0]
        || textBounds;
      const desiredWidth = Math.min(
        contentWidth,
        Math.max(32, anchorRect.width + Math.min(24, contentWidth * 0.04))
      );
      const fontSize = Number.parseFloat(computed.fontSize) || 16;
      const lineHeight = Number.parseFloat(computed.lineHeight) || fontSize * 1.45;
      const phraseHeight = Math.max(anchorRect.height, lineHeight);
      const anchorX = anchorPoint
        && anchorPoint.x >= anchorRect.left - 4
        && anchorPoint.x <= anchorRect.right + 4
        ? anchorPoint.x
        : anchorRect.left + anchorRect.width / 2;
      const phraseLeft = Math.max(
        contentLeft,
        Math.min(anchorX - desiredWidth / 2, contentRight - desiredWidth)
      );
      return {
        left: phraseLeft,
        top: anchorRect.top - Math.max(0, phraseHeight - anchorRect.height) / 2,
        width: desiredWidth,
        height: phraseHeight,
        sourceRect: anchorRect
      };
    }
    const left = blockLike && (centered || rightAligned)
      ? contentLeft
      : Math.max(contentLeft, textBounds.left);
    const availableRight = blockLike ? contentRight : textBounds.right;
    return {
      left,
      top: textBounds.top,
      width: Math.max(4, availableRight - left),
      height: Math.max(1, textBounds.height)
    };
  }

  function candidateAnchorRect(rects, point) {
    if (!rects?.length) return null;
    if (!point) return rects[0];
    return rects.find((rect) => (
      point.x >= rect.left - 4
      && point.x <= rect.right + 4
      && point.y >= rect.top - 4
      && point.y <= rect.bottom + 4
    )) || rects.find((rect) => (
      point.y >= rect.top - 4
      && point.y <= rect.bottom + 4
    )) || rects[0];
  }

  function fitTranslatedText(element, layout, computed, candidate) {
    if (computed.writingMode && !computed.writingMode.startsWith('horizontal')) return;
    const baseFontSize = Number.parseFloat(computed.fontSize) || 16;
    const parsedLineHeight = Number.parseFloat(computed.lineHeight);
    const baseLineHeight = Number.isFinite(parsedLineHeight)
      ? parsedLineHeight
      : baseFontSize * 1.45;
    if (candidate.kind === 'lens-phrase' && element.scrollHeight > layout.height + 1) {
      const expandedHeight = Math.min(element.scrollHeight, baseLineHeight * 2);
      const extraHeight = Math.max(0, expandedHeight - layout.height);
      layout.top -= extraHeight / 2;
      layout.height = expandedHeight;
      element.style.top = `${layout.top}px`;
      element.style.height = `${layout.height}px`;
    }
    let scale = 1;
    for (let pass = 0; pass < 4; pass += 1) {
      const nextScale = calculateTextFitScale(
        element.scrollHeight,
        layout.height,
        scale,
        0.70
      );
      if (nextScale >= scale - 0.005) break;
      scale = nextScale;
      element.style.fontSize = `${(baseFontSize * scale).toFixed(2)}px`;
      element.style.lineHeight = `${(baseLineHeight * scale).toFixed(2)}px`;
    }
    element.dataset.fitScale = scale.toFixed(3);
    element.dataset.overflowing = String(element.scrollHeight > layout.height + 1);
    updateLayoutDiagnostics();
  }

  function updateLayoutDiagnostics() {
    const textLayers = [...ui.lensTexts.children];
    const scales = textLayers
      .map((element) => Number(element.dataset.fitScale))
      .filter(Number.isFinite);
    ui.host.dataset.translensOverflowCount = String(
      textLayers.filter((element) => element.dataset.overflowing === 'true').length
    );
    ui.host.dataset.translensMinFitScale = scales.length
      ? Math.min(...scales).toFixed(3)
      : '1.000';
  }

  function beginBrushStroke(x, y, target) {
    const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
    const inkTheme = buildInkTheme(element || document.body);

    state.overlayMode = 'brush-draft';
    ui.host.dataset.translensOverlayMode = 'brush-draft';
    state.brushWidth = Math.max(12, Math.min(48, Number(state.settings.brushSize) || 24));
    state.brushPoints = [{ x, y, time: performance.now(), width: state.brushWidth * 0.72 }];
    ui.brushClipPath.replaceChildren();
    ui.lensGlass.style.clipPath = `url(#${ui.brushClipId})`;
    appendBrushDot(state.brushPoints[0]);
    ui.lensTexts.replaceChildren();
    ui.inkCovers.replaceChildren();
    ui.lensGlass.style.setProperty('--ink-wash', inkTheme.brushWash);
    ui.lensGlass.style.setProperty('--ink-edge', inkTheme.brushEdge);
    ui.lens.hidden = false;
    ui.inkCursor.hidden = true;
  }

  function extendBrushStroke(x, y) {
    const previous = state.brushPoints[state.brushPoints.length - 1];
    if (!previous) return;
    const distance = Math.hypot(x - previous.x, y - previous.y);
    if (distance < 2.5) return;

    const now = performance.now();
    const elapsed = Math.max(8, now - previous.time);
    const speed = distance / elapsed;
    const pressure = Math.max(0.62, Math.min(1.08, 1.06 - speed * 0.42));
    const wobble = 1 + Math.sin(state.brushPoints.length * 1.71) * 0.055;
    state.brushPoints.push({
      x,
      y,
      time: now,
      width: state.brushWidth * pressure * wobble
    });
    appendBrushSegment(previous, state.brushPoints[state.brushPoints.length - 1]);
    if (state.brushPoints.length > 180) state.brushPoints.shift();
  }

  function appendBrushDot(point) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', point.x.toFixed(1));
    circle.setAttribute('cy', point.y.toFixed(1));
    circle.setAttribute('r', Math.max(1, point.width / 2).toFixed(1));
    ui.brushClipPath.appendChild(circle);
  }

  function appendBrushSegment(before, point) {
    const points = brushSegmentPolygon(before, point);
    if (!points.length) return;
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', points.map(({ x, y }) => (
      `${x.toFixed(1)},${y.toFixed(1)}`
    )).join(' '));
    ui.brushClipPath.appendChild(polygon);
    appendBrushDot(point);
  }

  function showBrushReveal(candidate, translation) {
    state.overlayMode = 'brush';
    ui.host.dataset.translensOverlayMode = 'brush';
    populateTranslatedLayer(candidate, translation, false, 'lines');
    ui.host.dataset.translensBrushCoverCount = String(candidate.rects.length);
    const inkTheme = buildInkTheme(candidate.container);
    ui.lensGlass.style.setProperty(
      '--ink-wash',
      candidate.selectionMode === 'sentence' ? 'transparent' : inkTheme.wash
    );
    ui.lensGlass.style.setProperty('--ink-edge', inkTheme.brushEdge);
    ui.lens.hidden = false;
    ui.inkCursor.hidden = true;
    ui.status.hidden = true;
    if (candidate.selectionMode === 'precise') {
      ui.host.dataset.translensBrushLineCount = 'freeform';
      ui.host.dataset.translensSelectionMode = 'precise';
    } else {
      settleBrushMask(candidate);
    }
  }

  function settleBrushMask(candidate) {
    const translatedRects = [...ui.lensTexts.children].flatMap(textClientRects);
    const lines = mergeLineRects([...candidate.rects, ...translatedRects]);
    const horizontalPadding = Math.max(7, state.brushWidth * 0.32);
    const verticalPadding = Math.max(2, Math.min(5, state.brushWidth * 0.14));
    ui.brushClipPath.replaceChildren();
    for (const line of lines) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const height = line.height + verticalPadding * 2;
      rect.setAttribute('x', (line.left - horizontalPadding).toFixed(1));
      rect.setAttribute('y', (line.top - verticalPadding).toFixed(1));
      rect.setAttribute('width', (line.width + horizontalPadding * 2).toFixed(1));
      rect.setAttribute('height', height.toFixed(1));
      rect.setAttribute('rx', Math.min(5, height * 0.22).toFixed(1));
      ui.brushClipPath.appendChild(rect);
    }
    ui.lensGlass.style.clipPath = `url(#${ui.brushClipId})`;
    ui.host.dataset.translensBrushLineCount = String(lines.length);
    ui.host.dataset.translensSelectionMode = candidate.selectionMode || 'precise';
  }

  function mergeLineRects(rects) {
    const sorted = rects
      .filter((rect) => rect.width > 1 && rect.height > 1)
      .map((rect) => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      }))
      .sort((left, right) => left.top - right.top || left.left - right.left);
    const lines = [];
    for (const rect of sorted) {
      const existing = lines.find((line) => {
        const overlap = Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top);
        return overlap > Math.min(line.height, rect.height) * 0.5;
      });
      if (!existing) {
        lines.push({ ...rect });
        continue;
      }
      existing.left = Math.min(existing.left, rect.left);
      existing.top = Math.min(existing.top, rect.top);
      existing.right = Math.max(existing.right, rect.right);
      existing.bottom = Math.max(existing.bottom, rect.bottom);
      existing.width = existing.right - existing.left;
      existing.height = existing.bottom - existing.top;
    }
    return lines.sort((left, right) => left.top - right.top || left.left - right.left);
  }

  function positionLens(point) {
    if (!point || ui.lens.hidden) return;
    const now = performance.now();
    if (state.inkTarget) {
      const elapsed = Math.max(8, now - state.inkTarget.time);
      const distance = Math.hypot(
        point.x - state.inkTarget.x,
        point.y - state.inkTarget.y
      );
      const movementEnergy = Math.min(1, distance / elapsed / 1.15);
      state.inkEnergy = Math.max(state.inkEnergy, movementEnergy);
    }
    state.inkTarget = { x: point.x, y: point.y, time: now };
    state.inkCurrent ||= { x: point.x, y: point.y };
    ui.inkCursor.style.left = `${point.x}px`;
    ui.inkCursor.style.top = `${point.y}px`;
    if (!state.inkFrame) state.inkFrame = requestAnimationFrame(animateInk);
  }

  function animateInk(timestamp) {
    state.inkFrame = 0;
    if (state.overlayMode !== 'lens' || ui.lens.hidden || !state.inkTarget) return;

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const previousTime = state.inkLastFrameTime || timestamp;
    const elapsed = Math.max(0, Math.min(50, timestamp - previousTime));
    state.inkLastFrameTime = timestamp;
    state.inkEnergy *= Math.exp(-elapsed / 520);

    const follow = reducedMotion ? 1 : 1 - Math.exp(-elapsed / 42);
    state.inkCurrent.x += (state.inkTarget.x - state.inkCurrent.x) * follow;
    state.inkCurrent.y += (state.inkTarget.y - state.inkCurrent.y) * follow;
    state.inkPhase += elapsed * (0.00042 + state.inkEnergy * 0.00125);

    const size = Math.max(40, Math.min(300, Number(state.settings.inkSize) || 120));
    if (!state.inkLastPaintTime || timestamp - state.inkLastPaintTime >= 30 || reducedMotion) {
      ui.lensGlass.style.clipPath = makeRevealShape(
        state.inkCurrent.x,
        state.inkCurrent.y,
        size,
        state.inkPhase,
        reducedMotion ? 0 : state.inkEnergy
      );
      state.inkLastPaintTime = timestamp;
      state.inkPaintCount += 1;
      ui.host.dataset.translensInkPhase = state.inkPhase.toFixed(3);
      ui.host.dataset.translensInkEnergy = state.inkEnergy.toFixed(3);
      ui.host.dataset.translensInkPaints = String(state.inkPaintCount);
    }

    const settled = Math.hypot(
      state.inkTarget.x - state.inkCurrent.x,
      state.inkTarget.y - state.inkCurrent.y
    ) < 0.35
      && state.inkEnergy < 0.004
      && timestamp - state.inkTarget.time > 900;
    if (!reducedMotion && !settled) state.inkFrame = requestAnimationFrame(animateInk);
  }

  function stableInkPhase(value) {
    let hash = 2166136261;
    for (const character of String(value || 'translens')) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash % 6283) / 1000 || 0.731;
  }

  function makeRevealShape(centerX, centerY, size, phase, movementEnergy = 0) {
    const radius = size / 2;
    const points = [];
    const pointCount = 56;
    const energy = Math.max(0, Math.min(1, movementEnergy));
    const breath = Math.sin(phase * 1.08) * (0.012 + energy * 0.006);
    for (let index = 0; index < pointCount; index += 1) {
      const angle = index / pointCount * Math.PI * 2;
      const ripple = Math.sin(angle * 3 + phase * 0.78) * 0.086
        + Math.sin(angle * 5 - phase * 0.46) * 0.041
        + Math.cos(angle * 9 + phase * 0.19) * 0.021
        + Math.sin(angle * 17 - phase * 0.11) * 0.009
        + Math.sin(angle * 2 - phase * 1.35) * energy * 0.024;
      const localRadius = radius * (1 + breath + ripple);
      points.push(
        `${(centerX + Math.cos(angle) * localRadius).toFixed(1)}px `
        + `${(centerY + Math.sin(angle) * localRadius).toFixed(1)}px`
      );
    }
    return `polygon(${points.join(',')})`;
  }

  function buildInkTheme(element) {
    const background = parseRgb(findBackground(element, 1)) || { red: 255, green: 255, blue: 255 };
    const foreground = parseRgb(getComputedStyle(element).color) || { red: 20, green: 29, blue: 47 };
    const backgroundHsl = rgbToHsl(background);
    const foregroundHsl = rgbToHsl(foreground);
    const source = backgroundHsl.saturation > 0.08
      ? backgroundHsl
      : foregroundHsl.saturation > 0.08
        ? foregroundHsl
        : { hue: 205, saturation: 0.38, lightness: 0.5 };
    const darkPage = colorLuminance(background) < 0.46;
    const saturation = Math.max(0.28, Math.min(0.56, source.saturation));
    const hue = source.hue;

    return {
      wash: `hsla(${hue}, ${Math.round(saturation * 100)}%, ${darkPage ? 72 : 38}%, .025)`,
      edge: `hsla(${hue}, ${Math.round(saturation * 100)}%, ${darkPage ? 74 : 34}%, .42)`,
      cursor: `hsla(${hue}, ${Math.round(saturation * 100)}%, ${darkPage ? 72 : 34}%, .42)`,
      brushWash: `hsla(${hue}, ${Math.round(saturation * 100)}%, ${darkPage ? 74 : 32}%, ${darkPage ? .17 : .11})`,
      brushEdge: `hsla(${hue}, ${Math.round(saturation * 100)}%, ${darkPage ? 78 : 28}%, .68)`
    };
  }

  function parseRgb(value) {
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const [red, green, blue] = match[1].split(',').map((part) => Number.parseFloat(part));
    if (![red, green, blue].every(Number.isFinite)) return null;
    return { red, green, blue };
  }

  function rgbToHsl({ red, green, blue }) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * (((b - r) / delta) + 2);
      else hue = 60 * (((r - g) / delta) + 4);
    }
    if (hue < 0) hue += 360;
    const lightness = (max + min) / 2;
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
    return { hue: Math.round(hue), saturation, lightness };
  }

  function colorLuminance({ red, green, blue }) {
    return (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
  }

  function showInlineReplacement(candidate, translation) {
    hideVisuals();
    state.overlayMode = 'inline';
    const bounds = unionRects(candidate.rects);
    const computed = getComputedStyle(candidate.container);
    const background = findBackground(candidate.container, 0.99);

    for (const rect of candidate.rects) {
      const cover = document.createElement('span');
      cover.className = 'cover';
      Object.assign(cover.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        background
      });
      ui.layers.appendChild(cover);
    }

    Object.assign(ui.translation.style, {
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${Math.min(Math.max(bounds.width, 120), innerWidth - bounds.left - 8)}px`,
      minHeight: `${bounds.height}px`,
      color: computed.color,
      background,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      lineHeight: computed.lineHeight === 'normal' ? '1.45' : computed.lineHeight,
      textAlign: computed.textAlign
    });
    ui.translation.textContent = translation;
    ui.translation.hidden = false;
  }

  function showLoading(rects, requestId) {
    if (!rects.length || requestId !== state.requestId) return;
    const point = state.lastPoint || {
      x: rects[rects.length - 1].right,
      y: rects[rects.length - 1].bottom
    };
    ui.status.className = 'status loading';
    ui.status.textContent = '';
    ui.status.title = '正在翻译';
    state.statusRequestId = requestId;
    placeStatus(point.x + 12, point.y + 12);
  }

  function showPreparing(progress, requestId) {
    if (requestId !== state.requestId) return;
    ui.status.className = 'status preparing';
    ui.status.textContent = Number.isFinite(progress) ? `准备本地模型 ${progress}%` : '准备本地模型…';
    state.statusRequestId = requestId;
    placeStatus(state.lastPoint?.x || 16, state.lastPoint?.y || 16);
  }

  function showError(rects, message, requestId) {
    const rect = rects[rects.length - 1];
    ui.status.className = 'status error';
    ui.status.textContent = message;
    ui.status.title = message;
    state.statusRequestId = requestId;
    placeStatus(rect.right - 4, rect.bottom - 4);
  }

  function hideStatusForRequest(requestId) {
    if (state.statusRequestId !== requestId) return;
    ui.status.hidden = true;
    state.statusRequestId = 0;
  }

  function placeStatus(x, y) {
    ui.status.style.left = `${x}px`;
    ui.status.style.top = `${y}px`;
    ui.status.hidden = false;
  }

  function friendlyError(error) {
    if (error?.message === 'TRANSLATOR_API_UNSUPPORTED') {
      return '当前 Chrome 不支持本地翻译，请升级浏览器或切换为演示翻译。';
    }
    if (error?.message === 'MODEL_NOT_READY') {
      return '本地翻译尚未准备好，请在译镜设置中准备语言模型。';
    }
    if (error?.message === 'LANGUAGE_PAIR_UNAVAILABLE') return '当前源语言与目标语言的本地翻译不可用。';
    if (error?.message === 'LANGUAGE_DETECTION_FAILED') {
      return '暂时无法识别当前文字的语言，请在设置中手动指定源语言。';
    }
    if (error?.message === 'MODEL_CHECK_FAILED') return '暂时无法检查本地翻译状态。';
    if (error?.message === 'DEMO_TRANSLATION_UNAVAILABLE') {
      return '演示翻译仅支持测试内容，请在设置中准备本地翻译。';
    }
    return '翻译暂时失败。';
  }

  function configuredSourceLanguage() {
    const sourceLanguage = state.settings.sourceLanguage;
    return sourceLanguage && sourceLanguage !== 'auto' ? sourceLanguage : 'en';
  }

  function unionRects(rects) {
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function findBackground(element, alpha) {
    let current = element;
    while (current) {
      const value = getComputedStyle(current).backgroundColor;
      const match = value?.match(/^rgba?\(([^)]+)\)$/);
      if (match && value !== 'transparent') {
        const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
        if (parts.length === 3 || parts[3] > 0.05) {
          return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
        }
      }
      if (current === document.documentElement) break;
      current = current.parentElement;
    }
    return matchMedia('(prefers-color-scheme: dark)').matches
      ? `rgba(32, 33, 36, ${alpha})`
      : `rgba(255, 255, 255, ${alpha})`;
  }

  function createOverlay() {
    const host = document.createElement('div');
    host.dataset.translensRoot = '';
    host.dataset.translensRuntime = 'dynamic';
    const shadow = host.attachShadow({ mode: 'closed' });
    const brushClipId = `translens-brush-clip-${Math.random().toString(36).slice(2)}`;
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      .layers { position: fixed; inset: 0; pointer-events: none; }
      .cover { position: fixed; box-sizing: border-box; border-radius: 2px; }
      .translation {
        position: fixed; box-sizing: border-box; padding: 1px 3px;
        border: 0; border-radius: 2px; box-shadow: none;
        white-space: normal; overflow-wrap: anywhere; pointer-events: none;
      }
      .lens {
        position: fixed; inset: 0; box-sizing: border-box;
        pointer-events: none;
      }
      .lens-glass {
        position: fixed; inset: 0; overflow: hidden;
        pointer-events: none; will-change: clip-path;
        clip-path: circle(0 at 0 0);
      }
      .ink-wash {
        position: fixed; inset: 0;
        background: var(--ink-wash, rgba(38,80,98,.025));
        pointer-events: none;
      }
      .ink-covers {
        position: fixed; inset: 0; pointer-events: none;
      }
      .ink-texts {
        position: fixed; inset: 0; pointer-events: none;
      }
      .ink-cover {
        position: fixed; box-sizing: border-box;
        border: 0; border-radius: 0; box-shadow: none;
        outline: 0; pointer-events: none;
      }
      .brush-line-cover { border-radius: 2px; }
      .lens-text {
        position: fixed; z-index: 1; box-sizing: border-box;
        max-height: none; padding: 0; border: 0; box-shadow: none;
        outline: 0; overflow: hidden; color: inherit; text-align: center;
        background: transparent;
        white-space: normal; overflow-wrap: break-word; word-break: normal;
        pointer-events: none;
      }
      .ink-cursor {
        position: fixed; z-index: 3; width: 5px; height: 5px;
        margin: -2.5px 0 0 -2.5px; box-sizing: border-box;
        border: 0; border-radius: 42% 58% 61% 39% / 56% 44% 59% 41%;
        background: var(--ink-cursor, rgba(29,78,98,.5));
        pointer-events: none;
      }
      .status {
        position: fixed; transform: translate(-50%, -50%); box-sizing: border-box;
        font: 600 11px/18px system-ui, sans-serif; color: white; text-align: center;
        background: #4263eb; border-radius: 999px; box-shadow: 0 1px 5px rgba(0,0,0,.2);
      }
      .loading { width: 9px; height: 9px; padding: 0; animation: pulse .8s ease-in-out infinite alternate; }
      .preparing { padding: 3px 8px; transform: translate(8px, 8px); white-space: nowrap; }
      .error {
        max-width: min(320px, calc(100vw - 24px)); padding: 4px 9px;
        color: white; text-align: left; white-space: normal; background: #b42318;
      }
      .badge {
        position: fixed; right: 12px; bottom: 12px; padding: 4px 8px;
        border-radius: 999px; color: white; background: rgba(15,23,42,.82);
        font: 500 11px/16px system-ui, sans-serif; opacity: 0;
        transition: opacity .15s ease;
      }
      .badge.visible { opacity: 1; }
      @keyframes pulse { from { opacity: .35; transform: scale(.7); } to { opacity: 1; transform: scale(1); } }
    `;
    const layers = document.createElement('div');
    layers.className = 'layers';
    const translation = document.createElement('div');
    translation.className = 'translation';
    translation.hidden = true;
    const lens = document.createElement('div');
    lens.className = 'lens';
    lens.hidden = true;
    const lensGlass = document.createElement('div');
    lensGlass.className = 'lens-glass';
    const inkWash = document.createElement('div');
    inkWash.className = 'ink-wash';
    const inkCovers = document.createElement('div');
    inkCovers.className = 'ink-covers';
    const lensTexts = document.createElement('div');
    lensTexts.className = 'ink-texts';
    lensGlass.append(inkWash, inkCovers, lensTexts);
    lens.append(lensGlass);
    const inkCursor = document.createElement('div');
    inkCursor.className = 'ink-cursor';
    inkCursor.hidden = true;
    const status = document.createElement('div');
    status.className = 'status';
    status.hidden = true;
    const badge = document.createElement('div');
    badge.className = 'badge';
    const clipSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    clipSvg.setAttribute('width', '0');
    clipSvg.setAttribute('height', '0');
    clipSvg.setAttribute('aria-hidden', 'true');
    const clipDefs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const brushClipPath = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    brushClipPath.id = brushClipId;
    brushClipPath.setAttribute('clipPathUnits', 'userSpaceOnUse');
    clipDefs.appendChild(brushClipPath);
    clipSvg.appendChild(clipDefs);
    shadow.append(style, clipSvg, layers, translation, lens, inkCursor, status, badge);
    (document.documentElement || document.body).appendChild(host);
    return {
      host,
      layers,
      translation,
      lens,
      lensGlass,
      inkWash,
      inkCovers,
      lensTexts,
      inkCursor,
      status,
      badge,
      brushClipId,
      brushClipPath
    };
  }

  function updateBadge() {
    const label = !isActiveForPage()
      ? '译镜已关闭'
      : '';
    flashBadge(label);
  }

  function showHoverToggleBadge() {
    flashBadge(state.hoverEnabled ? '悬停墨迹已开启' : '悬停墨迹已关闭');
  }

  function modifierKeyLabel() {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    return /mac/i.test(platform) ? '⌥ Option' : 'Alt';
  }

  function flashBadge(label) {
    ui.badge.textContent = label;
    ui.badge.classList.toggle('visible', Boolean(label));
    if (label) window.setTimeout(() => ui.badge.classList.remove('visible'), 1400);
  }

  function clearNativeSelection() {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  }

  function resetInteraction() {
    const keepPinnedSelection = state.selectionPinned;
    if (state.altDown) state.hoverEnabled = state.optionPreviousHoverEnabled;
    state.altDown = false;
    resetOptionPress();
    state.selectionDraft = null;
    if (!keepPinnedSelection) hideOverlay();
  }

  function clearTimers() {
    window.clearTimeout(state.hoverTimer);
    window.clearTimeout(state.leaveTimer);
    window.clearTimeout(state.loadingTimer);
    state.leaveTimer = 0;
  }

  function hideVisuals() {
    window.cancelAnimationFrame(state.inkFrame);
    state.inkFrame = 0;
    state.inkTarget = null;
    state.inkCurrent = null;
    state.inkPhase = 0;
    state.inkLastFrameTime = 0;
    state.inkLastPaintTime = 0;
    state.inkEnergy = 0;
    state.inkPaintCount = 0;
    state.brushPoints = [];
    ui.brushClipPath.replaceChildren();
    ui.layers.replaceChildren();
    ui.inkCovers.replaceChildren();
    ui.lensTexts.replaceChildren();
    ui.translation.hidden = true;
    ui.lens.hidden = true;
    ui.inkCursor.hidden = true;
    ui.status.hidden = true;
    state.statusRequestId = 0;
    state.overlayMode = '';
    ui.host.dataset.translensOverlayMode = '';
    delete ui.host.dataset.translensHoverUnit;
    delete ui.host.dataset.translensSourceLanguage;
    delete ui.host.dataset.translensTargetLanguage;
    delete ui.host.dataset.translensPhraseWordLimit;
    delete ui.host.dataset.translensCoverStrategy;
    delete ui.host.dataset.translensBrushCoverCount;
    delete ui.host.dataset.translensBrushLineCount;
    delete ui.host.dataset.translensSelectionMode;
    delete ui.host.dataset.translensInkPhase;
    delete ui.host.dataset.translensInkEnergy;
    delete ui.host.dataset.translensInkPaints;
  }

  function hideOverlay() {
    state.requestId += 1;
    state.candidateKey = '';
    state.candidate = null;
    state.lensCandidates = [];
    state.candidatePoint = null;
    state.selectionPinned = false;
    clearTimers();
    hideVisuals();
  }
})();
