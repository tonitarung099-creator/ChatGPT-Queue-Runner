(() => {
  'use strict';
  // v0.1.8 monkey-patched Document.querySelectorAll and injected fake
  // synthetic completion markers. v0.2.0 deliberately does neither.
  document.querySelectorAll("[data-cqr-interrupted-completion='true']").forEach((node) => node.remove());
})();
