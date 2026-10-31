// Cloudflare Pages (_worker.js, advanced mode): KV short-link
// subscriptions + access-token protection. Also usable as a plain
// Worker entry (src/worker.js is kept in sync).
// Requires: KV binding SUB_STORE; secret/variable SUB_ACCESS_TOKEN.
// Subscription links carry a per-entry HMAC link token derived from
// SUB_ACCESS_TOKEN (see linkTokenFor): the admin secret itself never
// appears in any link, so sharing a link cannot leak admin access.

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type, x-admin-token',
    },
  });
}

function text(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      'access-control-allow-origin': '*',
    },
  });
}

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(str) {
  return decodeURIComponent(escape(atob(str)));
}

function escapeYaml(str = '') {
  // For double-quoted YAML scalars: escape the quote/backslash, spell
  // out tabs, and flatten line breaks and control characters — a raw
  // CR is a line break to a YAML parser just like LF.
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function splitHostAndPort(value) {
  const v = String(value || '').trim();
  if (!v) return { server: '', port: undefined };

  // Bracketed IPv6: [2606:4700::1] or [2606:4700::1]:443
  if (v.startsWith('[')) {
    const m = v.match(/^\[([^\]]+)](?::(\d+))?$/);
    if (m) return { server: m[1], port: m[2] ? Number(m[2]) : undefined };
    return { server: v, port: undefined };
  }

  // More than one colon and no brackets: a bare IPv6 address.
  // Never split a "port" off it: 2606:4700:4700::1111 is one address,
  // the old regex turned it into server "2606:4700:4700:" + port 1111.
  const colonCount = (v.match(/:/g) || []).length;
  if (colonCount > 1) return { server: v, port: undefined };

  if (colonCount === 1) {
    const idx = v.indexOf(':');
    const host = v.slice(0, idx);
    const portStr = v.slice(idx + 1);
    if (/^\d+$/.test(portStr)) return { server: host, port: Number(portStr) };
  }
  return { server: v, port: undefined };
}

function stripBrackets(host) {
  const h = String(host || '').trim();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

// IPv6 literals must be bracketed inside a URL authority (vless://u@[::1]:443)
function formatHostForUrl(host) {
  const h = String(host || '');
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

function parsePreferredEndpoints(input) {
  return String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const hashIdx = line.indexOf('#');
      const value = (hashIdx >= 0 ? line.slice(0, hashIdx) : line).trim();
      const remark = (hashIdx >= 0 ? line.slice(hashIdx + 1) : '').trim();
      const { server, port } = splitHostAndPort(value);
      const badPort = port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535);
      return { server, port, remark, badPort };
    });
}

const MAX_MIXED_SOURCES = 5;

// Split the mixed preferred-IP box into its lines, tagged by kind.
// A line starting with a scheme is meant to be a source link (it gets
// fetched and expanded); every other line is a literal endpoint,
// parsed exactly like the old manual list. The box order is preserved
// in `lines` because generation merges in box order.
function splitMixedPreferred(text) {
  const lines = [];
  const literals = [];
  const urls = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^https?:\/\//i.test(line)) {
      lines.push({ url: line });
      urls.push(line);
    } else {
      lines.push({ text: line });
      literals.push(line);
    }
  }
  return { lines, literals, urls };
}

function safeHost(u) {
  try { return new URL(u).host; } catch { return String(u); }
}

// ---- Preferred-IP API sources (dynamic subscriptions) --------------------
// A dynamic entry follows an external preferred-IP list (typically a
// public CloudflareSpeedTest-style publication) instead of a fixed
// snapshot: /sub responses are rebuilt from the source's latest list.
// The list is cached in KV for an hour; a failed refresh falls back to
// the stale cache, then to the entry's snapshot, so a dead source never
// takes existing subscriptions down with it.
const IP_SOURCE_FRESH_MS = 60 * 60 * 1000;
const IP_SOURCE_RETRY_MS = 5 * 60 * 1000;
const IP_SOURCE_MAX_BYTES = 512 * 1024;
const IP_SOURCE_CACHE_CAP = 500;

function assertSourceUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error('来源地址不是合法 URL');
  }
  if (u.protocol !== 'https:') throw new Error('来源地址必须以 https:// 开头');
  // Credentials in a source URL would be stored on the entry; strip them.
  u.username = '';
  u.password = '';
  // A fragment is never sent to the server, so it identifies nothing:
  // the preferred-IP box teaches "#备注" for literal lines, and a
  // remark typed after a source link must not split one list into
  // several entries / caches.
  u.hash = '';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('来源地址不允许指向内网主机');
  }
  // Private-range checks apply to IP literals only. The URL parser has
  // already canonicalized any typed IP (hex / octal / integer forms all
  // become dotted-quad), so a DNS name that merely starts with digits
  // or "fc" (fcdn.example.com, 10.example.com) is not mistaken for one.
  const bare = host.replace(/^\[|\]$/g, '');
  const isV4Literal = /^(\d{1,3}\.){3}\d{1,3}$/.test(bare);
  const isV6Literal = bare.includes(':');
  if (
    (isV4Literal && /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(bare)) ||
    (isV6Literal && (bare === '::1' || /^(fc|fd|fe80)/.test(bare)))
  ) {
    throw new Error('来源地址不允许指向内网 IP');
  }
  return u.toString();
}

function extractEndpointTokens(text) {
  // One candidate endpoint per line, however the source formats it:
  // plain txt, CSV speed-test results (endpoint in the first cell), or
  // stray text around the addresses. A CSV's separate port column is
  // not picked up — endpoints fall back to the node's own port.
  const tokens = [];
  const re = /\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?|(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?|\b((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?::(\d{1,5}))?/;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length && i < 20000 && tokens.length < 2000; i++) {
    // An endpoint is short; matching only a line's head bounds the regex
    // work a hostile or broken source can make us do per line.
    const m = lines[i].slice(0, 600).match(re);
    if (!m) continue;
    if (m[1]) tokens.push(m[2] ? `[${m[1]}]:${m[2]}` : m[1]);
    else if (m[3]) tokens.push(m[4] ? `${m[3]}:${m[4]}` : m[3]);
    else if (m[5]) tokens.push(m[6] ? `${m[5]}:${m[6]}` : m[5]);
  }
  return tokens;
}

function jsonCandidateStrings(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const strings = [];
  const walk = (v, depth) => {
    if (depth > 6 || strings.length > 5000) return;
    if (typeof v === 'string') {
      strings.push(v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (v && typeof v === 'object') {
      const preferred = v.ip ?? v.address ?? v.host ?? v.endpoint;
      if (typeof preferred === 'string') {
        strings.push(Number.isInteger(v.port) ? `${preferred}:${v.port}` : preferred);
      }
      Object.values(v).forEach((x) => walk(x, depth + 1));
    }
  };
  walk(data, 0);
  return strings;
}

// Read a response body with a hard byte cap, enforced WHILE streaming
// (a post-hoc length check would still buffer an unbounded body first).
async function readBodyCapped(resp) {
  const declared = Number(resp.headers?.get?.('content-length') || 0);
  if (declared > IP_SOURCE_MAX_BYTES) throw new Error('来源内容过大（超过 512KB）');
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const t = await resp.text();
    if (t.length > IP_SOURCE_MAX_BYTES) throw new Error('来源内容过大（超过 512KB）');
    return t;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > IP_SOURCE_MAX_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error('来源内容过大（超过 512KB）');
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

async function fetchIpSource(rawUrl) {
  const url = assertSourceUrl(rawUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  let text;
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'cloudflaresub (preferred-ip source)', accept: 'text/plain, application/json, */*' },
    });
    if (!resp.ok) throw new Error(`来源返回 HTTP ${resp.status}`);
    // A redirect must not smuggle the fetch to an http or private
    // target the original URL check would have rejected.
    if (resp.url) assertSourceUrl(resp.url);
    // The body read stays inside the abort window: a slow-drip source
    // cannot hold a /sub refresh open past the same 5 seconds.
    text = await readBodyCapped(resp);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('来源拉取超时（5 秒）');
    throw e instanceof Error ? e : new Error('来源拉取失败');
  } finally {
    clearTimeout(timer);
  }
  const jsonStrings = jsonCandidateStrings(text);
  const candidates = jsonStrings
    ? jsonStrings.flatMap((s) => extractEndpointTokens(s))
    : extractEndpointTokens(text);
  const parsed = parsePreferredEndpoints(candidates.join('\n'));
  const seen = new Set();
  const endpoints = [];
  for (const ep of parsed) {
    if (ep.badPort || !ep.server) continue;
    const key = `${ep.server}:${ep.port ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({ server: ep.server, port: ep.port, remark: ep.remark || '' });
    if (endpoints.length >= IP_SOURCE_CACHE_CAP) break;
  }
  return { url, candidates: candidates.length, endpoints };
}

async function readIpCache(env, url) {
  const raw = await env.SUB_STORE.get(`ipcache:${await sha256Hex(url)}`);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return c && Array.isArray(c.endpoints) ? c : null;
  } catch {
    return null;
  }
}

async function writeIpCache(env, url, cache) {
  await env.SUB_STORE.put(`ipcache:${await sha256Hex(url)}`, JSON.stringify(cache));
}

// Endpoints for a source URL: fresh KV cache, then a live fetch, then
// the stale cache. Throws only when there is nothing usable at all.
async function getSourceEndpoints(env, rawUrl, now = Date.now()) {
  const url = assertSourceUrl(rawUrl);
  const cached = await readIpCache(env, url);
  if (cached && now - (cached.fetchedAt || 0) < IP_SOURCE_FRESH_MS) {
    return { url, endpoints: cached.endpoints, fromCache: true, fetchedAt: cached.fetchedAt };
  }
  if (cached && now - (cached.lastAttempt || 0) < IP_SOURCE_RETRY_MS) {
    return { url, endpoints: cached.endpoints, fromCache: true, fetchedAt: cached.fetchedAt };
  }
  const fetchStartedAt = Date.now();
  try {
    const fresh = await fetchIpSource(url);
    if (!fresh.endpoints.length) throw new Error('来源没有返回可用的优选地址');
    await writeIpCache(env, url, { url, fetchedAt: now, lastAttempt: now, endpoints: fresh.endpoints });
    return { url, endpoints: fresh.endpoints, fromCache: false, fetchedAt: now, candidates: fresh.candidates };
  } catch (e) {
    // Source trouble is the classic hard-to-see failure: leave a
    // redacted trace (hashed host, coarse error kind, duration) in the
    // diagnostics ring. The URL itself never enters the ring.
    let host = 'h:none';
    try { host = await diagHash(env, `host:${new URL(url).hostname}`); } catch {}
    if (cached) {
      await writeIpCache(env, url, { ...cached, lastAttempt: now });
      await diagRecord(env, {
        kind: 'ip-source', host, result: 'stale-cache', err: sourceErrKind(e), ms: Date.now() - fetchStartedAt,
      });
      return { url, endpoints: cached.endpoints, fromCache: true, fetchedAt: cached.fetchedAt, refreshError: e.message };
    }
    await diagRecord(env, {
      kind: 'ip-source', host, result: 'failed', err: sourceErrKind(e), ms: Date.now() - fetchStartedAt,
    });
    throw e;
  }
}

// A refresh that could not reach a source must not erase the snapshot
// that source accumulated: while the source is down and its cache entry
// is gone, the stored snapshot is the only thing keeping its endpoints
// in the pool. Carry the previous snapshot over for every source that
// failed THIS round (its fresh snapshot is empty then), and rebuild
// the merged fallback so it still contains those endpoints too.
function carryOverFailedSnapshots(next, prev, sourceResults) {
  if (!prev || !Array.isArray(next.sources)) return;
  const failed = new Set(sourceResults.filter((r) => r.error).map((r) => r.url));
  if (!failed.size) return;
  const prevByUrl = new Map();
  if (Array.isArray(prev.sources)) {
    for (const s of prev.sources) if (s && s.url) prevByUrl.set(s.url, s.endpoints || []);
  } else if (prev.sourceUrl) {
    prevByUrl.set(prev.sourceUrl, prev.endpoints || []);
  }
  let restored = false;
  for (const s of next.sources) {
    if (!failed.has(s.url) || (s.endpoints && s.endpoints.length)) continue;
    const old = prevByUrl.get(s.url);
    if (old && old.length) {
      s.endpoints = old;
      restored = true;
    }
  }
  if (!restored) return;
  const seen = new Set();
  const merged = [];
  const push = (ep) => {
    const k = `${ep.server}:${ep.port ?? ''}`;
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(ep);
    }
  };
  (next.literals || []).forEach(push);
  next.sources.forEach((s) => (s.endpoints || []).forEach(push));
  if (merged.length) next.endpoints = merged;
}

// The endpoints a dynamic entry should serve right now: the entry's
// fixed literal lines plus each source's latest list (via cache), or
// the generation-time snapshot when a source has never been reachable
// since.
async function resolveDynamicEndpoints(env, record) {
  const dyn = record.dynamic;
  const limit = dyn.limit || 10;
  if (Array.isArray(dyn.sources) && dyn.sources.length) {
    const merged = [];
    const seen = new Set();
    const push = (ep) => {
      const key = `${ep.server}:${ep.port ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(ep);
    };
    (Array.isArray(dyn.literals) ? dyn.literals : []).forEach(push);
    for (const src of dyn.sources) {
      let eps = null;
      try {
        const { endpoints } = await getSourceEndpoints(env, src.url);
        const sliced = endpoints.slice(0, limit);
        if (sliced.length) eps = sliced;
      } catch {}
      if (!eps && Array.isArray(src.endpoints)) eps = src.endpoints.slice(0, limit);
      (eps || []).forEach(push);
    }
    if (merged.length) return merged;
    const snapshot = Array.isArray(dyn.endpoints) ? dyn.endpoints : [];
    return snapshot.length ? snapshot : null;
  }
  // Legacy single-source shape (records written before mixed sources).
  try {
    const { endpoints } = await getSourceEndpoints(env, dyn.sourceUrl);
    const sliced = endpoints.slice(0, limit);
    if (sliced.length) return sliced;
  } catch {}
  const snapshot = Array.isArray(dyn.endpoints) ? dyn.endpoints.slice(0, limit) : [];
  return snapshot.length ? snapshot : null;
}

function parseSourceLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  return Math.min(100, Math.max(1, Math.trunc(n)));
}

