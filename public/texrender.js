/*
 * texrender.js — render a LaTeX *note body* fragment to HTML via KaTeX.
 * Handles the constructs the readingnote bodies use:
 *   $..$, \[..\], $$..$$, \begin{aligned/equation/...}, \textbf{}, \emph{},
 *   \begin{itemize/enumerate}/\item, \par, \\, quotes/dashes.
 * It is a pragmatic renderer, not a full LaTeX engine.
 *
 * UMD: browser -> window.texToHtml ; Node -> module.exports (for testing).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('katex'));
  } else {
    root.texToHtml = factory(root.katex);
  }
})(typeof self !== 'undefined' ? self : this, function (katex) {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function texToHtml(src) {
    var math = [];
    var stash = function (html) { math.push(html); return '\u0000' + (math.length - 1) + '\u0000'; };

    var render = function (t, dm) {
      try { return katex.renderToString(t, { throwOnError: false, displayMode: !!dm }); }
      catch (e) { return escapeHtml(t); }
    };

    // ---- inline renderer (text with $..$ and \textbf etc., already HTML-safe) ----
    function inline(seg) {
      var s = String(seg);
      s = s.replace(/\$([^$\n]+?)\$/g, function (m, t) { return stash(render(t, false)); });
      // literal-char fixes BEFORE HTML-escaping (so `` and '' still match)
      s = s.replace(/---/g, '\u2014').replace(/--/g, '\u2013');
      s = s.replace(/``/g, '\u201c').replace(/''/g, '\u201d');
      s = s.replace(/(^|[^\\])\\&/g, '$1&');
      s = s.replace(/\\%/g, '%').replace(/\\#/g, '#').replace(/\\_/g, '_');
      s = s.replace(/~/g, ' ');
      s = escapeHtml(s);
      s = s.replace(/\\textbf\{([^{}]*)\}/g, '<strong>$1</strong>');
      s = s.replace(/\\emph\{([^{}]*)\}/g, '<em>$1</em>');
      s = s.replace(/\\textit\{([^{}]*)\}/g, '<i>$1</i>');
      s = s.replace(/\\texttt\{([^{}]*)\}/g, '<code>$1</code>');
      s = s.replace(/\\text\{([^{}]*)\}/g, '$1');
      s = s.replace(/\\mathrm\{([^{}]*)\}/g, '$1');
      s = s.replace(/\\operatorname\{([^{}]*)\}/g, '$1');
      s = s.replace(/\\cite(?:\[[^\]]*\])?\{([^}]*)\}/g, '[$1]');
      s = s.replace(/\\eqref\{([^}]*)\}/g, '($1)');
      s = s.replace(/\\ref\{([^}]*)\}/g, '($1)');
      s = s.replace(/\\label\{[^}]*\}/g, '');
      return s;
    }

    var s = String(src || '');

    // ---- 1. protect display math (multi-line safe) ----
    var denv = 'aligned|alignedat|gathered|split|cases|equation\\*?|align\\*?|multline\\*?|gather\\*?|array|pmatrix|bmatrix|vmatrix|Bmatrix|matrix|smallmatrix';
    s = s.replace(new RegExp('\\\\begin\\{(' + denv + ')\\}[\\s\\S]*?\\\\end\\{\\1\\}', 'g'), function (m) { return stash(render(m, true)); });
    s = s.replace(/\\\[[\s\S]*?\\\]/g, function (m) { return stash(render(m.slice(2, -2), true)); });
    s = s.replace(/\$\$[\s\S]*?\$\$/g, function (m) { return stash(render(m.slice(2, -2), true)); });

    // ---- 2. line / block parser ----
    var lines = s.split(/\r?\n/);
    var out = [];
    var para = [];
    var listStack = [];

    function flushPara() {
      if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line === '\\begin{itemize}') { flushPara(); listStack.push('ul'); out.push('<ul>'); continue; }
      if (line === '\\end{itemize}') { flushPara(); listStack.pop(); out.push('</ul>'); continue; }
      if (line === '\\begin{enumerate}') { flushPara(); listStack.push('ol'); out.push('<ol>'); continue; }
      if (line === '\\end{enumerate}') { flushPara(); listStack.pop(); out.push('</ol>'); continue; }
      if (/^\\item\b/.test(line)) { flushPara(); out.push('<li>' + inline(line.replace(/^\\item\s*/, '')) + '</li>'); continue; }
      if (line === '') { flushPara(); continue; }
      para.push(line.replace(/\\\\$/, '<br>'));
    }
    flushPara();

    var html = out.join('').replace(/(?:\s*<br>)*$/, '');
    // ---- 3. restore stashed math ----
    html = html.replace(/\u0000(\d+)\u0000/g, function (m, idx) { return math[+idx]; });
    return html;
  }

  return texToHtml;
});
