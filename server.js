'use strict';
/*
 * texnote-reader — one-stop PDF reader + reading-note injector for LaTeX papers.
 *
 * Multi-notebook: each *document folder* is a notebook. Notes persist in
 * <folder>/.texnote/notebook.json, so memory follows the folder and survives
 * reopening. The full Q&A history + a stable document header are fed to
 * DeepSeek as a byte-stable prefix (append-only) so the API's KV cache is hit
 * on every follow-up question (reasonix-style "prefix-cache stability").
 *
 * Notes are inserted as `\begin{readingnote}[Qn]{title}...\end{readingnote}`
 * using the readingnote.sty package (auto-\usepackage'd when missing).
 *
 * Zero runtime dependencies: plain Node (http + child_process + fetch).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const REGISTRY = process.env.TEXNOTE_REGISTRY
  ? path.resolve(process.env.TEXNOTE_REGISTRY)
  : path.join(ROOT, 'notebooks.json');
const NOTEDIR = '.texnote';

/* ------------------------------------------------------------- tool config -- */
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (_) {}
  const defaults = {
    port: 8910,
    activeProvider: 'deepseek',
    providers: {
      deepseek: {
        baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
        credentialsFile: process.env.DEEPSEEK_CREDENTIALS_FILE ||
          'C:\\Users\\49654\\.dsh\\.credentials.yaml',
        maxOutputTokens: 8000
      }
    }
  };
  const merged = Object.assign({}, defaults, cfg);
  merged.providers = Object.assign({}, defaults.providers, cfg.providers || {});
  if (!merged.providers[merged.activeProvider]) {
    merged.activeProvider = Object.keys(merged.providers)[0] || 'deepseek';
  }
  if (process.env.TEXNOTE_PORT) merged.port = parseInt(process.env.TEXNOTE_PORT, 10);
  return merged;
}
const config = loadConfig();

/* ------------------------------------------------------------ notebook registry -- */
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); }
  catch (_) { return { active: null, list: [] }; }
}
function saveRegistry(r) {
  fs.writeFileSync(REGISTRY, JSON.stringify(r, null, 2), 'utf8');
}

let registry = loadRegistry();
let active = null;
if (registry.active) {
  active = registry.list.find((n) =>
    n.dir === registry.active.dir && n.texFile === registry.active.texFile) || null;
}

/* ------------------------------------------------------------ paths -- */
const texPath = () => active && path.join(active.dir, active.texFile);
const pdfPath = () => active && texPath().replace(/\.tex$/i, '.pdf');
const noteDir = () => active && path.join(active.dir, NOTEDIR);
const noteFile = () => active && path.join(noteDir(), 'notebook.json');

/* ------------------------------------------------------------ api key -- */
function activeProviderName() { return config.activeProvider || 'deepseek'; }
function activeProvider() {
  const p = (config.providers && config.providers[activeProviderName()]) || {};
  return Object.assign({ name: activeProviderName() }, p);
}
function llmModel() { return activeProvider().model; }
function saveConfig() {
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function readApiKey() {
  const p = activeProvider();
  if (p.apiKey) return String(p.apiKey).trim();
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  if (p.credentialsFile && fs.existsSync(p.credentialsFile)) {
    const txt = fs.readFileSync(p.credentialsFile, 'utf8');
    const m = txt.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m);
    if (m) return m[1].trim();
  }
  return null;
}

/* Effective key for a provider (apiKey first, then credentialsFile). */
function providerKey(pr) {
  if (pr.apiKey) return String(pr.apiKey).trim();
  if (pr.credentialsFile && fs.existsSync(pr.credentialsFile)) {
    try {
      const txt = fs.readFileSync(pr.credentialsFile, 'utf8');
      const m = txt.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m);
      if (m) return m[1].trim();
    } catch (_) {}
  }
  return '';
}
function maskKey(k) {
  if (!k) return '';
  return k.length > 8 ? k.slice(0, 4) + '…' + k.slice(-4) : '••••';
}

