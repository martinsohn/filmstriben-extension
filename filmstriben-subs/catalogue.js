/*
 * Runs on the catalogue app (fjernleje.filmstriben.dk), isolated world.
 *
 * The player lives in a cross-origin iframe and cannot read the film title from its parent,
 * so the current film is parked in the service worker for the player panel to ask for.
 *
 * Two sources, in priority order:
 *   1. catalogue-net.js (MAIN world) relays the indexed GraphQL record — original title,
 *      Danish title and year. Authoritative.
 *   2. A DOM reading of the page heading, as a fallback for when the record has not been
 *      seen yet (direct load, cold cache).
 *
 * The precedence is scoped to the *path*, not to a time window. An earlier version expired
 * its guard after ten seconds, so lingering on a film page — which every user does, since
 * they have to click play — let the DOM fallback overwrite the GraphQL record and the
 * player ended up searching the Danish title.
 */
(() => {
  'use strict';

  const authoritativePaths = new Set();

  const send = (payload) => {
    try {
      chrome.runtime.sendMessage({ type: 'ctx.set', payload });
    } catch (_) { /* extension reloaded */ }
  };

  /* ---------------------------------------------- 1. relay from the MAIN world */

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const m = event.data;
    if (!m || m.__fsPoints !== 'ctx' || !m.payload) return;
    authoritativePaths.add(location.pathname);
    send(m.payload);
  });

  /* ------------------------------------------------------- 2. DOM fallback */

  const clean = (s) => (s || '')
    .replace(/\s*[|–-]\s*Filmstriben.*$/i, '')
    // The film page packs the runtime and a save button inside the <h1>, which produced
    // titles like "Rød1 time 35 minutterGemt" when read with textContent.
    .replace(/\d+\s*time[rn]?(?:\s*\d+\s*minutte[rn]?)?/gi, ' ')
    .replace(/\d+\s*t\s*\d+\s*min(?:utte?r?)?/gi, ' ')
    .replace(/\b(gemt?|gem|se filmen|tilføj til favoritter)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /* An element's own text, ignoring nested elements such as badges and buttons. */
  const ownText = (el) => {
    if (!el) return '';
    let s = '';
    for (const node of el.childNodes) if (node.nodeType === 3) s += node.nodeValue;
    return s.trim();
  };

  const read = () => {
    const h1 = document.querySelector('h1');
    // Prefer the heading's own text nodes; only fall back to the whole subtree, scrubbed.
    const danish = clean(ownText(h1)) || clean(h1 && h1.textContent) || clean(document.title);
    if (!danish || danish.length < 2) return null;

    // catalogue-net.js annotates headings with the original title, so even this fallback can
    // usually report one.
    const sub = h1 && h1.querySelector('.fs-orig-title');
    const original = clean(sub && sub.textContent) || null;

    const title = original || danish;

    let year = null;
    const scope = (h1 && h1.closest('main, article, section')) || document.body;
    const m = /\b(19\d{2}|20\d{2})\b/.exec((scope.textContent || '').slice(0, 4000));
    if (m) year = Number(m[1]);

    return {
      title,
      originalTitle: original,
      danishTitle: danish,
      year,
      source: 'dom',
      url: location.href,
      at: Date.now(),
    };
  };

  let lastKey = '';
  const push = () => {
    // Never overwrite a GraphQL record for this page, no matter how much time has passed.
    if (authoritativePaths.has(location.pathname)) return;
    const ctx = read();
    if (!ctx) return;
    const key = `${ctx.title}|${ctx.year}`;
    if (key === lastKey) return;
    lastKey = key;
    send(ctx);
  };

  push();
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; lastKey = ''; }
    push();
  }, 1200);
})();
