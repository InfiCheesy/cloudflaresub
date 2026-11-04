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
      // API JSON is same-origin only (the page calls its own /api) and
      // must never be cached: no wildcard CORS grant, no-store.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function text(body, status = 200, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      // No CORS wildcard and no caching: text() carries subscription
      // bodies, which ARE node credentials. Subscription clients do
      // not run CORS, so the wildcard only ever helped a web page
      // that somehow obtained a link read it cross-origin, and a
      // cacheable 200 could leave credentials sitting in a browser
      // or intermediary cache. (json() has always been no-store.)
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
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

// A literal preferred "endpoint" is whatever the owner typed, and the
// parser above splits host:port without judging the host — so a stray
// line (a sentence, or a source URL pasted without its https://) used
// to be stored verbatim as a node server. Judge the host shape here:
// IPv4, an IPv6 literal (hex + colons), or a plausible hostname.
// Source-derived endpoints don't need this: they are regex-extracted
// in IP/domain shapes already.
function isPlausibleHost(server) {
  const s = String(server || '');
  if (!s || s.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.split('.').every((o) => Number(o) <= 255);
  }
  if (s.includes(':')) return /^[0-9a-fA-F:]+$/.test(s);
  return /^[a-zA-Z0-9_]([a-zA-Z0-9_-]*[a-zA-Z0-9_])?(\.[a-zA-Z0-9_]([a-zA-Z0-9_-]*[a-zA-Z0-9_])?)*$/.test(s);
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
  const v4Private = (v4) => /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(v4);
  // IPv4-mapped IPv6 literals survive canonicalization in IPv6 dress
  // ('[::ffff:127.0.0.1]' comes out of the URL parser as
  // '::ffff:7f00:1'), so the prefix checks alone wave them through:
  // decode the embedded IPv4 (dotted or hex-pair tail) and put it
  // through the same private-range test.
  let mappedV4 = null;
  if (bare.startsWith('::ffff:')) {
    const tail = bare.slice('::ffff:'.length);
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(tail)) mappedV4 = tail;
    else {
      const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
      if (m) {
        const hi = parseInt(m[1], 16);
        const lo = parseInt(m[2], 16);
        mappedV4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      }
    }
  }
  if (
    (isV4Literal && v4Private(bare)) ||
    (mappedV4 && v4Private(mappedV4)) ||
    (isV6Literal && (bare === '::1' || bare === '::' || /^(fc|fd|fe80)/.test(bare)))
  ) {
    throw new Error('来源地址不允许指向内网 IP');
  }
  return u.toString();
}

function extractEndpointTokens(text) {
  // Candidate endpoints per line, however the source formats it:
  // plain txt, CSV speed-test results (endpoint in the first cell,
  // port in the second), or stray text around the addresses. Every
  // match on a line counts — a line like "1.1.1.1, 2.2.2.2" carries
  // two endpoints, and silently keeping only the first wasted the
  // rest of the list the owner pasted.
  const tokens = [];
  const re = /\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?|(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?|\b((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?::(\d{1,5}))?/g;
  const lines = String(text).split(/\r?\n/);
  // The CSV port column is honoured ONLY when a header line names
  // the second column as the port: the most widely used speed-test
  // CSV (CloudflareSpeedTest) puts the packets-SENT count there,
  // and reading it as a port silently redirected every node built
  // from such a source to port 4.
  let csvPortColumn = false;
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const cells = lines[i].split(',');
    if (cells.length > 1 && /^(port|端口)$/i.test((cells[1] || '').trim())) {
      csvPortColumn = true;
      break;
    }
  }
  for (let i = 0; i < lines.length && i < 20000 && tokens.length < 2000; i++) {
    // An endpoint is short; matching only a line's head bounds the regex
    // work a hostile or broken source can make us do per line.
    const line = lines[i].slice(0, 600);
    // CSV tables whose header names a port column ("IP,port,colo")
    // carry the port in the second cell: when the first cell is an
    // endpoint without an explicit port and the second cell is a
    // bare port, that port belongs to the endpoint.
    const cells = line.split(',');
    if (csvPortColumn && cells.length > 1) {
      const first = cells[0].trim();
      const second = (cells[1] || '').trim();
      if (first && /^\d{1,5}$/.test(second) && !/[:\]]$/.test(first) && !first.includes(':')) {
        const m = first.match(/^(\[[0-9a-fA-F:]+\]|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})$/);
        if (m) {
          tokens.push(`${first}:${second}`);
          continue;
        }
      }
    }
    for (const m of line.matchAll(re)) {
      if (m[1]) tokens.push(m[2] ? `[${m[1]}]:${m[2]}` : m[1]);
      else if (m[3]) tokens.push(m[4] ? `${m[3]}:${m[4]}` : m[3]);
      else if (m[5]) tokens.push(m[6] ? `${m[5]}:${m[6]}` : m[5]);
      if (tokens.length >= 2000) break;
    }
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

// Is a resolved IP address (from a DNS answer) in a private,
// loopback, link-local or otherwise non-public range? Mirrors the
// literal checks in assertSourceUrl, applied to addresses a source
// hostname RESOLVES to — the literal check alone cannot see those.
function ipAddressIsPrivate(addr) {
  const a = String(addr || '').toLowerCase();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(a)) {
    return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(a);
  }
  if (a.startsWith('::ffff:')) {
    const tail = a.slice('::ffff:'.length);
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(tail)) return ipAddressIsPrivate(tail);
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (m) {
      const v4 = `${parseInt(m[1], 16) >> 8}.${parseInt(m[1], 16) & 255}.${parseInt(m[2], 16) >> 8}.${parseInt(m[2], 16) & 255}`;
      return ipAddressIsPrivate(v4);
    }
  }
  return a === '::1' || a === '::'
    || /^f[cd][0-9a-f]{2}:/.test(a)
    || /^fe[89ab][0-9a-f]:/.test(a);
}

// A source hostname must not resolve to a non-public address: the
// literal checks in assertSourceUrl only see the hostname string, so
// a domain pointed (or rebound) at an internal address would sail
// through. Resolve via DNS-over-HTTPS and refuse when ANY answer is
// private. A resolver failure does not block the fetch — the literal
// checks and the platform fetcher remain as backstops, and source
// availability should not hinge on a third-party resolver being up.
async function assertSourceHostResolvesPublic(hostname, depth = 0) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.includes(':') || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return;
  let answers = [];
  let cnames = [];
  try {
    const query = async (type, typeNum) => {
      const u = 'https://cloudflare-dns.com/dns-query?' + new URLSearchParams({ name: host, type });
      const r = await fetch(u, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) return [];
      const j = await r.json();
      return (Array.isArray(j.Answer) ? j.Answer : [])
        .filter((a) => a && a.type === typeNum && typeof a.data === 'string')
        .map((a) => a.data);
    };
    answers = [...(await query('A', 1)), ...(await query('AAAA', 28))];
    if (!answers.length && depth < 2) cnames = await query('CNAME', 5);
  } catch {
    return;
  }
  if (answers.some((a) => ipAddressIsPrivate(a))) {
    throw new Error('来源域名解析到了内网地址，已拒绝');
  }
  // An answer carrying only a CNAME and no addresses would
  // otherwise sail through unchecked: follow the target and apply
  // the same rule to wherever the chain lands.
  if (!answers.length && cnames.length) {
    await assertSourceHostResolvesPublic(cnames[0].replace(/\.$/, ''), depth + 1);
  }
}

