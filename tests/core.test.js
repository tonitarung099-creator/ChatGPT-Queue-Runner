const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/core.js');

test('B01 queuesMatch tersedia di sumber bersama', () => {
  assert.equal(Core.queuesMatch(['A'], ['A']), true);
  assert.equal(Core.queuesMatch(['A'], ['B']), false);
});

test('B04 identitas percakapan menghentikan A -> B', () => {
  const a = Core.conversationIdentity('https://chatgpt.com/c/A');
  const b = Core.conversationIdentity('https://chatgpt.com/c/B');
  assert.equal(Core.reconcileConversation(a, b, false).ok, false);
});

test('B04 new chat boleh bind ke ID setelah prompt diterima', () => {
  const start = Core.conversationIdentity('https://chatgpt.com/');
  const chat = Core.conversationIdentity('https://chatgpt.com/c/XYZ');
  const result = Core.reconcileConversation(start, chat, true);
  assert.equal(result.ok, true);
  assert.equal(result.bind.chatId, 'XYZ');
});

test('B14 approval Indonesia/Inggris terdeteksi tanpa posisi viewport', () => {
  assert.equal(Core.classifyActionLabel('Izinkan'), 'approval');
  assert.equal(Core.classifyActionLabel('Confirm'), 'approval');
  assert.equal(Core.classifyActionLabel('Continue generating'), 'interrupted');
  assert.equal(Core.classifyActionLabel('Try again'), 'failed');
  assert.equal(Core.classifyActionLabel('Regenerate'), null);
});

test('B18 outcome campuran dihitung jujur', () => {
  const counts = Core.outcomeCounts([
    { status: 'completed' }, { status: 'completed' }, { status: 'interrupted' }, { status: 'failed' }, { status: 'unknown' }
  ]);
  assert.deepEqual(counts, { processed: 5, completed: 2, interrupted: 1, failed: 1, unknown: 1 });
});

test('T26 validator menerima 100, menolak 101, clamp delay 3-60', () => {
  assert.equal(Core.normalizeQueue(Array.from({ length: 100 }, (_, i) => `P${i}`)).length, 100);
  assert.throws(() => Core.normalizeQueue(Array.from({ length: 101 }, (_, i) => `P${i}`)), /batas 100/);
  assert.equal(Core.normalizeConfig({ delaySeconds: 1 }).delaySeconds, 3);
  assert.equal(Core.normalizeConfig({ delaySeconds: 99 }).delaySeconds, 60);
});

test('T28 migrasi v0.1.8 running menjadi paused-reconcile', () => {
  const migrated = Core.migrateState({ status: 'running', nextIndex: 2, completedCount: 1, totalCount: 3, inFlight: { queueIndex: 1 }, ownerTabId: 7 });
  assert.equal(migrated.status, 'paused');
  assert.equal(migrated.pauseReason.code, 'legacy-reconcile');
  assert.equal(migrated.processedCount, 2);
  assert.equal(migrated.unknownCount, 1);
});
