(() => {
  if (window.__CHAT_QUEUE_RUNNER_LOADED__) return;
  window.__CHAT_QUEUE_RUNNER_LOADED__ = true;

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

  const RUNNER_NAME = chrome.runtime.getManifest().name;
  const RUNNER_NUMBER = RUNNER_NAME.match(/\d+$/)?.[0] || "";

  const POLL_INTERVAL_MS = 1000;
  const MIN_RESPONSE_AGE_MS = 1500;
  const COMPOSER_WAIT_TIMEOUT_MS = 60000;
  const CONTINUE_POLL_INTERVAL_MS = 4000;

  let queue = [];
  let config = { ...DEFAULT_CONFIG };
  let state = makeIdleState();
  let tickLocked = false;
  let composerMissingSince = null;
  let continuePollLocked = false;
  let replacePollLocked = false;
  let pendingReplacement = null;
  let widget = null;
  let localTabId = null;

  function makeIdleState() {
    return {
      status: "idle",
      nextIndex: 0,
      completedCount: 0,
      totalCount: 0,
      inFlight: null,
      pausedReason: null,
      ownerTabId: null,
      updatedAt: Date.now()
    };
  }

  function isVisible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function isOnScreen(element) {
    if (!isVisible(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  function firstVisible(selectors) {
    for (const selector of selectors) {
      const match = [...document.querySelectorAll(selector)].find(isVisible);
      if (match) return match;
    }
    return null;
  }

  function firstOnScreen(selectors) {
    for (const selector of selectors) {
      const match = [...document.querySelectorAll(selector)].find(isOnScreen);
      if (match) return match;
    }
    return null;
  }

  function getComposer() {
    return firstVisible([
      "#prompt-textarea[contenteditable='true']",
      "textarea[name='prompt-textarea']",
      "textarea[data-testid='prompt-textarea']",
      "form[data-chatgpt-composer] [data-composer-markdown][contenteditable='true'][role='textbox']",
      "form[data-chatgpt-composer] .ProseMirror[contenteditable='true']",
      "div[contenteditable='true'][data-lexical-editor='true']",
      "main div[contenteditable='true'][role='textbox']",
      "[contenteditable='true'][role='textbox'][aria-label*='Chat' i]"
    ]);
  }

  function getSendButton() {
    return firstVisible([
      "button[data-testid='send-button']",
      "#composer-submit-button",
      "form[data-chatgpt-composer] button[type='submit']",
      "form[data-chatgpt-composer] button[aria-label='Send']",
      "button.composer-submit-btn",
      "button[aria-label='Send prompt']",
      "button[aria-label='Kirim prompt']",
      "button[aria-label='Send message']",
      "button[aria-label='Kirim pesan']",
      "button[aria-label*='Send' i]",
      "button[aria-label*='Kirim' i]"
    ]);
  }

  function getStopButton() {
    return firstVisible([
      "button[data-testid='stop-button']",
      "form[data-chatgpt-composer] button[type='button'][aria-label='Stop']",
      "button[aria-label*='Stop streaming']",
      "button[aria-label*='Stop generating']",
      "button[aria-label*='Hentikan']"
    ]);
  }

  function getAssistantTurns() {
    const selectors = [
      "section[data-turn='assistant']",
      "[data-testid^='conversation-turn-'][data-turn='assistant']",
      "[data-testid^='conversation-turn-'][data-message-author-role='assistant']",
      "[data-turn-key]:has([data-conversation-role='assistant'])",
      "[data-message-author-role='assistant']"
    ];

    for (const selector of selectors) {
      const matches = [...document.querySelectorAll(selector)];
      if (matches.length) return matches;
    }
    return [];
  }

  function getAssistantCount() {
    return getAssistantTurns().length;
  }

  function isGenerating() {
    if (getStopButton()) return true;
    return Boolean(firstVisible([
      "section[data-turn='assistant'][aria-busy='true']",
      "[data-message-author-role='assistant'][aria-busy='true']",
      "[data-turn='assistant'] [aria-busy='true']"
    ]));
  }

  function getBlockingReason() {
    const confirmation = firstOnScreen([
      "button[data-testid*='confirm' i]",
      "button[data-testid*='approve' i]",
      "button[aria-label*='Confirm' i]",
      "button[aria-label*='Allow' i]",
      "button[aria-label*='Approve' i]",
      "button[aria-label*='Konfirmasi' i]",
      "button[aria-label*='Izinkan' i]",
      "button[aria-label*='Setujui' i]"
    ]);
    if (confirmation) return "Perlu konfirmasi pengguna";

    const buttons = [...document.querySelectorAll("main button")].filter(isOnScreen);
    const hasAction = (pattern) => buttons.some((button) => pattern.test(button.textContent?.trim() || ""));

    if (hasAction(/^(continue generating|lanjutkan membuat|lanjutkan menghasilkan)$/i)) {
      return "Jawaban terhenti; klik lanjutkan dahulu";
    }
    if (hasAction(/^(try again|retry|coba lagi|ulangi)$/i)) {
      return "ChatGPT menampilkan kesalahan; perlu diperiksa";
    }
    return null;
  }

  async function persistState() {
    state.updatedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEYS.state]: state });
    renderWidget();
  }

  function publicState() {
    return JSON.parse(JSON.stringify(state));
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor?.set?.call(element, value);
  }

  function setComposerText(composer, prompt) {
    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      setNativeValue(composer, prompt);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete", false);
    document.execCommand("insertText", false, prompt);

    const currentText = (composer.innerText || composer.textContent || "").replace(/\u00a0/g, " ").trim();
    if (!currentText || currentText !== prompt.trim()) {
      composer.textContent = prompt;
    }

    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: prompt
    }));
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function waitForSendButton(timeoutMs = 3500) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const button = getSendButton();
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
      await sleep(100);
    }
    return null;
  }

  async function sendNextPrompt() {
    if (state.status !== "running" || state.inFlight || state.nextIndex >= queue.length) return;

    const composer = getComposer();
    if (!composer) {
      if (!composerMissingSince) composerMissingSince = Date.now();
      if (Date.now() - composerMissingSince < COMPOSER_WAIT_TIMEOUT_MS) return;
      composerMissingSince = null;
      throw new Error("Kotak prompt ChatGPT tidak ditemukan");
    }
    composerMissingSince = null;

    const queueIndex = state.nextIndex;
    const prompt = queue[queueIndex];
    const assistantCountBefore = getAssistantCount();

    setComposerText(composer, prompt);
    const sendButton = await waitForSendButton();
    if (!sendButton) throw new Error("Tombol kirim ChatGPT tidak aktif");

    sendButton.click();
    state.nextIndex += 1;
    state.inFlight = {
      external: false,
      queueIndex,
      sentAt: Date.now(),
      assistantCountBefore,
      sawGenerating: false,
      idleSince: null
    };
    await persistState();
  }

  async function finishInFlight() {
    const finished = state.inFlight;
    state.inFlight = null;
    if (finished && !finished.external) state.completedCount += 1;

    if (state.nextIndex >= queue.length && state.completedCount >= queue.length) {
      state.status = "completed";
      state.pausedReason = null;
    }
    await persistState();
  }

  async function pause(reason) {
    state.status = "paused";
    state.pausedReason = reason || "Dijeda";
    await persistState();
  }

  async function processTick() {
    if (
      tickLocked ||
      localTabId === null ||
      state.ownerTabId !== localTabId
    ) return;
    tickLocked = true;

    try {
      if (await applyPendingReplacementIfSafe(true)) return;
      if (state.status !== "running") return;

      const blockingReason = getBlockingReason();
      if (blockingReason) {
        await pause(blockingReason);
        return;
      }

      if (!state.inFlight) {
        if (state.nextIndex >= queue.length) {
          state.status = "completed";
          await persistState();
          return;
        }
        await sendNextPrompt();
        return;
      }

      const generating = isGenerating();
      if (generating) {
        state.inFlight.sawGenerating = true;
        state.inFlight.idleSince = null;
        return;
      }

      const responseAge = Date.now() - state.inFlight.sentAt;
      const assistantAppeared = getAssistantCount() > state.inFlight.assistantCountBefore;
      const hasResponseEvidence = state.inFlight.sawGenerating || assistantAppeared;

      if (responseAge < MIN_RESPONSE_AGE_MS || !hasResponseEvidence || !getComposer()) {
        return;
      }

      if (!state.inFlight.idleSince) {
        state.inFlight.idleSince = Date.now();
        await persistState();
        return;
      }

      const stableFor = Date.now() - state.inFlight.idleSince;
      if (stableFor >= config.delaySeconds * 1000) await finishInFlight();
    } catch (error) {
      await pause(error.message || "Terjadi kesalahan");
    } finally {
      tickLocked = false;
    }
  }

  function ensureWidget() {
    if (widget?.isConnected) return widget;

    widget = document.createElement("div");
    widget.id = "cqr-widget-host";
    widget.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;";
    const shadow = widget.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .box{display:flex;align-items:center;gap:9px;max-width:330px;padding:9px 10px 9px 12px;border:1px solid rgba(255,255,255,.14);border-radius:13px;background:#17221d;color:#f8f5ec;box-shadow:0 10px 28px rgba(0,0,0,.22);font:600 12px/1.25 ui-sans-serif,system-ui,sans-serif}
        .dot{width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:#44bf8b;box-shadow:0 0 0 3px rgba(68,191,139,.18)}
        .dot.paused{background:#e0a04f;box-shadow:0 0 0 3px rgba(224,160,79,.18)}
        .copy{min-width:0;flex:1}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{margin-top:2px;color:#b9c3bd;font-size:10px;font-weight:500}
        button{padding:5px 8px;border:1px solid rgba(255,255,255,.18);border-radius:7px;background:transparent;color:#f8f5ec;font:700 10px ui-sans-serif,system-ui,sans-serif;cursor:pointer}
        button:hover{background:rgba(255,255,255,.1)}
      </style>
      <div class="box">
        <span class="dot"></span>
        <div class="copy"><div class="title"></div><div class="meta"></div></div>
        <button type="button">Jeda</button>
      </div>`;
    shadow.querySelector("button").addEventListener("click", () => pause("Dijeda dari halaman"));
    document.documentElement.appendChild(widget);
    return widget;
  }

  function renderWidget() {
    if (state.status === "idle" || state.ownerTabId !== localTabId) {
      widget?.remove();
      widget = null;
      return;
    }

    const host = ensureWidget();
    const shadow = host.shadowRoot;
    const dot = shadow.querySelector(".dot");
    const title = shadow.querySelector(".title");
    const meta = shadow.querySelector(".meta");
    const button = shadow.querySelector("button");

    dot.classList.toggle("paused", state.status !== "running");
    if (state.status === "running") {
      title.textContent = state.inFlight
        ? `${RUNNER_NAME}: menunggu jawaban selesai`
        : `${RUNNER_NAME}: menyiapkan prompt berikutnya`;
      button.hidden = false;
    } else if (state.status === "completed") {
      title.textContent = `${RUNNER_NAME}: semua pekerjaan selesai`;
      button.hidden = true;
    } else {
      title.textContent = `${RUNNER_NAME}: ${state.pausedReason || "antrean dijeda"}`;
      button.hidden = true;
    }
    meta.textContent = `${state.completedCount} dari ${state.totalCount} selesai`;
  }

  async function start(newQueue, newConfig, ownerTabId) {
    if (!Array.isArray(newQueue) || !newQueue.length) throw new Error("Antrean kosong");
    if (newQueue.length > newConfig.maxItems) throw new Error("Jumlah pekerjaan melebihi batas sesi");
    if (!Number.isInteger(ownerTabId) || ownerTabId !== localTabId) throw new Error("Identitas tab ChatGPT tidak valid");

    queue = newQueue;
    config = { ...DEFAULT_CONFIG, ...newConfig };
    composerMissingSince = null;
    pendingReplacement = null;
    state = {
      status: "running",
      nextIndex: 0,
      completedCount: 0,
      totalCount: queue.length,
      inFlight: null,
      pausedReason: null,
      ownerTabId,
      updatedAt: Date.now()
    };

    if (isGenerating()) {
      state.inFlight = {
        external: true,
        queueIndex: null,
        sentAt: Date.now(),
        assistantCountBefore: Math.max(0, getAssistantCount() - 1),
        sawGenerating: true,
        idleSince: null
      };
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.queue]: queue,
      [STORAGE_KEYS.config]: config,
      [STORAGE_KEYS.state]: state
    });
    await chrome.storage.local.remove(STORAGE_KEYS.pendingReplacement);
    renderWidget();
    void processTick();
  }

  async function resume(newQueue, newConfig, ownerTabId) {
    if (state.ownerTabId !== ownerTabId) {
      throw new Error("Antrean ini berjalan di tab ChatGPT lain");
    }
    queue = newQueue;
    config = { ...DEFAULT_CONFIG, ...newConfig };
    composerMissingSince = null;
    state.status = "running";
    state.pausedReason = null;
    state.totalCount = queue.length;
    await chrome.storage.local.set({
      [STORAGE_KEYS.queue]: queue,
      [STORAGE_KEYS.config]: config,
      [STORAGE_KEYS.state]: state
    });
    renderWidget();
    void processTick();
  }

  function launcherAssignment() {
    const url = new URL(window.location.href);
    const runner = url.searchParams.get("cqr_runner");
    const port = Number.parseInt(url.searchParams.get("cqr_port") || "", 10);
    if (!runner || !Number.isInteger(port)) return null;
    return { runner: runner.padStart(2, "0"), port, url };
  }

  function clearLauncherParameters(url) {
    url.searchParams.delete("cqr_runner");
    url.searchParams.delete("cqr_port");
    window.history.replaceState(window.history.state, "", url.toString());
  }

  async function showLauncherError(reason) {
    state = makeIdleState();
    state.status = "paused";
    state.pausedReason = reason;
    state.ownerTabId = localTabId;
    await persistState();
  }

  async function startFromLauncherIfAssigned() {
    const assignment = launcherAssignment();
    if (!assignment || assignment.runner !== RUNNER_NUMBER) return false;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "CQR_GET_LAUNCHER_QUEUE",
        runner: RUNNER_NUMBER,
        port: assignment.port
      });
      if (!response?.ok) throw new Error(response?.error || "Antrean launcher tidak tersedia");

      const newQueue = Array.isArray(response.payload?.queue)
        ? response.payload.queue.map((item) => String(item).trim()).filter(Boolean)
        : [];
      const newConfig = {
        delaySeconds: Number.parseInt(response.payload?.config?.delaySeconds, 10),
        maxItems: DEFAULT_CONFIG.maxItems
      };

      if (!newQueue.length) throw new Error(`File runner-${RUNNER_NUMBER}.txt kosong`);
      if (newQueue.length > DEFAULT_CONFIG.maxItems) {
        throw new Error(`Runner ${RUNNER_NUMBER} melebihi ${DEFAULT_CONFIG.maxItems} prompt`);
      }
      if (!Number.isInteger(newConfig.delaySeconds)) {
        newConfig.delaySeconds = DEFAULT_CONFIG.delaySeconds;
      }
      newConfig.delaySeconds = Math.min(60, Math.max(3, newConfig.delaySeconds));

      clearLauncherParameters(assignment.url);
      await start(newQueue, newConfig, localTabId);
      return true;
    } catch (error) {
      await showLauncherError(`Launcher: ${error.message || "gagal memuat antrean"}`);
      return true;
    }
  }

  async function pollContinueLauncher() {
    if (
      continuePollLocked ||
      localTabId === null ||
      state.ownerTabId !== localTabId ||
      state.status === "running" ||
      !queue.length
    ) return;

    continuePollLocked = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CQR_GET_CONTINUE_QUEUE",
        runner: RUNNER_NUMBER
      });
      if (!response?.ok || !response.payload) return;

      const newQueue = Array.isArray(response.payload.queue)
        ? response.payload.queue.map((item) => String(item).trim()).filter(Boolean)
        : [];
      if (!newQueue.length || newQueue.length > DEFAULT_CONFIG.maxItems) return;

      const newConfig = {
        delaySeconds: Number.parseInt(response.payload.config?.delaySeconds, 10),
        maxItems: DEFAULT_CONFIG.maxItems
      };
      if (!Number.isInteger(newConfig.delaySeconds)) {
        newConfig.delaySeconds = DEFAULT_CONFIG.delaySeconds;
      }
      newConfig.delaySeconds = Math.min(60, Math.max(3, newConfig.delaySeconds));

      if (state.status === "paused" && queuesMatch(newQueue, queue)) {
        await resume(newQueue, newConfig, localTabId);
      } else {
        await start(newQueue, newConfig, localTabId);
      }
    } catch (_error) {
      // Server lanjutan hanya aktif saat CMD dijalankan; koneksi gagal adalah normal.
    } finally {
      continuePollLocked = false;
    }
  }

  function normalizeReplacementPayload(payload) {
    const newQueue = Array.isArray(payload?.queue)
      ? payload.queue.map((item) => String(item).trim()).filter(Boolean)
      : [];
    if (!newQueue.length || newQueue.length > DEFAULT_CONFIG.maxItems) return null;

    const delaySeconds = Number.parseInt(payload?.config?.delaySeconds, 10);
    return {
      queue: newQueue,
      config: {
        delaySeconds: Number.isInteger(delaySeconds)
          ? Math.min(60, Math.max(3, delaySeconds))
          : DEFAULT_CONFIG.delaySeconds,
        maxItems: DEFAULT_CONFIG.maxItems
      }
    };
  }

  async function applyPendingReplacementIfSafe(insideTick = false) {
    if (
      !pendingReplacement ||
      (!insideTick && tickLocked) ||
      state.inFlight ||
      isGenerating()
    ) return false;

    const replacement = pendingReplacement;
    pendingReplacement = null;
    await chrome.storage.local.remove(STORAGE_KEYS.pendingReplacement);
    await start(replacement.queue, replacement.config, localTabId);
    return true;
  }

  async function pollReplaceLauncher() {
    if (
      replacePollLocked ||
      localTabId === null ||
      state.ownerTabId !== localTabId ||
      !queue.length ||
      pendingReplacement
    ) return;

    replacePollLocked = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CQR_GET_REPLACE_QUEUE",
        runner: RUNNER_NUMBER
      });
      if (!response?.ok || !response.payload) return;

      const replacement = normalizeReplacementPayload(response.payload);
      if (!replacement) return;

      pendingReplacement = replacement;
      await chrome.storage.local.set({
        [STORAGE_KEYS.pendingReplacement]: pendingReplacement
      });
      await applyPendingReplacementIfSafe();
    } catch (_error) {
      // Server penggantian hanya aktif saat CMD dijalankan.
    } finally {
      replacePollLocked = false;
    }
  }

  const ready = Promise.all([
    chrome.runtime.sendMessage({ type: "CQR_GET_TAB_ID" }),
    chrome.storage.local.get(Object.values(STORAGE_KEYS))
  ]).then(async ([tabInfo, stored]) => {
    localTabId = tabInfo?.tabId ?? null;
    queue = Array.isArray(stored[STORAGE_KEYS.queue]) ? stored[STORAGE_KEYS.queue] : [];
    config = { ...DEFAULT_CONFIG, ...(stored[STORAGE_KEYS.config] || {}) };
    state = stored[STORAGE_KEYS.state] || makeIdleState();
    pendingReplacement = stored[STORAGE_KEYS.pendingReplacement] || null;
    renderWidget();
    const handledByLauncher = await startFromLauncherIfAssigned();
    const canRecoverComposerPause =
      state.status === "paused" &&
      state.pausedReason === "Kotak prompt ChatGPT tidak ditemukan" &&
      state.ownerTabId === localTabId &&
      queue.length > 0;

    if (!handledByLauncher && canRecoverComposerPause) {
      state.status = "running";
      state.pausedReason = null;
      await persistState();
      void processTick();
    } else if (!handledByLauncher && state.status === "running") {
      void processTick();
    }
    void pollContinueLauncher();
    void pollReplaceLauncher();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      await ready;
      if (message.type === "CQR_START") await start(message.queue, message.config, message.targetTabId);
      if (message.type === "CQR_RESUME") await resume(message.queue, message.config, message.targetTabId);
      if (message.type === "CQR_PAUSE") {
        if (state.ownerTabId !== message.targetTabId) throw new Error("Antrean ini berjalan di tab ChatGPT lain");
        await pause("Dijeda oleh pengguna");
      }
      if (message.type === "CQR_RESET") {
        state = makeIdleState();
        await persistState();
      }
      sendResponse({ ok: true, state: publicState() });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEYS.state]) return;
    state = changes[STORAGE_KEYS.state].newValue || makeIdleState();
    renderWidget();
  });

  setInterval(() => void processTick(), POLL_INTERVAL_MS);
  setInterval(() => void pollContinueLauncher(), CONTINUE_POLL_INTERVAL_MS);
  setInterval(() => void pollReplaceLauncher(), CONTINUE_POLL_INTERVAL_MS);
})();
