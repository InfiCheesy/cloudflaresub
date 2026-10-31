import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const store = new Map(); // name -> { value, metadata, expirationTtl }
const env = {
  SUB_STORE: {
    async get(k) { return store.get(k)?.value ?? null; },
    async put(k, v, opts = {}) { store.set(k, { value: v, metadata: opts.metadata, expirationTtl: opts.expirationTtl }); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .slice(0, limit)
        .map(([name, e]) => ({ name, metadata: e.metadata }));
      return { keys, list_complete: true, cursor: '' };
    },
  },
  ASSETS: { async fetch() { return new Response('HOME'); } },
  SUB_ACCESS_TOKEN: 'tok',
};

const adminReq = (path, token = 'tok') =>
  new Request(`https://x.pages.dev${path}`, { headers: { 'x-admin-token': token } });
const linkTokens = new Map(); // entry id -> its per-entry link token
async function generate(body) {
  const r = await worker.fetch(new Request('https://x.pages.dev/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok', ...body }),
  }), env);
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  if (j.shortId && j.urls) linkTokens.set(j.shortId, new URL(j.urls.auto).searchParams.get('token') || '');
  return j;
}
async function getSub(id, target, tokenOverride) {
  const token = tokenOverride !== undefined ? tokenOverride : linkTokens.get(id);
  const q = new URLSearchParams();
  if (target) q.set('target', target);
  if (token) q.set('token', token);
  const r = await worker.fetch(new Request(`https://x.pages.dev/sub/${id}?${q}`), env);
  return { status: r.status, body: await r.text() };
}

// --- Owner's example: plain links must match the expected strings exactly ---
const node = 'vless://f541611e-0aeb-4900-aa47-6e95d4916a49@walh6h3rdnazjx.topoffice.dpdns.org:443?alpn=http%2F1.1&encryption=none&fp=chrome&host=walh6h3rdnazjx.topoffice.dpdns.org&path=%2Fws-path&security=tls&sni=walh6h3rdnazjx.topoffice.dpdns.org&type=ws#%E7%BE%8E%E5%9B%BD33-freetrialtelegram';
const j1 = await generate({ nodeLinks: node, preferredIps: 'bestcf.top\ncf.877774.xyz', namePrefix: 'v4v6双栈-高速优选', keepOriginalHost: true });
const frag = (n) => encodeURIComponent(n);
const expect1 = 'vless://f541611e-0aeb-4900-aa47-6e95d4916a49@bestcf.top:443?alpn=http%2F1.1&encryption=none&fp=chrome&host=walh6h3rdnazjx.topoffice.dpdns.org&path=%2Fws-path&security=tls&sni=walh6h3rdnazjx.topoffice.dpdns.org&type=ws#' + frag('美国33-freetrialtelegram | v4v6双栈-高速优选 | 1');
const expect2 = expect1.replace('@bestcf.top', '@cf.877774.xyz').replace(frag('| 1'), frag('| 2'));
assert.equal(j1.plainText, expect1 + '\n' + expect2);
const sub = await getSub(j1.shortId, 'plain');
assert.equal(sub.status, 200);
assert.equal(sub.body, expect1 + '\n' + expect2);
const rawSub = await getSub(j1.shortId, 'raw');
assert.equal(Buffer.from(rawSub.body, 'base64').toString('utf8'), expect1 + '\n' + expect2);
console.log('owner example: plain output matches exactly, raw = base64(plain)');

// --- IPv6 preferred endpoints ---
const j2 = await generate({ nodeLinks: node, preferredIps: '2606:4700:4700::1111#v6-bare\n[2606:4700:4700::1001]:8443#v6-port\n2001:db8::1', namePrefix: '', keepOriginalHost: true });
const links = j2.plainText.split('\n');
assert.equal(links.length, 3);
assert.ok(links[0].includes('@[2606:4700:4700::1111]:443?'), links[0]); // bare v6 kept whole, default port, bracketed in URL
assert.ok(links[1].includes('@[2606:4700:4700::1001]:8443?'), links[1]); // bracketed v6 + explicit port
assert.ok(links[2].includes('@[2001:db8::1]:443?'), links[2]);          // "2001:db8::1" must not lose "::1" as a port
const clash = await getSub(j2.shortId, 'clash');
assert.ok(clash.body.includes('server: "2606:4700:4700::1111"'), clash.body.split('\n').slice(8,14).join('\n'));
const vm = await generate({ nodeLinks: 'vmess://ewogICJ2IjogIjIiLAogICJwcyI6ICJkZW1vIiwKICAiYWRkIjogImVkZ2UuZXhhbXBsZS5jb20iLAogICJwb3J0IjogIjQ0MyIsCiAgImlkIjogIjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsCiAgInNjeSI6ICJhdXRvIiwKICAibmV0IjogIndzIiwKICAidGxzIjogInRscyIsCiAgInBhdGgiOiAiL3dzIiwKICAiaG9zdCI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAic25pIjogImVkZ2UuZXhhbXBsZS5jb20iCn0=', preferredIps: '2606:4700::1' });
const vmPayload = JSON.parse(Buffer.from(vm.plainText.replace('vmess://',''), 'base64').toString('utf8'));
assert.equal(vmPayload.add, '2606:4700::1'); // vmess add is the bare address, no brackets/truncation
console.log('ipv6: bare, bracketed and bracketed+port all parse and render correctly');

console.log('worker tests passed');

// --- Permanent storage + notes + admin (appended suite) ---
{
  // seed a legacy entry: written the OLD way, with a 7-day TTL, no note/metadata
  const legacyId = 'legacyID01';
  store.set(`sub:${legacyId}`, {
    value: JSON.stringify({ version: 1, createdAt: '2026-10-20T00:00:00.000Z', options: {}, nodes: [] }),
    expirationTtl: 60 * 60 * 24 * 7,
  });

  const nodeA = 'vless://f541611e-0aeb-4900-aa47-6e95d4916a49@vps-a.example.com:443?security=tls&type=ws&path=%2Fws&host=vps-a.example.com&sni=vps-a.example.com#VPS-A%E8%8A%82%E7%82%B9';
  const g = await generate({ nodeLinks: nodeA, preferredIps: 'bestcf.top', note: '搬瓦工 DC6' });
  assert.equal(g.note, '搬瓦工 DC6');
  const entry = store.get(`sub:${g.shortId}`);
  assert.ok(entry, 'record stored');
  assert.equal(entry.expirationTtl, undefined, 'record must be stored permanently (no TTL)');
  const rec = JSON.parse(entry.value);
  assert.equal(rec.note, '搬瓦工 DC6');
  assert.equal(rec.sources[0].server, 'vps-a.example.com');
  assert.equal(entry.metadata.note, '搬瓦工 DC6');
  assert.equal(entry.metadata.sources, 'vps-a.example.com');
  assert.equal(store.get(`note:搬瓦工 DC6:${g.shortId}`)?.value, g.shortId, 'note pointer key exists');
  const dedupKey = [...store.keys()].find((k) => k.startsWith('dedup:'));
  assert.equal(store.get(dedupKey).expirationTtl, undefined, 'dedup key permanent too');

  // Same content again with a different note: same id, note updated, pointers swapped
  const g2 = await generate({ nodeLinks: nodeA, preferredIps: 'bestcf.top', note: '搬瓦工 DC9' });
  assert.equal(g2.shortId, g.shortId);
  assert.equal(JSON.parse(store.get(`sub:${g.shortId}`).value).note, '搬瓦工 DC9');
  assert.equal(store.has(`note:搬瓦工 DC6:${g.shortId}`), false, 'old pointer removed');
  assert.equal(store.get(`note:搬瓦工 DC9:${g.shortId}`)?.value, g.shortId);

  // Admin auth
  const badList = await worker.fetch(adminReq('/api/list', 'wrong'), env);
  assert.equal(badList.status, 403);
  const listResp = await worker.fetch(adminReq('/api/list'), env);
  const list = await listResp.json();
  assert.equal(list.ok, true);
  const mine = list.items.find((i) => i.id === g.shortId);
  assert.equal(mine.note, '搬瓦工 DC9');
  assert.deepEqual(mine.sources, ['vps-a.example.com']);
  assert.ok(list.items.some((i) => i.id === legacyId), 'legacy entry listed via fallback');

  // Rename via admin endpoint
  const noteResp = await worker.fetch(new Request('https://x.pages.dev/api/note', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: g.shortId, note: '主力美国 VPS', token: 'tok' }),
  }), env);
  assert.equal((await noteResp.json()).ok, true);
  assert.equal(JSON.parse(store.get(`sub:${g.shortId}`).value).note, '主力美国 VPS');
  assert.equal(store.get(`note:主力美国 VPS:${g.shortId}`)?.value, g.shortId);
  assert.equal(store.has(`note:搬瓦工 DC9:${g.shortId}`), false);

  // Renaming the LEGACY entry also strips its 7-day TTL (rewritten permanently)
  const legacyNote = await worker.fetch(new Request('https://x.pages.dev/api/note', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: legacyId, note: '旧条目', token: 'tok' }),
  }), env);
  assert.equal((await legacyNote.json()).ok, true);
  assert.equal(store.get(`sub:${legacyId}`).expirationTtl, undefined, 'legacy entry migrated to permanent on note save');

  // Delete removes record + pointer + dedup key, and the sub link dies
  const myDedupKey = [...store.entries()].find(([k, e]) => k.startsWith('dedup:') && e.value === g.shortId)?.[0];
  assert.ok(myDedupKey, 'found this entry dedup key');
  const del = await worker.fetch(new Request('https://x.pages.dev/api/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: g.shortId, token: 'tok' }),
  }), env);
  assert.equal((await del.json()).ok, true);
  assert.equal(store.has(`sub:${g.shortId}`), false);
  assert.equal(store.has(`note:主力美国 VPS:${g.shortId}`), false);
  assert.equal(store.has(myDedupKey), false, 'dedup key removed');
  const gone = await worker.fetch(new Request(`https://x.pages.dev/sub/${g.shortId}?token=${linkTokens.get(g.shortId)}`), env);
  assert.equal(gone.status, 404);
  console.log('permanent storage, notes, pointers, admin list/note/delete, legacy migration: all passed');
}

