import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionEpoch, renderLogin } from '../src/shared-session.mjs';
test('late requests cannot apply to a new login and each browser has an independent epoch', () => {
  const a = createSessionEpoch(); const b = createSessionEpoch();
  const pending = a.current(); const other = b.current();
  a.advance(); assert.equal(a.isCurrent(pending), false); assert.equal(b.isCurrent(other), true);
  assert.equal(a.isCurrent(a.current()), true);
});
test('login renders an accessible password input without reflecting passwords or error HTML', () => {
  const html = renderLogin('<img src=x onerror=alert(1)>');
  assert.match(html, /type="password"/); assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|value="/);
});
