import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calculatePrice,
  quotePrice as resolveQuote,
  publicPrice,
  modelPriceSummary as resolveSummary,
  higgsfieldPricing,
} from '../src/pricing/pricing-engine.js';
import { modelConfigs } from '../src/config/modelCatalog.js';

const blankBook = structuredClone(higgsfieldPricing);
function clearPrices(tree) {
  return tree && typeof tree === 'object'
    ? Object.fromEntries(Object.entries(tree).map(([key, value]) => [key, clearPrices(value)]))
    : null;
}
for (const modes of Object.values(blankBook.models))
  for (const config of Object.values(modes)) config.prices = clearPrices(config.prices);
const quotePrice = (body, options) => resolveQuote(body, { priceBook: blankBook, ...options });
const modelPriceSummary = (model, options) =>
  resolveSummary(model, { priceBook: blankBook, ...options });

const kling = {
  model: 'kling',
  mode: 'TEXT_TO_VIDEO',
  duration: 5,
  quality: 'standard',
  aspectRatio: '16:9',
};
const image = { model: 'qwen-image-3', mode: 'TEXT_TO_IMAGE', quality: '1k', aspectRatio: '1:1' };
function priced(body, rate, source = blankBook) {
  const book = structuredClone(source);
  const config = book.models[body.model][body.mode];
  let node = config;
  let key = 'prices';
  for (const path of config.dimensions) {
    node = node[key];
    key = String(path.startsWith('parameters.') ? body.parameters[path.slice(11)] : body[path]);
  }
  node[key] = rate;
  return book;
}

test('80% markup, USD conversion and exact ceil without floating-point errors', () => {
  assert.equal(calculatePrice('1').credits, 180);
  assert.equal(calculatePrice('1').retailUSD, '1.8');
  assert.equal(calculatePrice('0.05').credits, 9);
  assert.equal(calculatePrice('0.050000000000000001').credits, 10);
  assert.equal(calculatePrice('0.049999999999999999').credits, 9);
  assert.equal(calculatePrice('0.001').credits, 1);
  assert.equal(calculatePrice('0.07').credits, 13);
  assert.equal(
    calculatePrice('1', { markup: '0.4', creditValueUSD: '0.02', rounding: 'ceil' }).credits,
    70,
  );
});
test('null, zero, negative, malformed and out-of-range prices are unavailable', () => {
  for (const price of [
    null,
    undefined,
    0,
    '0',
    -1,
    '-1',
    '',
    true,
    {},
    [],
    'NaN',
    NaN,
    Infinity,
    '1e-3',
    '1,00',
    '999999999999',
  ])
    assert.equal(calculatePrice(price).status, 'PRICE_UNAVAILABLE', String(price));
  assert.equal(
    calculatePrice('1', { markup: 0.4, creditValueUSD: null, rounding: 'ceil' }).status,
    'PRICE_UNAVAILABLE',
  );
});
test('tariff JSON has exactly enabled models/modes and valid nullable prices', () => {
  const book = JSON.parse(
    readFileSync(new URL('../src/pricing/providers/higgsfield.json', import.meta.url)),
  );
  assert.deepEqual(
    Object.keys(book.models).sort(),
    modelConfigs
      .filter((m) => m.enabled)
      .map((m) => m.id)
      .sort(),
  );
  function leaves(tree) {
    if (tree !== null && typeof tree === 'object') Object.values(tree).forEach(leaves);
    else if (tree !== null) assert.equal(calculatePrice(tree).status, 'AVAILABLE');
  }
  for (const model of modelConfigs.filter((m) => m.enabled)) {
    assert.deepEqual(Object.keys(book.models[model.id]), Object.keys(model.modes));
    for (const config of Object.values(book.models[model.id])) {
      assert.equal(
        config.dimensions.includes('aspectRatio'),
        model.id === 'seedance-2-5' && config.workflow.endsWith('/text-to-video'),
      );
      leaves(config.prices);
    }
  }
  assert.equal(quotePrice(kling).status, 'PRICE_UNAVAILABLE');
});

test('optimized tariff has 124 cells, retaining the documented Seedance dimensional exception', () => {
  const expected = {
    kling: 2,
    'qwen-image-3': 4,
    'soul-v2': 4,
    'ideogram-4': 6,
    'recraft-v4-1': 1,
    'grok-image-2': 8,
    'kling-2-5-turbo': 2,
    'wan-3': 36,
    'seedance-2-5': 48,
    'kling-o3': 9,
    'kling-3-motion': 4,
  };
  const count = (value) =>
    value !== null && typeof value === 'object'
      ? Object.values(value).reduce((total, child) => total + count(child), 0)
      : 1;
  const counts = Object.fromEntries(
    Object.entries(blankBook.models).map(([id, modes]) => [
      id,
      Object.values(modes).reduce((total, config) => total + count(config.prices), 0),
    ]),
  );
  assert.deepEqual(counts, expected);
  assert.equal(
    Object.values(counts).reduce((total, value) => total + value, 0),
    124,
  );
});

