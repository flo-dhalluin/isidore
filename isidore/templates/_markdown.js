// --------------------------------------------------------------- markdown
// A tiny, dependency-free Markdown renderer. Text is HTML-escaped before it
// is formatted and unsafe URL schemes are refused, so agent output can never
// inject markup into the page.
function mdSafeUrl(url) {
  const raw = String(url).replace(/&amp;/g, "&").trim();
  return /^\s*(javascript|vbscript|data):/i.test(raw) ? "#" : url;
}

function mdEmphasis(text) {
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  return text;
}

function mdInline(text) {
  text = esc(text);
  // Code spans and generated tags are stashed behind placeholders so the
  // emphasis rules cannot reach inside them (e.g. the ``_`` in ``_blank``).
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return "\u0000X" + (stash.length - 1) + "\u0000";
  };
  text = text.replace(/`([^`]+)`/g, (m, code) => keep("<code>" + code + "</code>"));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) =>
    keep('<img src="' + mdSafeUrl(src) + '" alt="' + mdEmphasis(alt) + '" loading="lazy">'));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) =>
    keep('<a href="' + mdSafeUrl(href) + '" target="_blank" rel="noopener noreferrer">' + mdEmphasis(label) + "</a>"));
  text = text.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (m, url) =>
    keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>"));
  text = mdEmphasis(text);
  text = text.replace(/\n/g, "<br>");
  text = text.replace(/\u0000X(\d+)\u0000/g, (m, i) => stash[+i]);
  return text;
}

function mdList(lines, start) {
  const first = lines[start].match(/^( *)([-*+]|\d{1,9}[.)])\s+/);
  const ordered = /\d/.test(first[2]);
  const indent = first[1].length;
  const tag = ordered ? "ol" : "ul";
  const items = [];
  let current = null;
  let i = start;
  const same = (l) => {
    const m = l.match(/^( *)([-*+]|\d{1,9}[.)])\s+/);
    return m && m[1].length === indent && /\d/.test(m[2]) === ordered;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (same(line)) {
      if (current) items.push(current);
      current = [line.replace(/^( *)([-*+]|\d{1,9}[.)])\s+/, "")];
      i++;
    } else if (current && (!line.trim() || /^\s+/.test(line))) {
      current.push(line);
      i++;
    } else {
      break;
    }
  }
  if (current) items.push(current);
  const html = items.map((item) => {
    let inner = mdBlocks(item);
    inner = inner.replace(/^<p>([\s\S]*)<\/p>$/, "$1");
    return "<li>" + inner + "</li>";
  }).join("");
  return {html: "<" + tag + ">" + html + "</" + tag + ">", next: i};
}

function mdTable(lines, start) {
  const cells = (l) => {
    let s = l.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  };
  const head = cells(lines[start]);
  const aligns = cells(lines[start + 1]).map((c) => {
    const left = c.startsWith(":"), right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    rows.push(cells(lines[i]));
    i++;
  }
  const align = (idx) => aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : "";
  const th = head.map((c, idx) => "<th" + align(idx) + ">" + mdInline(c) + "</th>").join("");
  const body = rows.map((r) => "<tr>" + head.map((_, idx) =>
    "<td" + align(idx) + ">" + mdInline(r[idx] || "") + "</td>").join("") + "</tr>").join("");
  return {html: "<table><thead><tr>" + th + "</tr></thead><tbody>" + body + "</tbody></table>", next: i};
}

function mdBlocks(lines) {
  const out = [];
  const blank = (l) => !l.trim();
  const fence = (l) => /^\u0000B\d+\u0000$/.test(l.trim());
  const heading = (l) => /^ {0,3}#{1,6}(\s|$)/.test(l);
  const hr = (l) => /^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
  const quote = (l) => /^ {0,3}>/.test(l);
  const list = (l) => /^ {0,3}([-*+]|\d{1,9}[.)])\s+/.test(l);
  const separator = (l) => /^ {0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    if (fence(line)) { out.push(line.trim()); i++; continue; }
    if (hr(line)) { out.push("<hr>"); i++; continue; }
    let m;
    if ((m = line.match(/^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/))) {
      const level = m[1].length;
      out.push("<h" + level + ">" + mdInline(m[2]) + "</h" + level + ">");
      i++; continue;
    }
    if (quote(line)) {
      const buf = [];
      while (i < lines.length && (quote(lines[i]) ||
             (blank(lines[i]) && i + 1 < lines.length && quote(lines[i + 1])))) {
        buf.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }
      out.push("<blockquote>" + mdBlocks(buf) + "</blockquote>");
      continue;
    }
    if (list(line)) {
      const res = mdList(lines, i);
      out.push(res.html);
      i = res.next;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && separator(lines[i + 1])) {
      const res = mdTable(lines, i);
      out.push(res.html);
      i = res.next;
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && !blank(lines[i]) && !fence(lines[i]) && !heading(lines[i]) &&
           !hr(lines[i]) && !quote(lines[i]) && !list(lines[i]) &&
           !(lines[i].includes("|") && i + 1 < lines.length && separator(lines[i + 1]))) {
      buf.push(lines[i]);
      i++;
    }
    out.push("<p>" + mdInline(buf.join("\n")) + "</p>");
  }
  return out.join("\n");
}

function mdToHtml(src) {
  src = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
  const fences = [];
  src = src.replace(/(^|\n)```([^\n`]*)\n([\s\S]*?)(\n```[ \t]*(?=\n|$)|$)/g, (m, pre, lang, code) => {
    const cls = lang.trim() ? ' class="language-' + esc(lang.trim()) + '"' : "";
    fences.push('<pre class="md-code"><code' + cls + ">" + esc(code) + "</code></pre>");
    return pre + "\u0000B" + (fences.length - 1) + "\u0000";
  });
  const html = mdBlocks(src.split("\n"));
  return html.replace(/\u0000B(\d+)\u0000/g, (m, i) => fences[+i]);
}
