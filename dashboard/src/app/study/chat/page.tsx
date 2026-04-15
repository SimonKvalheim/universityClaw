'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ConceptSummary } from '@/lib/study-db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'SETUP' | 'CHATTING' | 'ENDED';

type ChatMethod = 'Feynman' | 'Socratic' | 'Case Analysis' | 'Comparison' | 'Synthesis' | 'Free';

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  pending?: boolean;
}

const METHODS: ChatMethod[] = ['Feynman', 'Socratic', 'Case Analysis', 'Comparison', 'Synthesis', 'Free'];

const BLOOM_LABELS: Record<number, string> = {
  1: 'L1 Remember',
  2: 'L2 Understand',
  3: 'L3 Apply',
  4: 'L4 Analyse',
  5: 'L5 Evaluate',
  6: 'L6 Create',
};

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function StudyChatPage() {
  const [phase, setPhase] = useState<Phase>('SETUP');

  // SETUP state
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);
  const [conceptsLoading, setConceptsLoading] = useState(true);
  const [selectedConceptId, setSelectedConceptId] = useState<string>('');
  const [selectedMethod, setSelectedMethod] = useState<ChatMethod>('Feynman');

  // CHATTING state
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [isFirstMessage, setIsFirstMessage] = useState(true);

  const esRef = useRef<EventSource | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const currentAgentMsgIdRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Load concepts
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Parse query params for pre-selection
    const params = new URLSearchParams(window.location.search);
    const qConceptId = params.get('conceptId');
    const qMethod = params.get('method') as ChatMethod | null;

    fetch('/api/study/concepts')
      .then((r) => r.json())
      .then((data: { concepts: ConceptSummary[] }) => {
        const list = data.concepts ?? [];
        setConcepts(list);
        if (qConceptId) {
          setSelectedConceptId(qConceptId);
        } else if (list.length > 0) {
          setSelectedConceptId(list[0].id);
        }
        if (qMethod && METHODS.includes(qMethod)) {
          setSelectedMethod(qMethod);
        }
      })
      .catch(() => {
        // silently fail
      })
      .finally(() => setConceptsLoading(false));
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-scroll
  // ---------------------------------------------------------------------------

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ---------------------------------------------------------------------------
  // SSE cleanup on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Open SSE connection
  // ---------------------------------------------------------------------------

  const openSSE = useCallback((sid: string) => {
    const es = new EventSource(`/api/study/chat/stream/${sid}`);
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string; text?: string };

        if (data.type === 'message' && data.text) {
          const text = data.text;
          const agentMsgId = currentAgentMsgIdRef.current;

          if (!agentMsgId) {
            // Start a new agent message
            const newId = crypto.randomUUID();
            currentAgentMsgIdRef.current = newId;
            setMessages((prev) => [
              ...prev,
              { id: newId, role: 'agent', text, pending: true },
            ]);
          } else {
            // Append to existing agent message
            setMessages((prev) =>
              prev.map((m) =>
                m.id === agentMsgId ? { ...m, text: m.text + text } : m,
              ),
            );
          }
        } else if (data.type === 'closed') {
          // Mark current agent message as complete
          if (currentAgentMsgIdRef.current) {
            const doneId = currentAgentMsgIdRef.current;
            setMessages((prev) =>
              prev.map((m) => (m.id === doneId ? { ...m, pending: false } : m)),
            );
            currentAgentMsgIdRef.current = null;
          }
          es.close();
          setPhase('ENDED');
        } else if (data.type === 'turn_end') {
          // Agent finished speaking — mark message as complete, ready for next turn
          if (currentAgentMsgIdRef.current) {
            const doneId = currentAgentMsgIdRef.current;
            setMessages((prev) =>
              prev.map((m) => (m.id === doneId ? { ...m, pending: false } : m)),
            );
            currentAgentMsgIdRef.current = null;
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      es.close();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Start chat
  // ---------------------------------------------------------------------------

  function handleStartChat() {
    if (!selectedConceptId) return;
    const sid = crypto.randomUUID();
    setSessionId(sid);
    setMessages([]);
    setIsFirstMessage(true);
    currentAgentMsgIdRef.current = null;
    openSSE(sid);
    setPhase('CHATTING');
  }

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------

  async function handleSend() {
    const text = inputText.trim();
    if (!text || sending) return;

    setSending(true);
    setInputText('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Optimistic: add user message immediately
    const userMsgId = crypto.randomUUID();
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text }]);

    // Prepare placeholder for agent response
    const agentMsgId = crypto.randomUUID();
    currentAgentMsgIdRef.current = agentMsgId;
    setMessages((prev) => [...prev, { id: agentMsgId, role: 'agent', text: '', pending: true }]);

    try {
      const selectedConcept = concepts.find((c) => c.id === selectedConceptId);
      const bloomLevel = selectedConcept?.bloomCeiling ?? 1;

      const body: {
        sessionId: string;
        text: string;
        conceptId?: string;
        method?: string;
        bloomLevel?: number;
      } = { sessionId, text };

      if (isFirstMessage) {
        body.conceptId = selectedConceptId;
        body.method = selectedMethod;
        body.bloomLevel = bloomLevel;
        setIsFirstMessage(false);
      }

      await fetch('/api/study/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Remove the pending agent placeholder on error
      setMessages((prev) => prev.filter((m) => m.id !== agentMsgId));
      currentAgentMsgIdRef.current = null;
    } finally {
      setSending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // End session
  // ---------------------------------------------------------------------------

  async function handleEndSession() {
    esRef.current?.close();
    try {
      await fetch('/api/study/chat/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    } catch {
      // ignore
    }
    setPhase('ENDED');
  }

  // ---------------------------------------------------------------------------
  // Textarea auto-grow
  // ---------------------------------------------------------------------------

  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInputText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const selectedConcept = concepts.find((c) => c.id === selectedConceptId);

  // ---------------------------------------------------------------------------
  // Render: SETUP
  // ---------------------------------------------------------------------------

  if (phase === 'SETUP') {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-gray-100 mb-1">Chat with Tutor</h2>
          <p className="text-sm text-gray-500">Choose a concept and method to start a dialogue.</p>
        </div>

        {/* Concept selector */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-400">Concept</label>
          {conceptsLoading ? (
            <p className="text-sm text-gray-600">Loading concepts...</p>
          ) : concepts.length === 0 ? (
            <p className="text-sm text-gray-600">No active concepts. Approve concepts on the Study page first.</p>
          ) : (
            <select
              value={selectedConceptId}
              onChange={(e) => setSelectedConceptId(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-500"
            >
              {concepts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}{c.domain ? ` — ${c.domain}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Method selector */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-400">Method</label>
          <div className="grid grid-cols-3 gap-2">
            {METHODS.map((method) => (
              <button
                key={method}
                onClick={() => setSelectedMethod(method)}
                className={`py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                  selectedMethod === method
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-900 border border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                {method}
              </button>
            ))}
          </div>
        </div>

        {/* Start button */}
        <button
          onClick={handleStartChat}
          disabled={!selectedConceptId || conceptsLoading}
          className="w-full py-3 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
        >
          Start Chat
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: CHATTING
  // ---------------------------------------------------------------------------

  if (phase === 'CHATTING') {
    return (
      <div className="flex flex-col h-[calc(100vh-8rem)] max-w-3xl mx-auto">
        {/* Context bar */}
        <div className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800 rounded-t-lg shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-sm font-medium text-gray-100 truncate">
              {selectedConcept?.title ?? 'Chat'}
            </span>
            {selectedConcept?.domain && (
              <span className="text-xs text-gray-500 truncate hidden sm:inline">
                {selectedConcept.domain}
              </span>
            )}
            <span className="shrink-0 text-xs px-2 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-800">
              {selectedMethod}
            </span>
            {selectedConcept && selectedConcept.bloomCeiling > 0 && (
              <span className="shrink-0 text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">
                {BLOOM_LABELS[selectedConcept.bloomCeiling] ?? `L${selectedConcept.bloomCeiling}`}
              </span>
            )}
          </div>
          <button
            onClick={() => void handleEndSession()}
            className="shrink-0 ml-4 text-xs px-3 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
          >
            End Session
          </button>
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-950">
          {messages.length === 0 && (
            <div className="text-center py-12">
              <p className="text-sm text-gray-600">Type a message to begin the conversation.</p>
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-100'
                } ${msg.pending && msg.text === '' ? 'animate-pulse' : ''}`}
              >
                {msg.text || (msg.pending ? <span className="text-gray-500 italic">Thinking...</span> : '')}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="shrink-0 px-4 py-3 bg-gray-900 border-t border-gray-800 rounded-b-lg">
          <div className="flex items-end gap-3">
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
              rows={1}
              className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 resize-none focus:outline-none focus:border-gray-500 overflow-hidden"
              style={{ minHeight: '38px' }}
            />
            <button
              onClick={() => void handleSend()}
              disabled={!inputText.trim() || sending}
              className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: ENDED
  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-xl mx-auto py-16 text-center space-y-4">
      <div className="inline-flex items-center px-4 py-2 rounded-full bg-gray-800 border border-gray-700">
        <span className="text-sm text-gray-300">Session ended</span>
      </div>
      <p className="text-sm text-gray-500">
        Your conversation with the tutor has ended.
      </p>
      <div className="flex items-center justify-center gap-4 pt-2">
        <a
          href="/study"
          className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors"
        >
          Back to Study
        </a>
        <button
          onClick={() => {
            setPhase('SETUP');
            setMessages([]);
            setSessionId('');
            setIsFirstMessage(true);
            currentAgentMsgIdRef.current = null;
          }}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          New Chat
        </button>
      </div>
    </div>
  );
}
