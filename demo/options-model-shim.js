(function installOptionsModelShim() {
  if (globalThis.chrome?.storage?.local) return;

  const values = {
    translationUnit: 'phrase',
    hoverDelay: 220,
    inkSize: 120,
    inkStyleVersion: 3,
    hoverUnitStyleVersion: 2,
    brushSize: 24,
    engine: 'mock',
    localModelStatus: 'downloadable',
    localModelProgress: 0,
    sourceLanguage: 'auto',
    targetLanguage: 'zh',
    languageSettingsVersion: 1
  };

  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) {
          return { ...(defaults || {}), ...values };
        },
        async set(next) {
          Object.assign(values, next);
        }
      }
    }
  };

  globalThis.Translator = {
    async availability() {
      return values.localModelStatus === 'ready' ? 'available' : 'downloadable';
    },
    async create(options) {
      let progressListener = () => {};
      options.monitor({
        addEventListener(_type, listener) {
          progressListener = listener;
        }
      });
      for (const loaded of [0.12, 0.38, 0.67, 0.88, 1]) {
        await new Promise((resolve) => setTimeout(resolve, 90));
        progressListener({ loaded });
      }
      values.localModelStatus = 'ready';
      return {
        destroy() {}
      };
    }
  };
})();
