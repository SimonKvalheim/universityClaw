/** Convert a slug like "working-memory-architecture" to "Working Memory Architecture". */
export function slugToTitle(slug: string): string {
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface WikiLink {
  target: string;
  heading: string | undefined;
  alias: string | undefined;
}

const WIKILINK_RE = /(?<!!)\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

export function extractWikilinks(markdown: string): WikiLink[] {
  const links: WikiLink[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  while ((match = re.exec(markdown)) !== null) {
    links.push({
      target: match[1].trim(),
      heading: match[2]?.trim(),
      alias: match[3]?.trim(),
    });
  }
  return links;
}

export function createWikilink(
  target: string,
  opts?: { heading?: string; alias?: string },
): string {
  let link = target;
  if (opts?.heading) link += `#${opts.heading}`;
  if (opts?.alias) link += `|${opts.alias}`;
  return `[[${link}]]`;
}

export function replaceWikilinks(
  markdown: string,
  oldTarget: string,
  newTarget: string,
): string {
  const re = new RegExp(
    `(?<!!)\\[\\[${escapeRegex(oldTarget)}(#[^\\]|]*?)?(\\|[^\\]]+?)?\\]\\]`,
    'g',
  );
  return markdown.replace(
    re,
    (_, heading = '', alias = '') => `[[${newTarget}${heading}${alias}]]`,
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface FrontmatterWikilink {
  target: string;
  field: string; // originating frontmatter field — used by T13's keyword routing
}

export function extractFrontmatterWikilinks(
  fm: Record<string, unknown>,
  allowlist: readonly string[],
): FrontmatterWikilink[] {
  const out: FrontmatterWikilink[] = [];
  const wikilinkRe = /\[\[([^\]]+)\]\]/g;
  for (const field of allowlist) {
    const value = fm[field];
    const candidates = Array.isArray(value) ? value : [value];
    for (const c of candidates) {
      if (typeof c !== 'string') continue;
      let m: RegExpExecArray | null;
      wikilinkRe.lastIndex = 0;
      while ((m = wikilinkRe.exec(c)) !== null) {
        out.push({ target: m[1].trim(), field });
      }
    }
  }
  return out;
}
