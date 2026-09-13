/*
 * Catalogue enhancements (fjernleje.filmstriben.dk) — MAIN world, document_start.
 *
 *   1. Shows each film's original title as a small subtitle under the Danish one.
 *   2. Hands the current film's title and year to the player for subtitle lookups.
 *
 * The catalogue's Apollo client already fetches what is needed:
 *
 *   GetContent → movies[].fields.{url, originalTitle, primaryTitle, year}
 *
 * So rather than issuing our own queries, this patches window.fetch and reads the responses
 * as they stream past. No extra network traffic, and records are indexed at the same moment
 * the cards they belong to render.
 */
(() => {
  'use strict';

  if (window.__fsPoints) return;

  const TITLE_SELECTOR = 'h1,h2,h3,h4,h5,[class*="title"],[class*="Title"]';
  const SUB_CLASS = 'fs-orig-title';

  /* ============================================================ pure helpers */

  const normUrl = (u) => {
    if (!u) return null;
    try {
      const path = u.startsWith('http') ? new URL(u).pathname : String(u).split('?')[0];
      return path.replace(/\/+$/, '').toLowerCase() || null;
    } catch (_) {
      return null;
    }
  };

  // Films are addressed as /film/<id>/<slug>; the id alone is the most durable key.
  const idFromUrl = (u) => {
    const m = /\/(\d{4,})(?:\/|$)/.exec(normUrl(u) || '');
    return m ? m[1] : null;
  };

  const normTitle = (t) => (t || '')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/[.,:;!?'"’“”()\[\]–—-]/g, '')
    .trim() || null;

  /*
   * An element's own text, ignoring child elements — so a heading still reports the Danish
   * title after the original has been appended to it as a subtitle.
   */
  const ownText = (el) => {
    let s = '';
    for (const node of el.childNodes) if (node.nodeType === 3) s += node.nodeValue;
    return s.trim();
  };

  /* ================================================================== index */

  const byId = new Map();      // route id → entry
  const byTitle = new Map();   // normalised danish OR original title → entry
  const swap = new Map();      // normalised danish title → original title
  let token = null;

  const indexMovies = (movies) => {
    let added = 0;
    for (const m of movies) {
      const f = m && m.fields;
      if (!f) continue;

      const primary = f.primaryTitle || null;
      const original = f.originalTitle || null;
      const entry = { title: primary, originalTitle: original, year: f.year || null, recordId: m.recordId };

      // fields.url is the bridge between the GraphQL recordId and the route id, but index
      // under both so a lookup works whichever one the page gives us.
      for (const id of [idFromUrl(f.url), m.recordId != null ? String(m.recordId) : null]) {
        if (id) byId.set(id, entry);
      }
      for (const t of [primary, original]) {
        const n = normTitle(t);
        if (n && !byTitle.has(n)) byTitle.set(n, entry);
      }

      const np = normTitle(primary);
      if (np && original && normTitle(original) !== np) swap.set(np, original);

      added++;
    }
    if (added) schedule();
    return added;
  };

  // Matched structurally rather than by operation name, so this survives the app renaming
  // or batching its queries.
  const absorb = (json) => {
    for (const p of (Array.isArray(json) ? json : [json])) {
      const d = p && p.data;
      if (!d) continue;
      if (Array.isArray(d.movies)) indexMovies(d.movies);
      if (d.movie) indexMovies([d.movie]);
    }
  };

  /* ============================================================ fetch patch */

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    let url = '';
    try {
      url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    } catch (_) {}

    if (url.includes('/graphql')) {
      try {
        const body = args[1] && args[1].body;
        if (typeof body === 'string') {
          const m = /"token"\s*:\s*"([0-9a-f]{16,})"/i.exec(body);
          if (m) token = m[1];
        }
      } catch (_) {}

      return origFetch.apply(this, args).then((res) => {
        try { res.clone().json().then(absorb).catch(() => {}); } catch (_) {}
        return res;
      });
    }

    return origFetch.apply(this, args);
  };

  /* ============================================================ title subtitle */

  /*
   * The Danish title stays as the heading; the original is appended inside it as a small,
   * faded block. Appending *inside* keeps it glued to the heading through the site's own
   * layout, and ownText() means the heading still matches on later passes.
   */
  const applyTitles = () => {
    if (!swap.size) return 0;
    let added = 0;

    for (const el of document.querySelectorAll(TITLE_SELECTOR)) {
      if (el.classList.contains(SUB_CLASS)) continue;      // never annotate our own subtitle

      const base = ownText(el);
      if (!base) continue;                                 // wrappers hold no text of their own

      const original = swap.get(normTitle(base));
      if (!original) continue;

      const existing = el.querySelector(`:scope > .${SUB_CLASS}`);
      if (existing) {
        if (existing.textContent !== original) existing.textContent = original;
        continue;
      }

      const sub = document.createElement('span');
      sub.className = SUB_CLASS;
      sub.textContent = original;
      sub.setAttribute('lang', '');                        // original language is unknown
      el.appendChild(sub);
      added++;
    }

    return added;
  };

  /* ======================================================= player film context */

  // The player iframe is cross-origin and cannot read the title from here, so the current
  // film is relayed to the isolated-world script, which forwards it to the service worker.
  /*
   * The route id and the GraphQL recordId are different namespaces bridged by fields.url, so
   * an id lookup can miss. Fall back to the page heading's own text — which is the Danish
   * title, indexed alongside the original one.
   */
  const currentFilm = () => {
    const m = /^\/film\/(\d+)(?:\/|$)/.exec(window.location.pathname);
    if (!m) return null;
    if (byId.has(m[1])) return byId.get(m[1]);

    const h1 = document.querySelector('h1');
    const t = h1 && normTitle(ownText(h1));
    return (t && byTitle.get(t)) || null;
  };

  let lastCtx = '';
  const reportContext = () => {
    const info = currentFilm();
    if (!info) return;

    const payload = {
      title: info.originalTitle || info.title,   // best guess for searching
      originalTitle: info.originalTitle || null, // stated explicitly so consumers can prefer it
      danishTitle: info.title || null,
      year: info.year || null,
      source: 'graphql',
      url: window.location.href,
      at: Date.now(),
    };
    const key = `${payload.title}|${payload.year}`;
    if (key === lastCtx) return;
    lastCtx = key;
    window.postMessage({ __fsPoints: 'ctx', payload }, '*');
  };

  /* ================================================================ schedule */

  let timer = null;
  const run = () => { applyTitles(); reportContext(); };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  };

  const start = () => {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  /* ================================================================= console */

  window.__fsPoints = {
    get token() { return token; },
    index: { byId, byTitle, swap },
    currentFilm,
    refresh: run,
    applyTitles,
    absorb,
    _helpers: { normUrl, idFromUrl, normTitle, ownText },
  };
})();