// --- Retention choice suite ---
{
  const nodeB = 'vless://f541611e-0aeb-4900-aa47-6e95d4916a49@vps-b.example.com:443?security=tls&type=ws&path=%2Fws&host=vps-b.example.com&sni=vps-b.example.com#B';

  // days mode: both keys carry the TTL, record + metadata know the plan
  const before = Date.now();
  const timed = await generate({ nodeLinks: nodeB, preferredIps: 'bestcf.top', storageMode: 'days', retentionDays: 7, note: '临时条目' });
  assert.equal(timed.storage.mode, 'days');
  assert.equal(timed.storage.days, 7);
  const expiresMs = Date.parse(timed.storage.expiresAt);
  assert.ok(expiresMs - before >= 7 * 86400 * 1000 - 5000 && expiresMs - before <= 7 * 86400 * 1000 + 5000, 'expiresAt ~= now + 7d');
  assert.equal(store.get(`sub:${timed.shortId}`).expirationTtl, 7 * 86400, 'record TTL = 7d');
  const dk = [...store.entries()].find(([k, e]) => k.startsWith('dedup:') && e.value === timed.shortId)?.[0];
  assert.equal(store.get(dk).expirationTtl, 7 * 86400, 'dedup TTL = 7d');
  assert.equal(store.get(`sub:${timed.shortId}`).metadata.retention, 'days:7');
  assert.equal(store.get(`sub:${timed.shortId}`).metadata.exp, timed.storage.expiresAt);

  // list surfaces the plan
  const lr = await (await worker.fetch(adminReq('/api/list'), env)).json();
  const li = lr.items.find((i) => i.id === timed.shortId);
  assert.equal(li.storage.mode, 'days'); assert.equal(li.storage.days, 7); assert.equal(li.storage.expiresAt, timed.storage.expiresAt);

  // saving a note preserves (approximately) the remaining TTL instead of wiping it
  const nr = await worker.fetch(new Request('https://x.pages.dev/api/note', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: timed.shortId, note: '临时条目改名', token: 'tok' }),
  }), env);
  assert.equal((await nr.json()).ok, true);
  const ttlAfter = store.get(`sub:${timed.shortId}`).expirationTtl;
  assert.ok(ttlAfter <= 7 * 86400 && ttlAfter > 7 * 86400 - 3600, `note save keeps remaining TTL, got ${ttlAfter}`);
  assert.equal(JSON.parse(store.get(`sub:${timed.shortId}`).value).storage.expiresAt, timed.storage.expiresAt, 'expiresAt unchanged by note save');

  // regenerate same content as permanent: same id, TTL gone, plan switched
  const again = await generate({ nodeLinks: nodeB, preferredIps: 'bestcf.top', storageMode: 'permanent' });
  assert.equal(again.shortId, timed.shortId);
  assert.equal(again.storage.mode, 'permanent');
  assert.equal(store.get(`sub:${timed.shortId}`).expirationTtl, undefined, 'switched back to permanent');
  assert.equal(store.get(dk).expirationTtl, undefined, 'dedup permanent again');
  assert.equal(JSON.parse(store.get(`sub:${timed.shortId}`).value).note, '临时条目改名', 'note survives retention switch when no new note given');

  // invalid days rejected
  const bad = await worker.fetch(new Request('https://x.pages.dev/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', nodeLinks: nodeB, preferredIps: 'bestcf.top', storageMode: 'days', retentionDays: 0 }),
  }), env);
  assert.equal(bad.status, 400);
  console.log('retention: days/permanent switching, TTL values, note-save preservation, validation: all passed');

  // --- POST /api/retention: change an existing entry's retention plan ---
  const retPost = (payload, token = 'tok') => worker.fetch(new Request('https://x.pages.dev/api/retention', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, ...payload }),
  }), env);
  // entry is permanent right now; give it 10 days from now
  let rr = await retPost({ id: timed.shortId, mode: 'days', days: 10 });
  assert.equal(rr.status, 200, 'retention days: status');
  let rj = await rr.json();
  assert.equal(rj.storage.mode, 'days');
  assert.equal(rj.storage.days, 10);
  const drift = Math.abs(Date.parse(rj.storage.expiresAt) - (Date.now() + 10 * 86400e3));
  assert.ok(drift < 120000, 'expiresAt is ~10 days from now');
  assert.equal(store.get(`sub:${timed.shortId}`).expirationTtl, 10 * 86400, 'record TTL updated to 10d');
  assert.equal(store.get(dk).expirationTtl, 10 * 86400, 'dedup TTL updated to 10d');
  assert.equal(JSON.parse(store.get(`sub:${timed.shortId}`).value).note, '临时条目改名', 'note survives retention change');
  // list reflects the new plan
  const lr2 = await (await worker.fetch(adminReq('/api/list'), env)).json();
  const listed1 = lr2.items.find((i) => i.id === timed.shortId);
  assert.equal(listed1.storage.mode, 'days');
  assert.equal(listed1.storage.days, 10);
  // back to permanent clears both TTLs
  rr = await retPost({ id: timed.shortId, mode: 'permanent' });
  assert.equal(rr.status, 200);
  assert.equal(store.get(`sub:${timed.shortId}`).expirationTtl, undefined, 'record permanent again');
  assert.equal(store.get(dk).expirationTtl, undefined, 'dedup permanent again');
  // validation + auth + missing entry
  assert.equal((await retPost({ id: timed.shortId, mode: 'days', days: 0 })).status, 400, 'days=0 rejected');
  assert.equal((await retPost({ id: timed.shortId, mode: 'days', days: 99999 })).status, 400, 'days too large rejected');
  assert.equal((await retPost({ id: 'nope999', mode: 'permanent' })).status, 404, 'unknown id 404');
  assert.equal((await retPost({ id: timed.shortId, mode: 'permanent' }, 'wrong')).status, 403, 'wrong token 403');
  console.log('retention endpoint: plan switching, TTL sync, list reflection, validation: all passed');

  // --- GET /api/entry: direct read used by the UI's write verification ---
  const er = await worker.fetch(adminReq(`/api/entry?id=${timed.shortId}`), env);
  assert.equal(er.status, 200, 'entry read: status');
  const ej = await er.json();
  assert.equal(ej.note, '临时条目改名', 'entry read: note straight from the record');
  assert.equal(ej.storage.mode, 'permanent', 'entry read: storage straight from the record');
  assert.equal((await worker.fetch(adminReq('/api/entry?id=nope999'), env)).status, 404, 'entry read: unknown id 404');
  assert.equal((await worker.fetch(adminReq(`/api/entry?id=${timed.shortId}`, 'wrong'), env)).status, 403, 'entry read: wrong token 403');
  console.log('entry endpoint: direct read, 404, 403: all passed');

  // --- Regression: list must follow the RECORD, not the (lagging) metadata ---
  // Give the entry a 3-day plan via the endpoint, then rewind the stored
  // key metadata to the old permanent plan, simulating a stale list index.
  await retPost({ id: timed.shortId, mode: 'days', days: 3 });
  const subKey = `sub:${timed.shortId}`;
  const freshMeta = store.get(subKey).metadata;
  store.get(subKey).metadata = { ...freshMeta, retention: 'permanent', exp: '' };
  const lr3 = await (await worker.fetch(adminReq('/api/list'), env)).json();
  const listed3 = lr3.items.find((i) => i.id === timed.shortId);
  assert.equal(listed3.storage.mode, 'days', 'list shows the record plan despite stale metadata');
  assert.equal(listed3.storage.days, 3, 'list shows the record days despite stale metadata');
  assert.equal(listed3.note, '临时条目改名', 'list note also comes from the record');
  // restore: back to permanent for a clean end state
  await retPost({ id: timed.shortId, mode: 'permanent' });
  console.log('list record-source regression: passed');

  // --- Regression: a deleted entry still enumerated by the list index
  // (ghost key, record already gone) must NOT appear in /api/list ---
  store.set('sub:ghost000', {
    value: null,
    metadata: { note: '幽灵条目', createdAt: '2026-10-28T00:00:00.000Z', sources: 'gone.example.com', out: 1, retention: 'permanent', exp: '' },
    expirationTtl: undefined,
  });
  const lr4 = await (await worker.fetch(adminReq('/api/list'), env)).json();
  assert.ok(!lr4.items.some((i) => i.id === 'ghost000'), 'ghost key skipped in list');
  store.delete('sub:ghost000');
  console.log('ghost key regression: passed');
}