async function fetchIpSource(rawUrl) {
  const url = assertSourceUrl(rawUrl);
  await assertSourceHostResolvesPublic(new URL(url).hostname);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  let text;
  try {
    // Redirects are followed MANUALLY, one validated hop at a
    // time: with redirect:'follow' the runtime completed the whole
    // chain — including a smuggled http or private hop — before
    // any check could run on the final URL, so a bad target WAS
    // contacted even though its content was then discarded. Here
    // every hop passes the same gates as the original URL BEFORE
    // it is requested.
    let current = url;
    let resp = null;
    for (let hop = 0; ; hop++) {
      resp = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'cloudflaresub (preferred-ip source)', accept: 'text/plain, application/json, */*' },
      });
      const location = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && location) {
        if (hop >= 5) throw new Error('来源重定向次数过多');
        const target = new URL(location, current).toString();
        assertSourceUrl(target);
        await assertSourceHostResolvesPublic(new URL(target).hostname);
        current = target;
        continue;
      }
      break;
    }
    if (!resp.ok) throw new Error(`来源返回 HTTP ${resp.status}`);
    // The body read stays inside the abort window: a slow-drip source
    // cannot hold a /sub refresh open past the same 5 seconds.
    text = await readBodyCapped(resp);
    // A source whose domain lapsed (parked page) or got hijacked can
    // answer 200 with an HTML page, and the endpoint scanner would
    // happily harvest IP-shaped strings out of the page furniture
    // into the subscription. A real address list is never an HTML
    // document, so refuse it as a fetch failure: the caller falls
    // back to the cached snapshot and names the source in a warning.
    const ctype = (resp.headers.get('content-type') || '').toLowerCase();
    const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 512).toLowerCase();
    if (ctype.includes('text/html') || head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head')) {
      throw new Error('来源返回了网页内容，不是优选地址列表');
    }
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
    // Source-derived endpoints get the same plausibility gate as
    // hand-typed literals: the token regex accepts 999.999.999.999
    // as an "IPv4" address, and without this check such garbage
    // occupies per-source limit slots and lands in subscriptions.
    if (ep.badPort || !ep.server || !isPlausibleHost(ep.server)) continue;
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
  // Coalesce concurrent refreshes of the same source: without this,
  // every request landing inside the stale window fetched the source
  // and rewrote the cache itself (a small stampede at each hourly
  // boundary, paid in external fetches and KV writes).
  const pending = sourceInflight.get(url);
  if (pending) return pending;
  const flight = fetchSourceAndCache(env, url, cached, now);
  sourceInflight.set(url, flight);
  try {
    return await flight;
  } finally {
    if (sourceInflight.get(url) === flight) sourceInflight.delete(url);
  }
}

const sourceInflight = new Map();

async function fetchSourceAndCache(env, url, cached, now) {
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
    const errKind = sourceErrKind(e);
    const result = cached ? 'stale-cache' : 'failed';
    if (sourceEventDue(`${host}|${result}|${errKind}`)) {
      await diagRecord(env, {
        kind: 'ip-source', host, result, err: errKind, ms: Date.now() - fetchStartedAt,
      });
    }
    if (cached) {
      await writeIpCache(env, url, { ...cached, lastAttempt: now });
      return { url, endpoints: cached.endpoints, fromCache: true, fetchedAt: cached.fetchedAt, refreshError: e.message };
    }
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
// since. A per-entry merged cache fronts the per-source resolution:
// a warm entry costs ONE KV read per /sub pull instead of one per
// source (subscription clients poll these links around the clock,
// and reads are the metered resource on the free tier). Its window
// is deliberately much shorter than the sources' hourly cadence:
// a rotation can lag by at most this window beyond the moment the
// source caches themselves go stale. Keys self-expire after 2h.
const ENTRY_CACHE_MS = 10 * 60 * 1000;
async function resolveDynamicEndpoints(env, record, id) {
  // The cache is stamped with the record version it was resolved
  // from (updatedAt, falling back to createdAt). Regeneration
  // deletes the cache, but a /sub in flight at that moment could
  // re-write the stale merge with a FRESH timestamp afterwards;
  // the stamp makes such a zombie cache unreadable, because the
  // regenerated record carries a newer stamp. Caches written
  // before stamps existed simply miss once and are rewritten.
  const recStamp = record.updatedAt || record.createdAt || '';
  if (id) {
    try {
      const raw = await env.SUB_STORE.get(`entrycache:${id}`);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && Array.isArray(c.endpoints) && c.endpoints.length
          && c.recStamp === recStamp
          && Date.now() - (c.at || 0) < ENTRY_CACHE_MS) {
          return c.endpoints;
        }
      }
    } catch {}
  }
  const resolved = await resolveDynamicEndpointsFresh(env, record);
  if (id && resolved && resolved.length) {
    try {
      await env.SUB_STORE.put(
        `entrycache:${id}`,
        JSON.stringify({ at: Date.now(), recStamp, endpoints: resolved }),
        { expirationTtl: 2 * 60 * 60 },
      );
    } catch {}
  }
  return resolved;
}

async function resolveDynamicEndpointsFresh(env, record) {
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
    // Sources resolve in PARALLEL (generation already did): fetching
    // serially made a 5-source entry's refresh cost the SUM of the
    // sources' latencies — 5 slow sources x the 5s timeout could
    // hold a /sub pull open for 25s+. Results merge in source order
    // regardless of completion order.
    const perSource = await Promise.all(dyn.sources.map(async (src) => {
      let eps = null;
      try {
        const { endpoints } = await getSourceEndpoints(env, src.url);
        const sliced = endpoints.slice(0, limit);
        if (sliced.length) eps = sliced;
      } catch {}
      if (!eps && Array.isArray(src.endpoints)) eps = src.endpoints.slice(0, limit);
      return eps || [];
    }));
    perSource.forEach((eps) => eps.forEach(push));
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
const APP_VERSION = '1.7.0';
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
    if (cached.ignoredTag && now - lastAttempt < VERSION_NEGATIVE_MS) {
      return { tag: null, url: null, checkedAt: cached.checkedAt || null, status: 'ok' };
    }
    const retryAfter = forceRetry ? VERSION_RETRY_MS : VERSION_NEGATIVE_MS;
    if (now - lastAttempt < retryAfter) {
      return { tag: null, url: null, checkedAt: null, status: 'failed' };
    }
  }
  try {
    const resp = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: {
        'user-agent': 'cloudflaresub (update check)',
        accept: 'application/vnd.github+json',
        // Unauthenticated GitHub API calls share a tight per-IP rate
        // limit, and Workers egress IPs are shared with everyone: on
        // a busy egress the update check used to fail spuriously.
        // Setting the optional GITHUB_TOKEN secret (any token with
        // public read access) raises the ceiling for this site.
        ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`GitHub HTTP ${resp.status}`);
    const data = await resp.json();
    const tag = String(data.tag_name || '').replace(/^v/, '');
    if (!tag) throw new Error('GitHub response has no tag_name');
    if (!/^\d+\.\d+\.\d+$/.test(tag)) {
      // Not a version-shaped tag: the release workflow's manual
      // dispatch channel tags its test builds v<YYYY.MM.DD>-<run>,
      // which compareVersions would rank above every real release
      // and make every deployed site cry 'update' at a test build.
      // The check SUCCEEDED — there is simply no applicable
      // release. Cache the ignored tag so GitHub is not refetched
      // on every page load while it stays the latest release.
      const ignored = { tag: '', ignoredTag: tag, checkedAt: now, lastAttempt: now };
      try { await env.SUB_STORE.put(VERSION_CACHE_KEY, JSON.stringify(ignored)); } catch {}
      return { tag: null, url: null, checkedAt: now, status: 'ok' };
    }
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

function vmessAlterId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 65535) : 0;
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
    // The link's alterId used to be dropped on the floor, silently
    // rewriting legacy (non-AEAD) nodes as AEAD ones in every output.
    alterId: vmessAlterId(obj.aid),
    cipher: obj.scy || 'auto',
    // A missing `net` means plain TCP in the VMess share format (the
    // URL-style parser below defaults to 'tcp' too): defaulting to
    // 'ws' here used to silently turn plain-TCP nodes into WebSocket
    // nodes in every output format, plain/raw links included.
    network: String(obj.net || 'tcp').toLowerCase(),
    tls: obj.tls === 'tls',
    host: obj.host || '',
    path: obj.path || '/',
    sni: obj.sni || obj.host || '',
    alpn: obj.alpn || '',
    fp: obj.fp || '',
    // The header-camouflage type and the insecure-cert flag used to
    // be dropped here: http-camouflage nodes were silently rewritten
    // as plain ones, and self-signed VMess endpoints lost the flag
    // every output format needs.
    headerType: String(obj.type || ''),
    allowInsecure: obj.allowInsecure === true || obj.allowInsecure === 1
      || ['1', 'true'].includes(String(obj.allowInsecure || '').toLowerCase()),
  };
}

