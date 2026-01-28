"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Send,
  Sparkles,
  Bot,
  User,
  X,
  AlertCircle,
  Trash2,
  Brain,
  Zap,
  FileEdit,
  Check,
  Undo2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  image?: string; // Base64 string
  thoughts?: string; // Full accumulated thought summaries
  currentThought?: string; // Latest thought (for live preview)
  appliedCode?: string; // The code that was applied (for diff highlighting)
  previousCode?: string; // The code before the change (for diff highlighting)
  codeAccepted?: boolean; // true = accepted, false = rejected, undefined = pending
}

interface ResearchAssistantProps {
  isOpen: boolean;
  onClose: () => void;
  latexCode: string;
  screenshot: string | null;
  onScreenshotConsumed: () => void;
  onApplyCode?: (code: string) => void;
  onHighlightChanges?: (oldCode: string, newCode: string) => void;
  onRevertCode?: (previousCode: string) => void;
  docked?: boolean;
}

const STORAGE_KEY = "research-assistant-messages";
const DEFAULT_MESSAGE: Message = {
  id: "1",
  role: "assistant",
  content:
    "Hello! I'm your Gemini 3 co-scientist. I can help you research topics, fact-check your paper, or suggest improvements based on your LaTeX code. What are we working on?",
};

const APPLY_CODE_START = "<<<APPLY_CODE>>>";
const APPLY_CODE_END = "<<<END_CODE>>>";
const APPLYING_CODE_MARKER = "[[APPLYING_CODE]]";
const APPLIED_CODE_MARKER = "[[APPLIED_CODE]]";

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const AppliedCodeIndicator = ({
  status,
  onClick,
  onAccept,
  onReject,
  accepted,
}: {
  status: "applying" | "applied";
  onClick?: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  accepted?: boolean; // true = accepted, false = rejected, undefined = pending
}) => (
  <div className="flex items-center gap-2 text-zinc-400 animate-fade-in my-2">
    <div
      className={`flex items-center gap-1.5 ${
        status === "applied" && onClick
          ? "cursor-pointer hover:text-zinc-600 transition-colors"
          : ""
      }`}
      onClick={status === "applied" ? onClick : undefined}
      title={
        status === "applied" && onClick
          ? "Click to highlight changes in editor"
          : undefined
      }
    >
      <FileEdit
        size={14}
        className={`flex-shrink-0 ${status === "applying" ? "animate-pulse" : ""}`}
      />
      <span className="text-sm">
        {status === "applying"
          ? "Updating document…"
          : accepted === true
            ? "Changes accepted"
            : accepted === false
              ? "Changes reverted"
              : "Updated document"}
      </span>
    </div>
    {/* Accept/Reject buttons - only show when applied and not yet decided */}
    {status === "applied" &&
      accepted === undefined &&
      (onAccept || onReject) && (
        <div className="flex items-center gap-1 ml-1">
          {onAccept && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAccept();
              }}
              className="p-1 rounded hover:bg-green-100 text-zinc-400 hover:text-green-600 transition-colors"
              title="Accept changes"
            >
              <Check size={14} />
            </button>
          )}
          {onReject && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onReject();
              }}
              className="p-1 rounded hover:bg-red-100 text-zinc-400 hover:text-red-600 transition-colors"
              title="Revert changes"
            >
              <Undo2 size={14} />
            </button>
          )}
        </div>
      )}
  </div>
);

// Extract and hide <<<APPLY_CODE>>>...<<<END_CODE>>> blocks for display.
// Returns the extracted code block (if complete) for optional application.
const processApplyCodeBlocksForDisplay = (
  raw: string,
): { display: string; extractedCode?: string; hasCompleteBlock: boolean } => {
  const startIdx = raw.indexOf(APPLY_CODE_START);
  if (startIdx === -1) {
    return { display: raw, hasCompleteBlock: false };
  }

  const endIdx = raw.indexOf(
    APPLY_CODE_END,
    startIdx + APPLY_CODE_START.length,
  );

  // Streaming case: start marker present but end marker not yet present
  if (endIdx === -1) {
    const before = raw.slice(0, startIdx).trimEnd();
    const display = [before, APPLYING_CODE_MARKER].filter(Boolean).join("\n\n");
    return { display, hasCompleteBlock: false };
  }

  const codeBlock = raw
    .slice(startIdx + APPLY_CODE_START.length, endIdx)
    .trim();

  const before = raw.slice(0, startIdx).trimEnd();
  const after = raw.slice(endIdx + APPLY_CODE_END.length).trimStart();

  const display = [before, APPLIED_CODE_MARKER, after]
    .filter(Boolean)
    .join("\n\n");

  return { display, extractedCode: codeBlock, hasCompleteBlock: true };
};