/* ------------------------------------------------------------ tex utils -- */
function readTexFile(fp) {
  const raw = fs.readFileSync(fp, 'utf8');
  const bom = raw.charCodeAt(0) === 0xFEFF;
  const body = bom ? raw.slice(1) : raw;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  return { raw: body, lines, eol, bom };
}
function writeTexFile(fp, lines, meta) {
  const body = lines.join(meta.eol);
  const out = (meta.bom ? '\uFEFF' : '') + body;
  fs.writeFileSync(fp, out, 'utf8');
}
const readTex = () => readTexFile(texPath());
const writeTex = (lines, meta) => writeTexFile(texPath(), lines, meta);
function sameFile(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/* Parse existing `\begin{readingnote}[id]{title} ... \end{readingnote}` blocks. */
function parseReadingNotes(lines) {
  const notes = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*%/.test(lines[i])) { i++; continue; }
    const m = lines[i].match(/^\s*\\begin\{readingnote\}\[([^\]]+)\]\{(.*)\}/);
    if (m) {
      const id = m[1], title = m[2];
      const body = [];
      let j = i + 1, depth = 1;
      while (j < lines.length) {
        if (/\\begin\{readingnote\}/.test(lines[j])) depth++;
        if (/\\end\{readingnote\}/.test(lines[j])) { depth--; if (depth === 0) break; }
        body.push(lines[j]);
        j++;
      }
      notes.push({ id, title, body: body.join('\n'), line: i + 1, page: null, x: null, y: null, inTex: true });
      i = j + 1;
    } else i++;
  }
  return notes;
}

/* Stable document header: title + section headings + notation macros +
 * a compact "skeleton" of all theorem/definition/... statements (no proofs). */
const STATEMENT_ENVS =
  'theorem|proposition|lemma|corollary|definition|construction|remark|remarks|conjecture|example|question|claim|thm|defn|rmk|prop|lem|cor';

function extractSkeleton(lines) {
  const out = [];
  const begin = new RegExp('^\\s*\\\\begin\\{(' + STATEMENT_ENVS + ')\\}(?:\\[([^\\]]*)\\])?\\s*(.*)$');
  let totalChars = 0;
  for (let i = 0; i < lines.length && out.length < 200; i++) {
    const m = lines[i].match(begin);
    if (!m) continue;
    const env = m[1], note = m[2] || '';
    let body = m[3] || '';
    let j = i + 1;
    const end = new RegExp('^\\s*\\\\end\\{' + env + '}');
    while (j < lines.length && !end.test(lines[j])) { body += '\n' + lines[j]; j++; }
    body = body.replace(/\s+/g, ' ').trim();
    if (body.length > 700) body = body.slice(0, 700) + ' …';
    const label = env.charAt(0).toUpperCase() + env.slice(1);
    out.push(label + (note ? ' [' + note + ']' : '') + ': ' + body);
    totalChars += body.length;
    if (totalChars > 40000) break;
    i = j;
  }
  return out;
}

/* Stable document header: title + section headings + notation macros. */
function extractDocMeta(lines) {
  let title = '';
  const sections = [];
  const notation = [];
  for (const l of lines) {
    if (!title) { const m = l.match(/\\title\s*\{([^}]*)\}/); if (m) title = m[1]; }
    const sm = l.match(/\\(?:sub)*section\*?\s*\{([^}]*)\}/);
    if (sm) sections.push(sm[1].replace(/\\[a-zA-Z]+/g, '').trim());
    if (/^\s*\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator\*?|newtheorem)\b/.test(l) && notation.length < 300) {
      notation.push(l.trim());
    }
  }
  return { title, sections, notation, skeleton: extractSkeleton(lines) };
}

/* Insert \usepackage{readingnote} into the preamble when missing. */
function ensureReadingnotePackage(lines) {
  for (const l of lines) {
    if (/\\usepackage(?:\[[^\]]*\])?\{readingnote\}/.test(l)) return { lines, added: false };
    if (/\\(?:new|renew)environment\{readingnote\}|\\NewEnviron\{readingnote\}|\\NewDocumentEnvironment\{readingnote\}/.test(l)) return { lines, added: false };
  }
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) if (/^\s*\\usepackage\b/.test(lines[i])) insertAt = i + 1;
  if (insertAt === 0) {
    for (let i = 0; i < lines.length; i++) if (/^\s*\\documentclass\b/.test(lines[i])) { insertAt = i + 1; break; }
  }
  for (let i = 0; i < lines.length; i++) if (/^\s*\\begin\{document\}/.test(lines[i]) && insertAt > i) insertAt = i;
  const newLines = lines.slice(0, insertAt).concat(['\\usepackage{readingnote}'], lines.slice(insertAt));
  return { lines: newLines, added: true };
}