// --- Form backfill suite: exact inputs for new entries, reconstruction for legacy ---
{
  const getEntry = async (id) => {
    const r = await worker.fetch(adminReq(`/api/entry?id=${id}`), env);
    return r.json();
  };

  // 1) New entry: backfill is the verbatim form input.
  const nodeA = 'vless://11111111-2222-4333-8444-555555555555@edge-a.example.com:443?encryption=none&security=tls&sni=edge-a.example.com&host=edge-a.example.com&type=ws&path=%2Fws#NodeA';
  const nodeB = 'trojan://pw123@edge-b.example.com:8443?security=tls&sni=edge-b.example.com&type=ws&host=edge-b.example.com&path=%2Ftj#NodeB';
  const gen = await generate({
    nodeLinks: `${nodeA}\n${nodeB}`,
    preferredIps: '198.51.100.7:2053#P1\nbestcf.example.net',
    namePrefix: 'PX', keepOriginalHost: true, note: '回填测试',
    storageMode: 'days', retentionDays: 12,
  });
  const e1 = await getEntry(gen.shortId);
  assert.equal(e1.backfill.exact, true, 'new entry backfills exactly');
  assert.equal(e1.backfill.nodeLinks, `${nodeA}\n${nodeB}`);
  assert.equal(e1.backfill.preferredIps, '198.51.100.7:2053#P1\nbestcf.example.net');
  assert.equal(e1.backfill.namePrefix, 'PX');
  assert.equal(e1.backfill.keepOriginalHost, true);
  assert.equal(e1.backfill.note, '回填测试');
  assert.equal(e1.backfill.storage.mode, 'days');
  assert.equal(e1.backfill.storage.days, 12);

  // 2) Legacy entry (inputs stripped): reconstruction restores the
  //    preferred list verbatim (port + remark on #1, portless domain on #2)
  //    and the originals well enough that regenerating dedup-hits the
  //    very same entry; the dedup hit then backfills exact inputs.
  const key = `sub:${gen.shortId}`;
  const rec = JSON.parse(store.get(key).value);
  delete rec.inputs;
  store.get(key).value = JSON.stringify(rec);
  const e2 = await getEntry(gen.shortId);
  assert.equal(e2.backfill.exact, false, 'legacy entry uses reconstruction');
  assert.equal(e2.backfill.preferredIps, '198.51.100.7:2053#P1\nbestcf.example.net', 'reconstructed preferred list');
  const regen = await generate({
    nodeLinks: e2.backfill.nodeLinks,
    preferredIps: e2.backfill.preferredIps,
    namePrefix: e2.backfill.namePrefix,
    keepOriginalHost: e2.backfill.keepOriginalHost,
  });
  assert.equal(regen.shortId, gen.shortId, 'reconstructed inputs regenerate the same entry');
  const e3 = await getEntry(gen.shortId);
  assert.equal(e3.backfill.exact, true, 'dedup hit backfills exact inputs onto legacy record');

  // 3) vmess round-trip: reconstruction regenerates identical subscription
  //    content (the re-encoded vmess text differs, so no id assertion).
  const nodeC = 'vmess://ewogICJ2IjogIjIiLAogICJwcyI6ICJkZW1vIiwKICAiYWRkIjogImVkZ2UuZXhhbXBsZS5jb20iLAogICJwb3J0IjogIjQ0MyIsCiAgImlkIjogIjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsCiAgInNjeSI6ICJhdXRvIiwKICAibmV0IjogIndzIiwKICAidGxzIjogInRscyIsCiAgInBhdGgiOiAiL3dzIiwKICAiaG9zdCI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAic25pIjogImVkZ2UuZXhhbXBsZS5jb20iCn0=';
  const genC = await generate({ nodeLinks: nodeC, preferredIps: '192.0.2.10:8443\n192.0.2.11', namePrefix: 'PX', keepOriginalHost: true });
  const keyC = `sub:${genC.shortId}`;
  const recC = JSON.parse(store.get(keyC).value);
  delete recC.inputs;
  store.get(keyC).value = JSON.stringify(recC);
  const eC = await getEntry(genC.shortId);
  assert.equal(eC.backfill.exact, false);
  assert.equal(eC.backfill.preferredIps, '192.0.2.10:8443\n192.0.2.11', 'counter suffixes are not mistaken for remarks');
  const regenC = await generate({
    nodeLinks: eC.backfill.nodeLinks,
    preferredIps: eC.backfill.preferredIps,
    namePrefix: eC.backfill.namePrefix,
    keepOriginalHost: eC.backfill.keepOriginalHost,
  });
  assert.equal(regenC.plainText, genC.plainText, 'vmess reconstruction regenerates identical content');

  // 4) Record without sources/nodes cannot be backfilled.
  store.set('sub:ancient1', { value: JSON.stringify({ version: 1, createdAt: '2026-01-01T00:00:00.000Z' }), metadata: {}, expirationTtl: undefined });
  const e4 = await getEntry('ancient1');
  assert.equal(e4.backfill, null, 'record without sources/nodes: backfill null');
  store.delete('sub:ancient1');

  // 5) Delete removes the stored inputs along with everything else: the
  //    inputs live INSIDE the single sub:<id> record value (no separate
  //    key), and delete clears record + note pointer + dedup key.
  const genD = await generate({ nodeLinks: nodeA, preferredIps: '203.0.113.9', namePrefix: 'D', note: '待删条目' });
  const recD = JSON.parse(store.get(`sub:${genD.shortId}`).value);
  assert.ok(recD.inputs && recD.inputs.nodeLinks === nodeA, 'inputs stored inside the record');
  const keysBefore = [...store.keys()].filter((k) => k.includes(genD.shortId) || k === `dedup:${recD.dedupHash}`);
  assert.equal(keysBefore.length, 3, 'record + note pointer + dedup key exist before delete');
  const delResp = await worker.fetch(new Request('https://x.pages.dev/api/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: genD.shortId, token: 'tok' }),
  }), env);
  assert.equal((await delResp.json()).ok, true);
  const keysAfter = [...store.keys()].filter((k) => k.includes(genD.shortId) || k === `dedup:${recD.dedupHash}`);
  assert.equal(keysAfter.length, 0, 'delete leaves no trace of the entry, inputs included');
  const e5 = await worker.fetch(adminReq(`/api/entry?id=${genD.shortId}`), env);
  assert.equal(e5.status, 404, 'deleted entry reads 404');
  console.log('backfill suite: exact, reconstruction, round-trips, null case, delete cleanup passed');
}

// --- Preview suite: ALL generated nodes are previewed, not just 20 ---
{
  const eps = Array.from({ length: 15 }, (_, i) => `10.0.0.${i + 1}`).join('\n');
  const vmessLink = 'vmess://ewogICJ2IjogIjIiLAogICJwcyI6ICJkZW1vIiwKICAiYWRkIjogImVkZ2UuZXhhbXBsZS5jb20iLAogICJwb3J0IjogIjQ0MyIsCiAgImlkIjogIjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsCiAgInNjeSI6ICJhdXRvIiwKICAibmV0IjogIndzIiwKICAidGxzIjogInRscyIsCiAgInBhdGgiOiAiL3dzIiwKICAiaG9zdCI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAic25pIjogImVkZ2UuZXhhbXBsZS5jb20iCn0=';
  const big = await generate({ nodeLinks: `${node}\n${vmessLink}`, preferredIps: eps });
  assert.equal(big.counts.outputNodes, 30, 'fixture really generates 30 nodes');
  assert.equal(big.preview.length, 30, 'preview lists every generated node');
  assert.equal(big.preview[29].name.endsWith('| 30'), true, 'last preview row is the 30th node');
  console.log('preview suite: all 30 nodes previewed, no 20-cap');
}

// --- Link token suite: sharing a subscription must not leak admin access ---
{
  const linkTokA = linkTokens.get(j1.shortId);
  assert.match(linkTokA, /^[0-9a-f]{32}$/, 'link token is a 32-hex HMAC prefix');
  assert.notEqual(linkTokA, 'tok');
  assert.ok(!j1.urls.auto.includes('token=tok'), 'generated urls never carry the admin token');
  assert.equal(new URL(j1.urls.auto).searchParams.get('token'), linkTokA);

  // The admin token itself no longer opens a subscription; neither does a
  // missing token, nor ANOTHER entry's link token.
  assert.equal((await getSub(j1.shortId, 'raw', 'tok')).status, 403, 'admin token must not open /sub');
  assert.equal((await getSub(j1.shortId, 'raw', '')).status, 403, 'missing link token 403');
  const jB = await generate({ nodeLinks: node, preferredIps: '198.51.100.23', namePrefix: 'B' });
  const linkTokB = linkTokens.get(jB.shortId);
  assert.ok(linkTokB && linkTokB !== linkTokA, 'each entry gets its own link token');
  assert.equal((await getSub(jB.shortId, 'raw', linkTokA)).status, 403, "entry A's link token must not open entry B");
  assert.equal((await getSub(jB.shortId, 'raw')).status, 200, 'entry B opens with its own link token');

  // A link token is worthless at the admin endpoints.
  const listByLink = await worker.fetch(new Request('https://x.pages.dev/api/list', { headers: { 'x-admin-token': linkTokA } }), env);
  assert.equal(listByLink.status, 403, 'link token must not list entries');
  const noteByLink = await worker.fetch(new Request('https://x.pages.dev/api/note', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: j1.shortId, note: 'pwned', token: linkTokA }),
  }), env);
  assert.equal(noteByLink.status, 403, 'link token must not modify entries');

  // The admin-authenticated reads hand the frontend each entry's link
  // token, matching the token in the generated urls.
  const lr = await (await worker.fetch(adminReq('/api/list'), env)).json();
  const itemA = lr.items.find((i) => i.id === j1.shortId);
  assert.equal(itemA.linkToken, linkTokA, 'list item carries the same link token');
  const er = await (await worker.fetch(adminReq(`/api/entry?id=${j1.shortId}`), env)).json();
  assert.equal(er.linkToken, linkTokA, 'entry read carries the same link token');

  // Surge output embeds the per-entry link token, never the admin
  // token. (j1 is vless-only, and since audit round 9 its Surge
  // target answers a clear 400 instead of an empty profile — so the
  // token-embedding check runs on a trojan entry.)
  const jTrojan = await generate({ nodeLinks: 'trojan://pw@tj.example.com:443#tj', preferredIps: '203.0.113.9' });
  const surge = await getSub(jTrojan.shortId, 'surge');
  assert.equal(surge.status, 200);
  assert.ok(surge.body.includes(`?token=${linkTokens.get(jTrojan.shortId)}`), 'surge profile carries the link token');
  assert.ok(!surge.body.includes('token=tok'), 'surge profile must not contain the admin token');
  const surgeVless = await getSub(j1.shortId, 'surge');
  assert.equal(surgeVless.status, 400, 'vless-only surge target is a clear error (audit round 9)');
  console.log('link token suite: per-entry tokens, admin token rejected at /sub, link token rejected at admin: passed');
}

