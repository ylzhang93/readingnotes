'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

const $ = (id) => document.getElementById(id);

const notebooksView = $('notebooks-view');
const notebookView = $('notebook-view');
const topControls = $('top-controls');
const viewerWrap = $('viewer-wrap');
const viewer = $('viewer');
const popover = $('popover');
const popSelected = $('pop-selected');
const popQuestion = $('pop-question');
const popStatus = $('pop-status');
const reasoningEl = $('reasoning');
const reasoningCard = $('reasoning-card');
const notePreview = $('note-preview');
const historyEl = $('history');
const logEl = $('log');
const toastEl = $('toast');

let pdf = null;
let pages = [];
let currentSelection = null;
let state = null;
let currentScale = 2.0;
let currentPage = 1;
let pageWidthPt = 0;
let pageHeightPt = 0;
let suppressScroll = false;
let fullscreenPos = null;

/* --------------------------------------------------------------- views -- */
function showNotebooks() {
  notebookView.hidden = true;
  notebooksView.hidden = false;
  topControls.hidden = true;
  $('pagenav').hidden = true;
  $('docname').textContent = '';
  $('btn-notebooks').textContent = '← Back to PDF';
  loadNotebooksList();
}
function toggleNotebooks() {
  if (notebooksView.hidden) showNotebooks();
  else {
    notebooksView.hidden = true;
    notebookView.hidden = false;
    topControls.hidden = false;
    $('pagenav').hidden = false;
    $('docname').textContent = state ? state.texFile : '';
    $('btn-notebooks').textContent = '📚 Notebooks';
  }
}
function showNotebookView(st) {
  state = st;
  notebooksView.hidden = true;
  notebookView.hidden = false;
  topControls.hidden = false;
  $('pagenav').hidden = false;
  $('docname').textContent = st.texFile;
  $('btn-notebooks').textContent = '📚 Notebooks';
  $('nextq').textContent = st.nextQ;
  if (localStorage.getItem('texnote-panel-collapsed') === '1') $('panel').classList.add('collapsed');
  else $('panel').classList.remove('collapsed');
  renderHistory(st.entries);
  currentPage = 1;   // each newly-opened notebook starts at page 1
  renderPdf();
}

let providersCache = [];
async function populateProviders() {
  try {
    const r = await (await fetch('/api/providers')).json();
    providersCache = r.list;
    // topbar provider switcher
    const sel = $('provider-select');
    sel.innerHTML = '';
    for (const p of r.list) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name + ' (' + p.model + ')';
      sel.appendChild(o);
    }
    sel.value = r.active;
    // notebooks-view api-key editor
    const asel = $('api-provider');
    asel.innerHTML = '';
    for (const p of r.list) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name;
      asel.appendChild(o);
    }
    asel.value = r.active;
    updateApiKeyHint(r.active);
  } catch (_) { /* ignore */ }
}
function updateApiKeyHint(name) {
  const p = providersCache.find((x) => x.name === name);
  const inp = $('api-key');
  inp.value = '';
  if (p && p.hasKey) {
    const src = p.source === 'credentialsFile' ? ' (from credentialsFile)' : '';
    inp.placeholder = 'current: ' + p.maskedKey + src + ' (type to replace)';
  } else {
    inp.placeholder = 'Paste a new API key…';
  }
}
async function saveApiKey() {
  const name = $('api-provider').value;
  const key = $('api-key').value.trim();
  const st = $('api-status');
  if (!key) { st.textContent = 'paste a key first'; st.className = 'status err'; return; }
  st.textContent = 'saving…'; st.className = 'status';
  try {
    const res = await fetch('/api/set-apikey', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: name, apiKey: key })
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || ('HTTP ' + res.status));
    st.textContent = `saved for ${name} (${r.maskedKey})`;
    st.className = 'status ok';
    $('api-key').value = '';
    populateProviders();
  } catch (e) {
    st.textContent = String(e.message || e);
    st.className = 'status err';
  }
}
async function switchProvider(name) {
  try {
    const r = await (await fetch('/api/switch-provider', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: name })
    })).json();
    toast('provider → ' + r.active, 'ok');
  } catch (e) {
    toast(String(e.message || e), 'err');
    populateProviders();
  }
}