/* The blank-line-delimited paragraph(s) around a 1-based line (small, cache-friendly context). */
function paragraphContext(lines, line1) {
  const n = lines.length;
  const isBlank = (l) => /^\s*$/.test(l);
  let i = Math.min(Math.max(line1 - 1, 0), n - 1);
  if (isBlank(lines[i])) { let j = i; while (j + 1 < n && isBlank(lines[j])) j++; i = j; }
  let start = i, end = i;
  while (start - 1 >= 0 && !isBlank(lines[start - 1])) start--;
  while (end + 1 < n && !isBlank(lines[end + 1])) end++;
  if (end - start < 3) { start = Math.max(0, i - 6); end = Math.min(n - 1, i + 6); }
  return lines.slice(start, end + 1).join('\n');
}

/* ------------------------------------------------------------ notebook state -- */
function loadNotebook() {
  if (noteFile() && fs.existsSync(noteFile())) {
    try {
      const nb = JSON.parse(fs.readFileSync(noteFile(), 'utf8'));
      if (nb && Array.isArray(nb.entries)) return nb;
    } catch (_) {}
  }
  return { version: 1, entries: [] };
}
function saveNotebook(nb) {
  fs.mkdirSync(noteDir(), { recursive: true });
  fs.writeFileSync(noteFile(), JSON.stringify(nb, null, 2), 'utf8');
}

/* Ensure the stable document header (title/sections/notation/skeleton) exists. */
function ensureDocMeta() {
  const nb = loadNotebook();
  if (!nb.docMeta || !Array.isArray(nb.docMeta.skeleton)) {
    nb.docMeta = extractDocMeta(readTex().lines);
    saveNotebook(nb);
  }
  return nb.docMeta;
}

function maxQ(entries, texLines) {
  let max = 0;
  for (const e of entries) { const m = /Q(\d+)/.exec(e.id || ''); if (m) max = Math.max(max, +m[1]); }
  for (const l of texLines) { const m = /\\begin\{readingnote\}\[Q(\d+)\]/.exec(l); if (m) max = Math.max(max, +m[1]); }
  return max;
}

/* ------------------------------------------------------------ folder auto-detect -- */
function detectTex(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /\.tex$/i.test(f)); } catch (_) { return null; }
  if (!files.length) return null;
  const lower = files.map((f) => f.toLowerCase());
  const iMain = lower.indexOf('main.tex');
  if (iMain >= 0) return files[iMain];
  const pdfBase = new Set(fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).map((f) => f.replace(/\.pdf$/i, '').toLowerCase()));
  for (const f of files) if (pdfBase.has(f.replace(/\.tex$/i, '').toLowerCase())) return f;
  let best = files[0], bestSize = -1;
  for (const f of files) {
    const s = fs.statSync(path.join(dir, f)).size;
    if (s > bestSize) { best = f; bestSize = s; }
  }
  return best;
}
function listTexFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.tex$/i.test(f)).sort(); }
  catch (_) { return []; }
}

/* ------------------------------------------------------------ synctex -- */
async function synctexEdit(page, x, y) {
  const args = ['edit', '-o', `${page}:${x}:${y}:${pdfPath()}`];
  try {
    const { stdout } = await execFileP('synctex', args, { cwd: active.dir, windowsHide: true, timeout: 30000 });
    const m = stdout.match(/Line:(\d+)/);
    const im = stdout.match(/Input:([^\r\n]+)/);
    let input = null;
    if (im) {
      let p = im[1].trim();
      if (p.startsWith('./')) p = p.slice(2);
      if (!path.isAbsolute(p)) p = path.resolve(active.dir, p);
      input = path.normalize(p);
    }
    return { line: m ? parseInt(m[1], 10) : null, input, raw: stdout };
  } catch (e) {
    return { line: null, input: null, error: String((e && (e.stderr || e.message)) || e) };
  }
}
async function synctexForward(line) {
  const args = ['view', '-i', `${line}:1:${texPath()}`, '-o', path.basename(pdfPath())];
  try {
    const { stdout } = await execFileP('synctex', args, { cwd: active.dir, windowsHide: true, timeout: 30000 });
    const m = stdout.match(/Page:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch (_) { return null; }
}

/* ------------------------------------------------------------ insertion -- */
function readingnoteContaining(lines, line1) {
  let depth = 0, start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/\\begin\{readingnote\}/.test(lines[i])) { if (depth === 0) start = i; depth++; }
    if (/\\end\{readingnote\}/.test(lines[i])) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start !== -1 && line1 >= start + 1 && line1 <= i + 1) return { end: i + 1 };
    }
  }
  return null;
}
function insertionIndex(lines, line1) {
  const n = lines.length;
  const isBlank = (l) => /^\s*$/.test(l);
  const isDocEnd = (l) => /^\s*\\end\{document\}/.test(l);
  const isDocBegin = (l) => /^\s*\\begin\{document\}/.test(l);
  // never insert at/after \end{document}
  let docEnd = n;
  for (let k = 0; k < n; k++) if (isDocEnd(lines[k])) { docEnd = k; break; }
  let i = Math.min(Math.max(line1 - 1, 0), n - 1);
  if (i >= docEnd) i = Math.max(0, docEnd - 1);
  if (isBlank(lines[i])) {
    let j = i;
    while (j + 1 < docEnd && isBlank(lines[j])) j++;
    i = j;
    if (isBlank(lines[i]) || i >= docEnd) return docEnd;
  }
  let start = i;
  while (start - 1 >= 0 && !isBlank(lines[start - 1]) && !isDocBegin(lines[start - 1])) start--;
  let end = i;
  while (end + 1 < docEnd && !isBlank(lines[end + 1])) end++;
  return Math.min(end + 1, docEnd);
}