// --- Audit-fix suite (2026-10-28): parse tolerance, Surge injection,
//     pointer TTL, port range, prefix cap, generate auth, UA auto ---
{
  // Generate requires the admin token once one is configured.
  const noTok = await worker.fetch(new Request('https://x.pages.dev/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeLinks: node, preferredIps: '1.2.3.4' }),
  }), env);
  assert.equal(noTok.status, 403, 'generate without token 403');
  const wrongTok = await worker.fetch(new Request('https://x.pages.dev/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'nope', nodeLinks: node, preferredIps: '1.2.3.4' }),
  }), env);
  assert.equal(wrongTok.status, 403, 'generate with wrong token 403');

  // One bad line no longer kills the batch; it is skipped and reported.
  const mixed = await generate({
    nodeLinks: node + '\nvmess://!!!broken!!!\nvless://not a url',
    preferredIps: '10.9.9.9',
  });
  assert.equal(mixed.counts.inputNodes, 1, 'only the valid node survives');
  assert.ok(mixed.warnings.some((w) => w.includes('已跳过')), 'skipped lines are reported in warnings');

  // Surge injection: a newline in a node name must not create config lines.
  const evil = 'trojan://pw@edge.example.com:443?security=tls#innocent%0AInjected%20%3D%20trojan%2C%20attacker.example.com%2C%20443%2C%20password%3Dpw2';
  const ej = await generate({ nodeLinks: evil, preferredIps: '10.9.9.8' });
  const eSub = await getSub(ej.shortId, 'surge');
  assert.equal(eSub.status, 200);
  assert.ok(!eSub.body.split('\n').some((l) => l.startsWith('Injected')), 'no injected Surge line');
  assert.ok(!eSub.body.includes('attacker.example.com, 443, password=pw2\n'), 'injected payload not present as a line');

  // The note pointer key shares the record's TTL, across retention edits.
  const timed = await generate({ nodeLinks: node, preferredIps: '10.9.9.7', note: 'ttl-note', storageMode: 'days', retentionDays: 3 });
  const ptrKey = `note:ttl-note:${timed.shortId}`;
  assert.equal(store.get(ptrKey)?.expirationTtl, 259200, 'pointer carries the same TTL as the record');
  const ret = (payload) => worker.fetch(new Request('https://x.pages.dev/api/retention', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', ...payload }),
  }), env);
  await ret({ id: timed.shortId, mode: 'permanent' });
  assert.equal(store.get(ptrKey)?.expirationTtl, undefined, 'pointer TTL cleared with permanent');
  await ret({ id: timed.shortId, mode: 'days', days: 9 });
  assert.equal(store.get(ptrKey)?.expirationTtl, 777600, 'pointer TTL follows retention changes');

  // Out-of-range preferred port is a clear 400, not a generated dud.
  const badPort = await worker.fetch(new Request('https://x.pages.dev/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', nodeLinks: node, preferredIps: '1.2.3.4:99999' }),
  }), env);
  assert.equal(badPort.status, 400, 'port 99999 rejected');

  // The name prefix is capped before hashing: prefixes that differ only
  // past the cap produce the SAME entry, and names stay bounded.
  const capA = await generate({ nodeLinks: node, preferredIps: '10.9.9.6', namePrefix: 'A'.repeat(100) + 'X'.repeat(60) });
  const capB = await generate({ nodeLinks: node, preferredIps: '10.9.9.6', namePrefix: 'A'.repeat(100) + 'Y'.repeat(60) });
  assert.equal(capA.shortId, capB.shortId, 'prefix capped before dedup hash');
  assert.ok(capA.preview[0].name.length < 160, 'node names stay bounded');

  // "Auto" adapts to the client: Clash UA -> YAML, Surge UA -> profile,
  // anything else -> the historical base64 raw.
  const linkTok = linkTokens.get(j1.shortId);
  const fetchAuto = (ua) => worker.fetch(new Request(`https://x.pages.dev/sub/${j1.shortId}?token=${linkTok}`, {
    headers: { 'user-agent': ua },
  }), env);
  const clashAuto = await (await fetchAuto('ClashforWindows/0.20.39')).text();
  assert.ok(clashAuto.startsWith('mixed-port:'), 'clash UA gets clash yaml');
  // The Surge-UA check needs a Surge-supported entry (j1 is vless-only
  // and now answers the audit-9 400 on the surge target).
  const jTj2 = await generate({ nodeLinks: 'trojan://pw@tj2.example.com:443#tj2', preferredIps: '203.0.113.10' });
  const surgeAutoResp = await worker.fetch(new Request('https://x.pages.dev/sub/' + jTj2.shortId + '?token=' + linkTokens.get(jTj2.shortId), { headers: { 'user-agent': 'Surge/5.10.0' } }), env);
  const surgeAuto = await surgeAutoResp.text();
  assert.ok(surgeAuto.includes('[Proxy]'), 'surge UA gets surge profile');
  const plainAuto = await (await fetchAuto('Mozilla/5.0')).text();
  assert.equal(Buffer.from(plainAuto, 'base64').toString('utf8'), j1.plainText, 'unknown UA keeps base64 raw');

  console.log('audit-fix suite: generate auth, parse tolerance, surge injection, pointer TTL, port range, prefix cap, UA auto: passed');
}

