export interface ZoteroMetadata {
  title: string;
  creators: { firstName: string; lastName: string; creatorType: string }[];
  date: string;
  DOI?: string;
  url?: string;
  publicationTitle?: string;
  tags: string[];
  abstractNote?: string;
  itemType: string;
}

export interface ZoteroItem {
  key: string;
  version: number;
  data: ZoteroItemData;
  meta: { numChildren?: number };
  links?: {
    attachment?: { href: string; type: string; attachmentType?: string; attachmentSize?: number };
  };
}

export interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  title: string;
  creators: { firstName: string; lastName: string; creatorType: string }[];
  date: string;
  DOI?: string;
  url?: string;
  publicationTitle?: string;
  tags: { tag: string; type?: number }[];
  abstractNote?: string;
  collections: string[];
  [k: string]: unknown;
}

export interface ZoteroAttachment {
  key: string;
  data: {
    key: string;
    itemType: 'attachment';
    contentType: string;
    filename?: string;
    path?: string;
    parentItem: string;
    [k: string]: unknown;
  };
  links?: {
    enclosure?: { href: string; type: string; length?: number };
  };
}
