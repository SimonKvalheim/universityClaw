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

  const tocTitles = await parseToc(zip, opfDoc, opfDir, manifest);

  const chapters: ParsedChapter[] = [];
  let untitledIndex = 0;

  for (const id of spineIds) {
    const href = manifest.get(id);
    if (!href) continue;

    const filePath = resolveHref(href, opfDir);
    const xhtml = await readZipText(zip, filePath);
    if (!xhtml) continue;

    const text = extractTextFromHtml(xhtml);
    const wordCount = text ? text.trim().split(/\s+/).length : 0;

    if (wordCount < 5) continue;

    const chapterTitle = tocTitles.get(filePath) ?? `Chapter ${++untitledIndex}`;
    chapters.push({ title: chapterTitle, text, wordCount });
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

async function parseToc(
  zip: JSZip,
  opfDoc: Document,
  opfDir: string,
  manifest: Map<string, string>,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();

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
          const rawHref = a.getAttribute('href')?.split('#')[0];
          const text = a.textContent?.trim();
          if (rawHref && text) titles.set(resolveHref(rawHref, navDir), text);
        }
      }

      if (titles.size > 0) return titles;
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
          const src = contentEl?.getAttribute('src')?.split('#')[0];
          if (text && src) titles.set(resolveHref(src, ncxDir), text);
        }
      }
    }
  }

  return titles;
}