// --- Dynamic subscription suite: API preferred-IP sources ---
{
  const realFetch = globalThis.fetch;
  let txtList = '104.16.1.2\n104.16.1.3:8443\n104.16.1.4';
  let sourceDown = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (sourceDown) throw new Error('network down');
    if (u === 'https://ips.example.com/list.txt') return new Response(txtList, { status: 200 });
    if (u === 'https://fcdn.example.com/ips.txt' || u === 'https://10.example.com/ips.txt') return new Response(txtList, { status: 200 });
    if (u === 'https://ips.example.com/redir') {
      return { ok: true, status: 200, url: 'https://127.0.0.1/evil', headers: { get: () => null }, text: async () => txtList };
    }
    if (u === 'https://ips.example.com/list.json') return new Response(JSON.stringify(['104.16.5.5', '104.16.5.6:8443']), { status: 200 });
    if (u === 'https://ips.example.com/list.csv') return new Response('IP,port,colo\n104.16.7.7,443,HKG\n104.16.7.8,8443,SIN', { status: 200 });
    throw new Error('unexpected fetch ' + u);
  };
  try {
    // Source test endpoint: auth + parsing across formats + URL guards.
    const noTok = await worker.fetch(new Request('https://x.pages.dev/api/ip-source-test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://ips.example.com/list.txt' }),
    }), env);
    assert.equal(noTok.status, 403, 'ip-source-test requires the admin token');
    const testPost = (url) => worker.fetch(new Request('https://x.pages.dev/api/ip-source-test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok', url }),
    }), env).then((r) => r.json());
    const t1 = await testPost('https://ips.example.com/list.txt');
    assert.equal(t1.count, 3, 'txt source parsed');
    assert.ok(t1.sample.includes('104.16.1.3:8443'), 'txt sample keeps explicit port');
    assert.equal((await testPost('https://ips.example.com/list.json')).count, 2, 'json source parsed');
    assert.equal((await testPost('https://ips.example.com/list.csv')).count, 2, 'csv source parsed (endpoint = first cell)');
    const tHttp = await worker.fetch(new Request('https://x.pages.dev/api/ip-source-test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok', url: 'http://ips.example.com/list.txt' }),
    }), env);
    assert.equal(tHttp.status, 400, 'http source rejected');
    const tPriv = await worker.fetch(new Request('https://x.pages.dev/api/ip-source-test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok', url: 'https://127.0.0.1/list.txt' }),
    }), env);
    assert.equal(tPriv.status, 400, 'private-IP source rejected');

    // Generate a dynamic entry: the snapshot takes the first `limit`.
    const dyn = await generate({ nodeLinks: node, ipMode: 'api', sourceUrl: 'https://ips.example.com/list.txt', sourceLimit: 2 });
    assert.ok(dyn.dynamic && dyn.dynamic.sourceTotal === 3, 'dynamic metadata returned');
    assert.equal(dyn.counts.outputNodes, 2, 'limit applied at generation');
    assert.ok(dyn.plainText.includes('@104.16.1.2:443') && dyn.plainText.includes('@104.16.1.3:8443'), 'snapshot endpoints in order');
    const dynSub1 = await getSub(dyn.shortId, 'plain');
    assert.equal(dynSub1.body, dyn.plainText, 'sub initially serves the snapshot');

    // The source rotates; once the cache is stale, /sub follows it.
    txtList = '104.16.9.9\n104.16.9.10';
    const cacheKey = [...store.keys()].find((k) => k.startsWith('ipcache:'));
    assert.ok(cacheKey, 'source cached in KV');
    const ageCache = () => {
      const c = JSON.parse(store.get(cacheKey).value);
      c.fetchedAt = Date.now() - 2 * 3600e3;
      c.lastAttempt = 0;
      store.set(cacheKey, { value: JSON.stringify(c) });
    };
    ageCache();
    const dynSub2 = await getSub(dyn.shortId, 'plain');
    assert.ok(dynSub2.body.includes('@104.16.9.9:443') && dynSub2.body.includes('@104.16.9.10:443'), 'sub follows the rotated source');
    assert.ok(!dynSub2.body.includes('104.16.1.2'), 'old snapshot replaced');

    // Source down + stale cache: the cached list keeps serving.
    sourceDown = true;
    ageCache();
    const dynSub3 = await getSub(dyn.shortId, 'plain');
    assert.equal(dynSub3.status, 200);
    assert.ok(dynSub3.body.includes('@104.16.9.9:443'), 'stale cache serves while source is down');

    // Source down + cache gone: the generation-time snapshot serves.
    store.delete(cacheKey);
    const dynSub4 = await getSub(dyn.shortId, 'plain');
    assert.equal(dynSub4.status, 200);
    assert.ok(dynSub4.body.includes('@104.16.1.2:443'), 'entry snapshot is the final fallback');
    sourceDown = false;

    // Identity: re-generating against the same source hits the same
    // entry even though the list rotated in between.
    txtList = '104.16.1.2\n104.16.1.3:8443\n104.16.1.4';
    const dynAgain = await generate({ nodeLinks: node, ipMode: 'api', sourceUrl: 'https://ips.example.com/list.txt', sourceLimit: 2 });
    assert.equal(dynAgain.shortId, dyn.shortId, 'dynamic dedup is by source, not by resolved IPs');

    // The admin list flags the entry as dynamic.
    const lr = await (await worker.fetch(adminReq('/api/list'), env)).json();
    const item = lr.items.find((i) => i.id === dyn.shortId);
    assert.equal(item.dynamic, true, 'list item marks dynamic entries');
    assert.equal(item.sourceUrl, 'https://ips.example.com/list.txt');

    // Audit regressions (second self-audit): URL-guard false positives,
    // redirect smuggling, URL-normalization dedup, backfill snapshots.
    assert.equal((await testPost('https://fcdn.example.com/ips.txt')).count, 3, 'DNS names starting with fc are not private IPs');
    assert.equal((await testPost('https://10.example.com/ips.txt')).count, 3, 'DNS names starting with digits are not private IPs');
    const tRedir = await worker.fetch(new Request('https://x.pages.dev/api/ip-source-test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok', url: 'https://ips.example.com/redir' }),
    }), env);
    assert.equal(tRedir.status, 400, 'redirect to a private target is rejected');
    const v1 = await generate({ nodeLinks: node, ipMode: 'api', sourceUrl: 'https://IPS.example.com:443/list.txt', sourceLimit: 2 });
    const v2 = await generate({ nodeLinks: node, ipMode: 'api', sourceUrl: 'https://ips.example.com/list.txt', sourceLimit: 2 });
    assert.equal(v1.shortId, dyn.shortId, 'uppercase/default-port variant lands on the original entry');
    assert.equal(v2.shortId, v1.shortId, 'source URL spelling variants dedup to one entry');
    const entryResp = await (await worker.fetch(adminReq(`/api/entry?id=${dyn.shortId}`), env)).json();
    // Backfill contract after the mixed-box redesign: an entry made via
    // the legacy api payload backfills as its source line in the mixed
    // box, and regenerating from that line refreshes the same entry
    // (the single-source identity bridge keeps the legacy api: hash).
    assert.equal(entryResp.backfill.ipMode, 'mixed', 'backfill reports the mixed box');
    assert.equal(entryResp.backfill.preferredIps, 'https://ips.example.com/list.txt', 'backfill box holds the source line');
    const dynRe = await generate({ nodeLinks: node, preferredIps: 'https://ips.example.com/list.txt', sourceLimit: 2 });
    assert.equal(dynRe.shortId, dyn.shortId, 'lone-source mixed regeneration refreshes the legacy entry');
    console.log('dynamic suite: source parsing, follow-on-rotate, cache + snapshot fallbacks, source-based dedup: passed');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- Mixed-source suite: literal lines + multiple source URLs in one box ---
{
  const realFetch = globalThis.fetch;
  let listA = '104.16.2.2\n104.16.2.3:8443\n104.16.2.4';
  let downA = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://a.example.com/l.txt') {
      if (downA) throw new Error('network down');
      return new Response(listA, { status: 200 });
    }
    if (u === 'https://c.example.com/l.txt') return new Response(listA, { status: 200 });
    if (u === 'https://b.example.com/l.txt') return new Response('104.16.3.3\n104.16.2.3:8443', { status: 200 });
    if (u === 'https://dead.example.com/l.txt') throw new Error('network down');
    throw new Error('unexpected fetch ' + u);
  };
  const genRaw = (body) => worker.fetch(new Request('https://x.pages.dev/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', ...body }),
  }), env);
  try {
    const mixedText = '104.16.9.1#FIXED\nhttps://a.example.com/l.txt\nhttps://b.example.com/l.txt';
    const mix = await generate({ nodeLinks: node, preferredIps: mixedText, sourceLimit: 2 });
    assert.equal(mix.counts.preferredEndpoints, 4, 'literal + first-2 of each source, cross-source dup dropped');
    assert.equal(mix.counts.outputNodes, 4);
    assert.equal(mix.dynamic.sources.length, 2, 'both sources reported');
    assert.equal(mix.dynamic.sourceTotal, 5, 'source totals summed');
    assert.ok(mix.warnings.some((w) => w.includes('2 个来源')), 'multi-source warning');
    const order = ['104.16.9.1', '104.16.2.2', '104.16.2.3', '104.16.3.3'].map((s) => mix.plainText.indexOf(s));
    assert.ok(order.every((v, i) => v >= 0 && (i === 0 || order[i - 1] < v)), 'merged in box order');

    // Audit fix F4: a source whose list fully duplicates an earlier
    // one reports used = 0 — it contributed nothing after dedupe.
    const dupSrc = await generate({ nodeLinks: node, preferredIps: 'https://a.example.com/l.txt\nhttps://c.example.com/l.txt', sourceLimit: 10 });
    assert.equal(dupSrc.counts.preferredEndpoints, 3);
    assert.equal(dupSrc.dynamic.sources[0].used, 3, 'first source contributed all');
    assert.equal(dupSrc.dynamic.sources[1].used, 0, 'fully-duplicated source contributed none');

    // Per-source test-fetch over the whole box.
    const tp = await worker.fetch(new Request('https://x.pages.dev/api/ip-source-test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok', text: '1.2.3.4\nhttps://a.example.com/l.txt\nhttps://dead.example.com/l.txt' }),
    }), env).then((r) => r.json());
    assert.equal(tp.ok, true);
    assert.equal(tp.literalCount, 1, 'literal lines counted');
    assert.equal(tp.results.length, 2);
    assert.equal(tp.results[0].count, 3, 'live source counted');
    assert.equal(tp.results[1].ok, false, 'dead source reported, not fatal');

    // Record shape: literals + per-source snapshots are stored.
    const rec = JSON.parse(store.get(`sub:${mix.shortId}`).value);
    assert.equal(rec.dynamic.sources.length, 2);
    assert.equal(rec.dynamic.literals.length, 1);
    assert.equal(rec.dynamic.literals[0].server, '104.16.9.1');
    assert.equal(rec.inputs.ipMode, 'mixed');
    assert.equal(rec.inputs.preferredIps, mixedText, 'mixed box stored verbatim');

    // The admin list reports the source count.
    const lr = await (await worker.fetch(adminReq('/api/list'), env)).json();
    const item = lr.items.find((i) => i.id === mix.shortId);
    assert.equal(item.dynamic, true);
    assert.equal(item.sourceCount, 2);
    assert.equal(item.sourceUrl, 'https://a.example.com/l.txt', 'first source kept for older readers');

    // Backfill restores the mixed box exactly.
    const entryResp = await (await worker.fetch(adminReq(`/api/entry?id=${mix.shortId}`), env)).json();
    assert.equal(entryResp.backfill.ipMode, 'mixed');
    assert.equal(entryResp.backfill.preferredIps, mixedText);
    assert.equal(entryResp.backfill.sourceLimit, 2);

    // /sub follows a rotation in ONE source; literals and the other
    // source stay put.
    const sub1 = await getSub(mix.shortId, 'plain');
    assert.equal(sub1.body, mix.plainText, 'sub initially serves the generation merge');
    listA = '104.16.2.9';
    for (const k of [...store.keys()].filter((x) => x.startsWith('ipcache:'))) {
      const c = JSON.parse(store.get(k).value);
      c.fetchedAt = Date.now() - 2 * 3600e3;
      c.lastAttempt = 0;
      store.set(k, { value: JSON.stringify(c) });
    }
    const sub2 = await getSub(mix.shortId, 'plain');
    assert.ok(sub2.body.includes('@104.16.2.9:443'), 'rotated source followed');
    assert.ok(sub2.body.includes('@104.16.9.1:443'), 'literal line stays fixed');
    assert.ok(sub2.body.includes('@104.16.3.3:443'), 'other source unchanged');
    assert.ok(!sub2.body.includes('104.16.2.2'), 'rotated-out endpoint gone');

    // Identity: same box refreshes; source order in the box does not
    // matter; a different limit is a different entry.
    const mixAgain = await generate({ nodeLinks: node, preferredIps: mixedText, sourceLimit: 2 });
    assert.equal(mixAgain.shortId, mix.shortId, 'same mixed content refreshes the same entry');
    const mixSwapped = await generate({ nodeLinks: node, preferredIps: '104.16.9.1#FIXED\nhttps://b.example.com/l.txt\nhttps://a.example.com/l.txt', sourceLimit: 2 });
    assert.equal(mixSwapped.shortId, mix.shortId, 'source order is not part of the identity');
    const mixLimit = await generate({ nodeLinks: node, preferredIps: mixedText, sourceLimit: 3 });
    assert.notEqual(mixLimit.shortId, mix.shortId, 'limit is part of the identity');

    // A dead source next to literals is skipped with a named warning;
    // a dead source alone fails like the old single-source path.
    const tolerated = await generate({ nodeLinks: node, preferredIps: '104.16.9.1\nhttps://dead.example.com/l.txt', sourceLimit: 2 });
    assert.equal(tolerated.counts.preferredEndpoints, 1, 'dead source skipped, literals still generate');
    assert.ok(tolerated.warnings.some((w) => w.includes('dead.example.com') && w.includes('拉取失败')), 'dead source named in warnings');
    const deadOnly = await genRaw({ nodeLinks: node, preferredIps: 'https://dead.example.com/l.txt' });
    assert.equal(deadOnly.status, 400, 'dead source with nothing else fails');
    assert.ok((await deadOnly.json()).error.includes('来源拉取失败'), 'failure names the source fetch');

    // Guards: http lines and too many sources are clear 400s.
    const httpLine = await genRaw({ nodeLinks: node, preferredIps: 'http://a.example.com/l.txt' });
    assert.equal(httpLine.status, 400, 'http source line rejected');
    const six = await genRaw({ nodeLinks: node, preferredIps: [1, 2, 3, 4, 5, 6].map((i) => `https://s${i}.example.com/l.txt`).join('\n') });
    assert.equal(six.status, 400, 'six sources refused');
    assert.ok((await six.json()).error.includes('最多 5 个'), 'cap named in the error');

    // Audit fix F2: a "#备注" typed after a source link is a remark,
    // not part of the URL — both spellings are the same entry.
    const fragA = await generate({ nodeLinks: node, preferredIps: 'https://a.example.com/l.txt#备注A' });
    assert.equal(fragA.dynamic.sourceUrl, 'https://a.example.com/l.txt', 'fragment stripped from the stored source');
    const fragB = await generate({ nodeLinks: node, preferredIps: 'https://a.example.com/l.txt#备注B' });
    assert.equal(fragB.shortId, fragA.shortId, 'different remarks after a source link stay one entry');

    // Audit fix F3: a static paste shaped like a dynamic identity
    // must not merge with the real dynamic entry.
    const crafted = await generate({ nodeLinks: node, preferredIps: 'api:https://a.example.com/l.txt|10' });
    assert.equal(crafted.dynamic, null, 'crafted identity-shaped paste stays static');
    const realDyn = await generate({ nodeLinks: node, preferredIps: 'https://a.example.com/l.txt' });
    assert.notEqual(crafted.shortId, realDyn.shortId, 'crafted paste and lone-source entry are separate');
    assert.ok(JSON.parse(store.get(`sub:${realDyn.shortId}`).value).dynamic, 'the real entry is dynamic');

    // Audit fix F1: refreshing while a source is down (cache evicted)
    // keeps its stored snapshot; /sub still serves it in the outage.
    const keepBox = '104.16.9.1\nhttps://a.example.com/l.txt';
    const keep1 = await generate({ nodeLinks: node, preferredIps: keepBox, sourceLimit: 2 });
    const keptSnap = JSON.parse(store.get(`sub:${keep1.shortId}`).value).dynamic.sources[0].endpoints;
    assert.ok(keptSnap.length > 0, 'snapshot seeded');
    downA = true;
    for (const k of [...store.keys()].filter((x) => x.startsWith('ipcache:'))) store.delete(k);
    const keep2 = await generate({ nodeLinks: node, preferredIps: keepBox, sourceLimit: 2 });
    assert.equal(keep2.shortId, keep1.shortId, 'down-refresh lands on the same entry');
    const keptAfter = JSON.parse(store.get(`sub:${keep2.shortId}`).value).dynamic;
    assert.deepEqual(keptAfter.sources[0].endpoints, keptSnap, 'failed source keeps its previous snapshot');
    assert.ok(keptAfter.endpoints.some((e) => e.server === keptSnap[0].server), 'merged fallback keeps the snapshot too');
    const subKept = await getSub(keep1.shortId, 'plain');
    assert.ok(subKept.body.includes(keptSnap[0].server), 'sub serves the preserved snapshot during the outage');
    assert.ok(subKept.body.includes('104.16.9.1'), 'literal still served');
    downA = false;
    console.log('mixed suite: box parsing, ordered merge, per-source fallback, identity, guards: passed');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- Tags suite: record-carried labels, picker vocabulary, filtering data ---
{
  const recOf = (id) => JSON.parse(store.get(`sub:${id}`).value);
  // Sanitization on generate: trim, whitespace collapse, per-tag cap,
  // case-insensitive dedupe (first spelling wins).
  const t1 = await generate({ nodeLinks: node, preferredIps: '104.16.7.7', tags: [' 香港 ', 'HK', 'hk', '主 力', 'x'.repeat(30)] });
  assert.deepEqual(t1.tags, ['香港', 'HK', '主 力', 'x'.repeat(24)], 'tags sanitized on generate');
  assert.deepEqual(recOf(t1.shortId).tags, t1.tags, 'tags stored on the record');

  // Tags are NOT part of the dedup identity, and an absent field on a
  // refresh leaves the stored tags untouched.
  const t2 = await generate({ nodeLinks: node, preferredIps: '104.16.7.7' });
  assert.equal(t2.shortId, t1.shortId, 'same content, no tags field: same entry');
  assert.deepEqual(recOf(t1.shortId).tags, t1.tags, 'refresh without tags keeps them');
  // A present field replaces wholesale — including an explicit empty set.
  const t3 = await generate({ nodeLinks: node, preferredIps: '104.16.7.7', tags: ['备用'] });
  assert.equal(t3.shortId, t1.shortId, 'same content with tags: still the same entry');
  assert.deepEqual(recOf(t1.shortId).tags, ['备用'], 'present tags replace');
  const t4 = await generate({ nodeLinks: node, preferredIps: '104.16.7.7', tags: [] });
  assert.deepEqual(recOf(t1.shortId).tags, [], 'explicit empty array clears');

  // Per-entry cap.
  const many = await generate({ nodeLinks: node, preferredIps: '104.16.7.8', tags: Array.from({ length: 12 }, (_, i) => `t${i}`) });
  assert.equal(many.tags.length, 10, 'at most 10 tags per entry');

  // The admin list carries tags; untagged entries report [].
  const plain = await generate({ nodeLinks: node, preferredIps: '104.16.7.9' });
  assert.deepEqual(plain.tags, [], 'fresh entry without tags reports []');
  const lr = await (await worker.fetch(adminReq('/api/list'), env)).json();
  assert.deepEqual(lr.items.find((i) => i.id === many.shortId).tags, many.tags, 'list item carries tags');
  assert.deepEqual(lr.items.find((i) => i.id === plain.shortId).tags, [], 'list item defaults to []');

  // Vocabulary endpoint: counts across entries, auth required.
  const vocab = await (await worker.fetch(adminReq('/api/tags'), env)).json();
  assert.equal(vocab.ok, true);
  assert.equal(vocab.tags.find((v) => v.tag === 't0').count, 1, 'vocabulary counts entries per tag');
  assert.ok(!vocab.tags.some((v) => v.tag === '备用'), 'cleared tags leave the vocabulary');
  const noAuth = await worker.fetch(new Request('https://x.pages.dev/api/tags'), env);
  assert.equal(noAuth.status, 403, 'vocabulary requires the admin token');

  // Save endpoint (management editor): sanitizes, persists, 404s and
  // auth behave like the note endpoint.
  const save = await worker.fetch(new Request('https://x.pages.dev/api/tags', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', id: plain.shortId, tags: [' 直播 ', 'HK'] }),
  }), env).then((r) => r.json());
  assert.deepEqual(save.tags, ['直播', 'HK'], 'save returns the sanitized set');
  assert.deepEqual(recOf(plain.shortId).tags, ['直播', 'HK'], 'save persisted on the record');
  const entry = await (await worker.fetch(adminReq(`/api/entry?id=${plain.shortId}`), env)).json();
  assert.deepEqual(entry.tags, ['直播', 'HK'], 'entry read carries tags for verification');
  assert.deepEqual(entry.backfill.tags, ['直播', 'HK'], 'backfill carries tags');
  const missing = await worker.fetch(new Request('https://x.pages.dev/api/tags', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', id: 'NOPE000000', tags: [] }),
  }), env);
  assert.equal(missing.status, 404, 'save on a missing entry 404s');
  const saveNoAuth = await worker.fetch(new Request('https://x.pages.dev/api/tags', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: plain.shortId, tags: [] }),
  }), env);
  assert.equal(saveNoAuth.status, 403, 'save requires the admin token');

  // Tag ORDER endpoints: one shared server-side arrangement (the
  // filter bar's order), replacing the old per-browser localStorage
  // preference that made devices disagree.
  const getOrder = () => worker.fetch(adminReq('/api/tag-order'), env).then((r) => r.json());
  const postOrder = (body) => worker.fetch(new Request('https://x.pages.dev/api/tag-order', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok', ...body }),
  }), env);
  assert.deepEqual((await getOrder()).order, [], 'tag order starts empty');
  assert.equal((await worker.fetch(new Request('https://x.pages.dev/api/tag-order'), env)).status, 403, 'tag order read requires the admin token');
  const savedOrder = await postOrder({ order: ['直播', 'HK', '直播', 7, ''] }).then((r) => r.json());
  assert.deepEqual(savedOrder.order, ['直播', 'HK'], 'tag order save sanitizes and dedupes');
  assert.deepEqual((await getOrder()).order, ['直播', 'HK'], 'tag order round-trips');
  assert.equal((await postOrder({ order: 'HK' })).status, 400, 'non-array order 400s');
  const imp1 = await postOrder({ order: ['甲'], ifEmpty: true }).then((r) => r.json());
  assert.equal(imp1.imported, false, 'ifEmpty import never overwrites an existing order');
  assert.deepEqual(imp1.order, ['直播', 'HK'], 'ifEmpty import returns the existing order');
  await env.SUB_STORE.delete('meta:tag-order');
  const imp2 = await postOrder({ order: ['甲', '乙'], ifEmpty: true }).then((r) => r.json());
  assert.equal(imp2.imported, true, 'ifEmpty import claims an empty server order');
  assert.deepEqual((await getOrder()).order, ['甲', '乙'], 'imported order reads back');
  const listAfter = await (await worker.fetch(adminReq('/api/list'), env)).json();
  assert.ok(!listAfter.items.some((i) => i.id === 'meta:tag-order'), 'the order record never appears as an entry');

  // Read-path sanitization (audit P1): a record hand-edited in KV
  // with junk tag members must not poison list/entry/vocabulary
  // responses — one corrupt record used to take the whole admin
  // list down through the client's sort comparator.
  const victim = await generate({ nodeLinks: node, preferredIps: '104.16.7.77', tags: ['干净'] });
  const vKey = `sub:${victim.shortId}`;
  const vRec = JSON.parse(store.get(vKey).value);
  vRec.tags = [123, null, { x: 1 }, '  带空格  ', '干净', '干净'];
  vRec.note = 123; // E1: a non-string note must read back as '' everywhere
  store.set(vKey, { value: JSON.stringify(vRec) });
  const poisonListRes = await (await worker.fetch(adminReq('/api/list'), env)).json();
  assert.deepEqual(poisonListRes.items.find((i) => i.id === victim.shortId).tags, ['带空格', '干净'], 'list sanitizes stored tags on read');
  assert.equal(poisonListRes.items.find((i) => i.id === victim.shortId).note, '', 'list coerces a non-string note to empty on read');
  const poisonEntryRes = await (await worker.fetch(adminReq(`/api/entry?id=${victim.shortId}`), env)).json();
  assert.deepEqual(poisonEntryRes.tags, ['带空格', '干净'], 'entry sanitizes stored tags on read');
  assert.equal(poisonEntryRes.note, '', 'entry coerces a non-string note to empty on read');
  assert.deepEqual(poisonEntryRes.backfill.tags, ['带空格', '干净'], 'backfill sanitizes stored tags on read');
  const poisonVocabRes = await (await worker.fetch(adminReq('/api/tags'), env)).json();
  assert.ok(poisonVocabRes.tags.every((v) => typeof v.tag === 'string'), 'vocabulary never carries non-string tags');
  assert.ok(!poisonVocabRes.tags.some((v) => v.tag === 'null' || v.tag === '123'), 'vocabulary drops junk members instead of coercing them');

  // Audit fixes (2026-10-31): F1 a missing/non-array tags field must be
  // a 400, never a silent wipe; F3 non-string members are dropped, not
  // String()-coerced into junk tags; F7 the per-tag length cap never
  // splits a surrogate pair; F5+F6 the vocabulary merges case variants
  // and counts entries, not occurrences.
  const postTagsRaw = (body) => worker.fetch(new Request('https://x.pages.dev/api/tags', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok', ...body }),
  }), env);
  assert.equal((await postTagsRaw({ id: plain.shortId })).status, 400, 'F1: missing tags field 400s');
  assert.equal((await postTagsRaw({ id: plain.shortId, tags: 'HK' })).status, 400, 'F1: string tags 400s');
  assert.deepEqual(recOf(plain.shortId).tags, ['直播', 'HK'], 'F1: rejected saves leave tags untouched');
  const f3 = await generate({ nodeLinks: node, preferredIps: '104.16.7.10', tags: [{}, [], 7, '正'] });
  assert.deepEqual(f3.tags, ['正'], 'F3: non-string members dropped');
  const f7 = await generate({ nodeLinks: node, preferredIps: '104.16.7.11', tags: ['a' + '🔥'.repeat(12)] });
  assert.equal(f7.tags[0].length, 23, 'F7: cap drops the dangling surrogate half');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(f7.tags[0]), 'F7: no lone surrogate stored');
  store.set('sub:CASEAAA', { value: JSON.stringify({ version: 2, tags: ['HK', 'hk', 'HK'] }), metadata: undefined, expirationTtl: undefined });
  store.set('sub:CASEBBB', { value: JSON.stringify({ version: 2, tags: ['hk'] }), metadata: undefined, expirationTtl: undefined });
  const vocab2 = await (await worker.fetch(adminReq('/api/tags'), env)).json();
  const hkEntry = vocab2.tags.filter((v) => v.tag.toLowerCase() === 'hk');
  assert.equal(hkEntry.length, 1, 'F5: case variants merge into one vocabulary entry');
  assert.equal(hkEntry[0].count, 3, 'F5+F6: count is entries (plain + CASEAAA + CASEBBB), duplicates inside one record ignored');
  store.delete('sub:CASEAAA');
  store.delete('sub:CASEBBB');
  console.log('tags suite: sanitize, refresh semantics, vocabulary, save endpoint, backfill: passed');
}

