const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  brushSegmentPolygon,
  calculateTextFitScale,
  findPhrase,
  findSentence,
  isMeaningfulHoverWord,
  isSiteEnabled,
  looksTranslatable,
  mergeSettings,
  normalizeText,
  isIntentionalDrag,
  isOptionTap,
  resolveHoverDelay,
  splitTranslationChunks
} = require('../src/core.js');

test('normalizes repeated whitespace without changing words', () => {
  assert.equal(normalizeText('  The \n company\tplans.  '), 'The company plans.');
});

test('finds the sentence containing the pointer offset', () => {
  const text = 'First sentence. The company plans to release the product later this year. Last one!';
  const offset = text.indexOf('release');
  assert.deepEqual(findSentence(text, offset, 'en'), {
    start: 16,
    end: 73,
    text: 'The company plans to release the product later this year.'
  });
});

test('handles Chinese and English punctuation', () => {
  const text = 'Hello world! 第二句话。Final sentence?';
  assert.equal(findSentence(text, text.indexOf('第二'), 'zh').text, '第二句话。');
  assert.equal(findSentence(text, text.indexOf('Final'), 'en').text, 'Final sentence?');
});

test('keeps content-word hover targets at single-word scope', () => {
  const text = 'One year ago, most Claude usage took the form of a conversation between a user and an assistant.';
  assert.equal(findPhrase(text, text.indexOf('Claude')).text, 'Claude');
  assert.equal(findPhrase(text, text.indexOf('took')).text, 'took');
  assert.equal(findPhrase(text, text.indexOf('conversation')).text, 'conversation');
  assert.equal(findPhrase(text, text.indexOf('assistant')).text, 'assistant');
});

test('adds only minimal grammatical context for function words', () => {
  assert.equal(findPhrase('A concise English sentence.', 5).text, 'concise');
  const text = 'We moved quickly, but the process required careful review.';
  assert.equal(findPhrase(text, text.indexOf('careful')).text, 'careful');
  assert.equal(findPhrase(text, text.indexOf('but')).text, 'but the process');
  assert.ok(findPhrase(text, text.indexOf('but')).text.split(/\s+/).length <= 4);
});

test('keeps conjunction context bounded to four words', () => {
  const text = 'Share more granular data, breaking out results for chat and Cowork conversations at a monthly level.';
  const expected = 'chat and Cowork conversations';
  assert.equal(findPhrase(text, text.indexOf('and'), 'en').text, expected);
  assert.equal(findPhrase(text, text.indexOf('chat'), 'en', 3).text, 'chat');
  assert.equal(findPhrase(text, text.indexOf('Cowork'), 'en', 3).text, 'Cowork');
});

test('identifies meaningful single-word hover targets', () => {
  assert.equal(isMeaningfulHoverWord('assistant'), true);
  assert.equal(isMeaningfulHoverWord('Claude'), true);
  assert.equal(isMeaningfulHoverWord('the'), false);
  assert.equal(isMeaningfulHoverWord('a'), false);
});

test('splits a long paragraph into bounded translation chunks without losing text', () => {
  const text = 'First sentence has useful context. Second sentence is also important. Third sentence finishes the paragraph.';
  const chunks = splitTranslationChunks(text, 52, 'en');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 52));
  assert.equal(chunks.join(' '), text);
});

test('recognizes only a standalone short Option press as a toggle', () => {
  assert.equal(isOptionTap(160), true);
  assert.equal(isOptionTap(260), false);
  assert.equal(isOptionTap(120, true, false), false);
  assert.equal(isOptionTap(120, false, true), false);
});

test('honors a zero hover delay and falls back only for invalid values', () => {
  assert.equal(resolveHoverDelay(0), 0);
  assert.equal(resolveHoverDelay('80'), 80);
  assert.equal(resolveHoverDelay(-1), 300);
  assert.equal(resolveHoverDelay('invalid'), 300);
});

test('distinguishes a light Option gesture from an intentional drag', () => {
  assert.equal(isIntentionalDrag(6), false);
  assert.equal(isIntentionalDrag(13.9), false);
  assert.equal(isIntentionalDrag(14), true);
  assert.equal(isIntentionalDrag(31), true);
});

test('builds valid brush geometry in any drawing direction', () => {
  const paths = [
    brushSegmentPolygon({ x: 10, y: 10, width: 20 }, { x: 40, y: 10, width: 24 }),
    brushSegmentPolygon({ x: 40, y: 10, width: 24 }, { x: 10, y: 10, width: 20 }),
    brushSegmentPolygon({ x: 20, y: 8, width: 18 }, { x: 20, y: 42, width: 26 })
  ];
  assert.ok(paths.every((points) => points.length === 4));
  assert.ok(paths.flat().every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
  assert.deepEqual(brushSegmentPolygon({ x: 4, y: 4 }, { x: 4, y: 4 }), []);
});

test('calculates a bounded scale for translated text overflow', () => {
  assert.equal(calculateTextFitScale(100, 100), 1);
  assert.ok(calculateTextFitScale(130, 100) < 0.8);
  assert.equal(calculateTextFitScale(300, 100), 0.70);
});

test('filters URLs, numbers, short text and accepts prose', () => {
  assert.equal(looksTranslatable('https://example.com/article'), false);
  assert.equal(looksTranslatable('123,456.00'), false);
  assert.equal(looksTranslatable('Hi', 6), false);
  assert.equal(looksTranslatable('A useful English sentence.'), true);
});

test('merges nested site rules with defaults', () => {
  const settings = mergeSettings({
    triggerMode: 'hover',
    siteRules: { 'example.com': 'disabled' }
  });
  assert.equal(settings.triggerMode, 'hover');
  assert.equal(settings.engine, DEFAULT_SETTINGS.engine);
  assert.equal(settings.displayMode, 'lens');
  assert.equal(settings.inkSize, 120);
  assert.equal(settings.brushSize, 24);
  assert.equal(settings.siteRules['example.com'], 'disabled');
});

test('respects the global switch and website disable rule', () => {
  const settings = mergeSettings({ siteRules: { 'private.example': 'disabled' } });
  assert.equal(isSiteEnabled(settings, 'example.com'), true);
  assert.equal(isSiteEnabled(settings, 'private.example'), false);
  assert.equal(isSiteEnabled({ ...settings, globalEnabled: false }, 'example.com'), false);
});
