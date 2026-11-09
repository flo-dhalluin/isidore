"""Minimal read-only scheduler page (the MCP tools are the main interface)."""

INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>scheduler</title>
<style>
  :root { color-scheme: light dark; --fg:#1b1b1b; --muted:#777; --line:#d8d8d8; --bg:#fff; --accent:#2b6cb0; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --muted:#999; --line:#333; --bg:#111; --accent:#7aa7d8; } }
  * { box-sizing: border-box; }
  body { margin: 0 auto; max-width: 860px; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--fg);
         font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  h1 { font-size: 1.1rem; letter-spacing: .18em; text-transform: uppercase; margin: 0 0 .25rem; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; font-size: .85rem; }
  .s { border: 1px solid var(--line); padding: .7rem .8rem; margin-bottom: .6rem; }
  .s header { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; }
  .id { color: var(--muted); font-size: .8rem; }
  .mode { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); }
  .prompt { margin: .35rem 0 0; white-space: pre-wrap; word-break: break-word; }
  .meta { color: var(--muted); font-size: .8rem; margin-top: .3rem; }
  button { background: transparent; color: var(--fg); border: 1px solid var(--line); padding: .3rem .6rem;
           font: inherit; cursor: pointer; }
  .empty { color: var(--muted); }
  .err { color: #c53030; }
</style>
</head>
<body>
<h1>scheduler</h1>
<p class="sub">one-shot and recurring isidore tasks</p>
<div id="list"><p class="empty">Loading…</p></div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const TOKEN = new URLSearchParams(location.search).get("token") || "";
async function api(path, opts) {
  const headers = {"Content-Type": "application/json"};
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  const res = await fetch(path, Object.assign({headers}, opts));
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.status === 204 ? null : res.json();
}
function render(items) {
  if (!items.length) { $("list").innerHTML = '<p class="empty">No schedules.</p>'; return; }
  $("list").innerHTML = items.map((s) => `
    <article class="s">
      <header>
        <span class="id">${esc(s.id)}</span>
        <span class="mode">${esc(s.mode)}</span>
        <span class="id">${s.enabled ? "enabled" : "done"}</span>
        <button data-cancel="${esc(s.id)}">cancel</button>
      </header>
      <p class="prompt">${esc(s.prompt)}</p>
      <p class="meta">${s.mode === "once" ? "at " + esc(s.at) : "every " + esc(s.every) + "s"}
        &middot; next ${esc(s.next_run || "—")} &middot; runs ${esc(s.runs)}
        ${s.last_error ? `&middot; <span class="err">${esc(s.last_error)}</span>` : ""}</p>
    </article>`).join("");
  document.querySelectorAll("[data-cancel]").forEach((b) => {
    b.onclick = async () => { b.disabled = true; try { await api("/api/schedules/" + b.dataset.cancel, {method: "DELETE"}); } catch (e) { alert(e.message); } refresh(); };
  });
}
async function refresh() {
  try { render((await api("/api/schedules")).schedules); }
  catch (e) { $("list").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
"""
