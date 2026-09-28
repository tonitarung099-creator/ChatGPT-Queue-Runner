const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const content = fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8');
const popup = fs.readFileSync(path.join(__dirname, '../src/popup.js'), 'utf8');
const background = fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8');

test('B02 guard token diperiksa sesudah await dan tepat sebelum click', () => {
  const send = content.slice(content.indexOf('async function sendNextPrompt'), content.indexOf('async function reconcilePreAcceptanceAttempt'));
  assert.ok(send.includes('await waitForSendButton(token)'));
  assert.ok(send.includes('if (!tokenMatches(token, true)) return;'));
  assert.ok(send.includes('sendButton.click()'));
});

test('B03 launcher response lama ditolak dengan snapshot token', () => {
  assert.ok(content.includes('const token = stateToken();'));
  assert.ok(content.includes('if (!tokenMatches(token, false)'));
});

test('B05 accepted tanpa response punya watchdog dan tidak dianggap sukses', () => {
  assert.ok(content.includes('NO_RESPONSE_RECONCILE_MS'));
  assert.ok(content.includes("pauseSession('response-unknown'"));
});

test('B06 response dikaitkan ke user turn dan baseline assistant IDs', () => {
  assert.ok(content.includes('userTurnId'));
  assert.ok(content.includes('assistantTurnIdsBefore'));
  assert.ok(content.includes('findResponseTurn(attempt)'));
});

test('B09 replacement hanya diterapkan ketika status running dan aman', () => {
  const fn = content.slice(content.indexOf('async function applyPendingReplacementIfSafe'), content.indexOf('async function processTick'));
  assert.ok(fn.includes("state.status !== 'running'"));
  assert.ok(fn.includes('state.activeAttempt'));
});

test('B15 storage queue/config/state disinkronkan dan resume memakai revision', () => {
  assert.ok(content.includes('changes[STORAGE_KEYS.queue]'));
  assert.ok(content.includes('changes[STORAGE_KEYS.config]'));
  assert.ok(popup.includes('expectedRevision: currentState.revision'));
});

test('B16 background menangani tab removed dan URL keluar ChatGPT', () => {
  assert.ok(background.includes('chrome.tabs.onRemoved.addListener'));
  assert.ok(background.includes('chrome.tabs.onUpdated.addListener'));
  assert.ok(background.includes("code: 'owner-missing'"));
});

test('B18 interrupted/failed auto-next melalui waiting-delay, approval pause lebih dulu', () => {
  const monitor = content.slice(content.indexOf('async function monitorActiveAttempt'), content.indexOf('async function applyPendingReplacementIfSafe'));
  assert.ok(monitor.indexOf("blocker?.type === 'approval'") < monitor.indexOf('getTerminalSignal(attempt)'));
  assert.ok(content.includes("state.phase = 'waiting-delay'"));
});
