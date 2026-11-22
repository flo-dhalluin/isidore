import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

const read = (name: string): string => readFileSync(join(TEMPLATE_DIR, name), "utf8");

/** Read a static asset that ships next to the templates (e.g. the logo SVG). */
export function readTemplateAsset(name: string): Buffer {
  return readFileSync(join(TEMPLATE_DIR, name));
}

const stripComments = (text: string): string => text.replace(/\{#[\s\S]*?#\}/g, "");

function extractBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const re = /{%\s*block\s+(\w+)\s*%}([\s\S]*?){%\s*endblock\s*%}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) blocks.set(match[1], match[2]);
  return blocks;
}

function resolveIncludes(text: string): string {
  return text.replace(/{%\s*include\s+"([^"]+)"\s*%}/g, (_, name: string) => stripComments(read(name)));
}

/**
 * Minimal Jinja renderer for the isidore templates: they carry no server-side
 * data, so only `extends`, `block`, `include`, and comments are needed.
 */
export function renderTemplate(name: string): string {
  const child = stripComments(read(name));
  const extendsMatch = /{%\s*extends\s+"([^"]+)"\s*%}/.exec(child);
  if (!extendsMatch) return resolveIncludes(child);

  const base = stripComments(read(extendsMatch[1]));
  const blocks = extractBlocks(child);
  const merged = base.replace(
    /{%\s*block\s+(\w+)\s*%}([\s\S]*?){%\s*endblock\s*%}/g,
    (_, key: string, fallback: string) => blocks.get(key) ?? fallback,
  );
  return resolveIncludes(merged);
}