// ---- Version / update check ----------------------------------------------
// APP_VERSION is this build's version: bump it in the SAME release commit
// as package.json's version field (the deployed site has no other way to
// know its own version — package.json is not part of the upload package).
// The update check asks GitHub for UPDATE_REPO's latest release and
// caches the answer in KV (6h for a hit, 30min for a failure), so the
// endpoint costs a handful of GitHub calls a day at most. It reports
// an explicit checkStatus (ok / stale / failed) so the page can warn
// visibly instead of mistaking "check failed" for "up to date".
const APP_VERSION = '1.6.0';
const UPDATE_REPO = 'realadmin/cloudflaresub';
const VERSION_CACHE_KEY = 'sys:latest-release';
const VERSION_CACHE_MS = 6 * 60 * 60 * 1000;
const VERSION_NEGATIVE_MS = 30 * 60 * 1000;
const VERSION_RETRY_MS = 5 * 60 * 1000;

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function getLatestRelease(env, forceRetry = false) {
  let cached = null;
  try {
    const raw = await env.SUB_STORE.get(VERSION_CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch {}
  const now = Date.now();
  const cachedTag = cached && cached.tag ? String(cached.tag) : '';
  const checkedAt = Number(cached?.checkedAt || 0);
  const lastAttempt = Number(cached?.lastAttempt || (cachedTag ? 0 : cached?.checkedAt) || 0);
  if (cachedTag) {
    if (!forceRetry && now - checkedAt < VERSION_CACHE_MS) {
      return { ...cached, tag: cachedTag, status: 'ok' };
    }
    if (now - lastAttempt < VERSION_RETRY_MS) {
      return {
        ...cached,
        tag: cachedTag,
        status: now - checkedAt < VERSION_CACHE_MS ? 'ok' : 'stale',
      };
    }
  } else if (cached) {
    const retryAfter = forceRetry ? VERSION_RETRY_MS : VERSION_NEGATIVE_MS;
    if (now - lastAttempt < retryAfter) {
      return { tag: null, url: null, checkedAt: null, status: 'failed' };
    }
  }
  try {
    const resp = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'user-agent': 'cloudflaresub (update check)', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`GitHub HTTP ${resp.status}`);
    const data = await resp.json();
    const tag = String(data.tag_name || '').replace(/^v/, '');
    if (!tag) throw new Error('GitHub response has no tag_name');
    const fresh = {
      tag,
      url: data.html_url || `https://github.com/${UPDATE_REPO}/releases`,
      checkedAt: now,
      lastAttempt: now,
    };
    try { await env.SUB_STORE.put(VERSION_CACHE_KEY, JSON.stringify(fresh)); } catch {}
    return { ...fresh, status: 'ok' };
  } catch {
    // A stale answer beats no answer, but it is now labelled "stale" so
    // the page can warn that the latest check failed. The failed attempt
    // is stamped separately: automatic and manual retries are throttled
    // for 5 minutes without pretending the old success just happened.
    if (cachedTag) {
      const stale = { ...cached, tag: cachedTag, checkedAt, lastAttempt: now };
      try { await env.SUB_STORE.put(VERSION_CACHE_KEY, JSON.stringify(stale)); } catch {}
      return { ...stale, status: 'stale' };
    }
    try {
      await env.SUB_STORE.put(VERSION_CACHE_KEY, JSON.stringify({ tag: '', checkedAt: now, lastAttempt: now }));
    } catch {}
    return { tag: null, url: null, checkedAt: null, status: 'failed' };
  }
}

async function handleVersion(request, env) {
  const forceRetry = new URL(request.url).searchParams.get('retry') === '1';
  const result = env.SUB_STORE ? await getLatestRelease(env, forceRetry) : null;
  const latest = result && result.tag ? result : null;
  return json({
    ok: true,
    version: APP_VERSION,
    latest: latest ? latest.tag : null,
    updateAvailable: latest ? compareVersions(latest.tag, APP_VERSION) > 0 : false,
    releaseUrl: latest ? latest.url : `https://github.com/${UPDATE_REPO}/releases`,
    checkStatus: result ? result.status : 'failed',
    checkedAt: latest ? latest.checkedAt || null : null,
  });
}

function parseVmess(link) {
  const raw = link.slice('vmess://'.length).trim();
  const obj = JSON.parse(b64DecodeUtf8(raw));
  return {
    type: 'vmess',
    name: obj.ps || 'vmess',
    server: stripBrackets(obj.add),
    port: Number(obj.port || 443),
    uuid: obj.id,
    cipher: obj.scy || 'auto',
    network: obj.net || 'ws',
    tls: obj.tls === 'tls',
    host: obj.host || '',
    path: obj.path || '/',
    sni: obj.sni || obj.host || '',
    alpn: obj.alpn || '',
    fp: obj.fp || '',
  };
}

function parseUrlLike(link, type) {
  const u = new URL(link);
  return {
    type,
    name: decodeURIComponent(u.hash.replace(/^#/, '')) || type,
    params: Object.fromEntries(u.searchParams),
    server: stripBrackets(u.hostname),
    port: Number(u.port || 443),
    password: type === 'trojan' ? decodeURIComponent(u.username) : undefined,
    uuid: type === 'vless' ? decodeURIComponent(u.username) : undefined,
    network: u.searchParams.get('type') || 'tcp',
    tls: (u.searchParams.get('security') || '').toLowerCase() === 'tls',
    host: u.searchParams.get('host') || u.searchParams.get('sni') || '',
    path: u.searchParams.get('path') || '/',
    sni: u.searchParams.get('sni') || u.searchParams.get('host') || '',
    fp: u.searchParams.get('fp') || '',
    alpn: u.searchParams.get('alpn') || '',
    flow: u.searchParams.get('flow') || '',
  };
}

function parseRawLinks(input) {
  const lines = String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Per-line fault tolerance: one corrupted or half-copied link must not
  // fail the whole batch. Unparsable lines are counted and reported back
  // as skipped instead of throwing the entire generate away.
  const nodes = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      if (line.startsWith('vmess://')) {
        nodes.push(parseVmess(line));
        continue;
      }
      if (line.startsWith('vless://')) {
        nodes.push(parseUrlLike(line, 'vless'));
        continue;
      }
      if (line.startsWith('trojan://')) {
        nodes.push(parseUrlLike(line, 'trojan'));
        continue;
      }
      const decoded = b64DecodeUtf8(line);
      if (/^(vmess|vless|trojan):\/\//m.test(decoded)) {
        const inner = parseRawLinks(decoded);
        nodes.push(...inner.nodes);
        skipped += inner.skipped;
      }
    } catch {
      skipped += 1;
    }
  }
  return { nodes, skipped };
}

function buildNodes(baseNodes, preferredEndpoints, options = {}) {
  const output = [];
  const prefix = (options.namePrefix || '').trim();
  let counter = 0;
  for (const node of baseNodes) {
    for (const ep of preferredEndpoints) {
      counter += 1;
      const nameParts = [];
      if (node.name) nameParts.push(node.name);
      if (prefix) nameParts.push(prefix);
      if (ep.remark) nameParts.push(ep.remark);
      else nameParts.push(String(counter));
      output.push({
        ...node,
        // Names land in line-based config formats (Surge, Clash): a raw
        // newline smuggled in via a link's #fragment could otherwise
        // inject whole config lines into the exported profile.
        name: nameParts.join(' | ').replace(/[\r\n]+/g, ' '),
        server: ep.server,
        port: ep.port || node.port,
        host: options.keepOriginalHost ? node.host : '',
        sni: options.keepOriginalHost ? node.sni : '',
      });
    }
  }
  return output;
}

function encodeVmess(node) {
  const obj = {
    v: '2',
    ps: node.name,
    add: node.server,
    port: String(node.port),
    id: node.uuid,
    aid: '0',
    scy: node.cipher || 'auto',
    net: node.network || 'ws',
    type: 'none',
    host: node.host || '',
    path: node.path || '/',
    tls: node.tls ? 'tls' : '',
    sni: node.sni || '',
    alpn: node.alpn || '',
    fp: node.fp || '',
  };
  return 'vmess://' + b64EncodeUtf8(JSON.stringify(obj));
}

function encodeVless(node) {
  // Start from the node's original query params so fields the parser does not
  // model (e.g. encryption=none) and the original ordering survive a round trip.
  const params = new URLSearchParams(node.params || {});
  params.set('type', node.network || 'ws');
  if (node.tls) params.set('security', 'tls');
  else if ((params.get('security') || '').toLowerCase() === 'tls') params.delete('security');
  if (node.host) params.set('host', node.host); else params.delete('host');
  if (node.sni) params.set('sni', node.sni); else params.delete('sni');
  if (node.path) params.set('path', node.path);
  if (node.alpn) params.set('alpn', node.alpn);
  if (node.fp) params.set('fp', node.fp);
  if (node.flow) params.set('flow', node.flow); else params.delete('flow');
  const qs = params.toString();
  return `vless://${encodeURIComponent(node.uuid)}@${formatHostForUrl(node.server)}:${node.port}${qs ? '?' + qs : ''}#${encodeURIComponent(node.name || '')}`;
}

function encodeTrojan(node) {
  const params = new URLSearchParams(node.params || {});
  params.set('type', node.network || 'ws');
  if (node.tls) params.set('security', 'tls');
  if (node.host) params.set('host', node.host); else params.delete('host');
  if (node.sni) params.set('sni', node.sni); else params.delete('sni');
  if (node.path) params.set('path', node.path);
  if (node.alpn) params.set('alpn', node.alpn);
  if (node.fp) params.set('fp', node.fp);
  const qs = params.toString();
  return `trojan://${encodeURIComponent(node.password)}@${formatHostForUrl(node.server)}:${node.port}${qs ? '?' + qs : ''}#${encodeURIComponent(node.name || '')}`;
}

function encodeNodeLink(node) {
  if (node.type === 'vmess') return encodeVmess(node);
  if (node.type === 'vless') return encodeVless(node);
  if (node.type === 'trojan') return encodeTrojan(node);
  return '';
}

function renderPlain(nodes) {
  // Plain-text node links, one per line, NOT base64-encoded.
  return nodes.map(encodeNodeLink).filter(Boolean).join('\n');
}

function renderRaw(nodes) {
  return b64EncodeUtf8(renderPlain(nodes));
}

function pushClashWsOpts(lines, node) {
  lines.push(
    `    ws-opts:`,
    `      path: "${escapeYaml(node.path || '/')}"`,
    `      headers:`,
    `        Host: "${escapeYaml(node.host || node.sni || '')}"`
  );
}

function renderClash(nodes) {
  const proxies = nodes
    .map((node) => {
      if (node.type === 'vmess') {
        const lines = [
          `  - name: "${escapeYaml(node.name)}"`,
          `    type: vmess`,
          `    server: "${escapeYaml(node.server)}"`,
          `    port: ${Number(node.port) || 0}`,
          `    uuid: "${escapeYaml(node.uuid)}"`,
          `    alterId: 0`,
          `    cipher: "${escapeYaml(node.cipher || 'auto')}"`,
          `    udp: true`,
          `    tls: ${node.tls ? 'true' : 'false'}`,
          `    network: "${escapeYaml(node.network || 'ws')}"`,
        ];

        if (node.sni) {
          lines.push(`    servername: "${escapeYaml(node.sni)}"`);
        }

        if ((node.network || 'ws') === 'ws') {
          pushClashWsOpts(lines, node);
        }

        return lines.join('\n');
      }

      if (node.type === 'vless') {
        const lines = [
          `  - name: "${escapeYaml(node.name)}"`,
          `    type: vless`,
          `    server: "${escapeYaml(node.server)}"`,
          `    port: ${Number(node.port) || 0}`,
          `    uuid: "${escapeYaml(node.uuid)}"`,
          `    udp: true`,
          `    tls: ${node.tls ? 'true' : 'false'}`,
          `    network: "${escapeYaml(node.network || 'ws')}"`,
        ];

        if (node.sni) {
          lines.push(`    servername: "${escapeYaml(node.sni)}"`);
        }

        if ((node.network || 'ws') === 'ws') {
          pushClashWsOpts(lines, node);
        }

        return lines.join('\n');
      }

      if (node.type === 'trojan') {
        const lines = [
          `  - name: "${escapeYaml(node.name)}"`,
          `    type: trojan`,
          `    server: "${escapeYaml(node.server)}"`,
          `    port: ${Number(node.port) || 0}`,
          `    password: "${escapeYaml(node.password || '')}"`,
          `    udp: true`,
        ];

        if (node.sni) {
          lines.push(`    sni: "${escapeYaml(node.sni)}"`);
        }

        if (node.tls !== false) {
          lines.push(`    tls: true`);
        }

        if (node.network) {
          lines.push(`    network: "${escapeYaml(node.network)}"`);
        }

        if (node.network === 'ws') {
          pushClashWsOpts(lines, node);
        }

        return lines.join('\n');
      }

      return '';
    })
    .filter(Boolean);

  const proxyNames = nodes.map(
    (node) => `      - "${escapeYaml(node.name)}"`
  );

  const allGroupMembers = [
    `      - "自动选择"`,
    ...proxyNames,
    `      - DIRECT`,
  ];

  const autoGroupMembers = proxyNames.length ? proxyNames : [`      - DIRECT`];

  return [
    `mixed-port: 7890`,
    `allow-lan: false`,
    `mode: rule`,
    `log-level: info`,
    `ipv6: true`,
    ``,
    `proxies:`,
    ...(proxies.length ? proxies : []),
    ``,
    `proxy-groups:`,
    `  - name: "自动选择"`,
    `    type: url-test`,
    `    url: "http://www.gstatic.com/generate_204"`,
    `    interval: 300`,
    `    tolerance: 50`,
    `    proxies:`,
    ...autoGroupMembers,
    ``,
    `  - name: "节点选择"`,
    `    type: select`,
    `    proxies:`,
    ...allGroupMembers,
    ``,
    `rules:`,
    `  - MATCH,节点选择`,
  ].join('\n');
}

function surgeName(name) {
  // Surge proxy definitions and its comma-separated group list cannot
  // carry raw commas or newlines in a proxy name (a crafted name could
  // otherwise inject config lines or phantom group members). Applied to
  // stored nodes too, so entries created before name sanitizing existed
  // are still safe to export.
  return String(name || '').replace(/[\r\n,]+/g, ' ').trim();
}

function surgeField(value) {
  // Every field on a Surge proxy line is comma-separated and confined
  // to that line: a comma or newline smuggled in through a node link
  // (password, path, host, uuid…) would otherwise forge extra fields
  // or entire config lines — including fake [Proxy] entries.
  return String(value ?? '').replace(/[\r\n,]+/g, ' ').trim();
}

function renderSurge(nodes, baseUrl, linkToken) {
  const proxies = nodes
    .filter((node) => node.type === 'vmess' || node.type === 'trojan')
    .map((node) => {
      if (node.type === 'vmess') {
        return `${surgeName(node.name)} = vmess, ${surgeField(node.server)}, ${surgeField(node.port)}, username=${surgeField(node.uuid)}, ws=true, ws-path=${surgeField(node.path || '/')}, ws-headers=Host:${surgeField(node.host || '')}, tls=${node.tls ? 'true' : 'false'}, sni=${surgeField(node.sni || '')}`;
      }
      return `${surgeName(node.name)} = trojan, ${surgeField(node.server)}, ${surgeField(node.port)}, password=${surgeField(node.password || '')}, sni=${surgeField(node.sni || '')}`;
    });

  return [
    '[General]',
    'skip-proxy = 127.0.0.1, localhost',
    '',
    '[Proxy]',
    ...proxies,
    '',
    '[Proxy Group]',
    'Proxy = select, ' +
      nodes
        .filter((n) => n.type === 'vmess' || n.type === 'trojan')
        .map((n) => surgeName(n.name))
        .join(', '),
    '',
    '[Rule]',
    'FINAL,Proxy',
    '',
    '; token-protected subscription',
    `; ${baseUrl}${linkToken ? `?token=${linkToken}` : ''}`,
  ].join('\n');
}

function createShortId(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

async function createUniqueShortId(env, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const id = createShortId(10);
    const exists = await env.SUB_STORE.get(`sub:${id}`);
    if (!exists) return id;
  }
  throw new Error('无法生成唯一短链接，请稍后再试');
}

function normalizeLines(value = '') {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
    .join('\n');
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildDedupHash(body) {
  const normalized = {
    nodeLinks: normalizeLines(body.nodeLinks || ''),
    preferredIps: normalizeLines(body.preferredIps || ''),
    namePrefix: String(body.namePrefix || '').trim(),
    keepOriginalHost: body.keepOriginalHost !== false,
  };
  return sha256Hex(JSON.stringify(normalized));
}

// Dynamic dedup identities are synthetic strings whose lines start
// with `api:` / `mix:`. A static paste containing such a line could
// hash-collide with a real dynamic identity and silently merge two
// different entries into one, so static hash inputs carrying one get
// a marker line no identity can contain (`static:` — identity lines
// are endpoint renderings with numeric ports or https URLs). Ordinary
// static text hashes exactly as before: existing entries keep
// refreshing in place.
function staticDedupText(text) {
  const hasIdentityLine = normalizeLines(text)
    .split('\n')
    .some((l) => l.startsWith('api:') || l.startsWith('mix:'));
  return hasIdentityLine ? `${text}\nstatic:` : text;
}

// A length cap applied by code units can split an emoji's surrogate
// pair; drop a dangling half so stored text never renders as �.
function dropDanglingSurrogate(s) {
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xd800 && c <= 0xdbff ? s.slice(0, -1) : s;
}

function sanitizeNote(value) {
  // Owner-written remark identifying an entry (e.g. which VPS it belongs to).
  return dropDanglingSurrogate(
    String(value ?? '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 80),
  );
}

const MAX_TAGS_PER_ENTRY = 10;
const MAX_TAG_LENGTH = 24;

// Entry tags: free-form labels for grouping/filtering entries in the
// admin list. Stored as an array on the record itself (like the note),
// so they expire and delete with the entry and need no index keys.
// Normalization: whitespace-collapsed, trimmed, capped per tag and per
// entry, deduped case-insensitively (first spelling wins). Only string
// members are tags at all — coercing anything else would mint junk
// labels like "[object Object]".
function sanitizeTags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = dropDanglingSurrogate(
      raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TAG_LENGTH),
    ).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_ENTRY) break;
  }
  return out;
}

