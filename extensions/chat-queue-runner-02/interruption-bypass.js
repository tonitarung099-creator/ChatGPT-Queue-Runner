(() => {
  if (window.__CQR_INTERRUPTION_BYPASS_LOADED__) return;
  window.__CQR_INTERRUPTION_BYPASS_LOADED__ = true;

  const nativeQuerySelectorAll = Document.prototype.querySelectorAll;
  const RECOVERABLE_ACTION = /\b(continue generating|continue response|lanjutkan membuat|lanjutkan menghasilkan|lanjutkan jawaban|try again|retry|coba lagi|ulangi|regenerate|regenerate response|hasilkan ulang)\b/i;

  function actionText(button) {
    return `${button?.textContent || ""} ${button?.getAttribute?.("aria-label") || ""}`
      .replace(/\s+/g, " ")
      .trim();
  }

  function isRecoverableButton(button) {
    return RECOVERABLE_ACTION.test(actionText(button));
  }

  Document.prototype.querySelectorAll = function(selector) {
    const result = nativeQuerySelectorAll.call(this, selector);
    if (this === document && selector === "main button") {
      return [...result].filter((button) => !isRecoverableButton(button));
    }
    return result;
  };

  function getLatestAssistantTurn() {
    const selectors = ["section[data-turn='assistant']","[data-testid^='conversation-turn-'][data-turn='assistant']","[data-testid^='conversation-turn-'][data-message-author-role='assistant']","[data-message-author-role='assistant']"];
    for (const selector of selectors) {
      const turns = [...nativeQuerySelectorAll.call(document, selector)];
      if (turns.length) return turns[turns.length - 1];
    }
    return null;
  }

  function ensureCompletionEvidence() {
    const buttons = [...nativeQuerySelectorAll.call(document, "main button")];
    if (!buttons.some(isRecoverableButton)) return;
    const turn = getLatestAssistantTurn();
    if (!turn || turn.querySelector("[data-cqr-interrupted-completion='true']")) return;
    const marker = document.createElement("button");
    marker.type = "button"; marker.hidden = true; marker.tabIndex = -1;
    marker.setAttribute("aria-hidden", "true");
    marker.setAttribute("data-testid", "copy-turn-action-button");
    marker.setAttribute("data-cqr-interrupted-completion", "true");
    turn.appendChild(marker);
  }

  ensureCompletionEvidence();
  const observer = new MutationObserver(ensureCompletionEvidence);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
})();