// --- Audit round 3 suite: hostile node links vs output formats, output cap ---
{
  // Node links are semi-untrusted input (they get copied from public
  // sources): fields carrying newlines/commas must not be able to forge
  // Clash YAML keys or whole Surge config lines.
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const evilVmess = 'vmess://' + b64(JSON.stringify({
    v: '2', ps: 'evilvmess', add: 'a.example.com', port: '443',
    id: 'f541611e-0aeb-4900-aa47-6e95d4916a49\n    tls: false\n    injected: yes',
    aid: '0', scy: 'auto\n    udp: false', net: 'ws', host: 'h.example.com', path: '/ws', tls: 'tls',
  }));
  const evilTrojan = 'trojan://pw%0A%5BProxy%5D%0AFake%20%3D%20trojan%2C%206.6.6.6%2C%20443%2C%20password%3Dx@t.example.com:443?security=tls&type=ws&path=%2Fws&host=h.example.com#eviltrojan';
  const evil = await generate({ nodeLinks: evilVmess + '\n' + evilTrojan, preferredIps: '104.16.1.2' });
  assert.equal(evil.counts.outputNodes, 2);

  const clash = await getSub(evil.shortId, 'clash');
  assert.ok(!clash.body.includes('\n    injected'), 'no forged YAML key from uuid');
  assert.ok(!clash.body.includes('\npassword:'), 'no unindented password line from trojan password');
  assert.ok(clash.body.includes('cipher: "auto'), 'cipher is a quoted scalar');
  assert.ok(clash.body.includes('uuid: "f541611e'), 'uuid is a quoted scalar');
  assert.ok(clash.body.includes('server: "104.16.1.2"'), 'server is a quoted scalar');

  const surge = await getSub(evil.shortId, 'surge');
  const surgeLines = surge.body.split('\n');
  assert.equal(surgeLines.filter((l) => l === '[Proxy]').length, 1, 'exactly one [Proxy] section');
  assert.ok(!surgeLines.some((l) => l.startsWith('Fake')), 'no forged Surge proxy line');
  assert.equal(surgeLines.filter((l) => l.includes(' = vmess, ') || l.includes(' = trojan, ')).length, 2, 'both proxies stay on single lines');

  // Output ceiling: nodes x endpoints is refused past 10000 with the
  // real numbers, and exactly 10000 still succeeds.
  const manyIps = (n) => Array.from({ length: n }, (_, i) => `104.16.${(i >> 8) & 255}.${i & 255}`).join('\n');
  const tooMany = await worker.fetch(new Request('https://x.pages.dev/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', nodeLinks: node + '\n' + node.replace('#US-Node-1', '#US-Node-2'), preferredIps: manyIps(6000) }),
  }), env);
  assert.equal(tooMany.status, 400, 'cartesian explosion refused');
  const tooManyJson = await tooMany.json();
  assert.ok(tooManyJson.error.includes('12000') && tooManyJson.error.includes('组合过多'), 'error names the real count');
  const atCap = await generate({ nodeLinks: node, preferredIps: manyIps(10000) });
  assert.equal(atCap.counts.outputNodes, 10000, 'exactly at the cap succeeds');
  console.log('audit round 3 suite: output-format injection sealed, output cap enforced: passed');
}

