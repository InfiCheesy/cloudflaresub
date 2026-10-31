// Small DOM / request shorthands used across the page.
const byId = (id) => document.getElementById(id);
function postJson(path, payload) {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
async function fetchEntry(id, token) {
  const resp = await fetch('/api/entry?' + new URLSearchParams({ id }), {
    headers: { 'x-admin-token': token },
  });
  return { resp, data: await resp.json().catch(() => null) };
}

// ---- Diagnostics journal ---------------------------------------------------
// A session ring of what the page DID: every API call's route template,
// status and duration, plus a few lifecycle events. Whitelist-shaped by
// construction — no bodies, no query strings, no user content — so the
// exported log is safe to hand to a maintainer. (The error ring lives in
// window.__diagErrors, installed by the inline script in index.html so
// it also catches failures from before this file loads.)
const diagJournal = [];
function diagPush(evt) {
  diagJournal.push({ t: Date.now(), ...evt });
  if (diagJournal.length > 120) diagJournal.splice(0, diagJournal.length - 120);
}
window.__diagJournal = diagJournal;
diagPush({ kind: 'event', name: 'boot' });
window.addEventListener('online', () => diagPush({ kind: 'event', name: 'online' }));
window.addEventListener('offline', () => diagPush({ kind: 'event', name: 'offline' }));
document.addEventListener('visibilitychange', () => {
  diagPush({ kind: 'event', name: document.visibilityState === 'visible' ? 'page-visible' : 'page-hidden' });
});
const rawFetch = window.fetch.bind(window);
// No request may hang forever: a stalled platform request used to
// leave the UI stuck on 生成中/加载中 with no trace in this journal
// (only completed calls were recorded). Every string-URL fetch gets
// a 20s AbortController budget; a timeout is journaled as
// err 'timeout' and surfaces as a clear Chinese error.
const FETCH_TIMEOUT_MS = 20000;
window.fetch = async (input, init) => {
  const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
  let path = '';
  try { path = new URL(urlStr, location.origin).pathname; } catch {}
  const track = path.startsWith('/api/') || path.startsWith('/sub/');
  const template = path.startsWith('/sub/') ? '/sub/:id' : path;
  const method = (init && init.method) || (input && input.method) || 'GET';
  const started = performance.now();
  let controller = null;
  let timer = null;
  let timedOut = false;
  let effectiveInit = init;
  if (typeof input === 'string' && !(init && init.signal) && typeof AbortController === 'function') {
    controller = new AbortController();
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, FETCH_TIMEOUT_MS);
    effectiveInit = { ...(init || {}), signal: controller.signal };
  }
  try {
    const resp = await rawFetch(input, effectiveInit);
    if (track) {
      diagPush({ kind: 'api', route: `${method} ${template}`, status: resp.status, ms: Math.round(performance.now() - started) });
    }
    return resp;
  } catch (e) {
    if (track) {
      diagPush({ kind: 'api', route: `${method} ${template}`, status: 0, ms: Math.round(performance.now() - started), err: timedOut ? 'timeout' : ((e && e.name) || 'Error') });
    }
    if (timedOut) throw new Error('请求超时，请检查网络后重试');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const form = byId('generator-form');
const submitBtn = byId('submitBtn');
const fillDemoBtn = byId('fillDemoBtn');
const resultSection = byId('resultSection');
const warningBox = byId('warningBox');
const previewBody = byId('previewBody');

const autoUrl = byId('autoUrl');
const rawUrl = byId('rawUrl');
const clashUrl = byId('clashUrl');
const surgeUrl = byId('surgeUrl');
const plainUrl = byId('plainUrl');
const plainLinks = byId('plainLinks');
const emptyState = byId('emptyState');

const qrModal = byId('qrModal');
const qrCanvas = byId('qrCanvas');
const qrText = byId('qrText');
const closeQrModal = byId('closeQrModal');

const demoVmess = [
  'vmess://ewogICJ2IjogIjIiLAogICJwcyI6ICJkZW1vLXdzLXRscyIsCiAgImFkZCI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAicG9ydCI6ICI0NDMiLAogICJpZCI6ICIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLAogICJzY3kiOiAiYXV0byIsCiAgIm5ldCI6ICJ3cyIsCiAgInRscyI6ICJ0bHMiLAogICJwYXRoIjogIi93cyIsCiAgImhvc3QiOiAiZWRnZS5leGFtcGxlLmNvbSIsCiAgInNuaSI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAiZnAiOiAiY2hyb21lIiwKICAiYWxwbiI6ICJoMixodHRwLzEuMSIKfQ=='
].join('\n');

const demoIps = [
  '104.16.1.2#HK-01',
  '104.17.2.3#HK-02',
  '104.18.3.4:2053#US-Edge'
].join('\n');

// ---------------- Preferred-IP box: literal lines + source links --------
const ipSourceLimitInput = byId('ipSourceLimit');
const ipSourceMsg = byId('ipSourceMsg');
const testIpSourceBtn = byId('testIpSourceBtn');

if (testIpSourceBtn) {
  testIpSourceBtn.addEventListener('click', async () => {
    const text = byId('preferredIps')?.value || '';
    const token = adminToken();
    if (!/^https?:\/\//im.test(text)) {
      ipSourceMsg.textContent = '框里还没有来源链接（以 https:// 开头的一行）。';
      return;
    }
    if (!token) {
      ipSourceMsg.textContent = '请先在页面下方「KV 条目管理」处填入管理令牌，再测试拉取。';
      return;
    }
    testIpSourceBtn.disabled = true;
    ipSourceMsg.textContent = '正在拉取…';
    try {
      const resp = await postJson('/api/ip-source-test', { text, token });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) throw new Error((data && data.error) || '拉取失败');
      ipSourceMsg.textContent = data.results
        .map((r) => (r.ok
          ? `✓ ${r.url}：解析到 ${r.count} 个可用优选地址${r.sample?.length ? `（前几个：${r.sample.join('、')}）` : ''}`
          : `✗ ${r.url}：${r.error || '拉取失败'}`))
        .join('\n');
    } catch (e) {
      ipSourceMsg.textContent = `拉取失败：${e.message || e}`;
    } finally {
      testIpSourceBtn.disabled = false;
    }
  });
}

const storageModeSelect = byId('storageMode');
const retentionDaysInput = byId('retentionDays');
if (storageModeSelect && retentionDaysInput) {
  storageModeSelect.addEventListener('change', () => {
    retentionDaysInput.disabled = storageModeSelect.value !== 'days';
  });
}

// ---------------- Drag-to-reorder chips (long-press) ----------------
// Chip lists whose order is meaningful (the generate-form picker, an
// entry's tag-edit panel, the filter bar) reorder by long-press drag:
// press ~220ms to pick a chip up — a shorter press, or moving first,
// stays an ordinary tap/scroll. The picked-up chip LEAVES the flow
// (position:fixed, follows the pointer) and a dashed placeholder holds
// its slot; only the placeholder moves among the siblings, and they
// glide to their new spots with a FLIP transform animation. Because
// the dragged chip never feeds back into the layout, the midpoint
// hit-test is stable — no jitter. On release the placeholder's slot
// gives the new order through onReorder(tagValues). An optional trash
// element (the filter bar's label) turns into a bin during the drag;
// dropping the chip on it calls onTrash(tagValue) instead.
function makeChipsSortable(container, chipSelector, { onReorder, trashEl = null, onTrash = null } = {}) {
  if (!container) return;
  let drag = null;
  const siblings = () => [...container.querySelectorAll(chipSelector)].filter((c) => c !== drag.chip);
  // Move the placeholder, animating the siblings from their old spots.
  const flipMove = (mutate) => {
    const chips = siblings();
    const before = new Map(chips.map((c) => [c, c.getBoundingClientRect()]));
    mutate();
    for (const c of chips) {
      const b = before.get(c);
      if (!b) continue;
      const a = c.getBoundingClientRect();
      const dx = b.left - a.left;
      const dy = b.top - a.top;
      if (!dx && !dy) continue;
      c.style.transition = 'none';
      c.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        c.style.transition = 'transform 180ms ease';
        c.style.transform = '';
      });
    }
  };
  const endDrag = (commit) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    if (!d.active) return;
    if (trashEl) {
      trashEl.textContent = d.trashText ?? trashEl.textContent;
      trashEl.classList.remove('trash-armed', 'is-hot');
    }
    const trashed = commit && d.overTrash && typeof onTrash === 'function';
    // Put the chip back into the slot the placeholder held, THEN read
    // the order off the restored DOM. Restoring unconditionally also
    // keeps the list whole when a trash drop is cancelled at its
    // confirm dialog.
    if (d.placeholder) {
      try {
        if (d.placeholder.parentElement === container) {
          container.insertBefore(d.chip, d.placeholder);
        } else {
          throw new Error('placeholder replaced mid-drag');
        }
      } catch {
        // A mid-drag re-render destroyed the placeholder and rebuilt
        // the chips from data — the dragged tag is already back in
        // the list as a fresh chip, so drop this stale element
        // rather than duplicate it (append only if it is somehow
        // missing). The cleanup below must run either way: a throw
        // here used to strand the chip in <body> with drag styles.
        const rebuilt = [...container.querySelectorAll(chipSelector)];
        if (rebuilt.some((c) => c.dataset.sortValue === d.chip.dataset.sortValue)) d.chip.remove();
        else container.appendChild(d.chip);
      }
      d.placeholder.remove();
    }
    d.chip.classList.remove('dragging');
    d.chip.style.cssText = '';
    container.classList.remove('chip-sorting');
    const values = commit && !trashed
      ? [...container.querySelectorAll(chipSelector)].map((c) => c.dataset.sortValue)
      : null;
    // The click this gesture is about to produce must not also toggle
    // the chip (filter chips are buttons): swallow exactly one.
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    container.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => container.removeEventListener('click', swallow, { capture: true }), 400);
    if (trashed) onTrash(d.chip.dataset.sortValue);
    else if (values) onReorder(values);
  };
  const onMove = (event) => {
    if (!drag) return;
    if (!drag.active) {
      // Moved before the press matured: this gesture is a scroll.
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 10) endDrag(false);
      return;
    }
    event.preventDefault();
    drag.chip.style.left = `${event.clientX - drag.grabDX - (drag.originDX || 0)}px`;
    drag.chip.style.top = `${event.clientY - drag.grabDY - (drag.originDY || 0)}px`;
    if (trashEl) {
      const r = trashEl.getBoundingClientRect();
      drag.overTrash = event.clientX >= r.left && event.clientX <= r.right
        && event.clientY >= r.top && event.clientY <= r.bottom;
      trashEl.classList.toggle('is-hot', drag.overTrash);
      if (drag.overTrash) return; // the slot stays put while over the bin
    }
    let target = null;
    for (const sib of siblings()) {
      const r = sib.getBoundingClientRect();
      const before = event.clientY < r.top
        || (event.clientY <= r.bottom && event.clientX < r.left + r.width / 2);
      if (before) { target = sib; break; }
    }
    const ph = drag.placeholder;
    if (target) {
      if (ph.nextSibling !== target) flipMove(() => container.insertBefore(ph, target));
    } else if (container.lastChild !== ph) {
      flipMove(() => container.appendChild(ph));
    }
  };
  const onUp = () => endDrag(true);
  const onCancel = () => endDrag(false);
  container.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const chip = event.target.closest(chipSelector);
    if (!chip || !container.contains(chip)) return;
    // A nested button inside a chip (the ×) stays a plain tap; a chip
    // that IS a button (filter chips) drags from its whole body.
    const innerBtn = event.target.closest('button');
    if (innerBtn && innerBtn !== chip) return;
    const state = {
      chip, x: event.clientX, y: event.clientY,
      active: false, timer: null, placeholder: null, overTrash: false, grabDX: 0, grabDY: 0, originDX: 0, originDY: 0, trashText: null,
    };
    state.timer = setTimeout(() => {
      state.active = true;
      const rect = chip.getBoundingClientRect();
      const ph = document.createElement('span');
      ph.className = 'chip-placeholder';
      ph.style.width = `${rect.width}px`;
      ph.style.height = `${rect.height}px`;
      container.insertBefore(ph, chip);
      state.placeholder = ph;
      state.grabDX = state.x - rect.left;
      state.grabDY = state.y - rect.top;
      // The chip is re-homed to <body> while dragging: left in place,
      // its position:fixed would be resolved against any transformed
      // or filtered ancestor instead of the viewport, and the chip
      // would jump away from the finger (seen live: it flew to the
      // top of the page). As a body child, fixed means the viewport.
      document.body.appendChild(chip);
      chip.classList.add('dragging');
      chip.style.position = 'fixed';
      chip.style.left = `${rect.left}px`;
      chip.style.top = `${rect.top}px`;
      chip.style.width = `${rect.width}px`;
      chip.style.zIndex = '1000';
      chip.style.pointerEvents = 'none';
      // Self-calibrate: if the placed chip is not exactly where the
      // finger grabbed it (any containing-block offset), remember the
      // delta and compensate for it here and on every move.
      const placed = chip.getBoundingClientRect();
      state.originDX = placed.left - rect.left;
      state.originDY = placed.top - rect.top;
      if (state.originDX || state.originDY) {
        chip.style.left = `${rect.left - state.originDX}px`;
        chip.style.top = `${rect.top - state.originDY}px`;
      }
      container.classList.add('chip-sorting');
      if (trashEl) {
        state.trashText = trashEl.textContent;
        trashEl.textContent = '🗑';
        trashEl.classList.add('trash-armed');
      }
    }, 220);
    drag = state;
    // Track the gesture at window level: no pointer capture needed,
    // and fast drags that leave the container keep working.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  });
}

