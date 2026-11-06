"""The isidore web UI: the task list plus a full-screen conversation page.

No build step: each page is one self-contained HTML string. Data comes from
the JSON API, so the pages stay small and the server stays stateless.
"""

# Shared styles and script for rendering an agent's Markdown answer as HTML.
# Kept as plain strings (not f-strings/templates) so the braces in the CSS and
# JavaScript need no escaping.
MARKDOWN_CSS = """
  .md { word-break: break-word; }
  .md.preview { max-height: 22rem; overflow: auto; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: .5rem 0; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: .9rem 0 .4rem; line-height: 1.3; }
  .md h1 { font-size: 1.25rem; } .md h2 { font-size: 1.12rem; } .md h3 { font-size: 1rem; }
  .md h4, .md h5, .md h6 { font-size: .95rem; }
  .md ul, .md ol { margin: .5rem 0; padding-left: 1.4rem; }
  .md li { margin: .15rem 0; }
  .md li > p { margin: .25rem 0; }
  .md code { background: rgba(127,127,127,.15); padding: .1em .35em; border-radius: 3px; font-size: .88em; }
  .md pre.md-code { margin: .6rem 0; padding: .6rem; background: rgba(127,127,127,.08); overflow: auto; }
  .md pre.md-code code { background: none; padding: 0; font-size: .85rem; }
  .md blockquote { margin: .5rem 0; padding: .1rem 0 .1rem .8rem; border-left: 3px solid var(--line); color: var(--muted); }
  .md hr { border: 0; border-top: 1px solid var(--line); margin: 1rem 0; }
  .md a { color: var(--accent); }
  .md img { max-width: 100%; }
  .md table { border-collapse: collapse; display: block; overflow: auto; max-width: 100%; margin: .6rem 0; }
  .md th, .md td { border: 1px solid var(--line); padding: .3rem .55rem; text-align: left; }
  .md th { background: rgba(127,127,127,.08); }
"""

MARKDOWN_JS = r"""
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
"""

INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>isidore</title>
<style>
  :root { color-scheme: light dark; --fg:#1b1b1b; --muted:#777; --line:#d8d8d8; --bg:#fff; --accent:#2b6cb0; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --muted:#999; --line:#333; --bg:#111; --accent:#7aa7d8; }
  }
  * { box-sizing: border-box; }
  body { margin: 0 auto; max-width: 860px; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--fg);
         font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  h1 { font-size: 1.1rem; letter-spacing: .18em; text-transform: uppercase; margin: 0 0 .25rem; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; font-size: .85rem; }
  form { border: 1px solid var(--line); padding: 1rem; margin-bottom: 1.5rem; }
  textarea, input { width: 100%; background: transparent; color: inherit; border: 1px solid var(--line);
                    padding: .55rem .6rem; font: inherit; }
  textarea { min-height: 5.5rem; resize: vertical; }
  .row { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: .6rem; align-items: center; }
  .row > * { flex: 1 1 10rem; }
  button { background: var(--accent); color: #fff; border: 0; padding: .55rem .9rem; font: inherit;
           cursor: pointer; flex: 0 0 auto; }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  button:disabled { opacity: .5; cursor: default; }
  .hint { color: var(--muted); font-size: .8rem; margin-top: .4rem; }
  .tasks { display: grid; gap: .6rem; }
  .task { border: 1px solid var(--line); padding: .7rem .8rem; cursor: pointer; }
  .task:hover { border-color: var(--accent); }
  .task header { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; }
  a.plain { color: inherit; text-decoration: none; }
  .id { color: var(--muted); font-size: .8rem; }
  .badge { color: var(--muted); font-size: .75rem; }
  .status { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; }
  .status.succeeded { color: #2f855a; } .status.failed, .status.timeout { color: #c53030; }
  .status.running { color: var(--accent); } .status.cancelled { color: var(--muted); }
  .prompt { margin: .35rem 0 0; white-space: pre-wrap; word-break: break-word; }
  pre { margin: .5rem 0 0; padding: .6rem; background: rgba(127,127,127,.08); overflow: auto;
        max-height: 22rem; white-space: pre-wrap; word-break: break-word; font-size: .82rem; }
  .empty { color: var(--muted); }
  .err { color: #c53030; }
""" + MARKDOWN_CSS + """
</style>
</head>
<body>
<h1>isidore</h1>
<p class="sub">spawn isolated Pi tasks &middot; <span id="count">0</span> total</p>

<form id="run">
  <textarea id="prompt" placeholder="What should the agent do?" required></textarea>
  <div class="row">
    <input id="model" placeholder="model (optional, e.g. openrouter/anthropic/claude-sonnet-4)">
    <button type="submit">Run now</button>
  </div>
</form>

<form id="schedule" hidden>
  <textarea id="sprompt" placeholder="Prompt to run on a schedule" required></textarea>
  <div class="row">
    <input id="at" type="datetime-local" title="one-shot time (local)">
    <input id="every" placeholder="or every (e.g. 30m, 2h, 1d)">
    <button type="submit" class="ghost">Schedule</button>
  </div>
  <p class="hint">Set either a time or an interval. Schedules are handled by the scheduler service.</p>
</form>

<div class="tasks" id="tasks"><p class="empty">Loading…</p></div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const TOKEN = new URLSearchParams(location.search).get("token") || "";
let scheduler = false;

async function api(path, opts) {
  const headers = {"Content-Type": "application/json"};
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  const res = await fetch(path, Object.assign({headers}, opts));
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.status === 204 ? null : res.json();
}

function openTask(id) {
  location.href = "/tasks/" + encodeURIComponent(id) + (TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "");
}

function render(tasks) {
  $("count").textContent = tasks.length;
  if (!tasks.length) { $("tasks").innerHTML = '<p class="empty">No tasks yet.</p>'; return; }
  // One entry per conversation: a follow-up reuses its root task's thread id.
  const threads = new Map();
  for (const t of tasks) {
    const root = t.thread_id || t.id;
    if (!threads.has(root)) threads.set(root, []);
    threads.get(root).push(t);
  }
  $("tasks").innerHTML = [...threads.entries()].map(([root, turns]) => {
    // tasks arrive newest first, so turns[0] is the latest state of the thread.
    const t = turns[0];
    return `
    <article class="task" data-open="${esc(root)}">
      <header>
        <span class="id">${esc(root)}</span>
        <span class="status ${esc(t.status)}">${esc(t.status)}</span>
        ${turns.length > 1 ? `<span class="badge">${turns.length} turns</span>` : ""}
        ${t.exit_code !== null && t.exit_code !== undefined ? `<span class="id">exit ${esc(t.exit_code)}</span>` : ""}
        ${t.done ? `<button class="ghost" data-delete="${esc(root)}">delete</button>` : `<button class="ghost" data-cancel="${esc(t.id)}">cancel</button>`}
      </header>
      <p class="prompt">${esc(t.prompt)}</p>
      ${t.output ? `<div class="md preview">${mdToHtml(t.output)}</div>` : ""}
      ${t.error ? `<pre class="err">${esc(t.error)}</pre>` : ""}
    </article>`;
  }).join("");
  document.querySelectorAll("[data-open]").forEach((el) => {
    el.onclick = () => openTask(el.dataset.open);
  });
  document.querySelectorAll("[data-cancel]").forEach((b) => {
    b.onclick = async (ev) => { ev.stopPropagation(); b.disabled = true; try { await api("/api/tasks/" + b.dataset.cancel + "/cancel", {method: "POST"}); } catch (e) { alert(e.message); } refresh(); };
  });
  document.querySelectorAll("[data-delete]").forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm("Delete this conversation and its workspace?")) return;
      b.disabled = true;
      try { await api("/api/tasks/" + b.dataset.delete, {method: "DELETE"}); } catch (e) { alert(e.message); }
      refresh();
    };
  });
}