/* ---------------------------------------------------------- notebooks -- */
async function loadNotebooksList() {
  try {
    const r = await (await fetch('/api/notebooks')).json();
    const list = $('notebook-list');
    list.innerHTML = '';
    if (!r.list || !r.list.length) {
      list.innerHTML = '<div class="nb-empty">No notebooks yet — open a folder to begin.</div>';
      return;
    }
    for (const n of r.list) {
      const item = document.createElement('div');
      item.className = 'nb-item';
      item.innerHTML =
        '<div><div class="nb-name">' + escapeHtml(pathBasename(n.dir)) + '</div>' +
        '<div class="nb-path">' + escapeHtml(n.dir) + ' · ' + escapeHtml(n.texFile) + '</div></div>';
      const actions = document.createElement('div');
      actions.className = 'nb-actions';
      const open = document.createElement('button');
      open.textContent = 'Open'; open.className = 'primary';
      open.onclick = (e) => { e.stopPropagation(); openFolder(n.dir, n.texFile); };
      const rm = document.createElement('button');
      rm.textContent = '✕'; rm.title = 'Remove from list (notes are kept)';
      rm.onclick = async (e) => {
        e.stopPropagation();
        await fetch('/api/remove-notebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: n.dir, texFile: n.texFile }) });
        loadNotebooksList();
      };
      actions.append(open, rm);
      item.appendChild(actions);
      item.onclick = () => openFolder(n.dir, n.texFile);
      list.appendChild(item);
    }
  } catch (e) {
    $('notebook-list').innerHTML = '<div class="nb-empty">' + escapeHtml(String(e)) + '</div>';
  }
}

async function openFolder(dir, texFile) {
  try {
    const res = await fetch('/api/open-folder', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, texFile: texFile || '' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    showNotebookView(data);
    log(`[notebook] ${data.dir} — ${data.entries.length} notes, next ${data.nextQ}`);
  } catch (e) {
    $('open-error').textContent = String(e.message || e);
  }
}

function pathBasename(p) { return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop(); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------ rendering -- */
function capturePos() {
  if (!pages.length) return { page: 1, frac: 0 };
  const vp = viewerWrap.getBoundingClientRect();
  let bp = 1, bo = -1e9;
  for (const p of pages) {
    const r = p.wrapper.getBoundingClientRect();
    const o = Math.min(r.bottom, vp.bottom) - Math.max(r.top, vp.top);
    if (o > bo) { bo = o; bp = p.pageNumber; }
  }
  const p = pages.find((x) => x.pageNumber === bp);
  if (!p) return { page: 1, frac: 0 };
  const r = p.wrapper.getBoundingClientRect();
  return { page: bp, frac: Math.max(0, (vp.top - r.top) / r.height) };
}

function restorePos(pos) {
  const p = pages.find((x) => x.pageNumber === pos.page);
  if (!p) return;
  const vp = viewerWrap.getBoundingClientRect();
  const r = p.wrapper.getBoundingClientRect();
  viewerWrap.scrollTop += (r.top + pos.frac * r.height) - vp.top;
  currentPage = pos.page;
  $('page-input').value = pos.page;
}

async function renderPdf(keepPos) {
  const pos = keepPos ? capturePos() : null;
  suppressScroll = true;
  viewer.innerHTML = '';
  pages = [];
  setStatus('pop-status', 'rendering…', '');
  pdf = await pdfjsLib.getDocument({ url: '/pdf?t=' + Date.now() }).promise;
  const n = pdf.numPages;
  $('page-total').textContent = '/ ' + n;

  // page size (assume uniform; page 1 is representative)
  const first = await pdf.getPage(1);
  pageWidthPt = first.view[2] - first.view[0];
  pageHeightPt = first.view[3] - first.view[1];
  const w = Math.floor(pageWidthPt * currentScale);
  const h = Math.floor(pageHeightPt * currentScale);

  // placeholder shells for every page -> correct scroll layout immediately
  for (let i = 1; i <= n; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page placeholder';
    wrapper.dataset.page = String(i);
    wrapper.style.width = w + 'px';
    wrapper.style.height = h + 'px';
    viewer.appendChild(wrapper);
    pages.push({ pageNumber: i, wrapper, page: (i === 1 ? first : null), viewport: null, pdfHeight: pageHeightPt, rendered: false });
  }

  // position at the target page right away (no jump-to-page-1 flash)
  if (pos) restorePos(pos);
  else { currentPage = 1; $('page-input').value = 1; viewerWrap.scrollTop = 0; }

  // render content: target page first, then outward
  const target = pos ? pos.page : 1;
  const order = [target];
  for (let d = 1; d < n; d++) {
    if (target - d >= 1) order.push(target - d);
    if (target + d <= n) order.push(target + d);
  }
  for (const i of order) await renderPageContent(i);

  suppressScroll = false;
  setStatus('pop-status', '', '');
}

async function renderPageContent(i) {
  const p = pages.find((x) => x.pageNumber === i);
  if (!p || p.rendered) return;
  const pageObj = p.page || await pdf.getPage(i);
  p.page = pageObj;
  const viewport = pageObj.getViewport({ scale: currentScale });
  p.viewport = viewport;
  p.pdfHeight = pageObj.view[3] - pageObj.view[1];
  p.wrapper.style.width = Math.floor(viewport.width) + 'px';
  p.wrapper.style.height = Math.floor(viewport.height) + 'px';

  const canvas = document.createElement('canvas');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  const ctx = canvas.getContext('2d', { alpha: false });
  p.wrapper.appendChild(canvas);

  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  textLayerDiv.style.setProperty('--scale-factor', viewport.scale);
  p.wrapper.appendChild(textLayerDiv);

  const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
  await pageObj.render({ canvasContext: ctx, viewport, transform }).promise;
  const textContent = await pageObj.getTextContent();
  const textLayer = pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayerDiv, viewport });
  await textLayer.promise;

  p.wrapper.classList.remove('placeholder');
  p.rendered = true;
}

function goToPage(n, smooth) {
  n = Math.max(1, Math.min(n, pages.length));
  currentPage = n;
  const p = pages.find((p) => p.pageNumber === n);
  if (p) p.wrapper.scrollIntoView({ behavior: smooth === false ? 'auto' : 'smooth', block: 'start' });
  $('page-input').value = n;
}

function fitWidth() {
  if (!pageWidthPt) return;
  currentScale = (viewerWrap.clientWidth - 48) / pageWidthPt;
  renderPdf(true);
}
function fitPage() {
  if (!pageWidthPt) return;
  const aw = viewerWrap.clientWidth - 48;
  const ah = viewerWrap.clientHeight - 48;
  currentScale = Math.min(aw / pageWidthPt, ah / pageHeightPt);
  renderPdf(true);
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else {
    fullscreenPos = capturePos();
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

function updatePageIndicator() {
  const vp = viewerWrap.getBoundingClientRect();
  let best = 1, bestOverlap = -1;
  for (const p of pages) {
    const r = p.wrapper.getBoundingClientRect();
    const overlap = Math.min(r.bottom, vp.bottom) - Math.max(r.top, vp.top);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = p.pageNumber; }
  }
  if (best !== currentPage) { currentPage = best; $('page-input').value = best; }
}

/* ------------------------------------------------------------ selection -- */
function selectionInfo() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  for (const p of pages) {
    if (!p.viewport) continue;   // page not rendered yet
    const pr = p.wrapper.getBoundingClientRect();
    const inside = rect.left >= pr.left - 2 && rect.right <= pr.right + 2 &&
      rect.top >= pr.top - 2 && rect.bottom <= pr.bottom + 2;
    if (!inside) continue;
    const cssX = rect.left - pr.left;
    const cssY = rect.top - pr.top;
    const [pdfX, pdfY] = p.viewport.convertToPdfPoint(cssX, cssY);
    return { text, page: p.pageNumber, x: pdfX.toFixed(3), y: (p.pdfHeight - pdfY).toFixed(3), rect };
  }
  return null;
}

function showPopover(info) {
  popSelected.textContent = `«${info.text}»  (p.${info.page})`;
  popQuestion.value = '';
  popStatus.textContent = '';
  $('pop-thinking').checked = localStorage.getItem('texnote-pop-thinking') === '1';
  $('pop-write').checked = localStorage.getItem('texnote-pop-write') !== '0';
  popover.hidden = false;
  // position below the selection (clamped to viewport)
  const w = 420;
  const left = Math.min(Math.max(info.rect.left, 8), window.innerWidth - w - 8);
  const top = Math.min(info.rect.bottom + 10, window.innerHeight - 130);
  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
  // NOTE: do not auto-focus the input — that would clear the PDF text
  // selection, so the user could no longer see/copy the highlighted text.
}
function hidePopover() { popover.hidden = true; }

function onSelectionEnd() {
  const info = selectionInfo();
  if (!info) return;
  currentSelection = info;
  showPopover(info);
}

/* -------------------------------------------------------------- status -- */
function setStatus(id, msg, cls) { const el = $(id); el.textContent = msg; el.className = 'status' + (cls ? ' ' + cls : ''); }
function log(msg) { logEl.textContent = (logEl.textContent === '—' ? '' : logEl.textContent + '\n') + msg; logEl.scrollTop = logEl.scrollHeight; }
function toast(msg, cls) {
  toastEl.textContent = msg;
  toastEl.className = cls || 'ok';
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

function cachePct(usage) {
  if (!usage) return '';
  const hit = usage.prompt_cache_hit_tokens ||
    (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  const total = usage.prompt_tokens || 0;
  if (!total) return '';
  return ` · cache ${Math.round(100 * hit / total)}%`;
}

/* ----------------------------------------------------------- annotation -- */
async function submitAnnotation() {
  if (!currentSelection) return;
  const question = popQuestion.value.trim();
  if (!question) { setStatus('pop-status', 'type a question first', 'err'); return; }
  const thinking = $('pop-thinking').checked;
  const writeToTex = $('pop-write').checked;
  $('pop-submit').disabled = true;
  setStatus('pop-status', thinking ? 'thinking…' : 'generating…', '');
  try {
    const res = await fetch('/api/annotate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question, selectedText: currentSelection.text,
        page: currentSelection.page, x: currentSelection.x, y: currentSelection.y,
        thinking, writeToTex
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

    if (data.reasoning) { reasoningEl.textContent = data.reasoning; reasoningCard.hidden = false; }
    notePreview.innerHTML = window.texToHtml('\\textbf{' + data.title + '}\n\n' + data.explanation);
    $('nextq').textContent = data.nextQ;
    log(data.logTail || '');
    toast((writeToTex
      ? `✓ ${data.qid} added to .tex & recompiled`
      : `✓ ${data.qid} saved to notebook`) + cachePct(data.usage), 'ok');

    const st = await (await fetch('/api/state')).json();
    renderHistory(st.entries);
    hidePopover();
    await renderPdf(true);
    setStatus('pop-status', '', '');
  } catch (e) {
    setStatus('pop-status', String(e.message || e), 'err');
  } finally {
    $('pop-submit').disabled = false;
  }
}

/* ------------------------------------------------------------- history -- */
function renderHistory(entries) {
  historyEl.innerHTML = '';
  if (!entries.length) { historyEl.innerHTML = '<div class="nb-empty" style="padding:10px">No notes yet.</div>'; return; }
  for (const e of entries) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const badge = e.inTex ? '<span class="badge tex">tex</span>' : '<span class="badge nb">notebook</span>';
    item.innerHTML = '<span class="hid">' + escapeHtml(e.id) + '</span>' + escapeHtml(e.title) + badge +
      (e.line ? '<span class="hline">L' + escapeHtml(e.line) + '</span>' : '');
    item.title = e.inTex && e.page ? 'Jump to page ' + e.page : 'View this note';
    item.onclick = () => {
      notePreview.innerHTML = window.texToHtml('\\textbf{' + (e.title || '') + '}\n\n' + (e.body || ''));
      if (e.inTex && e.page) goToPage(e.page, true);
    };
    historyEl.appendChild(item);
  }
}

/* ------------------------------------------------------------- actions -- */
async function doCompile() {
  toast('compiling…', '');
  $('btn-compile').disabled = true;
  try {
    const data = await (await fetch('/api/compile', { method: 'POST' })).json();
    log(data.logTail || '');
    toast(data.ok ? 'compiled ✓' : 'compile failed — see log', data.ok ? 'ok' : 'err');
    $('nextq').textContent = data.nextQ;
    await renderPdf(true);
  } catch (e) {
    toast(String(e.message || e), 'err');
  } finally {
    $('btn-compile').disabled = false;
  }
}

/* ---------------------------------------------------------------- wiring -- */
document.addEventListener('mouseup', () => setTimeout(onSelectionEnd, 10));
document.addEventListener('mousedown', (e) => {
  if (!popover.hidden && e.target && !popover.contains(e.target)) hidePopover();
});
document.addEventListener('wheel', (e) => {
  if (!popover.hidden && e.target && !popover.contains(e.target)) hidePopover();
}, { passive: true });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !popover.hidden) hidePopover();
});
document.addEventListener('scroll', () => { if (!suppressScroll) updatePageIndicator(); }, true);
document.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'PageDown' || e.key === 'ArrowRight') { e.preventDefault(); goToPage(currentPage + 1, true); }
  else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); goToPage(currentPage - 1, true); }
});
popQuestion.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAnnotation(); });
popQuestion.addEventListener('input', () => { popStatus.textContent = ''; });
$('pop-submit').addEventListener('click', submitAnnotation);
$('pop-thinking').addEventListener('change', () => localStorage.setItem('texnote-pop-thinking', $('pop-thinking').checked ? '1' : '0'));
$('pop-write').addEventListener('change', () => localStorage.setItem('texnote-pop-write', $('pop-write').checked ? '1' : '0'));
$('btn-prev').addEventListener('click', () => goToPage(currentPage - 1, true));
$('btn-next').addEventListener('click', () => goToPage(currentPage + 1, true));
$('page-input').addEventListener('change', () => { const n = parseInt($('page-input').value, 10); if (n) goToPage(n, true); });
$('btn-zoom-in').addEventListener('click', () => { currentScale = Math.min(3.5, currentScale + 0.25); renderPdf(true); });
$('btn-fit-page').addEventListener('click', fitPage);
$('btn-fit-width').addEventListener('click', fitWidth);
$('btn-fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  if (fullscreenPos) {
    requestAnimationFrame(() => { restorePos(fullscreenPos); fullscreenPos = null; });
  }
});
$('btn-zoom-out').addEventListener('click', () => { currentScale = Math.max(1.0, currentScale - 0.25); renderPdf(true); });
$('btn-compile').addEventListener('click', doCompile);
$('btn-panel').addEventListener('click', () => {
  $('panel').classList.toggle('collapsed');
  localStorage.setItem('texnote-panel-collapsed', $('panel').classList.contains('collapsed') ? '1' : '0');
});
$('btn-notebooks').addEventListener('click', toggleNotebooks);
$('provider-select').addEventListener('change', (e) => switchProvider(e.target.value));
$('api-provider').addEventListener('change', (e) => updateApiKeyHint(e.target.value));
$('api-save').addEventListener('click', saveApiKey);
$('btn-open-folder').addEventListener('click', () => {
  const dir = $('folder-path').value.trim();
  $('open-error').textContent = '';
  if (!dir) { $('open-error').textContent = 'paste a folder path first'; return; }
  openFolder(dir, '');
});
$('folder-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-open-folder').click(); });

// collapsible cards (History / Note preview / Compile log): click the title to toggle
document.querySelectorAll('#panel .card .card-title').forEach((t) => {
  t.addEventListener('click', () => t.parentElement.classList.toggle('collapsed'));
});

/* ----------------------------------------------------------------- boot -- */
(async function boot() {
  try {
    populateProviders();
    const res = await fetch('/api/state');
    if (res.ok) {
      const st = await res.json();
      showNotebookView(st);
      log(`[notebook] ${st.dir} — ${st.entries.length} notes, next ${st.nextQ}`);
    } else {
      showNotebooks();
    }
  } catch (e) {
    showNotebooks();
    $('open-error').textContent = String(e && e.message || e);
  }
})();
