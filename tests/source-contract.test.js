const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const content = fs.readFileSync(require('node:path').join(__dirname, '../src/content.js'), 'utf8');
const popup = fs.readFileSync(require('node:path').join(__dirname, '../src/popup.js'), 'utf8');
const bypass = fs.readFileSync(require('node:path').join(__dirname, '../src/interruption-bypass.js'), 'utf8');

test('B07 detached/empty composer bukan acceptance evidence', () => {
  const acceptance = content.slice(content.indexOf('async function waitForAcceptance'), content.indexOf('async function pauseSession'));
  assert.equal(/!composer\?\.isConnected/.test(acceptance), false);
  assert.equal(acceptance.includes('findAcceptedUserTurn'), true);
});

test('B08 draf manual dipause sebelum setComposerText', () => {
  const send = content.slice(content.indexOf('async function sendNextPrompt'), content.indexOf('async function reconcilePreAcceptanceAttempt'));
  assert.ok(send.indexOf("pauseSession('manual-draft'") < send.indexOf('setComposerText(composer, prompt)'));
});

test('B10 journal sending dipersist sebelum click', () => {
  const journal = content.indexOf('journal intent BEFORE click');
  const click = content.indexOf('sendButton.click()', journal);
  assert.ok(journal > 0 && click > journal);
});

test('B11 sawGenerating dipersist saat transisi pertama', () => {
  assert.ok(content.includes('if (changed) await persistState()'));
});

test('B12 koordinasi lintas runner memakai Web Locks dan lease DOM bersama', () => {
  assert.ok(content.includes('navigator.locks'));
  assert.ok(content.includes('data-cqr-owner'));
  assert.ok(content.includes('runner-conflict'));
});

test('B13 monkey patch dan marker palsu dihapus', () => {
  assert.equal(content.includes('Document.prototype.querySelectorAll ='), false);
  assert.equal(bypass.includes('Document.prototype.querySelectorAll ='), false);
  assert.equal(bypass.includes('copy-turn-action-button'), false);
});

test('B17 popup menyimpan draft terpisah dengan debounce', () => {
  assert.ok(popup.includes("draft: 'cqr_draft'"));
  assert.ok(popup.includes('setTimeout(() => void saveDraft(), 250)'));
});

test('B16 owner hilang dapat dipulihkan eksplisit ke tab aktif yang benar', () => {
  assert.ok(content.includes('async function recoverOwner'));
  assert.ok(content.includes("message?.type === 'CQR_RECOVER_OWNER'"));
  assert.ok(popup.includes("type: 'CQR_RECOVER_OWNER'"));
});
