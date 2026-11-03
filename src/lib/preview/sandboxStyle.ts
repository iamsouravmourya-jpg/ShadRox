/**
 * Self-contained stylesheet for documents ShadRox generates itself (the
 * structure preview and the markdown preview).
 *
 * These documents used to inject `https://cdn.tailwindcss.com`, so opening a
 * backend-only folder on a plane produced an unstyled page. Everything here is
 * deterministic, offline, and only applies to markup this module owns.
 */

export const SANDBOX_STYLE_VERSION = 1;

/** Semantic, prefixed classes: no utility framework and no network needed. */
export const SANDBOX_STYLE = `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  background: #050505;
  color: #f3f4f6;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.6;
}
h1, h2, h3 { margin: 0; font-weight: 600; color: #fff; }
.sd-page { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.sd-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid #262626; }
.sd-title-group { display: flex; align-items: center; gap: 12px; min-width: 0; }
.sd-mark { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: 8px; border: 1px solid rgba(196,181,253,.28); background: rgba(139,92,246,.12); color: #c4b5fd; font-weight: 700; font-size: 12px; }
.sd-title { font-size: 14px; letter-spacing: .01em; }
.sd-subtitle { margin-top: 2px; font-size: 11px; color: #a3a3a3; }
.sd-badge { flex: none; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(196,181,253,.28); background: rgba(139,92,246,.12); color: #c4b5fd; font-size: 10px; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; text-transform: uppercase; letter-spacing: .08em; }
.sd-note { padding: 12px; border-radius: 8px; border: 1px solid #78350f; background: rgba(69,26,3,.35); color: #fcd34d; font-size: 11px; line-height: 1.6; }
.sd-note--neutral { border-color: #262626; background: #0a0a0a; color: #a3a3a3; }
.sd-note strong { color: inherit; font-weight: 600; }
.sd-tabs { display: flex; align-items: center; gap: 6px; padding-bottom: 8px; border-bottom: 1px solid #262626; }
.sd-tab { padding: 6px 12px; border: 0; border-radius: 6px; background: transparent; color: #a3a3a3; font: inherit; font-size: 12px; cursor: pointer; }
.sd-tab:hover { color: #fff; }
.sd-tab[aria-selected="true"] { background: #fafafa; color: #0a0a0a; font-weight: 600; }
.sd-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.sd-card { padding: 16px; border: 1px solid #262626; border-radius: 10px; background: rgba(23,23,23,.5); }
.sd-card-label { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #737373; }
.sd-card-value { margin-top: 4px; font-size: 20px; font-weight: 700; color: #fff; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
.sd-card-note { margin-top: 4px; font-size: 10px; color: #a3a3a3; }
.sd-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #d4d4d4; margin-bottom: 10px; }
.sd-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; font-size: 11px; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; color: #a3a3a3; }
.sd-kv span { color: #e5e5e5; }
.sd-list { border: 1px solid #262626; border-radius: 10px; background: #0a0a0a; overflow: hidden; }
.sd-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid #171717; }
.sd-row:last-child { border-bottom: 0; }
.sd-route { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sd-method { flex: none; padding: 2px 6px; border-radius: 4px; border: 1px solid #404040; background: #171717; color: #d4d4d4; font-size: 10px; font-weight: 700; font-family: ui-monospace, Consolas, monospace; }
.sd-method--get { border-color: rgba(196,181,253,.3); background: rgba(139,92,246,.12); color: #c4b5fd; }
.sd-method--post { border-color: rgba(56,189,248,.3); background: rgba(12,74,110,.4); color: #7dd3fc; }
.sd-method--put, .sd-method--patch { border-color: rgba(245,158,11,.3); background: rgba(69,26,3,.5); color: #fcd34d; }
.sd-method--delete { border-color: rgba(248,113,113,.3); background: rgba(69,10,10,.5); color: #fca5a5; }
.sd-path { font-size: 12px; font-family: ui-monospace, Consolas, monospace; color: #e5e5e5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-source { font-size: 10px; font-family: ui-monospace, Consolas, monospace; color: #525252; flex: none; }
.sd-hint { font-size: 11px; color: #a3a3a3; margin-bottom: 8px; }
.sd-hint code { font-family: ui-monospace, Consolas, monospace; color: #e5e5e5; }
.sd-files { max-height: 260px; overflow-y: auto; padding: 12px; border: 1px solid #262626; border-radius: 10px; background: #0a0a0a; }
.sd-file { display: flex; align-items: center; gap: 8px; font-size: 12px; font-family: ui-monospace, Consolas, monospace; color: #d4d4d4; }
.sd-file::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #525252; flex: none; }
.sd-footnote { font-size: 10px; color: #525252; }
.sd-view[hidden] { display: none; }
code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }`;

/**
 * Tab switching for the generated document. Kept tiny, guarded, and free of any
 * data invention: it only moves `hidden` between views it can see.
 */
export const SANDBOX_TAB_SCRIPT = `(function () {
  function select(name) {
    var views = document.querySelectorAll('.sd-view');
    for (var i = 0; i < views.length; i += 1) {
      var view = views[i];
      var isActive = view.getAttribute('data-view') === name;
      view.hidden = !isActive;
      var tab = document.querySelector('.sd-tab[data-tab="' + name + '"]');
      if (tab) tab.setAttribute('aria-selected', String(isActive));
    }
    var tabs = document.querySelectorAll('.sd-tab');
    for (var t = 0; t < tabs.length; t += 1) {
      tabs[t].setAttribute('aria-selected', String(tabs[t].getAttribute('data-tab') === name));
    }
  }
  document.addEventListener('click', function (event) {
    var tab = event.target && event.target.closest ? event.target.closest('.sd-tab') : null;
    if (tab && tab.getAttribute('data-tab')) select(tab.getAttribute('data-tab'));
  });
})();`;
