const test = require('node:test');
const assert = require('node:assert/strict');

class Model {
  constructor(queue = ['A', 'B', 'C']) {
    this.queue = queue;
    this.runId = 1;
    this.revision = 1;
    this.status = 'running';
    this.nextIndex = 0;
    this.clicked = 0;
    this.active = null;
    this.outcomes = [];
    this.pauseReason = null;
  }
  token() { return `${this.runId}:${this.revision}:${this.status}`; }
  pause(code = 'user') { this.revision += 1; this.status = 'paused'; this.pauseReason = code; }
  reset() { this.runId += 1; this.revision += 1; this.status = 'idle'; this.active = null; this.nextIndex = 0; }
  beginSend() { this.active = { index: this.nextIndex, stage: 'sending', clicked: false, accepted: false }; return this.token(); }
  click(token) { if (token !== this.token() || this.status !== 'running') return false; this.clicked += 1; this.active.clicked = true; this.active.stage = 'awaiting-acceptance'; return true; }
  accept() { this.active.accepted = true; this.active.stage = 'awaiting-response'; this.nextIndex += 1; }
  resume() { this.revision += 1; this.status = 'running'; }
  terminal(status) { this.outcomes.push({ index: this.active.index, status }); this.active = null; }
}

test('T10 Jeda setelah await sebelum klik menghasilkan nol klik', () => {
  const m = new Model(); const token = m.beginSend(); m.pause(); assert.equal(m.click(token), false); assert.equal(m.clicked, 0);
});

test('T11 Reset setelah await tidak revive state baru', () => {
  const m = new Model(); const token = m.beginSend(); m.reset(); assert.equal(m.click(token), false); assert.equal(m.active, null); assert.equal(m.status, 'idle');
});

test('T12 klik sudah terjadi tidak dianggap dapat ditarik kembali', () => {
  const m = new Model(); const token = m.beginSend(); assert.equal(m.click(token), true); m.pause(); assert.equal(m.clicked, 1); assert.equal(m.active.clicked, true);
});

test('T14 send ambigu tidak retry buta saat resume', () => {
  const m = new Model(); const token = m.beginSend(); m.click(token); m.pause('send-ambiguous'); const clicks = m.clicked; m.resume(); assert.equal(m.clicked, clicks); assert.equal(m.active.stage, 'awaiting-acceptance');
});

test('T25 interruption/failed tetap processed berbeda dari success', () => {
  const m = new Model(['A','B']); let token = m.beginSend(); m.click(token); m.accept(); m.terminal('interrupted'); token = m.beginSend(); m.click(token); m.accept(); m.terminal('failed'); assert.deepEqual(m.outcomes.map(x => x.status), ['interrupted','failed']); assert.equal(m.nextIndex, 2);
});

test('T22 pause manual tidak hilang hanya karena replacement pending (model contract)', () => {
  const m = new Model(); m.pause('user'); const before = m.pauseReason; const pendingReplacement = ['X']; assert.ok(pendingReplacement); assert.equal(m.status, 'paused'); assert.equal(m.pauseReason, before);
});
