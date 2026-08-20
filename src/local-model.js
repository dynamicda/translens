(function initTransLensLocalModel(root, factory) {
  const api = factory();
  root.TransLensLocalModel = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createLocalModelApi() {
  const STATUS = Object.freeze({
    UNKNOWN: 'unknown',
    CHECKING: 'checking',
    UNSUPPORTED: 'unsupported',
    UNAVAILABLE: 'unavailable',
    DOWNLOADABLE: 'downloadable',
    DOWNLOADING: 'downloading',
    READY: 'ready',
    ERROR: 'error'
  });

  function normalizeAvailability(value) {
    if (value === 'available' || value === 'readily') return STATUS.READY;
    if (value === 'downloadable' || value === 'after-download') return STATUS.DOWNLOADABLE;
    if (value === 'unavailable' || value === 'no') return STATUS.UNAVAILABLE;
    return STATUS.ERROR;
  }

  async function inspect(options = {}) {
    const translatorApi = options.translatorApi ?? globalThis.Translator;
    if (!translatorApi?.availability || !translatorApi?.create) {
      return { status: STATUS.UNSUPPORTED, availability: 'unsupported' };
    }
    try {
      const availability = await translatorApi.availability({
        sourceLanguage: options.sourceLanguage || 'en',
        targetLanguage: options.targetLanguage || 'zh'
      });
      return {
        status: normalizeAvailability(availability),
        availability
      };
    } catch (error) {
      return { status: STATUS.ERROR, error };
    }
  }

  async function createTranslator(options = {}) {
    const translatorApi = options.translatorApi ?? globalThis.Translator;
    if (!translatorApi?.create) throw new Error('TRANSLATOR_API_UNSUPPORTED');
    const translator = await translatorApi.create({
      sourceLanguage: options.sourceLanguage || 'en',
      targetLanguage: options.targetLanguage || 'zh',
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          const progress = Math.max(0, Math.min(100, Math.round(Number(event.loaded) * 100)));
          options.onProgress?.(progress);
        });
      }
    });
    if (translator.ready && typeof translator.ready.then === 'function') {
      await translator.ready;
    }
    return translator;
  }

  async function createLanguageDetector(options = {}) {
    const detectorApi = options.detectorApi ?? globalThis.LanguageDetector;
    if (!detectorApi?.create) throw new Error('LANGUAGE_DETECTOR_UNSUPPORTED');
    const detector = await detectorApi.create({
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          const progress = Math.max(0, Math.min(100, Math.round(Number(event.loaded) * 100)));
          options.onProgress?.(progress);
        });
      }
    });
    if (detector.ready && typeof detector.ready.then === 'function') {
      await detector.ready;
    }
    return detector;
  }

  async function detectLanguage(text, options = {}) {
    const value = String(text || '').trim();
    if (!value) return null;
    const detector = options.detector || await createLanguageDetector(options);
    const results = await detector.detect(value);
    const best = Array.isArray(results) ? results[0] : null;
    if (!best?.detectedLanguage) return null;
    return {
      language: best.detectedLanguage,
      confidence: Number(best.confidence) || 0
    };
  }

  async function prepare(options = {}) {
    const availability = await inspect(options);
    if (availability.status === STATUS.UNSUPPORTED) {
      throw new Error('TRANSLATOR_API_UNSUPPORTED');
    }
    if (availability.status === STATUS.UNAVAILABLE) {
      throw new Error('LANGUAGE_PAIR_UNAVAILABLE');
    }
    if (availability.status === STATUS.ERROR) {
      throw availability.error || new Error('MODEL_CHECK_FAILED');
    }

    options.onStatus?.(
      availability.status === STATUS.READY ? STATUS.CHECKING : STATUS.DOWNLOADING
    );
    const translator = await createTranslator(options);
    translator.destroy?.();
    options.onProgress?.(100);
    options.onStatus?.(STATUS.READY);
    return { status: STATUS.READY };
  }

  return {
    STATUS,
    createLanguageDetector,
    createTranslator,
    detectLanguage,
    inspect,
    normalizeAvailability,
    prepare
  };
});