// ---------------- Generate-form tag picker ----------------
// Selected tags ride along with the generate request ONLY when the
// owner actually touched the picker (added/removed a chip, or a
// backfill loaded an entry's tags). Untouched = the field is omitted,
// and the server then leaves a refreshed entry's tags alone.
const genTagChips = byId('genTagChips');
const genTagInput = byId('tagInput');
const genTagSuggestions = byId('genTagSuggestions');
let genTags = [];
let genTagsTouched = false;
let genTagVocab = null; // [{tag, count}] from GET /api/tags, lazy

function renderGenTagSuggestions() {
  if (!genTagSuggestions) return;
  if (genTagChips?.classList.contains('chip-sorting')) return; // mid-drag: the drop re-renders
  // The picker suggestions follow the filter bar's (stored) order,
  // not the server vocabulary's raw count order.
  const vocab = applyTagOrder(genTagVocab || []).filter(
    (v) => !genTags.some((t) => t.toLowerCase() === String(v.tag).toLowerCase()),
  );
  genTagSuggestions.innerHTML = vocab
    .map((v) => `<button type="button" class="tag-chip tag-chip-pick" data-gen-tag-pick="${escapeHtml(v.tag)}">${escapeHtml(v.tag)} · ${v.count}</button>`)
    .join('');
}

function renderGenTags() {
  if (genTagChips) {
    genTagChips.innerHTML = genTags
      .map((t, i) => `<span class="tag-chip" data-sort-value="${escapeHtml(t)}">${escapeHtml(t)}<button type="button" class="tag-chip-x" data-gen-tag-remove="${i}" aria-label="移除标签 ${escapeHtml(t)}">×</button></span>`)
      .join('');
  }
  renderGenTagSuggestions();
}

function addGenTag(raw) {
  const tag = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  if (!tag) return;
  if (genTags.length >= 10) return;
  if (genTags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
  genTags.push(tag);
  genTagsTouched = true;
  renderGenTags();
}

function setGenTags(tags, touched) {
  // External data (backfill) is normalized at this boundary: only
  // strings may enter the picker — downstream code calls string
  // methods on members without re-checking.
  genTags = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
  genTagsTouched = !!touched;
  if (genTagInput) genTagInput.value = '';
  renderGenTags();
}

async function loadGenTagVocab() {
  // The vocabulary DATA stays cached, but focusing the picker always
  // re-renders the suggestions so their ORDER reflects the current
  // canonical (filter-bar) order, not the order at first load.
  if (genTagVocab) {
    renderGenTagSuggestions();
    return;
  }
  const token = adminToken();
  if (!token) return;
  // A token pasted just now (no list load yet) should also pick up
  // the shared order before the suggestions render.
  if (!tagOrderLoaded) loadTagOrderFromServer();
  try {
    const resp = await fetch('/api/tags', { headers: { 'x-admin-token': token } });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      genTagVocab = data.tags || [];
      renderGenTagSuggestions();
    }
  } catch {}
}

if (genTagInput) {
  genTagInput.addEventListener('keydown', (event) => {
    // Enter during IME composition confirms a candidate; it must not
    // also commit the half-typed text as a tag.
    if (event.isComposing) return;
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addGenTag(genTagInput.value);
      genTagInput.value = '';
    }
  });
  genTagInput.addEventListener('focus', loadGenTagVocab);
}
if (genTagChips) {
  genTagChips.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-gen-tag-remove]');
    if (!btn) return;
    genTags.splice(Number(btn.dataset.genTagRemove), 1);
    genTagsTouched = true;
    renderGenTags();
  });
  // Long-press drag reorders the picker; a reorder is a deliberate
  // edit, so it marks the picker touched like an add/remove does.
  makeChipsSortable(genTagChips, '.tag-chip', {
    onReorder: (values) => {
      genTags = values;
      genTagsTouched = true;
      renderGenTags();
    },
  });
}
if (genTagSuggestions) {
  genTagSuggestions.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-gen-tag-pick]');
    if (!btn) return;
    addGenTag(btn.dataset.genTagPick);
  });
}