/* ------------------------------------------------------------ llm -- */
const SYSTEM_PROMPT =
  'You are an expert research mathematician helping the reader annotate a mathematics paper ' +
  'with study notes. Each note has (1) a SHORT question title and (2) a self-contained English ' +
  'explanation body. Write rigorously in the paper\'s notation, matching the existing notes: ' +
  '\\textbf{...} sub-headers, \\begin{itemize}/\\begin{enumerate}, $...$ inline math, \\[...\\] or ' +
  '\\begin{aligned} display math. Reference earlier notes by id (e.g. "by Q3"). ' +
  'Do not invent theorem/page numbers or citations. ' +
  'Never emit raw \\input, \\include, \\includegraphics, \\bibliography, \\documentclass or \\usepackage ' +
  'commands in the note body.\n' +
  'ALWAYS write the TITLE and the BODY in English, even if the reader\'s query is in another language.\n\n' +
  'OUTPUT FORMAT (strict):\n' +
  'TITLE: <one concise question; English; plain text with only simple $..$ math; no line breaks; at most ~90 characters>\n' +
  'BODY:\n<the LaTeX note body>';

function historyBlock(entries) {
  if (!entries.length) return '(no previous notes yet)';
  return entries.map((e) => `[${e.id}] ${e.title}\n${e.body}`).join('\n\n---\n\n');
}

function fallbackTitle(q) {
  const t = String(q || '').trim().replace(/\s+/g, ' ');
  if (t && !/^Explain(?:\s*:|$)/i.test(t) && t.length > 3) return t.slice(0, 120);
  return 'Note';
}

/* Escape file-loading / document-structure commands the model may emit as
 * literal text (e.g. `\input`), which would otherwise be EXECUTED by LaTeX. */
function sanitizeExplanation(s) {
  return String(s)
    .replace(/\\input\b/g, '\\texttt{\\textbackslash{}input}')
    .replace(/\\include\b/g, '\\texttt{\\textbackslash{}include}')
    .replace(/\\includeonly\b/g, '\\texttt{\\textbackslash{}includeonly}')
    .replace(/\\includegraphics\b/g, '\\texttt{\\textbackslash{}includegraphics}')
    .replace(/\\bibliography\b/g, '\\texttt{\\textbackslash{}bibliography}')
    .replace(/\\documentclass\b/g, '\\texttt{\\textbackslash{}documentclass}')
    .replace(/\\usepackage\b/g, '\\texttt{\\textbackslash{}usepackage}')
    .replace(/\\begin\{document\}/g, '\\texttt{document}')
    .replace(/\\end\{document\}/g, '\\texttt{document}');
}