test('all non-Seedance modes share price and version across supported aspect ratios', () => {
  const priceBook = structuredClone(blankBook);
  const fill = (value) =>
    value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fill(child)]))
      : '0.02';
  for (const modes of Object.values(priceBook.models))
    for (const config of Object.values(modes)) config.prices = fill(config.prices);
  for (const model of modelConfigs.filter(
    (model) => model.enabled && model.id !== 'seedance-2-5',
  )) {
    for (const [mode, caps] of Object.entries(model.modes)) {
      const body = { model: model.id, mode, ...caps.defaults, parameters: {} };
      const context = { priceBook, referenceDuration: 6.25 };
      const first = quotePrice(body, context);
      assert.equal(first.status, 'AVAILABLE', `${model.id}/${mode}`);
      for (const aspectRatio of caps.aspectRatios)
        assert.deepEqual(
          quotePrice({ ...body, aspectRatio }, context),
          first,
          `${model.id}/${mode}/${aspectRatio}`,
        );
    }
  }
});

test('Seedance token billing remains unavailable even when a flat-rate cell is filled', () => {
  for (const [mode, caps] of Object.entries(
    modelConfigs.find((model) => model.id === 'seedance-2-5').modes,
  )) {
    const body = {
      model: 'seedance-2-5',
      mode,
      ...caps.defaults,
      parameters: { generate_audio: true },
    };
    const priceBook = priced(body, '0.02');
    assert.equal(priceBook.models[body.model][mode].billingReviewRequired, true);
    assert.equal(quotePrice(body, { priceBook }).status, 'PRICE_UNAVAILABLE');
    assert.equal(
      modelPriceSummary(
        modelConfigs.find((model) => model.id === body.model),
        { priceBook },
      ).status,
      'PRICE_UNAVAILABLE',
    );
  }
});

test('resolution and generation mode still select separate rates', () => {
  const high = { ...image, quality: '2k' };
  const edit = { ...image, mode: 'IMAGE_TO_IMAGE' };
  let priceBook = priced(image, '0.01');
  priceBook = priced(high, '0.02', priceBook);
  priceBook = priced(edit, '0.03', priceBook);
  assert.equal(quotePrice(image, { priceBook }).credits, 2);
  assert.equal(quotePrice(high, { priceBook }).credits, 4);
  assert.equal(quotePrice(edit, { priceBook }).credits, 6);
  assert.equal(quotePrice({ ...edit, quality: '2k' }, { priceBook }).status, 'PRICE_UNAVAILABLE');
});

test('rendering speed, audio, quality mode and retained parameters keep independent rates', () => {
  const pairs = [
    [
      {
        model: 'ideogram-4',
        mode: 'TEXT_TO_IMAGE',
        aspectRatio: '1:1',
        parameters: { rendering_speed: 'DEFAULT' },
      },
      'rendering_speed',
      'QUALITY',
    ],
    [
      {
        model: 'grok-image-2',
        mode: 'TEXT_TO_IMAGE',
        quality: '1k',
        aspectRatio: '1:1',
        parameters: { quality: 'low' },
      },
      'quality',
      'medium',
    ],
    [
      {
        model: 'wan-3',
        mode: 'TEXT_TO_VIDEO',
        quality: '720p',
        aspectRatio: '16:9',
        duration: 5,
        parameters: { generate_audio: false, enable_thinking: false },
      },
      'generate_audio',
      true,
    ],
    [
      {
        model: 'wan-3',
        mode: 'TEXT_TO_VIDEO',
        quality: '720p',
        aspectRatio: '16:9',
        duration: 5,
        parameters: { generate_audio: false, enable_thinking: false },
      },
      'enable_thinking',
      true,
    ],
    [
      {
        model: 'kling-o3',
        mode: 'FIRST_LAST_FRAME',
        duration: 5,
        aspectRatio: '16:9',
        parameters: { mode: 'std', sound: 'off' },
      },
      'mode',
      '4k',
    ],
    [
      {
        model: 'kling-3-motion',
        mode: 'MOTION_CONTROL',
        parameters: { keep_original_sound: 'yes', character_orientation: 'video' },
      },
      'keep_original_sound',
      'no',
    ],
    [
      {
        model: 'kling-3-motion',
        mode: 'MOTION_CONTROL',
        parameters: { keep_original_sound: 'yes', character_orientation: 'video' },
      },
      'character_orientation',
      'image',
    ],
  ];
  for (const [body, key, value] of pairs) {
    const alternative = { ...body, parameters: { ...body.parameters, [key]: value } };
    const priceBook = priced(alternative, '0.02', priced(body, '0.01'));
    const context = { priceBook, referenceDuration: 6.25 };
    assert.ok(
      quotePrice(alternative, context).credits > quotePrice(body, context).credits,
      `${body.model}/${key}`,
    );
  }
});