fillDemoBtn.addEventListener('click', () => {
  setGenTags([], false);
  byId('nodeLinks').value = demoVmess;
  byId('preferredIps').value = demoIps;
  byId('namePrefix').value = 'CF';
  byId('keepOriginalHost').checked = true;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  warningBox.classList.add('hidden');
  previewBody.innerHTML = '';

  const payload = {
    nodeLinks: byId('nodeLinks').value,
    preferredIps: byId('preferredIps').value,
    sourceLimit: Number(ipSourceLimitInput?.value || 10),
    namePrefix: byId('namePrefix').value,
    keepOriginalHost: byId('keepOriginalHost').checked,
    // Generating writes to KV, so it carries the same admin token the
    // owner keeps in the admin section's token box below.
    token: adminToken(),
    note: byId('subNote')?.value || '',
    // Only sent when the tag picker was touched (see its section):
    // untouched must leave a refreshed entry's tags unchanged.
    ...(genTagsTouched ? { tags: [...genTags] } : {}),
    storageMode: byId('storageMode')?.value || 'permanent',
    retentionDays: Number(byId('retentionDays')?.value || 30),
  };

  submitBtn.disabled = true;
  submitBtn.textContent = '生成中...';

  try {
    const response = await postJson('/api/generate', payload);

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.ok) {
      throw new Error((data && data.error) || '生成失败');
    }
    genTagVocab = null; // this generate may have introduced new tags

    autoUrl.value = data.urls.auto;
    rawUrl.value = data.urls.raw;
    byId('rocketUrl').value = data.urls.raw;
    clashUrl.value = data.urls.clash;
    surgeUrl.value = data.urls.surge;
    if (plainUrl) plainUrl.value = data.urls.plain || '';
    if (plainLinks) {
      plainLinks.value = data.plainText || (Array.isArray(data.links) ? data.links.join('\n') : '');
    }

    emptyState.classList.add('hidden');

    byId('statInputNodes').textContent = data.counts.inputNodes;
    byId('statEndpoints').textContent = data.counts.preferredEndpoints;
    byId('statOutputNodes').textContent = data.counts.outputNodes;

    previewBody.innerHTML = data.preview
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(item.type)}</td>
            <td>${escapeHtml(item.server)}</td>
            <td>${escapeHtml(String(item.port))}</td>
            <td>${escapeHtml(item.host || '-')}</td>
            <td>${escapeHtml(item.sni || '-')}</td>
          </tr>`,
      )
      .join('');

    if (Array.isArray(data.warnings) && data.warnings.length) {
      warningBox.textContent = data.warnings.join('\n');
      warningBox.classList.remove('hidden');
    }

    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    warningBox.textContent = error.message || '请求失败';
    warningBox.classList.remove('hidden');
    // The warning box lives in the result section below the form, and on
    // failure nothing else on screen changes — without scrolling, the
    // owner would never see why the generate seemingly did nothing.
    if (typeof warningBox.scrollIntoView === 'function') {
      warningBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '生成订阅';
  }
});

document.addEventListener('click', async (event) => {
  const copyButton = event.target.closest('[data-copy-target]');
  if (copyButton) {
    const input = byId(copyButton.dataset.copyTarget);
    if (!input?.value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(input.value);
      const originalText = copyButton.textContent;
      copyButton.textContent = '已复制';
      setTimeout(() => {
        copyButton.textContent = originalText;
      }, 1200);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    return;
  }

  const qrButton = event.target.closest('[data-qrcode-target]');
  if (qrButton) {
    warningBox.classList.add('hidden');

    const input = byId(qrButton.dataset.qrcodeTarget);
    if (!input?.value) {
      warningBox.textContent = '请先生成订阅链接，再显示二维码。';
      warningBox.classList.remove('hidden');
      return;
    }

    if (!window.QRCode) {
      warningBox.textContent = '二维码组件加载失败，请刷新页面后重试。';
      warningBox.classList.remove('hidden');
      return;
    }

    qrCanvas.innerHTML = '';
    qrText.textContent = input.value;
    qrOriginBtn = qrButton;
    qrModal.classList.remove('hidden');
    qrModal.setAttribute('aria-hidden', 'false');

    new window.QRCode(qrCanvas, {
      text: input.value,
      width: 220,
      height: 220,
      correctLevel: window.QRCode.CorrectLevel.M,
    });
    playQrMotion(true);
    if (closeQrModal && typeof closeQrModal.focus === 'function') {
      closeQrModal.focus({ preventScroll: true });
    }
    return;
  }

  if (event.target.closest('[data-close-modal="true"]')) {
    closeQrDialog();
  }
});

closeQrModal.addEventListener('click', closeQrDialog);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !qrModal.classList.contains('hidden')) closeQrDialog();
});

// The QR dialog grows out of the button that opened it and shrinks
// back into the same button on close ("从哪来，回哪去"): the flight is
// a translate+scale from the button's rect to the dialog's natural
// rect, computed fresh on every open and close (the button may have
// scrolled meanwhile). Reduced-motion users and missing pieces fall
// back to the previous instant toggle.
let qrOriginBtn = null;
let qrMotionSeq = 0;

function qrDialogParts() {
  return {
    dialog: qrModal.querySelector('.modal-dialog'),
    backdrop: qrModal.querySelector('.modal-backdrop'),
  };
}

function qrMotionKeyframes() {
  const { dialog } = qrDialogParts();
  if (!dialog || !qrOriginBtn || !qrOriginBtn.isConnected) return null;
  if (typeof dialog.animate !== 'function') return null;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const d = dialog.getBoundingClientRect();
  const b = qrOriginBtn.getBoundingClientRect();
  if (!d.width || !d.height || !b.width || !b.height) return null;
  const dx = b.left + b.width / 2 - (d.left + d.width / 2);
  const dy = b.top + b.height / 2 - (d.top + d.height / 2);
  const sx = Math.max(b.width / d.width, 0.02);
  const sy = Math.max(b.height / d.height, 0.02);
  return {
    atOrigin: { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: '0.35' },
    atRest: { transform: 'translate(0px, 0px) scale(1, 1)', opacity: '1' },
  };
}

function playQrMotion(opening) {
  const { dialog, backdrop } = qrDialogParts();
  if (!dialog) return;
  const seq = ++qrMotionSeq;
  if (dialog.getAnimations) dialog.getAnimations().forEach((a) => a.cancel());
  if (backdrop && backdrop.getAnimations) backdrop.getAnimations().forEach((a) => a.cancel());
  const frames = qrMotionKeyframes();
  if (backdrop && typeof backdrop.animate === 'function'
      && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    backdrop.animate(
      opening ? [{ opacity: '0' }, { opacity: '1' }] : [{ opacity: '1' }, { opacity: '0' }],
      { duration: 200, easing: 'ease-out', fill: opening ? 'none' : 'forwards' },
    );
  }
  if (!frames) {
    if (!opening) hideQrDialogNow();
    return;
  }
  const anim = dialog.animate(
    opening ? [frames.atOrigin, frames.atRest] : [frames.atRest, frames.atOrigin],
    {
      duration: opening ? 260 : 230,
      easing: opening ? 'cubic-bezier(0.32, 0.72, 0.24, 1)' : 'cubic-bezier(0.5, 0, 0.75, 0)',
      fill: opening ? 'none' : 'forwards',
    },
  );
  if (!opening) {
    let done = false;
    const finish = () => {
      if (done || seq !== qrMotionSeq) return;
      done = true;
      hideQrDialogNow();
    };
    if (anim && typeof anim === 'object') anim.onfinish = finish;
    setTimeout(finish, 300);
  }
}

function hideQrDialogNow() {
  const { dialog, backdrop } = qrDialogParts();
  if (dialog && dialog.getAnimations) dialog.getAnimations().forEach((a) => a.cancel());
  if (backdrop && backdrop.getAnimations) backdrop.getAnimations().forEach((a) => a.cancel());
  qrModal.classList.add('hidden');
  qrModal.setAttribute('aria-hidden', 'true');
  qrCanvas.innerHTML = '';
  // Focus returns to the button that opened the dialog.
  if (qrOriginBtn && qrOriginBtn.isConnected && typeof qrOriginBtn.focus === 'function') {
    qrOriginBtn.focus({ preventScroll: true });
  }
}

function closeQrDialog() {
  if (qrModal.classList.contains('hidden')) return;
  // playQrMotion hides the dialog when the return flight lands; with
  // no animation available it hides synchronously instead.
  playQrMotion(false);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---------------- KV entry admin ----------------
const adminTokenInput = byId('adminToken');
const adminMsg = byId('adminMsg');
const adminBody = byId('adminBody');
const listBtn = byId('listBtn');
const sortSelect = byId('sortSelect');
const adminSearchInput = byId('adminSearch');
const expandAllBtn = byId('expandAllBtn');
const collapseAllBtn = byId('collapseAllBtn');
const selectAllCheckbox = byId('selectAllEntries');
const deleteSelectedBtn = byId('deleteSelectedBtn');
const adminItems = new Map();
const adminState = {
  items: [],
  sort: 'created-desc',
  query: '',
  selected: new Set(),
  // Tag filter: a set of tag spellings plus the multi-tag mode the
  // owner picked ('and' = entry must carry every selected tag,
  // 'or' = any one suffices). Survives list reloads (it is a view
  // preference); selections whose tag vanished are pruned on render.
  tagSelected: new Set(),
  tagMode: 'and',
};

// Web storage can be present-but-throwing (blocked cookies/storage
// in hardened browsers and in-app webviews) — even reading the global
// can throw, and an unguarded access at load time used to kill the
// whole page script. Every access goes through these helpers and
// degrades to "no storage": a page that cannot remember the admin
// token still works.
function storageGet(name, key) {
  try { return window[name].getItem(key); } catch { return null; }
}
function storageSet(name, key, value) {
  try { window[name].setItem(key, value); } catch {}
}
function storageKeyNames(name) {
  const out = [];
  try {
    const s = window[name];
    for (let i = 0; i < s.length; i++) out.push(s.key(i));
  } catch {}
  return out;
}

const savedAdminToken = storageGet('sessionStorage', 'cfsub_admin_token');
if (adminTokenInput && savedAdminToken) {
  adminTokenInput.value = savedAdminToken;
}

function adminToken() {
  return (adminTokenInput?.value || '').trim();
}

function subUrlFor(id, target, token) {
  // `token` here is the entry's per-entry link token (item.linkToken),
  // never the admin token: these URLs are meant to be copied and shared.
  const base = `${location.origin}/sub/${id}`;
  const q = new URLSearchParams();
  if (target) q.set('target', target);
  if (token) q.set('token', token);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

function nameKeyOf(item) {
  return (item.note && item.note.trim()) || (item.sources || [])[0] || item.id;
}
function createdMs(item) {
  const ms = Date.parse(item.createdAt || '');
  return Number.isNaN(ms) ? 0 : ms;
}
function expiryMs(item) {
  const st = item.storage || { mode: 'permanent' };
  if (st.mode === 'days' && st.expiresAt) {
    const ms = Date.parse(st.expiresAt);
    return Number.isNaN(ms) ? Infinity : ms;
  }
  return Infinity; // permanent entries never expire: they sort as "longest remaining"
}
function cmpNum(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}
function sortedAdminItems() {
  const items = [...adminState.items];
  const byCreatedDesc = (a, b) => createdMs(b) - createdMs(a);
  switch (adminState.sort) {
    case 'created-asc':
      items.sort((a, b) => createdMs(a) - createdMs(b) || byCreatedDesc(a, b));
      break;
    case 'name-asc':
      items.sort((a, b) => nameKeyOf(a).localeCompare(nameKeyOf(b), 'zh-Hans-CN') || byCreatedDesc(a, b));
      break;
    case 'name-desc':
      items.sort((a, b) => nameKeyOf(b).localeCompare(nameKeyOf(a), 'zh-Hans-CN') || byCreatedDesc(a, b));
      break;
    case 'remaining-asc':
      items.sort((a, b) => cmpNum(expiryMs(a), expiryMs(b)) || byCreatedDesc(a, b));
      break;
    case 'remaining-desc':
      items.sort((a, b) => cmpNum(expiryMs(b), expiryMs(a)) || byCreatedDesc(a, b));
      break;
    default:
      items.sort(byCreatedDesc);
  }
  return items;
}

function itemMatchesQuery(item, needle) {
  if (!needle) return true;
  if ((item.id || '').toLowerCase().includes(needle)) return true;
  if ((item.note || '').toLowerCase().includes(needle)) return true;
  if ((item.tags || []).some((t) => String(t).toLowerCase().includes(needle))) return true;
  return (item.sources || []).some((s) => String(s).toLowerCase().includes(needle));
}

function itemMatchesTags(item) {
  const sel = [...adminState.tagSelected];
  if (!sel.length) return true;
  const own = new Set((item.tags || []).map((t) => String(t).toLowerCase()));
  return adminState.tagMode === 'or'
    ? sel.some((t) => own.has(t.toLowerCase()))
    : sel.every((t) => own.has(t.toLowerCase()));
}

function visibleAdminItems() {
  const needle = (adminState.query || '').trim().toLowerCase();
  return sortedAdminItems().filter((item) => itemMatchesQuery(item, needle) && itemMatchesTags(item));
}

function updateAdminCount() {
  const total = adminState.items.length;
  if (adminState.tagSelected.size) {
    adminMsg.textContent = `共 ${total} 条，筛选到 ${visibleAdminItems().length} 条。`;
    return;
  }
  if (!(adminState.query || '').trim()) {
    adminMsg.textContent = `共 ${total} 条。`;
    return;
  }
  adminMsg.textContent = `共 ${total} 条，搜索到 ${visibleAdminItems().length} 条。`;
}

// Selection covers the currently visible entries only (scheme 1): the
// header checkbox is tri-state over the visible set, and the bulk-delete
// button counts selected-and-visible entries.
function updateSelectionUI() {
  const visible = visibleAdminItems();
  const selectedVisible = visible.filter((i) => adminState.selected.has(i.id)).length;
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = visible.length > 0 && selectedVisible === visible.length;
    selectAllCheckbox.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    selectAllCheckbox.disabled = visible.length === 0;
  }
  if (deleteSelectedBtn) {
    deleteSelectedBtn.disabled = selectedVisible === 0;
    deleteSelectedBtn.textContent = selectedVisible ? `删除所选（${selectedVisible}）` : '删除所选';
  }
}

// ---------------- Tag filter bar ----------------
const tagFilterBar = byId('tagFilterBar');
const tagFilterChips = byId('tagFilterChips');
const tagFilterClear = byId('tagFilterClear');
const tagModeAndBtn = byId('tagModeAnd');
const tagModeOrBtn = byId('tagModeOr');

function allTagCounts() {
  // Case variants of one tag ('HK' vs 'hk') are a single tag for
  // filtering, matching the server vocabulary: aggregate by lowercase,
  // show the first spelling seen, count entries (never occurrences).
  const byLower = new Map();
  for (const item of adminState.items) {
    const seen = new Set();
    for (const t of item.tags || []) {
      const lower = String(t).toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      const cur = byLower.get(lower);
      if (cur) cur.count += 1;
      // Display form is always a string, whatever the source sent —
      // downstream comparators call .localeCompare on it.
      else byLower.set(lower, { tag: String(t), count: 1 });
    }
  }
  return [...byLower.values()]
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
}

function selectedTagLowers() {
  return new Set([...adminState.tagSelected].map((t) => t.toLowerCase()));
}

function entryTagsHtml(item) {
  const tags = item.tags || [];
  if (!tags.length) return '';
  const sel = selectedTagLowers();
  return `<div class="entry-tags">${tags.map((t) => `<button type="button" class="tag-chip tag-chip-mini${sel.has(String(t).toLowerCase()) ? ' is-on' : ''}" data-tag-filter="${escapeHtml(t)}" title="按此标签筛选">${escapeHtml(t)}</button>`).join('')}</div>`;
}

// The tag display order lives on the SERVER (GET/POST
// /api/tag-order): one shared arrangement for every device. This
// variable is only the current page's working copy. The order used
// to be a per-browser localStorage preference, which made devices
// disagree; the one remaining localStorage interaction is the
// one-time import in loadTagOrderFromServer, after which the legacy
// key is removed and never read or written again.
const LEGACY_TAG_ORDER_KEY = 'cfsub_tag_filter_order';
let tagOrder = [];
let tagOrderLoaded = false; // a server order has been adopted at least once
let tagOrderLoading = null; // in-flight load (single-flight)
let tagOrderSaveSeq = 0; // bumped on every local save

function loadTagOrder() {
  return tagOrder;
}

async function persistTagOrder(tags, ifEmpty) {
  const token = adminToken();
  if (!token) return null;
  try {
    const resp = await fetch('/api/tag-order', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify(ifEmpty ? { order: tags, ifEmpty: true } : { order: tags }),
    });
    const data = await resp.json().catch(() => null);
    return resp.ok && data?.ok ? data : null;
  } catch {
    return null;
  }
}

function saveTagOrder(tags) {
  tagOrder = [...tags];
  tagOrderSaveSeq++;
  // Before the first successful load there is nothing safe to write
  // against: persisting a pre-load arrangement (rendered in the
  // default order) would clobber the shared order this client has
  // never seen. Pre-load changes stay local and are superseded by
  // the first load's broadcast.
  if (!tagOrderLoaded) return;
  void persistTagOrder(tags, false).then((r) => {
    // A silent failure here is exactly the cross-device divergence
    // the server-side order exists to prevent — say so.
    if (!r && adminMsg) adminMsg.textContent = '标签顺序保存失败，请检查网络后重新加载列表';
  });
}

// Drop working-order slots for tags no entry carries. Runs at
// adoption (when the items are already in) and after each list
// render (when they were not): the order load and the list load
// race, and either may land first.
function pruneTagOrderToVocab() {
  if (!tagOrderLoaded || !adminState.items.length) return;
  const alive = new Set(allTagCounts().map((v) => v.tag.toLowerCase()));
  const pruned = tagOrder.filter((t) => alive.has(String(t).toLowerCase()));
  if (pruned.length !== tagOrder.length) {
    tagOrder = pruned;
    refreshTagVocabViews();
  }
}

// Runs alongside the admin list load: fetch the shared order, run
// the one-time legacy import if the server has none yet, then
// broadcast so every vocabulary view re-renders canonically.
// Single-flight: overlapping list loads share one fetch.
function loadTagOrderFromServer() {
  if (tagOrderLoading) return tagOrderLoading;
  tagOrderLoading = (async () => {
    try {
      const token = adminToken();
      if (!token) return;
      const seqAtStart = tagOrderSaveSeq;
      let serverOrder = null;
      try {
        const resp = await fetch('/api/tag-order', { headers: { 'x-admin-token': token } });
        const data = await resp.json().catch(() => null);
        if (resp.ok && data?.ok && Array.isArray(data.order)) serverOrder = data.order;
      } catch {}
      if (serverOrder === null) return; // unreachable: keep the last known order and retry on the next list load

      let keepLegacy = false;
      if (!serverOrder.length) {
        let legacy = [];
        try {
          const parsed = JSON.parse(localStorage.getItem(LEGACY_TAG_ORDER_KEY) || '[]');
          if (Array.isArray(parsed)) legacy = parsed.filter((t) => typeof t === 'string');
        } catch {}
        if (legacy.length) {
          const imported = await persistTagOrder(legacy, true);
          // The server's answer is authoritative either way: our
          // import, or another device's that landed first.
          if (imported && Array.isArray(imported.order)) serverOrder = imported.order;
          else if (!imported) keepLegacy = true; // import failed: keep the key so the next load retries
        }
      }
      // Imported, superseded, or empty — the legacy key has served
      // its purpose and is never read or written again. (On a failed
      // import it stays, exactly so it can be retried.)
      if (!keepLegacy) {
        try { localStorage.removeItem(LEGACY_TAG_ORDER_KEY); } catch {}
      }
      const hadLoaded = tagOrderLoaded;
      tagOrderLoaded = true;
      if (hadLoaded && tagOrderSaveSeq !== seqAtStart) {
        // A save landed while this load was in flight: the local
        // working order is newer than whatever this (possibly
        // stale) read returned — keep it; the next load confirms.
      } else {
        tagOrder = serverOrder;
        // Prune slots for tags no entry carries anymore (e.g. one
        // deleted in the window before this load landed, whose
        // prune-save was gated off); when the items have not landed
        // yet, loadAdminList prunes right after rendering instead.
        pruneTagOrderToVocab();
      }
      refreshTagVocabViews();
    } finally {
      tagOrderLoading = null;
    }
  })();
  return tagOrderLoading;
}
// The single broadcast every tag-order change goes through: ALL
// vocabulary views re-render from the one canonical order — the
// filter bar, the generate picker's suggestions, and every entry
// panel ever built, open or closed. (Panels are built once and then
// cached in the DOM, so refreshing only the visible ones left closed
// panels stale until the next full list reload.)
function refreshTagVocabViews() {
  renderTagFilterBar();
  if (genTagVocab) renderGenTagSuggestions();
  if (adminBody) {
    for (const panel of adminBody.querySelectorAll('.entry-tags-panel')) renderTagsPanel(panel);
  }
}
function setTagOrder(tags) {
  saveTagOrder(tags);
  refreshTagVocabViews();
}

// Another tab or device may have re-arranged the shared order while
// this page sat in the background. Refresh it whenever the page
// becomes visible or regains focus — a drag here always starts from
// the current base instead of silently overwriting theirs. The load
// is single-flight and its adoption is save-seq guarded, so this is
// cheap and cannot undo a save this page just made.
function refreshTagOrderOnReturn() {
  if (!tagOrderLoaded) return; // the admin list was never loaded here
  void loadTagOrderFromServer();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshTagOrderOnReturn();
});
window.addEventListener('focus', refreshTagOrderOnReturn);
// One ordering for every tag vocabulary display: the filter bar is
// the reference, and the suggestion areas (generate picker, entry
// panel) follow it — the stored custom order wins, everything else
// falls back to count, then name.
function applyTagOrder(vocab) {
  const pos = new Map(loadTagOrder().map((t, i) => [t.toLowerCase(), i]));
  return [...vocab].sort((a, b) => {
    const pa = pos.get(String(a.tag).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const pb = pos.get(String(b.tag).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN');
  });
}
function orderedTagVocab() {
  return applyTagOrder(allTagCounts());
}

function renderTagFilterBar() {
  if (!tagFilterBar || !tagFilterChips) return;
  if (tagFilterChips.classList.contains('chip-sorting')) return; // mid-drag: the drop re-renders
  const vocab = orderedTagVocab();
  const names = new Set(vocab.map((v) => v.tag.toLowerCase()));
  for (const t of [...adminState.tagSelected]) {
    if (!names.has(t.toLowerCase())) adminState.tagSelected.delete(t);
  }
  tagFilterBar.classList.toggle('hidden', vocab.length === 0);
  if (!vocab.length) return;
  const sel = selectedTagLowers();
  tagFilterChips.innerHTML = vocab
    .map((v) => `<button type="button" class="tag-chip tag-chip-filter${sel.has(String(v.tag).toLowerCase()) ? ' is-on' : ''}" data-tag-filter="${escapeHtml(v.tag)}" data-sort-value="${escapeHtml(v.tag)}" title="点按筛选；长按拖动排序，拖到左侧放开可删除">${escapeHtml(v.tag)} · ${v.count}</button>`)
    .join('');
  if (tagFilterClear) tagFilterClear.classList.toggle('hidden', adminState.tagSelected.size === 0);
  if (tagModeAndBtn) tagModeAndBtn.classList.toggle('is-active', adminState.tagMode === 'and');
  if (tagModeOrBtn) tagModeOrBtn.classList.toggle('is-active', adminState.tagMode === 'or');
}

function toggleTagFilter(tag) {
  // One selection per tag, case-insensitively: toggling any spelling of
  // an already-selected tag deselects it.
  const lower = String(tag).toLowerCase();
  const existing = [...adminState.tagSelected].find((t) => t.toLowerCase() === lower);
  if (existing) adminState.tagSelected.delete(existing);
  else adminState.tagSelected.add(tag);
  adminState.selected.clear();
  renderAdminList();
  updateAdminCount();
}

// Dragging a filter chip onto the bar's label (a bin while dragging)
// deletes that tag from EVERY entry carrying it — the vocabulary is
// derived from the entries, so there is no lesser "remove". Confirmed
// first, applied entry by entry through the regular tags endpoint,
// and any failures are named.
async function deleteTagEverywhere(tag) {
  const lower = String(tag).toLowerCase();
  const affected = adminState.items.filter((item) => (item.tags || []).some((t) => String(t).toLowerCase() === lower));
  if (!affected.length) return;
  if (!window.confirm(`确定要把标签「${tag}」从全部 ${affected.length} 条订阅上删除吗？此操作不可恢复。`)) return;
  const token = adminToken();
  await flushNoteAutosaves(affected.map((item) => item.id));
  adminMsg.textContent = `正在从 ${affected.length} 条订阅上删除标签「${tag}」…`;
  const failed = [];
  for (const item of affected) {
    const tags = (item.tags || []).filter((t) => String(t).toLowerCase() !== lower);
    try {
      const resp = await postJson('/api/tags', { id: item.id, tags, token });
      const data = await resp.json().catch(() => null);
      if (resp.ok && data?.ok) item.tags = tags;
      else failed.push(item.id);
    } catch {
      failed.push(item.id);
    }
  }
  for (const t of [...adminState.tagSelected]) {
    if (t.toLowerCase() === lower) adminState.tagSelected.delete(t);
  }
  // Prune the shared order by what ACTUALLY remains after the saves:
  // a tag whose save failed still exists on its entry and keeps its
  // slot; only tags gone from every entry lose theirs.
  const remaining = new Set(allTagCounts().map((v) => v.tag.toLowerCase()));
  saveTagOrder(loadTagOrder().filter((t) => remaining.has(t.toLowerCase())));
  const hadVocab = genTagVocab !== null;
  genTagVocab = null;
  renderAdminList();
  updateAdminCount();
  // The deleted tag also leaves every other vocabulary view; the
  // picker vocabulary refetches so its suggestions drop it too.
  refreshTagVocabViews();
  if (hadVocab) void loadGenTagVocab();
  adminMsg.textContent = failed.length
    ? `标签「${tag}」已从 ${affected.length - failed.length} 条订阅上删除；${failed.length} 条失败：${failed.join('、')}`
    : `标签「${tag}」已从全部 ${affected.length} 条订阅上删除。`;
}

if (tagFilterChips) {
  tagFilterChips.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-tag-filter]');
    if (btn) toggleTagFilter(btn.dataset.tagFilter);
  });
  makeChipsSortable(tagFilterChips, '.tag-chip', {
    onReorder: (values) => {
      setTagOrder(values);
    },
    trashEl: tagFilterBar?.querySelector('.tag-filter-label'),
    onTrash: (tag) => { void deleteTagEverywhere(tag); },
  });
}
if (adminBody) {
  adminBody.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-tag-filter]');
    if (btn) toggleTagFilter(btn.dataset.tagFilter);
  });
}
if (tagFilterClear) {
  tagFilterClear.addEventListener('click', () => {
    adminState.tagSelected.clear();
    adminState.selected.clear();
    renderAdminList();
    updateAdminCount();
  });
}
if (tagModeAndBtn) {
  tagModeAndBtn.addEventListener('click', () => {
    adminState.tagMode = 'and';
    renderAdminList();
    updateAdminCount();
  });
}
if (tagModeOrBtn) {
  tagModeOrBtn.addEventListener('click', () => {
    adminState.tagMode = 'or';
    renderAdminList();
    updateAdminCount();
  });
}

function retentionDaysText(st) {
  // Days reach innerHTML in the retention cell/panel: coerce to a plain
  // number so even a hand-corrupted record cannot inject markup there.
  const n = Number(st && st.days);
  return Number.isFinite(n) ? String(n) : '?';
}

// One guarded formatter for every date the admin list prints: a
// hand-corrupted record must show a placeholder, never the literal
// text "Invalid Date".
function fmtDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN', { hour12: false });
}

function retentionHtml(item) {
  const st = item.storage || { mode: 'permanent' };
  return st.mode === 'days'
    ? `${retentionDaysText(st)} 天后删除<br><span class="hint">${st.expiresAt ? '到期：' + fmtDateTime(st.expiresAt) : ''}</span>`
    : '永久';
}

function renderAdminList() {
  renderTagFilterBar();
  adminItems.clear();
  adminState.items.forEach((item) => adminItems.set(item.id, item));
  for (const id of [...adminState.selected]) {
    if (!adminItems.has(id)) adminState.selected.delete(id);
  }
  if (!adminState.items.length) {
    adminBody.innerHTML = '<div class="admin-empty">KV 里还没有任何条目。</div>';
    updateSelectionUI();
    return;
  }
  const visible = visibleAdminItems();
  if (!visible.length) {
    adminBody.innerHTML = '<div class="admin-empty">没有符合搜索条件的条目。</div>';
    updateSelectionUI();
    return;
  }
  adminBody.innerHTML = visible
    .map((item) => {
      const created = fmtDateTime(item.createdAt);
      const retention = retentionHtml(item);
      return `<div class="entry" data-id="${escapeHtml(item.id)}">
        <div class="entry-row">
          <div class="cell"><input type="checkbox" class="entry-check" aria-label="选择这条" ${adminState.selected.has(item.id) ? 'checked' : ''} /></div>
          <div class="cell note-cell"><textarea class="note-input" maxlength="80" rows="4" placeholder="（未填备注）">${escapeHtml(item.note || '')}</textarea><div class="note-save-status" role="status" aria-live="polite"></div>${entryTagsHtml(item)}</div>
          <div class="cell">${escapeHtml(created)}</div>
          <div class="cell">${retention}</div>
          <div class="cell">${escapeHtml((item.sources || []).join(', ') || '-')}${item.dynamic ? `<br><span class="hint">动态订阅 · ${item.sourceCount > 1 ? `${item.sourceCount} 个来源跟随更新` : '跟随来源更新'}</span>` : ''}</div>
          <div class="cell">${item.outputNodes ?? '-'}</div>
          <div class="cell">
            <div class="admin-actions">
              <button type="button" class="secondary small" data-admin-action="links">链接</button>
              <button type="button" class="secondary small" data-admin-action="tags">标签</button>
              <button type="button" class="secondary small" data-admin-action="retention">修改有效期</button>
              <button type="button" class="secondary small" data-admin-action="delete">删除</button>
              <button type="button" class="secondary small span-all" data-admin-action="backfill">回填到生成区</button>
            </div>
          </div>
        </div>
      </div>`;
    })
    .join('');
  updateSelectionUI();
}

let adminListLoadSeq = 0;
async function loadAdminList() {
  const token = adminToken();
  if (!token) {
    adminMsg.textContent = '请先填入 SUB_ACCESS_TOKEN。';
    return;
  }
  // Overlapping loads (double-click, reload races) resolve in network
  // order, not request order: without a sequence guard a slow older
  // response lands last and silently reverts the list to stale data.
  const seq = ++adminListLoadSeq;
  storageSet('sessionStorage', 'cfsub_admin_token', token);
  adminMsg.textContent = '加载中...';
  // The shared tag order loads in parallel; when it lands it
  // broadcasts, re-rendering every vocabulary view canonically.
  void loadTagOrderFromServer();
  try {
    // The admin token travels in a header, never in the URL.
    const resp = await fetch('/api/list', { headers: { 'x-admin-token': token } });
    const data = await resp.json().catch(() => null);
    if (seq !== adminListLoadSeq) return; // a newer load superseded this one
    if (!resp.ok || !data || !data.ok) throw new Error((data && data.error) || '加载失败');
    adminState.items = data.items || [];
    // Ingestion boundary: whatever the server (or a future regression
    // in it) sends, an item's tags are a string array by the time any
    // renderer or counter touches them — a non-array tags field used
    // to take down the whole list render and the diagnostics export.
    for (const item of adminState.items) {
      item.tags = Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [];
    }
    adminState.selected.clear();
    renderAdminList();
    pruneTagOrderToVocab();
    updateAdminCount();
  } catch (e) {
    if (seq !== adminListLoadSeq) return; // superseded; the newer load owns the message
    adminMsg.textContent = e.message || '加载失败';
  }
}

if (listBtn) listBtn.addEventListener('click', loadAdminList);
if (sortSelect) {
  sortSelect.addEventListener('change', () => {
    adminState.sort = sortSelect.value;
    adminState.selected.clear();
    renderAdminList();
  });
}
if (adminSearchInput) {
  adminSearchInput.addEventListener('input', () => {
    adminState.query = adminSearchInput.value;
    adminState.selected.clear();
    renderAdminList();
    updateAdminCount();
  });
}
if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener('change', () => {
    const visible = visibleAdminItems();
    if (selectAllCheckbox.checked) visible.forEach((i) => adminState.selected.add(i.id));
    else visible.forEach((i) => adminState.selected.delete(i.id));
    renderAdminList();
  });
}
if (deleteSelectedBtn) {
  deleteSelectedBtn.addEventListener('click', async () => {
    const token = adminToken();
    if (!token) return;
    const ids = visibleAdminItems().filter((i) => adminState.selected.has(i.id)).map((i) => i.id);
    if (!ids.length) return;
    if (!confirm(`确定删除选中的 ${ids.length} 条订阅吗？删除后它们的链接会立刻失效。`)) return;
    deleteSelectedBtn.disabled = true;
    await settleNoteAutosaves(ids);
    let done = 0;
    const failed = [];
    for (let k = 0; k < ids.length; k++) {
      deleteSelectedBtn.textContent = `删除中 ${k + 1}/${ids.length}…`;
      const id = ids[k];
      let data = null;
      try {
        const resp = await postJson('/api/delete', { id, token });
        data = await resp.json().catch(() => null);
      } catch (e) {
        data = null;
      }
      if (data && data.ok) {
        // Same rule as single delete: only a server-confirmed delete
        // removes the entry locally.
        done++;
        adminState.items = adminState.items.filter((i) => i.id !== id);
        adminItems.delete(id);
        noteSaveStates.delete(id);
        adminState.selected.delete(id);
      } else {
        failed.push(id);
      }
    }
    renderAdminList();
    adminMsg.textContent = failed.length
      ? `已删除 ${done} 条；${failed.length} 条删除失败，已保留：${failed.join('、')}`
      : `已删除选中的 ${done} 条。共 ${adminState.items.length} 条。`;
  });
}

function detailCard(prefix, key, icon, title, desc, url, wide = false) {
  const inputId = `${prefix}-${key}`;
  return `<article class="sub-card${wide ? ' sub-card-wide' : ''}">
    <div class="sub-card-head">
      <div class="client-meta">
        <div class="client-icon"><img src="/icons/${icon}" alt="${escapeHtml(title)}" /></div>
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(desc)}</p>
        </div>
      </div>
    </div>
    <div class="sub-actions">
      <input id="${inputId}" readonly value="${escapeHtml(url)}" />
      <button data-copy-target="${inputId}" type="button" class="secondary small">复制</button>
      <button data-qrcode-target="${inputId}" type="button" class="secondary small">二维码</button>
    </div>
  </article>`;
}

function buildDetail(item) {
  // The prefix lands UNESCAPED in id attributes below; entry ids are
  // minted alphanumeric, and stripping anything else keeps even a
  // hand-crafted KV key from breaking out of those attributes.
  const prefix = `d-${String(item.id).replace(/[^\w-]/g, '')}`;
  const linkToken = item.linkToken || '';
  const detail = document.createElement('div');
  detail.className = 'entry-detail';
  detail.innerHTML = `
    <div class="sub-grid">
      ${detailCard(prefix, 'auto', 'auto.svg', '自动识别', '适合支持自动识别的客户端', subUrlFor(item.id, '', linkToken))}
      ${detailCard(prefix, 'raw', 'v2rayn.svg', 'V2rayN', '适用于 V2rayN / v2rayNG', subUrlFor(item.id, 'raw', linkToken))}
      ${detailCard(prefix, 'clash', 'clash.svg', 'Clash', '适用于 Clash / Mihomo / Clash Verge', subUrlFor(item.id, 'clash', linkToken))}
      ${detailCard(prefix, 'rocket', 'shadowrocket.svg', 'Shadowrocket', '适用于 iPhone / iPad 小火箭', subUrlFor(item.id, 'raw', linkToken))}
      ${detailCard(prefix, 'plain', 'auto.svg', '明文链接', '逐行明文节点链接（非 Base64），打开即可看/复制', subUrlFor(item.id, 'plain', linkToken))}
      ${detailCard(prefix, 'surge', 'surge.svg', 'Surge', '适用于 Surge Profile 导入', subUrlFor(item.id, 'surge', linkToken), true)}
    </div>
    <h3>明文节点链接（一行一个，可整段复制）</h3>
    <textarea id="${prefix}-plainText" rows="6" readonly placeholder="正在加载明文链接..."></textarea>
    <div class="actions">
      <button data-copy-target="${prefix}-plainText" type="button" class="secondary small">复制全部明文链接</button>
    </div>`;
  return detail;
}

async function loadPlainOnce(detail, item) {
  if (detail.dataset.plainLoaded) return;
  detail.dataset.plainLoaded = '1';
  const box = detail.querySelector('textarea');
  try {
    const resp = await fetch(subUrlFor(item.id, 'plain', item.linkToken || ''));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    box.value = await resp.text();
  } catch (e) {
    box.value = '';
    box.placeholder = `明文链接加载失败：${e.message || e}`;
  }
}

async function setDetail(entry, expand) {
  const item = adminItems.get(entry?.dataset.id || '');
  if (!entry || !item) return;
  const btn = entry.querySelector('[data-admin-action="links"]');
  let detail = entry.querySelector('.entry-detail');
  if (expand) {
    if (!detail) {
      detail = buildDetail(item);
      entry.appendChild(detail);
    }
    detail.classList.remove('hidden');
    entry.classList.add('expanded');
    if (btn) btn.textContent = '收起';
    await loadPlainOnce(detail, item);
  } else {
    if (detail) detail.classList.add('hidden');
    entry.classList.remove('expanded');
    if (btn) btn.textContent = '链接';
  }
}

if (expandAllBtn) {
  expandAllBtn.addEventListener('click', async () => {
    for (const entry of adminBody.querySelectorAll('.entry')) {
      await setDetail(entry, true);
      openRetentionPanel(entry);
      openTagsPanel(entry);
    }
  });
}
if (collapseAllBtn) {
  collapseAllBtn.addEventListener('click', async () => {
    for (const entry of adminBody.querySelectorAll('.entry')) {
      await setDetail(entry, false);
      closeRetentionPanel(entry);
      closeTagsPanel(entry);
    }
  });
}

// Read-back verification must use the direct entry read, NOT /api/list:
// KV's list index lags behind fresh writes and caused false failures.
async function pollEntry(id, token, predicate) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const { resp, data: entry } = await fetchEntry(id, token);
      if (!resp.ok || !entry) continue;
      if (entry.ok && predicate(entry)) return entry;
    } catch {}
  }
  return null;
}

// ---------------- Note autosave ----------------
// Notes save themselves: a short pause after typing (or leaving the
// field) posts the new note, and only the direct KV read-back may show
// the success note. Saves for one entry are serialized — typing during
// a save queues the newest text instead of racing the in-flight write.
const noteSaveStates = new Map();

// The server's sanitizeNote, mirrored: dirty checks must compare the
// text as it will be STORED, not the raw box contents — otherwise a
// note containing a newline or edge spaces (easy to paste into the
// multi-line box) never compares equal to its stored form and every
// blur would re-post the identical note forever.
function normalizeNoteText(value) {
  const collapsed = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 80);
  const c = collapsed.charCodeAt(collapsed.length - 1);
  return c >= 0xd800 && c <= 0xdbff ? collapsed.slice(0, -1) : collapsed;
}

function noteSaveState(id) {
  let state = noteSaveStates.get(id);
  if (!state) {
    state = {
      timer: null,
      statusTimer: null,
      statusSeq: 0,
      saving: false,
      pendingValue: null,
      composing: false,
      finishOnCompositionEnd: false,
      promise: null,
    };
    noteSaveStates.set(id, state);
  }
  return state;
}

function noteEntryElement(id) {
  return [...adminBody.querySelectorAll('.entry')].find((entry) => entry.dataset.id === id) || null;
}

function setNoteSaveStatus(id, text, state = '', transientMs = 0) {
  const saveState = noteSaveState(id);
  const seq = ++saveState.statusSeq;
  if (saveState.statusTimer) {
    clearTimeout(saveState.statusTimer);
    saveState.statusTimer = null;
  }
  const el = noteEntryElement(id)?.querySelector('.note-save-status');
  if (el) {
    el.textContent = text;
    if (state) el.dataset.state = state;
    else delete el.dataset.state;
    el.classList.toggle('is-visible', !!text);
  }
  if (transientMs) {
    saveState.statusTimer = setTimeout(() => {
      if (saveState.statusSeq !== seq) return;
      const current = noteEntryElement(id)?.querySelector('.note-save-status');
      if (current) {
        current.textContent = '';
        delete current.dataset.state;
        current.classList.remove('is-visible');
      }
    }, transientMs);
  }
}

function requestNoteSave(id, value) {
  value = normalizeNoteText(value);
  const saveState = noteSaveState(id);
  const item = adminItems.get(id);
  if (!item) return Promise.resolve(false);
  if (value === item.note) {
    if (!saveState.saving) setNoteSaveStatus(id, '');
    return Promise.resolve(true);
  }
  if (saveState.saving) {
    saveState.pendingValue = value;
    setNoteSaveStatus(id, '输入完成后自动保存', 'pending');
    return saveState.promise;
  }

  saveState.saving = true;
  saveState.promise = (async () => {
    let valueToSave = value;
    let anySaved = false;
    while (valueToSave !== null) {
      const savingValue = valueToSave;
      valueToSave = null;
      saveState.pendingValue = null;
      const currentItem = adminItems.get(id);
      if (!currentItem) break;
      if (savingValue === currentItem.note) continue;
      const previousNote = currentItem.note || '';
      setNoteSaveStatus(id, '正在保存备注…', 'saving');
      let postOk = false;
      let verified = false;
      let savedNote = savingValue;
      let errMsg = '';
      try {
        const token = adminToken();
        const resp = await postJson('/api/note', { id, note: savingValue, token });
        const data = await resp.json().catch(() => null);
        if (resp.ok && data?.ok) {
          postOk = true;
          savedNote = typeof data.note === 'string' ? data.note : savingValue;
          // Verify against KV itself via the direct record read, never
          // the lagging list (the rule the old save button followed).
          verified = !!(await pollEntry(id, token, (entry) => (entry.note || '') === savedNote));
        } else {
          errMsg = (data && data.error) || '保存失败';
        }
      } catch (e) {
        postOk = false;
      }
      const latestItem = adminItems.get(id);
      if (!latestItem) break;
      if (postOk) {
        // The server acknowledged the write, so the note IS stored —
        // even when the read-back could not confirm it in time. Only
        // the wording differs: green success is reserved for a verified
        // read-back; an unverified save says so instead of crying failure.
        latestItem.note = savedNote;
        anySaved = true;
        // If the list re-rendered during the save, bring a stale,
        // unfocused editor up to date without disturbing active typing.
        const box = noteEntryElement(id)?.querySelector('.note-input');
        if (box && document.activeElement !== box && box.value === previousNote) box.value = savedNote;
        if (saveState.pendingValue !== null && saveState.pendingValue !== savedNote) {
          valueToSave = saveState.pendingValue;
          saveState.pendingValue = null;
          setNoteSaveStatus(id, '输入完成后自动保存', 'pending');
        } else if (verified) {
          saveState.pendingValue = null;
          setNoteSaveStatus(id, '备注保存成功', 'ok', 1500);
        } else {
          saveState.pendingValue = null;
          setNoteSaveStatus(id, '备注已保存，待刷新确认', 'warn', 2500);
        }
      } else if (saveState.pendingValue !== null && saveState.pendingValue !== savingValue) {
        valueToSave = saveState.pendingValue;
        saveState.pendingValue = null;
      } else {
        saveState.pendingValue = null;
        setNoteSaveStatus(id, errMsg ? `备注保存失败：${errMsg}` : '备注保存失败，请重试', 'fail', 2500);
      }
    }
    saveState.saving = false;
    saveState.promise = null;
    return anySaved;
  })();
  return saveState.promise;
}

function scheduleNoteAutosave(box, delay = 900) {
  const entry = box.closest('.entry');
  const id = entry?.dataset.id;
  if (!id) return;
  const saveState = noteSaveState(id);
  if (saveState.composing) return;
  if (saveState.timer) clearTimeout(saveState.timer);
  saveState.timer = null;
  const item = adminItems.get(id);
  if (!item) return;
  if (normalizeNoteText(box.value) === item.note && !saveState.saving) {
    setNoteSaveStatus(id, '');
    return;
  }
  setNoteSaveStatus(id, '输入完成后自动保存', 'pending');
  saveState.timer = setTimeout(() => {
    saveState.timer = null;
    requestNoteSave(id, box.value);
  }, delay);
}

function finishNoteInput(box) {
  const entry = box.closest('.entry');
  const id = entry?.dataset.id;
  if (!id) return;
  const saveState = noteSaveState(id);
  if (saveState.composing) {
    saveState.finishOnCompositionEnd = true;
    return;
  }
  if (saveState.timer) {
    clearTimeout(saveState.timer);
    saveState.timer = null;
  }
  requestNoteSave(id, box.value);
}

function cancelNoteAutosave(id) {
  const saveState = noteSaveStates.get(id);
  if (!saveState) return;
  if (saveState.timer) clearTimeout(saveState.timer);
  saveState.timer = null;
  saveState.pendingValue = null;
  saveState.finishOnCompositionEnd = false;
}

// Deletes must not race a note write: cancel queued saves and let an
// in-flight one land before the record is removed, so its putRecord
// can never resurrect a just-deleted entry.
async function settleNoteAutosaves(ids) {
  ids.forEach(cancelNoteAutosave);
  await Promise.all(ids.map((id) => noteSaveStates.get(id)?.promise).filter(Boolean).map((p) => p.catch(() => {})));
}

// A queued autosave lives in a ~0.9s timer: closing the tab (or the
// OS killing a backgrounded mobile tab) inside that window used to
// drop the last edit silently, despite the 自动保存 promise. On
// pagehide, fire every unsaved note change immediately with
// keepalive so the request outlives the page. Read-back verification
// is skipped — landing the write is what counts here.
window.addEventListener('pagehide', () => {
  if (!adminBody) return;
  const token = adminToken();
  if (!token) return;
  for (const entry of adminBody.querySelectorAll('.entry')) {
    const id = entry.dataset.id;
    const box = entry.querySelector('.note-input');
    if (!id || !box) continue;
    const item = adminItems.get(id);
    if (!item) continue;
    const value = normalizeNoteText(box.value);
    if (value === (item.note || '')) continue;
    try {
      fetch('/api/note', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, note: value, token }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* the page is going away; nothing more can be done */ }
  }
});

// Tags/retention saves rewrite the SAME record the note autosave
// writes, and every handler puts the whole record from its own read:
// an autosave landing mid-save reverts the other field (possibly
// after the UI already showed success). Flush instead of cancel —
// fire a queued autosave now with the input's current value, then
// await the chain — so the writes serialize. (Deletes deliberately
// use settleNoteAutosaves: there the queued save is dropped because
// the entry is going away.)
async function flushNoteAutosaves(ids) {
  for (const id of ids) {
    const saveState = noteSaveStates.get(id);
    if (!saveState || !saveState.timer) continue;
    clearTimeout(saveState.timer);
    saveState.timer = null;
    const entry = [...adminBody.querySelectorAll('.entry')].find((el) => el.dataset.id === id);
    const box = entry?.querySelector('.note-input');
    if (box) requestNoteSave(id, box.value);
  }
  await Promise.all(ids.map((id) => noteSaveStates.get(id)?.promise).filter(Boolean).map((p) => p.catch(() => {})));
}

if (adminBody) {
  adminBody.addEventListener('input', (event) => {
    const box = event.target.closest?.('.note-input');
    if (box) scheduleNoteAutosave(box);
  });
  adminBody.addEventListener('focusout', (event) => {
    const box = event.target.closest?.('.note-input');
    if (box) finishNoteInput(box);
  });
  adminBody.addEventListener('compositionstart', (event) => {
    const box = event.target.closest?.('.note-input');
    if (!box) return;
    const saveState = noteSaveState(box.closest('.entry')?.dataset.id || '');
    saveState.composing = true;
    if (saveState.timer) {
      clearTimeout(saveState.timer);
      saveState.timer = null;
    }
  });
  adminBody.addEventListener('compositionend', (event) => {
    const box = event.target.closest?.('.note-input');
    if (!box) return;
    const saveState = noteSaveState(box.closest('.entry')?.dataset.id || '');
    saveState.composing = false;
    if (saveState.finishOnCompositionEnd) {
      saveState.finishOnCompositionEnd = false;
      finishNoteInput(box);
    } else {
      scheduleNoteAutosave(box, 500);
    }
  });
}

// Load an entry's stored inputs back into the generate form for editing.
// Regenerating afterwards follows the usual rules: changed content makes a
// new entry, unchanged content refreshes the same entry.
function fillGenerateForm(bf) {
  const setValue = (id, value) => {
    const el = byId(id);
    if (el) el.value = value ?? '';
  };
  setValue('nodeLinks', bf.nodeLinks);
  // Into the one mixed box: mixed entries restore their box verbatim;
  // a legacy api entry becomes its single source line (its snapshot
  // endpoints stay visible in the entry's expanded link cards).
  if (bf.ipMode === 'api' && bf.sourceUrl) setValue('preferredIps', bf.sourceUrl);
  else setValue('preferredIps', bf.preferredIps);
  if (bf.sourceLimit) setValue('ipSourceLimit', bf.sourceLimit);
  setValue('namePrefix', bf.namePrefix);
  const keep = byId('keepOriginalHost');
  if (keep) keep.checked = bf.keepOriginalHost !== false;
  setValue('subNote', bf.note);
  setGenTags(bf.tags, Array.isArray(bf.tags));
  const mode = byId('storageMode');
  if (mode) {
    mode.value = bf.storage?.mode === 'days' ? 'days' : 'permanent';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (bf.storage?.mode === 'days' && bf.storage.days) setValue('retentionDays', bf.storage.days);
  if (typeof form.scrollIntoView === 'function') {
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-admin-action]');
  if (!btn) return;
  const entry = btn.closest('.entry');
  const id = entry?.dataset.id;
  const token = adminToken();
  if (!id || !token) return;
  const action = btn.dataset.adminAction;

  if (action === 'backfill') {
    btn.disabled = true;
    try {
      const { resp, data } = await fetchEntry(id, token);
      if (!resp.ok || !data?.ok) throw new Error((data && data.error) || '回填失败，请重试');
      if (!data.backfill) throw new Error('这条记录缺少可还原的数据，无法回填');
      fillGenerateForm(data.backfill);
      adminMsg.textContent = data.backfill.exact
        ? `条目 ${id} 已回填到生成区，修改后点「生成订阅」即可。`
        : `条目 ${id} 已按已存数据还原并回填到生成区（老条目，可能与原始输入略有差异），修改后点「生成订阅」即可。`;
    } catch (err) {
      adminMsg.textContent = err.message || '回填失败，请重试';
    } finally {
      btn.disabled = false;
    }
    return;
  }
  if (action === 'retention') {
    toggleRetentionPanel(entry);
    return;
  }
  if (action === 'tags') {
    toggleTagsPanel(entry);
    return;
  }
  if (action === 'links') {
    await setDetail(entry, !entry.classList.contains('expanded'));
    return;
  }
  if (action === 'delete') {
    const note = entry.querySelector('.note-input')?.value || id;
    if (!confirm(`确定删除条目「${note}」吗？删除后它的订阅链接会立刻失效。`)) return;
    await settleNoteAutosaves([id]);
    let data = null;
    try {
      const resp = await postJson('/api/delete', { id, token });
      data = await resp.json();
    } catch (e) {
      data = null; // network failure / non-JSON error page: treat as failure
    }
    if (data && data.ok) {
      // Remove the row locally at once: the entry is already gone from KV,
      // and waiting for a list refresh lets the lagging KV list index keep
      // showing it until the next manual reload.
      adminState.items = adminState.items.filter((i) => i.id !== id);
      adminItems.delete(id);
      noteSaveStates.delete(id);
      renderAdminList();
      adminMsg.textContent = `条目 ${id} 已删除。共 ${adminState.items.length} 条。`;
    } else {
      // The row is only ever removed after the server confirms the delete;
      // any failure (server error or network) keeps the row and says so.
      adminMsg.textContent = (data && data.error) || '删除失败，请重试';
    }
  }
});

// ---------------- Retention edit panel (scheme 1: inline) ----------------
function buildRetentionPanel(item) {
  const st = item.storage || { mode: 'permanent' };
  const panel = document.createElement('div');
  panel.className = 'entry-retention hidden';
  const current = st.mode === 'days'
    ? `${retentionDaysText(st)} 天后删除${st.expiresAt ? '（到期：' + fmtDateTime(st.expiresAt) + '）' : ''}`
    : '永久保存';
  panel.innerHTML = `
    <div class="ret-current">当前有效期：<strong>${escapeHtml(current)}</strong></div>
    <div class="ret-controls">
      <label>改为
        <select class="ret-mode">
          <option value="permanent"${st.mode !== 'days' ? ' selected' : ''}>永久保存（手动删除为止）</option>
          <option value="days"${st.mode === 'days' ? ' selected' : ''}>自定义天数后自动删除</option>
        </select>
      </label>
      <label>天数
        <input class="ret-days" type="number" min="1" max="3650" step="1" value="${st.mode === 'days' && Number.isFinite(Number(st.days)) ? Number(st.days) : 30}"${st.mode !== 'days' ? ' disabled' : ''} />
      </label>
      <button type="button" class="secondary small" data-ret-save>保存有效期</button>
      <button type="button" class="secondary small" data-ret-cancel>取消</button>
    </div>
    <p class="hint">选“自定义天数”会从保存这一刻起重新计时；选“永久保存”会去掉过期时间。</p>`;
  return panel;
}

function openRetentionPanel(entry) {
  const item = adminItems.get(entry?.dataset.id || '');
  if (!entry || !item) return;
  let panel = entry.querySelector('.entry-retention');
  if (!panel) {
    panel = buildRetentionPanel(item);
    entry.querySelector('.entry-row').after(panel);
  }
  panel.classList.remove('hidden');
  entry.classList.add('retention-open');
  const btn = entry.querySelector('[data-admin-action="retention"]');
  if (btn) btn.textContent = '收起';
}

function toggleRetentionPanel(entry) {
  const panel = entry?.querySelector('.entry-retention');
  if (panel && !panel.classList.contains('hidden')) closeRetentionPanel(entry);
  else openRetentionPanel(entry);
}

function closeRetentionPanel(entry) {
  const panel = entry?.querySelector('.entry-retention');
  if (panel) panel.classList.add('hidden');
  entry?.classList.remove('retention-open');
  const btn = entry?.querySelector('[data-admin-action="retention"]');
  if (btn) btn.textContent = '修改有效期';
}

document.addEventListener('change', (event) => {
  const check = event.target.closest?.('.entry-check');
  if (check) {
    const entry = check.closest('.entry');
    const id = entry?.dataset.id;
    if (id) {
      if (check.checked) adminState.selected.add(id);
      else adminState.selected.delete(id);
      updateSelectionUI();
    }
    return;
  }
  const sel = event.target.closest?.('.ret-mode');
  if (!sel) return;
  const panel = sel.closest('.entry-retention');
  const days = panel?.querySelector('.ret-days');
  if (days) days.disabled = sel.value !== 'days';
});

document.addEventListener('click', async (event) => {
  const cancelBtn = event.target.closest('[data-ret-cancel]');
  if (cancelBtn) {
    closeRetentionPanel(cancelBtn.closest('.entry'));
    return;
  }
  const saveBtn = event.target.closest('[data-ret-save]');
  if (!saveBtn) return;
  const entry = saveBtn.closest('.entry');
  const id = entry?.dataset.id;
  const token = adminToken();
  if (!entry || !id || !token) return;
  const panel = entry.querySelector('.entry-retention');
  const mode = panel.querySelector('.ret-mode')?.value || 'permanent';
  const days = Number(panel.querySelector('.ret-days')?.value);
  await flushNoteAutosaves([id]);
  saveBtn.disabled = true;
  saveBtn.removeAttribute('data-save-state');
  saveBtn.textContent = '保存中…';
  let ok = false;
  let newStorage = null;
  try {
    const resp = await postJson('/api/retention', { id, token, mode, days: mode === 'days' ? days : undefined });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      newStorage = data.storage;
      // Verify against KV via a direct record read, same as the note save.
      const verified = await pollEntry(id, token, (e) => e.storage && e.storage.mode === mode
        && (mode !== 'days' || (e.storage.days === days && !!e.storage.expiresAt)));
      if (verified) {
        ok = true;
        newStorage = verified.storage;
      }
    } else {
      adminMsg.textContent = data.error || '修改有效期失败';
    }
  } catch (e) {
    ok = false;
  }
  saveBtn.textContent = ok ? '成功' : '失败';
  saveBtn.dataset.saveState = ok ? 'ok' : 'fail';
  if (ok) {
    adminMsg.textContent = `条目 ${id} 的有效期已更新并在 KV 中确认。`;
    const item = adminItems.get(id);
    if (item && newStorage) item.storage = newStorage;
    const cells = entry.querySelectorAll('.entry-row .cell');
    if (item && cells[3]) cells[3].innerHTML = retentionHtml(item);
  } else if (!adminMsg.textContent || adminMsg.textContent.startsWith('共 ')) {
    adminMsg.textContent = `条目 ${id} 的有效期未能确认修改，请重试。`;
  }
  setTimeout(() => {
    saveBtn.textContent = '保存有效期';
    saveBtn.disabled = false;
    saveBtn.removeAttribute('data-save-state');
    if (ok) closeRetentionPanel(entry);
  }, 1500);
});

// ---------------- Entry tags edit panel (inline, mirrors retention) ----------------
function renderTagsPanel(panel) {
  const chips = panel.querySelector('.tags-edit-chips');
  // Never rebuild a chip list mid-drag: the drag's placeholder and
  // hit-testing live in that DOM. The drop itself broadcasts, which
  // re-renders everything right after.
  if (chips && !chips.classList.contains('chip-sorting')) {
    chips.innerHTML = panel._tags.length
      ? panel._tags.map((t, i) => `<span class="tag-chip" data-sort-value="${escapeHtml(t)}">${escapeHtml(t)}<button type="button" class="tag-chip-x" data-tags-remove="${i}" aria-label="移除标签 ${escapeHtml(t)}">×</button></span>`).join('')
      : '<span class="hint">暂无标签</span>';
  }
  const sugg = panel.querySelector('.tags-edit-suggest');
  if (sugg) {
    const vocab = orderedTagVocab().filter((v) => !panel._tags.some((t) => t.toLowerCase() === v.tag.toLowerCase()));
    sugg.innerHTML = vocab
      .map((v) => `<button type="button" class="tag-chip tag-chip-pick" data-tags-pick="${escapeHtml(v.tag)}">${escapeHtml(v.tag)} · ${v.count}</button>`)
      .join('');
  }
}

function buildTagsPanel(item) {
  const panel = document.createElement('div');
  panel.className = 'entry-tags-panel hidden';
  panel.innerHTML = `
    <div class="tags-edit-chips tag-chips"></div>
    <div class="ret-controls">
      <input class="tags-edit-input" type="text" placeholder="输入新标签，回车或点「添加」" />
      <button type="button" class="secondary small" data-tags-add>添加</button>
      <button type="button" class="secondary small" data-tags-save>保存</button>
      <button type="button" class="secondary small" data-tags-cancel>取消</button>
    </div>
    <div class="tags-edit-suggest tag-suggestions"></div>
    <p class="hint">每条最多 10 个标签，单个最长 24 字；点下方已有标签可直接选用，长按标签可拖动排序。保存后会回读 KV 确认。</p>`;
  // Same boundary rule as the picker: only strings enter the draft.
  panel._tags = (Array.isArray(item.tags) ? item.tags : []).filter((t) => typeof t === 'string');
  renderTagsPanel(panel);
  makeChipsSortable(panel.querySelector('.tags-edit-chips'), '.tag-chip', {
    onReorder: (values) => {
      panel._tags = values;
      renderTagsPanel(panel);
    },
  });
  return panel;
}

function openTagsPanel(entry) {
  const item = adminItems.get(entry?.dataset.id || '');
  if (!entry || !item) return;
  let panel = entry.querySelector('.entry-tags-panel');
  if (!panel) {
    panel = buildTagsPanel(item);
    entry.querySelector('.entry-row').after(panel);
  }
  panel.classList.remove('hidden');
  entry.classList.add('tags-open');
  const btn = entry.querySelector('[data-admin-action="tags"]');
  if (btn) btn.textContent = '收起';
}

function closeTagsPanel(entry) {
  const panel = entry?.querySelector('.entry-tags-panel');
  if (panel) panel.classList.add('hidden');
  entry?.classList.remove('tags-open');
  const btn = entry?.querySelector('[data-admin-action="tags"]');
  if (btn) btn.textContent = '标签';
}

function toggleTagsPanel(entry) {
  const panel = entry?.querySelector('.entry-tags-panel');
  if (panel && !panel.classList.contains('hidden')) closeTagsPanel(entry);
  else openTagsPanel(entry);
}

function addTagToPanel(panel, raw) {
  const tag = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  if (!tag || panel._tags.length >= 10) return;
  if (panel._tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
  panel._tags.push(tag);
  renderTagsPanel(panel);
}

document.addEventListener('keydown', (event) => {
  if (event.isComposing) return; // IME candidate confirmation, not "add"
  const input = event.target.closest?.('.tags-edit-input');
  if (!input || event.key !== 'Enter') return;
  event.preventDefault();
  const panel = input.closest('.entry-tags-panel');
  if (panel) {
    addTagToPanel(panel, input.value);
    input.value = '';
  }
});

document.addEventListener('click', async (event) => {
  const panel = event.target.closest?.('.entry-tags-panel');
  if (!panel) return;
  const entry = event.target.closest('.entry');
  if (!entry) return;

  const removeBtn = event.target.closest('[data-tags-remove]');
  if (removeBtn) {
    panel._tags.splice(Number(removeBtn.dataset.tagsRemove), 1);
    renderTagsPanel(panel);
    return;
  }
  const pickBtn = event.target.closest('[data-tags-pick]');
  if (pickBtn) {
    addTagToPanel(panel, pickBtn.dataset.tagsPick);
    return;
  }
  const addBtn = event.target.closest('[data-tags-add]');
  if (addBtn) {
    const input = panel.querySelector('.tags-edit-input');
    if (input) {
      addTagToPanel(panel, input.value);
      input.value = '';
    }
    return;
  }
  if (event.target.closest('[data-tags-cancel]')) {
    closeTagsPanel(entry);
    return;
  }
  const saveBtn = event.target.closest('[data-tags-save]');
  if (!saveBtn) return;
  const id = entry.dataset.id;
  const token = adminToken();
  if (!id || !token) return;
  await flushNoteAutosaves([id]);
  saveBtn.disabled = true;
  saveBtn.removeAttribute('data-save-state');
  saveBtn.textContent = '保存中…';
  let ok = false;
  let stored = null;
  try {
    const resp = await postJson('/api/tags', { id, tags: panel._tags, token });
    const data = await resp.json();
    if (resp.ok && data.ok && Array.isArray(data.tags)) {
      // Verify against KV via a direct record read, same as note/retention.
      const verified = await pollEntry(id, token, (e) => Array.isArray(e.tags)
        && e.tags.length === data.tags.length
        && e.tags.every((t, i) => t === data.tags[i]));
      if (verified) {
        ok = true;
        stored = verified.tags;
      }
    } else {
      adminMsg.textContent = (data && data.error) || '保存标签失败';
    }
  } catch (e) {
    ok = false;
  }
  saveBtn.textContent = ok ? '成功' : '失败';
  saveBtn.dataset.saveState = ok ? 'ok' : 'fail';
  if (ok) {
    const item = adminItems.get(id);
    if (item) item.tags = stored;
    genTagVocab = null; // the generate picker must offer the new tags too
    adminMsg.textContent = `条目 ${id} 的标签已保存并在 KV 中确认。`;
  } else if (!adminMsg.textContent || adminMsg.textContent.startsWith('共 ')) {
    adminMsg.textContent = `条目 ${id} 的标签未能确认保存，请重试。`;
  }
  setTimeout(() => {
    saveBtn.textContent = '保存';
    saveBtn.disabled = false;
    saveBtn.removeAttribute('data-save-state');
    if (ok) {
      closeTagsPanel(entry);
      renderAdminList();
      updateAdminCount();
    }
  }, 1500);
});

// ---------------- Back to top ----------------
const backTopBtn = byId('backTopBtn');
if (backTopBtn) {
  const onScroll = () => {
    backTopBtn.classList.toggle('show', window.scrollY > 400);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  backTopBtn.addEventListener('click', () => {
    const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  });
}

// ------------- Quick nav: liquid-glass section dock -------------
const quickNavBtns = Array.from(document.querySelectorAll('.quick-nav'));
if (quickNavBtns.length) {
  const quickSections = quickNavBtns
    .map((btn) => byId(btn.dataset.target))
    .filter(Boolean);
  const setActiveQuickNav = (id) => {
    quickNavBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.target === id));
  };
  quickNavBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = byId(btn.dataset.target);
      if (!target) return;
      setActiveQuickNav(btn.dataset.target);
      const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
  });
  // Scrollspy: the section crossing a line at 40% of the viewport height
  // is current. Sections are tried in document order, so when the
  // side-by-side generate/result columns both cross the line on wide
  // screens 生成 wins; if no section contains the line, the last section
  // whose top has passed it stays current.
  const raf = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (fn) => setTimeout(fn, 0);
  let spyTicking = false;
  const updateQuickSpy = () => {
    spyTicking = false;
    const line = window.innerHeight * 0.4;
    let activeId = '';
    for (const sec of quickSections) {
      const r = sec.getBoundingClientRect();
      if (r.top <= line && r.bottom > line) { activeId = sec.id; break; }
    }
    if (!activeId) {
      for (const sec of quickSections) {
        if (sec.getBoundingClientRect().top <= line) activeId = sec.id;
      }
    }
    if (activeId) setActiveQuickNav(activeId);
  };
  const onSpyScroll = () => {
    if (spyTicking) return;
    spyTicking = true;
    raf(updateQuickSpy);
  };
  window.addEventListener('scroll', onSpyScroll, { passive: true });
  window.addEventListener('resize', onSpyScroll);
  updateQuickSpy();
}

// ------------- Header: current version + update check --------------------
const versionStatusEl = byId('versionStatus');
const versionUpdateLink = byId('versionUpdateLink');
const versionAlertEl = byId('versionAlert');
const versionAlertTextEl = byId('versionAlertText');
const versionRetryBtn = byId('versionRetryBtn');
let versionCheckInFlight = false;

function showVersionStatus(state, text) {
  if (!versionStatusEl || !versionUpdateLink) return;
  versionUpdateLink.classList.add('hidden');
  versionStatusEl.classList.remove('hidden');
  versionStatusEl.className = `version-status is-${state}`;
  versionStatusEl.textContent = text;
}

function showVersionUpdate(data) {
  if (!versionStatusEl || !versionUpdateLink) return;
  versionStatusEl.classList.add('hidden');
  versionUpdateLink.classList.remove('hidden');
  versionUpdateLink.className = 'version-status is-update';
  versionUpdateLink.textContent = `v${data.version} · 新版 v${data.latest} →`;
  versionUpdateLink.setAttribute('aria-label', `发现新版本 v${data.latest}，点击查看`);
  versionUpdateLink.href = data.releaseUrl || 'https://github.com/realadmin/cloudflaresub/releases';
}

function showVersionAlert(message) {
  if (!versionAlertEl || !versionAlertTextEl) return;
  versionAlertTextEl.textContent = message;
  versionAlertEl.classList.remove('hidden');
}

function hideVersionAlert() {
  if (!versionAlertEl || !versionAlertTextEl) return;
  versionAlertTextEl.textContent = '';
  versionAlertEl.classList.add('hidden');
}

async function loadVersionStatus(retry = false) {
  if (!versionStatusEl || !versionUpdateLink || versionCheckInFlight) return;
  versionCheckInFlight = true;
  if (versionRetryBtn) {
    versionRetryBtn.disabled = true;
    versionRetryBtn.textContent = '检查中…';
  }
  showVersionStatus('loading', retry ? '正在重新检查…' : '版本检查中…');
  hideVersionAlert();
  try {
    const resp = await fetch(retry ? '/api/version?retry=1' : '/api/version', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json().catch(() => null);
    if (!data || !data.version || !['ok', 'stale', 'failed'].includes(data.checkStatus)) {
      throw new Error('Malformed version response');
    }
    if (data.checkStatus === 'failed') {
      showVersionStatus('failed', `v${data.version} · 检查失败`);
      showVersionAlert('⚠ 本次新版本检查失败：暂时无法连接 GitHub，无法确认是否有新版本。订阅生成功能不受影响。');
      return;
    }
    if (!data.latest) throw new Error('Version response has no latest release');
    if (data.updateAvailable) {
      showVersionUpdate(data);
      if (data.checkStatus === 'stale') {
        showVersionAlert('⚠ 本次新版本检查失败：暂时无法连接 GitHub；“发现新版本”的提示来自上次成功检查。订阅生成功能不受影响。');
      }
      return;
    }
    if (data.checkStatus === 'stale') {
      showVersionStatus('stale', `v${data.version} · 上次结果`);
      showVersionAlert('⚠ 本次新版本检查失败：暂时无法连接 GitHub，下面显示的是上次成功检查的结果，暂时不能确认最新状态。订阅生成功能不受影响。');
      return;
    }
    showVersionStatus('current', `v${data.version} · 已是最新`);
  } catch {
    showVersionStatus('failed', '版本信息获取失败');
    showVersionAlert('⚠ 版本信息获取失败：无法连接本站的版本检查接口，暂时无法确认当前版本或是否有新版本。订阅生成功能不受影响。');
  } finally {
    versionCheckInFlight = false;
    if (versionRetryBtn) {
      versionRetryBtn.disabled = false;
      versionRetryBtn.textContent = '重新检查';
    }
  }
}

if (versionRetryBtn) {
  versionRetryBtn.addEventListener('click', () => loadVersionStatus(true));
}
loadVersionStatus(false);

// ---- Diagnostics export ----------------------------------------------------
// Assembles the redacted troubleshooting report behind the footer
// button: environment, a live version/clock probe, the session journal,
// the page error ring, aggregate page state, and (with an admin token)
// the server-side diag report including its event ring. A final
// regex pass strips anything that still looks like a secret, an
// address or a node link, in case an error message smuggled one in.
function sanitizeDiagText(s) {
  return s
    .replace(/(?:vmess|vless|trojan|ss):\/\/\S+/gi, '‹节点链接›')
    .replace(/https?:\/\/[^\s"']+/g, (u) => {
      try {
        const x = new URL(u);
        return x.origin + x.pathname;
      } catch {
        return '‹网址›';
      }
    })
    .replace(/\b[0-9a-f]{32,}\b/gi, '‹长串已抹除›')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '‹IP›')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,}[0-9a-f:]*\b/gi, '‹IPv6›');
}

function diagTime(t) {
  try {
    return new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

async function buildDiagReport() {
  const lines = [];
  lines.push('cloudflaresub 诊断日志（已脱敏）');
  lines.push(`导出时间（本机）：${new Date().toString()}`);
  try {
    const t0 = performance.now();
    const resp = await fetch('/api/version', { cache: 'no-store' });
    const ms = Math.round(performance.now() - t0);
    const data = await resp.json().catch(() => null);
    lines.push(`应用版本：${data?.version ?? '未知'}（最新发布：${data?.latest ?? '未知'}，更新检查：${data?.checkStatus ?? '未知'}）`);
    lines.push(`现测 /api/version：HTTP ${resp.status}，${ms}ms`);
    const serverDate = resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('date') : null;
    if (serverDate) {
      const skew = Math.round((Date.now() - new Date(serverDate).getTime()) / 1000);
      lines.push(`时钟偏差（本机 - 服务器）：${skew}s`);
    }
  } catch (e) {
    lines.push(`现测 /api/version：失败（${(e && e.name) || 'Error'}）`);
  }

  lines.push('', '[环境]');
  const nav = navigator;
  lines.push(`UA：${nav.userAgent}`);
  if (nav.userAgentData) {
    lines.push(`UA-CH：platform=${nav.userAgentData.platform || '?'}，mobile=${nav.userAgentData.mobile ? '是' : '否'}`);
  }
  lines.push(`语言：${nav.language || '?'} / ${(nav.languages || []).join(', ')}`);
  try {
    lines.push(`时区：${Intl.DateTimeFormat().resolvedOptions().timeZone || '未知'}`);
  } catch {
    lines.push('时区：未知');
  }
  lines.push(`屏幕：${screen.width}x${screen.height}，视口：${window.innerWidth}x${window.innerHeight}，DPR：${window.devicePixelRatio}`);
  lines.push(`触屏：${'ontouchstart' in window ? '是' : '否'}（maxTouchPoints ${nav.maxTouchPoints || 0}）`);
  lines.push(`在线状态：${nav.onLine ? '在线' : '离线'}`);
  if (nav.connection) {
    lines.push(`网络：${nav.connection.effectiveType || '?'}，下行约 ${nav.connection.downlink ?? '?'}Mbps，RTT ${nav.connection.rtt ?? '?'}ms`);
  }
  try {
    lines.push(`深色模式偏好：${window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}`);
  } catch {}
  try {
    const est = nav.storage && (await nav.storage.estimate());
    if (est) lines.push(`存储配额：已用 ${est.usage ?? '?'} / ${est.quota ?? '?'} 字节`);
  } catch {}
  lines.push(`localStorage 键：${storageKeyNames('localStorage').join(', ') || '（无）'}`);
  lines.push(`sessionStorage 键：${storageKeyNames('sessionStorage').join(', ') || '（无）'}`);

  lines.push('', '[页面状态]');
  const items = adminState.items || [];
  const dynCount = items.filter((i) => i.dynamic).length;
  const tagCount = items.filter((i) => Array.isArray(i.tags) && i.tags.length).length;
  const noteCount = items.filter((i) => typeof i.note === 'string' && i.note.trim()).length;
  lines.push(`管理列表：${items.length ? `已加载 ${items.length} 条（动态 ${dynCount}，含标签 ${tagCount}，含备注 ${noteCount}）` : '未加载'}`);
  lines.push(`标签词汇：${allTagCounts().length} 个；已选筛选：${adminState.tagSelected.size} 个；顺序已加载：${tagOrderLoaded ? '是' : '否'}`);
  const lastList = [...diagJournal].reverse().find((e) => e.kind === 'api' && e.route === 'GET /api/list');
  if (lastList) lines.push(`最近一次列表加载：HTTP ${lastList.status}，${lastList.ms}ms，${diagTime(lastList.t)}`);

  lines.push('', '[会话操作流水]');
  if (!diagJournal.length) lines.push('（无）');
  for (const e of diagJournal) {
    if (e.kind === 'api') {
      lines.push(`${diagTime(e.t)} ${e.route} → ${e.status === 0 ? `失败（${e.err || 'Error'}）` : `HTTP ${e.status}`}，${e.ms}ms`);
    } else {
      lines.push(`${diagTime(e.t)} 事件：${e.name}`);
    }
  }

  lines.push('', '[页面报错]');
  const errs = window.__diagErrors || [];
  if (!errs.length) lines.push('（无）');
  for (const e of errs) {
    lines.push(`${diagTime(e.t)} ${e.kind}：${e.msg}${e.src ? ` @${e.src}:${e.line || 0}` : ''}`);
    if (e.stack) lines.push(e.stack);
  }

  lines.push('', '[服务端诊断]');
  const token = adminToken();
  if (!token) {
    lines.push('（未填管理令牌，跳过服务端诊断）');
  } else {
    try {
      const resp = await fetch('/api/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({}),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data || !data.diag) {
        lines.push(`获取失败：HTTP ${resp.status}`);
      } else {
        const d = data.diag;
        lines.push(`服务端时间：${d.serverTime}；落点：${d.colo || '未知'}；版本：${d.version}`);
        if (d.kvProbe) {
          lines.push(`KV 探针：写入 ${d.kvProbe.putMs ?? '?'}ms，读取 ${d.kvProbe.getMs ?? '?'}ms，一致：${d.kvProbe.match === true ? '是' : '否'}${d.kvProbe.error ? `，错误 ${d.kvProbe.error}` : ''}`);
        }
        const c = d.census || {};
        if (c.error) {
          lines.push(`条目普查失败：${c.error}`);
        } else {
          lines.push(`条目普查：共 ${c.entries} 条（抽样细查 ${c.detailSampled} 条：动态 ${c.dynamic}，含标签 ${c.withTags}，含备注 ${c.withNote}，永久 ${c.permanent}）`);
          if (c.recordBytes) lines.push(`记录体积：总 ${c.recordBytes.total} 字节，中位 ${c.recordBytes.p50}，最大 ${c.recordBytes.max}`);
          if (c.oldestAgeDays !== undefined && c.oldestAgeDays !== null) lines.push(`条目年龄：最老 ${c.oldestAgeDays} 天，最新 ${c.newestAgeDays} 天`);
          lines.push(`标签词汇：${c.tagVocab} 个；去重键：${c.dedupKeys} 个；来源缓存：${c.ipcache?.keys ?? '?'} 个（抽样 ${c.ipcache?.sampled ?? 0} 个中新鲜 ${c.ipcache?.freshInSample ?? 0} 个）`);
          lines.push(`动态来源主机（哈希）：${(c.sourceHosts || []).join(', ') || '（无）'}`);
          lines.push(`标签顺序：${c.tagOrder?.exists ? `存在，${c.tagOrder.size} 个，约 ${c.tagOrder.ageSec ?? '?'} 秒前更新` : '不存在'}`);
        }
        lines.push(`版本检查：${d.versionCheck?.status ?? '?'}，最新 ${d.versionCheck?.latest ?? '未知'}，有更新：${d.versionCheck?.updateAvailable ? '是' : '否'}`);
        lines.push('', '[服务端事件环]');
        const evts = d.events || [];
        if (!evts.length) lines.push('（无）');
        for (const e of evts) {
          const times = e.n && e.n > 1 ? `，共 ${e.n} 次` : '';
          if (e.kind === 'ip-source') {
            lines.push(`${diagTime(e.t)} 来源 ${e.host} ${e.result === 'failed' ? '抓取失败' : '用旧缓存兜底'}（${e.err || '?'}），${e.ms}ms${times}`);
          } else {
            lines.push(`${diagTime(e.t)} ${e.route} → HTTP ${e.status}，${e.ms}ms${e.err ? `，错误 ${e.err}` : ''}${times}`);
          }
        }
      }
    } catch (e) {
      lines.push(`获取失败：${(e && e.name) || 'Error'}`);
    }
  }
  return sanitizeDiagText(lines.join('\n'));
}

const diagExportBtn = byId('diagExportBtn');
const diagStatusEl = byId('diagStatus');
if (diagExportBtn) {
  diagExportBtn.addEventListener('click', async () => {
    diagExportBtn.disabled = true;
    if (diagStatusEl) diagStatusEl.textContent = '正在生成…';
    try {
      const report = await buildDiagReport();
      const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = URL.createObjectURL(blob);
      a.download = `cloudflaresub-diag-${stamp}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      if (diagStatusEl) diagStatusEl.textContent = '已导出（已脱敏）。';
    } catch {
      if (diagStatusEl) diagStatusEl.textContent = '导出失败，请重试。';
    } finally {
      diagExportBtn.disabled = false;
    }
  });
}

// With a restored token, preload the shared tag order: it used to
// load only together with the admin list, so a straight-to-generate
// session rendered the picker's suggestions in vocabulary order
// instead of the owner's arrangement. This deliberately runs at the
// very end of the script — the tag-order state is declared further
// up and must be initialized before the loader can touch it.
if (savedAdminToken) loadTagOrderFromServer();
