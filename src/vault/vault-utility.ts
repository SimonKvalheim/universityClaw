import {
  readFile,
  writeFile,
  mkdir,
  rename,
  readdir,
  unlink,
} from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { extractWikilinks } from './wikilinks.js';

export interface NoteInput {
  data: Record<string, unknown>;
  content: string;
}

export interface NoteOutput {
  path: string;
  data: Record<string, unknown>;
  content: string;
}

export class VaultUtility {
  constructor(private readonly vaultDir: string) {}

  async createNote(notePath: string, note: NoteInput): Promise<void> {
    const fullPath = join(this.vaultDir, notePath);
    await mkdir(dirname(fullPath), { recursive: true });
    const markdown = serializeFrontmatter(note.data, note.content);
    await writeFile(fullPath, markdown, 'utf-8');
  }

  async readNote(notePath: string): Promise<NoteOutput | null> {
    const fullPath = join(this.vaultDir, notePath);
    let raw: string;
    try {
      raw = await readFile(fullPath, 'utf-8');
    } catch {
      return null;
    }
    const { data, content } = parseFrontmatter(raw);
    return { path: notePath, data, content };
  }

  async updateNote(
    notePath: string,
    updates: Record<string, unknown>,
  ): Promise<void> {
    const fullPath = join(this.vaultDir, notePath);
    const raw = await readFile(fullPath, 'utf-8');
    const { data, content } = parseFrontmatter(raw);
    const merged = { ...data, ...updates };
    const markdown = serializeFrontmatter(merged, content);
    await writeFile(fullPath, markdown, 'utf-8');
  }

  async moveNote(fromPath: string, toPath: string): Promise<void> {
    const fullFrom = join(this.vaultDir, fromPath);
    const fullTo = join(this.vaultDir, toPath);
    await mkdir(dirname(fullTo), { recursive: true });
    await rename(fullFrom, fullTo);
  }

  async deleteNote(notePath: string): Promise<void> {
    const fullPath = join(this.vaultDir, notePath);
    await unlink(fullPath);
  }

  async listNotes(dirPath: string): Promise<string[]> {
    const fullDir = join(this.vaultDir, dirPath);
    let entries: string[];
    try {
      entries = await readdir(fullDir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.endsWith('.md'))
      .map((e) => join(dirPath, e));
  }

  async searchNotes(
    query: Record<string, unknown>,
    searchDir?: string,
  ): Promise<NoteOutput[]> {
    const files = await this.walkMarkdownFiles(
      searchDir ? join(this.vaultDir, searchDir) : this.vaultDir,
    );
    const results: NoteOutput[] = [];
    for (const fullPath of files) {
      let raw: string;
      try {
        raw = await readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      const { data, content } = parseFrontmatter(raw);
      const matches = Object.entries(query).every(
        ([key, value]) => data[key] === value,
      );
      if (matches) {
        const notePath = relative(this.vaultDir, fullPath);
        results.push({ path: notePath, data, content });
      }
    }
    return results;
  }

  async getBacklinks(noteTitle: string): Promise<string[]> {
    const files = await this.walkMarkdownFiles(this.vaultDir);
    const backlinks: string[] = [];
    for (const fullPath of files) {
      let raw: string;
      try {
        raw = await readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      const links = extractWikilinks(raw);
      const linksToTitle = links.some((l) => l.target === noteTitle);
      if (linksToTitle) {
        backlinks.push(relative(this.vaultDir, fullPath));
      }
    }
    return backlinks;
  }

  private async walkMarkdownFiles(dir: string): Promise<string[]> {
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.walkMarkdownFiles(fullPath);
        results.push(...nested);
      } else if (entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }
}
