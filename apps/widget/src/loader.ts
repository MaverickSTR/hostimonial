// M0 stub: finds [data-aggregator] nodes and attaches a Shadow root. Real rendering lands in M3.
// Rule: never throw into the host page.
function init(): void {
  try {
    document.querySelectorAll<HTMLElement>("[data-aggregator]").forEach((el) => {
      if (!el.shadowRoot) el.attachShadow({ mode: "open" });
    });
  } catch { /* render nothing on failure */ }
}
(window as unknown as { AggreGator: { refresh: () => void } }).AggreGator = { refresh: init };
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
