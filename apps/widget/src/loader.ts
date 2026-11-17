// M0 stub: finds [data-staywall] nodes and attaches a Shadow root. Real rendering lands in M3.
// Rule: never throw into the host page.
function init(): void {
  try {
    document.querySelectorAll<HTMLElement>("[data-staywall]").forEach((el) => {
      if (!el.shadowRoot) el.attachShadow({ mode: "open" });
    });
  } catch { /* render nothing on failure */ }
}
(window as unknown as { Staywall: { refresh: () => void } }).Staywall = { refresh: init };
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
