(() => {
  if (window.__CQR_INTERRUPTION_BYPASS_LOADED__) return;
  window.__CQR_INTERRUPTION_BYPASS_LOADED__ = true;
  const q=Document.prototype.querySelectorAll,r=/\b(continue generating|continue response|lanjutkan membuat|lanjutkan menghasilkan|lanjutkan jawaban|try again|retry|coba lagi|ulangi|regenerate|regenerate response|hasilkan ulang)\b/i;
  const t=b=>`${b?.textContent||""} ${b?.getAttribute?.("aria-label")||""}`.replace(/\s+/g," ").trim(),x=b=>r.test(t(b));
  Document.prototype.querySelectorAll=function(s){const a=q.call(this,s);return this===document&&s==="main button"?[...a].filter(b=>!x(b)):a;};
  function last(){for(const s of ["section[data-turn='assistant']","[data-testid^='conversation-turn-'][data-turn='assistant']","[data-testid^='conversation-turn-'][data-message-author-role='assistant']","[data-message-author-role='assistant']"]){const a=[...q.call(document,s)];if(a.length)return a[a.length-1];}return null;}
  function mark(){if(![...q.call(document,"main button")].some(x))return;const a=last();if(!a||a.querySelector("[data-cqr-interrupted-completion='true']"))return;const m=document.createElement("button");m.hidden=true;m.setAttribute("data-testid","copy-turn-action-button");m.setAttribute("data-cqr-interrupted-completion","true");a.appendChild(m);} mark();new MutationObserver(mark).observe(document.documentElement,{childList:true,subtree:true,attributes:true});
})();
