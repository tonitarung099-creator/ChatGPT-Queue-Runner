'use strict';

const STORAGE_KEYS = {
  state: 'cqr_state'
};
const runnerNumber = chrome.runtime.getManifest().name.match(/\d+$/)?.[0] || '';
const CHAT_URL = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;

chrome.action.setBadgeText({ text: runnerNumber });
chrome.action.setBadgeBackgroundColor({ color: '#247455' });

async function pauseMissingOwner(tabId, reason) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.state);
  const state = stored[STORAGE_KEYS.state];
  if (!state || state.ownerTabId !== tabId || !['running', 'paused'].includes(state.status)) return;
  state.revision = (Number.parseInt(state.revision, 10) || 0) + 1;
  state.status = 'paused';
  state.phase = 'paused';
  state.pauseReason = { code: 'owner-missing', message: reason };
  state.updatedAt = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEYS.state]: state });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void pauseMissingOwner(tabId, 'Tab ChatGPT pemilik antrean ditutup. Buka percakapan yang benar lalu pulihkan sesi secara manual.');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (!CHAT_URL.test(tab?.url || changeInfo.url || '')) {
    void pauseMissingOwner(tabId, 'Tab pemilik keluar dari ChatGPT. Antrean dijeda agar tidak berpindah percakapan/situs.');
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.state);
  const state = stored[STORAGE_KEYS.state];
  if (!state || state.status !== 'running' || !Number.isInteger(state.ownerTabId)) return;
  try {
    const tab = await chrome.tabs.get(state.ownerTabId);
    if (!CHAT_URL.test(tab?.url || '')) await pauseMissingOwner(state.ownerTabId, 'Tab pemilik tidak lagi berada di ChatGPT setelah browser dimulai.');
  } catch (_error) {
    await pauseMissingOwner(state.ownerTabId, 'Tab pemilik tidak ditemukan setelah browser dimulai.');
  }
});

function launcherFetch(message, sender, sendResponse, kind) {
  (async () => {
    if (!CHAT_URL.test(sender.tab?.url || '')) throw new Error('Permintaan launcher bukan berasal dari tab ChatGPT');
    const requestedRunner = String(message.runner || '').padStart(2, '0');
    if (requestedRunner !== runnerNumber) throw new Error('Nomor runner launcher tidak cocok');

    let url;
    let timeoutMs;
    if (kind === 'initial') {
      const port = Number.parseInt(message.port, 10);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port launcher tidak valid');
      url = `http://127.0.0.1:${port}/runner/${runnerNumber}`;
      timeoutMs = 12000;
    } else if (kind === 'continue') {
      url = `http://127.0.0.1:47651/continue/${runnerNumber}`;
      timeoutMs = 2500;
    } else {
      url = `http://127.0.0.1:47652/replace/${runnerNumber}`;
      timeoutMs = 2500;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (response.status === 204) return sendResponse({ ok: true, payload: null });
      if (!response.ok) throw new Error(`Launcher merespons HTTP ${response.status}`);
      const payload = await response.json();
      sendResponse({ ok: true, payload });
    } finally {
      clearTimeout(timeout);
    }
  })().catch((error) => {
    const detail = error?.name === 'AbortError' ? 'Launcher lokal tidak merespons' : (error?.message || 'Gagal mengambil antrean launcher');
    sendResponse({ ok: false, error: detail });
  });
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CQR_GET_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return;
  }
  if (message?.type === 'CQR_GET_LAUNCHER_QUEUE') return launcherFetch(message, sender, sendResponse, 'initial');
  if (message?.type === 'CQR_GET_CONTINUE_QUEUE') return launcherFetch(message, sender, sendResponse, 'continue');
  if (message?.type === 'CQR_GET_REPLACE_QUEUE') return launcherFetch(message, sender, sendResponse, 'replace');
});
