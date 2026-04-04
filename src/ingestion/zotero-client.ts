import { logger } from '../logger.js';

const REQUEST_TIMEOUT = 10_000;

export class ZoteroLocalClient {
  constructor(private readonly baseUrl: string) {}

  async getItems(since?: number): Promise<{ items: unknown[]; version: number }> {
    // Build query string manually to preserve literal '+' in itemType filter
    // (URLSearchParams encodes '+' as '%2B' which Zotero does not accept)
    const parts: string[] = [];
    if (since !== undefined) parts.push(`since=${since}`);
    parts.push('itemType=-attachment+-note', 'format=json');
    const query = parts.join('&');

    const res = await fetch(`${this.baseUrl}/api/users/0/items?${query}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!res.ok) throw new Error(`Zotero local API error: ${res.status}`);

    const items = await res.json();
    const version = parseInt(res.headers.get('Last-Modified-Version') || '0', 10);
    return { items, version };
  }

  async getChildren(itemKey: string): Promise<unknown[]> {
    const res = await fetch(
      `${this.baseUrl}/api/users/0/items/${itemKey}/children?format=json`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT) },
    );
    if (!res.ok) throw new Error(`Zotero children fetch error: ${res.status}`);
    return res.json();
  }

  async getCollections(): Promise<unknown[]> {
    const res = await fetch(
      `${this.baseUrl}/api/users/0/collections?format=json`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT) },
    );
    if (!res.ok) throw new Error(`Zotero collections fetch error: ${res.status}`);
    return res.json();
  }

  async getFileUrl(attachmentKey: string): Promise<string | null> {
    const res = await fetch(
      `${this.baseUrl}/api/users/0/items/${attachmentKey}/file/view/url`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT) },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Zotero file URL error: ${res.status}`);

    const url = (await res.text()).trim();
    if (url.startsWith('file://')) {
      return decodeURIComponent(new URL(url).pathname);
    }
    return url;
  }
}

export class ZoteroWebClient {
  private readonly baseUrl = 'https://api.zotero.org';

  constructor(
    private readonly apiKey: string,
    private readonly userId: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      'Zotero-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  async createChildNote(
    parentKey: string,
    htmlContent: string,
    libraryVersion: number,
  ): Promise<void> {
    const body = [
      {
        itemType: 'note',
        parentItem: parentKey,
        note: htmlContent,
        tags: [],
      },
    ];

    const res = await fetch(`${this.baseUrl}/users/${this.userId}/items`, {
      method: 'POST',
      headers: {
        ...this.headers,
        'If-Unmodified-Since-Version': String(libraryVersion),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (res.status === 412) {
      throw new Error('Zotero version conflict (412)');
    }
    if (!res.ok) {
      throw new Error(`Zotero create note error: ${res.status}`);
    }
  }

  async addTag(itemKey: string, tag: string): Promise<void> {
    const getRes = await fetch(
      `${this.baseUrl}/users/${this.userId}/items/${itemKey}`,
      {
        headers: this.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );
    if (!getRes.ok) throw new Error(`Zotero get item error: ${getRes.status}`);

    const item = (await getRes.json()) as {
      version: number;
      data: { tags: { tag: string }[] };
    };

    if (item.data.tags.some((t) => t.tag === tag)) return;

    const updatedTags = [...item.data.tags, { tag }];
    const patchRes = await fetch(
      `${this.baseUrl}/users/${this.userId}/items/${itemKey}`,
      {
        method: 'PATCH',
        headers: {
          ...this.headers,
          'If-Unmodified-Since-Version': String(item.version),
        },
        body: JSON.stringify({ tags: updatedTags }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );

    if (patchRes.status === 412) {
      throw new Error('Zotero version conflict on tag update (412)');
    }
    if (!patchRes.ok) {
      throw new Error(`Zotero tag update error: ${patchRes.status}`);
    }
  }

  async getLibraryVersion(): Promise<number> {
    const res = await fetch(
      `${this.baseUrl}/users/${this.userId}/items?limit=0`,
      {
        headers: this.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );
    if (!res.ok) throw new Error(`Zotero version fetch error: ${res.status}`);
    return parseInt(res.headers.get('Last-Modified-Version') || '0', 10);
  }
}
