// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseEpub } from './epubParser';

// ---------------------------------------------------------------------------
// Helper: build a minimal EPUB zip from parts
// ---------------------------------------------------------------------------

interface EpubParts {
  opfPath?: string;
  opfContent: string;
  files: Record<string, string>; // path → content
}

async function buildEpub(parts: EpubParts): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const opfPath = parts.opfPath ?? 'OEBPS/content.opf';

  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  zip.file(opfPath, parts.opfContent);

  for (const [path, content] of Object.entries(parts.files)) {
    zip.file(path, content);
  }

  return zip.generateAsync({ type: 'arraybuffer' });
}

function xhtml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Test</title></head>
<body>${body}</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Test 1: Basic multi-file EPUB with EPUB3 nav (happy path)
// ---------------------------------------------------------------------------

describe('parseEpub integration', () => {
  it('parses a simple multi-file EPUB3 with nav TOC', async () => {
    const buffer = await buildEpub({
      opfContent: `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`,
      files: {
        'OEBPS/nav.xhtml': xhtml(`
          <nav epub:type="toc" id="toc">
            <ol>
              <li><a href="ch1.xhtml">Introduction</a></li>
              <li><a href="ch2.xhtml">Methods</a></li>
            </ol>
          </nav>
        `),
        'OEBPS/ch1.xhtml': xhtml('<p>This is the introduction chapter with enough words to pass the filter easily.</p>'),
        'OEBPS/ch2.xhtml': xhtml('<p>This is the methods chapter with enough words to pass the filter easily too.</p>'),
      },
    });

    const book = await parseEpub(buffer);
    expect(book.title).toBe('Test Book');
    expect(book.author).toBe('Test Author');
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0].title).toBe('Introduction');
    expect(book.chapters[1].title).toBe('Methods');
  });

  // -------------------------------------------------------------------------
  // Test 2: Single-file EPUB with fragment-based chapters in nav TOC
  //
  // This is common in EPUBs produced by InDesign or Calibre where the entire
  // book is in one XHTML file and chapters are anchored by id fragments.
  // -------------------------------------------------------------------------

  it('handles single-file EPUB with fragment-based TOC entries', async () => {
    const buffer = await buildEpub({
      opfContent: `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Single File Book</dc:title>
    <dc:creator>Author</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
</package>`,
      files: {
        'OEBPS/nav.xhtml': xhtml(`
          <nav epub:type="toc" id="toc">
            <ol>
              <li><a href="content.xhtml#ch1">Chapter 1: The Beginning</a></li>
              <li><a href="content.xhtml#ch2">Chapter 2: The Middle</a></li>
              <li><a href="content.xhtml#ch3">Chapter 3: The End</a></li>
            </ol>
          </nav>
        `),
        'OEBPS/content.xhtml': xhtml(`
          <h1 id="ch1">Chapter 1: The Beginning</h1>
          <p>This is the first chapter of the book. It contains introductory material about the topic we are exploring in great detail.</p>
          <p>There is more content here to ensure we have enough words for the chapter to be meaningful and pass any word count filters.</p>

          <h1 id="ch2">Chapter 2: The Middle</h1>
          <p>This is the second chapter which covers the main body of the work. We explore the methodology and present our findings here.</p>
          <p>Additional content to make this chapter substantial enough to demonstrate the splitting behavior correctly.</p>

          <h1 id="ch3">Chapter 3: The End</h1>
          <p>This is the final chapter with conclusions and future work. We summarize everything that was discussed previously.</p>
          <p>Some more concluding remarks to ensure adequate word count for the chapter filter.</p>
        `),
      },
    });

    const book = await parseEpub(buffer);

    // BUG: Currently the parser produces only 1 chapter because all TOC entries
    // point to content.xhtml (fragment stripped), and the entire file text is
    // extracted as a single chapter.
    //
    // Expected: 3 chapters split at the fragment anchors
    // Actual: 1 chapter with the title of the last TOC entry that matches

    // This assertion documents the EXPECTED behavior:
    expect(book.chapters.length).toBeGreaterThanOrEqual(3);
    expect(book.chapters[0].title).toBe('Chapter 1: The Beginning');
    expect(book.chapters[1].title).toBe('Chapter 2: The Middle');
    expect(book.chapters[2].title).toBe('Chapter 3: The End');

    // Each chapter should contain only its own text, not the full file
    expect(book.chapters[0].text).toContain('introductory material');
    expect(book.chapters[0].text).not.toContain('methodology');
    expect(book.chapters[1].text).toContain('methodology');
    expect(book.chapters[1].text).not.toContain('conclusions');
    expect(book.chapters[2].text).toContain('conclusions');
  });

  // -------------------------------------------------------------------------
  // Test 3: EPUB2 with NCX TOC (no EPUB3 nav)
  // -------------------------------------------------------------------------

  it('falls back to NCX TOC for EPUB2 books', async () => {
    const buffer = await buildEpub({
      opfContent: `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>EPUB2 Book</dc:title>
    <dc:creator>Legacy Author</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`,
      files: {
        'OEBPS/toc.ncx': `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint id="np1">
      <navLabel><text>Kapittel 1: Innledning</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
    <navPoint id="np2">
      <navLabel><text>Kapittel 2: Metode</text></navLabel>
      <content src="ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
        'OEBPS/ch1.xhtml': xhtml('<p>Dette er det første kapittelet med introduksjon til temaet vi utforsker i detalj.</p>'),
        'OEBPS/ch2.xhtml': xhtml('<p>Dette er det andre kapittelet om metode og tilnærming vi bruker i denne studien.</p>'),
      },
    });

    const book = await parseEpub(buffer);
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0].title).toBe('Kapittel 1: Innledning');
    expect(book.chapters[1].title).toBe('Kapittel 2: Metode');
  });

  // -------------------------------------------------------------------------
  // Test 4: NCX with fragment-based chapters (same bug as test 2)
  // -------------------------------------------------------------------------

  it('handles NCX TOC with fragment-based chapter references', async () => {
    const buffer = await buildEpub({
      opfContent: `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>NCX Fragment Book</dc:title>
    <dc:creator>Author</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="content"/>
  </spine>
</package>`,
      files: {
        'OEBPS/toc.ncx': `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint id="np1">
      <navLabel><text>Del 1</text></navLabel>
      <content src="content.xhtml#part1"/>
    </navPoint>
    <navPoint id="np2">
      <navLabel><text>Del 2</text></navLabel>
      <content src="content.xhtml#part2"/>
    </navPoint>
  </navMap>
</ncx>`,
        'OEBPS/content.xhtml': xhtml(`
          <div id="part1">
            <h1>Del 1</h1>
            <p>Innhold i del 1. Her er det nok tekst til å passere filteret for minimum antall ord i et kapittel.</p>
          </div>
          <div id="part2">
            <h1>Del 2</h1>
            <p>Innhold i del 2. Også her er det tilstrekkelig med tekst til å demonstrere at kapittelet blir riktig splittet.</p>
          </div>
        `),
      },
    });

    const book = await parseEpub(buffer);
    expect(book.chapters.length).toBeGreaterThanOrEqual(2);
    expect(book.chapters[0].title).toBe('Del 1');
    expect(book.chapters[1].title).toBe('Del 2');
  });

  // -------------------------------------------------------------------------
  // Test 5: Mixed — some files + some fragments within the same file
  // -------------------------------------------------------------------------

  it('handles mix of separate files and fragment-based chapters', async () => {
    const buffer = await buildEpub({
      opfContent: `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Mixed Book</dc:title>
    <dc:creator>Author</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="preface" href="preface.xhtml" media-type="application/xhtml+xml"/>
    <item id="body" href="body.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="preface"/>
    <itemref idref="body"/>
  </spine>
</package>`,
      files: {
        'OEBPS/nav.xhtml': xhtml(`
          <nav epub:type="toc" id="toc">
            <ol>
              <li><a href="preface.xhtml">Preface</a></li>
              <li><a href="body.xhtml#ch1">Chapter 1</a></li>
              <li><a href="body.xhtml#ch2">Chapter 2</a></li>
            </ol>
          </nav>
        `),
        'OEBPS/preface.xhtml': xhtml('<p>This is the preface with introductory remarks about the book and its purpose for the reader.</p>'),
        'OEBPS/body.xhtml': xhtml(`
          <section id="ch1">
            <h1>Chapter 1</h1>
            <p>Content of chapter one with sufficient text to demonstrate the split works correctly here.</p>
          </section>
          <section id="ch2">
            <h1>Chapter 2</h1>
            <p>Content of chapter two with more text so we can verify each section is treated independently.</p>
          </section>
        `),
      },
    });

    const book = await parseEpub(buffer);

    // Preface should be its own chapter, and body.xhtml should be split into 2
    expect(book.chapters.length).toBeGreaterThanOrEqual(3);
    expect(book.chapters[0].title).toBe('Preface');
    expect(book.chapters[1].title).toBe('Chapter 1');
    expect(book.chapters[2].title).toBe('Chapter 2');
  });

  // -------------------------------------------------------------------------
  // Test 6: Front matter filtered out (< 5 words)
  // -------------------------------------------------------------------------

  it('filters out spine items with fewer than 5 words', async () => {
    const buffer = await buildEpub({
      opfContent: `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Filtered Book</dc:title>
    <dc:creator>Author</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="ch1"/>
  </spine>
</package>`,
      files: {
        'OEBPS/nav.xhtml': xhtml(`
          <nav epub:type="toc" id="toc">
            <ol>
              <li><a href="ch1.xhtml">Chapter 1</a></li>
            </ol>
          </nav>
        `),
        'OEBPS/cover.xhtml': xhtml('<p>Cover</p>'),
        'OEBPS/ch1.xhtml': xhtml('<p>This is the actual chapter with real content that passes the word filter.</p>'),
      },
    });

    const book = await parseEpub(buffer);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('Chapter 1');
  });
});
