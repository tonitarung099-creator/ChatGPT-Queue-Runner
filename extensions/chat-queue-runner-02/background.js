const runnerNumber = chrome.runtime.getManifest().name.match(/\d+$/)?.[0] || "";

chrome.action.setBadgeText({ text: runnerNumber });
chrome.action.setBadgeBackgroundColor({ color: "#247455" });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CQR_GET_TAB_ID") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return;
  }

  if (message?.type === "CQR_GET_LAUNCHER_QUEUE") {
    (async () => {
      if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.tab?.url || "")) {
        throw new Error("Permintaan launcher bukan berasal dari tab ChatGPT");
      }

      const port = Number.parseInt(message.port, 10);
      const requestedRunner = String(message.runner || "").padStart(2, "0");
      if (requestedRunner !== runnerNumber) throw new Error("Nomor runner launcher tidak cocok");
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error("Port launcher tidak valid");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/runner/${runnerNumber}`, {
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Launcher merespons HTTP ${response.status}`);

        const payload = await response.json();
        sendResponse({ ok: true, payload });
      } finally {
        clearTimeout(timeout);
      }
    })().catch((error) => {
      const detail = error?.name === "AbortError"
        ? "Launcher lokal tidak merespons"
        : error?.message || "Gagal mengambil antrean launcher";
      sendResponse({ ok: false, error: detail });
    });
    return true;
  }

  if (message?.type === "CQR_GET_CONTINUE_QUEUE") {
    (async () => {
      if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.tab?.url || "")) {
        throw new Error("Permintaan lanjutan bukan berasal dari tab ChatGPT");
      }

      const requestedRunner = String(message.runner || "").padStart(2, "0");
      if (requestedRunner !== runnerNumber) throw new Error("Nomor runner lanjutan tidak cocok");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);

      try {
        const response = await fetch(`http://127.0.0.1:47651/continue/${runnerNumber}`, {
          cache: "no-store",
          signal: controller.signal
        });
        if (response.status === 204) {
          sendResponse({ ok: true, payload: null });
          return;
        }
        if (!response.ok) throw new Error(`Server lanjutan merespons HTTP ${response.status}`);
        sendResponse({ ok: true, payload: await response.json() });
      } finally {
        clearTimeout(timeout);
      }
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "CQR_GET_REPLACE_QUEUE") {
    (async () => {
      if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.tab?.url || "")) {
        throw new Error("Permintaan penggantian bukan berasal dari tab ChatGPT");
      }

      const requestedRunner = String(message.runner || "").padStart(2, "0");
      if (requestedRunner !== runnerNumber) throw new Error("Nomor runner penggantian tidak cocok");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);

      try {
        const response = await fetch(`http://127.0.0.1:47652/replace/${runnerNumber}`, {
          cache: "no-store",
          signal: controller.signal
        });
        if (response.status === 204) {
          sendResponse({ ok: true, payload: null });
          return;
        }
        if (!response.ok) throw new Error(`Server penggantian merespons HTTP ${response.status}`);
        sendResponse({ ok: true, payload: await response.json() });
      } finally {
        clearTimeout(timeout);
      }
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
});
