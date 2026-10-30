// Page outline for the model: landmarks, headings, short text, and every
// interactive element tagged with a ref ("e12") that the tools resolve back to
// the element through window.__mcpRefs. Open shadow roots are traversed;
// iframes are listed but not entered.
//
// arguments[0] = max text length per line
const maxText = arguments[0] || 160;

const old = window.__mcpRefs;
if (old) for (const el of old.values()) el.removeAttribute?.("data-mcp-ref");
const refs = new Map();
window.__mcpRefs = refs;
let counter = 0;

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD", "svg", "SVG", "PATH"]);
const CONTAINERS = {
  NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo",
  ASIDE: "complementary", FORM: "form", DIALOG: "dialog", TABLE: "table",
  UL: "list", OL: "list", FIELDSET: "group", SECTION: null, ARTICLE: "article",
};
const INTERACTIVE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton", "treeitem",
]);

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const cut = (s, n = maxText) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const q = (s) => JSON.stringify(cut(clean(s)));

function visible(el) {
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
  const st = getComputedStyle(el);
  return st.display !== "none" && st.visibility !== "hidden" && el.getClientRects().length > 0;
}

function roleOf(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.split(" ")[0];
  const tag = el.tagName;
  if (tag === "A") return el.hasAttribute("href") ? "link" : null;
  if (tag === "BUTTON" || tag === "SUMMARY") return "button";
  if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    if (t === "hidden") return null;
    if (["button", "submit", "reset", "image"].includes(t)) return "button";
    if (t === "checkbox" || t === "radio") return t;
    if (t === "range") return "slider";
    if (t === "number") return "spinbutton";
    if (t === "search") return "searchbox";
    if (t === "file") return "file";
    return "textbox";
  }
  if (el.isContentEditable && !el.parentElement?.isContentEditable) return "textbox";
  if (/^H[1-6]$/.test(tag)) return "heading";
  if (tag === "IMG") return "img";
  return null;
}

function nameOf(el) {
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
    if (clean(t)) return t;
  }
  const aria = el.getAttribute("aria-label");
  if (clean(aria)) return aria;
  if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.innerText).join(" ");
  if (el.tagName === "IMG") return el.alt || el.title || "";
  if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return el.value || el.type;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return el.placeholder || el.title || el.name || "";
  return el.innerText || el.title || el.querySelector?.("img[alt]")?.alt || "";
}

function interactive(el, role) {
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (role === "file") return true;
  return el.hasAttribute("onclick") || (el.tabIndex >= 0 && el.hasAttribute("tabindex"));
}

function describe(el, role) {
  const attrs = [];
  if (el.disabled || el.getAttribute("aria-disabled") === "true") attrs.push("disabled");
  if (role === "checkbox" || role === "radio" || role === "switch")
    attrs.push(el.checked || el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked");
  if (el.getAttribute("aria-expanded")) attrs.push(`expanded=${el.getAttribute("aria-expanded")}`);
  if (el.getAttribute("aria-selected") === "true") attrs.push("selected");
  if (el.required) attrs.push("required");
  if (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset"].includes(el.type)) {
    if (el.type && el.type !== "text") attrs.push(`type=${el.type}`);
    if (el.value) attrs.push(`value=${q(el.type === "password" ? "•••" : el.value)}`);
  }
  if (el.tagName === "TEXTAREA" && el.value) attrs.push(`value=${q(el.value)}`);
  if (el.tagName === "SELECT") {
    const sel = Array.from(el.selectedOptions).map((o) => clean(o.text));
    attrs.push(`value=${q(sel.join(", "))}`);
    const opts = Array.from(el.options).slice(0, 25).map((o) => clean(o.text));
    attrs.push(`options=${JSON.stringify(opts)}${el.options.length > 25 ? "+" : ""}`);
  }
  if (el.tagName === "A" && el.href && !el.href.startsWith("javascript:")) attrs.push(`href=${cut(el.getAttribute("href"), 120)}`);
  return attrs.length ? " " + attrs.join(" ") : "";
}

const out = [];
function emit(depth, line) {
  out.push("  ".repeat(depth) + "- " + line);
}

// Flattened tree: shadow roots replace their host's light DOM, slots expand
// to the nodes assigned to them.
function kids(node) {
  if (node.shadowRoot) return node.shadowRoot.childNodes;
  if (node.tagName === "SLOT") {
    const assigned = node.assignedNodes({ flatten: true });
    return assigned.length ? assigned : node.childNodes;
  }
  return node.childNodes;
}

function walk(node, depth) {
  for (const child of kids(node)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = clean(child.textContent);
      if (t) emit(depth, "text: " + q(t));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE || SKIP.has(child.tagName)) continue;
    const el = child;
    if (el.tagName === "SLOT") {
      walk(el, depth);
      continue;
    }
    if (!visible(el)) continue;

    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      emit(depth, `iframe src=${cut(el.getAttribute("src") || "", 120)} (not traversed)`);
      continue;
    }

    const role = roleOf(el);
    if (interactive(el, role)) {
      const ref = "e" + ++counter;
      refs.set(ref, el);
      el.setAttribute("data-mcp-ref", ref);
      emit(depth, `${role || el.tagName.toLowerCase()} ${q(nameOf(el))} [ref=${ref}]${describe(el, role)}`);
      // Rich widgets (menus, comboboxes built from divs) can hide more controls.
      if (el.querySelector("a,button,input,select,textarea,[role],[onclick],[tabindex]")) walk(el, depth + 1);
      continue;
    }
    if (role === "heading") {
      emit(depth, `heading[${el.tagName[1] || el.getAttribute("aria-level") || ""}] ${q(el.innerText)}`);
      continue;
    }
    if (role === "img") {
      const n = clean(nameOf(el));
      if (n) emit(depth, `img ${q(n)}`);
      continue;
    }
    const container = role && role !== "presentation" && role !== "none" ? role : CONTAINERS[el.tagName];
    if (container) {
      const label = clean(el.getAttribute("aria-label") || (el.tagName === "FIELDSET" ? el.querySelector("legend")?.innerText : ""));
      emit(depth, container + (label ? " " + q(label) : "") + ":");
      walk(el, depth + 1);
      continue;
    }
    walk(el, depth);
  }
}

walk(document.body || document.documentElement, 0);
return out.join("\n");