function notePointerKey(note, id) {
  return `note:${note}:${id}`;
}

function buildRecordMetadata(record) {
  const servers = (record.sources || []).map((x) => x.server).filter(Boolean);
  const st = record.storage || { mode: 'permanent' };
  return {
    note: record.note || '',
    createdAt: record.createdAt || '',
    sources: [...new Set(servers)].slice(0, 3).join(',').slice(0, 200),
    out: Array.isArray(record.nodes) ? record.nodes.length : 0,
    retention: st.mode === 'days' ? `days:${st.days}` : 'permanent',
    exp: st.mode === 'days' ? (st.expiresAt || '') : '',
  };
}

// Retention chosen by the owner at generate time:
//   { mode: 'permanent' }           -> stored forever, until manually deleted
//   { mode: 'days', days: 1..3650 } -> KV auto-deletes after that many days
function parseRetention(body) {
  const mode = String(body.storageMode || 'permanent').toLowerCase();
  if (mode !== 'days') return { storage: { mode: 'permanent' } };
  const days = Number(body.retentionDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    return { error: '保留天数需要是 1 到 3650 之间的整数' };
  }
  return { storage: { mode: 'days', days } };
}

// (Re)stamp a record's expiry from "now" and return the TTL to write with.
function applyRetention(record, nowMs) {
  const st = record.storage || { mode: 'permanent' };
  if (st.mode === 'days') {
    const ttl = st.days * 86400;
    record.storage = { mode: 'days', days: st.days, expiresAt: new Date(nowMs + ttl * 1000).toISOString() };
    return ttl;
  }
  record.storage = { mode: 'permanent' };
  return undefined;
}

