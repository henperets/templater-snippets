'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const vm = require('node:vm');

// extension.js requires 'vscode', which only exists inside VS Code. A stub is enough to build the HTML.
function loadExtension() {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? {} : load.call(this, request, ...rest);
  };
  try { return require('../src/extension'); }
  finally { Module._load = load; }
}

// The webview script lives inside a template string, where a single backslash is silently
// dropped (`\[` becomes `[`). node --check can't see that, so parse the script as delivered.
test('VS Code webview script is valid JavaScript', () => {
  const html = loadExtension().getHtml('test-nonce');
  const match = html.match(/<script nonce="test-nonce">([\s\S]*)<\/script>/);
  assert.ok(match, 'webview script not found');
  assert.doesNotThrow(() => new vm.Script(match[1]));
});

test('VS Code webview script keeps the placeholder regex intact', () => {
  const html = loadExtension().getHtml('n');
  assert.ok(html.includes('/\\[([^\\]]*)\\]/g'), 'the [Field] regex lost its escapes');
});
