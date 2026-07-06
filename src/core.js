const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const DEFAULT_TEST_URL = 'http://cp.cloudflare.com/generate_204';

export const SUPPORTED_PROTOCOLS = ['vmess', 'vless', 'trojan'];

export function normalizeText(value = '') {
  return String(value).replace(/\r\n?/g, '\n').trim();
}

export function splitCsvLike(text = '') {
  return normalizeText(text)
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ensureSecret(secret) {
  if (!secret || String(secret).trim().length < 16) {
    throw new Error('未配置 SUB_LINK_SECRET，或长度过短（建议至少 16 个字符）。');
  }
  return String(secret).trim();
}

export function detectTarget(userAgent = '', explicitTarget = '') {
  const target = String(explicitTarget || '').trim().toLowerCase();
  if (target && target !== 'auto') {
    return target;
  }

  const ua = String(userAgent || '').toLowerCase();
  if (/clash|mihomo|stash|nekobox|meta/.test(ua)) {
    return 'clash';
  }
  if (/surge/.test(ua)) {
    return 'surge';
  }
  return 'raw';
}

export function buildShareUrls(origin, token) {
  const base = `${origin}/sub/${token}`;
  return {
    auto: base,
    raw: `${base}?target=raw`,
    clash: `${base}?target=clash`,
    surge: `${base}?target=surge`,
    json: `${base}?target=json`,
  };
}

export async function encryptPayload(payload, secret) {
  const key = await getAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plainBytes = textEncoder.encode(JSON.stringify(payload));
  const cipherBytes = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes),
  );

  const merged = new Uint8Array(iv.length + cipherBytes.length);
  merged.set(iv, 0);
  merged.set(cipherBytes, iv.length);
  return bytesToBase64Url(merged);
}

export async function decryptPayload(token, secret) {
  const bytes = base64UrlToBytes(token);
  if (bytes.length <= 12) {
    throw new Error('订阅令牌无效。');
  }
  const iv = bytes.slice(0, 12);
  const cipher = bytes.slice(12);
  const key = await getAesKey(secret);
  const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  const json = textDecoder.decode(plainBuffer);
  return JSON.parse(json);
}

async function getAesKey(secret) {
  const normalized = ensureSecret(secret);
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(normalized));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function parseNodeLinks(inputText) {
  const text = maybeExpandRawSubscription(inputText);
  const lines = normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new Error('请至少粘贴 1 个 vmess:// / vless:// / trojan:// 节点链接。');
  }

  const nodes = [];
  const warnings = [];

  lines.forEach((line, index) => {
    try {
      nodes.push(parseSingleNode(line));
    } catch (error) {
      warnings.push(`第 ${index + 1} 行解析失败：${error.message}`);
    }
  });

  if (!nodes.length) {
    throw new Error(warnings[0] || '没有解析出任何可用节点。');
  }

  return { nodes, warnings, normalizedInput: text };
}

