const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// The editor's initial-load effect used to return from the success path without
// clearing its loading flag, leaving the page stuck on the spinner forever.
function effectSource() {
  const file = 'src/app/pages/AdminPolicyRatesEditor.tsx';
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf('useEffect(() => {');
  assert(start >= 0, 'initial load effect not found');
  const endMarker = '}, [rates, reservationTerms]);';
  const end = source.indexOf(endMarker, start);
  assert(end > start, 'effect terminator not found');
  return esbuild.transformSync(source.slice(start, end + endMarker.length), { loader: 'tsx' }).code;
}

async function runInitialLoad(fetchImpl, context = {}) {
  const calls = { isLoading: [], ratesForm: [], termsForm: [], baseline: [], errors: [] };
  let cb;
  const env = {
    useEffect: fn => { cb = fn; },
    localFetch: fetchImpl,
    rates: context.rates || {},
    reservationTerms: context.terms || {},
    setRatesForm: v => calls.ratesForm.push(v),
    setTermsForm: v => calls.termsForm.push(v),
    setPolicyRevision: () => {},
    setPolicyBaseline: v => calls.baseline.push(v),
    setPolicyLoadError: v => calls.errors.push(v),
    setPolicyWarning: () => {},
    setIsLoading: v => calls.isLoading.push(v),
  };
  vm.runInNewContext(`${effectSource()};`, env);
  cb();
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  return calls;
}

const ok = payload => async () => ({ ok: true, json: async () => payload });

test('loading finishes once saved policy settings are adopted', async () => {
  const calls = await runInitialLoad(ok({ hourlyRate: 150, overtimeRate: 300 }));
  assert.equal(calls.isLoading[0], true);
  assert.equal(calls.isLoading.at(-1), false, 'spinner must be cleared on the success path');
  assert.equal(calls.ratesForm.length, 1);
  assert.equal(calls.ratesForm[0].hourlyRate, 150);
});

test('loading finishes when the fetch falls back to context values', async () => {
  const calls = await runInitialLoad(async () => { throw new Error('offline'); }, { rates: { hourlyRate: 200 } });
  assert.equal(calls.isLoading.at(-1), false, 'spinner must be cleared on the fallback path');
  assert.equal(calls.ratesForm.length, 1);
});

test('loading finishes when the endpoints answer without usable rates', async () => {
  const calls = await runInitialLoad(ok({}));
  assert.equal(calls.isLoading.at(-1), false, 'spinner must be cleared when no saved rates are returned');
});
