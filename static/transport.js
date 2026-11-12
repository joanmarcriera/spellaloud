// transport.js - how the kid app and the parent page talk to their data (Vikunja #3532).
//   server mode (default, the family deployment): fetch() against server.py's /api/*.
//   local mode (browser-only product): the same calls answered by store.js over IndexedDB.
// Local mode is chosen by <html data-store="local"> (stamped by the public build) or by ?local=1 for testing.
// Every function takes the same arguments in both modes, so screens never branch on the mode.
//
// Usage:  const t = await createTransport();  await t.api('GET', '/api/kids');  await t.audioSrc(id) -> url

export function isLocalMode(doc = globalThis.document, search = globalThis.location ? globalThis.location.search : '') {
  return Boolean(doc && doc.documentElement && doc.documentElement.dataset.store === 'local') || new URLSearchParams(search).get('local') === '1';
}

/** Server transport. `fetchImpl` is injectable for tests. */
export function serverTransport(fetchImpl = (...a) => globalThis.fetch(...a)) {
  const readJson = async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    return data;
  };
  return {
    mode: 'server',
    store: null,
    async api(method, path, body) {
      const opt = { method, headers: {} };
      if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
      else if (method !== 'GET' && method !== 'DELETE') opt.headers['Content-Type'] = 'application/json';
      return readJson(await fetchImpl(path, opt));
    },
    async audioSrc(wordId) { return `/api/words/${wordId}/audio`; },
    async putAudio(wordId, wav, source = 'child') {
      const q = source === 'child' ? '' : `?source=${source}`;
      return readJson(await fetchImpl(`/api/words/${wordId}/audio${q}`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: wav }));
    },
  };
}

/** Local transport over a store (see store.js). Playback URLs are blob: URLs, one per word, revoked on replace. */
export function localTransport(store, { URLApi = globalThis.URL, BlobApi = globalThis.Blob } = {}) {
  const urls = new Map();
  const drop = (id) => { const u = urls.get(id); if (u) { URLApi.revokeObjectURL(u); urls.delete(id); } };
  return {
    mode: 'local',
    store,
    async api(method, path, body) {
      try { return (await store.request(method, path, body)).data; }
      catch (e) { throw new Error(e && e.message ? e.message : 'Something went wrong'); }
    },
    async audioSrc(wordId) {
      if (urls.has(wordId)) return urls.get(wordId);
      const { data } = await store.request('GET', `/api/words/${wordId}/audio`);
      const url = URLApi.createObjectURL(new BlobApi([data.bytes], { type: data.type }));
      urls.set(wordId, url);
      return url;
    },
    async putAudio(wordId, wav, source = 'child') {
      const bytes = wav instanceof Uint8Array ? wav : new Uint8Array(wav instanceof ArrayBuffer ? wav : await wav.arrayBuffer());
      const q = source === 'child' ? '' : `?source=${source}`;
      const out = (await store.request('PUT', `/api/words/${wordId}/audio${q}`, bytes)).data;
      drop(wordId);
      return out;
    },
  };
}

let shared = null;
/** The one transport for this page. Local mode lazily loads store.js so the family build never fetches it. */
export function createTransport() {
  shared ||= (async () => {
    if (!isLocalMode()) return serverTransport();
    // Offline shell: the public build ships /sw.js (bin/build-local); registration is best-effort.
    if (globalThis.navigator && 'serviceWorker' in globalThis.navigator) globalThis.navigator.serviceWorker.register('/sw.js').catch(() => {});
    const { createStore, idbBackend } = await import('./store.js');
    return localTransport(await createStore(idbBackend(), { homeUrl: '/?who=1', speechFallback: true })); // Home = back to the kid picker
  })();
  return shared;
}