export function parsePreferredEndpoints(inputText) {
  const items = splitCsvLike(inputText);
  if (!items.length) {
    throw new Error('请至少填写 1 个优选 IP 或优选域名。');
  }

  const endpoints = [];
  const warnings = [];
  const seen = new Set();

  items.forEach((raw, index) => {
    try {
      const endpoint = parseEndpoint(raw);
      const dedupeKey = `${endpoint.host}:${endpoint.port || ''}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);
      endpoints.push(endpoint);
    } catch (error) {
      warnings.push(`第 ${index + 1} 个优选地址解析失败：${error.message}`);
    }
  });

  if (!endpoints.length) {
    throw new Error(warnings[0] || '没有解析出任何可用优选地址。');
  }

  return { endpoints, warnings };
}

export function expandNodes(baseNodes, endpoints, options = {}) {
  const keepOriginalHost = options.keepOriginalHost !== false;
  const namePrefix = String(options.namePrefix || '').trim();
  const warnings = [];
  const expanded = [];

  baseNodes.forEach((baseNode) => {
    const originalTlsHost = getEffectiveTlsHost(baseNode);
    if (keepOriginalHost && !originalTlsHost) {
      warnings.push(`节点「${baseNode.name}」缺少 Host/SNI/原始域名，替换成优选 IP 后可能无法握手。`);
    }

    endpoints.forEach((endpoint, index) => {
      const port = endpoint.port || baseNode.port;
      const label = endpoint.label || `${endpoint.host}:${port}`;
      const suffix = namePrefix ? `${namePrefix}-${index + 1}` : label;
      const clone = deepClone(baseNode);
      clone.server = endpoint.host;
      clone.port = port;
      clone.name = buildNodeName(baseNode.name, suffix);
      clone.endpointLabel = endpoint.label || '';
      clone.endpointSource = `${endpoint.host}:${port}`;

      if (keepOriginalHost) {
        clone.sni = baseNode.sni || baseNode.hostHeader || baseNode.originalServer || '';
        clone.hostHeader = baseNode.hostHeader || baseNode.sni || baseNode.originalServer || '';
      } else {
        if (!baseNode.sni || baseNode.sni === baseNode.originalServer) {
          clone.sni = endpoint.host;
        }
        if (!baseNode.hostHeader || baseNode.hostHeader === baseNode.originalServer) {
          clone.hostHeader = endpoint.host;
        }
      }

      expanded.push(clone);
    });
  });

  return { nodes: expanded, warnings };
}

export function summarizeNodes(nodes, limit = 20) {
  return nodes.slice(0, limit).map((node) => ({
    name: node.name,
    type: node.type,
    server: node.server,
    port: node.port,
    host: node.hostHeader || '',
    sni: node.sni || '',
    network: node.network || 'tcp',
    tls: Boolean(node.tls),
  }));
}

export function renderSubscription(target, nodes, requestUrl) {
  switch (target) {
    case 'raw':
    case 'base64':
    case 'v2rayn':
    case 'shadowrocket':
      return {
        body: renderRawSubscription(nodes),
        contentType: 'text/plain; charset=utf-8',
        filename: 'subscription.txt',
      };
    case 'clash':
      return {
        body: renderClashSubscription(nodes),
        contentType: 'text/yaml; charset=utf-8',
        filename: 'subscription-clash.yaml',
      };
    case 'surge':
      return {
        body: renderSurgeSubscription(nodes, requestUrl),
        contentType: 'text/plain; charset=utf-8',
        filename: 'subscription-surge.conf',
      };
    case 'json':
      return {
        body: JSON.stringify(nodes, null, 2),
        contentType: 'application/json; charset=utf-8',
        filename: 'subscription.json',
      };
    default:
      throw new Error(`不支持的订阅输出格式：${target}`);
  }
}

export function renderRawSubscription(nodes) {
  const lines = nodes.map((node) => renderNodeUri(node)).join('\n');
  return encodeBase64Utf8(lines);
}

export function renderClashSubscription(nodes) {
  const supportedNodes = nodes.filter(isClashSupportedNode);
  if (!supportedNodes.length) {
    throw new Error('没有可导出为 Clash 的节点。当前版本主要支持 VMess/VLESS/Trojan 的 WS/TCP/GRPC/HTTP 常见格式。');
  }

  const proxyNames = supportedNodes.map((node) => node.name);
  const lines = [
    '# Generated by CF Worker IP Batch Sub',
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'ipv6: false',
    'proxies:',
  ];

  supportedNodes.forEach((node) => {
    lines.push(...renderClashProxy(node));
  });

  lines.push('proxy-groups:');
  lines.push('  - name: "Proxy"');
  lines.push('    type: select');
  lines.push(`    proxies: ["Auto", ${proxyNames.map(yamlQuote).join(', ')}, "DIRECT"]`);
  lines.push('  - name: "Auto"');
  lines.push('    type: url-test');
  lines.push(`    url: ${yamlQuote(DEFAULT_TEST_URL)}`);
  lines.push('    interval: 300');
  lines.push('    tolerance: 50');
  lines.push(`    proxies: [${proxyNames.map(yamlQuote).join(', ')}]`);
  lines.push('rules:');
  lines.push('  - GEOIP,CN,DIRECT');
  lines.push('  - MATCH,Proxy');

  return lines.join('\n') + '\n';
}

export function renderSurgeSubscription(nodes, requestUrl) {
  const supportedNodes = nodes.filter((node) => node.type === 'vmess' || node.type === 'trojan');
  if (!supportedNodes.length) {
    throw new Error('当前 Surge 导出仅支持 VMess / Trojan 节点。你的示例 VMess 节点可以正常使用该导出。');
  }

  const proxyNames = supportedNodes.map((node) => sanitizeSurgeName(node.name));
  const lines = [
    `#!MANAGED-CONFIG ${requestUrl} interval=86400 strict=false`,
    '',
    '[General]',
    'loglevel = notify',
    `internet-test-url = ${DEFAULT_TEST_URL}`,
    `proxy-test-url = ${DEFAULT_TEST_URL}`,
    'ipv6 = false',
    '',
    '[Proxy]',
  ];

  supportedNodes.forEach((node) => {
    lines.push(renderSurgeProxy(node));
  });

  lines.push('');
  lines.push('[Proxy Group]');
  lines.push(`🚀 节点选择 = select, ♻️ 自动选择, ${proxyNames.join(', ')}`);
  lines.push(`♻️ 自动选择 = url-test, ${proxyNames.join(', ')}, url=${DEFAULT_TEST_URL}, interval=600, tolerance=50`);
  lines.push('');
  lines.push('[Rule]');
  lines.push('FINAL, 🚀 节点选择');
  lines.push('');

  return lines.join('\n');
}

export function renderNodeUri(node) {
  switch (node.type) {
    case 'vmess':
      return renderVmessUri(node);
    case 'vless':
      return renderVlessUri(node);
    case 'trojan':
      return renderTrojanUri(node);
    default:
      throw new Error(`未知节点类型：${node.type}`);
  }
}

export function renderVmessUri(node) {
  const payload = {
    v: '2',
    ps: node.name,
    add: node.server,
    port: String(node.port),
    id: node.uuid,
    aid: String(node.alterId ?? 0),
    scy: node.cipher || 'auto',
    net: node.network || 'ws',
    type: node.headerType || '',
    host: node.hostHeader || '',
    path: node.path || '/',
    tls: node.tls ? (node.security || 'tls') : '',
    sni: node.sni || '',
    fp: node.fp || '',
    alpn: Array.isArray(node.alpn) && node.alpn.length ? node.alpn.join(',') : '',
  };
  return `vmess://${encodeBase64Utf8(JSON.stringify(payload))}`;
}

export function renderVlessUri(node) {
  const params = new URLSearchParams(node.params || {});
  params.set('type', node.network || 'ws');
  params.set('encryption', node.encryption || 'none');
  if (node.security) {
    params.set('security', node.security);
  } else if (node.tls) {
    params.set('security', 'tls');
  } else {
    params.delete('security');
  }
  setQueryParam(params, 'path', node.path || '');
  setQueryParam(params, 'host', node.hostHeader || '');
  setQueryParam(params, 'sni', node.sni || '');
  setQueryParam(params, 'alpn', node.alpn?.length ? node.alpn.join(',') : '');
  setQueryParam(params, 'fp', node.fp || '');
  setQueryParam(params, 'flow', node.flow || '');
  setQueryParam(params, 'serviceName', node.serviceName || '');
  setQueryParam(params, 'authority', node.authority || '');
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `vless://${encodeURIComponent(node.uuid)}@${formatHostForUrl(node.server)}:${node.port}?${params.toString()}${hash}`;
}

export function renderTrojanUri(node) {
  const params = new URLSearchParams(node.params || {});
  params.set('type', node.network || 'ws');
  if (node.security) {
    params.set('security', node.security);
  } else {
    params.set('security', 'tls');
  }
  setQueryParam(params, 'path', node.path || '');
  setQueryParam(params, 'host', node.hostHeader || '');
  setQueryParam(params, 'sni', node.sni || '');
  setQueryParam(params, 'alpn', node.alpn?.length ? node.alpn.join(',') : '');
  setQueryParam(params, 'fp', node.fp || '');
  setQueryParam(params, 'serviceName', node.serviceName || '');
  setQueryParam(params, 'authority', node.authority || '');
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `trojan://${encodeURIComponent(node.password)}@${formatHostForUrl(node.server)}:${node.port}?${params.toString()}${hash}`;
}

function maybeExpandRawSubscription(inputText) {
  const text = normalizeText(inputText);
  if (!text || text.includes('://')) {
    return text;
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) {
    return text;
  }
  try {
    const decoded = decodeBase64Utf8(text);
    if (decoded.includes('://')) {
      return decoded;
    }
  } catch {
    // ignore
  }
  return text;
}

function parseSingleNode(uri) {
  const lower = uri.toLowerCase();
  if (lower.startsWith('vmess://')) {
    return parseVmessUri(uri);
  }
  if (lower.startsWith('vless://')) {
    return parseVlessUri(uri);
  }
  if (lower.startsWith('trojan://')) {
    return parseTrojanUri(uri);
  }
  throw new Error('只支持 vmess://、vless://、trojan://');
}

function parseVmessUri(uri) {
  const encoded = uri.slice('vmess://'.length).trim();
  const jsonText = decodeBase64Utf8(encoded);
  const data = JSON.parse(jsonText);
  const server = String(data.add || '').trim();
  const port = normalizePort(data.port, 443);
  const uuid = String(data.id || '').trim();
  if (!server || !uuid) {
    throw new Error('VMess 链接缺少 add 或 id');
  }

  return {
    type: 'vmess',
    name: String(data.ps || 'vmess').trim() || 'vmess',
    server,
    originalServer: server,
    port,
    uuid,
    alterId: normalizeInteger(data.aid, 0),
    cipher: String(data.scy || data.cipher || 'auto').trim() || 'auto',
    network: String(data.net || 'ws').trim() || 'ws',
    path: normalizePath(data.path || '/'),
    hostHeader: String(data.host || '').trim(),
    sni: String(data.sni || '').trim(),
    tls: isTlsEnabled(data.tls),
    security: String(data.tls || '').trim(),
    alpn: splitListValue(data.alpn),
    fp: String(data.fp || '').trim(),
    headerType: String(data.type || '').trim(),
    allowInsecure: toBoolean(data.allowInsecure),
    params: {},
  };
}

function parseVlessUri(uri) {
  const url = new URL(uri);
  const params = Object.fromEntries(url.searchParams.entries());
  const server = url.hostname;
  const port = normalizePort(url.port || params.port, 443);
  const uuid = decodeURIComponent(url.username || '').trim();
  if (!server || !uuid) {
    throw new Error('VLESS 链接缺少主机或 UUID');
  }

  const network = String(params.type || 'tcp').trim() || 'tcp';
  const security = String(params.security || '').trim();
  return {
    type: 'vless',
    name: decodeHashName(url.hash) || 'vless',
    server,
    originalServer: server,
    port,
    uuid,
    network,
    path: normalizePath(params.path || ''),
    hostHeader: String(params.host || '').trim(),
    sni: String(params.sni || params.peer || '').trim(),
    tls: security === 'tls' || security === 'reality',
    security,
    alpn: splitListValue(params.alpn),
    fp: String(params.fp || '').trim(),
    allowInsecure: toBoolean(params.allowInsecure || params.insecure),
    flow: String(params.flow || '').trim(),
    serviceName: String(params.serviceName || '').trim(),
    authority: String(params.authority || '').trim(),
    encryption: String(params.encryption || 'none').trim() || 'none',
    params,
  };
}

function parseTrojanUri(uri) {
  const url = new URL(uri);
  const params = Object.fromEntries(url.searchParams.entries());
  const server = url.hostname;
  const port = normalizePort(url.port || params.port, 443);
  const password = decodeURIComponent(url.username || '').trim();
  if (!server || !password) {
    throw new Error('Trojan 链接缺少主机或密码');
  }

  const security = String(params.security || 'tls').trim() || 'tls';
  return {
    type: 'trojan',
    name: decodeHashName(url.hash) || 'trojan',
    server,
    originalServer: server,
    port,
    password,
    network: String(params.type || 'tcp').trim() || 'tcp',
    path: normalizePath(params.path || ''),
    hostHeader: String(params.host || '').trim(),
    sni: String(params.sni || params.peer || '').trim(),
    tls: security === 'tls',
    security,
    alpn: splitListValue(params.alpn),
    fp: String(params.fp || '').trim(),
    allowInsecure: toBoolean(params.allowInsecure || params.insecure),
    serviceName: String(params.serviceName || '').trim(),
    authority: String(params.authority || '').trim(),
    params,
  };
}

function parseEndpoint(rawLine) {
  const raw = String(rawLine || '').trim();
  if (!raw) {
    throw new Error('优选地址为空');
  }

  const hashIndex = raw.indexOf('#');
  const hostPart = hashIndex >= 0 ? raw.slice(0, hashIndex).trim() : raw;
  const label = hashIndex >= 0 ? raw.slice(hashIndex + 1).trim() : '';
  const { host, port } = splitHostAndPort(hostPart);

  if (!host) {
    throw new Error(`无效地址：${raw}`);
  }

  return { host, port, label };
}

function splitHostAndPort(input) {
  const value = String(input || '').trim();
  if (!value) {
    return { host: '', port: undefined };
  }

  if (value.startsWith('[')) {
    const match = value.match(/^\[([^\]]+)](?::(\d+))?$/);
    if (!match) {
      throw new Error(`IPv6 地址格式错误：${value}`);
    }
    return {
      host: match[1],
      port: match[2] ? normalizePort(match[2]) : undefined,
    };
  }

  const colonCount = (value.match(/:/g) || []).length;
  if (colonCount > 1) {
    // 视为裸 IPv6，不拆端口
    return { host: value, port: undefined };
  }

  const parts = value.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: normalizePort(parts[1]) };
  }

  return { host: value, port: undefined };
}