// TTL to use when rewriting an existing record WITHOUT changing its
// retention plan (e.g. saving a note): count down to the stored expiry.
function remainingTtl(record) {
  const st = record.storage;
  if (!st || st.mode !== 'days') return undefined;
  if (st.expiresAt) {
    const left = Math.ceil((Date.parse(st.expiresAt) - Date.now()) / 1000);
    return Math.max(60, left);
  }
  return st.days ? st.days * 86400 : undefined;
}

// Records are stored permanently by default, or with an expirationTtl
// when the owner picked a retention period. Also maintains a
// human-readable `note:<remark>:<id>` pointer key so the owner can tell
// entries apart at a glance in the Cloudflare KV browser, where only
// key names are visible in the list.
async function putRecord(env, id, record, prevNote = undefined, ttlSeconds = undefined) {
  const opts = { metadata: buildRecordMetadata(record) };
  if (ttlSeconds) opts.expirationTtl = ttlSeconds;
  await env.SUB_STORE.put(`sub:${id}`, JSON.stringify(record), opts);
  if (prevNote && prevNote !== record.note) {
    await env.SUB_STORE.delete(notePointerKey(prevNote, id));
  }
  if (record.note) {
    // The pointer shares the record's lifetime: writing it without the
    // TTL used to leave orphan note keys behind after timed entries
    // expired on their own.
    const pointerOpts = ttlSeconds ? { expirationTtl: ttlSeconds } : {};
    await env.SUB_STORE.put(notePointerKey(record.note, id), id, pointerOpts);
  }
}

