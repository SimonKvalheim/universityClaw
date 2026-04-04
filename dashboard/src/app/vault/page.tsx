'use client';

import { useEffect, useState } from 'react';

interface Entry {
  name: string;
  type: 'directory' | 'file';
  path: string;
}

interface DirectoryResult {
  type: 'directory';
  path: string;
  entries: Entry[];
}

interface NoteResult {
  type: 'note';
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

type VaultResult = DirectoryResult | NoteResult;

export default function VaultPage() {
  const [currentPath, setCurrentPath] = useState('');
  const [result, setResult] = useState<VaultResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  async function navigate(path: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/vault?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to load');
        setResult(null);
      } else {
        setResult(data);
        setCurrentPath(path);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    navigate('');
  }, []);

  function handleEntryClick(entry: Entry) {
    setHistory((prev) => [...prev, currentPath]);
    navigate(entry.path);
  }

  function handleBack() {
    const prev = history[history.length - 1] ?? '';
    setHistory((h) => h.slice(0, -1));
    navigate(prev);
  }

  const breadcrumbs = currentPath
    ? currentPath.split('/').filter(Boolean)
    : [];

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <h2 className="text-xl font-semibold">Vault</h2>
        {history.length > 0 && (
          <button
            onClick={handleBack}
            className="text-sm text-gray-400 hover:text-gray-200"
          >
            &larr; Back
          </button>
        )}
        {breadcrumbs.length > 0 && (
          <nav className="text-sm text-gray-500 flex items-center gap-1">
            <span>/</span>
            {breadcrumbs.map((segment, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-gray-400">{segment}</span>
                {i < breadcrumbs.length - 1 && <span>/</span>}
              </span>
            ))}
          </nav>
        )}
      </div>

      {loading && <p className="text-gray-400">Loading...</p>}
      {error && (
        <div className="px-4 py-3 rounded bg-red-900 text-red-100 text-sm">{error}</div>
      )}

      {!loading && result && result.type === 'directory' && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          {result.entries.length === 0 ? (
            <p className="p-4 text-gray-500 text-sm">Empty directory</p>
          ) : (
            <ul className="divide-y divide-gray-800">
              {result.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    onClick={() => handleEntryClick(entry)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800 transition-colors text-left"
                  >
                    <span className="text-lg">
                      {entry.type === 'directory' ? '' : ''}
                    </span>
                    <span className="text-sm text-gray-200">{entry.name}</span>
                    {entry.type === 'directory' && (
                      <span className="ml-auto text-gray-600 text-xs">dir</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!loading && result && result.type === 'note' && (
        <div>
          {/* Frontmatter */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
            <h3 className="text-sm font-medium text-gray-400 mb-2">Frontmatter</h3>
            <pre className="text-xs text-gray-300 overflow-auto">
              {JSON.stringify(result.frontmatter, null, 2)}
            </pre>
          </div>

          {/* Note content */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Content</h3>
            <pre className="text-sm text-gray-300 whitespace-pre-wrap font-mono leading-relaxed overflow-auto">
              {result.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
