(function initTransLensCore(root, factory) {
  const api = factory();
  root.TransLensCore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createCore() {
  const BLOCK_SELECTOR = [
    'p',
    'li',
    'blockquote',
    'td',
    'th',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'figcaption',
    'article',
    'section',
    'main',
    'button',
    'a',
    'label',
    'div'
  ].join(',');

  const SKIPPED_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'OPTION',
    'CODE',
    'PRE',
    'SVG',
    'CANVAS'
  ]);

  const HOVER_CONTEXT_WORDS = new Set([
    'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'from', 'with',
    'into', 'onto', 'over', 'under', 'between', 'through', 'by', 'as',
    'and', 'or', 'but', 'nor', 'than', 'that', 'this', 'these', 'those',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
    'not', 'no', 'it', 'its', 'i', 'we', 'you', 'they', 'he', 'she'
  ]);
  const HOVER_ARTICLES = new Set(['a', 'an', 'the']);
  const HOVER_CONJUNCTIONS = new Set(['and', 'or', 'but', 'nor']);
  const HOVER_PREPOSITIONS = new Set([
    'to', 'of', 'in', 'on', 'at', 'for', 'from', 'with', 'into', 'onto',
    'over', 'under', 'between', 'through', 'by', 'as', 'than'
  ]);

  const DEFAULT_SETTINGS = Object.freeze({
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
    siteRules: {}
  });

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isOptionTap(durationMs, chordUsed = false, pointerUsed = false, threshold = 220) {
    return Number(durationMs) >= 0
      && Number(durationMs) <= threshold
      && !chordUsed
      && !pointerUsed;
  }

  function resolveHoverDelay(value, fallback = 300) {
    const delay = Number(value);
    return Number.isFinite(delay) && delay >= 0 ? delay : fallback;
  }

  function isIntentionalDrag(distancePx, threshold = 14) {
    const distance = Number(distancePx);
    const limit = Number(threshold);
    return Number.isFinite(distance)
      && Number.isFinite(limit)
      && distance >= Math.max(0, limit);
  }

  function calculateTextFitScale(contentExtent, availableExtent, currentScale = 1, minScale = 0.70) {
    const content = Number(contentExtent);
    const available = Number(availableExtent);
    const scale = Number(currentScale);
    if (![content, available, scale].every(Number.isFinite) || content <= 0 || available <= 0) {
      return 1;
    }
    if (content <= available + 1) return Math.min(1, scale);
    return Math.max(minScale, Math.min(scale - 0.02, scale * available / content * 0.985));
  }

  function brushSegmentPolygon(before, point) {
    const startX = Number(before?.x);
    const startY = Number(before?.y);
    const endX = Number(point?.x);
    const endY = Number(point?.y);
    const beforeWidth = Math.max(2, Number(before?.width) || 2);
    const pointWidth = Math.max(2, Number(point?.width) || 2);
    if (![startX, startY, endX, endY].every(Number.isFinite)) return [];
    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.hypot(dx, dy);
    if (!length) return [];
    const normalX = -dy / length;
    const normalY = dx / length;
    const beforeRadius = beforeWidth / 2;
    const pointRadius = pointWidth / 2;
    return [
      { x: startX + normalX * beforeRadius, y: startY + normalY * beforeRadius },
      { x: endX + normalX * pointRadius, y: endY + normalY * pointRadius },
      { x: endX - normalX * pointRadius, y: endY - normalY * pointRadius },
      { x: startX - normalX * beforeRadius, y: startY - normalY * beforeRadius }
    ];
  }

  function findSentence(text, offset, locale = 'en') {
    if (!text || offset < 0 || offset > text.length) return null;

    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
      for (const part of segmenter.segment(text)) {
        const end = part.index + part.segment.length;
        const containsOffset = offset >= part.index
          && (offset < end || (end === text.length && offset === end));
        if (containsOffset) {
          return trimSegment(text, part.index, end);
        }
      }
    }

    let start = offset;
    let end = offset;
    const boundary = /[.!?。！？\n]/;
    while (start > 0 && !boundary.test(text[start - 1])) start -= 1;
    while (end < text.length && !boundary.test(text[end])) end += 1;
    if (end < text.length) end += 1;
    return trimSegment(text, start, end);
  }

  function findPhrase(text, offset, locale = 'en', maxWords = 4) {
    if (!text || offset < 0 || offset > text.length) return null;
    const sentence = findSentence(text, offset, locale);
    if (!sentence) return null;

    const clauses = [];
    let clauseStart = sentence.start;
    for (let index = sentence.start; index < sentence.end; index += 1) {
      if (!/[,;:—–\n]/.test(text[index])) continue;
      const clause = trimSegment(text, clauseStart, index);
      if (clause) clauses.push(clause);
      clauseStart = index + 1;
    }
    const finalClause = trimSegment(text, clauseStart, sentence.end);
    if (finalClause) clauses.push(finalClause);

    const distanceToClause = (clause) => (
      offset < clause.start ? clause.start - offset : offset > clause.end ? offset - clause.end : 0
    );
    let clause = clauses.reduce((nearest, candidate) => (
      !nearest || distanceToClause(candidate) < distanceToClause(nearest) ? candidate : nearest
    ), null) || sentence;
    let words = segmentWords(text, clause.start, clause.end, locale);
    if (words.length < 2 && clause !== sentence) {
      clause = sentence;
      words = segmentWords(text, sentence.start, sentence.end, locale);
    }
    if (!words.length) return clause;

    const limit = Math.max(2, Math.min(4, Number(maxWords) || 4));
    const targetIndex = words.reduce((nearestIndex, word, index) => {
      const distance = offset < word.start
        ? word.start - offset
        : offset > word.end
          ? offset - word.end
          : 0;
      const nearest = words[nearestIndex];
      const nearestDistance = offset < nearest.start
        ? nearest.start - offset
        : offset > nearest.end
          ? offset - nearest.end
          : 0;
      return distance < nearestDistance ? index : nearestIndex;
    }, 0);
    const target = words[targetIndex];
    const normalizedTarget = target.text.toLocaleLowerCase(locale);
    const previous = words[targetIndex - 1];
    const next = words[targetIndex + 1];
    const normalizedPrevious = previous?.text.toLocaleLowerCase(locale);
    let startIndex = targetIndex;
    let endIndex = targetIndex;

    // 内容词默认保持单词级命中，避免把相邻几个内容词错误拼成“假短语”。
    // 只对明显承担语法连接作用的词，或紧邻冠词的名词，补充最小必要上下文。
    if (HOVER_CONJUNCTIONS.has(normalizedTarget)) {
      startIndex = Math.max(0, targetIndex - 1);
      endIndex = Math.min(words.length - 1, targetIndex + 2);
    } else if (HOVER_ARTICLES.has(normalizedTarget)) {
      endIndex = Math.min(words.length - 1, targetIndex + 1);
    } else if (HOVER_PREPOSITIONS.has(normalizedTarget)) {
      endIndex = Math.min(words.length - 1, targetIndex + 1);
      if (HOVER_ARTICLES.has(words[targetIndex + 1]?.text.toLocaleLowerCase(locale))) {
        endIndex = Math.min(words.length - 1, targetIndex + 2);
      }
    } else if (HOVER_CONTEXT_WORDS.has(normalizedTarget) && next) {
      endIndex = Math.min(words.length - 1, targetIndex + 1);
    }

    if (endIndex - startIndex + 1 > limit) {
      endIndex = Math.min(words.length - 1, startIndex + limit - 1);
    }
    const selected = words.slice(startIndex, endIndex + 1);
    return trimSegment(text, selected[0].start, selected[selected.length - 1].end);
  }

  function isMeaningfulHoverWord(text) {
    const word = normalizeText(text).toLocaleLowerCase('en');
    if (!/^[\p{L}\p{N}][\p{L}\p{N}'’_-]*$/u.test(word)) return false;
    return word.length >= 2 && !HOVER_CONTEXT_WORDS.has(word);
  }

  function segmentWords(text, start, end, locale) {
    const value = text.slice(start, end);
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
      return [...segmenter.segment(value)]
        .filter((part) => part.isWordLike)
        .map((part) => ({
          start: start + part.index,
          end: start + part.index + part.segment.length,
          text: part.segment
        }));
    }
    const words = [];
    const pattern = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g;
    let match;
    while ((match = pattern.exec(value))) {
      words.push({
        start: start + match.index,
        end: start + match.index + match[0].length,
        text: match[0]
      });
    }
    return words;
  }

  function splitTranslationChunks(value, maxLength = 500, locale = 'en') {
    const text = normalizeText(value);
    const limit = Math.max(40, Number(maxLength) || 500);
    if (!text) return [];
    if (text.length <= limit) return [text];

    let sentences = [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
      sentences = [...segmenter.segment(text)].map((part) => normalizeText(part.segment));
    } else {
      sentences = (text.match(/[^.!?。！？]+[.!?。！？]?/g) || [text]).map(normalizeText);
    }

    const pieces = [];
    for (const sentence of sentences.filter(Boolean)) {
      let remainder = sentence;
      while (remainder.length > limit) {
        let cut = remainder.lastIndexOf(' ', limit);
        if (cut < Math.floor(limit * 0.55)) cut = limit;
        pieces.push(remainder.slice(0, cut).trim());
        remainder = remainder.slice(cut).trim();
      }
      if (remainder) pieces.push(remainder);
    }

    const chunks = [];
    let current = '';
    for (const piece of pieces) {
      const combined = current ? `${current} ${piece}` : piece;
      if (current && combined.length > limit) {
        chunks.push(current);
        current = piece;
      } else {
        current = combined;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function trimSegment(text, start, end) {
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (start === end) return null;
    return { start, end, text: normalizeText(text.slice(start, end)) };
  }

  function mergeSettings(value) {
    const settings = value || {};
    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      siteRules: {
        ...DEFAULT_SETTINGS.siteRules,
        ...(settings.siteRules || {})
      }
    };
  }

  function isSiteEnabled(settings, hostname) {
    if (!settings.globalEnabled) return false;
    return settings.siteRules[hostname] !== 'disabled';
  }

  function isSkippableElement(element) {
    if (!element || element.nodeType !== 1) return true;
    if (SKIPPED_TAGS.has(element.tagName)) return true;
    if (element.closest('[data-translens-root]')) return true;
    if (element.closest('input, textarea, select, [contenteditable], [role="textbox"]')) {
      return true;
    }
    return false;
  }

  function looksTranslatable(text, minLength = 6, maxLength = 500) {
    const normalized = normalizeText(text);
    if (normalized.length < minLength || normalized.length > maxLength) return false;
    if (/^(?:https?:\/\/|www\.|\S+@\S+\.\S+)/i.test(normalized)) return false;
    if (/^[\d\s.,:%+\-–—/()]+$/.test(normalized)) return false;
    return /[A-Za-z]/.test(normalized);
  }

  return {
    BLOCK_SELECTOR,
    brushSegmentPolygon,
    calculateTextFitScale,
    DEFAULT_SETTINGS,
    SKIPPED_TAGS,
    findSentence,
    findPhrase,
    isMeaningfulHoverWord,
    isSiteEnabled,
    isSkippableElement,
    isIntentionalDrag,
    isOptionTap,
    looksTranslatable,
    mergeSettings,
    normalizeText,
    resolveHoverDelay,
    splitTranslationChunks
  };
});
