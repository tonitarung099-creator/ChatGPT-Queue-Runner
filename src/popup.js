'use strict';

const STORAGE_KEYS = {
  queue: 'cqr_queue',
  config: 'cqr_config',
  state: 'cqr_state',
  draft: 'cqr_draft',
  pendingReplacement: 'cqr_pending_replacement'
};
const DEFAULT_CONFIG = { delaySeconds: 6, maxItems: 100 };

const queueInput = document.querySelector('#queueInput');
const delayInput = document.querySelector('#delayInput');
const startButton = document.querySelector('#startButton');
const pauseButton = document.querySelector('#pauseButton');
const resetButton = document.querySelector('#resetButton');
const statusText = document.querySelector('#statusText');
const progressText = document.querySelector('#progressText');
const statusDot = document.querySelector('#statusDot');
const message = document.querySelector('#message');
const runnerName = document.querySelector('#runnerName');

let currentState = null;
let storedQueue = [];
let storedConfig = { ...DEFAULT_CONFIG };
let draftDirty = false;
let draftTimer = null;

function parseQueue(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function normalizeNumber(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function queuesMatch(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

function currentDraft() {
  return {
    text: queueInput.value,
    delaySeconds: normalizeNumber(delayInput.value, 3, 60, DEFAULT_CONFIG.delaySeconds),
    updatedAt: Date.now()
  };
}

async function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  await chrome.storage.local.set({ [STORAGE_KEYS.draft]: currentDraft() });
}

function scheduleDraftSave() {
  draftDirty = true;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => void saveDraft(), 250);
}

async function getActiveChatTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) {
    throw new Error('Buka percakapan ChatGPT di tab aktif terlebih dahulu.');
  }
  return tab;
}

async function sendToActiveTab(payload) {
  const tab = await getActiveChatTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, { ...payload, targetTabId: tab.id });
  } catch (_error) {
    throw new Error('Muat ulang tab ChatGPT setelah memasang/memperbarui ekstensi, lalu coba lagi.');
  }
}

async function sendToOwnerTab(payload) {
  const tabId = currentState?.ownerTabId;
  if (!Number.isInteger(tabId)) return sendToActiveTab(payload);
  try {
    return await chrome.tabs.sendMessage(tabId, { ...payload, targetTabId: tabId });
  } catch (_error) {
    throw new Error('Tab ChatGPT tempat antrean berjalan sudah tidak tersedia.');
  }
}

function stateLabel(state) {
  if (!state) return 'Siap';
  if (state.status === 'running') {
    if (state.phase === 'waiting-delay') return 'Menunggu jeda sebelum prompt berikutnya';
    if (state.phase === 'sending' || state.phase === 'awaiting-acceptance') return 'Mengirim prompt dan memverifikasi penerimaan';
    if (state.activeAttempt) return 'Menunggu jawaban ChatGPT';
    return 'Menyiapkan prompt berikutnya';
  }
  if (state.status === 'paused') return state.pauseReason?.message || 'Dijeda';
  if (state.status === 'completed') return 'Semua pekerjaan sudah diproses';
  return 'Siap';
}

function renderState(state) {
  currentState = state || null;
  const status = state?.status || 'idle';
  const processed = state?.processedCount || 0;
  const total = state?.totalCount ?? storedQueue.length;
  const success = state?.successCount || 0;
  const interrupted = state?.interruptedCount || 0;
  const failed = state?.failedCount || 0;
  const unknown = state?.unknownCount || 0;

  statusText.textContent = stateLabel(state);
  progressText.textContent = `${processed}/${total} diproses · ${success} berhasil · ${interrupted} terhenti · ${failed} gagal${unknown ? ` · ${unknown} perlu cek` : ''}`;
  statusDot.className = `status-dot ${status}`;
  startButton.textContent = status === 'paused' ? 'Lanjutkan' : 'Mulai';
  startButton.disabled = status === 'running';
  pauseButton.disabled = status !== 'running';
}

async function initialize() {
  const extensionName = chrome.runtime.getManifest().name;
  document.title = extensionName;
  runnerName.textContent = extensionName;

  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  storedQueue = Array.isArray(stored[STORAGE_KEYS.queue]) ? stored[STORAGE_KEYS.queue] : [];
  storedConfig = { ...DEFAULT_CONFIG, ...(stored[STORAGE_KEYS.config] || {}) };
  const draft = stored[STORAGE_KEYS.draft];

  queueInput.value = typeof draft?.text === 'string' ? draft.text : storedQueue.join('\n');
  delayInput.value = Number.isInteger(draft?.delaySeconds) ? draft.delaySeconds : storedConfig.delaySeconds;
  draftDirty = false;
  renderState(stored[STORAGE_KEYS.state] || null);
}