function renderClashProxy(node) {
  const lines = [`  - name: ${yamlQuote(node.name)}`, `    type: ${node.type}`];
  lines.push(`    server: ${yamlQuote(node.server)}`);
  lines.push(`    port: ${node.port}`);
  lines.push('    udp: true');

  if (node.type === 'vmess') {
    lines.push(`    uuid: ${yamlQuote(node.uuid)}`);
    lines.push(`    alterId: ${node.alterId ?? 0}`);
    lines.push(`    cipher: ${yamlQuote(node.cipher || 'auto')}`);
  }
  if (node.type === 'vless') {
    lines.push(`    uuid: ${yamlQuote(node.uuid)}`);
    if (node.flow) {
      lines.push(`    flow: ${yamlQuote(node.flow)}`);
    }
  }
  if (node.type === 'trojan') {
    lines.push(`    password: ${yamlQuote(node.password)}`);
  }

  if (node.tls) {
    lines.push('    tls: true');
    const servername = getEffectiveTlsHost(node);
    if (servername) {
      lines.push(`    servername: ${yamlQuote(servername)}`);
    }
    if (node.alpn?.length) {
      lines.push(`    alpn: [${node.alpn.map(yamlQuote).join(', ')}]`);
    }
    if (node.fp) {
      lines.push(`    client-fingerprint: ${yamlQuote(node.fp)}`);
    }
    lines.push(`    skip-cert-verify: ${node.allowInsecure ? 'true' : 'false'}`);
  }

  lines.push(`    network: ${node.network || 'tcp'}`);

  if (node.network === 'ws') {
    lines.push('    ws-opts:');
    lines.push(`      path: ${yamlQuote(node.path || '/')}`);
    if (node.hostHeader) {
      lines.push('      headers:');
      lines.push(`        Host: ${yamlQuote(node.hostHeader)}`);
    }
  }

  if (node.network === 'grpc') {
    lines.push('    grpc-opts:');
    lines.push(`      grpc-service-name: ${yamlQuote(node.serviceName || '')}`);
  }

  if (node.network === 'http' || node.network === 'h2') {
    lines.push('    http-opts:');
    lines.push(`      path: [${yamlQuote(node.path || '/')}]`);
    if (node.hostHeader) {
      lines.push('      headers:');
      lines.push(`        Host: [${yamlQuote(node.hostHeader)}]`);
    }
  }

  return lines;
}