function parseUrlLike(link, type) {
  const u = new URL(link);
  const security = (u.searchParams.get('security') || '').toLowerCase();
  return {
    type,
    name: decodeURIComponent(u.hash.replace(/^#/, '')) || type,
    params: Object.fromEntries(u.searchParams),
    server: stripBrackets(u.hostname),
    port: Number(u.port || 443),
    password: type === 'trojan' ? decodeURIComponent(u.username) : undefined,
    uuid: type === 'vless' ? decodeURIComponent(u.username) : undefined,
    network: u.searchParams.get('type') || 'tcp',
    // REALITY and XTLS are TLS-family transports: treating only the
    // literal 'tls' as encrypted used to render REALITY nodes as
    // plaintext in Clash (they still round-tripped in raw links via
    // params, so nothing looked wrong until the node never connected).
    security,
    tls: security === 'tls' || security === 'reality' || security === 'xtls',
    pbk: u.searchParams.get('pbk') || '',
    sid: u.searchParams.get('sid') || '',
    serviceName: u.searchParams.get('serviceName') || '',
    allowInsecure: ['1', 'true'].includes(
      (u.searchParams.get('allowInsecure') || u.searchParams.get('insecure') || '').toLowerCase(),
    ),
    host: u.searchParams.get('host') || u.searchParams.get('sni') || '',
    path: u.searchParams.get('path') || '/',
    sni: u.searchParams.get('sni') || u.searchParams.get('peer') || u.searchParams.get('host') || '',
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
      // URL schemes are case-insensitive, and some panels export
      // VLESS:// in capitals: dispatch on a lowered copy but parse
      // the original line (a vmess payload is case-sensitive base64).
      const lower = line.toLowerCase();
      if (lower.startsWith('vmess://')) {
        nodes.push(parseVmess(line));
        continue;
      }
      if (lower.startsWith('vless://')) {
        nodes.push(parseUrlLike(line, 'vless'));
        continue;
      }
      if (lower.startsWith('trojan://')) {
        nodes.push(parseUrlLike(line, 'trojan'));
        continue;
      }
      const decoded = b64DecodeUtf8(line);
      if (/^(vmess|vless|trojan):\/\//im.test(decoded)) {
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

// Clash/Mihomo and Surge key proxies by name and reject (or silently
// misroute) duplicates. Two source nodes sharing one remark — or the
// same link pasted twice — used to produce duplicate names and a
// subscription the client refused to import. Later occurrences get a
// " (n)" suffix, bumped past any name that already ends that way.
function dedupeNodeNames(nodes, reserved = []) {
  // `reserved` seeds the used set with names the caller will emit
  // itself (proxy-group titles): a node carrying one of those names
  // would otherwise define a proxy and a group under one name, which
  // clients reject just like a duplicate proxy name.
  const used = new Set(reserved);
  const counts = new Map();
  return nodes.map((node) => {
    const base = node.name || '';
    if (!used.has(base)) {
      used.add(base);
      counts.set(base, 1);
      return node;
    }
    let n = (counts.get(base) || 1) + 1;
    let candidate = `${base} (${n})`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${base} (${n})`;
    }
    counts.set(base, n);
    used.add(candidate);
    return { ...node, name: candidate };
  });
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
        // With keepOriginalHost off, host/sni used to be BLANKED.
        // The rule instead: a host/sni that is
        // empty or merely repeats the origin server follows the
        // preferred endpoint instead; a DISTINCT one (a CDN front
        // domain) survives — it was never the origin's identity, and
        // blanking it stranded exactly the nodes that needed it.
        host: options.keepOriginalHost
          ? node.host
          : (!node.host || node.host === node.server ? ep.server : node.host),
        sni: options.keepOriginalHost
          ? node.sni
          : (!node.sni || node.sni === node.server ? ep.server : node.sni),
      });
    }
  }
  return dedupeNodeNames(output);
}

function encodeVmess(node) {
  const obj = {
    v: '2',
    ps: node.name,
    add: node.server,
    port: String(node.port),
    id: node.uuid,
    aid: String(node.alterId ?? 0),
    scy: node.cipher || 'auto',
    net: node.network || 'tcp',
    type: node.headerType || 'none',
    host: node.host || '',
    path: node.path || '/',
    tls: node.tls ? 'tls' : '',
    sni: node.sni || '',
    alpn: node.alpn || '',
    fp: node.fp || '',
    ...(node.allowInsecure ? { allowInsecure: true } : {}),
  };
  return 'vmess://' + b64EncodeUtf8(JSON.stringify(obj));
}

function encodeVless(node) {
  // Start from the node's original query params so fields the parser does not
  // model (e.g. encryption=none) and the original ordering survive a round trip.
  const params = new URLSearchParams(node.params || {});
  params.set('type', node.network || 'ws');
  // Preserve REALITY/XTLS verbatim: the parser now reports them as
  // tls:true, and the old unconditional rewrite to 'tls' would have
  // broken the raw round trip that used to work.
  const secIn = String(node.security || (params.get('security') || '')).toLowerCase();
  if (secIn === 'reality' || secIn === 'xtls') params.set('security', secIn);
  else if (node.tls) params.set('security', 'tls');
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
  lines.push('    ws-opts:', `      path: "${escapeYaml(node.path || '/')}"`);
  const host = node.host || node.sni || '';
  // An explicitly empty Host header is worse than none — servers
  // may reject it, and mihomo reads a missing headers block as "no
  // override". The h2/http emitters already guard this way.
  if (host) {
    lines.push('      headers:', `        Host: "${escapeYaml(host)}"`);
  }
}

// TLS-family options the links can carry and Clash understands. The
// renderer used to drop all of them, which silently degraded or
// broke nodes in Clash only.
function pushClashTlsExtras(lines, node) {
  if (node.allowInsecure) lines.push('    skip-cert-verify: true');
  if (node.fp) lines.push(`    client-fingerprint: "${escapeYaml(node.fp)}"`);
  if (node.alpn) {
    const list = String(node.alpn).split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length) lines.push(`    alpn: [${list.map((a) => `"${escapeYaml(a)}"`).join(', ')}]`);
  }
}

function pushClashXhttpOpts(lines, node) {
  if ((node.network || '') !== 'xhttp') return;
  // mihomo's xhttp transport reads path/host/mode from xhttp-opts;
  // emitting the node as bare network: "xhttp" silently dropped all
  // three, and path-gated xhttp endpoints (the common deployment)
  // then handshook against the root path. The mode lives in the
  // link's params (the parser does not model it as a node field).
  const params = node.params || {};
  lines.push('    xhttp-opts:');
  lines.push(`      path: "${escapeYaml(node.path || '/')}"`);
  if (node.host) lines.push(`      host: "${escapeYaml(node.host)}"`);
  const mode = node.mode || params.mode || '';
  if (mode) lines.push(`      mode: "${escapeYaml(mode)}"`);
}

function pushClashGrpcOpts(lines, node) {
  if ((node.network || '') !== 'grpc') return;
  // VMess links carry the grpc service name in `path` (the v2ray
  // convention); vless/trojan use an explicit serviceName field.
  const svc = node.serviceName || String(node.path || '').replace(/^\//, '');
  lines.push('    grpc-opts:', `      grpc-service-name: "${escapeYaml(svc)}"`);
}

// The network a VMess node is emitted as in Clash: header
// camouflage 'http' over raw TCP is mihomo's http transport —
// emitting plain 'tcp' would silently drop the camouflage the
// link carries (raw/plain links preserve the field; Clash was the
// remaining format that lost it).
function clashNetworkOf(node) {
  const net = node.network || 'tcp';
  return net === 'tcp' && node.headerType === 'http' ? 'http' : net;
}

function pushClashHttpOpts(lines, node) {
  lines.push('    http-opts:');
  lines.push(`      path: ["${escapeYaml(node.path || '/')}"]`);
  const host = node.host || node.sni || '';
  if (host) {
    lines.push('      headers:');
    lines.push(`        Host: ["${escapeYaml(host)}"]`);
  }
}

function pushClashH2Opts(lines, node) {
  // mihomo reads H2 transport options from h2-opts, NOT http-opts
  // (that key belongs to network: http, and its shape differs: h2
  // takes a path string and a host list). Emitting http-opts for an
  // h2 node made the client fall back to the default path and no
  // hosts, silently breaking or degrading every h2 node.
  lines.push('    h2-opts:');
  lines.push(`      path: "${escapeYaml(node.path || '/')}"`);
  const host = node.host || node.sni || '';
  if (host) lines.push(`      host: ["${escapeYaml(host)}"]`);
}

function renderClash(nodes) {
  // Stored records predate build-time dedupe: rename again here so an
  // old entry with duplicate names still imports cleanly.
  nodes = dedupeNodeNames(nodes, ['自动选择', '节点选择', 'DIRECT', 'REJECT', 'GLOBAL']);
  const proxies = nodes
    .map((node) => {
      // Records stored before the parser modeled REALITY carry these
      // only in the raw params: read through so old entries render
      // correctly without being regenerated.
      if (node.type === 'vless' || node.type === 'trojan') {
        const p = node.params || {};
        node = {
          ...node,
          security: node.security || String(p.security || '').toLowerCase(),
          tls: node.tls || ['reality', 'xtls'].includes(String(p.security || '').toLowerCase()),
          pbk: node.pbk || p.pbk || '',
          sid: node.sid || p.sid || '',
          serviceName: node.serviceName || p.serviceName || '',
          allowInsecure: node.allowInsecure
            || ['1', 'true'].includes(String(p.allowInsecure || p.insecure || '').toLowerCase()),
        };
      }
      if (node.type === 'vmess') {
        const lines = [
          `  - name: "${escapeYaml(node.name)}"`,
          `    type: vmess`,
          `    server: "${escapeYaml(node.server)}"`,
          `    port: ${Number(node.port) || 0}`,
          `    uuid: "${escapeYaml(node.uuid)}"`,
          `    alterId: ${Number(node.alterId) || 0}`,
          `    cipher: "${escapeYaml(node.cipher || 'auto')}"`,
          `    udp: true`,
          `    tls: ${node.tls ? 'true' : 'false'}`,
          `    network: "${escapeYaml(clashNetworkOf(node))}"`,
        ];

        if (node.sni) {
          lines.push(`    servername: "${escapeYaml(node.sni)}"`);
        }

        if ((node.network || 'tcp') === 'ws') {
          pushClashWsOpts(lines, node);
        }
        pushClashGrpcOpts(lines, node);
        if (node.network === 'h2') pushClashH2Opts(lines, node);
        else if (clashNetworkOf(node) === 'http') pushClashHttpOpts(lines, node);
        if (node.tls) pushClashTlsExtras(lines, node);

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

        if (node.flow && node.tls && (node.network || 'tcp') === 'tcp') {
          // flow (XTLS Vision) only exists over TLS/REALITY on a raw
          // TCP connection: emitting it for a plaintext node — or
          // paired with ws/grpc transport — produces a combination
          // mihomo rejects, taking the whole profile down with it.
          lines.push(`    flow: "${escapeYaml(node.flow)}"`);
        }

        if (node.security === 'reality' && node.pbk) {
          lines.push('    reality-opts:');
          lines.push(`      public-key: "${escapeYaml(node.pbk)}"`);
          if (node.sid) lines.push(`      short-id: "${escapeYaml(node.sid)}"`);
        }

        if ((node.network || 'ws') === 'ws') {
          pushClashWsOpts(lines, node);
        }
        pushClashGrpcOpts(lines, node);
        if (node.network === 'h2') pushClashH2Opts(lines, node);
        else if (node.network === 'http') pushClashHttpOpts(lines, node);
        pushClashXhttpOpts(lines, node);
        if (node.tls) pushClashTlsExtras(lines, node);

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
        pushClashGrpcOpts(lines, node);
        if (node.network === 'h2') pushClashH2Opts(lines, node);
        else if (node.network === 'http') pushClashHttpOpts(lines, node);
        pushClashTlsExtras(lines, node);

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
    `profile:`,
    `  store-selected: true`,
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
  // '=' is Surge's name/value separator: a name carrying one is cut
  // in half by the parser, so it flattens with the commas.
  return String(name || '').replace(/[\r\n,=]+/g, ' ').trim();
}

function surgeField(value) {
  // Every field on a Surge proxy line is comma-separated and confined
  // to that line: a comma or newline smuggled in through a node link
  // (password, path, host, uuid…) would otherwise forge extra fields
  // or entire config lines — including fake [Proxy] entries.
  return String(value ?? '').replace(/[\r\n,]+/g, ' ').trim();
}

// Surge can only express plain TCP and WebSocket transports for
// VMess/Trojan. An h2 / gRPC / HTTP node used to render with NO
// transport marker at all, which Surge dials as plain TCP+TLS — a
// silently dead node sitting among working ones. Such nodes are
// filtered out instead (the same treatment VLESS gets: a type Surge
// cannot express at all), and handleSub reports the case where that
// leaves an entry with nothing Surge can use.
function surgeExpressible(node) {
  if (node.type !== 'vmess' && node.type !== 'trojan') return false;
  const net = String(node.network || 'tcp').toLowerCase();
  if (net !== 'tcp' && net !== 'ws') return false;
  // Surge fields are comma-separated with no escaping: a credential
  // carrying a comma cannot be written verbatim, and the field
  // flattener would silently rewrite it instead (a trojan password
  // 'p,a,ss' came out as 'p a ss' — a node that can never
  // authenticate). Such nodes are inexpressible too, not corrupted.
  // (Line breaks in a credential are a different case: never a real
  // password character, always injection debris, and the flattener
  // already neutralizes them — that long-standing behaviour stays.)
  const credential = node.type === 'trojan' ? node.password : node.uuid;
  if (String(credential ?? '').includes(',')) return false;
  return true;
}

function renderSurge(nodes, baseUrl, linkToken, intervalSec = 86400) {
  // Dedupe twice: once on the raw names (shared with Clash), then on
  // the Surge-sanitized names — two different raw names can sanitize
  // to the same Surge name ('a,b' vs 'a b'), and Surge keys by the
  // sanitized form. surgeName is idempotent, so the renders below are
  // unaffected.
  const supported = dedupeNodeNames(
    dedupeNodeNames(nodes)
      .filter(surgeExpressible)
      .map((node) => ({
        ...node,
        name: surgeName(node.name),
        // Same params read-through as renderClash for older records.
        allowInsecure: node.allowInsecure
          || ['1', 'true'].includes(String((node.params || {}).allowInsecure || (node.params || {}).insecure || '').toLowerCase()),
      })),
    ['Proxy', 'DIRECT', 'REJECT'],
  );
  const proxies = supported
    .map((node) => {
      if (node.type === 'vmess') {
        // The ws parameter block applies ONLY to ws transport: it
        // used to be emitted unconditionally, rendering tcp and grpc
        // nodes as ws nodes (with the grpc service name, which lives
        // in path, stuffed into ws-path).
        const wsPart = (node.network || 'tcp') === 'ws'
          ? `, ws=true, ws-path=${surgeField(node.path || '/')}${node.host ? `, ws-headers=Host:${surgeField(node.host)}` : ''}`
          : '';
        return `${surgeName(node.name)} = vmess, ${surgeField(node.server)}, ${surgeField(node.port)}, username=${surgeField(node.uuid)}, vmess-aead=${node.alterId ? 'false' : 'true'}${wsPart}, tls=${node.tls ? 'true' : 'false'}, sni=${surgeField(node.sni || '')}, skip-cert-verify=${node.allowInsecure ? 'true' : 'false'}`;
      }
      return `${surgeName(node.name)} = trojan, ${surgeField(node.server)}, ${surgeField(node.port)}, password=${surgeField(node.password || '')}, sni=${surgeField(node.sni || '')}, skip-cert-verify=${node.allowInsecure ? 'true' : 'false'}${(node.network || '') === 'ws' ? `, ws=true, ws-path=${surgeField(node.path || '/')}${node.host ? `, ws-headers=Host:${surgeField(node.host)}` : ''}` : ''}`;
    });

  // The MANAGED-CONFIG first line is what makes Surge treat the
  // profile as a remote subscription and re-pull it on the interval:
  // without it (the old output started at [General]) the profile was
  // a local file that never updated — fatal for dynamic entries,
  // whose whole point is fresh endpoints.
  const managedUrl = baseUrl + (linkToken ? '?token=' + linkToken : '');
  return [
    '#!MANAGED-CONFIG ' + managedUrl + ' interval=' + intervalSec + ' strict=false',
    '',
    '[General]',
    'skip-proxy = 127.0.0.1, localhost',
    '',
    '[Proxy]',
    ...proxies,
    '',
    '[Proxy Group]',
    'Proxy = select, ' +
      supported
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
  // Rejection sampling: 256 is not a multiple of the alphabet size,
  // so a bare modulo would favour the first (256 % len) symbols.
  // Draw with headroom and keep only bytes below the largest
  // multiple of the alphabet size that fits in a byte.
  const limit = Math.floor(256 / chars.length) * chars.length;
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b >= limit) continue;
      out += chars[b % chars.length];
      if (out.length === length) break;
    }
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

// Tags ride along in the record's KV metadata so /api/tags can
// aggregate the vocabulary from the key list alone instead of
// reading every full record value. Omitted when the JSON would
// bloat the 1024-byte metadata budget (long note + many wide tags):
// the endpoint then falls back to reading that one record, exactly
// as it did before this field existed.
// KV metadata is capped at 1024 BYTES on the platform, and multibyte
// text breaks char-count budgets (a CJK char is 1 char but 3 bytes), so
// every metadata budget below is measured in UTF-8 bytes.
function utf8ByteLength(s) {
  return new TextEncoder().encode(s).length;
}

function metaTagsOf(record) {
  const tags = sanitizeTags(record && record.tags);
  if (!tags.length) return [];
  return utf8ByteLength(JSON.stringify(tags)) <= 384 ? tags : undefined;
}

function buildRecordMetadata(record) {
  const servers = (record.sources || []).map((x) => x.server).filter(Boolean);
  const st = record.storage || { mode: 'permanent' };
  const meta = {
    note: (typeof record.note === 'string' ? record.note : ''),
    createdAt: record.createdAt || '',
    sources: [...new Set(servers)].slice(0, 3).join(',').slice(0, 200),
    out: Array.isArray(record.nodes) ? record.nodes.length : 0,
    retention: st.mode === 'days' ? `days:${st.days}` : 'permanent',
    exp: st.mode === 'days' ? (st.expiresAt || '') : '',
    tags: metaTagsOf(record),
  };
  // Keep the serialized metadata safely under the platform's 1024-byte
  // limit: a legal max-length CJK note plus ten max-length CJK tags
  // otherwise pushes past it and the KV put throws, failing the save
  // with an opaque 500. The tags copy is display-only (the record body
  // is authoritative), so it is dropped first; the note copy is
  // truncated next (the record keeps the full note either way).
  if (utf8ByteLength(JSON.stringify(meta)) > 1000 && meta.tags !== undefined) {
    meta.tags = undefined;
  }
  while (meta.note && utf8ByteLength(JSON.stringify(meta)) > 1000) {
    meta.note = dropDanglingSurrogate(meta.note.slice(0, -8));
  }
  return meta;
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
  if (!st.expiresAt && st.days) {
    // Legacy/hand-shaped timed records carry days but no expiresAt.
    // Returning the FULL countdown here would restart the entry's
    // clock on every save, so it could never expire while in use.
    // Anchor the expiry at createdAt + days instead, and materialize
    // it onto the record (both callers putRecord this same object
    // right after) so later saves count down normally. With no
    // parseable createdAt the only anchor left is now — still
    // materialized, so the restart happens at most once.
    const createdMs = Date.parse(record.createdAt || '');
    const baseMs = Number.isFinite(createdMs) ? createdMs : Date.now();
    st.expiresAt = new Date(baseMs + st.days * 86400 * 1000).toISOString();
  }
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
const MAX_RECORD_BYTES = 24 * 1024 * 1024;

async function putRecord(env, id, record, prevNote = undefined, ttlSeconds = undefined) {
  const serialized = JSON.stringify(record);
  // The node-count cap cannot see bytes: long parameters replicate
  // into every expanded node, so a record can still outgrow KV's
  // 25MB value limit and die as a platform error nobody can act on.
  // Refuse here with the actual size; generation maps it to a 400.
  const bytes = utf8ByteLength(serialized);
  if (bytes > MAX_RECORD_BYTES) {
    throw new Error(`记录体积过大（约 ${(bytes / 1048576).toFixed(1)} MB，上限 ${(MAX_RECORD_BYTES / 1048576).toFixed(0)} MB）`);
  }
  const opts = { metadata: buildRecordMetadata(record) };
  if (ttlSeconds) opts.expirationTtl = ttlSeconds;
  await env.SUB_STORE.put(`sub:${id}`, serialized, opts);
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
  try {
    return await handleGenerateBody(request, env, url);
  } catch (e) {
    if (e && typeof e.message === 'string' && e.message.startsWith('记录体积过大')) {
      return json({ ok: false, error: `${e.message}。请减少节点数量或优选地址数量。` }, 400);
    }
    throw e;
  }
}

async function handleGenerateBody(request, env, url) {
  if (!env.SUB_STORE) {
    return json({ ok: false, error: '服务端未绑定 KV：请在 Pages 项目 Settings -> Bindings 中添加 KV namespace，变量名必须为 SUB_STORE，然后重新部署' }, 500);
  }
  const parsedBody = await parseJsonBody(request);
  if (parsedBody.error) return parsedBody.error;
  const body = parsedBody.body;

  // Generating writes to KV, so it sits behind the same gate as the
  // admin endpoints — including when no token is configured at all.
  // An unset token used to leave generation wide open during exactly
  // the setup window where forgetting the secret is easiest (the
  // admin endpoints already failed closed; generation did not).
  const denied = await checkAdmin(request, env, url, body, 'generate');
  if (denied) return denied;
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
  const literalEndpoints = [];
  const invalidLiteralLines = [];
  const seenLiteralEp = new Set();
  for (const litLine of mixed.literals) {
    const ep = parsePreferredEndpoints(litLine)[0];
    if (!ep) continue;
    if (!isPlausibleHost(ep.server)) {
      invalidLiteralLines.push(litLine);
      continue;
    }
    const key = `${ep.server}:${ep.port ?? ''}`;
    if (seenLiteralEp.has(key)) continue;
    seenLiteralEp.add(key);
    literalEndpoints.push(ep);
  }
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
  // expand to their (limited) list. Every endpoint dedupes against
  // everything already emitted (first occurrence wins).
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
      if (!ep || !isPlausibleHost(ep.server)) continue;
      // Literal lines dedupe like everything else (first occurrence
      // wins): the README has always promised this, but the literal
      // branch never checked the seen set, so an address pasted
      // three times produced three identical nodes.
      if (seenEp.has(epKey(ep))) continue;
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
  let deduplicated = false;

  if (!id) {
    id = await createUniqueShortId(env);
    record = {
      version: 2,
      createdAt: new Date().toISOString(),
      note: providedNote || '',
      tags: providedTags || [],
      storage: retention.storage,
      dedupHash,
      linkToken: newLinkToken(),
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
    deduplicated = true;
    // Same content generated again: reuse the entry. Rewriting it without
    // a TTL also migrates older (7-day expiry) entries to permanent
    // storage, backfills sources, and applies a newly provided note.
    const raw = await env.SUB_STORE.get(`sub:${id}`);
    let existing = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') existing = parsed;
      } catch {}
    }
    if (existing) {
      record = existing;
      const prevNote = (typeof record.note === 'string' ? record.note : '');
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
      } else {
        // A static hit refreshes the stored nodes too: the generate
        // response renders THIS request's expansion, and serving the
        // previously stored order from /sub made the two disagree —
        // the same links re-pasted in a different order previewed
        // one name assignment and served another.
        record.nodes = nodes;
      }
      // The retention picked this time replaces the previous plan, and the
      // countdown restarts from now.
      record.storage = retention.storage;
      record.updatedAt = new Date().toISOString();
      const ttl = applyRetention(record, Date.now());
      await putRecord(env, id, record, prevNote, ttl);
      // The entry was just rewritten: its merged /sub cache must not
      // keep serving the pre-regeneration endpoints for the rest of
      // its 10-minute window.
      await env.SUB_STORE.delete(`entrycache:${id}`);
      await env.SUB_STORE.put(dedupKey, id, ttl ? { expirationTtl: ttl } : {});
    } else {
      record = {
        version: 2,
        createdAt: new Date().toISOString(),
        note: providedNote || '',
        tags: providedTags || [],
        storage: retention.storage,
        dedupHash,
        linkToken: newLinkToken(),
        sources,
        options,
        inputs,
        nodes,
        ...(dynamic ? { dynamic, baseNodes } : {}),
      };
      const ttl = applyRetention(record, Date.now());
      await putRecord(env, id, record, undefined, ttl);
      await env.SUB_STORE.delete(`entrycache:${id}`);
      // The record was gone but its dedup key survived (KV reaped one
      // and not the other): the healed record just got a fresh TTL,
      // so renew the dedup key on the same clock — otherwise the key
      // lapses first and the next identical generate mints a duplicate
      // entry alongside the healed one.
      await env.SUB_STORE.put(dedupKey, id, ttl ? { expirationTtl: ttl } : {});
    }
  }

  const origin = url.origin;
  const linkToken = await effectiveLinkToken(id, env, record);
  const withToken = (target) => {
    const q = new URLSearchParams();
    if (target) q.set('target', target);
    if (linkToken) q.set('token', linkToken);
    const qs = q.toString();
    return `${origin}/sub/${id}${qs ? `?${qs}` : ''}`;
  };

  return json({
    ok: true,
    deduplicated,
    shortId: id,
    urls: {
      auto: withToken(''),
      raw: withToken('raw'),
      plain: withToken('plain'),
      clash: withToken('clash'),
      surge: withToken('surge'),
    },
    note: (typeof record.note === 'string' ? record.note : ''),
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
      ...(skippedLines > 0 ? [`有 ${skippedLines} 行节点链接无法解析或端口不可用，已跳过。`] : []),
      ...(invalidLiteralLines.length
        ? [`有 ${invalidLiteralLines.length} 行优选地址不是合法的 IP 或域名，已跳过（例如「${invalidLiteralLines[0].slice(0, 40)}」；若它其实是来源链接，请以 https:// 开头）。`]
        : []),
      // Generation parses the full text, but the stored copy (what
      // backfill restores) is capped: say so, or the tail silently
      // vanishes from every future backfill-and-regenerate.
      ...(String(body.nodeLinks || '').length > 100000
        ? ['节点链接过长：本次已完整生成，但存档仅保留前 100000 字符，日后用「回填到生成区」再生成时尾部链接会缺失（且会生成新条目）。']
        : []),
      ...(mixedText.length > 50000
        ? ['优选地址框过长：本次已完整生成，但存档仅保留前 50000 字符，日后用「回填到生成区」再生成时尾部内容会缺失（且会生成新条目）。']
        : []),
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

// The admin token guards every stored subscription at once, and a
// weak one can be brute-forced OFFLINE against a legacy entry's
// derived link token (an HMAC anyone can recompute for a guessed
// token) — so the token carries a hard length floor. Repeated wrong
// guesses also lock the admin surface for a cooldown instead of
// being merely logged: per-isolate state, so it is a brake, not a
// wall, but online guessing of a 16+ character token was never the
// realistic path anyway.
const ADMIN_TOKEN_MIN_LENGTH = 16;
const ADMIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_FAIL_LIMIT = 20;
const adminFailureTimes = [];

async function checkAdmin(request, env, url, body, flavor) {
  const expected = env.SUB_ACCESS_TOKEN;
  if (!expected) {
    return json({ ok: false, error: '未设置 SUB_ACCESS_TOKEN，出于安全原因管理接口已禁用，请先在 Pages 项目里设置该 Secret' }, 403);
  }
  if (expected.length < ADMIN_TOKEN_MIN_LENGTH) {
    return json({ ok: false, error: `SUB_ACCESS_TOKEN 太短（当前 ${expected.length} 个字符，至少需要 ${ADMIN_TOKEN_MIN_LENGTH} 个）：弱令牌可被离线破解，请在 Pages 项目里换一个更长的随机令牌后重新部署` }, 403);
  }
  // Body field or the dedicated header only — never the URL query, so the
  // admin token stays out of browser history, proxy logs and referrers.
  const provided =
    (body && typeof body.token === 'string' && body.token) ||
    request.headers.get('x-admin-token') ||
    '';
  if (await safeEqual(provided, expected)) {
    // A CORRECT token is always admitted — even while wrong guesses
    // are being throttled. The throttle exists to brake guessing,
    // and guessing is unaffected by letting the owner in; the other
    // arrangement handed any stranger a lever to lock the owner out
    // of their own admin surface indefinitely.
    adminFailureTimes.length = 0;
    return null;
  }
  const now = Date.now();
  while (adminFailureTimes.length && now - adminFailureTimes[0] > ADMIN_FAIL_WINDOW_MS) {
    adminFailureTimes.shift();
  }
  // Capped: once the throttle is tripped, more samples change
  // nothing, and an uncapped array would grow by one entry per
  // wrong guess for as long as someone keeps guessing.
  if (adminFailureTimes.length < ADMIN_FAIL_LIMIT) adminFailureTimes.push(now);
  if (adminFailureTimes.length >= ADMIN_FAIL_LIMIT) {
    return json({ ok: false, error: '管理令牌错误次数过多，已暂时拒绝继续尝试，请 5 分钟后再试（正确令牌不受影响）' }, 429);
  }
  if (flavor === 'generate') {
    return json({ ok: false, error: '生成订阅需要管理令牌：请先在页面下方「KV 条目管理」处填入 SUB_ACCESS_TOKEN（生成与管理共用同一个令牌）' }, 403);
  }
  return json({ ok: false, error: '管理令牌不正确' }, 403);
}

// One admin-list row, resolved from its record. Returns null for a
// ghost key (the list index still enumerates a just-deleted entry
// whose record is already gone).
async function buildListItem(env, key) {
  const id = key.name.slice('sub:'.length);
  const meta = key.metadata || {};
  const item = {
    id,
    note: (typeof meta.note === 'string' ? meta.note : ''),
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
  if (raw === null || raw === undefined) return null;
  try {
    const rec = JSON.parse(raw);
    item.note = (typeof rec.note === 'string' ? rec.note : '');
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
    if (typeof rec.linkToken === 'string' && rec.linkToken) item.linkToken = rec.linkToken;
    if (rec.dynamic) {
      item.sourceCount = Array.isArray(rec.dynamic.sources)
        ? rec.dynamic.sources.length
        : (rec.dynamic.sourceUrl ? 1 : 0);
    }
  } catch {}
  item.linkToken = item.linkToken || await linkTokenFor(id, env);
  return item;
}

async function handleList(request, env, url) {
  if (!env.SUB_STORE) return json({ ok: false, error: 'SUB_STORE KV 未绑定' }, 500);
  const denied = await checkAdmin(request, env, url, null);
  if (denied) return denied;

  // The key list only tells us WHICH entries exist. Every displayed
  // field is read from the record itself: list-index metadata lags
  // fresh writes and caused false failure reports and stale displays.
  // Paged reads (limit/offset present) take an index-driven path:
  // keys are ordered by the list index's createdAt metadata and
  // only the requested page's records are read, so a script paging
  // through a big store pays reads for one page, not for every
  // record. The ORDER is the one thing taken from index metadata
  // (eventually consistent — a just-written entry can briefly sort
  // by a stale createdAt); every displayed field still comes from
  // the record itself, and the unpaged path below is unchanged.
  const offsetRaw = Number(url.searchParams.get('offset'));
  const limitRaw = Number(url.searchParams.get('limit'));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.trunc(offsetRaw) : 0;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(5000, Math.trunc(limitRaw)) : null;
  if (limit !== null || offset > 0) {
    const keys = [];
    let cur;
    do {
      const page = await env.SUB_STORE.list({ prefix: 'sub:', cursor: cur, limit: 256 });
      keys.push(...page.keys);
      cur = page.list_complete ? undefined : page.cursor;
    } while (cur);
    keys.sort((a, b) => String((b.metadata || {}).createdAt || '').localeCompare(String((a.metadata || {}).createdAt || '')));
    const total = keys.length;
    const pageKeys = keys.slice(offset, limit === null ? undefined : offset + limit);
    const pageItems = [];
    for (let i = 0; i < pageKeys.length; i += 25) {
      const built = await Promise.all(pageKeys.slice(i, i + 25).map((key) => buildListItem(env, key)));
      for (const item of built) if (item) pageItems.push(item);
    }
    return json({ ok: true, count: total, total, offset, limit, items: pageItems });
  }

  // One source of truth: the record.
  const items = [];
  let cursor;
  do {
    const page = await env.SUB_STORE.list({ prefix: 'sub:', cursor, limit: 256 });
    // Records resolve in parallel chunks (the diagnostics census
    // pattern): awaiting one KV get at a time made the list's
    // latency grow strictly linearly with the entry count.
    for (let i = 0; i < page.keys.length; i += 25) {
      const chunk = page.keys.slice(i, i + 25);
      const built = await Promise.all(chunk.map((key) => buildListItem(env, key)));
      for (const item of built) if (item) items.push(item);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return json({ ok: true, count: items.length, total: items.length, offset: 0, limit: null, items });
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
    note: (typeof record.note === 'string' ? record.note : ''),
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
// Parse a stored entry record tolerantly: a hand-corrupted KV value
// must surface as a clean 'record damaged' answer, not as a bare 500
// from an unguarded JSON.parse. (The list, entry and census paths
// already guard individually; the write/sub paths now share this.)
function parseStoredRecord(raw) {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

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
    note: (typeof record.note === 'string' ? record.note : ''),
    tags: sanitizeTags(record.tags),
    createdAt: record.createdAt || null,
    storage: record.storage || { mode: 'permanent' },
    linkToken: await effectiveLinkToken(id, env, record),
    backfill: buildBackfill(record),
  });
}

// Test-fetch a preferred-IP source so the owner can verify an API
// address before generating a dynamic subscription from it. Always
// fetches live (never the cache) and requires the admin token, like
// every other server-side fetch trigger.
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

// JSON request bodies are size-capped BEFORE parsing — and therefore
// before auth: without a ceiling, an unauthenticated client could
// make the worker buffer and parse arbitrarily large payloads on
// every POST endpoint. The legitimate maximum is far lower (the
// biggest real request is a large generate paste, a few MB at the
// output-node cap), so 16MB refuses abuse without touching real use.
async function parseJsonBody(request) {
  const tooBig = () => json({ ok: false, error: `请求体过大（上限 ${MAX_REQUEST_BODY_BYTES / 1048576} MB）` }, 413);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_REQUEST_BODY_BYTES) return { error: tooBig() };
  let raw;
  try {
    raw = await request.text();
  } catch {
    return { error: json({ ok: false, error: '请求体不是合法 JSON' }, 400) };
  }
  if (utf8ByteLength(raw) > MAX_REQUEST_BODY_BYTES) return { error: tooBig() };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: json({ ok: false, error: '请求体不是合法 JSON' }, 400) };
  }
}

// Shared prelude of the POST admin endpoints: KV bound, JSON body
// parsed, admin token verified. Returns { body } or { error }.
async function parseAdminBody(request, env) {
  if (!env.SUB_STORE) return { error: json({ ok: false, error: 'SUB_STORE KV 未绑定' }, 500) };
  const parsed = await parseJsonBody(request);
  if (parsed.error) return { error: parsed.error };
  const body = parsed.body;
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

  const record = parseStoredRecord(raw);
  if (!record) return json({ ok: false, error: '条目数据损坏' }, 500);
  const prevNote = (typeof record.note === 'string' ? record.note : '');
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

  const record = parseStoredRecord(raw);
  if (!record) return json({ ok: false, error: '条目数据损坏' }, 500);
  record.tags = sanitizeTags(body.tags);
  record.updatedAt = new Date().toISOString();
  await putRecord(env, id, record, (typeof record.note === 'string' ? record.note : ''), remainingTtl(record));
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
    // Tags normally ride in the key metadata (buildRecordMetadata),
    // so the vocabulary costs zero record reads. Keys written before
    // that field existed — or whose tags overflowed the metadata
    // budget and were omitted — fall back to reading the record
    // itself. Keys resolve in parallel chunks, like the census.
    for (let i = 0; i < page.keys.length; i += 25) {
      const chunk = page.keys.slice(i, i + 25);
      const perKey = await Promise.all(chunk.map(async (key) => {
        const meta = key.metadata || {};
        if (Array.isArray(meta.tags)) return meta.tags;
        const raw = await env.SUB_STORE.get(key.name);
        if (raw === null || raw === undefined) return null;
        let rec;
        try { rec = JSON.parse(raw); } catch { return null; }
        return Array.isArray(rec.tags) ? rec.tags : null;
      }));
      for (const tags of perKey) {
        if (!tags) continue;
        const seen = new Set();
        for (const tag of tags) {
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

  const record = parseStoredRecord(raw);
  if (!record) return json({ ok: false, error: '条目数据损坏' }, 500);
  record.storage = retention.storage;
  record.updatedAt = new Date().toISOString();
  // Re-apply from NOW: switching to permanent clears the TTL, switching to
  // days restarts the countdown (same rule as regenerating the entry).
  const ttl = applyRetention(record, Date.now());
  await putRecord(env, id, record, (typeof record.note === 'string' ? record.note : ''), ttl);
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
  await env.SUB_STORE.delete(`entrycache:${id}`);
  if (record && record.note) await env.SUB_STORE.delete(notePointerKey(record.note, id));
  if (record && record.dedupHash) await env.SUB_STORE.delete(`dedup:${record.dedupHash}`);
  return json({ ok: true, id, existed: Boolean(raw) });
}

// ---- Per-entry subscription link tokens -----------------------------------
// A subscription link is meant to be shared, so it must never carry
// the admin secret — and it must not be DERIVABLE from it either:
// an HMAC keyed by the admin token lets anyone holding one link
// test guesses at that token offline, at full speed, forever.
// Entries minted by current builds therefore carry their own random
// link token, stored on the record and compared directly; nothing
// about such a link verifies an admin-token guess. Entries created
// before this change have no stored token: their links keep working
// against the legacy HMAC derivation below until the entry is
// deleted and regenerated, and rotating SUB_ACCESS_TOKEN still
// invalidates those legacy links (and only those).
function newLinkToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function effectiveLinkToken(id, env, record) {
  if (record && typeof record.linkToken === 'string' && record.linkToken) {
    return record.linkToken;
  }
  return linkTokenFor(id, env);
}

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

async function validateLinkToken(url, env, id, record) {
  // Fail CLOSED when no admin token is configured: an unset token
  // used to leave every subscription readable by anyone who knew
  // an entry id, during exactly the setup window where forgetting
  // the secret is easiest.
  if (!env.SUB_ACCESS_TOKEN) {
    return { ok: false, response: text('未设置 SUB_ACCESS_TOKEN，订阅服务已禁用，请先在 Pages 项目里设置该 Secret 后重新部署。', 403) };
  }
  const provided = url.searchParams.get('token') || '';
  const expected = await effectiveLinkToken(id, env, record);
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

  // The record loads BEFORE token validation: an entry carrying a
  // stored link token validates against it, and only legacy entries
  // fall back to the derived token. A missing record is a plain 404
  // regardless of the token (the historical behaviour, and the
  // honest answer for a deleted link): entry ids are random and
  // unguessable, so the existence signal costs nothing.
  const raw = await env.SUB_STORE.get(`sub:${id}`);
  if (!raw) return text('not found', 404);
  const record = parseStoredRecord(raw);
  const tokenCheck = await validateLinkToken(url, env, id, record);
  if (!tokenCheck.ok) return tokenCheck.response;
  if (!record) return text('条目数据损坏，无法生成订阅内容。', 500, 'text/plain; charset=utf-8');
  // Retention expiry is recorded in the record itself, and KV reaps
  // expired keys lazily — without this check an expired entry keeps
  // serving until the platform gets around to deleting it.
  const recStorage = record.storage;
  if (recStorage && recStorage.mode === 'days' && recStorage.expiresAt) {
    const expMs = Date.parse(recStorage.expiresAt);
    if (Number.isFinite(expMs) && expMs <= Date.now()) return text('not found', 404);
  }
  let nodes = record.nodes || [];
  if (record.dynamic && Array.isArray(record.baseNodes) && record.baseNodes.length) {
    // Dynamic subscription: rebuild the node list from the source's
    // current preferred IPs. Any failure keeps the stored snapshot.
    const eps = await resolveDynamicEndpoints(env, record, id);
    if (eps && eps.length) {
      const rebuilt = buildNodes(record.baseNodes, eps, record.options || {});
      if (rebuilt.length) nodes = rebuilt;
    }
  }
  if (!nodes.length) {
    // Only reachable for a hand-corrupted record (generation always
    // stores at least one node): every format would otherwise return
    // a 200 with an empty or group-only body that clients reject
    // opaquely. Same treatment as the Surge no-supported-nodes case.
    return text('该条目的节点列表为空，无法生成订阅内容。', 400, 'text/plain; charset=utf-8');
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

  // Tell subscription clients how often to come back (hours):
  // dynamic entries track sources that refresh about hourly, static
  // ones change only when the owner regenerates them.
  const subHeaders = { 'profile-update-interval': record.dynamic ? '1' : '24' };
  // Give the imported profile a human-recognizable name — the
  // entry's note when it has one: without a Content-Disposition,
  // clients name the profile after the raw subscription URL and a
  // list of entries becomes indistinguishable. filename* carries
  // the full UTF-8 name; the plain filename is an ASCII-only
  // fallback, and both are built so even a hand-edited note cannot
  // inject response headers.
  const profileName = (typeof record.note === 'string' && record.note.trim()) || `sub-${id}`;
  const profileExt = target === 'clash' ? 'yaml' : 'txt';
  const asciiFallback = profileName
    .replace(/[^\x21-\x7e]/g, '-')
    .replace(/["\\]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || `sub-${id}`;
  subHeaders['content-disposition'] =
    `attachment; filename="${asciiFallback}.${profileExt}"; filename*=UTF-8''${encodeURIComponent(`${profileName}.${profileExt}`)}`;
  // A whole family of clients (Shadowrocket, Stash, Surge) reads the
  // profile name from the profile-title HEADER and never looks at
  // content-disposition; the base64: form is the agreed
  // Unicode-safe encoding for it.
  subHeaders['profile-title'] = `base64:${b64EncodeUtf8(profileName)}`;
  if (target === 'plain' || target === 'links' || target === 'text') {
    return text(renderPlain(nodes), 200, 'text/plain; charset=utf-8', subHeaders);
  }
  if (target === 'clash') {
    return text(renderClash(nodes), 200, 'text/yaml; charset=utf-8', subHeaders);
  }
  if (target === 'surge') {
    // Surge supports only VMess/Trojan: an entry without either used
    // to return a 200 with an empty [Proxy] section, which imports
    // into a client as a silently node-less profile. Say so instead.
    if (!nodes.some((node) => node.type === 'vmess' || node.type === 'trojan')) {
      return text(
        '该条目没有 Surge 支持的节点：Surge 仅支持 VMess / Trojan 节点，当前条目不含这两种类型。',
        400,
        'text/plain; charset=utf-8',
      );
    }
    if (!nodes.some(surgeExpressible)) {
      // The types are right but none can be written into a Surge
      // config: either the transport is one Surge cannot express
      // (h2 / gRPC / HTTP) or the credential carries a comma, which
      // Surge's comma-separated fields cannot hold. Rendering them
      // anyway would produce silently dead or corrupted lines.
      return text(
        '该条目没有 Surge 可用的节点：当前条目的 VMess / Trojan 节点或因传输方式（h2 / gRPC / HTTP），或因密码等凭据含有 Surge 无法表达的逗号，均无法写入 Surge 配置。',
        400,
        'text/plain; charset=utf-8',
      );
    }
    return text(
      renderSurge(nodes, url.origin + url.pathname, await effectiveLinkToken(id, env, record), record.dynamic ? 3600 : 86400),
      200,
      'text/plain; charset=utf-8',
      subHeaders,
    );
  }
  if (target !== 'raw') {
    // Unknown targets used to fall through to base64 silently, so a
    // client asking for a format this build does not produce (json,
    // a typo, another tool's dialect) got a 200 it could not parse
    // and no hint why. Name the supported set instead.
    return text(`不支持的订阅格式 target=${target}：可用值为 auto、raw、plain、clash、surge。`, 400, 'text/plain; charset=utf-8');
  }
  return text(renderRaw(nodes), 200, 'text/plain; charset=utf-8', subHeaders);
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
const DIAG_SHARDS = 8;
const DIAG_SHARD_MAX = 20;
const DIAG_KNOWN_ROUTES = new Set([
  '/api/generate', '/api/list', '/api/entry', '/api/ip-source-test',
  '/api/note', '/api/tags', '/api/tag-order', '/api/retention', '/api/delete',
]);

async function readDiagShard(env, key) {
  try {
    const raw = await env.SUB_STORE.get(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Keep only well-formed events (plain object, numeric timestamp —
    // the only shape diagRecord writes). One junk member must not
    // poison the merge: the sort dereferences .t, and a null member
    // used to throw there and silently zero the whole ring view.
    return parsed.filter((e) => e && typeof e === 'object' && typeof e.t === 'number');
  } catch {
    return [];
  }
}

// The merged view across all shards (plus the pre-sharding single key,
// whose events age out of the window on their own): sorted by time,
// newest DIAG_RING_MAX kept.
async function readDiagEvents(env) {
  try {
    const keys = [];
    let cursor;
    do {
      const page = await env.SUB_STORE.list({ prefix: DIAG_EVENTS_KEY, cursor, limit: 64 });
      keys.push(...page.keys);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    const all = [];
    for (const k of keys.slice(0, 16)) {
      all.push(...(await readDiagShard(env, k.name)));
    }
    all.sort((a, b) => (a.t || 0) - (b.t || 0));
    return all.slice(-DIAG_RING_MAX);
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
    // Writes land on a random shard: KV has no atomic read-modify-write,
    // so a single hot key loses most events whenever two requests are
    // in flight at once. Eight shards cut same-key collisions by about
    // 8x; the read side merges. (Loss is reduced, not eliminated —
    // the ring stays best-effort by design.)
    const key = `${DIAG_EVENTS_KEY}:${Math.floor(Math.random() * DIAG_SHARDS)}`;
    const arr = await readDiagShard(env, key);
    const last = arr[arr.length - 1];
    if (last && diagSig(last) === diagSig(evt)) {
      last.n = (last.n || 1) + 1;
      last.t = Date.now();
      if (typeof evt.ms === 'number') last.ms = evt.ms;
    } else {
      arr.push({ t: Date.now(), ...evt });
      if (arr.length > DIAG_SHARD_MAX) arr.splice(0, arr.length - DIAG_SHARD_MAX);
    }
    await env.SUB_STORE.put(key, JSON.stringify(arr));
  } catch {}
}

// Per-isolate throttle for ip-source failure events: while a source
// stays down, subscription fetches retry it every few minutes for
// days. One ring entry per host+result+error per 10 minutes is plenty
// of signal and keeps the /sub hot path from paying ring writes for
// the whole outage. (Isolates are ephemeral; a cold isolate may let
// one extra entry through — acceptable for a best-effort ring.)
const sourceEventSeen = new Map();
function sourceEventDue(key) {
  const now = Date.now();
  if (now - (sourceEventSeen.get(key) || 0) < 10 * 60 * 1000) return false;
  sourceEventSeen.set(key, now);
  if (sourceEventSeen.size > 200) sourceEventSeen.clear();
  return true;
}

function sourceErrKind(e) {
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return 'timeout';
  const m = String((e && e.message) || '');
  if (m.includes('可用的优选地址')) return 'empty';
  if (m.includes('网页内容')) return 'html-content';
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
    // Records store createdAt as an ISO string (only hand-made ones
    // use epoch numbers): accept both, or the age summary below is a
    // dead field that never populates for real data.
    const createdMs = typeof rec.createdAt === 'number'
      ? rec.createdAt
      : typeof rec.createdAt === 'string'
        ? Date.parse(rec.createdAt)
        : NaN;
    if (Number.isFinite(createdMs) && createdMs > 0) {
      oldest = oldest === null ? createdMs : Math.min(oldest, createdMs);
      newest = newest === null ? createdMs : Math.max(newest, createdMs);
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
const apiFailureSeen = new Map();
function apiFailureEventDue(sig) {
  const now = Date.now();
  if (now - (apiFailureSeen.get(sig) || 0) < 10 * 60 * 1000) return false;
  apiFailureSeen.set(sig, now);
  if (apiFailureSeen.size > 200) {
    for (const [k, t] of apiFailureSeen) {
      if (now - t >= 10 * 60 * 1000) apiFailureSeen.delete(k);
    }
  }
  return true;
}

async function recordApiEvent(env, ctx, request, url, status, ms, errName) {
  if (request.method === 'OPTIONS') return;
  const p = url.pathname;
  if (p === '/api/diag' || p === '/api/version') return;
  const isApi = p.startsWith('/api/');
  const isSub = p.startsWith('/sub/');
  if (!isApi && !isSub) return;
  if (isSub && status === 200) return;
  // /sub 403s stay unrecorded: a wrong per-entry link token carries
  // no signal worth a KV write (the tokens are 128-bit HMACs). /api
  // 403s are different — the admin token is human-chosen, and an
  // online guessing run used to leave no trace anywhere: no throttle,
  // no log. They now flow into the same per-signature failure
  // throttle as every other failure below, so a burst costs at most
  // one ring write per route template per 10 minutes, while the
  // first sighting still lands immediately.
  if (status === 403 && !isApi) return;
  // Only known route templates are recorded. An unknown /api path is
  // caller-controlled text: recording it verbatim would let anyone
  // write arbitrary strings into the (shareable) diagnostics log.
  const routePath = isSub
    ? '/sub/:id'
    : DIAG_KNOWN_ROUTES.has(p)
      ? p
      : '/api/*';
  // Failure events are throttled per signature (method + route
  // template + status + error name). Each recorded event costs a KV
  // read and a write, and the failure paths are precisely the ones
  // that can repeat without any token: junk requests to unknown /api
  // paths (404) and dead subscription links retried by clients (404).
  // Unthrottled, a few hundred of those could burn the free tier's
  // daily write quota and take the owner's own saves down with it.
  // The first sighting of each failure still lands immediately, and
  // successes are never throttled (the activity timeline is the
  // point, and those paths are token-gated or healthy fetches).
  if (status !== 200 && !apiFailureEventDue(`${request.method} ${routePath}|${status}|${errName || ''}`)) return;
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
        // No CORS grants at all: the admin UI is same-origin and
        // needs no preflight, and subscription bodies are
        // credentials. The wildcard preflight this replaces (any
        // origin, x-admin-token allowed) contradicted the removal
        // of ACAO from the actual responses. A bare 204 tells
        // browsers there is simply nothing cross-origin here.
        if (url.pathname.startsWith('/api/')) return new Response(null, { status: 204 });
        return text('not found', 404);
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
        const assetResp = await env.ASSETS.fetch(request);
        // The admin page holds the management token: it must not be
        // framed by another site (clickjacking), sniffed into a
        // different content type, or leak its URL as a referrer.
        const headers = new Headers(assetResp.headers);
        headers.set('x-frame-options', 'SAMEORIGIN');
        headers.set('content-security-policy', "frame-ancestors 'self'");
        headers.set('x-content-type-options', 'nosniff');
        headers.set('referrer-policy', 'same-origin');
        return new Response(assetResp.body, {
          status: assetResp.status,
          statusText: assetResp.statusText,
          headers,
        });
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