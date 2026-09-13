/*
 * Service worker: everything that touches the network or persistent storage.
 *
 * api.opensubtitles.com does not send CORS headers, so a page-context fetch is blocked.
 * An MV3 service worker holding host_permissions for that origin is not subject to CORS,
 * which is why all API traffic is funnelled through here.
 */

const API = 'https://api.opensubtitles.com/api/v1';
const UA = 'FilmstribenSubs v0.6.0';

const store = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
};

/* ------------------------------------------------------------------ decoding */

const decode = (buffer) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    return new TextDecoder('windows-1252').decode(buffer);
  }
};

/* ----------------------------------------------------------------------- auth */

async function login() {
  const { apiKey, username, password } = await store.get(['apiKey', 'username', 'password']);
  if (!apiKey) throw new Error('Ingen API-nøgle. Åbn indstillinger for udvidelsen.');
  if (!username || !password) return null;

  const res = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Key': apiKey, 'User-Agent': UA },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login mislykkedes (${res.status})`);
  const json = await res.json();
  await store.set({ token: json.token, tokenAt: Date.now() });
  return json.token;
}

async function apiFetch(path, init = {}, allowRetry = true) {
  const { apiKey, token } = await store.get(['apiKey', 'token']);
  if (!apiKey) throw new Error('Ingen API-nøgle. Åbn indstillinger for udvidelsen.');

  const headers = {
    'Api-Key': apiKey,
    'User-Agent': UA,
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers || {}),
  };

  const res = await fetch(`${API}${path}`, { ...init, headers });

  // Token expired (JWTs are short-lived) — log in again once and replay.
  if (res.status === 401 && allowRetry) {
    const fresh = await login();
    if (fresh) return apiFetch(path, init, false);
  }
  if (res.status === 429) {
    throw new Error('OpenSubtitles: for mange forespørgsler eller download-kvote opbrugt.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (_) {}
    throw new Error(`OpenSubtitles ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ handlers */

const handlers = {
  async 'ctx.set'(payload) {
    const { filmContext: prev } = await store.get('filmContext');

    /*
     * Last line of defence for title precedence. The DOM reading of a page heading only ever
     * yields the Danish title reliably, so it must never replace a GraphQL record for the
     * same film — whatever order the two arrive in, and however long apart.
     */
    if (prev && prev.source === 'graphql' && payload.source === 'dom' && prev.url === payload.url) {
      return false;
    }

    await store.set({ filmContext: payload });
    return true;
  },

  async 'ctx.get'() {
    const { filmContext } = await store.get('filmContext');
    // Ignore anything stale — the user may have left the catalogue hours ago.
    if (!filmContext || Date.now() - filmContext.at > 6 * 3600e3) return null;
    return filmContext;
  },

  async 'os.status'() {
    const { apiKey, username, token } = await store.get(['apiKey', 'username', 'token']);
    return { hasKey: Boolean(apiKey), loggedIn: Boolean(token), username: username || null };
  },

  async 'os.search'({ query, languages, year, type, imdbId }) {
    const params = new URLSearchParams();
    if (imdbId) params.set('imdb_id', String(imdbId).replace(/^tt/, ''));
    else params.set('query', query || '');
    if (languages) params.set('languages', languages);
    if (year) params.set('year', String(year));
    if (type) params.set('type', type);
    params.set('order_by', 'download_count');
    params.set('order_direction', 'desc');

    const json = await apiFetch(`/subtitles?${params}`);
    const rows = (json.data || []).map((item) => {
      const a = item.attributes || {};
      const file = (a.files && a.files[0]) || {};
      return {
        fileId: file.file_id,
        fileName: file.file_name || a.release || '(uden navn)',
        language: a.language,
        release: a.release,
        downloads: a.download_count,
        hearingImpaired: Boolean(a.hearing_impaired),
        fps: a.fps || null,
        uploadDate: a.upload_date,
        featureTitle: (a.feature_details && a.feature_details.title) || null,
        featureYear: (a.feature_details && a.feature_details.year) || null,
      };
    }).filter((r) => r.fileId);

    return { rows, total: json.total_count || rows.length };
  },

  async 'os.download'({ fileId }) {
    const json = await apiFetch('/download', {
      method: 'POST',
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!json.link) throw new Error('Intet download-link i svaret.');

    // Links are single-use and short-lived; fetch immediately.
    const res = await fetch(json.link, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Download mislykkedes (${res.status})`);
    const text = decode(await res.arrayBuffer());

    return {
      text,
      fileName: json.file_name || 'subtitles.srt',
      remaining: typeof json.remaining === 'number' ? json.remaining : null,
      resetTime: json.reset_time || null,
    };
  },

  async 'os.login'() {
    const token = await login();
    return { loggedIn: Boolean(token) };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Ukendt kommando: ${msg && msg.type}` });
    return false;
  }
  handler(msg.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
  return true;   // async response
});