function renderSurgeProxy(node) {
  const name = sanitizeSurgeName(node.name);
  if (node.type === 'vmess') {
    const params = [
      `username=${node.uuid}`,
      `vmess-aead=true`,
      `tls=${node.tls ? 'true' : 'false'}`,
      `skip-cert-verify=${node.allowInsecure ? 'true' : 'false'}`,
    ];
    const sni = getEffectiveTlsHost(node);
    if (sni) {
      params.push(`sni=${sni}`);
    }
    if (node.network === 'ws') {
      params.push('ws=true');
      params.push(`ws-path=${node.path || '/'}`);
      if (node.hostHeader) {
        params.push(`ws-headers=Host:"${escapeSurgeHeader(node.hostHeader)}"`);
      }
    }
    return `${name} = vmess, ${formatHostForUrl(node.server)}, ${node.port}, ${params.join(', ')}`;
  }

  const trojanParams = [];
  trojanParams.push(`password=${node.password}`);
  trojanParams.push(`skip-cert-verify=${node.allowInsecure ? 'true' : 'false'}`);
  const sni = getEffectiveTlsHost(node);
  if (sni) {
    trojanParams.push(`sni=${sni}`);
  }
  if (node.network === 'ws') {
    trojanParams.push('ws=true');
    trojanParams.push(`ws-path=${node.path || '/'}`);
    if (node.hostHeader) {
      trojanParams.push(`ws-headers=Host:"${escapeSurgeHeader(node.hostHeader)}"`);
    }
  }
  return `${name} = trojan, ${formatHostForUrl(node.server)}, ${node.port}, ${trojanParams.join(', ')}`;
}

