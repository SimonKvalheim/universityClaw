'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRSVPEngine, getORPIndex, TokenizedWord } from './useRSVPEngine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'input' | 'reading' | 'complete';
type DisplayMode = 'orp' | 'centered' | 'orp+context';
type InputTab = 'paste' | 'upload' | 'vault';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getFontSize(chunk: TokenizedWord[]): number {
  const maxLen = chunk.reduce((max, w) => Math.max(max, w.word.length), 0);
  if (maxLen > 30) return 24;
  if (maxLen > 20) return 32;
  return 44;
}

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function ORPDisplay({ chunk, fontSize }: { chunk: TokenizedWord[]; fontSize: number }) {
  if (chunk.length === 0) return null;

  // Find longest word for ORP alignment
  const longestWord = chunk.reduce((longest, w) =>
    w.word.length > longest.word.length ? w : longest
  );
  const word = longestWord.word;
  const pivot = getORPIndex(word);

  const before = word.slice(0, pivot);
  const pivotChar = word[pivot] ?? '';
  const after = word.slice(pivot + 1);

  // For multi-word chunks, join remaining words
  const otherWords = chunk
    .filter((w) => w !== longestWord)
    .map((w) => w.word)
    .join(' ');
  const displayWord = chunk.length > 1
    ? chunk.map((w) => w.word).join(' ')
    : word;

  // For multi-word chunks, build the full phrase and calculate pivot offset
  // relative to the longest word's pivot character within the phrase
  if (chunk.length > 1) {
    const phrase = chunk.map((w) => w.word).join(' ');
    // Find the character position of the pivot within the full phrase
    let charsBeforeLongest = 0;
    for (const w of chunk) {
      if (w === longestWord) break;
      charsBeforeLongest += w.word.length + 1; // +1 for space
    }
    const pivotInPhrase = charsBeforeLongest + pivot;
    const phraseShiftCh = phrase.length / 2 - pivotInPhrase - 0.5;

    return (
      <div className="relative flex items-center justify-center" style={{ fontSize, fontFamily: 'ui-monospace, monospace', minHeight: '1.5em' }}>
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-800" />
        <span style={{ transform: `translateX(${phraseShiftCh}ch)` }}>
          {chunk.map((w, i) => {
            const isLongest = w === longestWord;
            return (
              <span key={i}>
                {i > 0 && ' '}
                {isLongest ? (
                  <>
                    <span className="text-gray-300">{before}</span>
                    <span className="text-red-500 font-bold">{pivotChar}</span>
                    <span className="text-gray-300">{after}</span>
                  </>
                ) : (
                  <span className="text-gray-300">{w.word}</span>
                )}
              </span>
            );
          })}
        </span>
      </div>
    );
  }

  // Offset so the pivot character's center aligns with the center line.
  // In monospace, each char is 1ch wide. The pivot center is at (pivot + 0.5)ch
  // from the left edge. The word center is at (word.length / 2)ch.
  // Shift = (word.length / 2 - pivot - 0.5)ch to the right.
  const shiftCh = word.length / 2 - pivot - 0.5;

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ fontSize, fontFamily: 'ui-monospace, monospace', minHeight: '1.5em' }}
    >
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-800" />
      <span
        className="flex items-center"
        style={{ transform: `translateX(${shiftCh}ch)` }}
      >
        <span className="text-gray-300">{before}</span>
        <span className="text-red-500 font-bold">{pivotChar}</span>
        <span className="text-gray-300">{after}</span>
      </span>
    </div>
  );
}

function CenteredDisplay({ chunk, fontSize }: { chunk: TokenizedWord[]; fontSize: number }) {
  const text = chunk.map((w) => w.word).join(' ');
  return (
    <div
      className="flex items-center justify-center text-gray-100"
      style={{ fontSize, fontFamily: 'ui-monospace, monospace', minHeight: '1.5em' }}
    >
      {text}
    </div>
  );
}

