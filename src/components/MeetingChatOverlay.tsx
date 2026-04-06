import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStreamBuffer } from '../hooks/useStreamBuffer';
import { X, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import nativelyIcon from './icon.png';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

// ============================================
// Types 
// ============================================

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    isStreaming?: boolean;
}

interface MeetingContext {
    id?: string;  // Required for RAG queries
    title: string;
    summary?: string;
    keyPoints?: string[];
    actionItems?: string[];
    transcript?: Array<{ speaker: string; text: string; timestamp: number }>;
}

interface MeetingChatOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    meetingContext: MeetingContext;
    initialQuery?: string;
    onNewQuery: (query: string) => void;
}

type ChatState = 'idle' | 'opening' | 'waiting_for_llm' | 'streaming_response' | 'error' | 'closing';
type ResponseMode = 'answer' | 'behavioral' | 'system_design';

const MODE_META: Record<ResponseMode, { badge: string; short: string }> = {
    answer: { badge: '⚡ Answer', short: 'Answer' },
    behavioral: { badge: '🎯 Behavioral', short: 'Behavioral' },
    system_design: { badge: '🏗 System Design', short: 'Design' }
};

function getModeInstruction(mode: ResponseMode): string {
    if (mode === 'behavioral') {
        return 'Use STAR format (Situation, Task, Action, Result). Keep it concise and outcome-focused.';
    }
    if (mode === 'system_design') {
        return 'Use this structure: Requirements, Architecture, Scaling, Trade-offs. Keep it practical and concise.';
    }
    return 'Answer directly and clearly with concrete details. Keep it concise.';
}

// ============================================
// Typing Indicator Component
// ============================================

const TypingIndicator: React.FC = () => (
    <div className="flex items-center gap-2 py-4">
        <div className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
                <motion.div
                    key={i}
                    className="w-2 h-2 rounded-full bg-text-tertiary"
                    animate={{ opacity: [0.4, 1, 0.4] }}
                    transition={{
                        duration: 0.6,
                        repeat: Infinity,
                        delay: i * 0.15,
                        ease: "easeInOut"
                    }}
                />
            ))}
        </div>
        <span className="text-[13px] text-text-tertiary">Thinking...</span>
    </div>
);

// ============================================
// Message Components
// ============================================

const UserMessage: React.FC<{ content: string; delay?: number }> = ({ content, delay = 0 }) => (
    <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut', delay }}
        className="flex justify-end mb-6"
    >
        <div className="bg-accent-primary text-white px-5 py-3 rounded-2xl rounded-tr-md max-w-[70%] text-[15px] leading-relaxed shadow-sm transition-all duration-200 ease-out hover:shadow-md">
            {content}
        </div>
    </motion.div>
);

const AssistantMessage: React.FC<{ content: string; isStreaming?: boolean; delay?: number }> = ({ content, isStreaming, delay = 0 }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <motion.div
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut', delay }}
            className="flex flex-col items-start mb-6"
        >
            <motion.div
                whileHover={{ y: -1, scale: 1.005 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="max-w-[85%] rounded-2xl border border-border-subtle bg-bg-tertiary/55 px-4 py-3 shadow-sm transition-all duration-200 ease-out hover:shadow-md"
            >
                <div className="text-text-primary text-[15px] leading-relaxed">
                    <div className="markdown-content">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex]}
                            components={{
                                p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0 whitespace-pre-wrap" {...props} />,
                                a: ({ node, ...props }: any) => <a className="text-blue-500 hover:underline" {...props} />,
                                pre: ({ children }: any) => <div className="not-prose mb-4">{children}</div>,
                                code: ({ node, inline, className, children, ...props }: any) => {
                                    const match = /language-(\w+)/.exec(className || '');
                                    const isInline = inline ?? false;
                                    const lang = match ? match[1] : '';

                                    return !isInline ? (
                                        <div className="my-3 rounded-xl overflow-hidden border border-white/[0.08] shadow-lg bg-zinc-800/60 backdrop-blur-md">
                                            <div className="bg-white/[0.04] px-3 py-1.5 border-b border-white/[0.08]">
                                                <span className="text-[10px] uppercase tracking-widest font-semibold text-white/40 font-mono">
                                                    {lang || 'CODE'}
                                                </span>
                                            </div>
                                            <div className="bg-transparent">
                                                <SyntaxHighlighter
                                                    language={lang || 'text'}
                                                    style={vscDarkPlus}
                                                    customStyle={{
                                                        margin: 0,
                                                        borderRadius: 0,
                                                        fontSize: '13px',
                                                        lineHeight: '1.6',
                                                        background: 'transparent',
                                                        padding: '16px',
                                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                                                    }}
                                                    wrapLongLines={true}
                                                    showLineNumbers={true}
                                                    lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1.2em', color: 'rgba(255,255,255,0.2)', textAlign: 'right', fontSize: '11px' }}
                                                    {...props}
                                                >
                                                    {String(children).replace(/\n$/, '')}
                                                </SyntaxHighlighter>
                                            </div>
                                        </div>
                                    ) : (
                                        <code className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[13px] font-mono text-text-primary border border-border-subtle whitespace-pre-wrap" {...props}>
                                            {children}
                                        </code>
                                    );
                                },
                            }}
                        >
                            {content}
                        </ReactMarkdown>
                    </div>
                    {isStreaming && (
                        <motion.span
                            className="inline-block w-0.5 h-4 bg-text-secondary ml-0.5 align-middle"
                            animate={{ opacity: [1, 0] }}
                            transition={{ duration: 0.5, repeat: Infinity }}
                        />
                    )}
                </div>
            </motion.div>
            {!isStreaming && content && (
                <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={handleCopy}
                    className="flex items-center gap-2 mt-3 text-[13px] text-text-tertiary hover:text-text-secondary transition-all duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                >
                    {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy message'}
                </motion.button>
            )}
        </motion.div>
    );
};

