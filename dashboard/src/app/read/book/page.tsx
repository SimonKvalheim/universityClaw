'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRSVPEngine } from '../useRSVPEngine';
import {
  formatTime,
  getFontSize,
  segmentClass,
  ORPDisplay,
  CenteredDisplay,
  ContextDisplay,
  SourcePanel,
} from '../components';
import { parseEpub } from './epubParser';
import {
  getAllBooks,
  getBook,
  saveBook,
  deleteBook,
  getReadingState,
  saveReadingState,
  deleteReadingState,
  type StoredBook,
  type ReadingState,
} from './bookStore';
import { generateBookId, extractCurrentSentence } from './utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'library' | 'upload' | 'reading' | 'complete';
type DisplayMode = 'orp' | 'centered' | 'orp+context';

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function BookReaderPage() {
  const [phase, setPhase] = useState<Phase>('library');
  const [books, setBooks] = useState<StoredBook[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Reading state
  const [currentBook, setCurrentBook] = useState<StoredBook | null>(null);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [chapterText, setChapterText] = useState('');
  const [wpm, setWpm] = useState(250);
  const [chunkSize, setChunkSize] = useState<1 | 2 | 3>(1);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('orp');
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [initialPosition, setInitialPosition] = useState(0);
  const [copiedSentence, setCopiedSentence] = useState(false);
  const [textVersion, setTextVersion] = useState(0);

  // Timing refs
  const readingStartTime = useRef(0);
  const totalPauseTime = useRef(0);
  const lastPauseStart = useRef(0);
  const autoSaveInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // Refs for values needed in stable callbacks (avoids stale closures)
  const currentBookRef = useRef(currentBook);
  const currentChapterIndexRef = useRef(currentChapterIndex);
  useEffect(() => { currentBookRef.current = currentBook; }, [currentBook]);
  useEffect(() => { currentChapterIndexRef.current = currentChapterIndex; }, [currentChapterIndex]);

  const engine = useRSVPEngine({ text: chapterText, wpm, chunkSize, initialPosition, textVersion });

  // Completion stats
  const [completionStats, setCompletionStats] = useState<{
    totalTime: number;
    effectiveWpm: number;
  } | null>(null);

  // -----------------------------------------------------------------------
  // Load library on mount
  // -----------------------------------------------------------------------

  useEffect(() => {
    getAllBooks().then((b) => {
      setBooks(b);
      setLoadingLibrary(false);
    });
  }, []);

  // -----------------------------------------------------------------------
  // Auto-save on visibilitychange
  // -----------------------------------------------------------------------

  // Use engine position via ref so the callback stays stable during playback.
  // Without this, engine.position in deps causes the 30s interval to restart every word.
  const enginePositionRef = useRef(engine.position);
  useEffect(() => { enginePositionRef.current = engine.position; }, [engine.position]);

  const saveCurrentState = useCallback(() => {
    const book = currentBookRef.current;
    if (!book) return;
    saveReadingState({
      bookId: book.id,
      currentChapter: currentChapterIndexRef.current,
      position: enginePositionRef.current,
      wpm,
      chunkSize,
      displayMode,
      lastRead: Date.now(),
    });
  }, [wpm, chunkSize, displayMode]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden && phase === 'reading') {
        saveCurrentState();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [phase, saveCurrentState]);

  // Auto-save every 30s during playback
  useEffect(() => {
    if (phase === 'reading' && engine.isPlaying) {
      autoSaveInterval.current = setInterval(saveCurrentState, 30000);
    } else if (autoSaveInterval.current) {
      clearInterval(autoSaveInterval.current);
      autoSaveInterval.current = null;
    }
    return () => {
      if (autoSaveInterval.current) clearInterval(autoSaveInterval.current);
    };
  }, [phase, engine.isPlaying, saveCurrentState]);

  // Save on pause
  useEffect(() => {
    if (phase === 'reading' && !engine.isPlaying && currentBookRef.current) {
      saveCurrentState();
    }
  }, [engine.isPlaying, phase, saveCurrentState]);

  // Track pause time
  useEffect(() => {
    if (phase !== 'reading') return;
    if (!engine.isPlaying) {
      lastPauseStart.current = Date.now();
    } else if (lastPauseStart.current > 0) {
      totalPauseTime.current += Date.now() - lastPauseStart.current;
      lastPauseStart.current = 0;
    }
  }, [engine.isPlaying, phase]);

  // Detect chapter completion → auto-advance or book completion
  useEffect(() => {
    if (
      phase === 'reading' &&
      !engine.isPlaying &&
      engine.position >= engine.totalWords &&
      engine.totalWords > 0
    ) {
      const book = currentBookRef.current;
      const chIdx = currentChapterIndexRef.current;
      if (!book) return;
      const isLastChapter = chIdx >= book.chapters.length - 1;

      if (isLastChapter) {
        // Book complete
        if (lastPauseStart.current > 0) {
          totalPauseTime.current += Date.now() - lastPauseStart.current;
          lastPauseStart.current = 0;
        }
        const totalTime = (Date.now() - readingStartTime.current - totalPauseTime.current) / 1000;
        const totalWords = book.chapters.reduce((sum, ch) => sum + ch.wordCount, 0);
        const effectiveWpm = totalTime > 0 ? Math.round(totalWords / (totalTime / 60)) : 0;
        setCompletionStats({ totalTime, effectiveWpm });
        setPhase('complete');
      } else {
        // Advance to next chapter
        goToChapter(chIdx + 1, 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.isPlaying, engine.position, engine.totalWords, phase]);

  // -----------------------------------------------------------------------
  // Stable engine ref for keyboard handler
  // -----------------------------------------------------------------------

  const engineRef = useRef(engine);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (phase !== 'reading' && phase !== 'complete') return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || target.getAttribute('role') === 'slider') return;

      const eng = engineRef.current;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          eng.isPlaying ? eng.pause() : eng.play();
          break;
        case 'ArrowLeft':
          eng.seek(-10);
          break;
        case 'ArrowRight':
          eng.seek(10);
          break;
        case 'ArrowUp':
          setWpm((w) => Math.min(800, w + 25));
          break;
        case 'ArrowDown':
          setWpm((w) => Math.max(100, w - 25));
          break;
        case 'KeyR':
          eng.restart();
          break;
        case 'KeyT':
          setSourceExpanded((v) => !v);
          break;
        case 'KeyM':
          setDisplayMode((m) => {
            if (m === 'orp') return 'centered';
            if (m === 'centered') return 'orp+context';
            return 'orp';
          });
          break;
        case 'KeyC':
          setChunkSize((c) => {
            if (c === 1) return 2;
            if (c === 2) return 3;
            return 1;
          });
          break;
        case 'BracketLeft':
          if (currentBook && currentChapterIndex > 0) {
            goToChapter(currentChapterIndex - 1, 0);
          }
          break;
        case 'BracketRight':
          if (currentBook && currentChapterIndex < currentBook.chapters.length - 1) {
            goToChapter(currentChapterIndex + 1, 0);
          }
          break;
        case 'Escape':
          saveCurrentState();
          setPhase('library');
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phase, currentBook, currentChapterIndex]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  function goToChapter(index: number, pos: number) {
    if (!currentBook) return;
    const chapter = currentBook.chapters[index];
    if (!chapter) return;
    setCurrentChapterIndex(index);
    setInitialPosition(pos);
    setChapterText(chapter.text);
    setTextVersion((v) => v + 1); // Force engine re-init even if same text
  }

  async function openBook(bookId: string) {
    const book = await getBook(bookId);
    if (!book) return;

    setCurrentBook(book);
    const state = getReadingState(bookId);

    const chIdx = state?.currentChapter ?? 0;
    const pos = state?.position ?? 0;
    if (state?.wpm) setWpm(state.wpm);
    if (state?.chunkSize) setChunkSize(state.chunkSize);
    if (state?.displayMode) setDisplayMode(state.displayMode);

    setCurrentChapterIndex(chIdx);
    setInitialPosition(pos);
    setChapterText(book.chapters[chIdx]?.text ?? '');
    setTextVersion((v) => v + 1);
    readingStartTime.current = Date.now();
    totalPauseTime.current = 0;
    lastPauseStart.current = 0;
    setPhase('reading');
  }

  async function handleRemoveBook(bookId: string) {
    if (!confirm('Remove this book? Reading progress will be lost.')) return;
    await deleteBook(bookId);
    deleteReadingState(bookId);
    setBooks((prev) => prev.filter((b) => b.id !== bookId));
  }

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.epub')) {
      setUploadError('Please upload an .epub file.');
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const buffer = await file.arrayBuffer();
      const id = await generateBookId(buffer);

      // Check if book already exists
      const existing = await getBook(id);
      if (existing) {
        if (!confirm(`"${existing.title}" is already in your library. Replace it? Reading progress will be reset.`)) {
          setUploading(false);
          return;
        }
        deleteReadingState(id);
      }

      const parsed = await parseEpub(buffer);
      const book: StoredBook = {
        id,
        title: parsed.title,
        author: parsed.author,
        chapters: parsed.chapters,
        addedAt: Date.now(),
      };

      await saveBook(book);
      setBooks((prev) => {
        const filtered = prev.filter((b) => b.id !== id);
        return [...filtered, book];
      });

      // Go directly to reading
      setCurrentBook(book);
      setCurrentChapterIndex(0);
      setInitialPosition(0);
      setChapterText(book.chapters[0].text);
      readingStartTime.current = Date.now();
      totalPauseTime.current = 0;
      lastPauseStart.current = 0;
      setPhase('reading');
    } catch (err) {
      const message = err instanceof DOMException && err.name === 'QuotaExceededError'
        ? 'Storage full. Remove some books to make room.'
        : err instanceof Error
          ? err.message
          : 'Failed to parse EPUB file.';
      setUploadError(message);
    } finally {
      setUploading(false);
    }
  }

  // -----------------------------------------------------------------------
  // Computed values
  // -----------------------------------------------------------------------

  const fontSize = getFontSize(engine.currentChunk);
  const showSettings = !engine.isPlaying && phase === 'reading';
  const currentChapter = currentBook?.chapters[currentChapterIndex];
  const chapterProgress = engine.totalWords > 0
    ? Math.round((engine.position / engine.totalWords) * 100)
    : 0;
  const overallProgress = currentBook
    ? (() => {
        const totalWords = currentBook.chapters.reduce((s, c) => s + c.wordCount, 0);
        const wordsBefore = currentBook.chapters.slice(0, currentChapterIndex).reduce((s, c) => s + c.wordCount, 0);
        return Math.round(((wordsBefore + engine.position) / totalWords) * 100);
      })()
    : 0;

  // "Find my place" sentence
  const currentSentence = (() => {
    if (!currentChapter) return '';
    const words = currentChapter.text.trim().split(/\s+/);
    return extractCurrentSentence(words, engine.position);
  })();

  async function copySentence() {
    await navigator.clipboard.writeText(currentSentence);
    setCopiedSentence(true);
    setTimeout(() => setCopiedSentence(false), 2000);
  }

  // -----------------------------------------------------------------------
  // Render: complete phase
  // -----------------------------------------------------------------------

  if (phase === 'complete') {
    const totalWords = currentBook?.chapters.reduce((s, c) => s + c.wordCount, 0) ?? 0;
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-10 text-center">
          <h2 className="text-2xl font-semibold text-gray-100 mb-2">Book Complete</h2>
          <p className="text-gray-400 mb-8">{currentBook?.title}</p>

          {completionStats && (
            <div className="flex justify-center gap-12 mb-10">
              <div>
                <p className="text-3xl font-mono text-blue-400">{formatTime(completionStats.totalTime)}</p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Time</p>
              </div>
              <div>
                <p className="text-3xl font-mono text-blue-400">{completionStats.effectiveWpm.toLocaleString()}</p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Effective WPM</p>
              </div>
              <div>
                <p className="text-3xl font-mono text-blue-400">{totalWords.toLocaleString()}</p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Words</p>
              </div>
            </div>
          )}

          <button
            className="px-6 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            onClick={() => {
              setCompletionStats(null);
              setPhase('library');
            }}
          >
            Back to Library
          </button>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: reading phase
  // -----------------------------------------------------------------------

  if (phase === 'reading' && currentBook && currentChapter) {
    return (
      <div className="max-w-2xl mx-auto select-none">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <button
            className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
            onClick={() => { saveCurrentState(); setPhase('library'); }}
            title="Back to library (Esc)"
          >
            ← Library
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-400 truncate">{currentBook.title}</p>
          </div>
          <select
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-gray-600 max-w-[200px]"
            value={currentChapterIndex}
            onChange={(e) => goToChapter(Number(e.target.value), 0)}
          >
            {currentBook.chapters.map((ch, i) => (
              <option key={i} value={i}>{ch.title}</option>
            ))}
          </select>
          <span className="text-xs text-gray-500 whitespace-nowrap">
            {currentChapterIndex + 1}/{currentBook.chapters.length} — {chapterProgress}%
          </span>
        </div>

        {/* Display area */}
        <div className="py-20 flex items-center justify-center min-h-[160px]">
          {displayMode === 'orp' && <ORPDisplay chunk={engine.currentChunk} fontSize={fontSize} />}
          {displayMode === 'centered' && <CenteredDisplay chunk={engine.currentChunk} fontSize={fontSize} />}
          {displayMode === 'orp+context' && (
            <ContextDisplay chunk={engine.currentChunk} words={engine.words} position={engine.position} fontSize={fontSize} />
          )}
        </div>

        {/* Find my place panel */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500">
              Chapter {currentChapterIndex + 1} — {chapterProgress}% · Book {overallProgress}%
            </span>
            <button
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              onClick={copySentence}
              title="Copy sentence to clipboard"
            >
              {copiedSentence ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="text-sm text-gray-400 leading-relaxed">{currentSentence}</p>
        </div>

        {/* Progress bar */}
        <div className="mb-4">
          <div
            className="h-2 bg-gray-800 rounded-full cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - rect.left) / rect.width;
              engine.jumpTo(Math.round(pct * engine.totalWords));
            }}
          >
            <div
              className="h-full bg-blue-600 rounded-full transition-all"
              style={{ width: `${engine.progress * 100}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>Word {engine.position} / {engine.totalWords}</span>
            <span>{formatTime(engine.estimatedTimeLeft)} left</span>
          </div>
        </div>

        {/* Transport controls */}
        <div className="flex items-center justify-center gap-3 mb-4">
          <button className="px-3 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm transition-colors" onClick={() => engine.seek(-10)} title="Seek back 10s (←)">←10s</button>
          <button className="px-5 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors min-w-[80px]" onClick={() => (engine.isPlaying ? engine.pause() : engine.play())} title="Play/Pause (Space)">
            {engine.isPlaying ? 'Pause' : 'Play'}
          </button>
          <button className="px-3 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm transition-colors" onClick={() => engine.seek(10)} title="Seek forward 10s (→)">10s→</button>
          <button className="px-3 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm transition-colors" onClick={() => engine.restart()} title="Restart chapter (R)">↺</button>
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-center gap-4 text-xs text-gray-500 mb-4">
          <span>WPM: <span className="text-gray-300">{wpm}</span> <span className="text-gray-600">(↑↓)</span></span>
          <span>Chunk: <span className="text-gray-300">{chunkSize}</span> <span className="text-gray-600">(C)</span></span>
          <span>Mode: <span className="text-gray-300">{displayMode}</span> <span className="text-gray-600">(M)</span></span>
          <button className="text-gray-500 hover:text-gray-300 transition-colors" onClick={() => setSourceExpanded((v) => !v)} title="Toggle source (T)">
            Source <span className="text-gray-600">(T)</span>
          </button>
          <span>Ch: <span className="text-gray-600">[ ]</span></span>
        </div>

        {/* Settings panel — visible on pause */}
        {showSettings && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
            <div className="flex flex-wrap gap-6 items-center">
              <div className="flex items-center gap-3 flex-1 min-w-48">
                <label className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">WPM</label>
                <input type="range" min={100} max={800} step={25} value={wpm} onChange={(e) => setWpm(Number(e.target.value))} className="flex-1 accent-blue-500" />
                <input type="number" min={100} max={800} step={25} value={wpm} onChange={(e) => setWpm(Math.min(800, Math.max(100, Number(e.target.value))))} className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-center text-gray-100 focus:outline-none focus:border-gray-600" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">Words</span>
                <div className="flex gap-1">
                  {([1, 2, 3] as const).map((n) => (
                    <button key={n} className={segmentClass(chunkSize === n)} onClick={() => setChunkSize(n)}>{n}</button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">Mode</span>
                <div className="flex gap-1">
                  {([
                    { value: 'orp' as const, label: 'ORP' },
                    { value: 'centered' as const, label: 'Centered' },
                    { value: 'orp+context' as const, label: 'ORP + Context' },
                  ]).map(({ value, label }) => (
                    <button key={value} className={segmentClass(displayMode === value)} onClick={() => setDisplayMode(value)}>{label}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Source panel */}
        {(sourceExpanded || showSettings) && (
          <SourcePanel text={chapterText} words={engine.words} position={engine.position} />
        )}
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: upload phase
  // -----------------------------------------------------------------------

  if (phase === 'upload') {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button
            className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
            onClick={() => setPhase('library')}
          >
            ← Library
          </button>
          <h2 className="text-xl font-semibold">Add Book</h2>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div
            className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors ${
              dragging ? 'border-blue-500 bg-blue-950/20' : 'border-gray-700 hover:border-gray-600'
            }`}
            onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
          >
            {uploading ? (
              <p className="text-gray-400 text-sm">Parsing EPUB...</p>
            ) : (
              <>
                <p className="text-gray-400 mb-2 text-sm">
                  Drag and drop an EPUB file here, or{' '}
                  <label className="text-blue-400 hover:text-blue-300 cursor-pointer underline">
                    browse
                    <input type="file" accept=".epub" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                  </label>
                </p>
                <p className="text-xs text-gray-600">Supports .epub files</p>
              </>
            )}
          </div>

          {uploadError && (
            <p className="text-sm text-red-400 mt-3">{uploadError}</p>
          )}
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: library phase (default)
  // -----------------------------------------------------------------------

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Book Library</h2>
        <button
          className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          onClick={() => { setUploadError(null); setPhase('upload'); }}
        >
          Add Book
        </button>
      </div>

      {loadingLibrary ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : books.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-10 text-center">
          <p className="text-gray-400 mb-4">No books yet</p>
          <button
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            onClick={() => { setUploadError(null); setPhase('upload'); }}
          >
            Upload an EPUB
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {[...books]
            .sort((a, b) => {
              const stateA = getReadingState(a.id);
              const stateB = getReadingState(b.id);
              return (stateB?.lastRead ?? b.addedAt) - (stateA?.lastRead ?? a.addedAt);
            })
            .map((book) => {
              const state = getReadingState(book.id);
              const chIdx = state?.currentChapter ?? 0;
              const totalWords = book.chapters.reduce((s, c) => s + c.wordCount, 0);
              const wordsBefore = book.chapters.slice(0, chIdx).reduce((s, c) => s + c.wordCount, 0);
              const overallPct = totalWords > 0 ? Math.round(((wordsBefore + (state?.position ?? 0)) / totalWords) * 100) : 0;
              const lastRead = state?.lastRead ? new Date(state.lastRead).toLocaleDateString() : null;

              return (
                <div
                  key={book.id}
                  className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors cursor-pointer"
                  onClick={() => openBook(book.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-gray-100 font-medium truncate">{book.title}</h3>
                      {book.author && <p className="text-sm text-gray-500">{book.author}</p>}
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                        <span>Chapter {chIdx + 1} / {book.chapters.length}</span>
                        <span>{overallPct}%</span>
                        {lastRead && <span>Last read: {lastRead}</span>}
                      </div>
                      {/* Mini progress bar */}
                      <div className="h-1 bg-gray-800 rounded-full mt-2 w-full">
                        <div className="h-full bg-blue-600 rounded-full" style={{ width: `${overallPct}%` }} />
                      </div>
                    </div>
                    <button
                      className="text-gray-600 hover:text-red-400 text-sm ml-3 transition-colors"
                      onClick={(e) => { e.stopPropagation(); handleRemoveBook(book.id); }}
                      title="Remove book"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