async function handleGenerate(request, env, url) {
  if (!env.SUB_STORE) {
    return json({ ok: false, error: '服务端未绑定 KV：请在 Pages 项目 Settings -> Bindings 中添加 KV namespace，变量名必须为 SUB_STORE，然后重新部署' }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  // Generating writes to KV, so once an admin token exists it is required
  // here too — otherwise anyone who finds the page could fill the store
  // and burn the KV write quota. The page sends the same token the owner
  // already keeps in the admin section's token box.
  if (env.SUB_ACCESS_TOKEN) {
    const denied = await checkAdmin(request, env, url, body);
    if (denied) {
      return json({ ok: false, error: '生成订阅需要管理令牌：请先在页面下方「KV 条目管理」处填入 SUB_ACCESS_TOKEN（生成与管理共用同一个令牌）' }, 403);
    }
  }
  // Cap the name prefix before it reaches the dedup hash and every node
  // name, so an oversized prefix cannot bloat records or outputs.
  body.namePrefix = String(body.namePrefix || '').trim().slice(0, 100);

  const parsed = parseRawLinks(body.nodeLinks || '');
  // Nodes whose own port is unusable (e.g. a hand-written vmess JSON
  // carrying port 99999) are dropped like unparsable lines.
  const baseNodes = parsed.nodes.filter(
    (n) => Number.isInteger(n.port) && n.port >= 1 && n.port <= 65535,
  );
  const skippedLines = parsed.skipped + (parsed.nodes.length - baseNodes.length);
  if (!baseNodes.length) return json({ ok: false, error: '没有识别到可用节点' }, 400);

  // Preferred endpoints come from ONE mixed box: literal lines are a
  // fixed snapshot, while lines that are https URLs are sources the
  // entry keeps following (a dynamic subscription). No URL lines at
  // all = a static entry, exactly like the old manual mode. The legacy
  // ipMode:'api' payload folds into the same path — its sourceUrl is
  // treated as the box's only line.
  let mixedText = String(body.preferredIps || '');
  if (body.ipMode === 'api' && body.sourceUrl) mixedText = String(body.sourceUrl);
  const mixed = splitMixedPreferred(mixedText);
  const limit = parseSourceLimit(body.sourceLimit);
  // Validate + normalize the source URLs up front: a URL-shaped line
  // was typed deliberately, so a bad one fails loudly here instead of
  // being silently dropped like a stray bad IP line. The NORMALIZED
  // URL (host lowercased, default port dropped) is the source's
  // identity: spelling variants dedup onto one source.
  let sourceUrls;
  try {
    sourceUrls = [...new Set(mixed.urls.map((u) => assertSourceUrl(u)))];
  } catch (e) {
    return json({ ok: false, error: `优选 IP 来源链接不可用：${e.message || e}` }, 400);
  }
  if (sourceUrls.length > MAX_MIXED_SOURCES) {
    return json({ ok: false, error: `来源链接最多 ${MAX_MIXED_SOURCES} 个，当前有 ${sourceUrls.length} 个` }, 400);
  }
  const literalEndpoints = parsePreferredEndpoints(mixed.literals.join('\n'));
  if (literalEndpoints.some((ep) => ep.badPort)) {
    return json({ ok: false, error: '优选地址的端口需要在 1 到 65535 之间' }, 400);
  }
  // Fetch every source in parallel; each keeps the cache / stale-cache
  // fallbacks of getSourceEndpoints. A source with nothing usable at
  // all is skipped (and named in the warnings) as long as something
  // else produced endpoints — it stays on the entry and heals itself
  // on a later refresh.
  const sourceResults = await Promise.all(sourceUrls.map(async (u) => {
    try {
      const s = await getSourceEndpoints(env, u);
      return { url: s.url, endpoints: s.endpoints, total: s.endpoints.length, fromCache: !!s.fromCache, error: null };
    } catch (e) {
      return { url: u, endpoints: [], total: 0, fromCache: false, error: e.message || String(e) };
    }
  }));
  const resultByUrl = new Map(sourceResults.map((r) => [r.url, r]));
  // Merge in box order: literal lines stay in place, source lines
  // expand to their (limited) list. Source endpoints dedupe against
  // everything already emitted (first occurrence wins, like the source
  // adapter itself); literal lines keep the old no-dedupe behaviour.
  const preferredEndpoints = [];
  const seenEp = new Set();
  const epKey = (ep) => `${ep.server}:${ep.port ?? ''}`;
  const contributed = new Map(); // source url -> endpoints actually merged
  for (const line of mixed.lines) {
    if (line.url) {
      let key;
      try { key = assertSourceUrl(line.url); } catch { continue; }
      const r = resultByUrl.get(key);
      if (!r || r.error) continue;
      for (const ep of r.endpoints.slice(0, limit)) {
        if (seenEp.has(epKey(ep))) continue;
        seenEp.add(epKey(ep));
        preferredEndpoints.push(ep);
        contributed.set(key, (contributed.get(key) || 0) + 1);
      }
    } else {
      const ep = parsePreferredEndpoints(line.text)[0];
      if (!ep) continue;
      seenEp.add(epKey(ep));
      preferredEndpoints.push(ep);
    }
  }
  if (!preferredEndpoints.length) {
    const firstErr = sourceResults.find((r) => r.error);
    if (firstErr) {
      return json({ ok: false, error: `优选 IP 来源拉取失败：${firstErr.error}` }, 400);
    }
    return json({ ok: false, error: '没有识别到可用优选地址' }, 400);
  }
  let dynamic = null;
  let sourceInfo = null;
  if (sourceUrls.length) {
    dynamic = {
      // The first source stays in sourceUrl for older readers (list
      // badges, legacy backfill); sources[] is the full picture, each
      // with its own snapshot for the /sub fallback chain.
      sourceUrl: sourceUrls[0],
      sources: sourceResults.map((r) => ({ url: r.url, endpoints: r.endpoints.slice(0, limit) })),
      limit,
      literals: literalEndpoints,
      endpoints: preferredEndpoints,
      snapshotAt: new Date().toISOString(),
    };
    sourceInfo = {
      total: sourceResults.reduce((n, r) => n + r.total, 0),
      fromCache: sourceResults.every((r) => r.fromCache || !!r.error),
      failed: sourceResults.filter((r) => r.error),
    };
  }

  const options = {
    namePrefix: body.namePrefix || '',
    keepOriginalHost: body.keepOriginalHost !== false,
  };

  // The output is the full cartesian product; without a ceiling, a big
  // pasted IP list (a normal thing to have) times a few dozen nodes
  // would build a record past KV's 25 MB value limit and fail with an
  // unexplained 500. Refuse early with the actual numbers instead.
  const MAX_OUTPUT_NODES = 10000;
  if (baseNodes.length * preferredEndpoints.length > MAX_OUTPUT_NODES) {
    return json({
      ok: false,
      error: `节点与优选地址的组合过多：将生成 ${baseNodes.length * preferredEndpoints.length} 个节点，超过上限 ${MAX_OUTPUT_NODES} 个。请减少节点数量或优选地址数量。`,
    }, 400);
  }

  const nodes = buildNodes(baseNodes, preferredEndpoints, options);
  // Remember where the nodes came from BEFORE expansion overwrites the
  // server with a preferred endpoint: this is how the owner tells which
  // VPS an entry belongs to.
  const sources = baseNodes.map((n) => ({
    type: n.type, name: n.name, server: n.server, port: n.port,
  }));
  // The note is metadata only: it is NOT part of the dedup hash.
  const providedNote = typeof body.note === 'string' && body.note.trim() !== ''
    ? sanitizeNote(body.note)
    : null;
  // Tags are metadata too (also NOT in the dedup hash). They follow an
  // explicit-field rule, stricter than the note's: the field must be
  // present to change anything. Absent = a fresh entry starts tagless
  // and a refresh keeps the entry's tags; present (even an empty
  // array) = replace wholesale. The generate form only sends the field
  // when the owner actually touched the tag picker, so an incidental
  // regeneration can never wipe an entry's tags.
  const providedTags = Array.isArray(body.tags) ? sanitizeTags(body.tags) : null;
  // Raw form inputs, kept so this entry can later be backfilled into the
  // generate form for editing (exact restore). Entries created before this
  // field existed are reconstructed from their stored nodes instead.
  const inputs = {
    nodeLinks: String(body.nodeLinks || '').slice(0, 100000),
    // The mixed box is stored verbatim: backfill restores it exactly,
    // URL lines and literal lines alike.
    preferredIps: mixedText.slice(0, 50000),
    ipMode: dynamic ? 'mixed' : 'manual',
    sourceUrl: dynamic ? dynamic.sourceUrl : '',
    sourceLimit: dynamic ? dynamic.limit : 10,
  };
  const retention = parseRetention(body);
  if (retention.error) return json({ ok: false, error: retention.error }, 400);

  // A dynamic entry's identity is its nodes + its literal endpoints +
  // its SOURCE SET (not whichever IPs the sources happen to return
  // today), so re-generating while a list rotates still lands on the
  // same entry and refreshes it. A single source with no literals
  // keeps the legacy `api:` identity, so entries created by the old
  // two-mode form refresh in place instead of duplicating.
  let dedupBody = body;
  if (dynamic) {
    const litPart = literalEndpoints
      .map((ep) => `${ep.server}:${ep.port ?? ''}#${ep.remark || ''}`)
      .join('\n');
    const identity = sourceUrls.length === 1 && literalEndpoints.length === 0
      ? `api:${sourceUrls[0]}|${limit}`
      : `mix:${litPart}|${[...sourceUrls].sort().join('\n')}|${limit}`;
    dedupBody = { ...body, preferredIps: identity };
  } else {
    dedupBody = { ...body, preferredIps: staticDedupText(String(body.preferredIps || '')) };
  }
  const dedupHash = await buildDedupHash(dedupBody);
  const dedupKey = `dedup:${dedupHash}`;

  let id = await env.SUB_STORE.get(dedupKey);
  let record;

  if (!id) {
    id = await createUniqueShortId(env);
    record = {
      version: 2,
      createdAt: new Date().toISOString(),
      note: providedNote || '',
      tags: providedTags || [],
      storage: retention.storage,
      dedupHash,
      sources,
      options,
      inputs,
      nodes,
      ...(dynamic ? { dynamic, baseNodes } : {}),
    };
    const ttl = applyRetention(record, Date.now());
    await putRecord(env, id, record, undefined, ttl);
    await env.SUB_STORE.put(dedupKey, id, ttl ? { expirationTtl: ttl } : {});
  } else {
    // Same content generated again: reuse the entry. Rewriting it without
    // a TTL also migrates older (7-day expiry) entries to permanent
    // storage, backfills sources, and applies a newly provided note.
    const raw = await env.SUB_STORE.get(`sub:${id}`);
    if (raw) {
      record = JSON.parse(raw);
      const prevNote = record.note || '';
      if (providedNote !== null) record.note = providedNote;
      if (providedTags !== null) record.tags = providedTags;
      if (!record.sources) record.sources = sources;
      if (!record.dedupHash) record.dedupHash = dedupHash;
      // Same content => the inputs are the same too; backfill them onto
      // legacy records so their owner can edit them via form backfill.
      if (!record.inputs) record.inputs = inputs;
      // A dynamic entry re-generated against its source refreshes the
      // stored snapshot and base nodes (retention below restarts too).
      if (dynamic) {
        carryOverFailedSnapshots(dynamic, record.dynamic, sourceResults);
        record.dynamic = dynamic;
        record.baseNodes = baseNodes;
        record.inputs = inputs;
        record.nodes = nodes;
      }
      // The retention picked this time replaces the previous plan, and the
      // countdown restarts from now.
      record.storage = retention.storage;
      record.updatedAt = new Date().toISOString();
      const ttl = applyRetention(record, Date.now());
      await putRecord(env, id, record, prevNote, ttl);
      await env.SUB_STORE.put(dedupKey, id, ttl ? { expirationTtl: ttl } : {});
    } else {
      record = {
        version: 2,
        createdAt: new Date().toISOString(),
        note: providedNote || '',
        tags: providedTags || [],
        storage: retention.storage,
        dedupHash,
        sources,
        options,
        inputs,
        nodes,
        ...(dynamic ? { dynamic, baseNodes } : {}),
      };
      const ttl = applyRetention(record, Date.now());
      await putRecord(env, id, record, undefined, ttl);
    }
  }

  const origin = url.origin;
  const accessToken = env.SUB_ACCESS_TOKEN || '';
  const linkToken = await linkTokenFor(id, env);
  const withToken = (target) => {
    const q = new URLSearchParams();
    if (target) q.set('target', target);
    if (linkToken) q.set('token', linkToken);
    const qs = q.toString();
    return `${origin}/sub/${id}${qs ? `?${qs}` : ''}`;
  };

  return json({
    ok: true,
    deduplicated: true,
    shortId: id,
    urls: {
      auto: withToken(''),
      raw: withToken('raw'),
      plain: withToken('plain'),
      clash: withToken('clash'),
      surge: withToken('surge'),
    },
    note: record.note || '',
    tags: sanitizeTags(record.tags),
    storage: record.storage || { mode: 'permanent' },
    links: nodes.map(encodeNodeLink).filter(Boolean),
    plainText: renderPlain(nodes),
    counts: {
      inputNodes: baseNodes.length,
      preferredEndpoints: preferredEndpoints.length,
      outputNodes: nodes.length,
    },
    preview: nodes.map((node) => ({
      name: node.name,
      type: node.type,
      server: node.server,
      port: node.port,
      host: node.host || '',
      sni: node.sni || '',
    })),
    dynamic: dynamic
      ? {
          sourceUrl: dynamic.sourceUrl,
          limit: dynamic.limit,
          sourceTotal: sourceInfo.total,
          fromCache: sourceInfo.fromCache,
          sources: sourceResults.map((r) => ({
            url: r.url,
            total: r.total,
            used: contributed.get(r.url) || 0,
            fromCache: r.fromCache,
            error: r.error,
          })),
        }
      : null,
    warnings: [
      ...(accessToken ? [] : ['未检测到 SUB_ACCESS_TOKEN，订阅链接将没有第二层访问保护。']),
      ...(skippedLines > 0 ? [`有 ${skippedLines} 行节点链接无法解析或端口不可用，已跳过。`] : []),
      ...(dynamic && sourceUrls.length === 1 && !sourceInfo.failed.length
        ? [`动态订阅：将自动跟随来源的最新优选 IP（约每小时刷新；来源不可用时用上次快照兜底）。来源现有 ${sourceInfo.total} 个优选地址，本次使用前 ${dynamic.limit} 个。`]
        : []),
      ...(dynamic && sourceUrls.length > 1
        ? [`动态订阅：将自动跟随 ${sourceUrls.length} 个来源的最新优选 IP（约每小时刷新；来源不可用时用上次快照兜底）。`]
        : []),
      ...(dynamic
        ? sourceInfo.failed.map((r) => `来源 ${safeHost(r.url)} 本次拉取失败，已跳过；订阅仍会跟随它，恢复后自动生效。`)
        : []),
    ],
  });
}

// Constant-time string comparison (via digests, so neither content nor
// length leaks through timing).
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a || ''))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b || ''))),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function checkAdmin(request, env, url, body) {
  const expected = env.SUB_ACCESS_TOKEN;
  if (!expected) {
    return json({ ok: false, error: '未设置 SUB_ACCESS_TOKEN，出于安全原因管理接口已禁用，请先在 Pages 项目里设置该 Secret' }, 403);
  }
  // Body field or the dedicated header only — never the URL query, so the
  // admin token stays out of browser history, proxy logs and referrers.
  const provided =
    (body && typeof body.token === 'string' && body.token) ||
    request.headers.get('x-admin-token') ||
    '';
  if (!(await safeEqual(provided, expected))) {
    return json({ ok: false, error: '管理令牌不正确' }, 403);
  }
  return null;
}