// ============================================
// Main Component
// ============================================

const MeetingChatOverlay: React.FC<MeetingChatOverlayProps> = ({
    isOpen,
    onClose,
    meetingContext,
    initialQuery = '',
    // onNewQuery
}) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [chatState, setChatState] = useState<ChatState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [mode, setMode] = useState<ResponseMode>('answer');

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);
    const streamBuffer = useStreamBuffer();

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Submit initial query when overlay opens
    useEffect(() => {
        if (isOpen && initialQuery && messages.length === 0) {
            setChatState('opening');
            setTimeout(() => {
                submitQuestion(initialQuery);
            }, 100);
        }
    }, [isOpen, initialQuery]);

    // Listen for new queries from parent
    useEffect(() => {
        if (isOpen && initialQuery && messages.length > 0) {
            // This is a follow-up query
            submitQuestion(initialQuery);
        }
    }, [initialQuery]);

    // Reset state when overlay closes
    useEffect(() => {
        if (!isOpen) {
            setChatState('idle');
            setMessages([]);
            setErrorMessage(null);
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;

        let mounted = true;
        window.electronAPI?.getIntelligenceResponseMode?.()
            .then((result) => {
                if (!mounted || !result?.mode) return;
                setMode(result.mode);
            })
            .catch((error) => {
                console.warn('[MeetingChat] Failed to fetch response mode:', error);
            });

        const cleanup = window.electronAPI?.onIntelligenceResponseModeChanged?.((data) => {
            if (data?.mode) {
                setMode(data.mode);
            }
        });

        return () => {
            mounted = false;
            cleanup?.();
        };
    }, [isOpen]);

    // ESC key handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                handleClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    // Click outside handler
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            handleClose();
        }
    }, []);

    const handleClose = useCallback(() => {
        onClose();
    }, [onClose]);

    const handleModeChange = useCallback(async (nextMode: ResponseMode) => {
        setMode(nextMode);
        try {
            await window.electronAPI?.setIntelligenceResponseMode?.(nextMode);
        } catch (error) {
            console.error('[MeetingChat] Failed to set response mode:', error);
        }
    }, []);

    // Build context string for LLM
    const buildContextString = useCallback((): string => {
        const parts: string[] = [];

        parts.push(`MEETING: ${meetingContext.title}`);

        if (meetingContext.summary) {
            parts.push(`\nSUMMARY:\n${meetingContext.summary}`);
        }

        if (meetingContext.keyPoints?.length) {
            parts.push(`\nKEY POINTS:\n${meetingContext.keyPoints.map(p => `- ${p}`).join('\n')}`);
        }

        if (meetingContext.actionItems?.length) {
            parts.push(`\nACTION ITEMS:\n${meetingContext.actionItems.map(a => `- ${a}`).join('\n')}`);
        }

        if (meetingContext.transcript?.length) {
            const recentTranscript = meetingContext.transcript.slice(-20);
            const transcriptText = recentTranscript
                .map(t => `[${t.speaker === 'user' ? 'Me' : 'Them'}]: ${t.text}`)
                .join('\n');
            parts.push(`\nRECENT TRANSCRIPT:\n${transcriptText}`);
        }

        return parts.join('\n');
    }, [meetingContext]);

    // Submit question using RAG streaming
    const submitQuestion = useCallback(async (question: string) => {
        if (!question.trim() || chatState === 'waiting_for_llm' || chatState === 'streaming_response') return;

        const modeInstruction = getModeInstruction(mode);

        try {
            await window.electronAPI?.setIntelligenceResponseMode?.(mode);
        } catch {
            // Keep chat responsive even if mode sync fails.
        }

        const userMessage: Message = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: question
        };
        setMessages(prev => [...prev, userMessage]);
        setChatState('waiting_for_llm');
        setErrorMessage(null);

        const assistantMessageId = `assistant-${Date.now()}`;

        try {
            // Add typing indicator delay (200ms) - makes the AI feel "thoughtful"
            await new Promise(resolve => setTimeout(resolve, 200));

            // Create assistant message placeholder
            setMessages(prev => [...prev, {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                isStreaming: true
            }]);

            // Set up RAG streaming listeners (RAF-batched to avoid per-token re-renders)
            streamBuffer.reset();
            const tokenCleanup = window.electronAPI?.onRAGStreamChunk((data: { chunk: string }) => {
                setChatState('streaming_response');
                streamBuffer.appendToken(data.chunk, (content) => {
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content }
                            : msg
                    ));
                });
            });

            const doneCleanup = window.electronAPI?.onRAGStreamComplete(() => {
                // Final commit — flush any remaining buffered content
                const finalContent = streamBuffer.getBufferedContent();
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: finalContent, isStreaming: false }
                        : msg
                ));
                setChatState('idle');
                streamBuffer.reset();
                tokenCleanup?.();
                doneCleanup?.();
                errorCleanup?.();
            });

            const errorCleanup = window.electronAPI?.onRAGStreamError((data: { error: string }) => {
                console.error('[MeetingChat] RAG stream error:', data.error);
                setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                setErrorMessage("Couldn't get a response. Please try again.");
                setChatState('error');
                streamBuffer.reset();
                tokenCleanup?.();
                doneCleanup?.();
                errorCleanup?.();
            });

            // Get meeting ID from context for RAG queries
            const meetingId = meetingContext.id;

            if (meetingId) {
                // Use RAG-powered meeting query
                const result = await window.electronAPI?.ragQueryMeeting(meetingId, question);

                // If RAG not available (or failed), fall back to context-window chat
                if (result?.fallback) {
                    console.log("[MeetingChat] RAG unavailable, using context window fallback");
                    // Cleanup RAG listeners since we won't use them
                    tokenCleanup?.();
                    doneCleanup?.();
                    errorCleanup?.();

                    // FALLBACK LOGIC
                    const contextString = buildContextString();
                    const systemPrompt = `You are recalling a specific meeting. Answer questions ONLY about this meeting. Be concise (2-4 sentences). Sound natural, like a human recalling. If information is not present, say so briefly. Never guess.

RESPONSE MODE:
${modeInstruction}

${contextString}`;

                    streamBuffer.reset();
                    const oldTokenCleanup = window.electronAPI?.onGeminiStreamToken((token: string) => {
                        setChatState('streaming_response');
                        streamBuffer.appendToken(token, (content) => {
                            setMessages(prev => prev.map(msg =>
                                msg.id === assistantMessageId
                                    ? { ...msg, content }
                                    : msg
                            ));
                        });
                    });

                    const oldDoneCleanup = window.electronAPI?.onGeminiStreamDone(() => {
                        const finalContent = streamBuffer.getBufferedContent();
                        setMessages(prev => prev.map(msg =>
                            msg.id === assistantMessageId
                                ? { ...msg, content: finalContent, isStreaming: false }
                                : msg
                        ));
                        streamBuffer.reset();
                        oldTokenCleanup?.();
                        oldDoneCleanup?.();
                        oldErrorCleanup?.();
                    });

                    const oldErrorCleanup = window.electronAPI?.onGeminiStreamError((error: string) => {
                        console.error('[MeetingChat] Gemini stream error (fallback):', error);
                        setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                        setErrorMessage("Couldn't get a response. Please check your settings.");
                        setChatState('error');
                        streamBuffer.reset();
                        oldTokenCleanup?.();
                        oldDoneCleanup?.();
                        oldErrorCleanup?.();
                    });

                    await window.electronAPI?.streamGeminiChat(
                        question,
                        undefined,
                        systemPrompt,
                        { skipSystemPrompt: true }
                    );
                }
            } else {
                // No meeting ID, standard fallback
                const contextString = buildContextString();
                const systemPrompt = `You are recalling a specific meeting. Answer questions ONLY about this meeting. Be concise (2-4 sentences). Sound natural, like a human recalling. If information is not present, say so briefly. Never guess.

RESPONSE MODE:
${modeInstruction}

${contextString}`;

                // Switch to Gemini streaming (RAF-batched)
                streamBuffer.reset();
                const oldTokenCleanup = window.electronAPI?.onGeminiStreamToken((token: string) => {
                    setChatState('streaming_response');
                    streamBuffer.appendToken(token, (content) => {
                        setMessages(prev => prev.map(msg =>
                            msg.id === assistantMessageId
                                ? { ...msg, content }
                                : msg
                        ));
                    });
                });

                const oldDoneCleanup = window.electronAPI?.onGeminiStreamDone(() => {
                    const finalContent = streamBuffer.getBufferedContent();
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content: finalContent, isStreaming: false }
                            : msg
                    ));
                    setChatState('idle');
                    streamBuffer.reset();
                    oldTokenCleanup?.();
                    oldDoneCleanup?.();
                    oldErrorCleanup?.();
                });

                const oldErrorCleanup = window.electronAPI?.onGeminiStreamError((error: string) => {
                    console.error('[MeetingChat] Gemini stream error:', error);
                    setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                    setErrorMessage("Couldn't get a response. Please check your settings.");
                    setChatState('error');
                    streamBuffer.reset();
                    oldTokenCleanup?.();
                    oldDoneCleanup?.();
                    oldErrorCleanup?.();
                });

                await window.electronAPI?.streamGeminiChat(
                    question,
                    undefined,
                    systemPrompt,
                    { skipSystemPrompt: true }
                );
            }

        } catch (error) {
            console.error('[MeetingChat] Error:', error);
            setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
            setErrorMessage("Something went wrong. Please try again.");
            setChatState('error');
        }
    }, [chatState, buildContextString, meetingContext, mode]);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="absolute inset-0 z-40 flex flex-col justify-end backdrop-blur-md"
                    onClick={handleBackdropClick}
                >
                    {/* Backdrop with blur */}
                    <motion.div
                        initial={{ backdropFilter: 'blur(0px)' }}
                        animate={{ backdropFilter: 'blur(8px)' }}
                        exit={{ backdropFilter: 'blur(0px)' }}
                        transition={{ duration: 0.16 }}
                        className="absolute inset-0 bg-black/40"
                    />

                    {/* Chat Window - extends to bottom, leaves room for input */}
                    <motion.div
                        ref={chatWindowRef}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "85vh", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                            height: { type: "spring", stiffness: 300, damping: 30, mass: 0.8 },
                            opacity: { duration: 0.2 }
                        }}
                        className="relative mx-auto w-full max-w-[680px] mb-0 bg-bg-secondary rounded-t-[24px] border-t border-x border-border-subtle shadow-2xl overflow-hidden flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header with close button */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
                            <div className="flex items-center gap-2 text-text-tertiary">
                                <img src={nativelyIcon} className="w-3.5 h-3.5 force-black-icon opacity-50" alt="logo" />
                                <span className="text-[13px] font-medium">Search this meeting</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="inline-flex items-center rounded-full border border-border-subtle bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-secondary">
                                    {MODE_META[mode].badge}
                                </span>
                                <motion.button
                                    whileHover={{ scale: 1.03 }}
                                    whileTap={{ scale: 0.96 }}
                                    onClick={handleClose}
                                    className="p-2 transition-all duration-200 ease-out group focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                                >
                                    <X size={16} className="text-text-tertiary group-hover:text-red-500 group-hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-all duration-300" />
                                </motion.button>
                            </div>
                        </div>

                        <div className="px-4 py-2 border-b border-border-subtle shrink-0 flex items-center gap-2">
                            {(['answer', 'behavioral', 'system_design'] as ResponseMode[]).map((option) => (
                                <motion.button
                                    key={option}
                                    whileHover={{ scale: 1.03 }}
                                    whileTap={{ scale: 0.96 }}
                                    onClick={() => handleModeChange(option)}
                                    className={`px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/30 ${mode === option
                                        ? 'bg-accent-primary text-white border-accent-primary shadow-[0_0_12px_rgba(59,130,246,0.3)]'
                                        : 'bg-bg-tertiary text-text-secondary border-border-subtle hover:text-text-primary'
                                        }`}
                                >
                                    {MODE_META[option].short}
                                </motion.button>
                            ))}
                        </div>

                        {/* Messages area - scrollable */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 pb-32 custom-scrollbar">
                                {messages.map((msg, index) => (
                                msg.role === 'user'
                                    ? <UserMessage key={msg.id} content={msg.content} delay={index * 0.02} />
                                    : <AssistantMessage key={msg.id} content={msg.content} isStreaming={msg.isStreaming} delay={index * 0.02} />
                            ))}

                            {(chatState === 'waiting_for_llm' || chatState === 'streaming_response') && <TypingIndicator />}

                            {errorMessage && (
                                <motion.div
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="text-[#FF6B6B] text-[13px] py-2"
                                >
                                    {errorMessage}
                                </motion.div>
                            )}

                            <div ref={messagesEndRef} />
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default MeetingChatOverlay;
