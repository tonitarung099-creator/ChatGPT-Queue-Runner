(() => {
  if (window.__CQR_INTERRUPTION_BYPASS_LOADED__) return;
  window.__CQR_INTERRUPTION_BYPASS_LOADED__ = true;
  const nativeQuerySelectorAll = Document.prototype.querySelectorAll;
  const RECOVERABLE_ACTION = /\b(continue generating|continue response|lanjutkan membuat|lanjutkan menghasilkan|lanjutkan jawaban|try again|retry|coba lagi|ulangi|regenerate|regenerate response|hasilkan ulang)\b/i;
  const actionText=(button)=>`${button?.textContent||""} ${button?.getAttribute?.("aria-label")||""}`.replace(/\s+/g," ").trim(); const isRecoverableButton=(button)=>RECOVERABLE_ACTION.test(actionText(button));
  Document.prototype.querySelectorAll=function(selector){const result=nativeQuerySelectorAll.call(this,selector);if(this===document&&selector==="main button")return [...result].filter((button)=>!isRecoverableButton(button));return result;};
  function latest(){for(const selector of ["section[data-turn='assistant']","[data-testid^='conversation-turn-'][data-turn='assistant']","[data-testid^='conversation-turn-'][data-message-author-role='assistant']","[data-message-author-role='assistant']"]){const turns=[...nativeQuerySelectorAll.call(document,selector)];if(turns.length)return turns[turns.length-1];}return null;}
  function mark(){const buttons=[...nativeQuerySelectorAll.call(document,"main button")];if(!buttons.some(isRecoverableButton))return;const turn=latest();if(!turn||turn.querySelector("[data-cqr-interrupted-completion='true']"))return;const m=document.createElement("button");m.hidden=true;m.setAttribute("data-testid","copy-turn-action-button");m.setAttribute("data-cqr-interrupted-completion","true");turn.appendChild(m);} mark(); new MutationObserver(mark).observe(document.documentElement,{childList:true,subtree:true,attributes:true});
})();