// Component to render content with [[APPLYING_CODE]]/[[APPLIED_CODE]] markers replaced
const ContentWithAppliedCode = ({
  content,
  onClickApplied,
  onAccept,
  onReject,
  accepted,
}: {
  content: string;
  onClickApplied?: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  accepted?: boolean;
}) => {
  // Also sanitize any saved/older messages that still contain <<<APPLY_CODE>>> blocks.
  const processed = processApplyCodeBlocksForDisplay(content);
  const displayContent = processed.display;

  const markerRegex = new RegExp(
    `(${escapeRegExp(APPLYING_CODE_MARKER)}|${escapeRegExp(APPLIED_CODE_MARKER)})`,
    "g",
  );

  const parts = displayContent.split(markerRegex);

  // Fast path: no markers
  if (parts.length === 1) {
    return (
      <ReactMarkdown
        components={MARKDOWN_COMPONENTS}
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {displayContent}
      </ReactMarkdown>
    );
  }

  return (
    <>
      {parts.map((part, index) => {
        const trimmed = part.trim();

        if (trimmed === APPLYING_CODE_MARKER) {
          return (
            <AppliedCodeIndicator key={`marker-${index}`} status="applying" />
          );
        }

        if (trimmed === APPLIED_CODE_MARKER) {
          return (
            <AppliedCodeIndicator
              key={`marker-${index}`}
              status="applied"
              onClick={onClickApplied}
              onAccept={onAccept}
              onReject={onReject}
              accepted={accepted}
            />
          );
        }

        if (!trimmed) return null;

        return (
          <ReactMarkdown
            key={`md-${index}`}
            components={MARKDOWN_COMPONENTS}
            remarkPlugins={[remarkMath]}
            rehypePlugins={[rehypeKatex]}
          >
            {part}
          </ReactMarkdown>
        );
      })}
    </>
  );
};

// Define Markdown components outside to ensure stability and prevent re-mounting
const MARKDOWN_COMPONENTS: any = {
  code({ node, children, ...props }: any) {
    const className = node?.properties?.className?.join(" ") || "";
    const match = /language-(\w+)/.exec(className);
    const isInline = !match && !className;
    return !isInline && match ? (
      <div className="my-2 rounded border border-zinc-200 overflow-hidden text-[12px] animate-fade-in">
        <SyntaxHighlighter
          style={vscDarkPlus as any}
          language={match[1]}
          PreTag="div"
        >
          {String(children).replace(/\n$/, "")}
        </SyntaxHighlighter>
      </div>
    ) : (
      <code
        className="bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-900 font-mono text-xs border border-zinc-200"
        {...props}
      >
        {children}
      </code>
    );
  },
  p: ({ children }: any) => (
    <p className="mb-2 last:mb-0 animate-fade-in">{children}</p>
  ),
  ul: ({ children }: any) => (
    <ul className="list-disc ml-4 mb-2 marker:text-zinc-400 animate-fade-in">
      {children}
    </ul>
  ),
  ol: ({ children }: any) => (
    <ol className="list-decimal ml-4 mb-2 marker:text-zinc-400 animate-fade-in">
      {children}
    </ol>
  ),
  li: ({ children }: any) => (
    <li className="mb-1 animate-fade-in">{children}</li>
  ),
  h1: ({ children }: any) => (
    <h1 className="text-base font-bold mb-2 text-zinc-900 animate-fade-in">
      {children}
    </h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-sm font-bold mb-2 text-zinc-900 animate-fade-in">
      {children}
    </h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="text-sm font-semibold mb-1 text-zinc-900 animate-fade-in">
      {children}
    </h3>
  ),
};

