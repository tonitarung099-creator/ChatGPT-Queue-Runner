(() => {
  'use strict';
  if (globalThis.__CHAT_QUEUE_RUNNER_V2_LOADED__) return;
  globalThis.__CHAT_QUEUE_RUNNER_V2_LOADED__ = true;

  const Core = globalThis.CQRCore;
  if (!Core) throw new Error('CQRCore tidak dimuat');

  const STORAGE_KEYS = {
    queue: 'cqr_queue',
    config: 'cqr_config',
    state: 'cqr_state',
    draft: 'cqr_draft',
    pendingReplacement: 'cqr_pending_replacement'
  };

  const RUNNER_NAME = chrome.runtime.getManifest().name;
  const RUNNER_NUMBER = RUNNER_NAME.match(/\d+$/)?.[0] || '';
  const POLL_INTERVAL_MS = 1000;
  const LAUNCHER_POLL_INTERVAL_MS = 4000;
  const SEND_BUTTON_TIMEOUT_MS = 5000;
  const SEND_ACCEPT_TIMEOUT_MS = 12000;
  const NO_RESPONSE_RECONCILE_MS = 90000;
  const COMPOSER_MISSING_RECONCILE_MS = 60000;
  const STABLE_RESPONSE_MS = 15000;
  const LEASE_STALE_MS = 600000;

  let queue = [];
  let config = Core.normalizeConfig({});
  let state = Core.makeIdleState();
  let pendingReplacement = null;
  let localTabId = null;
  let tickLocked = false;
  let continuePollLocked = false;
  let replacePollLocked = false;
  let operationEpoch = 0;
  let widget = null;
  let composerMissingSince = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const now = () => Date.now();

  function pauseReason(code, message) {
    return { code, message: message || code };
  }

  function stateToken() {
    return { runId: state.runId, revision: state.revision, ownerTabId: state.ownerTabId, epoch: operationEpoch };
  }

  function tokenMatches(token, requireRunning = false) {
    if (!token) return false;
    if (token.epoch !== operationEpoch || token.runId !== state.runId || token.revision !== state.revision) return false;
    if (token.ownerTabId !== state.ownerTabId) return false;
    if (requireRunning && (state.status !== 'running' || state.ownerTabId !== localTabId)) return false;
    return true;
  }

  function bumpRevision() {
    state.revision = (Number.parseInt(state.revision, 10) || 0) + 1;
    operationEpoch += 1;
  }

  async function persistState() {
    state.updatedAt = now();
    await chrome.storage.local.set({ [STORAGE_KEYS.state]: clone(state) });
    renderWidget();
  }

  async function persistSnapshot() {
    state.updatedAt = now();
    await chrome.storage.local.set({
      [STORAGE_KEYS.queue]: clone(queue),
      [STORAGE_KEYS.config]: clone(config),
      [STORAGE_KEYS.state]: clone(state)
    });
    renderWidget();
  }

  function publicState() {
    return clone(state);
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  }

  function firstVisible(selectors, root = document) {
    for (const selector of selectors) {
      const match = [...root.querySelectorAll(selector)].find(isVisible);
      if (match) return match;
    }
    return null;
  }

  function elementText(element) {
    if (!element) return '';
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value || '';
    return element.innerText || element.textContent || '';
  }

  function getComposer() {
    return firstVisible([
      "#prompt-textarea[contenteditable='true']",
      "textarea[name='prompt-textarea']",
      "textarea[data-testid='prompt-textarea']",
      "form[data-chatgpt-composer] [contenteditable='true'][role='textbox']",
      "form[data-chatgpt-composer] .ProseMirror[contenteditable='true']",
      "div[contenteditable='true'][data-lexical-editor='true']",
      "main div[contenteditable='true'][role='textbox']"
    ]);
  }

  function getSendButton() {
    return firstVisible([
      "button[data-testid='send-button']",
      '#composer-submit-button',
      "form[data-chatgpt-composer] button[type='submit']",
      "button[aria-label='Send prompt']",
      "button[aria-label='Kirim prompt']",
      "button[aria-label='Send message']",
      "button[aria-label='Kirim pesan']"
    ]);
  }

  function isSendButtonReady() {
    const button = getSendButton();
    return Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
  }

  function getStopButton() {
    return firstVisible([
      "button[data-testid='stop-button']",
      "button[aria-label*='Stop streaming' i]",
      "button[aria-label*='Stop generating' i]",
      "button[aria-label*='Hentikan' i]"
    ]);
  }

  function isGenerating() {
    if (getStopButton()) return true;
    return Boolean(firstVisible([
      "section[data-turn='assistant'][aria-busy='true']",
      "[data-message-author-role='assistant'][aria-busy='true']",
      "[data-turn='assistant'] [aria-busy='true']"
    ]));
  }

  function getTurns(role) {
    const selectors = role === 'assistant' ? [
      "section[data-turn='assistant']",
      "[data-testid^='conversation-turn-'][data-turn='assistant']",
      "[data-testid^='conversation-turn-'][data-message-author-role='assistant']",
      "[data-turn-key]:has([data-conversation-role='assistant'])",
      "[data-message-author-role='assistant']"
    ] : [
      "section[data-turn='user']",
      "[data-testid^='conversation-turn-'][data-turn='user']",
      "[data-testid^='conversation-turn-'][data-message-author-role='user']",
      "[data-turn-key]:has([data-user-message-bubble])",
      "[data-message-author-role='user']"
    ];
    for (const selector of selectors) {
      const matches = [...document.querySelectorAll(selector)];
      if (matches.length) return matches;
    }
    return [];
  }

  function turnIdentity(turn, role, index) {
    if (!turn) return null;
    const stable = turn.getAttribute?.('data-testid') || turn.getAttribute?.('data-turn-key') || turn.id;
    return stable || `${role}:${index}`;
  }

  function turnSnapshot(role) {
    return getTurns(role).map((turn, index) => turnIdentity(turn, role, index));
  }

  function turnBodyText(turn, role) {
    if (!turn) return '';
    const selector = role === 'assistant'
      ? "[data-message-author-role='assistant'], [data-conversation-role='assistant']"
      : "[data-message-author-role='user'], [data-user-message-bubble]";
    const body = turn.querySelector?.(selector) || turn;
    return Core.normalizeText(elementText(body));
  }

  function findTurnByIdentity(role, identity) {
    if (!identity) return null;
    const turns = getTurns(role);
    return turns.find((turn, index) => turnIdentity(turn, role, index) === identity) || null;
  }

  function findAcceptedUserTurn(attempt, prompt) {
    const baseline = new Set(attempt.userTurnIdsBefore || []);
    const normalizedPrompt = Core.normalizeText(prompt);
    const turns = getTurns('user');
    let unmatchedNew = false;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      const id = turnIdentity(turn, 'user', index);
      if (baseline.has(id)) continue;
      const text = turnBodyText(turn, 'user');
      if (text === normalizedPrompt || text.startsWith(`${normalizedPrompt} `)) return { id, turn };
      unmatchedNew = true;
    }
    return { id: null, turn: null, unmatchedNew };
  }

  function findResponseTurn(attempt) {
    if (!attempt) return null;
    if (attempt.responseTurnId) {
      const stored = findTurnByIdentity('assistant', attempt.responseTurnId);
      if (stored) return stored;
    }
    const baseline = new Set(attempt.assistantTurnIdsBefore || []);
    const assistants = getTurns('assistant');
    const userTurn = findTurnByIdentity('user', attempt.userTurnId);
    for (let index = 0; index < assistants.length; index += 1) {
      const assistant = assistants[index];
      const id = turnIdentity(assistant, 'assistant', index);
      if (baseline.has(id)) continue;
      if (!userTurn) return assistant;
      const relation = userTurn.compareDocumentPosition(assistant);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return assistant;
    }
    return null;
  }

  function hasRealCompletionAction(turn) {
    if (!turn) return false;
    return [...turn.querySelectorAll("button[data-testid='copy-turn-action-button'], [data-testid*='copy-turn-action'], .turn-action-controls button")]
      .some((button) => !button.hasAttribute('data-cqr-interrupted-completion'));
  }

  function relevantButtonLabel(button) {
    return Core.normalizeText(`${button?.textContent || ''} ${button?.getAttribute?.('aria-label') || ''}`);
  }

  function activeButtons(attempt) {
    const result = [];
    const seen = new Set();
    const addFrom = (root) => {
      if (!root) return;
      for (const button of root.querySelectorAll?.('button') || []) {
        if (!isVisible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
        if (seen.has(button)) continue;
        seen.add(button);
        result.push(button);
      }
    };
    for (const dialog of document.querySelectorAll("[role='dialog']")) if (isVisible(dialog)) addFrom(dialog);
    addFrom(findResponseTurn(attempt));
    const userTurn = findTurnByIdentity('user', attempt?.userTurnId);
    if (userTurn) {
      for (const button of document.querySelectorAll('main button')) {
        if (!isVisible(button) || seen.has(button)) continue;
        const relation = userTurn.compareDocumentPosition(button);
        if (relation & Node.DOCUMENT_POSITION_FOLLOWING) {
          seen.add(button);
          result.push(button);
        }
      }
    }
    return result;
  }

  function getBlockingSignal(attempt) {
    for (const button of activeButtons(attempt)) {
      if (Core.classifyActionLabel(relevantButtonLabel(button)) === 'approval') {
        return { type: 'approval', message: 'ChatGPT meminta izin atau konfirmasi pengguna' };
      }
    }

    const visibleStatus = [...document.querySelectorAll("[role='alert'], [role='dialog']")]
      .filter(isVisible)
      .map((node) => Core.normalizeText(elementText(node)))
      .join(' ');
    if (/\b(rate limit|too many requests|try again later|sign in|log in|masuk untuk melanjutkan|terlalu banyak permintaan|unusual activity|capacity)\b/i.test(visibleStatus)) {
      return { type: 'blocked', message: 'ChatGPT belum siap (login/rate limit/layanan); antrean dijeda' };
    }
    return null;
  }

  function getTerminalSignal(attempt) {
    const responseTurn = findResponseTurn(attempt);
    const buttons = activeButtons(attempt);
    for (const button of buttons) {
      const type = Core.classifyActionLabel(relevantButtonLabel(button));
      if (type === 'interrupted') return { outcome: 'interrupted', reason: 'Jawaban ChatGPT terhenti' };
      if (type === 'failed') return { outcome: 'failed', reason: 'ChatGPT menampilkan kegagalan/Try again' };
    }

    const alertText = [...document.querySelectorAll("[role='alert']")]
      .filter(isVisible)
      .map((node) => Core.normalizeText(elementText(node)))
      .join(' ');
    if (/\b(something went wrong|network error|error occurred|terjadi kesalahan|koneksi terputus|gagal menghasilkan)\b/i.test(alertText)) {
      return { outcome: 'failed', reason: 'ChatGPT menampilkan kesalahan' };
    }
    if (responseTurn && hasRealCompletionAction(responseTurn)) return { outcome: 'completed', reason: 'Jawaban selesai' };
    return null;
  }

  function sharedTabToken() {
    const root = document.documentElement;
    let token = root.getAttribute('data-cqr-tab-token');
    if (!token) {
      token = Core.randomId('tab');
      root.setAttribute('data-cqr-tab-token', token);
    }
    return root.getAttribute('data-cqr-tab-token') || token;
  }

  function leaseIdentity(runId = state.runId, leaseToken = state.leaseToken) {
    return `${RUNNER_NUMBER}:${runId || ''}:${leaseToken || ''}`;
  }

  function parseLease() {
    const raw = document.documentElement.getAttribute('data-cqr-owner');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_error) { return null; }
  }

  async function withLeaseMutex(callback) {
    const locks = navigator.locks;
    if (!locks?.request) return callback();
    const name = `cqr-lease:${location.origin}:${sharedTabToken()}`;
    let result = false;
    await locks.request(name, { ifAvailable: true, mode: 'exclusive' }, async (lock) => {
      if (!lock) return;
      result = await callback();
    });
    return result;
  }

  async function claimOrRefreshLease(runId = state.runId, leaseToken = state.leaseToken) {
    if (!runId || !leaseToken) return false;
    return withLeaseMutex(async () => {
      const current = parseLease();
      const mine = leaseIdentity(runId, leaseToken);
      if (current && current.identity !== mine && current.runner !== RUNNER_NUMBER && now() - Number(current.updatedAt || 0) < LEASE_STALE_MS) return false;
      document.documentElement.setAttribute('data-cqr-owner', JSON.stringify({
        identity: mine,
        runner: RUNNER_NUMBER,
        runId,
        leaseToken,
        updatedAt: now()
      }));
      return true;
    });
  }

  async function releaseLease() {
    await withLeaseMutex(async () => {
      const current = parseLease();
      if (current?.identity === leaseIdentity()) document.documentElement.removeAttribute('data-cqr-owner');
      return true;
    });
  }

  async function withSendLock(callback) {
    const locks = navigator.locks;
    if (!locks?.request) return callback();
    const name = `cqr-send:${location.origin}:${sharedTabToken()}`;
    let result = { acquired: false };
    await locks.request(name, { ifAvailable: true, mode: 'exclusive' }, async (lock) => {
      if (!lock) return;
      result = { acquired: true, value: await callback() };
    });
    return result;
  }

  function currentConversation() {
    return Core.conversationIdentity(window.location.href);
  }

  async function ensureConversation() {
    if (!state.conversationIdentity) return true;
    const current = currentConversation();
    const canBind = Boolean(state.conversationIdentity.isNew && state.activeAttempt?.acceptedAt);
    const result = Core.reconcileConversation(state.conversationIdentity, current, canBind);
    if (!result.ok) {
      await pauseSession('conversation-changed', `${result.reason}; kembali ke percakapan awal lalu klik Lanjutkan.`);
      return false;
    }
    if (result.bind?.key !== state.conversationIdentity.key) {
      state.conversationIdentity = result.bind;
      await persistState();
    }
    return true;
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor?.set?.call(element, value);
  }

  function setComposerText(composer, prompt) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      setNativeValue(composer, prompt);
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, prompt);
    if (Core.normalizeText(elementText(composer)) !== Core.normalizeText(prompt)) composer.textContent = prompt;
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  }

  function clearComposerIfMatchesPrompt(prompt) {
    const composer = getComposer();
    if (!composer || Core.normalizeText(elementText(composer)) !== Core.normalizeText(prompt)) return false;
    setComposerText(composer, '');
    return true;
  }

  async function waitForSendButton(token) {
    const started = now();
    while (now() - started < SEND_BUTTON_TIMEOUT_MS) {
      if (!tokenMatches(token, true)) return null;
      const button = getSendButton();
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') return button;
      await sleep(100);
    }
    return null;
  }

  async function waitForAcceptance(token, attempt, prompt) {
    const started = now();
    while (now() - started < SEND_ACCEPT_TIMEOUT_MS) {
      if (!tokenMatches(token, true)) return { cancelled: true };
      const accepted = findAcceptedUserTurn(attempt, prompt);
      if (accepted.id) return { accepted: true, userTurnId: accepted.id };
      const newAssistant = turnSnapshot('assistant').some((id) => !(attempt.assistantTurnIdsBefore || []).includes(id));
      if (accepted.unmatchedNew || newAssistant || isGenerating()) {
        attempt.ambiguousEvidence = true;
      }
      await sleep(150);
    }
    const accepted = findAcceptedUserTurn(attempt, prompt);
    if (accepted.id) return { accepted: true, userTurnId: accepted.id };
    return { accepted: false, ambiguous: Boolean(attempt.ambiguousEvidence || attempt.clickedAt) };
  }

  async function pauseSession(code, message, bump = true) {
    if (bump) bumpRevision();
    state.status = 'paused';
    state.phase = 'paused';
    state.pauseReason = pauseReason(code, message);
    await persistState();
  }

  async function acceptAttempt(attempt, userTurnId) {
    if (state.activeAttempt?.attemptId !== attempt.attemptId) return;
    attempt.stage = 'awaiting-response';
    attempt.acceptedAt = attempt.acceptedAt || now();
    attempt.userTurnId = userTurnId;
    attempt.lastActivityAt = now();
    state.nextIndex = Math.max(state.nextIndex, attempt.queueIndex + 1);
    state.phase = 'awaiting-response';
    await persistState();
  }

  async function recordOutcome(status, reason) {
    const attempt = state.activeAttempt;
    if (!attempt) return;
    if (!state.outcomes.some((item) => item.itemId === attempt.itemId)) {
      state.outcomes.push({
        queueIndex: attempt.queueIndex,
        itemId: attempt.itemId,
        status,
        reason,
        finishedAt: now()
      });
    }
    Core.syncOutcomeCounters(state);
    state.activeAttempt = null;
    composerMissingSince = null;
    if (state.nextIndex >= queue.length && state.processedCount >= queue.length) {
      state.status = 'completed';
      state.phase = 'completed';
      state.delayUntil = null;
      state.pauseReason = null;
      await persistState();
      await releaseLease();
      return;
    }
    state.phase = 'waiting-delay';
    state.delayUntil = now() + config.delaySeconds * 1000;
    await persistState();
  }

  async function sendNextPrompt() {
    if (state.status !== 'running' || state.activeAttempt || state.nextIndex >= queue.length) return;
    const leaseOk = await claimOrRefreshLease();
    if (!leaseOk) {
      await pauseSession('runner-conflict', 'Tab ini sedang dipakai Runner lain. Gunakan tab ChatGPT berbeda atau Reset runner lain.');
      return;
    }

    const lockResult = await withSendLock(async () => {
      const token = stateToken();
      if (!tokenMatches(token, true)) return;
      if (!(await ensureConversation())) return;
      if (isGenerating()) {
        await pauseSession('external-generation', 'ChatGPT sedang menghasilkan jawaban lain. Tunggu selesai lalu klik Lanjutkan.');
        return;
      }

      const composer = getComposer();
      if (!composer) throw new Error('Kotak prompt ChatGPT tidak ditemukan');
      const existingDraft = Core.normalizeText(elementText(composer));
      if (existingDraft) {
        await pauseSession('manual-draft', 'Kotak prompt berisi draf pengguna. Draf tidak ditimpa; kosongkan/kirim draf lalu klik Lanjutkan.');
        return;
      }

      const queueIndex = state.nextIndex;
      const prompt = queue[queueIndex];
      const attempt = {
        itemId: `${state.runId}:${queueIndex}`,
        attemptId: Core.randomId('attempt'),
        queueIndex,
        promptFingerprint: Core.fingerprint(prompt),
        stage: 'preparing',
        createdAt: now(),
        clickedAt: null,
        acceptedAt: null,
        userTurnIdsBefore: turnSnapshot('user'),
        assistantTurnIdsBefore: turnSnapshot('assistant'),
        userTurnId: null,
        responseTurnId: null,
        sawGenerating: false,
        lastResponseText: '',
        stableSince: null,
        lastActivityAt: now(),
        ambiguousEvidence: false
      };
      state.activeAttempt = attempt;
      state.phase = 'preparing';
      await persistState();
      if (!tokenMatches(token, true) || state.activeAttempt?.attemptId !== attempt.attemptId) return;

      setComposerText(composer, prompt);
      if (Core.normalizeText(elementText(composer)) !== Core.normalizeText(prompt)) {
        await pauseSession('composer-write-failed', 'Prompt gagal dimasukkan persis ke kotak ChatGPT.');
        return;
      }

      const sendButton = await waitForSendButton(token);
      if (!sendButton) {
        if (!tokenMatches(token, true)) return;
        await pauseSession('send-button-unavailable', 'Tombol kirim ChatGPT tidak aktif; antrean dijeda.');
        return;
      }
      if (!tokenMatches(token, true)) return;
      if (Core.normalizeText(elementText(composer)) !== Core.normalizeText(prompt)) {
        await pauseSession('draft-changed', 'Isi kotak prompt berubah sebelum dikirim. Runner tidak mengirim teks yang berubah.');
        return;
      }

      attempt.stage = 'sending';
      state.phase = 'sending';
      await persistState(); // journal intent BEFORE click
      if (!tokenMatches(token, true)) return;

      sendButton.click();
      attempt.clickedAt = now();
      attempt.stage = 'awaiting-acceptance';
      state.phase = 'awaiting-acceptance';
      try { await persistState(); } catch (_error) { /* sending intent was already durable before click */ }

      const acceptance = await waitForAcceptance(token, attempt, prompt);
      if (acceptance.cancelled || !tokenMatches(token, true)) return;
      if (acceptance.accepted) {
        await acceptAttempt(attempt, acceptance.userTurnId);
        return;
      }
      await pauseSession(
        'send-ambiguous',
        'Prompt mungkin sudah terkirim tetapi belum dapat dipastikan. Runner dijeda agar tidak mengirim prompt ganda.'
      );
    });

    if (!lockResult.acquired && state.status === 'running') return;
  }

  async function reconcilePreAcceptanceAttempt() {
    const attempt = state.activeAttempt;
    if (!attempt || attempt.acceptedAt) return true;
    const prompt = queue[attempt.queueIndex];
    if (!prompt || Core.fingerprint(prompt) !== attempt.promptFingerprint) {
      await pauseSession('queue-mismatch', 'Antrean aktif berubah; pengiriman tidak dapat direkonsiliasi.');
      return false;
    }
    const accepted = findAcceptedUserTurn(attempt, prompt);
    if (accepted.id) {
      await acceptAttempt(attempt, accepted.id);
      return true;
    }
    if (attempt.stage === 'preparing' && !attempt.clickedAt) {
      await pauseSession('prepared-recovery', 'Runner dimuat ulang sebelum klik kirim. Klik Lanjutkan untuk mengulang tahap aman ini.');
      return false;
    }
    await pauseSession('send-ambiguous', 'Status pengiriman sebelumnya tidak pasti. Runner tidak akan mengirim ulang otomatis.');
    return false;
  }

  async function monitorActiveAttempt() {
    const attempt = state.activeAttempt;
    if (!attempt) return;
    if (!attempt.acceptedAt) {
      await reconcilePreAcceptanceAttempt();
      return;
    }

    const blocker = getBlockingSignal(attempt);
    if (blocker?.type === 'approval') {
      await pauseSession('awaiting-user', blocker.message);
      return;
    }
    if (blocker?.type === 'blocked') {
      await pauseSession('service-blocked', blocker.message);
      return;
    }

    const generating = isGenerating();
    if (generating) {
      const changed = !attempt.sawGenerating;
      attempt.sawGenerating = true;
      attempt.stage = 'generating';
      state.phase = 'generating';
      attempt.lastActivityAt = now();
      attempt.stableSince = null;
      if (changed) await persistState();
      return;
    }

    const terminal = getTerminalSignal(attempt);
    if (terminal) {
      await recordOutcome(terminal.outcome, terminal.reason);
      return;
    }

    const responseTurn = findResponseTurn(attempt);
    if (responseTurn) {
      const responseId = turnIdentity(responseTurn, 'assistant', getTurns('assistant').indexOf(responseTurn));
      if (responseId && responseId !== attempt.responseTurnId) {
        attempt.responseTurnId = responseId;
        attempt.lastActivityAt = now();
        await persistState();
      }
      const text = turnBodyText(responseTurn, 'assistant');
      if (text !== attempt.lastResponseText) {
        attempt.lastResponseText = text;
        attempt.lastActivityAt = now();
        attempt.stableSince = text ? now() : null;
        return;
      }
      if (text && !attempt.stableSince) attempt.stableSince = now();
      if (text && attempt.stableSince && now() - attempt.stableSince >= STABLE_RESPONSE_MS && isSendButtonReady()) {
        await recordOutcome('completed', 'Jawaban stabil dan composer kembali siap');
        return;
      }
    }

    if (!getComposer()) {
      if (!composerMissingSince) composerMissingSince = now();
      if (now() - composerMissingSince >= COMPOSER_MISSING_RECONCILE_MS) {
        await pauseSession('composer-missing', 'Kotak prompt hilang terlalu lama; status jawaban perlu diperiksa sebelum lanjut.');
      }
      return;
    }
    composerMissingSince = null;

    if (!responseTurn && !attempt.sawGenerating && now() - attempt.acceptedAt >= NO_RESPONSE_RECONCILE_MS && isSendButtonReady()) {
      await pauseSession('response-unknown', 'Prompt diterima, tetapi jawaban tidak terdeteksi. Periksa ChatGPT lalu klik Lanjutkan; runner tidak akan menebak sukses/gagal.');
    }
  }

  async function applyPendingReplacementIfSafe() {
    if (!pendingReplacement || state.status !== 'running' || state.activeAttempt || isGenerating() || state.delayUntil) return false;
    const replacement = pendingReplacement;
    pendingReplacement = null;
    await chrome.storage.local.remove(STORAGE_KEYS.pendingReplacement);
    await startSession(replacement.queue, replacement.config, localTabId, { fromReplacement: true });
    return true;
  }

  async function processTick() {
    if (tickLocked || localTabId === null || state.ownerTabId !== localTabId) return;
    tickLocked = true;
    try {
      if (state.status !== 'running') return;
      if (!(await claimOrRefreshLease())) {
        await pauseSession('runner-conflict', 'Runner lain sudah menguasai tab/percakapan ini.');
        return;
      }
      if (!(await ensureConversation())) return;

      if (state.activeAttempt) {
        await monitorActiveAttempt();
        return;
      }

      const blocker = getBlockingSignal(null);
      if (blocker?.type === 'approval') {
        await pauseSession('awaiting-user', blocker.message);
        return;
      }
      if (blocker?.type === 'blocked') {
        await pauseSession('service-blocked', blocker.message);
        return;
      }

      if (state.delayUntil) {
        if (now() < state.delayUntil) return;
        state.delayUntil = null;
        state.phase = 'preparing';
        await persistState();
      }

      if (await applyPendingReplacementIfSafe()) return;
      if (state.nextIndex >= queue.length) {
        state.status = 'completed';
        state.phase = 'completed';
        await persistState();
        await releaseLease();
        return;
      }
      if (isGenerating()) {
        await pauseSession('external-generation', 'Ada jawaban ChatGPT yang bukan milik item aktif. Tunggu selesai lalu klik Lanjutkan.');
        return;
      }
      await sendNextPrompt();
    } catch (error) {
      if (state.status === 'running') await pauseSession('runtime-error', error?.message || 'Terjadi kesalahan pada runner');
    } finally {
      tickLocked = false;
    }
  }

  async function startSession(newQueue, newConfig, ownerTabId, options = {}) {
    const normalizedQueue = Core.normalizeQueue(newQueue);
    const normalizedConfig = Core.normalizeConfig(newConfig);
    if (!Number.isInteger(ownerTabId) || ownerTabId !== localTabId) throw new Error('Identitas tab ChatGPT tidak valid');
    if (!options.fromReplacement && state.status === 'running') throw new Error('Antrean masih berjalan. Jeda atau Reset terlebih dahulu.');
    if (!options.fromReplacement && state.activeAttempt) throw new Error('Masih ada prompt aktif/ambigu. Lanjutkan atau Reset sesi lama terlebih dahulu.');
    if (isGenerating()) throw new Error('ChatGPT sedang menghasilkan jawaban lain. Tunggu hingga selesai.');

    const runId = Core.randomId('run');
    const leaseToken = Core.randomId('lease');
    const leaseOk = await claimOrRefreshLease(runId, leaseToken);
    if (!leaseOk) throw new Error('Tab ini sedang dipakai Runner lain. Gunakan tab ChatGPT berbeda.');

    operationEpoch += 1;
    const revision = (Number.parseInt(state.revision, 10) || 0) + 1;
    queue = normalizedQueue;
    config = normalizedConfig;
    pendingReplacement = null;
    composerMissingSince = null;
    state = {
      ...Core.makeIdleState(revision),
      revision,
      runId,
      status: 'running',
      phase: 'preparing',
      totalCount: queue.length,
      ownerTabId,
      conversationIdentity: currentConversation(),
      leaseToken
    };
    await chrome.storage.local.remove(STORAGE_KEYS.pendingReplacement);
    await persistSnapshot();
    void processTick();
  }

  async function resumeSession(expectedRevision, ownerTabId) {
    if (state.ownerTabId !== ownerTabId || ownerTabId !== localTabId) throw new Error('Antrean ini berjalan di tab ChatGPT lain');
    if (state.status !== 'paused') throw new Error('Antrean tidak sedang dijeda');
    if (Number.isInteger(expectedRevision) && expectedRevision !== state.revision) throw new Error('Status antrean sudah berubah. Buka ulang popup lalu coba lagi.');
    if (!(await ensureConversation())) throw new Error('Percakapan aktif tidak cocok dengan sesi ini');

    if (!state.runId || !state.leaseToken) {
      state.runId = Core.randomId('run-migrated');
      state.leaseToken = Core.randomId('lease');
      state.conversationIdentity = state.conversationIdentity || currentConversation();
      if (!(await claimOrRefreshLease(state.runId, state.leaseToken))) throw new Error('Tab ini sedang dipakai Runner lain.');
    }

    if (state.activeAttempt && !state.activeAttempt.acceptedAt && state.activeAttempt.stage === 'preparing' && !state.activeAttempt.clickedAt) {
      const prompt = queue[state.activeAttempt.queueIndex];
      if (prompt) clearComposerIfMatchesPrompt(prompt);
      state.activeAttempt = null;
    } else if (state.activeAttempt && !state.activeAttempt.acceptedAt) {
      const prompt = queue[state.activeAttempt.queueIndex];
      const accepted = prompt ? findAcceptedUserTurn(state.activeAttempt, prompt) : { id: null };
      if (accepted.id) {
        state.activeAttempt.acceptedAt = now();
        state.activeAttempt.userTurnId = accepted.id;
        state.activeAttempt.stage = 'awaiting-response';
        state.nextIndex = Math.max(state.nextIndex, state.activeAttempt.queueIndex + 1);
      } else {
        throw new Error('Pengiriman sebelumnya masih ambigu. Reset jika sudah memastikan prompt tidak terkirim.');
      }
    }

    bumpRevision();
    state.status = 'running';
    state.phase = state.activeAttempt ? (state.activeAttempt.acceptedAt ? 'awaiting-response' : 'preparing') : (state.delayUntil ? 'waiting-delay' : 'preparing');
    state.pauseReason = null;
    await persistState();
    void processTick();
  }

  async function recoverOwner(expectedRevision, ownerTabId) {
    if (state.status !== 'paused' || state.pauseReason?.code !== 'owner-missing') throw new Error('Sesi tidak menunggu pemulihan tab owner.');
    if (Number.isInteger(expectedRevision) && expectedRevision !== state.revision) throw new Error('Status antrean sudah berubah. Buka ulang popup lalu coba lagi.');
    if (!Number.isInteger(ownerTabId) || ownerTabId !== localTabId) throw new Error('Tab pemulihan tidak valid.');
    if (state.activeAttempt && !state.activeAttempt.acceptedAt) throw new Error('Pengiriman lama masih ambigu; Reset hanya setelah memastikan prompt tidak terkirim.');

    const current = currentConversation();
    if (state.conversationIdentity) {
      const compatible = Core.reconcileConversation(state.conversationIdentity, current, Boolean(state.conversationIdentity.isNew && state.activeAttempt?.acceptedAt));
      if (!compatible.ok) throw new Error('Buka percakapan ChatGPT yang sama dengan sesi lama sebelum memulihkan owner.');
      state.conversationIdentity = compatible.bind || state.conversationIdentity;
    } else {
      state.conversationIdentity = current;
    }

    state.ownerTabId = ownerTabId;
    state.runId = state.runId || Core.randomId('run-recovered');
    state.leaseToken = Core.randomId('lease');
    if (!(await claimOrRefreshLease(state.runId, state.leaseToken))) throw new Error('Tab ini sedang dipakai Runner lain.');
    bumpRevision();
    state.status = 'running';
    state.phase = state.activeAttempt ? 'awaiting-response' : (state.delayUntil ? 'waiting-delay' : 'preparing');
    state.pauseReason = null;
    await persistState();
    void processTick();
  }

  async function resetSession() {
    const oldRevision = state.revision;
    operationEpoch += 1;
    await releaseLease();
    queue = [];
    config = Core.normalizeConfig({});
    pendingReplacement = null;
    composerMissingSince = null;
    state = Core.makeIdleState((Number.parseInt(oldRevision, 10) || 0) + 1);
    await chrome.storage.local.remove([STORAGE_KEYS.pendingReplacement]);
    await persistSnapshot();
  }

  function launcherAssignment() {
    const url = new URL(window.location.href);
    const runner = url.searchParams.get('cqr_runner');
    const port = Number.parseInt(url.searchParams.get('cqr_port') || '', 10);
    if (!runner || !Number.isInteger(port)) return null;
    return { runner: runner.padStart(2, '0'), port, url };
  }

  function clearLauncherParameters(url) {
    url.searchParams.delete('cqr_runner');
    url.searchParams.delete('cqr_port');
    history.replaceState(history.state, '', url.toString());
  }

  function commandAlreadyProcessed(commandId) {
    return Boolean(commandId && state.processedCommandIds?.includes(String(commandId)));
  }

  async function rememberCommand(commandId) {
    if (!commandId || commandAlreadyProcessed(commandId)) return;
    state.processedCommandIds = [...(state.processedCommandIds || []), String(commandId)].slice(-50);
    await persistState();
  }

  function normalizeLauncherPayload(payload) {
    return {
      queue: Core.normalizeQueue(payload?.queue),
      config: Core.normalizeConfig(payload?.config),
      commandId: payload?.commandId ? String(payload.commandId) : null
    };
  }

  async function startFromLauncherIfAssigned() {
    const assignment = launcherAssignment();
    if (!assignment || assignment.runner !== RUNNER_NUMBER) return false;
    const token = stateToken();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CQR_GET_LAUNCHER_QUEUE', runner: RUNNER_NUMBER, port: assignment.port });
      if (!tokenMatches(token, false)) return true;
      if (!response?.ok) throw new Error(response?.error || 'Antrean launcher tidak tersedia');
      const normalized = normalizeLauncherPayload(response.payload);
      if (commandAlreadyProcessed(normalized.commandId)) return true;
      clearLauncherParameters(assignment.url);
      await startSession(normalized.queue, normalized.config, localTabId);
      await rememberCommand(normalized.commandId);
      return true;
    } catch (error) {
      if (tokenMatches(token, false)) await pauseSession('launcher-error', `Launcher: ${error.message || 'gagal memuat antrean'}`);
      return true;
    }
  }

  async function pollContinueLauncher() {
    if (continuePollLocked || localTabId === null || state.ownerTabId !== localTabId || state.status === 'running' || !queue.length) return;
    continuePollLocked = true;
    const token = stateToken();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CQR_GET_CONTINUE_QUEUE', runner: RUNNER_NUMBER });
      if (!tokenMatches(token, false) || !response?.ok || !response.payload) return;
      const normalized = normalizeLauncherPayload(response.payload);
      if (commandAlreadyProcessed(normalized.commandId)) return;
      if (state.status === 'paused' && Core.queuesMatch(normalized.queue, queue)) {
        const code = state.pauseReason?.code;
        if (code === 'awaiting-user' || code === 'user' || code === 'manual-draft' || code === 'send-ambiguous') return;
        await resumeSession(state.revision, localTabId);
        await rememberCommand(normalized.commandId);
      } else if (state.status === 'paused') {
        pendingReplacement = normalized;
        await chrome.storage.local.set({ [STORAGE_KEYS.pendingReplacement]: pendingReplacement });
      } else {
        await startSession(normalized.queue, normalized.config, localTabId);
        await rememberCommand(normalized.commandId);
      }
    } catch (error) {
      if (responseIsImplementationError(error) && tokenMatches(token, false)) console.warn('[CQR] launcher continue:', error);
    } finally {
      continuePollLocked = false;
    }
  }

  function responseIsImplementationError(error) {
    const message = String(error?.message || '');
    return !/failed to fetch|networkerror|launcher lokal|could not establish connection/i.test(message);
  }

  async function pollReplaceLauncher() {
    if (replacePollLocked || localTabId === null || state.ownerTabId !== localTabId || !queue.length || pendingReplacement) return;
    replacePollLocked = true;
    const token = stateToken();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CQR_GET_REPLACE_QUEUE', runner: RUNNER_NUMBER });
      if (!tokenMatches(token, false) || !response?.ok || !response.payload) return;
      const normalized = normalizeLauncherPayload(response.payload);
      if (commandAlreadyProcessed(normalized.commandId)) return;
      pendingReplacement = normalized;
      await chrome.storage.local.set({ [STORAGE_KEYS.pendingReplacement]: clone(pendingReplacement) });
      if (state.status === 'running') await applyPendingReplacementIfSafe();
    } catch (error) {
      if (responseIsImplementationError(error) && tokenMatches(token, false)) console.warn('[CQR] launcher replace:', error);
    } finally {
      replacePollLocked = false;
    }
  }

  function ensureWidget() {
    if (widget?.isConnected) return widget;
    widget = document.createElement('div');
    widget.id = `cqr-widget-host-${RUNNER_NUMBER || 'default'}`;
    const runnerIndex = Math.max(0, (Number.parseInt(RUNNER_NUMBER, 10) || 1) - 1);
    widget.style.cssText = `position:fixed;right:18px;bottom:${18 + runnerIndex * 52}px;z-index:2147483647;`;
    const shadow = widget.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .box{display:flex;align-items:center;gap:9px;max-width:390px;padding:9px 10px 9px 12px;border:1px solid rgba(255,255,255,.14);border-radius:13px;background:#17221d;color:#f8f5ec;box-shadow:0 10px 28px rgba(0,0,0,.22);font:600 12px/1.25 ui-sans-serif,system-ui,sans-serif}
        .dot{width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:#44bf8b}.dot.paused{background:#e0a04f}.copy{min-width:0;flex:1}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{margin-top:2px;color:#b9c3bd;font-size:10px;font-weight:500}button{padding:5px 8px;border:1px solid rgba(255,255,255,.18);border-radius:7px;background:transparent;color:#f8f5ec;font:700 10px ui-sans-serif,system-ui,sans-serif;cursor:pointer}
      </style><div class="box"><span class="dot"></span><div class="copy"><div class="title"></div><div class="meta"></div></div><button type="button">Jeda</button></div>`;
    shadow.querySelector('button').addEventListener('click', () => pauseSession('user', 'Dijeda dari halaman'));
    document.documentElement.appendChild(widget);
    return widget;
  }

  function renderWidget() {
    if (state.status === 'idle' || state.ownerTabId !== localTabId) {
      widget?.remove();
      widget = null;
      return;
    }
    const host = ensureWidget();
    const shadow = host.shadowRoot;
    shadow.querySelector('.dot').classList.toggle('paused', state.status !== 'running');
    const title = shadow.querySelector('.title');
    const meta = shadow.querySelector('.meta');
    const button = shadow.querySelector('button');
    if (state.status === 'running') {
      title.textContent = state.activeAttempt ? `${RUNNER_NAME}: menunggu jawaban` : `${RUNNER_NAME}: menyiapkan prompt`;
      button.hidden = false;
    } else if (state.status === 'completed') {
      title.textContent = `${RUNNER_NAME}: selesai`;
      button.hidden = true;
    } else {
      title.textContent = `${RUNNER_NAME}: ${state.pauseReason?.message || 'dijeda'}`;
      button.hidden = true;
    }
    meta.textContent = `${state.processedCount}/${state.totalCount} diproses · ${state.successCount} berhasil · ${state.interruptedCount} terhenti · ${state.failedCount} gagal`;
  }

  const ready = Promise.all([
    chrome.runtime.sendMessage({ type: 'CQR_GET_TAB_ID' }),
    chrome.storage.local.get(Object.values(STORAGE_KEYS))
  ]).then(async ([tabInfo, stored]) => {
    localTabId = tabInfo?.tabId ?? null;
    queue = Array.isArray(stored[STORAGE_KEYS.queue]) ? stored[STORAGE_KEYS.queue] : [];
    config = Core.normalizeConfig(stored[STORAGE_KEYS.config] || {});
    state = Core.migrateState(stored[STORAGE_KEYS.state]);
    pendingReplacement = stored[STORAGE_KEYS.pendingReplacement] || null;

    document.querySelectorAll("[data-cqr-interrupted-completion='true']").forEach((node) => node.remove());

    if (state.schemaVersion !== stored[STORAGE_KEYS.state]?.schemaVersion) await persistSnapshot();
    renderWidget();
    const handled = await startFromLauncherIfAssigned();
    if (!handled && state.status === 'running' && state.ownerTabId === localTabId) void processTick();
    void pollContinueLauncher();
    void pollReplaceLauncher();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      await ready;
      if (message?.type === 'CQR_START') await startSession(message.queue, message.config, message.targetTabId);
      else if (message?.type === 'CQR_RESUME') await resumeSession(message.expectedRevision, message.targetTabId);
      else if (message?.type === 'CQR_PAUSE') {
        if (state.ownerTabId !== message.targetTabId) throw new Error('Antrean ini berjalan di tab ChatGPT lain');
        await pauseSession('user', 'Dijeda oleh pengguna');
      } else if (message?.type === 'CQR_RECOVER_OWNER') {
        await recoverOwner(message.expectedRevision, message.targetTabId);
      } else if (message?.type === 'CQR_RESET') await resetSession();
      sendResponse({ ok: true, state: publicState() });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const previousRunId = state.runId;
    const previousRevision = state.revision;
    if (changes[STORAGE_KEYS.queue]) queue = Array.isArray(changes[STORAGE_KEYS.queue].newValue) ? changes[STORAGE_KEYS.queue].newValue : [];
    if (changes[STORAGE_KEYS.config]) config = Core.normalizeConfig(changes[STORAGE_KEYS.config].newValue || {});
    if (changes[STORAGE_KEYS.pendingReplacement]) pendingReplacement = changes[STORAGE_KEYS.pendingReplacement].newValue || null;
    if (changes[STORAGE_KEYS.state]) {
      state = Core.migrateState(changes[STORAGE_KEYS.state].newValue);
      if (state.runId !== previousRunId || state.revision !== previousRevision) operationEpoch += 1;
      renderWidget();
    }
  });

  setInterval(() => void processTick(), POLL_INTERVAL_MS);
  setInterval(() => void pollContinueLauncher(), LAUNCHER_POLL_INTERVAL_MS);
  setInterval(() => void pollReplaceLauncher(), LAUNCHER_POLL_INTERVAL_MS);
})();
