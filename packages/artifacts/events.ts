/**
 * One live-update connection per page, released while the tab is hidden.
 *
 * Browsers cap HTTP/1.1 connections per host at about six. Each artifact page
 * used to hold two permanent EventSource streams (reload + annotations), so a
 * few background tabs silently starved the next page load: it just spun.
 *
 * The hub is idempotent (both the baked reload snippet and the serve-time
 * review layer include it), shares one stream between subscribers, closes it
 * on hide/pagehide, and on return passes `since` so the server replays any
 * reload/annotation change that happened while it was disconnected.
 */
export const EVENT_HUB_JS = `(function () {
  if (window.__artifactEvents || typeof EventSource === "undefined") return;
  var subs = [], es = null, since = Math.floor(performance.timeOrigin || Date.now());
  function open() {
    if (es || !subs.length || document.visibilityState === "hidden") return;
    es = new EventSource("/events?slug=" + encodeURIComponent(subs[0].slug) + "&since=" + since);
    ["reload", "annotations"].forEach(function (type) {
      es.addEventListener(type, function (e) {
        subs.slice().forEach(function (s) { if (s.type === type) { try { s.fn(e); } catch (_) {} } });
      });
    });
  }
  function close() { if (!es) return; es.close(); es = null; since = Date.now(); }
  document.addEventListener("visibilitychange", function () { document.visibilityState === "hidden" ? close() : open(); });
  window.addEventListener("pagehide", close);
  window.addEventListener("pageshow", open);
  window.__artifactEvents = { on: function (slug, type, fn) { subs.push({ slug: slug, type: type, fn: fn }); setTimeout(open, 0); } };
})();`;

/** Matches the reload snippet baked into already-written artifact files. */
export const BAKED_RELOAD_SNIPPET = /<script data-artifact-reload>[\s\S]*?<\/script>/g;
