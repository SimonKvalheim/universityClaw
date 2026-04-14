// Types
export interface StoredBook {
  id: string;
  title: string;
  author: string;
  chapters: { title: string; text: string; wordCount: number }[];
  addedAt: number;
}

export interface ReadingState {
  bookId: string;
  currentChapter: number;
  position: number;
  wpm: number;
  chunkSize: 1 | 2 | 3;
  displayMode: 'orp' | 'centered' | 'orp+context';
  lastRead: number;
}

// IndexedDB — book storage
const DB_NAME = 'book-reader';
const STORE_NAME = 'books';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllBooks(): Promise<StoredBook[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getBook(id: string): Promise<StoredBook | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result ?? undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function saveBook(book: StoredBook): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(book);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function deleteBook(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// localStorage — reading state
function stateKey(bookId: string): string {
  return `book-state:${bookId}`;
}

export function getReadingState(bookId: string): ReadingState | null {
  const raw = localStorage.getItem(stateKey(bookId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReadingState;
  } catch {
    return null;
  }
}

export function saveReadingState(state: ReadingState): void {
  localStorage.setItem(stateKey(state.bookId), JSON.stringify(state));
}

export function deleteReadingState(bookId: string): void {
  localStorage.removeItem(stateKey(bookId));
}
