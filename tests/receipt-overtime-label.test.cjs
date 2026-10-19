const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = fs.readFileSync(require.resolve('../src/app/pages/Tables.tsx'), 'utf8');
const start = source.indexOf('<span>OVERTIME');
assert.ok(start > 0);
const label = source.slice(start, source.indexOf('</span>', start) + '</span>'.length);
const code = esbuild.transformSync(`globalThis.label = ${label};`, { loader: 'tsx', jsx: 'transform' }).code;
function render(rData) {
  const context = { React, rData, formatPHP: n => `PHP ${n.toFixed(2)}` };
  vm.runInNewContext(code, context);
  return renderToStaticMarkup(context.label);
}
test('legacy saved receipt replays do not invent missing overtime minutes or rates', () => {
  for (const metadata of [{}, { overtimeMins: null, overtimeRate: null }]) {
    assert.equal(render(metadata), '<span>OVERTIME</span>');
  }
});
test('current receipt label displays its recorded overtime metadata', () => {
  assert.equal(render({ overtimeMins: 17, overtimeRate: 300 }), '<span>OVERTIME (17m) @ PHP 300.00/HR</span>');
});
