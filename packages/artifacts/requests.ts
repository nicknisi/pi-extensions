/**
 * Page requests: a served page may carry elements like
 *
 *   <button type="button" data-artifact-action="approve" hidden>Approve in Pi</button>
 *   <span data-artifact-action-status="approve"></span>
 *
 * They stay hidden and inert unless the artifact's current subscriber accepts
 * that action, so a file:// copy or a page with no listening session shows
 * nothing. A click sends a same-origin request to the owning session; what it
 * does with it is the session's business. A request is never permission.
 */
export function requestSnippet(slug: string): string {
  const safeSlug = JSON.stringify(slug).replace(/</g, '\\u003c');
  return `
<script data-artifact-requests>
(function () {
  var slug = ${safeSlug};
  var els = [].slice.call(document.querySelectorAll('[data-artifact-action]'));
  if (!els.length || !window.fetch) return;
  function say(action, text) {
    [].forEach.call(document.querySelectorAll('[data-artifact-action-status="' + action + '"]'), function (s) { s.textContent = text; });
  }
  fetch('/api/actions?slug=' + encodeURIComponent(slug)).then(function (r) { return r.ok ? r.json() : { actions: [] }; }).then(function (d) {
    var live = Array.isArray(d.actions) ? d.actions : [];
    els.forEach(function (el) {
      var action = el.getAttribute('data-artifact-action');
      if (live.indexOf(action) < 0) return;
      el.hidden = false;
      el.disabled = false;
      el.addEventListener('click', function () {
        if (el.getAttribute('aria-busy') === 'true') return;
        el.setAttribute('aria-busy', 'true');
        say(action, 'Sending…');
        fetch('/api/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: slug, action: action }) })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok && b.delivered === true, body: b }; }); })
          .then(function (x) { say(action, x.ok ? (el.getAttribute('data-artifact-sent') || 'Sent.') : (x.body.error || 'Not delivered.')); })
          .catch(function () { say(action, 'Not delivered.'); })
          .then(function () { setTimeout(function () { el.removeAttribute('aria-busy'); }, 1500); });
      });
    });
  }).catch(function () {});
})();
</script>`;
}
