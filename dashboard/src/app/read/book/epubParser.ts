import JSZip from 'jszip';

// Types
export interface ParsedBook {
  title: string;
  author: string;
  chapters: ParsedChapter[];
}

export interface ParsedChapter {
  title: string;
  text: string;
  wordCount: number;
}

interface TocEntry {
  title: string;
  fragment: string | null;
}

// Public API
export async function parseEpub(buffer: ArrayBuffer): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(buffer);

  const containerXml = await readZipText(zip, 'META-INF/container.xml');
  if (!containerXml) throw new Error('Invalid EPUB: missing META-INF/container.xml');

  const containerDoc = parseXml(containerXml);
  const rootfileEl = containerDoc.getElementsByTagNameNS('*', 'rootfile')[0];
  const opfPath = rootfileEl?.getAttribute('full-path');
  if (!opfPath) throw new Error('Invalid EPUB: no rootfile path found');

  const opfXml = await readZipText(zip, opfPath);
  if (!opfXml) throw new Error(`Invalid EPUB: missing OPF file at ${opfPath}`);

  const opfDoc = parseXml(opfXml);
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  const DC_NS = 'http://purl.org/dc/elements/1.1/';
  const title = opfDoc.getElementsByTagNameNS(DC_NS, 'title')[0]?.textContent?.trim() ?? 'Untitled';
  const author = opfDoc.getElementsByTagNameNS(DC_NS, 'creator')[0]?.textContent?.trim() ?? '';

  const manifest = new Map<string, string>();
  const manifestItems = opfDoc.getElementsByTagNameNS('*', 'item');
  for (let i = 0; i < manifestItems.length; i++) {
    const item = manifestItems[i];
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) manifest.set(id, href);
  }

  const spineIds: string[] = [];
  const spineItemrefs = opfDoc.getElementsByTagNameNS('*', 'itemref');
  for (let i = 0; i < spineItemrefs.length; i++) {
    const idref = spineItemrefs[i].getAttribute('idref');
    if (idref) spineIds.push(idref);
  }

  const tocMap = await parseToc(zip, opfDoc, opfDir, manifest);

  const chapters: ParsedChapter[] = [];
  let untitledIndex = 0;

  for (const id of spineIds) {
    const href = manifest.get(id);
    if (!href) continue;

    const filePath = resolveHref(href, opfDir);
    const xhtml = await readZipText(zip, filePath);
    if (!xhtml) continue;

    const tocEntries = tocMap.get(filePath);
    const hasFragments = tocEntries?.some(e => e.fragment !== null);

    if (hasFragments && tocEntries) {
      // File has fragment-based chapters — split content at anchor points
      const fragmentChapters = splitHtmlByFragments(xhtml, tocEntries);
      for (const ch of fragmentChapters) {
        if (ch.wordCount >= 5) chapters.push(ch);
      }
    } else {
      // Single chapter per file (original behavior)
      const text = extractTextFromHtml(xhtml);
      const wordCount = text ? text.trim().split(/\s+/).length : 0;
      if (wordCount < 5) continue;

      const chapterTitle = tocEntries?.[0]?.title ?? `Chapter ${++untitledIndex}`;
      chapters.push({ title: chapterTitle, text, wordCount });
    }
  }

  if (chapters.length === 0) {
    throw new Error('No readable chapters found in this EPUB.');
  }

  return { title, author, chapters };
}

// Exported helpers (tested directly)

export function extractTextFromHtml(html: string): string {
  let doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) {
    doc = new DOMParser().parseFromString(html, 'text/html');
  }
  const body = doc.body ?? doc.documentElement;
  return (body.textContent ?? '').trim();
}