// --- Version suite: /api/version reporting + update check caching ---
{
  const realFetch = globalThis.fetch;
  let ghCalls = 0;
  let ghTag = null;
  let ghDown = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.github.com/')) {
      ghCalls++;
      if (ghDown) throw new Error('github down');
      return new Response(JSON.stringify({ tag_name: ghTag, html_url: 'https://example.com/rel' }), { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
  };
  const getVersion = () => worker.fetch(new Request('https://x.pages.dev/api/version'), env).then((r) => r.json());
  const getVersionRetry = () => worker.fetch(new Request('https://x.pages.dev/api/version?retry=1'), env).then((r) => r.json());
  try {
    const v0 = await getVersion();
    assert.match(v0.version, /^\d+\.\d+\.\d+$/, 'endpoint reports the running version');
    store.delete('sys:latest-release'); // v0 ran with no tag set: drop its negative cache entry
    const newer = 'v' + (parseInt(v0.version, 10) + 1) + '.0.0';
    ghTag = newer;
    const v1 = await getVersion();
    assert.equal(v1.latest, newer.slice(1), 'latest comes from GitHub');
    assert.equal(v1.updateAvailable, true, 'newer release detected');
    assert.equal(v1.releaseUrl, 'https://example.com/rel');
    assert.equal(v1.checkStatus, 'ok', 'successful check is reported explicitly');
    const callsAfterFirst = ghCalls;
    const v2 = await getVersion();
    assert.equal(v2.latest, v1.latest, 'second read served from KV cache');
    assert.equal(ghCalls, callsAfterFirst, 'GitHub not re-queried inside the cache window');

    store.delete('sys:latest-release');
    ghTag = 'v' + v0.version;
    assert.equal((await getVersion()).updateAvailable, false, 'same version is not an update');
    store.delete('sys:latest-release');
    ghTag = 'v0.0.1';
    assert.equal((await getVersion()).updateAvailable, false, 'older release is not an update');

    // GitHub down + stale positive cache: last known answer still served,
    // and the retry is throttled instead of fetching per page view.
    store.delete('sys:latest-release');
    ghTag = newer;
    await getVersion();
    const staleEntry = JSON.parse(store.get('sys:latest-release').value);
    staleEntry.checkedAt = Date.now() - 7 * 3600e3;
    store.set('sys:latest-release', { value: JSON.stringify(staleEntry) });
    ghDown = true;
    const vDown = await getVersion();
    assert.equal(vDown.latest, newer.slice(1), 'stale cache beats a GitHub outage');
    assert.equal(vDown.checkStatus, 'stale', 'outage with a cached answer is reported as stale');
    const callsDuringOutage = ghCalls;
    await getVersion();
    assert.equal(ghCalls, callsDuringOutage, 'stale-serving throttles outage retries');

    // GitHub down + no cache at all: current version only, negatively cached.
    store.delete('sys:latest-release');
    const vNone = await getVersion();
    assert.equal(vNone.latest, null);
    assert.equal(vNone.updateAvailable, false);
    assert.equal(vNone.version, v0.version);
    assert.equal(vNone.checkStatus, 'failed', 'outage with no cached answer is reported as failed');
    const callsAfterOutage = ghCalls;
    await getVersion();
    assert.equal(ghCalls, callsAfterOutage, 'outage is negatively cached');

    // Manual retry cannot hammer GitHub: inside five minutes it is
    // refused, after that floor it performs a real re-check.
    ghDown = false;
    ghTag = newer;
    const callsBeforeRetry = ghCalls;
    const vRetryEarly = await getVersionRetry();
    assert.equal(vRetryEarly.checkStatus, 'failed', 'early manual retry stays failed');
    assert.equal(ghCalls, callsBeforeRetry, 'early manual retry does not reach GitHub');
    const negativeEntry = JSON.parse(store.get('sys:latest-release').value);
    negativeEntry.lastAttempt = Date.now() - 6 * 60e3;
    store.set('sys:latest-release', { value: JSON.stringify(negativeEntry) });
    const vRetry = await getVersionRetry();
    assert.equal(vRetry.checkStatus, 'ok', 'manual retry re-checks after the five-minute floor');
    assert.equal(vRetry.latest, newer.slice(1));
    assert.ok(ghCalls > callsBeforeRetry, 'allowed manual retry reaches GitHub');
    console.log('version suite: report, compare, KV cache, explicit stale/failed status, rate-limited retry: passed');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- Audit round 4 suite: API namespace contract ---
{
  const wrongMethod = await worker.fetch(new Request('https://x.pages.dev/api/generate'), env);
  assert.equal(wrongMethod.status, 404, 'GET on a POST-only API path is a JSON 404, not the homepage');
  assert.equal((await wrongMethod.json()).ok, false);
  const unknown = await worker.fetch(new Request('https://x.pages.dev/api/nonexistent', { method: 'POST' }), env);
  assert.equal(unknown.status, 404, 'unknown API path is a JSON 404');
  const home = await worker.fetch(new Request('https://x.pages.dev/'), env);
  assert.equal(home.status, 200, 'non-API paths still reach the static site');
  console.log('audit round 4 suite: unknown/wrong-method API paths return JSON 404: passed');
}

// --- Diagnostics suite: /api/diag shape, redaction, event ring ---
{
  const diagPost = (body = { token: 'tok' }) => worker.fetch(new Request('https://x.pages.dev/api/diag', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env);
  const noTok = await diagPost({});
  assert.equal(noTok.status, 403, 'diag without token is 403');
  const wrongTok = await diagPost({ token: 'nope' });
  assert.equal(wrongTok.status, 403, 'diag with wrong token is 403');
  const queryTok = await worker.fetch(new Request('https://x.pages.dev/api/diag?token=tok', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }), env);
  assert.equal(queryTok.status, 403, 'diag never accepts a query token');

  // Seed an entry carrying secrets in every user-controlled field.
  const seeded = await generate({ nodeLinks: node, preferredIps: '203.0.113.7', namePrefix: 'diagseed' });
  await worker.fetch(new Request('https://x.pages.dev/api/note', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', id: seeded.shortId, note: '秘密备注XYZ' }),
  }), env);
  await worker.fetch(new Request('https://x.pages.dev/api/tags', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', id: seeded.shortId, tags: ['秘密标签'] }),
  }), env);

  const okResp = await diagPost();
  assert.equal(okResp.status, 200);
  const okJson = await okResp.json();
  assert.equal(okJson.ok, true);
  const diagText = JSON.stringify(okJson);
  for (const secret of ['秘密备注XYZ', '秘密标签', '203.0.113.7', seeded.shortId, 'f541611e-0aeb-4900-aa47', 'walh6h3rdnazjx']) {
    assert.ok(!diagText.includes(secret), `diag output must not contain: ${secret}`);
  }
  assert.ok(!diagText.includes('vmess://') && !diagText.includes('vless://'), 'diag output carries no node links');
  assert.equal(okJson.diag.kvProbe.match, true, 'KV probe round-trips');
  assert.equal(store.get('sys:diag-probe'), undefined, 'KV probe key is cleaned up');
  assert.ok(okJson.diag.census.entries >= 1, 'census counts entries');
  assert.ok(okJson.diag.census.withNote >= 1 && okJson.diag.census.withTags >= 1, 'census counts note/tag presence without contents');
  assert.ok(Array.isArray(okJson.diag.events), 'diag returns the event ring');
  assert.ok(
    okJson.diag.events.some((e) => e.kind === 'api' && String(e.route).includes('/api/tags')),
    'ring recorded the tags save',
  );
  assert.ok(!okJson.diag.events.some((e) => e.status === 403), 'auth failures are never recorded');

  // A dead dynamic source leaves a hashed-host ring event, never the URL.
  await generate({ nodeLinks: node, preferredIps: '203.0.113.8\nhttps://dead-source.invalid/x', namePrefix: 'diagsrc' });
  const afterSrc = await (await diagPost()).json();
  const srcEvt = afterSrc.diag.events.find((e) => e.kind === 'ip-source');
  assert.ok(srcEvt, 'failed source fetch left a ring event');
  assert.ok(String(srcEvt.host).startsWith('h:'), 'source host is a keyed hash, not the hostname');
  assert.ok(!JSON.stringify(afterSrc).includes('dead-source.invalid'), 'source hostname never appears in diag output');

  // The ring is capped.
  for (let i = 0; i < 65; i++) {
    await worker.fetch(new Request('https://x.pages.dev/api/tag-order', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok', order: ['甲'] }),
    }), env);
  }
  const capped = await (await diagPost()).json();
  assert.ok(capped.diag.events.length <= 60, 'event ring is capped at 60');

  // D1/D2: unknown paths are recorded only as a template (never
  // verbatim — the path is caller-controlled text), a junk flood
  // collapses into a single counted entry, and real history survives.
  await worker.fetch(new Request('https://x.pages.dev/api/deadbeefdeadbeefdeadbeefdeadbeef/xyz'), env);
  const templated = await (await diagPost()).json();
  assert.ok(!JSON.stringify(templated).includes('deadbeef'), 'crafted path segments never enter the ring');
  assert.ok(templated.diag.events.some((e) => e.route === 'GET /api/*'), 'unknown paths recorded under one template');
  for (let i = 0; i < 65; i++) {
    await worker.fetch(new Request(`https://x.pages.dev/api/junk${i}`), env);
  }
  const flooded = await (await diagPost()).json();
  const stars = flooded.diag.events.filter((e) => e.route === 'GET /api/*');
  const starTotal = stars.reduce((a, e) => a + (e.n || 1), 0);
  // H1 supersedes the D2-era expectation here: failure events are
  // throttled per signature at the door, so a junk flood now costs a
  // single KV write per window instead of being fully counted.
  assert.ok(starTotal <= 2, 'junk flood is throttled to a single counted event per window');
  assert.ok(stars.length <= 8, 'flood occupies at most one collapsed entry per shard');
  assert.ok(flooded.diag.events.some((e) => e.route === 'POST /api/tag-order'), 'legit history survives the flood');
  assert.ok(flooded.diag.events.length <= 60, 'ring still capped after the flood');

  // F1: junk members inside a shard (null, primitives, a string
  // timestamp) must not zero the merged view or block new events.
  store.set('sys:diag-events:3', {
    value: JSON.stringify([null, 1, 'x', { t: 'bad' }, { t: Date.now(), kind: 'api', route: 'POST /api/note', status: 200, ms: 1 }]),
  });
  const withJunk = await (await diagPost()).json();
  assert.ok(withJunk.diag.events.some((e) => e.route === 'POST /api/note'), 'valid events survive junk shard members');
  assert.ok(
    withJunk.diag.events.every((e) => e && typeof e === 'object' && typeof e.t === 'number'),
    'merged events are all well-formed',
  );

  // H1: failure events are throttled per signature. A burst of junk
  // 404s (no token needed) and a dead-link /sub retry loop may each
  // add at most ONE ring entry per window — otherwise a few hundred
  // requests could burn the free tier's daily KV write quota.
  const countSig = (j, route, status) => j.diag.events.filter((e) => e.route === route && e.status === status).length;
  const junkBefore = countSig(await (await diagPost()).json(), 'GET /api/*', 404);
  for (let i = 0; i < 20; i++) {
    await worker.fetch(new Request(`https://sub.test/api/nope-${i}`), env);
  }
  const junkAfter = await (await diagPost()).json();
  assert.ok(countSig(junkAfter, 'GET /api/*', 404) - junkBefore <= 1, 'junk 404 burst throttled to one event');
  const deadGen = await generate({ nodeLinks: node, preferredIps: '203.0.113.7' });
  await worker.fetch(new Request('https://x.pages.dev/api/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', id: deadGen.shortId }),
  }), env);
  const subBefore = countSig(await (await diagPost()).json(), 'GET /sub/:id', 404);
  for (let i = 0; i < 20; i++) {
    await worker.fetch(new Request(`https://x.pages.dev/sub/${deadGen.shortId}?token=${linkTokens.get(deadGen.shortId)}`), env);
  }
  const subAfter = await (await diagPost()).json();
  assert.ok(countSig(subAfter, 'GET /sub/:id', 404) - subBefore <= 1, 'dead-link retry loop throttled to one event');

  // H2: API JSON is no-store and carries no wildcard CORS grant.
  const versionResp = await worker.fetch(new Request('https://sub.test/api/version'), env);
  assert.equal(versionResp.headers.get('cache-control'), 'no-store', 'API JSON is no-store');
  assert.equal(versionResp.headers.get('access-control-allow-origin'), null, 'no wildcard CORS on API JSON');
  console.log('diagnostics suite: auth, redaction, census, KV probe, event ring: passed');
}

