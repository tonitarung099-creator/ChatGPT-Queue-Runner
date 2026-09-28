const STORAGE_KEYS = {
  queue: "cqr_queue",
  config: "cqr_config",
  state: "cqr_state",
  pendingReplacement: "cqr_pending_replacement"
};

const DEFAULT_CONFIG = {
  delaySeconds: 6,
  maxItems: 100
};

const queueInput = document.querySelector("#queueInput");
const delayInput = document.querySelector("#delayInput");
const startButton = document.querySelector("#startButton");
const pauseButton = document.querySelector("#pauseButton");
const resetButton = document.querySelector("#resetButton");
const statusText = document.querySelector("#statusText");
const progressText = document.querySelector("#progressText");
const statusDot = document.querySelector("#statusDot");
const message = document.querySelector("#message");
const runnerName = document.querySelector("#runnerName");

let currentState = null;
let storedQueue = [];

function parseQueue(value) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeNumber(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function queuesMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function getActiveChatTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
    throw new Error("Buka percakapan ChatGPT di tab aktif terlebih dahulu.");
  }
  return tab;
}

async function sendToActiveTab(payload) {
  const tab = await getActiveChatTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, { ...payload, targetTabId: tab.id });
  } catch (_error) {
    throw new Error("Muat ulang tab ChatGPT setelah memasang ekstensi, lalu coba lagi.");
  }
}

async function sendToOwnerTab(payload) {
  const tabId = currentState?.ownerTabId;
  if (!Number.isInteger(tabId)) return sendToActiveTab(payload);
  try {
    return await chrome.tabs.sendMessage(tabId, { ...payload, targetTabId: tabId });
  } catch (_error) {
    throw new Error("Tab ChatGPT tempat antrean berjalan sudah tidak tersedia.");
  }
}

function stateLabel(state) {
  if (!state) return "Siap";
  if (state.status === "running") {
    return state.inFlight ? "Menunggu jawaban selesai" : "Menyiapkan prompt berikutnya";
  }
  if (state.status === "paused") return state.pausedReason || "Dijeda";
  if (state.status === "completed") return "Semua pekerjaan selesai";
  return "Siap";
}

function renderState(state) {
  currentState = state;
  const status = state?.status || "idle";
  const completed = state?.completedCount || 0;
  const total = state?.totalCount ?? storedQueue.length;

  statusText.textContent = stateLabel(state);
  progressText.textContent = `${completed} / ${total}`;
  statusDot.className = `status-dot ${status}`;
  startButton.textContent = status === "paused" ? "Lanjutkan" : "Mulai";
  startButton.disabled = status === "running";
  pauseButton.disabled = status !== "running";
}

async function initialize() {
  const extensionName = chrome.runtime.getManifest().name;
  document.title = extensionName;
  runnerName.textContent = extensionName;

  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  storedQueue = Array.isArray(stored[STORAGE_KEYS.queue]) ? stored[STORAGE_KEYS.queue] : [];
  const config = { ...DEFAULT_CONFIG, ...(stored[STORAGE_KEYS.config] || {}) };
  config.maxItems = DEFAULT_CONFIG.maxItems;

  queueInput.value = storedQueue.join("\n");
  delayInput.value = config.delaySeconds;
  renderState(stored[STORAGE_KEYS.state] || null);
}

startButton.addEventListener("click", async () => {
  message.textContent = "";
  const queue = parseQueue(queueInput.value);
  const config = {
    delaySeconds: normalizeNumber(delayInput.value, 3, 60, DEFAULT_CONFIG.delaySeconds),
    maxItems: DEFAULT_CONFIG.maxItems
  };

  if (!queue.length) {
    message.textContent = "Tambahkan setidaknya satu pekerjaan.";
    return;
  }

  if (queue.length > config.maxItems) {
    message.textContent = `Ada ${queue.length} pekerjaan, melebihi batas ${config.maxItems}.`;
    return;
  }

  const canResume = currentState?.status === "paused" && queuesMatch(queue, storedQueue);

  try {
    startButton.disabled = true;
    const sendCommand = canResume ? sendToOwnerTab : sendToActiveTab;
    const response = await sendCommand({
      type: canResume ? "CQR_RESUME" : "CQR_START",
      queue,
      config
    });
    if (!response?.ok) throw new Error(response?.error || "Ekstensi tidak dapat memulai antrean.");

    storedQueue = queue;
    await chrome.storage.local.set({
      [STORAGE_KEYS.queue]: queue,
      [STORAGE_KEYS.config]: config
    });
    renderState(response.state);
  } catch (error) {
    message.textContent = error.message;
    renderState(currentState);
  }
});

pauseButton.addEventListener("click", async () => {
  message.textContent = "";
  try {
    const response = await sendToOwnerTab({ type: "CQR_PAUSE" });
    if (!response?.ok) throw new Error(response?.error || "Gagal menjeda antrean.");
    renderState(response.state);
  } catch (error) {
    message.textContent = error.message;
  }
});

resetButton.addEventListener("click", async () => {
  message.textContent = "";
  let response = null;

  try {
    response = await sendToOwnerTab({ type: "CQR_RESET" });
  } catch (_error) {
    // Jika tab sudah ditutup, storage lokal tetap dapat direset di bawah.
  }

  try {
    await chrome.storage.local.remove(STORAGE_KEYS.pendingReplacement);
    if (response?.ok) {
      renderState(response.state);
    } else {
      await chrome.storage.local.remove(STORAGE_KEYS.state);
      renderState(null);
    }
  } catch (error) {
    message.textContent = error.message;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE_KEYS.state]) renderState(changes[STORAGE_KEYS.state].newValue || null);
});

initialize().catch((error) => {
  message.textContent = error.message;
});
