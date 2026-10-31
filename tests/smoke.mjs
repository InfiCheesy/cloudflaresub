import assert from 'node:assert/strict';
import {
  decryptPayload,
  encryptPayload,
  expandNodes,
  parseNodeLinks,
  parsePreferredEndpoints,
  renderClashSubscription,
  renderRawSubscription,
  renderSurgeSubscription,
} from '../src/core.js';

const vmess = 'vmess://ewogICJ2IjogIjIiLAogICJwcyI6ICJkZW1vLXdzLXRscyIsCiAgImFkZCI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAicG9ydCI6ICI0NDMiLAogICJpZCI6ICIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLAogICJzY3kiOiAiYXV0byIsCiAgIm5ldCI6ICJ3cyIsCiAgInRscyI6ICJ0bHMiLAogICJwYXRoIjogIi93cyIsCiAgImhvc3QiOiAiZWRnZS5leGFtcGxlLmNvbSIsCiAgInNuaSI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAiZnAiOiAiY2hyb21lIiwKICAiYWxwbiI6ICJoMixodHRwLzEuMSIKfQ==';

const { nodes } = parseNodeLinks(vmess);
assert.equal(nodes.length, 1);
assert.equal(nodes[0].type, 'vmess');
assert.equal(nodes[0].server, 'edge.example.com');

const { endpoints } = parsePreferredEndpoints('104.16.1.2#HK\n104.17.2.3:2053#US');
assert.equal(endpoints.length, 2);

const expanded = expandNodes(nodes, endpoints, { keepOriginalHost: true, namePrefix: 'CF' });
assert.equal(expanded.nodes.length, 2);
assert.equal(expanded.nodes[0].server, '104.16.1.2');
assert.equal(expanded.nodes[0].hostHeader, 'edge.example.com');
assert.equal(expanded.nodes[1].port, 2053);

const raw = renderRawSubscription(expanded.nodes);
assert.ok(raw.length > 10);

// Audit-8/9: name escaping in Clash output — line breaks flatten to a
// space (the worker's escapeYaml semantics; the two implementations
// are kept in lockstep), tabs are spelled out, other C0 controls go.
const clashCtrl = renderClashSubscription([{ ...nodes[0], name: 'a\nb\rc\td\x07e' }]);
assert.ok(clashCtrl.includes('a b c\\tde'), 'clash flattens name line breaks and spells out tabs');
assert.ok(!clashCtrl.includes('\x07'), 'clash output carries no raw control characters');

// Audit-9: duplicate node names are disambiguated with " (n)"
// suffixes so Clash/Surge (which key proxies by name) accept the
// file; a name already ending that way is bumped past.
const dupClash = renderClashSubscription([
  { ...nodes[0], name: '同名' },
  { ...nodes[0], name: '同名' },
  { ...nodes[0], name: '同名 (2)' },
  { ...nodes[0], name: '同名' },
]);
const dupNames = [...dupClash.matchAll(/- name: "([^"]+)"/g)].map((m) => m[1]).filter((n) => n.startsWith('同名'));
assert.deepEqual(dupNames, ['同名', '同名 (2)', '同名 (2) (2)', '同名 (3)'], 'clash duplicate names get unique suffixes');

const clash = renderClashSubscription(expanded.nodes);
assert.match(clash, /proxies:/);
assert.match(clash, /edge\.example\.com/);

const surge = renderSurgeSubscription(expanded.nodes, 'https://sub.example.com/sub/demo?target=surge');
assert.match(surge, /\[Proxy]/);
assert.match(surge, /vmess/);

const secret = 'this-is-a-very-secret-key';
const token = await encryptPayload({ nodes: expanded.nodes }, secret);
const payload = await decryptPayload(token, secret);
assert.equal(payload.nodes.length, 2);

