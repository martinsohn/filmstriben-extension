/*
 * Isolated-world relay.
 *
 * player.js runs in the MAIN world so it can reach window.shakaplayer, which means it has
 * no chrome.* APIs. This script sits in the isolated world on the same page and forwards
 * requests to the service worker, which is where network calls happen — a service worker
 * with host_permissions is not subject to CORS, and api.opensubtitles.com refuses
 * browser-origin requests.
 */
(() => {
  'use strict';

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__fsSubs !== 'req' || typeof msg.id !== 'number') return;

    const reply = { __fsSubs: 'res', id: msg.id };
    try {
      const res = await chrome.runtime.sendMessage({ type: msg.type, payload: msg.payload });
      if (res && res.ok === false) {
        reply.ok = false;
        reply.error = res.error || 'unknown error';
      } else {
        reply.ok = true;
        reply.data = res ? res.data : null;
      }
    } catch (err) {
      reply.ok = false;
      reply.error = (err && err.message) || String(err);
    }
    window.postMessage(reply, '*');
  });
})();