export function resolveHref(href: string, opfDir: string): string {
  const decoded = decodeURIComponent(href);
  const combined = opfDir + decoded;
  const parts = combined.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else if (part !== '.') {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

// Internal helpers

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

async function readZipText(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;
  return file.async('text');
}

function splitHref(href: string): [string, string | null] {
  const hashIndex = href.indexOf('#');
  if (hashIndex < 0) return [href, null];
  return [href.substring(0, hashIndex), href.substring(hashIndex + 1)];
}

export function splitHtmlByFragments(
  html: string,
  entries: TocEntry[],
): ParsedChapter[] {
  const fragmentEntries = entries.filter(
    (e): e is TocEntry & { fragment: string } => e.fragment !== null,
  );
  if (fragmentEntries.length === 0) return [];

  let doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) {
    doc = new DOMParser().parseFromString(html, 'text/html');
  }
  const body = doc.body ?? doc.documentElement;

  // Locate fragment elements in the DOM; keep only those that exist
  const fragmentEls = fragmentEntries
    .map(e => ({ title: e.title, fragment: e.fragment, el: doc.getElementById(e.fragment) }))
    .filter((f): f is { title: string; fragment: string; el: HTMLElement } => f.el !== null);

  if (fragmentEls.length === 0) {
    // Fragments listed in TOC but not found in the document — fall back to full text
    const text = (body.textContent ?? '').trim();
    return [{ title: entries[0].title, text, wordCount: text ? text.split(/\s+/).length : 0 }];
  }

  // Walk every text node in document order and assign it to the latest
  // fragment element that precedes (or contains) it.
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const sections = new Map<string, string[]>();
  for (const f of fragmentEls) sections.set(f.fragment, []);

  let currentIdx = -1; // index into fragmentEls; -1 = before first fragment
  let textNode: Node | null;

  while ((textNode = walker.nextNode())) {
    const content = textNode.textContent ?? '';
    if (!content.trim()) continue;

    // Advance the current fragment pointer whenever the text node is
    // after (or inside) the next fragment element in document order.
    while (currentIdx + 1 < fragmentEls.length) {
      const next = fragmentEls[currentIdx + 1].el;
      const pos = next.compareDocumentPosition(textNode);
      if (pos & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY)) {
        currentIdx++;
      } else {
        break;
      }
    }

    if (currentIdx >= 0) {
      sections.get(fragmentEls[currentIdx].fragment)!.push(content);
    }
    // Text before the first fragment anchor is discarded (front matter / preamble)
  }

  return fragmentEls.map(f => {
    const text = (sections.get(f.fragment) ?? []).join(' ').replace(/\s+/g, ' ').trim();
    return { title: f.title, text, wordCount: text ? text.split(/\s+/).length : 0 };
  });
}

async function parseToc(
  zip: JSZip,
  opfDoc: Document,
  opfDir: string,
  manifest: Map<string, string>,
): Promise<Map<string, TocEntry[]>> {
  const entries = new Map<string, TocEntry[]>();

  const addEntry = (resolvedPath: string, title: string, fragment: string | null) => {
    if (!entries.has(resolvedPath)) entries.set(resolvedPath, []);
    entries.get(resolvedPath)!.push({ title, fragment });
  };

  const manifestItems = opfDoc.getElementsByTagNameNS('*', 'item');
  let navDir = opfDir;
  for (let i = 0; i < manifestItems.length; i++) {
    const item = manifestItems[i];
    const props = item.getAttribute('properties') ?? '';
    if (props.includes('nav')) {
      const navHref = item.getAttribute('href');
      if (!navHref) continue;

      const navPath = resolveHref(navHref, opfDir);
      navDir = navPath.includes('/') ? navPath.substring(0, navPath.lastIndexOf('/') + 1) : '';
      const navXhtml = await readZipText(zip, navPath);
      if (!navXhtml) continue;

      const navDoc = new DOMParser().parseFromString(navXhtml, 'text/html');
      const navElements = navDoc.getElementsByTagName('nav');
      for (let n = 0; n < navElements.length; n++) {
        const nav = navElements[n];
        const epubType = nav.getAttribute('epub:type') ?? nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? '';
        if (epubType !== 'toc' && nav.id !== 'toc') continue;

        const links = nav.getElementsByTagName('a');
        for (let l = 0; l < links.length; l++) {
          const a = links[l];
          const rawHref = a.getAttribute('href');
          const text = a.textContent?.trim();
          if (!rawHref || !text) continue;
          const [hrefPath, fragment] = splitHref(rawHref);
          addEntry(resolveHref(hrefPath, navDir), text, fragment);
        }
      }

      if (entries.size > 0) return entries;
    }
  }

  const spineEl = opfDoc.getElementsByTagNameNS('*', 'spine')[0];
  const tocId = spineEl?.getAttribute('toc');
  if (tocId) {
    const ncxHref = manifest.get(tocId);
    if (ncxHref) {
      const ncxPath = resolveHref(ncxHref, opfDir);
      const ncxDir = ncxPath.includes('/') ? ncxPath.substring(0, ncxPath.lastIndexOf('/') + 1) : '';
      const ncxXml = await readZipText(zip, ncxPath);
      if (ncxXml) {
        const ncxDoc = parseXml(ncxXml);
        const navPoints = ncxDoc.getElementsByTagNameNS('*', 'navPoint');
        for (let i = 0; i < navPoints.length; i++) {
          const np = navPoints[i];
          const textEl = np.getElementsByTagNameNS('*', 'text')[0];
          const contentEl = np.getElementsByTagNameNS('*', 'content')[0];
          const text = textEl?.textContent?.trim();
          const src = contentEl?.getAttribute('src');
          if (!text || !src) continue;
          const [srcPath, fragment] = splitHref(src);
          addEntry(resolveHref(srcPath, ncxDir), text, fragment);
        }
      }
    }
  }

  return entries;
}
