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
// SCOPE, stated plainly (audit round 10): this battery guards NAMES
// only. The two renderers are different generations and differ in
// emitted fields (ipv6, ws-opts, fingerprint, test URLs, group
// titles) by history — field-level equality is deliberately NOT
// asserted. What it additionally guarantees: core's renderers accept
// the worker's stored node shape (e.g. a string `alpn`) without
// throwing — see the rich vmess node in the battery below, which
// core's clash renderer used to crash on.
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
    // Rich worker-shaped node: string alpn. Core's own parser makes
    // an array, and its clash renderer used to throw on the string.
    { type: 'vmess', name: 'alpn节点', server: 'g.example.com', port: 443, uuid: U, cipher: 'auto', network: 'ws', tls: true, sni: 's.example.com', hostHeader: 'h.example.com', path: '/ws', alpn: 'h2', fp: 'chrome' },
  ];
  eqStore.set('sub:EqTest01', { value: JSON.stringify({ id: 'EqTest01', nodes: battery, storage: { mode: 'permanent' }, createdAt: '2026-01-01T00:00:00.000Z' }) });
  const eqList = await (await worker.fetch(new Request('https://x.pages.dev/api/list', { headers: { 'x-admin-token': 'tok' } }), eqEnv)).json();
  const eqTok = eqList.items.find((i) => i.id === 'EqTest01').linkToken;
  const wClash = await (await worker.fetch(new Request(`https://x.pages.dev/sub/EqTest01?token=${eqTok}&target=clash`), eqEnv)).text();
  const wSurge = await (await worker.fetch(new Request(`https://x.pages.dev/sub/EqTest01?token=${eqTok}&target=surge`), eqEnv)).text();
  const clashNames = (doc) => [...doc.split('proxy-groups:')[0].matchAll(/- name: "([^"]+)"/g)].map((m) => m[1]);
  const surgeNames = (doc) => doc.split('\n').map((l) => /^(.+?) = (?:vmess|trojan),/.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.deepEqual(clashNames(wClash), ['同名', '同名 (2)', 'a b', 'x,y', 'x y', 'vless名', 'alpn节点'], 'worker clash battery names');
  assert.deepEqual(surgeNames(wSurge), ['同名', '同名 (2)', 'a b', 'x y', 'x y (2)', 'alpn节点'], 'worker surge battery names');
  assert.deepEqual(clashNames(renderClashSubscription(battery)), clashNames(wClash), 'core/worker clash names agree');
  assert.deepEqual(surgeNames(renderSurgeSubscription(battery, 'https://x.pages.dev/sub/EqTest01')), surgeNames(wSurge), 'core/worker surge names agree');
  // Core-only: its own group titles are reserved names there (the
  // worker's groups have different titles, so this stays core-local).
  const coreReserved = renderClashSubscription([
    { type: 'vmess', name: '🚀 节点选择', server: 'h.example.com', port: 443, uuid: U, cipher: 'auto', network: 'tcp', tls: false, sni: '', hostHeader: '', path: '/' },
  ]);
  assert.ok(coreReserved.includes('- name: "🚀 节点选择 (2)"'), 'core clash renames a node named like its select group');
  // Audit-11: core renders REALITY vless with reality-opts.
  const rlParsed = parseNodeLinks('vless://f541611e-0aeb-4900-aa47-6e95d4916a49@rl.example.com:443?security=reality&pbk=AAAABBBBCCCC&sid=0123&flow=xtls-rprx-vision&sni=www.example.com&type=tcp#RL');
  const rlCore = renderClashSubscription(rlParsed.nodes);
  assert.ok(rlCore.includes('reality-opts:') && rlCore.includes('AAAABBBBCCCC'), 'core clash carries reality-opts');
  console.log('equivalence battery: worker/core rendered names agree');
}

console.log('smoke test passed');

// ===== Audit round 14 (core): vmess default transport, h2-opts, surge transport filter =====
{
  const noNet = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'core-tcp', add: '203.0.113.20', port: '10086', id: '00000000-0000-4000-8000-000000000001', scy: 'auto', tls: '' })).toString('base64');
  const parsed = parseNodeLinks(noNet);
  assert.equal(parsed.nodes[0].network, 'tcp', 'core: vmess without net defaults to tcp');
  const rawCore = Buffer.from(renderRawSubscription(parsed.nodes), 'base64').toString('utf8');
  assert.equal(JSON.parse(Buffer.from(rawCore.split('vmess://')[1], 'base64').toString('utf8')).net, 'tcp', 'core: re-encoded vmess keeps net=tcp');

  const h2Nodes = [{ type: 'vmess', name: 'core-h2', server: '203.0.113.21', port: 443, uuid: '00000000-0000-4000-8000-000000000001', cipher: 'auto', network: 'h2', tls: true, hostHeader: 'h2.example.com', path: '/h2p', sni: 'h2.example.com', alpn: '', fp: '' }];
  const clashCore = renderClashSubscription(h2Nodes);
  assert.ok(clashCore.includes('h2-opts:'), 'core clash: h2 node carries h2-opts');
  assert.ok(!clashCore.includes('http-opts:'), 'core clash: no http-opts for h2');

  const grpcOnly = [{ type: 'vmess', name: 'core-grpc', server: '203.0.113.22', port: 443, uuid: '00000000-0000-4000-8000-000000000001', cipher: 'auto', network: 'grpc', tls: true, path: 'svc', sni: '', hostHeader: '', alpn: '', fp: '' }];
  assert.throws(() => renderSurgeSubscription(grpcOnly, 'https://x/sub'), /Surge/, 'core surge: grpc-only set is refused');
  const mixed = [...grpcOnly, { ...grpcOnly[0], name: 'core-ws', network: 'ws', path: '/ws' }];
  const surgeCore = renderSurgeSubscription(mixed, 'https://x/sub');
  assert.ok(surgeCore.includes('core-ws'), 'core surge: ws node survives');
  assert.ok(!surgeCore.includes('core-grpc'), 'core surge: grpc node filtered out');
  console.log('audit-14 core suite: vmess tcp default, h2-opts, surge transport filter: passed');
}