function buildNodeName(baseName, suffix) {
  const cleanBase = String(baseName || '').trim() || 'node';
  const cleanSuffix = String(suffix || '').trim();
  return cleanSuffix ? `${cleanBase} | ${cleanSuffix}` : cleanBase;
}

function getEffectiveTlsHost(node) {
  return String(node.sni || node.hostHeader || node.originalServer || '').trim();
}

function isClashSupportedNode(node) {
  return ['vmess', 'vless', 'trojan'].includes(node.type);
}

function isTlsEnabled(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'tls' || text === 'xtls' || text === 'reality';
}

function decodeHashName(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) {
    return '';
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizePort(value, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  if (Number.isInteger(number) && number >= 1 && number <= 65535) {
    return number;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`端口无效：${value}`);
}

function normalizeInteger(value, fallback = 0) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePath(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '/';
  }
  return text.startsWith('/') ? text : `/${text}`;
}

function splitListValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatHostForUrl(host) {
  if (String(host).includes(':') && !String(host).startsWith('[')) {
    return `[${host}]`;
  }
  return host;
}

function setQueryParam(params, key, value) {
  const normalized = String(value || '').trim();
  if (normalized) {
    params.set(key, normalized);
  } else {
    params.delete(key);
  }
}

function yamlQuote(value) {
  const text = String(value ?? '');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sanitizeSurgeName(name) {
  return String(name || 'proxy')
    .replace(/[\r\n]/g, ' ')
    .replace(/,/g, '，')
    .replace(/=/g, '＝')
    .trim();
}

function escapeSurgeHeader(value) {
  return String(value || '').replace(/"/g, '\\"');
}

function toBoolean(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function encodeBase64Utf8(text) {
  return bytesToBase64(textEncoder.encode(text));
}

function decodeBase64Utf8(base64Text) {
  return textDecoder.decode(base64ToBytes(normalizeBase64(base64Text)));
}

function normalizeBase64(input) {
  const value = String(input || '').trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  return value + padding;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64Text) {
  const binary = atob(base64Text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(text) {
  return base64ToBytes(normalizeBase64(text));
}
