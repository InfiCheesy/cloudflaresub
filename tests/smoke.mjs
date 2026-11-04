import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// Smoke checks against the ONE implementation: src/worker.js (the
// deployed Pages _worker.js source). This file used to also exercise
// a parallel src/core.js copy of the parse/render logic; the two
// drifted repeatedly (fields present in one, missing in the other),
// so core.js was removed in favour of the single worker
// implementation — what is tested here is exactly what ships.

const store = new Map();
const env = {
  SUB_STORE: {
    async get(k) { return store.get(k)?.value ?? null; },
    async put(k, v, opts = {}) { store.set(k, { value: v, metadata: opts.metadata }); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = [...store.entries()].filter(([n]) => n.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + limit);
      return { keys: slice.map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: start + limit >= all.length, cursor: String(start + limit) };
    },
  },
  ASSETS: { async fetch() { return new Response('HOME'); } },
  SUB_ACCESS_TOKEN: 'tok-0123456789abcdef',
};
const ADMIN = env.SUB_ACCESS_TOKEN;

function seedEntry(id, nodes) {
  store.set(`sub:${id}`, { value: JSON.stringify({ id, nodes, storage: { mode: 'permanent' }, createdAt: '2026-01-01T00:00:00.000Z' }) });
}
async function linkTokenOf(id) {
  const list = await (await worker.fetch(new Request('https://x.pages.dev/api/list', { headers: { 'x-admin-token': ADMIN } }), env)).json();
  return list.items.find((i) => i.id === id).linkToken;
}
async function pullSub(id, target) {
  const tok = await linkTokenOf(id);
  const r = await worker.fetch(new Request(`https://x.pages.dev/sub/${id}?token=${tok}&target=${target}`), env);
  assert.equal(r.status, 200, `sub ${id} ${target} pulls`);
  return r.text();
}
const clashNames = (doc) => [...doc.split('proxy-groups:')[0].matchAll(/- name: "([^"]+)"/g)].map((m) => m[1]);
const surgeNames = (doc) => doc.split('\n').map((l) => /^(.+?) = (?:vmess|trojan),/.exec(l)).filter(Boolean).map((m) => m[1]);

// Hostile-name battery through the live path: duplicate names,
// embedded line breaks, commas, an emoji name, and a rich vmess
// node (string alpn) in the worker's stored shape. The rendered
// proxy NAME lists are asserted exactly, in Clash and in Surge.
{
  const U = 'f541611e-0aeb-4900-aa47-6e95d4916a49';
  const battery = [
    { type: 'vmess', name: '同名', server: 'a.example.com', port: 443, uuid: U, cipher: 'auto', network: 'ws', tls: true, sni: '', host: '', path: '/' },
    { type: 'trojan', name: '同名', server: 'b.example.com', port: 443, password: 'pw', tls: true, sni: '', host: '', path: '/' },
    { type: 'vmess', name: 'a\nb', server: 'c.example.com', port: 443, uuid: U, cipher: 'auto', network: 'tcp', tls: false, sni: '', host: '', path: '/' },
    { type: 'trojan', name: 'x,y', server: 'd.example.com', port: 443, password: 'pw', tls: true, sni: '', host: '', path: '/' },
    { type: 'vmess', name: 'x y', server: 'e.example.com', port: 443, uuid: U, cipher: 'auto', network: 'tcp', tls: false, sni: '', host: '', path: '/' },
    { type: 'vless', name: 'vless名', server: 'f.example.com', port: 443, uuid: U, network: 'tcp', tls: false, sni: '', host: '', path: '/' },
    { type: 'vmess', name: 'alpn节点', server: 'g.example.com', port: 443, uuid: U, cipher: 'auto', network: 'ws', tls: true, sni: 's.example.com', host: 'h.example.com', path: '/ws', alpn: 'h2', fp: 'chrome' },
  ];
  seedEntry('EqTest01', battery);
  const wClash = await pullSub('EqTest01', 'clash');
  const wSurge = await pullSub('EqTest01', 'surge');
  assert.deepEqual(clashNames(wClash), ['同名', '同名 (2)', 'a b', 'x,y', 'x y', 'vless名', 'alpn节点'], 'worker clash battery names');
  assert.deepEqual(surgeNames(wSurge), ['同名', '同名 (2)', 'a b', 'x y', 'x y (2)', 'alpn节点'], 'worker surge battery names');
  console.log('hostile-name battery: worker rendered names exact in clash + surge');
}

// Name escaping in Clash output: line breaks flatten to a space,
// tabs are spelled out, other C0 controls go. (Migrated from the
// removed core copy; the semantics are the worker's own.)
{
  const U = 'f541611e-0aeb-4900-aa47-6e95d4916a49';
  seedEntry('EscTest01', [
    { type: 'vmess', name: 'a\nb\rc\td\x07e', server: 'a.example.com', port: 443, uuid: U, cipher: 'auto', network: 'tcp', tls: false, sni: '', host: '', path: '/' },
  ]);
  const clash = await pullSub('EscTest01', 'clash');
  assert.ok(clash.includes('a b c\\tde'), 'clash flattens name line breaks and spells out tabs');
  assert.ok(!clash.includes('\x07'), 'clash output carries no raw control characters');
  console.log('name escaping: line breaks flattened, tabs spelled, controls stripped');
}

// Duplicate names get " (n)" suffixes so Clash/Surge (which key
// proxies by name) accept the file; a name already ending that way
// is bumped past. (Migrated from the removed core copy.)
{
  const U = 'f541611e-0aeb-4900-aa47-6e95d4916a49';
  const mk = (name) => ({ type: 'vmess', name, server: 'a.example.com', port: 443, uuid: U, cipher: 'auto', network: 'tcp', tls: false, sni: '', host: '', path: '/' });
  seedEntry('DupTest01', [mk('同名'), mk('同名'), mk('同名 (2)'), mk('同名')]);
  const clash = await pullSub('DupTest01', 'clash');
  const dupNames = clashNames(clash).filter((n) => n.startsWith('同名'));
  assert.deepEqual(dupNames, ['同名', '同名 (2)', '同名 (2) (2)', '同名 (3)'], 'clash duplicate names get unique suffixes');
  console.log('duplicate names: unique (n) suffixes assigned');
}

console.log('smoke test passed');