// Audit round 9: duplicate node names are disambiguated end-to-end,
// and a vless-only entry's Surge target answers a clear error instead
// of an empty 200 profile.
{
  const gen9 = async (body) => {
    const r = await worker.fetch(new Request('http://x/api/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok', ...body }),
    }), env);
    return r.json();
  };
  const listTok9 = async (id) => {
    const l = await (await worker.fetch(new Request('http://x/api/list', { headers: { 'x-admin-token': 'tok' } }), env)).json();
    return l.items.find((i) => i.id === id).linkToken;
  };
  // The endpoint carries a remark, so buildNodes composes the SAME
  // name for both source nodes (without a remark the build counter
  // already disambiguates) — dedupe must suffix the second one.
  const dup = await gen9({ nodeLinks: 'vless://f541611e-0aeb-4900-aa47-6e95d4916a49@a.example.com:443?security=tls#同名\nvless://f541611e-0aeb-4900-aa47-6e95d4916a49@b.example.com:443?security=tls#同名', preferredIps: '203.0.113.7#备注' });
  const tok9 = await listTok9(dup.shortId);
  const clash9 = await (await worker.fetch(new Request(`http://x/sub/${dup.shortId}?token=${tok9}&target=clash`), env)).text();
  const names9 = [...clash9.split('proxy-groups:')[0].matchAll(/- name: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(names9).size, names9.length, 'clash proxy names are unique end-to-end');
  assert.ok(names9.some((n) => n.endsWith('(2)')), 'the duplicate got a (2) suffix');
  const surge9 = await worker.fetch(new Request(`http://x/sub/${dup.shortId}?token=${tok9}&target=surge`), env);
  assert.equal(surge9.status, 400, 'vless-only surge target is a clear error, not an empty 200');
  assert.ok((await surge9.text()).includes('Surge 仅支持 VMess / Trojan'), 'surge error explains the supported types');
  console.log('audit round 9 suite: duplicate names + surge empty-profile error: passed');
}