// Memoized Message Item to prevent re-renders when input changes
const MessageItem = React.memo(
  ({
    msg,
    onHighlightChanges,
    onAcceptChanges,
    onRejectChanges,
  }: {
    msg: Message;
    onHighlightChanges?: (oldCode: string, newCode: string) => void;
    onAcceptChanges?: (messageId: string) => void;
    onRejectChanges?: (messageId: string, previousCode: string) => void;
  }) => {
    const [thoughtsExpanded, setThoughtsExpanded] = useState(false);

    // Get a preview of the current/latest thought (first line, max 80 chars)
    const thoughtsPreview = msg.currentThought
      ? msg.currentThought
          .replace(/\*\*/g, "")
          .split("\n")[0]
          .slice(0, 80)
          .trim() + (msg.currentThought.length > 80 ? "..." : "")
      : msg.thoughts
        ? msg.thoughts
            .replace(/\*\*/g, "")
            .split("\n")
            .pop()
            ?.slice(0, 80)
            .trim() + "..."
        : null;

    // Handler for clicking "Updated document" to highlight changes
    const handleClickApplied =
      msg.previousCode && msg.appliedCode && onHighlightChanges
        ? () => onHighlightChanges(msg.previousCode!, msg.appliedCode!)
        : undefined;

    // Handler for accepting changes
    const handleAccept =
      msg.appliedCode && onAcceptChanges && msg.codeAccepted === undefined
        ? () => onAcceptChanges(msg.id)
        : undefined;

    // Handler for rejecting changes (revert to previous code)
    const handleReject =
      msg.previousCode && onRejectChanges && msg.codeAccepted === undefined
        ? () => onRejectChanges(msg.id, msg.previousCode!)
        : undefined;

    return (
      <div
        className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
      >
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 border ${msg.role === "user" ? "bg-zinc-900 border-zinc-900" : "bg-white border-zinc-200"}`}
        >
          {msg.role === "user" ? (
            <User size={14} className="text-white" />
          ) : (
            <img
              src="https://upload.wikimedia.org/wikipedia/commons/thumb/1/1d/Google_Gemini_icon_2025.svg/960px-Google_Gemini_icon_2025.svg.png"
              alt="Gemini"
              className="w-5 h-5 object-contain"
            />
          )}
        </div>
        <div className={`max-w-[85%] flex flex-col gap-2`}>
          {/* Thought summaries - clickable to expand */}
          {msg.thoughts && (
            <div
              className="flex items-start gap-1.5 text-zinc-400 cursor-pointer hover:text-zinc-600 transition-colors"
              onClick={() => setThoughtsExpanded(!thoughtsExpanded)}
            >
              <Brain
                size={14}
                className={`mt-1 flex-shrink-0 ${msg.currentThought && !msg.content ? "animate-pulse" : ""}`}
              />
              {thoughtsExpanded ? (
                <div className="text-sm thoughts-content">
                  <ReactMarkdown
                    components={MARKDOWN_COMPONENTS}
                    remarkPlugins={[remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                  >
                    {msg.thoughts}
                  </ReactMarkdown>
                </div>
              ) : (
                <span className="text-sm">{thoughtsPreview}</span>
              )}
            </div>
          )}
          {msg.image && (
            <div className="rounded-sm overflow-hidden border border-zinc-200 shadow-sm animate-fade-in">
              <img
                src={msg.image}
                alt="Visual Context"
                className="w-full h-auto"
              />
            </div>
          )}
          <div
            className={`text-sm leading-relaxed ${
              msg.role === "user"
                ? "text-zinc-900 font-medium text-right"
                : "text-zinc-600"
            }`}
          >
            {msg.role === "assistant" ? (
              <ContentWithAppliedCode
                content={msg.content}
                onClickApplied={handleClickApplied}
                onAccept={handleAccept}
                onReject={handleReject}
                accepted={msg.codeAccepted}
              />
            ) : (
              <div className="whitespace-pre-wrap animate-fade-in">
                {msg.content}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
);
MessageItem.displayName = "MessageItem";

export default function ResearchAssistant({
  isOpen,
  onClose,
  latexCode,
  screenshot,
  onScreenshotConsumed,
  onApplyCode,
  onHighlightChanges,
  onRevertCode,
  docked = false,
}: ResearchAssistantProps) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([DEFAULT_MESSAGE]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isInitialized = useRef(false);

  // Handler for accepting code changes
  const handleAcceptChanges = React.useCallback((messageId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, codeAccepted: true } : m)),
    );
  }, []);

  // Handler for rejecting code changes (revert to previous)
  const handleRejectChanges = React.useCallback(
    (messageId: string, previousCode: string) => {
      // Revert the code in the editor
      if (onRevertCode) {
        onRevertCode(previousCode);
      }
      // Mark as rejected in the message
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, codeAccepted: false } : m,
        ),
      );
    },
    [onRevertCode],
  );

  // Load messages from localStorage on mount
  useEffect(() => {
    if (isInitialized.current) return;
    isInitialized.current = true;

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
        }
      }
    } catch (e) {
      console.error("Failed to load chat history:", e);
    }
  }, []);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    if (!isInitialized.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch (e) {
      console.error("Failed to save chat history:", e);
    }
  }, [messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading, isStreaming]);

  useEffect(() => {
    if (isOpen) {
      const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      };

      scrollToBottom();
      const timer1 = setTimeout(scrollToBottom, 100);
      const timer2 = setTimeout(scrollToBottom, 350);
      return () => {
        clearTimeout(timer1);
        clearTimeout(timer2);
      };
    }
  }, [isOpen]);

  // Handle incoming screenshot from parent
  useEffect(() => {
    if (screenshot && !isLoading) {
      const runAnalysis = async () => {
        const userMessage: Message = {
          id: Date.now().toString(),
          role: "user",
          content:
            "Please analyze the visual layout and content of this PDF page.",
          image: screenshot,
        };
        const updatedMessages = [...messages, userMessage];
        setMessages(updatedMessages);
        onScreenshotConsumed(); // Clear parent state
        await sendMessageToBackend(
          userMessage.content,
          screenshot,
          updatedMessages,
        );
      };
      runAnalysis();
    }
  }, [screenshot]);

  const sendMessageToBackend = async (
    text: string,
    imgData?: string,
    currentMessages?: Message[],
  ) => {
    setIsLoading(true);
    setError(null);

    // Build conversation history for context (exclude images to reduce payload)
    const history = (currentMessages || messages)
      .filter((m) => m.id !== "1") // Exclude the default greeting
      .map((m) => ({ role: m.role, content: m.content }));

    // Create a placeholder message for streaming
    const aiMessageId = (Date.now() + 1).toString();
    const aiMessage: Message = {
      id: aiMessageId,
      role: "assistant",
      content: "",
    };
    setMessages((prev) => [...prev, aiMessage]);

    try {
      const response = await fetch("http://localhost:8000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          latex_context: latexCode,
          image: imgData, // Optional base64 image
          history: history, // Conversation history for context
          agent_mode: agentMode, // Pass agent mode flag
        }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || "Failed to get response from Gemini");
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No response body");
      }

      let accumulatedContent = "";
      let accumulatedThoughts = "";
      let codeApplied = false;
      let previousCodeSnapshot = latexCode; // Capture current code before any changes

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.error) {
                throw new Error(data.error);
              }

              if (data.thought) {
                // Accumulate full thought summaries
                accumulatedThoughts += data.thought;
                // Update the message with both accumulated thoughts and current thought
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === aiMessageId
                      ? {
                          ...m,
                          thoughts: accumulatedThoughts,
                          currentThought: data.thought, // Latest thought for preview
                        }
                      : m,
                  ),
                );
              }

              if (data.content) {
                if (!accumulatedContent) {
                  setIsStreaming(true);
                }
                accumulatedContent += data.content;

                // Always sanitize displayed content so the user never sees the code/tags.
                const processed =
                  processApplyCodeBlocksForDisplay(accumulatedContent);

                // Apply the code exactly once (only when Agent Mode is enabled).
                const shouldApplyCode =
                  agentMode &&
                  !codeApplied &&
                  processed.hasCompleteBlock &&
                  processed.extractedCode &&
                  onApplyCode;

                if (shouldApplyCode) {
                  onApplyCode(processed.extractedCode);
                  codeApplied = true;
                }

                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === aiMessageId
                      ? {
                          ...m,
                          content: processed.display,
                          ...(shouldApplyCode && {
                            previousCode: previousCodeSnapshot,
                            appliedCode: processed.extractedCode,
                          }),
                        }
                      : m,
                  ),
                );
              }

              if (data.done) {
                // One final sanitize + apply pass (in case the last chunk was split oddly).
                const processed =
                  processApplyCodeBlocksForDisplay(accumulatedContent);

                const shouldApplyCodeFinal =
                  agentMode &&
                  !codeApplied &&
                  processed.hasCompleteBlock &&
                  processed.extractedCode &&
                  onApplyCode;

                if (shouldApplyCodeFinal) {
                  onApplyCode(processed.extractedCode);
                  codeApplied = true;
                }

                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === aiMessageId
                      ? {
                          ...m,
                          content: processed.display,
                          ...(shouldApplyCodeFinal && {
                            previousCode: previousCodeSnapshot,
                            appliedCode: processed.extractedCode,
                          }),
                        }
                      : m,
                  ),
                );
                break;
              }
            } catch (parseError) {
              // Skip malformed JSON lines
            }
          }
        }
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message);
      // Remove the empty AI message on error
      setMessages((prev) =>
        prev.filter((m) => m.id !== aiMessageId || m.content !== ""),
      );
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input,
    };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    await sendMessageToBackend(userMessage.content, undefined, updatedMessages);
  };

  const clearChat = () => {
    setMessages([DEFAULT_MESSAGE]);
    localStorage.removeItem(STORAGE_KEY);
  };

  if (!isOpen && !docked) return null;

  const containerClassName = docked
    ? `h-full w-full min-w-[280px] bg-white flex flex-col transition-opacity duration-200 ease-out ${isOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`
    : `fixed top-12 right-0 bottom-0 w-96 bg-white border-l border-zinc-200 shadow-xl flex flex-col z-50 transition-all duration-200 ease-out ${isOpen ? "opacity-100 translate-x-0" : "opacity-0 translate-x-full pointer-events-none"}`;

  return (
    <div className={containerClassName}>
      {/* Header */}
      <div className="h-12 border-b border-zinc-200 bg-white/50 backdrop-blur-sm flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-2 text-zinc-900">
          <Sparkles size={16} className="text-zinc-900" />
          <span className="font-medium text-sm tracking-tight">
            Research Assistant
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={clearChat}
            className="text-zinc-400 hover:text-zinc-900 transition-colors"
            title="Clear chat history"
          >
            <Trash2 size={16} />
          </button>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-900 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6 bg-white custom-scrollbar">
        {messages
          .filter((msg) => msg.role === "user" || msg.content || msg.thoughts)
          .map((msg) => (
            <MessageItem
              key={msg.id}
              msg={msg}
              onHighlightChanges={onHighlightChanges}
              onAcceptChanges={handleAcceptChanges}
              onRejectChanges={handleRejectChanges}
            />
          ))}

        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-md text-red-600 text-xs">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Agent Mode Toolbar + Input */}
      <div className="border-t border-zinc-200 bg-white">
        {/* Agent Mode Toggle */}
        <div className="px-4 py-2 border-b border-zinc-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap
              size={14}
              className={agentMode ? "text-amber-500" : "text-zinc-400"}
            />
            <span
              className={`text-xs font-medium ${agentMode ? "text-zinc-900" : "text-zinc-500"}`}
            >
              Agent Mode
            </span>
          </div>
          <button
            onClick={() => setAgentMode(!agentMode)}
            className={`relative w-9 h-5 rounded-full transition-colors ${agentMode ? "bg-amber-500" : "bg-zinc-200"}`}
            title="When enabled, AI can automatically apply code changes"
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${agentMode ? "translate-x-4" : "translate-x-0"}`}
            />
          </button>
        </div>

        {/* Input */}
        <div className="p-4">
          <div className="relative">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder={
                agentMode
                  ? "Ask the agent to make changes..."
                  : "Ask a question..."
              }
              className="w-full bg-white text-zinc-900 text-sm rounded-lg border border-zinc-300 pl-4 pr-12 py-3 focus:outline-none focus:ring-1 focus:ring-zinc-400 focus:border-zinc-400 transition-all placeholder:text-zinc-400 shadow-sm"
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 disabled:opacity-30 disabled:hover:text-zinc-500 transition-colors"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