queueInput.addEventListener('input', scheduleDraftSave);
delayInput.addEventListener('input', scheduleDraftSave);
window.addEventListener('pagehide', () => { if (draftTimer) void saveDraft(); });

startButton.addEventListener('click', async () => {
  message.textContent = '';
  const draftQueue = parseQueue(queueInput.value);
  const config = {
    delaySeconds: normalizeNumber(delayInput.value, 3, 60, DEFAULT_CONFIG.delaySeconds),
    maxItems: DEFAULT_CONFIG.maxItems
  };

  if (!draftQueue.length) {
    message.textContent = 'Tambahkan setidaknya satu pekerjaan.';
    return;
  }
  if (draftQueue.length > config.maxItems) {
    message.textContent = `Ada ${draftQueue.length} pekerjaan, melebihi batas ${config.maxItems}.`;
    return;
  }

  const canResume = currentState?.status === 'paused' && queuesMatch(draftQueue, storedQueue);
  try {
    startButton.disabled = true;
    let response;
    if (canResume && currentState?.pauseReason?.code === 'owner-missing') {
      response = await sendToActiveTab({ type: 'CQR_RECOVER_OWNER', expectedRevision: currentState.revision });
    } else if (canResume) {
      response = await sendToOwnerTab({ type: 'CQR_RESUME', expectedRevision: currentState.revision });
    } else {
      response = await sendToActiveTab({ type: 'CQR_START', queue: draftQueue, config });
    }
    if (!response?.ok) throw new Error(response?.error || 'Ekstensi tidak dapat menjalankan antrean.');

    if (!canResume) {
      storedQueue = draftQueue;
      storedConfig = config;
      await chrome.storage.local.set({
        [STORAGE_KEYS.queue]: storedQueue,
        [STORAGE_KEYS.config]: storedConfig,
        [STORAGE_KEYS.draft]: currentDraft()
      });
      draftDirty = false;
    }
    renderState(response.state);
  } catch (error) {
    message.textContent = error.message;
    renderState(currentState);
  }
});

pauseButton.addEventListener('click', async () => {
  message.textContent = '';
  try {
    const response = await sendToOwnerTab({ type: 'CQR_PAUSE' });
    if (!response?.ok) throw new Error(response?.error || 'Gagal menjeda antrean.');
    renderState(response.state);
  } catch (error) {
    message.textContent = error.message;
  }
});

resetButton.addEventListener('click', async () => {
  message.textContent = '';
  let response = null;
  try {
    response = await sendToOwnerTab({ type: 'CQR_RESET' });
  } catch (_error) {
    // Owner may be gone. Reset local session below without touching the saved draft.
  }

  try {
    await chrome.storage.local.remove([STORAGE_KEYS.pendingReplacement]);
    if (response?.ok) renderState(response.state);
    else {
      const previousRevision = Number.parseInt(currentState?.revision, 10) || 0;
      const idle = {
        schemaVersion: 2,
        revision: previousRevision + 1,
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
      await chrome.storage.local.set({ [STORAGE_KEYS.state]: idle });
      renderState(idle);
    }
  } catch (error) {
    message.textContent = error.message;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STORAGE_KEYS.state]) renderState(changes[STORAGE_KEYS.state].newValue || null);
  if (changes[STORAGE_KEYS.queue]) {
    const previous = storedQueue;
    storedQueue = Array.isArray(changes[STORAGE_KEYS.queue].newValue) ? changes[STORAGE_KEYS.queue].newValue : [];
    if (!draftDirty && queuesMatch(parseQueue(queueInput.value), previous)) queueInput.value = storedQueue.join('\n');
    else if (draftDirty && !queuesMatch(parseQueue(queueInput.value), storedQueue)) message.textContent = 'Antrean aktif berubah dari launcher. Draf Anda tetap dipertahankan terpisah.';
  }
  if (changes[STORAGE_KEYS.config]) {
    storedConfig = { ...DEFAULT_CONFIG, ...(changes[STORAGE_KEYS.config].newValue || {}) };
    if (!draftDirty) delayInput.value = storedConfig.delaySeconds;
  }
});

initialize().catch((error) => { message.textContent = error.message; });