async function handleList(request, env, url) {
  if (!env.SUB_STORE) return json({ ok: false, error: 'SUB_STORE KV 未绑定' }, 500);
  const denied = await checkAdmin(request, env, url, null);
  if (denied) return denied;

  // The key list only tells us WHICH entries exist. Every displayed
  // field is read from the record itself: list-index metadata lags
  // fresh writes and caused false failure reports and stale displays.
  // One source of truth: the record.
  const items = [];
  let cursor;
  do {
    const page = await env.SUB_STORE.list({ prefix: 'sub:', cursor, limit: 256 });
    for (const key of page.keys) {
      const id = key.name.slice('sub:'.length);
      const meta = key.metadata || {};
      const item = {
        id,
        note: meta.note || '',
        tags: [],
        createdAt: meta.createdAt || null,
        sources: meta.sources ? meta.sources.split(',').filter(Boolean) : [],
        outputNodes: typeof meta.out === 'number' ? meta.out : null,
        storage: meta.retention && meta.retention.startsWith('days:')
          ? { mode: 'days', days: Number(meta.retention.slice(5)) || null, expiresAt: meta.exp || null }
          : { mode: 'permanent' },
        dynamic: false,
      };
      const raw = await env.SUB_STORE.get(key.name);
      if (raw === null || raw === undefined) {
        // Ghost key: the list index still enumerates a just-deleted entry.
        // The record is gone, so the entry must not reappear in the list.
        continue;
      }
      {
        try {
          const rec = JSON.parse(raw);
          item.note = rec.note || '';
          // Sanitize on read: a record hand-edited in KV can carry
          // non-string tag members, and raw passthrough lets one
          // corrupt record break the whole admin UI downstream.
          item.tags = sanitizeTags(rec.tags);
          item.createdAt = rec.createdAt || item.createdAt;
          const servers = [...new Set((rec.sources || []).map((x) => x.server).filter(Boolean))];
          if (servers.length) item.sources = servers;
          if (Array.isArray(rec.nodes)) item.outputNodes = rec.nodes.length;
          item.storage = rec.storage || { mode: 'permanent' };
          item.dynamic = !!rec.dynamic;
          if (rec.dynamic && rec.dynamic.sourceUrl) item.sourceUrl = rec.dynamic.sourceUrl;
          if (rec.dynamic) {
            item.sourceCount = Array.isArray(rec.dynamic.sources)
              ? rec.dynamic.sources.length
              : (rec.dynamic.sourceUrl ? 1 : 0);
          }
        } catch {}
      }
      item.linkToken = await linkTokenFor(id, env);
      items.push(item);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return json({ ok: true, count: items.length, items });
}

// ---- Form backfill -------------------------------------------------------
// The generate form's inputs for an existing entry, for form backfill.
// Newer records store the raw inputs verbatim (exact). Older records
// are reconstructed from their expanded nodes: generation laid nodes
// out as sources x endpoints, so a source's original node is its first
// expanded node with the source's own server/port/name swapped back,
// and the preferred list is rebuilt per endpoint position.
function nameTailOf(nodeName, sourceName, prefix) {
  let rest = String(nodeName || '');
  if (sourceName && rest.startsWith(`${sourceName} | `)) rest = rest.slice(sourceName.length + 3);
  else if (sourceName && rest === sourceName) rest = '';
  if (prefix && rest.startsWith(`${prefix} | `)) rest = rest.slice(prefix.length + 3);
  else if (prefix && rest === prefix) rest = '';
  return rest;
}

function reconstructInputs(record) {
  const sources = Array.isArray(record.sources) ? record.sources : [];
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  if (!sources.length || !nodes.length || nodes.length % sources.length !== 0) return null;
  const perSource = nodes.length / sources.length;
  if (!perSource) return null;
  const prefix = (record.options?.namePrefix || '').trim();
  const keep = record.options?.keepOriginalHost !== false;

  const endpointLines = [];
  for (let j = 0; j < perSource; j++) {
    const first = nodes[j];
    const ports = sources.map((s, i) => nodes[i * perSource + j].port);
    // If every source kept its own port at this position, the endpoint
    // itself carried no port (each node used its original port).
    const portless = ports.every((p, i) => Number(p) === Number(sources[i].port));
    // A generated name ends with either the endpoint remark or a global
    // counter. Identical tails across sources mean a remark (counters
    // differ per source); check the counter pattern explicitly.
    const tails = sources.map((s, i) => nameTailOf(nodes[i * perSource + j].name, s.name, prefix));
    let remark = '';
    if (tails[0] && tails.every((t) => t === tails[0])
        && !tails.every((t, i) => t === String(i * perSource + j + 1))) {
      remark = tails[0];
    }
    let line = formatHostForUrl(first.server);
    if (!portless) line += `:${ports[0]}`;
    if (remark) line += `#${remark}`;
    endpointLines.push(line);
  }

  const links = sources.map((s, i) => {
    const node = { ...nodes[i * perSource], server: s.server, port: s.port, name: s.name };
    if (!keep) { node.host = ''; node.sni = ''; }
    return encodeNodeLink(node);
  });
  if (links.some((l) => !l)) return null;
  return { nodeLinks: links.join('\n'), preferredIps: endpointLines.join('\n') };
}

// A dynamic entry's snapshot endpoints rendered as pasted-list lines.
function snapshotLines(record) {
  const eps = record.dynamic && Array.isArray(record.dynamic.endpoints) ? record.dynamic.endpoints : [];
  return eps
    .map((ep) => (ep.port ? `${formatHostForUrl(ep.server)}:${ep.port}` : ep.server))
    .join('\n');
}

function buildBackfill(record) {
  const base = {
    namePrefix: record.options?.namePrefix || '',
    keepOriginalHost: record.options?.keepOriginalHost !== false,
    note: record.note || '',
    tags: sanitizeTags(record.tags),
    storage: record.storage || { mode: 'permanent' },
  };
  if (record.inputs && typeof record.inputs.nodeLinks === 'string' && record.inputs.nodeLinks) {
    if (record.inputs.ipMode === 'mixed') {
      // Mixed-box entries store the box verbatim; restore it as-is.
      return {
        ...base,
        exact: true,
        nodeLinks: record.inputs.nodeLinks,
        preferredIps: record.inputs.preferredIps || '',
        ipMode: 'mixed',
        sourceUrl: record.inputs.sourceUrl || '',
        sourceLimit: record.inputs.sourceLimit || 10,
      };
    }
    return {
      ...base,
      exact: true,
      nodeLinks: record.inputs.nodeLinks,
      // A dynamic entry stores no pasted list; hand back its snapshot
      // endpoints so switching it to manual mode still has IPs to use.
      preferredIps: record.inputs.preferredIps || snapshotLines(record),
      ipMode: record.inputs.ipMode === 'api' ? 'api' : 'manual',
      sourceUrl: record.inputs.sourceUrl || '',
      sourceLimit: record.inputs.sourceLimit || 10,
    };
  }
  const reconstructed = reconstructInputs(record);
  if (reconstructed) return { ...base, exact: false, ...reconstructed };
  return null;
}

// Direct single-record read for write verification. Deliberately NOT
// built on KV list(): the list index lags fresh writes and made the
// UI's read-back check report false failures; a point get() is prompt.
async function handleEntry(request, env, url) {
  if (!env.SUB_STORE) return json({ ok: false, error: 'SUB_STORE KV 未绑定' }, 500);
  const denied = await checkAdmin(request, env, url, null);
  if (denied) return denied;
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id) return json({ ok: false, error: '缺少条目 id' }, 400);
  const raw = await env.SUB_STORE.get(`sub:${id}`);
  if (!raw) return json({ ok: false, error: '条目不存在' }, 404);
  let record;
  try { record = JSON.parse(raw); } catch { return json({ ok: false, error: '条目数据损坏' }, 500); }
  return json({
    ok: true,
    id,
    note: record.note || '',
    tags: sanitizeTags(record.tags),
    createdAt: record.createdAt || null,
    storage: record.storage || { mode: 'permanent' },
    linkToken: await linkTokenFor(id, env),
    backfill: buildBackfill(record),
  });
}

// Test-fetch a preferred-IP source so the owner can verify an API
// address before generating a dynamic subscription from it. Always
// fetches live (never the cache) and requires the admin token, like
// every other server-side fetch trigger.
// Shared prelude of the POST admin endpoints: KV bound, JSON body
// parsed, admin token verified. Returns { body } or { error }.
async function parseAdminBody(request, env) {
  if (!env.SUB_STORE) return { error: json({ ok: false, error: 'SUB_STORE KV 未绑定' }, 500) };
  let body;
  try { body = await request.json(); } catch { return { error: json({ ok: false, error: '请求体不是合法 JSON' }, 400) }; }
  const denied = await checkAdmin(request, env, new URL(request.url), body);
  return denied ? { error: denied } : { body };
}

async function handleIpSourceTest(request, env) {
  const { body, error } = await parseAdminBody(request, env);
  if (error) return error;
  // Mixed-box mode: the page sends the whole box and every URL line in
  // it is test-fetched live, reported individually.
  if (typeof body.text === 'string') {
    const mixed = splitMixedPreferred(body.text);
    let urls;
    try {
      urls = [...new Set(mixed.urls.map((u) => assertSourceUrl(u)))];
    } catch (e) {
      return json({ ok: false, error: `来源链接不可用：${e.message || e}` }, 400);
    }
    if (!urls.length) return json({ ok: false, error: '框里没有来源链接（以 https:// 开头的一行）' }, 400);
    if (urls.length > MAX_MIXED_SOURCES) {
      return json({ ok: false, error: `来源链接最多 ${MAX_MIXED_SOURCES} 个，当前有 ${urls.length} 个` }, 400);
    }
    const results = await Promise.all(urls.map(async (u) => {
      try {
        const fresh = await fetchIpSource(u);
        return {
          url: fresh.url,
          ok: true,
          candidates: fresh.candidates,
          count: fresh.endpoints.length,
          sample: fresh.endpoints
            .slice(0, 5)
            .map((ep) => (ep.port ? `${formatHostForUrl(ep.server)}:${ep.port}` : ep.server)),
        };
      } catch (e) {
        return { url: u, ok: false, error: e.message || String(e) };
      }
    }));
    return json({ ok: true, results, literalCount: mixed.literals.length });
  }
  try {
    const fresh = await fetchIpSource(String(body.url || ''));
    return json({
      ok: true,
      url: fresh.url,
      candidates: fresh.candidates,
      count: fresh.endpoints.length,
      sample: fresh.endpoints
        .slice(0, 5)
        .map((ep) => (ep.port ? `${formatHostForUrl(ep.server)}:${ep.port}` : ep.server)),
    });
  } catch (e) {
    return json({ ok: false, error: `拉取失败：${e.message || e}` }, 400);
  }
}

async function handleNote(request, env) {
  const { body, error } = await parseAdminBody(request, env);
  if (error) return error;

  const id = String(body.id || '').trim();
  if (!id) return json({ ok: false, error: '缺少条目 id' }, 400);
  const raw = await env.SUB_STORE.get(`sub:${id}`);
  if (!raw) return json({ ok: false, error: '条目不存在' }, 404);

  const record = JSON.parse(raw);
  const prevNote = record.note || '';
  record.note = sanitizeNote(body.note);
  record.updatedAt = new Date().toISOString();
  // Rewrite with whatever time the entry has left, so saving a note never
  // silently extends or shortens a timed entry. Legacy entries (written by
  // the old 7-day code, no storage plan) have no plan and become permanent.
  await putRecord(env, id, record, prevNote, remainingTtl(record));
  return json({ ok: true, id, note: record.note });
}

// Save one entry's tag set (management-area tag editor). Mirrors the
// note save: the record is rewritten with its remaining TTL, and the
// stored (sanitized) tags are returned for the UI's read-back check.
async function handleTagsSave(request, env) {
  const { body, error } = await parseAdminBody(request, env);
  if (error) return error;

  const id = String(body.id || '').trim();
  if (!id) return json({ ok: false, error: '缺少条目 id' }, 400);
  // The tag set must arrive as an array: a missing or malformed field
  // must never silently wipe an entry's tags (the generate endpoint's
  // explicit-field rule exists for exactly this reason).
  if (!Array.isArray(body.tags)) return json({ ok: false, error: 'tags 必须是数组' }, 400);
  const raw = await env.SUB_STORE.get(`sub:${id}`);
  if (!raw) return json({ ok: false, error: '条目不存在' }, 404);

  const record = JSON.parse(raw);
  record.tags = sanitizeTags(body.tags);
  record.updatedAt = new Date().toISOString();
  await putRecord(env, id, record, record.note || '', remainingTtl(record));
  return json({ ok: true, id, tags: record.tags });
}

// The site's tag vocabulary with per-tag entry counts, aggregated live
// from the records (the generate form's tag picker offers these). Like
// the admin list, it enumerates keys but reads every field from the
// records themselves; ghost keys and corrupt records are skipped.
async function handleTagsList(request, env, url) {
  if (!env.SUB_STORE) return json({ ok: false, error: 'SUB_STORE KV 未绑定' }, 500);
  const denied = await checkAdmin(request, env, url, null);
  if (denied) return denied;

  // Aggregate case-insensitively (filtering matches case-insensitively,
  // so 'HK' and 'hk' are one tag with one count), display the first
  // spelling seen, and count ENTRIES, never occurrences — a record
  // hand-edited in KV could otherwise inflate a count with duplicates.
  const byLower = new Map();
  let cursor;
  do {
    const page = await env.SUB_STORE.list({ prefix: 'sub:', cursor, limit: 256 });
    for (const key of page.keys) {
      const raw = await env.SUB_STORE.get(key.name);
      if (raw === null || raw === undefined) continue;
      let rec;
      try { rec = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(rec.tags)) continue;
      const seen = new Set();
      for (const tag of rec.tags) {
        // Skip non-string members outright (hand-edited records): a
        // String() coercion would invent junk tags like 'null'.
        if (typeof tag !== 'string') continue;
        const lower = tag.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        const cur = byLower.get(lower);
        if (cur) cur.count += 1;
        else byLower.set(lower, { tag, count: 1 });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const tags = [...byLower.values()]
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
  return json({ ok: true, tags });
}

// The site-wide display order for the tag vocabulary (the filter bar
// is canonical; suggestion areas follow it). Stored as ONE global
// record on the server so every device sees the same arrangement —
// it used to be a per-browser localStorage preference, which made
// different devices disagree. Written without a TTL: it is settings,
// not an entry.
const TAG_ORDER_KV_KEY = 'meta:tag-order';
const MAX_TAG_ORDER = 500;

function sanitizeTagOrder(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = dropDanglingSurrogate(
      raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TAG_LENGTH),
    ).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAG_ORDER) break;
  }
  return out;
}

async function readTagOrder(env) {
  // Point get on the record itself — never a list() scan (KV list is
  // eventually consistent and would serve stale orders).
  const raw = await env.SUB_STORE.get(TAG_ORDER_KV_KEY);
  if (!raw) return [];
  try {
    return sanitizeTagOrder(JSON.parse(raw)?.order);
  } catch {
    return [];
  }
}

async function handleTagOrderGet(request, env, url) {
  if (!env.SUB_STORE) return json({ ok: false, error: 'SUB_STORE KV 未绑定' }, 500);
  const denied = await checkAdmin(request, env, url, null);
  if (denied) return denied;
  return json({ ok: true, order: await readTagOrder(env) });
}

async function handleTagOrderSave(request, env) {
  const { body, error } = await parseAdminBody(request, env);
  if (error) return error;
  if (!Array.isArray(body.order)) return json({ ok: false, error: 'order 必须是数组' }, 400);
  const order = sanitizeTagOrder(body.order);
  // One-time import semantics: a client carrying its old per-browser
  // order may claim an EMPTY server order, but must never overwrite
  // one that already exists — whichever device imports first wins,
  // and after that the server copy is the only one anyone reads.
  if (body.ifEmpty === true) {
    const existing = await readTagOrder(env);
    if (existing.length) return json({ ok: true, order: existing, imported: false });
  }
  await env.SUB_STORE.put(TAG_ORDER_KV_KEY, JSON.stringify({ order, updatedAt: new Date().toISOString() }));
  return json({ ok: true, order, imported: body.ifEmpty === true });
}

async function handleRetention(request, env) {
  const { body, error } = await parseAdminBody(request, env);
  if (error) return error;

  const id = String(body.id || '').trim();
  if (!id) return json({ ok: false, error: '缺少条目 id' }, 400);
  const raw = await env.SUB_STORE.get(`sub:${id}`);
  if (!raw) return json({ ok: false, error: '条目不存在' }, 404);

  const retention = parseRetention({ storageMode: body.mode, retentionDays: body.days });
  if (retention.error) return json({ ok: false, error: retention.error }, 400);

  const record = JSON.parse(raw);
  record.storage = retention.storage;
  record.updatedAt = new Date().toISOString();
  // Re-apply from NOW: switching to permanent clears the TTL, switching to
  // days restarts the countdown (same rule as regenerating the entry).
  const ttl = applyRetention(record, Date.now());
  await putRecord(env, id, record, record.note || '', ttl);
  if (record.dedupHash) {
    await env.SUB_STORE.put(`dedup:${record.dedupHash}`, id, ttl ? { expirationTtl: ttl } : {});
  }
  return json({ ok: true, id, storage: record.storage });
}

async function handleDelete(request, env) {
  const { body, error } = await parseAdminBody(request, env);
  if (error) return error;

  const id = String(body.id || '').trim();
  if (!id) return json({ ok: false, error: '缺少条目 id' }, 400);
  const raw = await env.SUB_STORE.get(`sub:${id}`);
  let record = null;
  if (raw) { try { record = JSON.parse(raw); } catch {} }

  await env.SUB_STORE.delete(`sub:${id}`);
  if (record && record.note) await env.SUB_STORE.delete(notePointerKey(record.note, id));
  if (record && record.dedupHash) await env.SUB_STORE.delete(`dedup:${record.dedupHash}`);
  return json({ ok: true, id, existed: Boolean(raw) });
}

// ---- Per-entry subscription link tokens -----------------------------------
// A subscription link is meant to be shared, so it must never carry the
// admin secret. Instead the /sub token is an HMAC of the entry id keyed
// by SUB_ACCESS_TOKEN: it opens exactly that one subscription, is
// rejected by every admin endpoint, and cannot open other entries.
// Rotating SUB_ACCESS_TOKEN invalidates all outstanding link tokens.
let hmacKeyCache = { secret: null, promise: null };
function linkTokenFor(id, env) {
  const secret = env.SUB_ACCESS_TOKEN || '';
  if (!secret) return Promise.resolve('');
  if (hmacKeyCache.secret !== secret) {
    hmacKeyCache = {
      secret,
      promise: crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      ),
    };
  }
  return hmacKeyCache.promise
    .then((key) => crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`sub-link:${id}`)))
    .then((sig) =>
      [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32),
    );
}

