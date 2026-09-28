(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CQRCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const MAX_ITEMS = 100;
  const MIN_DELAY_SECONDS = 3;
  const MAX_DELAY_SECONDS = 60;
  const DEFAULT_DELAY_SECONDS = 6;

  function normalizeText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeQueue(value, maxItems = MAX_ITEMS) {
    const list = Array.isArray(value) ? value : [];
    const queue = list.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (!queue.length) throw new Error('Antrean kosong');
    if (queue.length > maxItems) throw new Error(`Jumlah pekerjaan melebihi batas ${maxItems}`);
    return queue;
  }

  function normalizeConfig(value) {
    const raw = Number.parseInt(value?.delaySeconds, 10);
    const delaySeconds = Number.isInteger(raw)
      ? Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, raw))
      : DEFAULT_DELAY_SECONDS;
    return { delaySeconds, maxItems: MAX_ITEMS };
  }

  function queuesMatch(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => String(item) === String(right[index]));
  }

  function fingerprint(value) {
    const text = String(value || '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function randomId(prefix = 'id') {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`;
  }

  function conversationIdentity(input) {
    const url = input instanceof URL ? input : new URL(String(input));
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const parts = path.split('/').filter(Boolean);
    const chatIndex = parts.indexOf('c');
    if (chatIndex >= 0 && parts[chatIndex + 1]) {
      const scopeParts = parts.slice(0, chatIndex);
      return {
        origin: url.origin,
        scope: `/${scopeParts.join('/')}` || '/',
        chatId: parts[chatIndex + 1],
        isNew: false,
        key: `${url.origin}|/${scopeParts.join('/')}|c:${parts[chatIndex + 1]}`
      };
    }
    return {
      origin: url.origin,
      scope: path,
      chatId: null,
      isNew: true,
      key: `${url.origin}|${path}|new`
    };
  }

  function reconcileConversation(bound, current, canBindNewChat) {
    if (!bound) return { ok: true, bind: current };
    if (bound.origin !== current.origin) return { ok: false, reason: 'Percakapan berpindah ke situs lain' };
    if (!bound.isNew) {
      if (!current.isNew && bound.chatId === current.chatId && bound.scope === current.scope) return { ok: true, bind: bound };
      return { ok: false, reason: 'Percakapan ChatGPT berubah' };
    }
    if (current.isNew && bound.scope === current.scope) return { ok: true, bind: bound };
    if (canBindNewChat && !current.isNew) return { ok: true, bind: current };
    return { ok: false, reason: 'Tab berpindah dari percakapan awal' };
  }

  function outcomeCounts(outcomes) {
    const counts = { processed: 0, completed: 0, interrupted: 0, failed: 0, unknown: 0 };
    for (const item of Array.isArray(outcomes) ? outcomes : []) {
      if (!item || !['completed', 'interrupted', 'failed', 'unknown'].includes(item.status)) continue;
      counts.processed += 1;
      counts[item.status] += 1;
    }
    return counts;
  }

  function makeIdleState(previousRevision = 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: Number.isInteger(previousRevision) ? previousRevision : 0,
      runId: null,
      status: 'idle',
      phase: 'idle',
      nextIndex: 0,
      totalCount: 0,
      outcomes: [],
      processedCount: 0,
      successCount: 0,
      interruptedCount: 0,
      failedCount: 0,
      unknownCount: 0,
      activeAttempt: null,
      delayUntil: null,
      pauseReason: null,
      ownerTabId: null,
      conversationIdentity: null,
      leaseToken: null,
      processedCommandIds: [],
      updatedAt: Date.now()
    };
  }

  function syncOutcomeCounters(state) {
    const counts = outcomeCounts(state.outcomes);
    state.processedCount = counts.processed;
    state.successCount = counts.completed;
    state.interruptedCount = counts.interrupted;
    state.failedCount = counts.failed;
    state.unknownCount = counts.unknown;
    return state;
  }

  function migrateState(raw) {
    if (!raw || typeof raw !== 'object') return makeIdleState();
    if (raw.schemaVersion === SCHEMA_VERSION) {
      const next = { ...makeIdleState(raw.revision), ...raw };
      next.outcomes = Array.isArray(raw.outcomes) ? raw.outcomes : [];
      return syncOutcomeCounters(next);
    }

    const next = makeIdleState(1);
    next.totalCount = Number.isInteger(raw.totalCount) ? raw.totalCount : 0;
    next.nextIndex = Number.isInteger(raw.nextIndex) ? raw.nextIndex : 0;
    const completed = Math.max(0, Number.parseInt(raw.completedCount, 10) || 0);
    next.outcomes = Array.from({ length: Math.min(completed, next.totalCount) }, (_, index) => ({
      queueIndex: index,
      itemId: `legacy-${index}`,
      status: 'completed',
      reason: 'Dimigrasikan dari v0.1.8',
      finishedAt: Date.now()
    }));
    const legacyInFlightIndex = Number.parseInt(raw.inFlight?.queueIndex, 10);
    if (Number.isInteger(legacyInFlightIndex) && legacyInFlightIndex >= 0 && legacyInFlightIndex < next.totalCount && !next.outcomes.some((item) => item.queueIndex === legacyInFlightIndex)) {
      next.outcomes.push({
        queueIndex: legacyInFlightIndex,
        itemId: `legacy-${legacyInFlightIndex}`,
        status: 'unknown',
        reason: 'Item aktif v0.1.8 tidak dikirim ulang otomatis; hasilnya perlu diperiksa.',
        finishedAt: Date.now()
      });
    }
    syncOutcomeCounters(next);
    if (raw.status === 'running' || raw.inFlight) {
      next.status = 'paused';
      next.phase = 'paused';
      next.pauseReason = {
        code: 'legacy-reconcile',
        message: 'Sesi v0.1.8 perlu diperiksa sebelum dilanjutkan agar prompt tidak terkirim ganda.'
      };
      next.ownerTabId = Number.isInteger(raw.ownerTabId) ? raw.ownerTabId : null;
    } else if (raw.status === 'paused') {
      next.status = 'paused';
      next.phase = 'paused';
      next.pauseReason = { code: 'legacy-paused', message: raw.pausedReason || 'Sesi lama dijeda' };
      next.ownerTabId = Number.isInteger(raw.ownerTabId) ? raw.ownerTabId : null;
    } else if (raw.status === 'completed') {
      next.status = 'completed';
      next.phase = 'completed';
    }
    return next;
  }

  function classifyActionLabel(value) {
    const text = normalizeText(value).toLowerCase();
    if (!text) return null;
    if (/^(continue generating|continue response|lanjutkan membuat|lanjutkan menghasilkan|lanjutkan jawaban)$/.test(text)) return 'interrupted';
    if (/^(try again|retry|coba lagi|ulangi)$/.test(text)) return 'failed';
    if (/\b(confirm|allow|approve|izinkan|konfirmasi|setujui|beri izin|ya, lanjut|yes, continue)\b/.test(text)) return 'approval';
    return null;
  }

  function shouldAutoResumePause(code) {
    return ['launcher-wait', 'composer-recovered'].includes(String(code || ''));
  }

  return {
    SCHEMA_VERSION,
    MAX_ITEMS,
    MIN_DELAY_SECONDS,
    MAX_DELAY_SECONDS,
    DEFAULT_DELAY_SECONDS,
    normalizeText,
    normalizeQueue,
    normalizeConfig,
    queuesMatch,
    fingerprint,
    randomId,
    conversationIdentity,
    reconcileConversation,
    outcomeCounts,
    makeIdleState,
    syncOutcomeCounters,
    migrateState,
    classifyActionLabel,
    shouldAutoResumePause
  };
});
