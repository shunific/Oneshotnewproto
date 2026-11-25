const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

// Compile the real TypeScript guard and replace the Supabase client import
// with a tiny URL validator so the test stays offline and deterministic.
const source = fs.readFileSync(path.resolve(__dirname, '../src/app/utils/cmsImages.ts'), 'utf8')
  .replace(
    /import \{ isWebsiteImageValue \} from '\.\/supabase';/,
    `const isWebsiteImageValue = (value: unknown): boolean =>
       typeof value === 'string' && (
         value.includes('olywhyaozjlkjrnsdydg.supabase.co') ||
         value.startsWith('/api/images/') ||
         value.startsWith('data:image/')
       );`,
  );
const compiled = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code;

const moduleShim = { exports: {} };
new Function('module', 'exports', 'require', compiled)(moduleShim, moduleShim.exports, require);
const {
  decideCmsImageWrite,
  isValidCmsImageValue,
  parseCmsImageList,
} = moduleShim.exports;

const live = 'https://olywhyaozjlkjrnsdydg.supabase.co/storage/v1/object/public/oneshot-assets/hero.png';
const retired = 'https://bqnswmjopwmvunzchqzl.supabase.co/storage/v1/object/public/oneshot-assets/hero.png';
const existing = {
  keyname: 'heroImages',
  settingvalue: JSON.stringify([live]),
  dateAdded: '2026-10-01T00:00:00.000Z',
};

test('parses array and stored JSON gallery values', () => {
  assert.deepEqual(parseCmsImageList([live, retired]), [live, retired]);
  assert.deepEqual(parseCmsImageList(JSON.stringify([live])), [live]);
  assert.deepEqual(parseCmsImageList('not json'), ['not json']);
  assert.deepEqual(parseCmsImageList('[not json'), []);
  assert.deepEqual(parseCmsImageList(null), []);
});

test('accepts only website-reachable image sources', () => {
  assert.equal(isValidCmsImageValue('aboutImage', live), true);
  assert.equal(isValidCmsImageValue('aboutImage', retired), false);
  assert.equal(isValidCmsImageValue('aboutImage', '/api/images/local.png'), true);
  assert.equal(isValidCmsImageValue('heroImages', [live, live]), true);
  assert.equal(isValidCmsImageValue('heroImages', []), false);
  assert.equal(isValidCmsImageValue('heroImages', [live, retired]), false);
});

test('keeps an older valid row when the incoming image is blank or stale', () => {
  const blank = decideCmsImageWrite('aboutImage', '', existing);
  assert.equal(blank.action, 'keep');

  const stale = decideCmsImageWrite('aboutImage', retired, existing);
  assert.equal(stale.action, 'keep');

  const emptyGallery = decideCmsImageWrite('heroImages', [], existing);
  assert.equal(emptyGallery.action, 'keep');

  const staleGallery = decideCmsImageWrite('heroImages', [retired], existing);
  assert.equal(staleGallery.action, 'keep');
});

test('writes a valid image and preserves the original dateAdded', () => {
  const decision = decideCmsImageWrite('aboutImage', live, existing);
  assert.equal(decision.action, 'write');
  assert.equal(decision.value, live);
  assert.equal(decision.dateAdded, existing.dateAdded);

  const gallery = decideCmsImageWrite('heroImages', [live, live], existing);
  assert.equal(gallery.action, 'write');
  assert.equal(gallery.value, JSON.stringify([live, live]));
  assert.equal(gallery.dateAdded, existing.dateAdded);
});

test('allows an explicit clear only when the caller requests it', () => {
  const clearGallery = decideCmsImageWrite('heroImages', [], existing, { allowClear: true });
  assert.equal(clearGallery.action, 'write');
  assert.equal(clearGallery.value, '[]');

  const clearAbout = decideCmsImageWrite('aboutImage', '', existing, { allowClear: true });
  assert.equal(clearAbout.action, 'write');
  assert.equal(clearAbout.value, '');
});