async function validateLinkToken(url, env, id) {
  if (!env.SUB_ACCESS_TOKEN) return { ok: true };
  const provided = url.searchParams.get('token') || '';
  const expected = await linkTokenFor(id, env);
  if (!provided || !(await safeEqual(provided, expected))) {
    return { ok: false, response: text('Forbidden: invalid token', 403) };
  }
  return { ok: true };
}

async function handleSub(request, env, url) {
  if (!env.SUB_STORE) {
    return text('Server error: SUB_STORE KV binding is missing. Add it in Pages Settings -> Bindings, then redeploy.', 500);
  }
  const id = url.pathname.split('/').pop();
  if (!id) return text('missing id', 400);

  const tokenCheck = await validateLinkToken(url, env, id);
  if (!tokenCheck.ok) return tokenCheck.response;

  const raw = await env.SUB_STORE.get(`sub:${id}`);
  if (!raw) return text('not found', 404);

  const record = JSON.parse(raw);
  let nodes = record.nodes || [];
  if (record.dynamic && Array.isArray(record.baseNodes) && record.baseNodes.length) {
    // Dynamic subscription: rebuild the node list from the source's
    // current preferred IPs. Any failure keeps the stored snapshot.
    const eps = await resolveDynamicEndpoints(env, record);
    if (eps && eps.length) {
      const rebuilt = buildNodes(record.baseNodes, eps, record.options || {});
      if (rebuilt.length) nodes = rebuilt;
    }
  }
  let target = (url.searchParams.get('target') || '').toLowerCase();
  if (!target || target === 'auto') {
    // "Auto" really is adaptive: clients identifying themselves as
    // Clash/Mihomo or Surge get their native format; everything else
    // keeps the historical default (base64 raw), so unknown clients see
    // no behaviour change.
    const ua = (request.headers.get('user-agent') || '').toLowerCase();
    if (/clash|mihomo|stash/.test(ua)) target = 'clash';
    else if (/surge/.test(ua)) target = 'surge';
    else target = 'raw';
  }

  if (target === 'plain' || target === 'links' || target === 'text') {
    return text(renderPlain(nodes), 200, 'text/plain; charset=utf-8');
  }
  if (target === 'clash') {
    return text(renderClash(nodes), 200, 'text/yaml; charset=utf-8');
  }
  if (target === 'surge') {
    return text(
      renderSurge(nodes, url.origin + url.pathname, await linkTokenFor(id, env)),
      200,
      'text/plain; charset=utf-8',
    );
  }
  return text(renderRaw(nodes), 200, 'text/plain; charset=utf-8');
}

// ---- Diagnostics: keyed hashes, event ring, /api/diag ----------------------
// Everything recorded for diagnostics is whitelist-shaped: route
// templates, status codes, durations, counts and keyed short hashes.
// The admin token, node links, preferred IPs, notes, tag names and entry
// contents NEVER enter the ring or the report — that is what makes an
// exported log safe to share for troubleshooting.
let diagHmacCache = { secret: null, promise: null };
function diagHash(env, value) {
  const secret = env.SUB_ACCESS_TOKEN || '';
  if (!secret) return Promise.resolve('h:none');
  if (diagHmacCache.secret !== secret) {
    diagHmacCache = {
      secret,
      promise: crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      ),
    };
  }
  return diagHmacCache.promise
    .then((key) => crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`diag:${value}`)))
    .then((sig) => 'h:' + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 10))
    .catch(() => 'h:error');
}

const DIAG_EVENTS_KEY = 'sys:diag-events';
const DIAG_RING_MAX = 60;
const DIAG_KNOWN_ROUTES = new Set([
  '/api/generate', '/api/list', '/api/entry', '/api/ip-source-test',
  '/api/note', '/api/tags', '/api/tag-order', '/api/retention', '/api/delete',
]);