function parseTitleBody(raw, fallbackQ) {
  const r = String(raw || '');
  const m = r.match(/^\s*TITLE\s*:\s*([\s\S]*?)^\s*BODY\s*:\s*([\s\S]*)$/im);
  if (m) {
    let title = m[1].trim().replace(/\s+/g, ' ').replace(/^[*`#\s]+|[*`#\s]+$/g, '');
    let body = m[2].trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
    if (!title) title = fallbackTitle(fallbackQ);
    return { title, body };
  }
  return { title: fallbackTitle(fallbackQ), body: r.trim() };
}

async function explain({ question, selectedText, context, thinking }) {
  const apiKey = readApiKey();
  if (!apiKey) return { error: 'DEEPSEEK_API_KEY not found (set env or ~/.dsh/.credentials.yaml)' };

  const nb = loadNotebook();
  const hist = historyBlock(nb.entries);
  const dm = ensureDocMeta() || {};
  const docBlock =
    (dm.title ? 'Title: ' + dm.title + '\n' : '') +
    (dm.sections && dm.sections.length ? 'Sections: ' + dm.sections.join(' | ') + '\n' : '') +
    (dm.notation && dm.notation.length ? 'Notation:\n' + dm.notation.join('\n') + '\n' : '') +
    (dm.skeleton && dm.skeleton.length ? 'Paper skeleton (statements, no proofs):\n' + dm.skeleton.join('\n') + '\n' : '');

  const user =
    'DOCUMENT CONTEXT (stable):\n' + docBlock + '\n' +
    'EXISTING NOTES IN THIS NOTEBOOK (stable context — reference them, do not repeat them):\n' +
    '<<<\n' + hist + '\n>>>\n\n' +
    '==== NEW QUESTION ====\n' +
    'Passage selected in the PDF:\n<<<\n' + selectedText + '\n>>>\n\n' +
    'Surrounding LaTeX source (for notation/definitions):\n<<<\n' + context + '\n>>>\n\n' +
    'Reader\'s query (may be rough, in any language — turn it into a sharp, short English question):\n' + question + '\n\n' +
    'Respond with TITLE then BODY as instructed.';

  const base = activeProvider().baseURL.replace(/\/+$/, '');

  async function attempt(withThinking) {
    const prov = activeProvider();
    const body = {
      model: llmModel(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user }
      ],
      stream: false,
      temperature: withThinking ? undefined : 0.3
    };
    if (prov.name === 'cstcloud') {
      body.chat_template_kwargs = { thinking: !!withThinking };
      body.max_length = prov.maxOutputTokens || 8000;
    } else {
      body.max_tokens = prov.maxOutputTokens || 8000;
      if (withThinking) {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = 'high';
      } else {
        body.thinking = { type: 'disabled' };
      }
    }
    let res;
    try {
      res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300000)
      });
    } catch (e) {
      return { error: 'DeepSeek request failed: ' + String(e && (e.message || e)) };
    }
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      return { error: `DeepSeek HTTP ${res.status}: ${(data && data.error && data.error.message) || res.statusText}` };
    }
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const parsed = parseTitleBody(msg.content, question);
    return {
      title: parsed.title,
      explanation: parsed.body,
      reasoning: (msg.reasoning_content || '').trim(),
      usage: data.usage || null,
      model: llmModel()
    };
  }

  let r = await attempt(thinking);
  if (!r.error && !r.explanation) {
    // empty body (occasionally happens in thinking mode) — retry once without thinking
    r = await attempt(false);
  }
  if (!r.error && !r.explanation) {
    return { error: 'the model returned an empty answer — please try again' };
  }
  return r;
}

/* ------------------------------------------------------------ compile -- */
async function compile() {
  const tex = texPath();
  const args = ['-pdf', '-interaction=nonstopmode', '-synctex=1', '-quiet', tex];
  try {
    const { stdout, stderr } = await execFileP('latexmk', args, {
      cwd: active.dir, windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024
    });
    return { ok: true, out: (stdout || '') + '\n' + (stderr || '') };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + '\n' + (e.stderr || '') + '\n' + String(e.message || '') };
  }
}