// Audit-9 equivalence battery: src/worker.js (the live path) and
// src/core.js carry parallel parse/render implementations that have
// drifted before (YAML escaping, Surge name sanitizing). Feed ONE
// battery of hostile names through both and require the rendered
// proxy NAME lists to agree exactly, in Clash and in Surge.
{
  const { default: worker } = await import('../src/worker.js');
  const eqStore = new Map();
  const eqEnv = {
    SUB_STORE: {
      async get(k) { return eqStore.get(k)?.value ?? null; },
      async put(k, v, opts = {}) { eqStore.set(k, { value: v, metadata: opts.metadata }); },
      async delete(k) { eqStore.delete(k); },
      async list({ prefix = '', cursor, limit = 1000 } = {}) {
        const all = [...eqStore.entries()].filter(([n]) => n.startsWith(prefix));
        const start = cursor ? Number(cursor) : 0;
        const slice = all.slice(start, start + limit);
        return { keys: slice.map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: start + limit >= all.length, cursor: String(start + limit) };
      },
    },
    ASSETS: { async fetch() { return new Response('HOME'); } },
    SUB_ACCESS_TOKEN: 'tok',
  };
  const U = 'f541611e-0aeb-4900-aa47-6e95d4916a49';
  const battery = [
    { type: 'vmess', name: '同名', server: 'a.example.com', port: 443, uuid: U, cipher: 'auto', network: 'ws', tls: true, sni: '', host: '', path: '/' },
    { type: 'trojan', name: '同名', server: 'b.example.com', port: 443, password: 'pw', tls: true, sni: '', host: '', path: '/' },
    { type: 'vmess', name: 'a\nb', server: 'c.example.com', port: 443, uuid: U, cipher: 'auto', network: 'tcp', tls: false, sni: '', host: '', path: '/' },
    { type: 'trojan', name: 'x,y', server: 'd.example.com', port: 443, password: 'pw', tls: true, sni: '', host: '', path: '/' },
    { type: 'vmess', name: 'x y', server: 'e.example.com', port: 443, uuid: U, cipher: 'auto', network: 'tcp', tls: false, sni: '', host: '', path: '/' },
    { type: 'vless', name: 'vless名', server: 'f.example.com', port: 443, uuid: U, network: 'tcp', tls: false, sni: '', host: '', path: '/' },
  ];
  eqStore.set('sub:EqTest01', { value: JSON.stringify({ id: 'EqTest01', nodes: battery, storage: { mode: 'permanent' }, createdAt: '2026-01-01T00:00:00.000Z' }) });
  const eqList = await (await worker.fetch(new Request('https://x.pages.dev/api/list', { headers: { 'x-admin-token': 'tok' } }), eqEnv)).json();
  const eqTok = eqList.items.find((i) => i.id === 'EqTest01').linkToken;
  const wClash = await (await worker.fetch(new Request(`https://x.pages.dev/sub/EqTest01?token=${eqTok}&target=clash`), eqEnv)).text();
  const wSurge = await (await worker.fetch(new Request(`https://x.pages.dev/sub/EqTest01?token=${eqTok}&target=surge`), eqEnv)).text();
  const clashNames = (doc) => [...doc.split('proxy-groups:')[0].matchAll(/- name: "([^"]+)"/g)].map((m) => m[1]);
  const surgeNames = (doc) => doc.split('\n').map((l) => /^(.+?) = (?:vmess|trojan),/.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.deepEqual(clashNames(wClash), ['同名', '同名 (2)', 'a b', 'x,y', 'x y', 'vless名'], 'worker clash battery names');
  assert.deepEqual(surgeNames(wSurge), ['同名', '同名 (2)', 'a b', 'x y', 'x y (2)'], 'worker surge battery names');
  assert.deepEqual(clashNames(renderClashSubscription(battery)), clashNames(wClash), 'core/worker clash names agree');
  assert.deepEqual(surgeNames(renderSurgeSubscription(battery, 'https://x.pages.dev/sub/EqTest01')), surgeNames(wSurge), 'core/worker surge names agree');
  console.log('equivalence battery: worker/core rendered names agree');
}

console.log('smoke test passed');