async function refresh() {
  try { render(await api("/api/tasks?limit=50")); }
  catch (e) { $("tasks").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

$("run").onsubmit = async (ev) => {
  ev.preventDefault();
  const button = ev.submitter || ev.target.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/tasks", {method: "POST", body: JSON.stringify({prompt: $("prompt").value, model: $("model").value || null})});
    $("prompt").value = "";
    refresh();
  } catch (e) { alert(e.message); }
  finally { button.disabled = false; }
};

$("schedule").onsubmit = async (ev) => {
  ev.preventDefault();
  const button = ev.submitter || ev.target.querySelector("button");
  button.disabled = true;
  try {
    const at = $("at").value ? new Date($("at").value).toISOString() : null;
    await api("/api/schedules", {method: "POST", body: JSON.stringify({prompt: $("sprompt").value, at, every: $("every").value || null})});
    $("sprompt").value = ""; $("at").value = ""; $("every").value = "";
    alert("Scheduled.");
  } catch (e) { alert(e.message); }
  finally { button.disabled = false; }
};

(async () => {
  try {
    const info = await api("/api/info");
    scheduler = !!info.scheduler;
    $("schedule").hidden = !scheduler;
  } catch (e) { /* ignore */ }
  refresh();
  setInterval(refresh, 3000);
})();

""" + MARKDOWN_JS + """
</script>
</body>
</html>
"""

TASK_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>isidore · task</title>
<style>
  :root { color-scheme: light dark; --fg:#1b1b1b; --muted:#777; --line:#d8d8d8; --bg:#fff; --accent:#2b6cb0; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --muted:#999; --line:#333; --bg:#111; --accent:#7aa7d8; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100dvh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg);
         font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header.bar { display: flex; gap: .8rem; align-items: baseline; flex-wrap: wrap;
               padding: .7rem 1rem; border-bottom: 1px solid var(--line); }
  header.bar h1 { font-size: 1rem; letter-spacing: .18em; text-transform: uppercase; margin: 0; }
  header.bar .spacer { flex: 1; }
  .id { color: var(--muted); font-size: .8rem; }
  .badge { color: var(--muted); font-size: .75rem; }
  .status { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; }
  .status.succeeded { color: #2f855a; } .status.failed, .status.timeout { color: #c53030; }
  .status.running { color: var(--accent); } .status.cancelled, .status.queued { color: var(--muted); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  main { flex: 1; overflow: auto; }
  .inner { max-width: 860px; margin: 0 auto; padding: 1.5rem 1rem 2rem; display: grid; gap: 1.2rem; }
  .turn { border-top: 1px solid var(--line); padding-top: 1rem; }
  .turn:first-child { border-top: 0; padding-top: 0; }
  .who { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .1em; }
  .prompt { margin: .3rem 0 0; white-space: pre-wrap; word-break: break-word; }
  pre { margin: .6rem 0 0; padding: .6rem; background: rgba(127,127,127,.08); overflow: auto;
        white-space: pre-wrap; word-break: break-word; font-size: .85rem; }
  .foot { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; margin-top: .5rem; }
  .empty { color: var(--muted); }
  .err { color: #c53030; }
  form { border-top: 1px solid var(--line); padding: .8rem 1rem; }
  .composer { max-width: 860px; margin: 0 auto; }
  textarea { width: 100%; background: transparent; color: inherit; border: 1px solid var(--line);
             padding: .55rem .6rem; font: inherit; min-height: 3.4rem; max-height: 12rem; resize: vertical; }
  .row { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: .6rem; align-items: center; }
  .row .grow { flex: 1 1 12rem; }
  button { background: var(--accent); color: #fff; border: 0; padding: .55rem .9rem; font: inherit; cursor: pointer; }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  button.danger { background: transparent; color: #c53030; border: 1px solid var(--line); }
  button:disabled { opacity: .5; cursor: default; }
  .hint { color: var(--muted); font-size: .8rem; margin-top: .4rem; }
""" + MARKDOWN_CSS + """
</style>
</head>
<body>
<header class="bar">
  <h1>isidore</h1>
  <a id="back" href="/">← tasks</a>
  <span class="spacer"></span>
  <span class="id" id="root"></span>
  <span class="status" id="status"></span>
  <button class="ghost" id="cancel" hidden>cancel</button>
  <button class="danger" id="delete" hidden>delete</button>
</header>

<main><div class="inner" id="turns"><p class="empty">Loading…</p></div></main>

<form id="ask">
  <div class="composer">
    <textarea id="prompt" placeholder="Follow-up question…" required></textarea>
    <div class="row">
      <input class="grow" id="model" placeholder="model override (optional)">
      <button type="submit" id="send">Send</button>
    </div>
    <p class="hint" id="hint"></p>
  </div>
</form>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const TOKEN = new URLSearchParams(location.search).get("token") || "";
const ROOT = decodeURIComponent(location.pathname.replace(/^\\/tasks\\//, "").replace(/\\/+$/, ""));
if (TOKEN) { $("back").href = "/?token=" + encodeURIComponent(TOKEN); }

async function api(path, opts) {
  const headers = {"Content-Type": "application/json"};
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  const res = await fetch(path, Object.assign({headers}, opts));
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.status === 204 ? null : res.json();
}

let lastSig = null;
let lastTurns = 0;

function turn(task) {
  return `
    <article class="turn">
      <span class="who">you</span>
      <p class="prompt">${esc(task.prompt)}</p>
      ${task.output ? `<div class="md">${mdToHtml(task.output)}</div>` : ""}
      ${task.error ? `<pre class="err">${esc(task.error)}</pre>` : ""}
      <div class="foot">
        <span class="status ${esc(task.status)}">${esc(task.status)}</span>
        <span class="badge">${esc(task.id)}</span>
        ${task.exit_code !== null && task.exit_code !== undefined ? `<span class="badge">exit ${esc(task.exit_code)}</span>` : ""}
      </div>
    </article>`;
}

function render(data) {
  $("root").textContent = data.id;
  const last = data.turns[data.turns.length - 1];
  $("status").textContent = last ? last.status : "";
  $("status").className = "status " + (last ? last.status : "");
  const running = data.running;
  $("cancel").hidden = !running;
  if (running && last) $("cancel").dataset.id = last.id;
  $("delete").hidden = running || !data.turns.length;
  $("send").disabled = running;
  $("hint").textContent = running ? "waiting for the current turn to finish…" : "answers keep this conversation's workspace and session";
  // Re-render only when something changed, so reading/scrolling is not disturbed.
  const sig = data.turns.map((t) => [t.id, t.status, t.output.length, t.error || ""].join(":")).join("|");
  if (sig === lastSig) return;
  const main = document.querySelector("main");
  const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
  $("turns").innerHTML = data.turns.map(turn).join("");
  if (data.turns.length !== lastTurns || atBottom || running) main.scrollTop = main.scrollHeight;
  lastSig = sig;
  lastTurns = data.turns.length;
}

async function refresh() {
  try { render(await api("/api/tasks/" + encodeURIComponent(ROOT) + "/thread")); }
  catch (e) { $("turns").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

$("ask").onsubmit = async (ev) => {
  ev.preventDefault();
  const text = $("prompt").value.trim();
  if (!text) return;
  const data = await api("/api/tasks/" + encodeURIComponent(ROOT) + "/thread");
  const last = data.turns[data.turns.length - 1];
  if (!last || data.running) return;
  $("send").disabled = true;
  try {
    await api("/api/tasks/" + encodeURIComponent(last.id) + "/followup",
      {method: "POST", body: JSON.stringify({prompt: text, model: $("model").value || null})});
    $("prompt").value = "";
    refresh();
  } catch (e) { alert(e.message); }
  finally { $("send").disabled = false; }
};

$("cancel").onclick = async () => {
  const id = $("cancel").dataset.id;
  if (!id) return;
  try { await api("/api/tasks/" + encodeURIComponent(id) + "/cancel", {method: "POST"}); } catch (e) { alert(e.message); }
  refresh();
};

$("delete").onclick = async () => {
  if (!confirm("Delete this conversation and its workspace?")) return;
  try {
    await api("/api/tasks/" + encodeURIComponent(ROOT), {method: "DELETE"});
    location.href = "/" + (TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "");
  } catch (e) { alert(e.message); }
};

refresh();
setInterval(refresh, 2000);

""" + MARKDOWN_JS + """
</script>
</body>
</html>
"""
