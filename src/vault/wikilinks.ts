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