async function readDiagEvents(env) {
  try {
    const raw = await env.SUB_STORE.get(DIAG_EVENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function diagSig(e) {
  return [e.kind || '', e.route || '', e.status ?? '', e.err || '', e.host || '', e.result || ''].join('|');
}

// Best-effort append; never throws, never blocks a response on failure.
// Consecutive events with the same signature collapse into one entry
// with a repeat count, so a flood (a flaky source retried by every
// subscription fetch, or junk requests) can never evict the rest of
// the history — it occupies exactly one slot, however large it gets.
async function diagRecord(env, evt) {
  try {
    if (!env || !env.SUB_STORE) return;
    const arr = await readDiagEvents(env);
    const last = arr[arr.length - 1];
    if (last && diagSig(last) === diagSig(evt)) {
      last.n = (last.n || 1) + 1;
      last.t = Date.now();
      if (typeof evt.ms === 'number') last.ms = evt.ms;
    } else {
      arr.push({ t: Date.now(), ...evt });
      if (arr.length > DIAG_RING_MAX) arr.splice(0, arr.length - DIAG_RING_MAX);
    }
    await env.SUB_STORE.put(DIAG_EVENTS_KEY, JSON.stringify(arr));
  } catch {}
}

function sourceErrKind(e) {
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return 'timeout';
  const m = String((e && e.message) || '');
  if (m.includes('可用的优选地址')) return 'empty';
  if (/timeout|timed out/i.test(m)) return 'timeout';
  return 'fetch-failed';
}

async function diagCensus(env) {
  const store = env.SUB_STORE;
  const listAll = async (prefix) => {
    const keys = [];
    let cursor;
    do {
      const page = await store.list({ prefix, cursor, limit: 256 });
      keys.push(...page.keys);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return keys;
  };
  const subKeys = await listAll('sub:');
  const census = { entries: subKeys.length, detailSampled: 0 };
  let dynamic = 0;
  let expiring = 0;
  let withTags = 0;
  let withNote = 0;
  const vocab = new Set();
  const hostnames = new Set();
  const sizes = [];
  let oldest = null;
  let newest = null;
  const sampleKeys = subKeys.slice(0, 300);
  const sampleRaws = [];
  for (let i = 0; i < sampleKeys.length; i += 25) {
    const chunk = sampleKeys.slice(i, i + 25);
    sampleRaws.push(...(await Promise.all(chunk.map((k) => store.get(k.name)))));
  }
  for (let idx = 0; idx < sampleKeys.length; idx++) {
    const k = sampleKeys[idx];
    const raw = sampleRaws[idx];
    if (!raw) continue;
    census.detailSampled++;
    // Counted only for records actually read, so `permanent` below
    // shares one denominator and can never go negative when the key
    // list and the values briefly disagree.
    if (k.expiration || (k.metadata && k.metadata.expiresAt)) expiring++;
    sizes.push(raw.length);
    let rec = null;
    try { rec = JSON.parse(raw); } catch {}
    if (!rec) continue;
    if (rec.dynamic) dynamic++;
    if (Array.isArray(rec.tags)) {
      const clean = rec.tags.filter((t) => typeof t === 'string');
      if (clean.length) withTags++;
      for (const t of clean) vocab.add(t.toLowerCase());
    }
    if (typeof rec.note === 'string' && rec.note) withNote++;
    if (typeof rec.createdAt === 'number') {
      oldest = oldest === null ? rec.createdAt : Math.min(oldest, rec.createdAt);
      newest = newest === null ? rec.createdAt : Math.max(newest, rec.createdAt);
    }
    const srcUrls = rec.dynamic && Array.isArray(rec.dynamic.sources)
      ? rec.dynamic.sources.map((s) => s && s.url)
      : rec.dynamic && rec.dynamic.sourceUrl
        ? [rec.dynamic.sourceUrl]
        : [];
    for (const u of srcUrls) {
      try { hostnames.add(new URL(u).hostname); } catch {}
    }
  }
  census.dynamic = dynamic;
  census.expiring = expiring;
  census.permanent = census.detailSampled - expiring;
  census.withTags = withTags;
  census.withNote = withNote;
  census.tagVocab = vocab.size;
  if (sizes.length) {
    sizes.sort((a, b) => a - b);
    census.recordBytes = {
      total: sizes.reduce((a, b) => a + b, 0),
      min: sizes[0],
      p50: sizes[Math.floor(sizes.length / 2)],
      max: sizes[sizes.length - 1],
    };
  }
  if (oldest !== null) {
    census.oldestAgeDays = Math.round((Date.now() - oldest) / 864000) / 100;
    census.newestAgeDays = Math.round((Date.now() - newest) / 864000) / 100;
  }
  census.sourceHosts = [];
  for (const h of hostnames) census.sourceHosts.push(await diagHash(env, `host:${h}`));
  const dedupKeys = await listAll('dedup:');
  census.dedupKeys = dedupKeys.length;
  const cacheKeys = await listAll('ipcache:');
  let cacheFresh = 0;
  let cacheSampled = 0;
  const cacheRaws = await Promise.all(cacheKeys.slice(0, 50).map((k) => store.get(k.name)));
  for (const raw of cacheRaws) {
    if (!raw) continue;
    cacheSampled++;
    try {
      const c = JSON.parse(raw);
      if (c && Date.now() - (c.fetchedAt || 0) < IP_SOURCE_FRESH_MS) cacheFresh++;
    } catch {}
  }
  census.ipcache = { keys: cacheKeys.length, sampled: cacheSampled, freshInSample: cacheFresh };
  const orderRaw = await store.get('meta:tag-order');
  if (!orderRaw) {
    census.tagOrder = { exists: false };
  } else {
    try {
      const o = JSON.parse(orderRaw);
      census.tagOrder = {
        exists: true,
        size: Array.isArray(o.order) ? o.order.length : 0,
        ageSec: o.updatedAt ? Math.max(0, Math.round((Date.now() - o.updatedAt) / 1000)) : null,
      };
    } catch {
      census.tagOrder = { exists: true, corrupt: true };
    }
  }
  return census;
}

async function handleDiag(request, env) {
  const { error } = await parseAdminBody(request, env);
  if (error) return error;
  const store = env.SUB_STORE;
  const diag = {
    version: APP_VERSION,
    serverTime: new Date().toISOString(),
    colo: (request.cf && request.cf.colo) || null,
  };
  try {
    const probeVal = JSON.stringify({ t: Date.now(), r: crypto.randomUUID() });
    const p0 = Date.now();
    await store.put('sys:diag-probe', probeVal);
    const p1 = Date.now();
    const got = await store.get('sys:diag-probe');
    const p2 = Date.now();
    await store.delete('sys:diag-probe');
    diag.kvProbe = { putMs: p1 - p0, getMs: p2 - p1, match: got === probeVal };
  } catch (e) {
    diag.kvProbe = { error: (e && e.name) || 'Error' };
  }
  try {
    diag.census = await diagCensus(env);
  } catch (e) {
    diag.census = { error: (e && e.name) || 'Error' };
  }
  try {
    const rel = await getLatestRelease(env, false);
    diag.versionCheck = {
      status: rel.status,
      latest: rel.tag || null,
      checkedAt: rel.checkedAt || null,
      updateAvailable: rel.tag ? compareVersions(rel.tag, APP_VERSION) > 0 : false,
    };
  } catch {
    diag.versionCheck = { status: 'failed' };
  }
  diag.events = await readDiagEvents(env);
  return json({ ok: true, diag });
}

// Which requests leave a ring entry: every admin/API call except the
// public version check (chatty, low signal) and the diag export itself,
// plus failed subscription fetches. Auth failures (403) are skipped on
// purpose: rejected requests must not write anything, as the security
// audits established.
async function recordApiEvent(env, ctx, request, url, status, ms, errName) {
  if (request.method === 'OPTIONS') return;
  const p = url.pathname;
  if (p === '/api/diag' || p === '/api/version') return;
  const isApi = p.startsWith('/api/');
  const isSub = p.startsWith('/sub/');
  if (!isApi && !isSub) return;
  if (isSub && status === 200) return;
  if (status === 403) return;
  // Only known route templates are recorded. An unknown /api path is
  // caller-controlled text: recording it verbatim would let anyone
  // write arbitrary strings into the (shareable) diagnostics log.
  const routePath = isSub
    ? '/sub/:id'
    : DIAG_KNOWN_ROUTES.has(p)
      ? p
      : '/api/*';
  const evt = {
    kind: 'api',
    route: `${request.method} ${routePath}`,
    status,
    ms,
  };
  if (errName) evt.err = String(errName).slice(0, 40);
  const done = diagRecord(env, evt);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(done);
  else await done;
}

async function dispatch(request, env) {
    const url = new URL(request.url);

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,POST,OPTIONS',
            'access-control-allow-headers': 'content-type, x-admin-token',
          },
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/generate') {
        return await handleGenerate(request, env, url);
      }

      if (request.method === 'GET' && url.pathname === '/api/version') {
        return await handleVersion(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/list') {
        return await handleList(request, env, url);
      }

      if (request.method === 'GET' && url.pathname === '/api/entry') {
        return await handleEntry(request, env, url);
      }

      if (request.method === 'POST' && url.pathname === '/api/ip-source-test') {
        return await handleIpSourceTest(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/note') {
        return await handleNote(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/tags') {
        return await handleTagsList(request, env, url);
      }

      if (request.method === 'POST' && url.pathname === '/api/tags') {
        return await handleTagsSave(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/tag-order') {
        return await handleTagOrderGet(request, env, url);
      }

      if (request.method === 'POST' && url.pathname === '/api/tag-order') {
        return await handleTagOrderSave(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/diag') {
        return await handleDiag(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/retention') {
        return await handleRetention(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/delete') {
        return await handleDelete(request, env);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/sub/')) {
        return await handleSub(request, env, url);
      }

      // Unknown API paths (or wrong methods on known ones) get a JSON
      // 404, not the HTML homepage from the static fallback below.
      if (url.pathname.startsWith('/api/')) {
        return json({ ok: false, error: '接口不存在' }, 404);
      }

      // Pages (advanced mode) always provides the ASSETS binding. In a
      // plain Worker without [assets] it is undefined, and calling
      // env.ASSETS.fetch() throws -> Cloudflare 1101.
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return await env.ASSETS.fetch(request);
      }
      return text('Not found. Static assets are not available: deploy as a Cloudflare Pages project with build output directory "public" (see README).', 404);
}

export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    let url = null;
    try { url = new URL(request.url); } catch {}
    try {
      const response = await dispatch(request, env);
      if (url) await recordApiEvent(env, ctx, request, url, response.status, Date.now() - startedAt, null);
      return response;
    } catch (err) {
      // Never let an uncaught exception bubble up as a bare 1101 page,
      // and never leak internal error details to the caller: the real
      // error goes to the server log only.
      console.error(err);
      if (url) await recordApiEvent(env, ctx, request, url, 500, Date.now() - startedAt, err && err.name);
      return json({ ok: false, error: 'Internal error' }, 500);
    }
  },
};