/* ============================================================ http server -- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf', '.png': 'image/png', '.woff2': 'font/woff2'
};
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, filePath) {
  const safe = path.normalize(filePath);
  if (!safe.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(safe, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(safe).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(buf);
  });
}

function stateForActive() {
  if (!active) return null;
  const meta = readTex();
  const nb = loadNotebook();
  const entries = nb.entries;
  return {
    dir: active.dir,
    texFile: active.texFile,
    pdfName: path.basename(pdfPath()),
    provider: activeProviderName(),
    model: llmModel(),
    nextQ: maxQ(entries, meta.lines) + 1,
    entries: entries.map((e) => ({ id: e.id, title: e.title, line: e.line, page: e.page, inTex: e.inTex !== false, body: e.body || '' }))
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') return serveStatic(req, res, path.join(PUBLIC, 'index.html'));
    if (p === '/app.js') return serveStatic(req, res, path.join(PUBLIC, 'app.js'));
    if (p === '/style.css') return serveStatic(req, res, path.join(PUBLIC, 'style.css'));
    if (p === '/texrender.js') return serveStatic(req, res, path.join(PUBLIC, 'texrender.js'));
    if (p.startsWith('/vendor/')) return serveStatic(req, res, path.join(PUBLIC, 'vendor', p.slice('/vendor/'.length)));
    if (p === '/pdf') {
      if (!active) return sendJSON(res, 404, { error: 'no active notebook' });
      return fs.readFile(pdfPath(), (err, buf) => {
        if (err) { res.writeHead(404); res.end('pdf not found'); return; }
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(buf);
      });
    }

    if (p === '/api/notebooks' && req.method === 'GET') {
      return sendJSON(res, 200, { active: active ? { dir: active.dir, texFile: active.texFile } : null, list: registry.list });
    }

    if (p === '/api/providers' && req.method === 'GET') {
      const list = Object.keys(config.providers).map((name) => {
        const pr = config.providers[name];
        const k = providerKey(pr);
        return {
          name, model: pr.model, baseURL: pr.baseURL,
          hasKey: !!k,
          maskedKey: maskKey(k),
          source: pr.apiKey ? 'apiKey' : (pr.credentialsFile ? 'credentialsFile' : '')
        };
      });
      return sendJSON(res, 200, { active: activeProviderName(), list });
    }

    if (p === '/api/set-apikey' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.provider || '').trim();
      const key = String(b.apiKey || '').trim();
      if (!config.providers[name]) return sendJSON(res, 400, { error: 'unknown provider: ' + name });
      if (!key) return sendJSON(res, 400, { error: 'apiKey is empty' });
      config.providers[name].apiKey = key;
      saveConfig();
      const masked = key.length > 8 ? key.slice(0, 4) + '…' + key.slice(-4) : '••••';
      return sendJSON(res, 200, { ok: true, provider: name, maskedKey: masked });
    }

    if (p === '/api/switch-provider' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.provider || '').trim();
      if (!config.providers[name]) return sendJSON(res, 400, { error: 'unknown provider: ' + name });
      config.activeProvider = name;
      saveConfig();
      return sendJSON(res, 200, { active: name, model: llmModel() });
    }

    if (p === '/api/open-folder' && req.method === 'POST') {
      const b = await readBody(req);
      const dir = String(b.dir || '').trim().replace(/["']/g, '');
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return sendJSON(res, 400, { error: 'folder does not exist: ' + dir });
      }
      let texFile = String(b.texFile || '').trim();
      if (!texFile) texFile = detectTex(dir);
      else if (!fs.existsSync(path.join(dir, texFile))) texFile = detectTex(dir);
      if (!texFile) return sendJSON(res, 400, { error: 'no .tex file found in ' + dir });

      let nb = registry.list.find((n) => n.dir === dir && n.texFile === texFile);
      if (!nb) {
        nb = { dir, texFile, addedAt: new Date().toISOString() };
        registry.list.unshift(nb);
      }
      registry.active = { dir, texFile };
      active = nb;
      saveRegistry(registry);

      // seed notebook state from existing readingnote blocks if absent
      if (!fs.existsSync(noteFile())) {
        const meta = readTex();
        saveNotebook({ version: 1, entries: parseReadingNotes(meta.lines), docMeta: extractDocMeta(meta.lines) });
      } else {
        const nb2 = loadNotebook();
        if (!nb2.docMeta) { nb2.docMeta = extractDocMeta(readTex().lines); saveNotebook(nb2); }
      }
      // enrich missing page numbers via forward synctex (best-effort, every open)
      {
        const nb2 = loadNotebook();
        let changed = false;
        for (const e of nb2.entries) {
          if (e.page == null && e.line) {
            const pg = await synctexForward(e.line);
            if (pg != null) { e.page = pg; changed = true; }
          }
        }
        if (changed) saveNotebook(nb2);
      }

      // compile a fresh document once so it has a PDF + synctex to select from
      if (!fs.existsSync(pdfPath())) {
        await compile();
      }

      const st = stateForActive();
      st.texFiles = listTexFiles(dir);
      return sendJSON(res, 200, st);
    }

    if (p === '/api/remove-notebook' && req.method === 'POST') {
      const b = await readBody(req);
      registry.list = registry.list.filter((n) => !(n.dir === b.dir && n.texFile === b.texFile));
      if (registry.active && registry.active.dir === b.dir && registry.active.texFile === b.texFile) {
        registry.active = null; active = null;
      }
      saveRegistry(registry);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/state' && req.method === 'GET') {
      if (!active) return sendJSON(res, 404, { error: 'no active notebook' });
      const st = stateForActive();
      st.texFiles = listTexFiles(active.dir);
      return sendJSON(res, 200, st);
    }

    if (p === '/api/compile' && req.method === 'POST') {
      if (!active) return sendJSON(res, 400, { error: 'no active notebook' });
      const r = await compile();
      const st = stateForActive();
      return sendJSON(res, 200, { ok: r.ok, logTail: r.out.slice(-4000), nextQ: st.nextQ });
    }

    if (p === '/api/explain' && req.method === 'POST') {
      if (!active) return sendJSON(res, 400, { error: 'no active notebook' });
      const b = await readBody(req);
      const page = Number(b.page), x = Number(b.x), y = Number(b.y);
      if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) return sendJSON(res, 400, { error: 'invalid page/x/y' });
      let context = '', line = null;
      const st = await synctexEdit(page, x, y);
      if (st.line != null) {
        line = st.line;
        const targetFile = (st.input && fs.existsSync(st.input)) ? path.normalize(st.input) : texPath();
        context = paragraphContext(readTexFile(targetFile).lines, st.line);
      }
      const r = await explain({
        question: String(b.question || '').slice(0, 2000),
        selectedText: String(b.selectedText || '').slice(0, 4000),
        context, thinking: !!b.thinking
      });
      if (r.error) return sendJSON(res, 502, r);
      return sendJSON(res, 200, Object.assign({ line, historyCount: loadNotebook().entries.length }, r));
    }

    if (p === '/api/insert' && req.method === 'POST') {
      if (!active) return sendJSON(res, 400, { error: 'no active notebook' });
      const b = await readBody(req);
      const writeToTex = b.writeToTex !== false;   // default: write into the .tex
      const title = String(b.title || '').replace(/\s*\r?\n\s*/g, ' ').trim();
      let explanation = String(b.explanation || '').trim();
      if (!title || !explanation) return sendJSON(res, 400, { error: 'title and explanation are required' });

      const nb = loadNotebook();
      const meta = readTex();
      const qid = 'Q' + (maxQ(nb.entries, meta.lines) + 1);

      explanation = sanitizeExplanation(explanation
        .replace(/^\s*\\begin\{readingnote\}(?:\[[^\]]*\])?(?:\{[^}]*\})?\s*/i, '')
        .replace(/\s*\\end\{readingnote\}\s*$/i, ''));

      let insertedLine = null, page = null, x = null, y = null, logTail = '', ok = true;
      if (writeToTex) {
        page = Number(b.page); x = Number(b.x); y = Number(b.y);
        if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
          return sendJSON(res, 400, { error: 'invalid page/x/y' });
        }
        const st = await synctexEdit(page, x, y);
        if (st.line == null) return sendJSON(res, 400, { error: 'synctex mapping failed: ' + (st.error || st.raw || 'no line') });

        let targetFile = texPath();
        if (st.input && fs.existsSync(st.input)) targetFile = path.normalize(st.input);
        const isMain = sameFile(targetFile, texPath());

        const mainMeta = readTex();
        const mainPkg = ensureReadingnotePackage(mainMeta.lines);
        if (mainPkg.added) writeTex(mainPkg.lines, mainMeta);

        const tMeta = readTexFile(targetFile);
        const lines = tMeta.lines;
        const effLine = st.line + (isMain && mainPkg.added ? 1 : 0);

        const inside = readingnoteContaining(lines, effLine);
        const idx = inside ? inside.end : insertionIndex(lines, effLine);

        const block = ['\\begin{readingnote}[' + qid + ']{' + title + '}']
          .concat(explanation.split(/\r?\n/))
          .concat(['\\end{readingnote}']);
        const before = lines.slice(0, idx);
        const after = lines.slice(idx);
        while (before.length && !/^\s*$/.test(before[before.length - 1])) before.push('');
        while (after.length && !/^\s*$/.test(after[0])) after.unshift('');
        writeTexFile(targetFile, before.concat(block, after), tMeta);
        insertedLine = before.length + 1;

        const compiled = await compile();
        ok = compiled.ok;
        logTail = compiled.out.slice(-4000);
      } else {
        page = Number(b.page); x = Number(b.x); y = Number(b.y);
        if (!Number.isFinite(page)) page = null;
        if (!Number.isFinite(x)) x = null;
        if (!Number.isFinite(y)) y = null;
        logTail = '(saved to notebook only — not written to the .tex)';
      }

      nb.entries.push({ id: qid, title, body: explanation, line: insertedLine, page, x, y, inTex: writeToTex, ts: new Date().toISOString() });
      saveNotebook(nb);

      const nextQ = maxQ(nb.entries, writeToTex ? readTex().lines : meta.lines) + 1;
      return sendJSON(res, 200, { ok, qid, insertedLine, writeToTex, logTail, nextQ, historyCount: nb.entries.length });
    }

    if (p === '/api/annotate' && req.method === 'POST') {
      // one-shot: select a passage + type a question -> explain + insert + compile
      if (!active) return sendJSON(res, 400, { error: 'no active notebook' });
      const b = await readBody(req);
      const thinking = !!b.thinking;
      const writeToTex = b.writeToTex !== false;
      const question = String(b.question || '').trim();
      const selectedText = String(b.selectedText || '').slice(0, 4000);
      const page = Number(b.page), x = Number(b.x), y = Number(b.y);
      if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
        return sendJSON(res, 400, { error: 'invalid page/x/y' });
      }

      const meta = readTex();
      let context = '', line = null;
      const st = await synctexEdit(page, x, y);
      if (st.line != null) {
        line = st.line;
        const ctxFile = (st.input && fs.existsSync(st.input)) ? path.normalize(st.input) : texPath();
        context = paragraphContext(readTexFile(ctxFile).lines, st.line);
      }

      const r = await explain({ question, selectedText, context, thinking });
      if (r.error) return sendJSON(res, 502, r);

      const nb = loadNotebook();
      const qid = 'Q' + (maxQ(nb.entries, meta.lines) + 1);
      const title = r.title;
      const explanation = sanitizeExplanation(r.explanation
        .replace(/^\s*\\begin\{readingnote\}(?:\[[^\]]*\])?(?:\{[^}]*\})?\s*/i, '')
        .replace(/\s*\\end\{readingnote\}\s*$/i, ''));

      let insertedLine = null, logTail = '', ok = true;
      if (writeToTex) {
        if (st.line == null) return sendJSON(res, 400, { error: 'synctex mapping failed: ' + (st.error || st.raw || 'no line') });

        // the file synctex says holds the text (main file or an \input/\include sub-file)
        let targetFile = texPath();
        if (st.input && fs.existsSync(st.input)) targetFile = path.normalize(st.input);
        const isMain = sameFile(targetFile, texPath());

        // 1) \usepackage{readingnote} goes ONLY in the main (compiled) file
        const mainMeta = readTex();
        const mainPkg = ensureReadingnotePackage(mainMeta.lines);
        if (mainPkg.added) writeTex(mainPkg.lines, mainMeta);

        // 2) insert the note into the file that actually contains the text
        const tMeta = readTexFile(targetFile);
        const lines = tMeta.lines;
        const effLine = st.line + (isMain && mainPkg.added ? 1 : 0);
        const inside = readingnoteContaining(lines, effLine);
        const idx = inside ? inside.end : insertionIndex(lines, effLine);
        const block = ['\\begin{readingnote}[' + qid + ']{' + title + '}']
          .concat(explanation.split(/\r?\n/))
          .concat(['\\end{readingnote}']);
        const before = lines.slice(0, idx);
        const after = lines.slice(idx);
        while (before.length && !/^\s*$/.test(before[before.length - 1])) before.push('');
        while (after.length && !/^\s*$/.test(after[0])) after.unshift('');
        writeTexFile(targetFile, before.concat(block, after), tMeta);
        insertedLine = before.length + 1;

        // 3) compile the MAIN file (it pulls in the sub-files)
        const compiled = await compile();
        ok = compiled.ok;
        logTail = compiled.out.slice(-4000);
      } else {
        logTail = '(saved to notebook only — not written to the .tex)';
      }

      nb.entries.push({ id: qid, title, body: explanation, line: insertedLine, page, x, y, inTex: writeToTex, ts: new Date().toISOString() });
      saveNotebook(nb);

      return sendJSON(res, 200, {
        ok, qid, title, explanation, reasoning: r.reasoning, usage: r.usage, insertedLine, writeToTex, logTail,
        nextQ: maxQ(nb.entries, writeToTex ? readTex().lines : meta.lines) + 1,
        historyCount: nb.entries.length
      });
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    sendJSON(res, 500, { error: String(e && (e.stack || e.message) || e) });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`texnote-reader running at http://127.0.0.1:${config.port}`);
  console.log(`provider: ${activeProviderName()}  model: ${llmModel()}`);
});