function ContextDisplay({
  chunk,
  words,
  position,
  fontSize,
}: {
  chunk: TokenizedWord[];
  words: TokenizedWord[];
  position: number;
  fontSize: number;
}) {
  const before = words
    .slice(Math.max(0, position - 10), position)
    .map((w) => w.word)
    .join(' ');
  const after = words
    .slice(position + chunk.length, position + chunk.length + 10)
    .map((w) => w.word)
    .join(' ');

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-gray-700 text-sm truncate max-w-full text-center">{before}</p>
      <ORPDisplay chunk={chunk} fontSize={fontSize} />
      <p className="text-gray-700 text-sm truncate max-w-full text-center">{after}</p>
    </div>
  );
}

function SourcePanel({ text, position }: { text: string; words: TokenizedWord[]; position: number }) {
  const allWords = text.trim().split(/\s+/);
  const start = Math.max(0, position - 250);
  const end = Math.min(allWords.length, position + 250);
  const slice = allWords.slice(start, end);

  const highlightRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [position]);

  return (
    <div className="max-h-48 overflow-y-auto text-xs leading-relaxed text-gray-600 p-3 bg-gray-900 border border-gray-800 rounded-lg">
      {slice.map((word, i) => {
        const globalIdx = start + i;
        const isHighlighted = globalIdx === position;
        return (
          <span key={globalIdx}>
            {isHighlighted ? (
              <span
                ref={highlightRef}
                className="bg-blue-900 text-blue-200 px-0.5 rounded"
              >
                {word}
              </span>
            ) : (
              <span className="text-gray-600">{word}</span>
            )}
            {' '}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function ReadPage() {
  const [phase, setPhase] = useState<Phase>('input');
  const [text, setText] = useState('');
  const [wpm, setWpm] = useState(250);
  const [chunkSize, setChunkSize] = useState<1 | 2 | 3>(1);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('orp');
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [inputTab, setInputTab] = useState<InputTab>('paste');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const readingStartTime = useRef<number>(0);
  const totalPauseTime = useRef<number>(0);
  const lastPauseStart = useRef<number>(0);

  const engine = useRSVPEngine({ text, wpm, chunkSize });

  // -------------------------------------------------------------------------
  // Hooks that must be before conditional returns
  // -------------------------------------------------------------------------

  // Completion stats state
  const [completionStats, setCompletionStats] = useState<{
    totalTime: number;
    effectiveWpm: number;
  } | null>(null);

  // autoPlay flag for "Read Again" pattern
  const [autoPlay, setAutoPlay] = useState(false);

  // Trigger autoPlay after phase transitions to reading
  useEffect(() => {
    if (autoPlay && phase === 'reading') {
      engine.play();
      setAutoPlay(false);
    }
  }, [autoPlay, phase, engine]);

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

  // Detect completion
  useEffect(() => {
    if (
      phase === 'reading' &&
      !engine.isPlaying &&
      engine.position >= engine.totalWords &&
      engine.totalWords > 0
    ) {
      if (lastPauseStart.current > 0) {
        totalPauseTime.current += Date.now() - lastPauseStart.current;
        lastPauseStart.current = 0;
      }
      const totalTime =
        (Date.now() - readingStartTime.current - totalPauseTime.current) / 1000;
      const effectiveWpm =
        totalTime > 0 ? Math.round(engine.totalWords / (totalTime / 60)) : 0;
      setCompletionStats({ totalTime, effectiveWpm });
      setPhase('complete');
    }
  }, [engine.isPlaying, engine.position, engine.totalWords, phase]);

  // Stable ref to engine for keyboard handler
  const engineRef = useRef(engine);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  // Keyboard shortcuts for reading + complete phases
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (phase !== 'reading' && phase !== 'complete') return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        tag === 'BUTTON' ||
        target.getAttribute('role') === 'slider'
      ) {
        return;
      }

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
          setPhase('reading');
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
      }
    },
    [phase]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Computed reading values
  const fontSize = getFontSize(engine.currentChunk);
  const showSettings = !engine.isPlaying && phase === 'reading';

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function tabClass(tab: InputTab, disabled = false) {
    if (disabled) return 'px-4 py-2 text-sm text-gray-600 cursor-not-allowed';
    return `px-4 py-2 text-sm cursor-pointer ${
      inputTab === tab
        ? 'text-gray-100 border-b-2 border-blue-500'
        : 'text-gray-400 hover:text-gray-200'
    }`;
  }

  function segmentClass(active: boolean) {
    return `px-3 py-1.5 text-sm rounded transition-colors ${
      active
        ? 'bg-blue-600 text-white'
        : 'bg-gray-800 text-gray-400 hover:text-gray-200 cursor-pointer'
    }`;
  }

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  // -------------------------------------------------------------------------
  // Upload handling
  // -------------------------------------------------------------------------

  async function handleFile(file: File) {
    setUploadError(null);
    setUploadedFileName(null);

    const name = file.name.toLowerCase();

    if (name.endsWith('.txt') || name.endsWith('.md')) {
      const content = await file.text();
      setText(content);
      setUploadedFileName(file.name);
      return;
    }

    if (name.endsWith('.pdf')) {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items
            .map((item) => ('str' in item ? (item.str ?? '') : ''))
            .join(' ');
          pages.push(pageText);
        }
        setText(pages.join('\n\n'));
        setUploadedFileName(file.name);
      } catch {
        setUploadError('Could not extract text from this PDF. Try a different file.');
      }
      return;
    }

    setUploadError('Unsupported file type. Please upload a .txt, .md, or .pdf file.');
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave() {
    setDragging(false);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  // -------------------------------------------------------------------------
  // Start reading
  // -------------------------------------------------------------------------

  function handleStart() {
    setPhase('reading');
    setSourceExpanded(false);
    readingStartTime.current = Date.now();
    totalPauseTime.current = 0;
    lastPauseStart.current = 0;
    engine.restart();
    engine.play();
  }

  // -------------------------------------------------------------------------
  // Render: complete phase
  // -------------------------------------------------------------------------

  if (phase === 'complete') {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-10 text-center">
          <h2 className="text-2xl font-semibold text-gray-100 mb-8">Finished</h2>

          {completionStats && (
            <div className="flex justify-center gap-12 mb-10">
              <div>
                <p className="text-3xl font-mono text-blue-400">
                  {formatTime(completionStats.totalTime)}
                </p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Time</p>
              </div>
              <div>
                <p className="text-3xl font-mono text-blue-400">
                  {completionStats.effectiveWpm.toLocaleString()}
                </p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Effective WPM</p>
              </div>
              <div>
                <p className="text-3xl font-mono text-blue-400">
                  {engine.totalWords.toLocaleString()}
                </p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Words</p>
              </div>
            </div>
          )}

          <div className="flex gap-3 justify-center">
            <button
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
              onClick={() => {
                engine.restart();
                readingStartTime.current = Date.now();
                totalPauseTime.current = 0;
                lastPauseStart.current = 0;
                setCompletionStats(null);
                setPhase('reading');
                setAutoPlay(true);
              }}
            >
              Read Again
            </button>
            <button
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors"
              onClick={() => {
                engine.restart();
                setCompletionStats(null);
                setPhase('input');
              }}
            >
              New Text
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: reading phase
  // -------------------------------------------------------------------------

  if (phase === 'reading') {
    const timeLeft = engine.estimatedTimeLeft;
    const progressPct = engine.progress * 100;

    return (
      <div className="max-w-2xl mx-auto select-none">
        {/* Display area */}
        <div className="py-20 flex items-center justify-center min-h-[160px]">
          {displayMode === 'orp' && (
            <ORPDisplay chunk={engine.currentChunk} fontSize={fontSize} />
          )}
          {displayMode === 'centered' && (
            <CenteredDisplay chunk={engine.currentChunk} fontSize={fontSize} />
          )}
          {displayMode === 'orp+context' && (
            <ContextDisplay
              chunk={engine.currentChunk}
              words={engine.words}
              position={engine.position}
              fontSize={fontSize}
            />
          )}
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
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>
              Word {engine.position} / {engine.totalWords}
            </span>
            <span>{formatTime(timeLeft)} left</span>
          </div>
        </div>

        {/* Transport controls */}
        <div className="flex items-center justify-center gap-3 mb-4">
          <button
            className="px-3 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm transition-colors"
            onClick={() => engine.seek(-10)}
            title="Seek back 10s (←)"
          >
            ←10s
          </button>
          <button
            className="px-5 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors min-w-[80px]"
            onClick={() => (engine.isPlaying ? engine.pause() : engine.play())}
            title="Play/Pause (Space)"
          >
            {engine.isPlaying ? 'Pause' : 'Play'}
          </button>
          <button
            className="px-3 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm transition-colors"
            onClick={() => engine.seek(10)}
            title="Seek forward 10s (→)"
          >
            10s→
          </button>
          <button
            className="px-3 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm transition-colors"
            onClick={() => {
              engine.restart();
              readingStartTime.current = Date.now();
              totalPauseTime.current = 0;
              lastPauseStart.current = 0;
            }}
            title="Restart (R)"
          >
            ↺ Restart
          </button>
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-center gap-4 text-xs text-gray-500 mb-4">
          <span>
            WPM: <span className="text-gray-300">{wpm}</span>{' '}
            <span className="text-gray-600">(↑↓)</span>
          </span>
          <span>
            Chunk: <span className="text-gray-300">{chunkSize}</span>{' '}
            <span className="text-gray-600">(C)</span>
          </span>
          <span>
            Mode: <span className="text-gray-300">{displayMode}</span>{' '}
            <span className="text-gray-600">(M)</span>
          </span>
          <button
            className="text-gray-500 hover:text-gray-300 transition-colors"
            onClick={() => setSourceExpanded((v) => !v)}
            title="Toggle source (T)"
          >
            Source <span className="text-gray-600">(T)</span>
          </button>
        </div>

        {/* Settings panel — visible on pause */}
        {showSettings && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
            <div className="flex flex-wrap gap-6 items-center">
              {/* WPM */}
              <div className="flex items-center gap-3 flex-1 min-w-48">
                <label className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  WPM
                </label>
                <input
                  type="range"
                  min={100}
                  max={800}
                  step={25}
                  value={wpm}
                  onChange={(e) => setWpm(Number(e.target.value))}
                  className="flex-1 accent-blue-500"
                />
                <input
                  type="number"
                  min={100}
                  max={800}
                  step={25}
                  value={wpm}
                  onChange={(e) =>
                    setWpm(Math.min(800, Math.max(100, Number(e.target.value))))
                  }
                  className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-center text-gray-100 focus:outline-none focus:border-gray-600"
                />
              </div>

              {/* Chunk size */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  Words
                </span>
                <div className="flex gap-1">
                  {([1, 2, 3] as const).map((n) => (
                    <button
                      key={n}
                      className={segmentClass(chunkSize === n)}
                      onClick={() => setChunkSize(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Display mode */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  Mode
                </span>
                <div className="flex gap-1">
                  {(
                    [
                      { value: 'orp', label: 'ORP' },
                      { value: 'centered', label: 'Centered' },
                      { value: 'orp+context', label: 'ORP + Context' },
                    ] as { value: DisplayMode; label: string }[]
                  ).map(({ value, label }) => (
                    <button
                      key={value}
                      className={segmentClass(displayMode === value)}
                      onClick={() => setDisplayMode(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Source panel — expands on pause or T key */}
        {(sourceExpanded || showSettings) && (
          <SourcePanel text={text} words={engine.words} position={engine.position} />
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: input phase
  // -------------------------------------------------------------------------

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold mb-6">Speed Reader</h2>

      {/* Input card */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mb-4">
        {/* Tabs */}
        <div className="flex border-b border-gray-800">
          <button
            className={tabClass('paste')}
            onClick={() => setInputTab('paste')}
          >
            Paste Text
          </button>
          <button
            className={tabClass('upload')}
            onClick={() => setInputTab('upload')}
          >
            Upload File
          </button>
          <span className={tabClass('vault', true)}>
            From Vault
          </span>
        </div>

        {/* Tab content */}
        <div className="p-4">
          {/* Paste tab */}
          {inputTab === 'paste' && (
            <div>
              <textarea
                className="w-full h-72 bg-gray-950 border border-gray-800 rounded p-3 text-sm text-gray-100 placeholder-gray-600 resize-none focus:outline-none focus:border-gray-700"
                placeholder="Paste your text here..."
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <p className="text-xs text-gray-500 mt-2">
                {wordCount > 0 ? `${wordCount.toLocaleString()} words` : 'No text yet'}
              </p>
            </div>
          )}

          {/* Upload tab */}
          {inputTab === 'upload' && (
            <div>
              <div
                className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors ${
                  dragging
                    ? 'border-blue-500 bg-blue-950/20'
                    : 'border-gray-700 hover:border-gray-600'
                }`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                <p className="text-gray-400 mb-2 text-sm">
                  Drag and drop a file here, or{' '}
                  <label className="text-blue-400 hover:text-blue-300 cursor-pointer underline">
                    browse
                    <input
                      type="file"
                      accept=".txt,.md,.pdf"
                      className="hidden"
                      onChange={handleFileInput}
                    />
                  </label>
                </p>
                <p className="text-xs text-gray-600">Supports .txt, .md, .pdf</p>
              </div>

              {uploadError && (
                <p className="text-sm text-red-400 mt-3">{uploadError}</p>
              )}

              {uploadedFileName && !uploadError && (
                <div className="mt-3">
                  <p className="text-sm text-gray-300">
                    <span className="text-green-400">Loaded:</span> {uploadedFileName}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {wordCount.toLocaleString()} words extracted
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Vault tab */}
          {inputTab === 'vault' && (
            <div className="py-8 text-center">
              <p className="text-sm text-gray-500">Vault search coming soon</p>
            </div>
          )}
        </div>
      </div>

      {/* Settings row */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap gap-6 items-center">
          {/* WPM */}
          <div className="flex items-center gap-3 flex-1 min-w-48">
            <label className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">
              WPM
            </label>
            <input
              type="range"
              min={100}
              max={800}
              step={25}
              value={wpm}
              onChange={(e) => setWpm(Number(e.target.value))}
              className="flex-1 accent-blue-500"
            />
            <input
              type="number"
              min={100}
              max={800}
              step={25}
              value={wpm}
              onChange={(e) => setWpm(Math.min(800, Math.max(100, Number(e.target.value))))}
              className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-center text-gray-100 focus:outline-none focus:border-gray-600"
            />
          </div>

          {/* Chunk size */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">
              Words
            </span>
            <div className="flex gap-1">
              {([1, 2, 3] as const).map((n) => (
                <button
                  key={n}
                  className={segmentClass(chunkSize === n)}
                  onClick={() => setChunkSize(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* Display mode */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">
              Mode
            </span>
            <div className="flex gap-1">
              {(
                [
                  { value: 'orp', label: 'ORP' },
                  { value: 'centered', label: 'Centered' },
                  { value: 'orp+context', label: 'ORP + Context' },
                ] as { value: DisplayMode; label: string }[]
              ).map(({ value, label }) => (
                <button
                  key={value}
                  className={segmentClass(displayMode === value)}
                  onClick={() => setDisplayMode(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Start button */}
      <button
        className="w-full py-3 rounded-lg text-sm font-medium transition-colors bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
        disabled={!text.trim()}
        onClick={handleStart}
      >
        Start Reading
      </button>
    </div>
  );
}