test('per-second billing scales duration before one final ceil, without package assumptions', () => {
  const priceBook = priced(kling, '0.01');
  assert.equal(quotePrice(kling, { priceBook }).credits, 9);
  assert.equal(quotePrice({ ...kling, duration: 10 }, { priceBook }).credits, 18);
});

test('old aspect-ratio tariff structures are rejected rather than partially matched', () => {
  const book = priced(image, '0.01');
  book.models[image.model][image.mode].dimensions.push('aspectRatio');
  book.models[image.model][image.mode].prices['1k'] = { '1:1': '0.01' };
  assert.equal(quotePrice(image, { priceBook: book }).status, 'PRICE_UNAVAILABLE');
});
test('pricing resolves image and per-second video configurations and defaults', () => {
  assert.equal(quotePrice(image, { priceBook: priced(image, '0.05') }).credits, 9);
  assert.equal(quotePrice(kling, { priceBook: priced(kling, '0.01') }).credits, 9);
  const grok = {
    model: 'grok-image-2',
    mode: 'TEXT_TO_IMAGE',
    quality: '1k',
    aspectRatio: '1:1',
    parameters: { quality: 'medium' },
  };
  const book = priced(grok, '0.02');
  assert.equal(quotePrice({ ...grok, parameters: {} }, { priceBook: book }).credits, 4);
  assert.equal(
    quotePrice({ ...grok, parameters: { quality: 'low' } }, { priceBook: book }).status,
    'PRICE_UNAVAILABLE',
  );
});
test('unsupported model, mode, duration, resolution and parameters cannot fall back to a price', () => {
  const priceBook = priced(kling, '0.01');
  for (const change of [
    { model: 'missing' },
    { model: 'higgsfield' },
    { mode: 'TEXT_TO_IMAGE' },
    { duration: 6 },
    { quality: '1080p' },
    { aspectRatio: '4:3' },
    { parameters: { sound: 'on' } },
  ])
    assert.equal(quotePrice({ ...kling, ...change }, { priceBook }).status, 'PRICE_UNAVAILABLE');
  const drift = structuredClone(priceBook);
  drift.models.kling.TEXT_TO_VIDEO.fixed.sound = 'on';
  assert.equal(quotePrice(kling, { priceBook: drift }).status, 'PRICE_UNAVAILABLE');
});
test('reference-video price requires inspected duration and computes fractional seconds exactly', () => {
  const body = {
    model: 'kling-3-motion',
    mode: 'MOTION_CONTROL',
    parameters: { keep_original_sound: 'yes', character_orientation: 'video' },
  };
  const priceBook = priced(body, '0.02');
  assert.equal(quotePrice(body, { priceBook }).status, 'PRICE_UNAVAILABLE');
  const quote = quotePrice(body, { priceBook, referenceDuration: 6.25 });
  assert.equal(quote.providerCostUSD, '0.125');
  assert.equal(quote.credits, 23);
});
test('public prices expose only retail credits and tariff version', () => {
  const quote = quotePrice(image, { priceBook: priced(image, '0.05') });
  assert.deepEqual(Object.keys(publicPrice({ ...quote, secret: 'test', markup: 0.4 })).sort(), [
    'credits',
    'status',
    'tariffVersion',
  ]);
  assert.ok(!JSON.stringify(publicPrice(quote)).includes('USD'));
  assert.equal(publicPrice(null).credits, null);
});
test('tariff version changes with prices and summaries return fixed/from correctly', () => {
  const model = modelConfigs.find((m) => m.id === 'qwen-image-3');
  const partial = priced(image, '0.05');
  const first = quotePrice(image, { priceBook: partial });
  assert.equal(modelPriceSummary(model, { priceBook: partial }).kind, 'from');
  const second = quotePrice(image, { priceBook: priced(image, '0.06') });
  assert.notEqual(first.tariffVersion, second.tariffVersion);
  const fill = (tree) =>
    tree && typeof tree === 'object'
      ? Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, fill(v)]))
      : '0.05';
  for (const config of Object.values(partial.models[model.id])) config.prices = fill(config.prices);
  assert.equal(modelPriceSummary(model, { priceBook: partial }).kind, 'fixed');
});
