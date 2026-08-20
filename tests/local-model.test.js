const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUS,
  detectLanguage,
  inspect,
  normalizeAvailability,
  prepare
} = require('../src/local-model.js');

test('normalizes current and legacy Translator availability values', () => {
  assert.equal(normalizeAvailability('available'), STATUS.READY);
  assert.equal(normalizeAvailability('downloadable'), STATUS.DOWNLOADABLE);
  assert.equal(normalizeAvailability('unavailable'), STATUS.UNAVAILABLE);
  assert.equal(normalizeAvailability('readily'), STATUS.READY);
  assert.equal(normalizeAvailability('after-download'), STATUS.DOWNLOADABLE);
});

test('reports unsupported when the Translator API is missing', async () => {
  assert.deepEqual(await inspect({ translatorApi: null }), {
    status: STATUS.UNSUPPORTED,
    availability: 'unsupported'
  });
});

test('prepares a downloadable model and reports progress', async () => {
  const progress = [];
  let destroyed = false;
  const translatorApi = {
    async availability() {
      return 'downloadable';
    },
    async create(options) {
      options.monitor({
        addEventListener(type, listener) {
          assert.equal(type, 'downloadprogress');
          listener({ loaded: 0.42 });
        }
      });
      return {
        destroy() {
          destroyed = true;
        }
      };
    }
  };

  const result = await prepare({
    translatorApi,
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    onProgress(value) {
      progress.push(value);
    }
  });

  assert.deepEqual(result, { status: STATUS.READY });
  assert.deepEqual(progress, [42, 100]);
  assert.equal(destroyed, true);
});

test('returns the highest-confidence detected language', async () => {
  const result = await detectLanguage('Hallo und herzlich willkommen!', {
    detectorApi: {
      async create() {
        return {
          async detect() {
            return [
              { detectedLanguage: 'de', confidence: 0.98 },
              { detectedLanguage: 'en', confidence: 0.01 }
            ];
          }
        };
      }
    }
  });
  assert.deepEqual(result, { language: 'de', confidence: 0.98 });
});
