(function installDemoChromeShim() {
  const query = new URLSearchParams(location.search);
  const engine = query.get('engine') === 'local' ? 'local' : 'mock';
  const values = {
    globalEnabled: true,
    triggerMode: 'hover',
    translationUnit: 'phrase',
    displayMode: 'lens',
    inkSize: Number(query.get('ink')) || 120,
    inkStyleVersion: 3,
    hoverUnitStyleVersion: 2,
    engine,
    localModelStatus: engine === 'local' ? 'ready' : 'unknown',
    localModelProgress: engine === 'local' ? 100 : 0,
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    languageSettingsVersion: 1,
    hoverDelay: 220,
    minLength: 6,
    maxLength: 500,
    siteRules: {}
  };
  const changeListeners = [];
  const messageListeners = [];

  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) {
          return { ...(defaults || {}), ...values };
        },
        async set(next) {
          const changes = {};
          for (const [key, value] of Object.entries(next)) {
            changes[key] = { oldValue: values[key], newValue: value };
            values[key] = value;
          }
          for (const listener of changeListeners) listener(changes, 'local');
        }
      },
      onChanged: {
        addListener(listener) {
          changeListeners.push(listener);
        }
      }
    },
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener);
        }
      }
    }
  };

  globalThis.TransLensDemo = {
    set(next) {
      return globalThis.chrome.storage.local.set(next);
    },
    send(message) {
      let response;
      for (const listener of messageListeners) {
        listener(message, {}, (value) => { response = value; });
      }
      return response;
    }
  };
})();
