"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
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
  Plus,
  Image as ImageIcon,
  FileText,
  GripHorizontal,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
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
  onApplyCode?: (code: string) => void;
  onHighlightChanges?: (oldCode: string, newCode: string) => void;
  onRevertCode?: (previousCode: string) => void;
  docked?: boolean;
  isDarkMode?: boolean;
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
// When showMarker is false, the code block is stripped without showing "Updated document"
const processApplyCodeBlocksForDisplay = (
  raw: string,
  showMarker: boolean = true,
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
    // Only show "Updating document..." if agent mode is on
    const display = showMarker
      ? [before, APPLYING_CODE_MARKER].filter(Boolean).join("\n\n")
      : before;
    return { display, hasCompleteBlock: false };
  }

  const codeBlock = raw
    .slice(startIdx + APPLY_CODE_START.length, endIdx)
    .trim();

  const before = raw.slice(0, startIdx).trimEnd();
  const after = raw.slice(endIdx + APPLY_CODE_END.length).trimStart();

  // Only show "Updated document" marker if agent mode is on
  const display = showMarker
    ? [before, APPLIED_CODE_MARKER, after].filter(Boolean).join("\n\n")
    : [before, after].filter(Boolean).join("\n\n");

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
  // For old messages, strip without marker since we don't have agent mode context.
  const processed = processApplyCodeBlocksForDisplay(content, false);
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
      <div className="my-2 rounded-lg border border-zinc-200 dark:border-zinc-600 overflow-hidden text-[12px] animate-fade-in bg-zinc-50 dark:bg-zinc-900 shadow-sm">
        <SyntaxHighlighter
          style={oneLight as any}
          language={match[1]}
          PreTag="div"
          customStyle={{
            margin: 0,
            padding: "12px",
            background: "transparent",
            fontSize: "12px",
          }}
          codeTagProps={{
            className: "dark:invert dark:hue-rotate-180",
          }}
        >
          {String(children).replace(/\n$/, "")}
        </SyntaxHighlighter>
      </div>
    ) : (
      <code
        className="bg-zinc-100 dark:bg-zinc-700 px-1.5 py-0.5 rounded text-zinc-900 dark:text-zinc-100 font-mono text-xs border border-zinc-200 dark:border-zinc-600"
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
    <h1 className="text-base font-bold mb-2 text-zinc-900 dark:text-zinc-100 animate-fade-in">
      {children}
    </h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-sm font-bold mb-2 text-zinc-900 dark:text-zinc-100 animate-fade-in">
      {children}
    </h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="text-sm font-semibold mb-1 text-zinc-900 dark:text-zinc-100 animate-fade-in">
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
    isDarkMode = false,
  }: {
    msg: Message;
    onHighlightChanges?: (oldCode: string, newCode: string) => void;
    onAcceptChanges?: (messageId: string) => void;
    onRejectChanges?: (messageId: string, previousCode: string) => void;
    isDarkMode?: boolean;
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
        className={`flex gap-2.5 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
      >
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm ${msg.role === "user" ? "bg-zinc-900 dark:bg-zinc-100" : "bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700"}`}
        >
          {msg.role === "user" ? (
            <User size={12} className="text-white dark:text-zinc-900" />
          ) : (
            <img
              src="https://upload.wikimedia.org/wikipedia/commons/thumb/1/1d/Google_Gemini_icon_2025.svg/960px-Google_Gemini_icon_2025.svg.png"
              alt="Gemini"
              className="w-4 h-4 object-contain"
            />
          )}
        </div>
        <div className={`max-w-[85%] flex flex-col gap-2`}>
          {/* Thought summaries - clickable to expand */}
          {msg.thoughts && (
            <div
              className="flex items-start gap-1.5 text-zinc-400 cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
              onClick={() => setThoughtsExpanded(!thoughtsExpanded)}
            >
              <Brain
                size={12}
                className={`mt-0.5 flex-shrink-0 ${msg.currentThought && !msg.content ? "animate-pulse" : ""}`}
              />
              {thoughtsExpanded ? (
                <div className="text-xs thoughts-content">
                  <ReactMarkdown
                    components={MARKDOWN_COMPONENTS}
                    remarkPlugins={[remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                  >
                    {msg.thoughts}
                  </ReactMarkdown>
                </div>
              ) : (
                <span className="text-xs">{thoughtsPreview}</span>
              )}
            </div>
          )}
          {msg.image && (
            <div className="rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700 shadow-sm animate-fade-in">
              <img
                src={msg.image}
                alt="Visual Context"
                className="w-full h-auto max-w-[200px]"
              />
            </div>
          )}
          {/* Only render content bubble when there's actual content */}
          {msg.content && (
            <div
              className={`text-[13px] leading-relaxed ${
                msg.role === "user"
                  ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-2 rounded-2xl rounded-tr-md shadow-sm"
                  : "text-zinc-600 dark:text-zinc-300 bg-white dark:bg-zinc-800 px-3 py-2 rounded-2xl rounded-tl-md border border-zinc-200 dark:border-zinc-700 shadow-sm"
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
          )}
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
  onApplyCode,
  onHighlightChanges,
  onRevertCode,
  docked = false,
  isDarkMode = false,
}: ResearchAssistantProps) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([DEFAULT_MESSAGE]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [isAttachmentOpen, setIsAttachmentOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const attachmentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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

  // Close attachment menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        attachmentRef.current &&
        !attachmentRef.current.contains(event.target as Node)
      ) {
        setIsAttachmentOpen(false);
      }
    };

    if (isAttachmentOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isAttachmentOpen]);

  // Handle paste events for images
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
              const base64 = event.target?.result as string;
              setPendingImage(base64);
            };
            reader.readAsDataURL(file);
          }
          break;
        }
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, []);

  // Attach PDF preview (capture canvas from react-pdf)
  const handleAttachPreview = () => {
    const canvas = document.querySelector(
      ".react-pdf__Page__canvas",
    ) as HTMLCanvasElement;
    if (canvas) {
      const base64Image = canvas.toDataURL("image/png");
      setPendingImage(base64Image);
      setIsAttachmentOpen(false);
    } else {
      setError("Could not capture PDF preview. Make sure the PDF is visible.");
    }
  };

  // Handle file selection for image attachment
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        setPendingImage(base64);
      };
      reader.readAsDataURL(file);
    }
    // Reset input so the same file can be selected again
    e.target.value = "";
    setIsAttachmentOpen(false);
  };

  // Clear pending image
  const clearPendingImage = () => {
    setPendingImage(null);
  };

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
                // Only show "Updated document" marker when agent mode is on.
                const processed = processApplyCodeBlocksForDisplay(
                  accumulatedContent,
                  agentMode,
                );

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
                const processed = processApplyCodeBlocksForDisplay(
                  accumulatedContent,
                  agentMode,
                );

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
    if ((!input.trim() && !pendingImage) || isLoading) return;
    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content:
        input.trim() || (pendingImage ? "Please analyze this image." : ""),
      image: pendingImage || undefined,
    };
    const imageToSend = pendingImage;
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setPendingImage(null);
    await sendMessageToBackend(
      userMessage.content,
      imageToSend || undefined,
      updatedMessages,
    );
  };

  const clearChat = () => {
    setMessages([DEFAULT_MESSAGE]);
    localStorage.removeItem(STORAGE_KEY);
  };

  if (!isOpen && !docked) return null;

  const containerClassName = docked
    ? `h-full w-full min-w-[280px] bg-white dark:bg-zinc-900 flex flex-col transition-opacity duration-200 ease-out ${isOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`
    : `fixed top-12 right-0 bottom-0 w-96 bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-700 shadow-xl flex flex-col z-50 transition-all duration-200 ease-out ${isOpen ? "opacity-100 translate-x-0" : "opacity-0 translate-x-full pointer-events-none"}`;

  return (
    <div className={containerClassName}>
      {/* Header */}
      <div className="h-11 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 flex items-center px-3 justify-between shrink-0">
        <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
          <div className="w-6 h-6 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
            <Sparkles size={12} className="text-zinc-600 dark:text-zinc-400" />
          </div>
          <span className="font-medium text-xs tracking-tight text-zinc-600 dark:text-zinc-400">
            Research Assistant
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={clearChat}
            className="p-1.5 rounded-full text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            title="Clear chat history"
          >
            <Trash2 size={14} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 bg-zinc-50 dark:bg-zinc-950 custom-scrollbar">
        {messages
          .filter((msg) => msg.role === "user" || msg.content || msg.thoughts)
          .map((msg) => (
            <MessageItem
              key={msg.id}
              msg={msg}
              onHighlightChanges={onHighlightChanges}
              onAcceptChanges={handleAcceptChanges}
              onRejectChanges={handleRejectChanges}
              isDarkMode={isDarkMode}
            />
          ))}

        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950 border border-red-100 dark:border-red-900 rounded-xl text-red-600 dark:text-red-400 text-xs shadow-sm">
            <AlertCircle size={12} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-3 bg-zinc-50 dark:bg-zinc-950">
        {/* Hidden file input for image selection */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleImageSelect}
          className="hidden"
        />

        {/* Pending image preview */}
        {pendingImage && (
          <div className="mb-3 relative inline-block animate-fade-in">
            <img
              src={pendingImage}
              alt="Attachment preview"
              className="max-h-24 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-sm"
            />
            <button
              onClick={clearPendingImage}
              className="absolute -top-2 -right-2 p-1 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-full hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors shadow-md"
              title="Remove attachment"
            >
              <X size={10} />
            </button>
          </div>
        )}

        {/* Floating Input Bar */}
        <div className="bg-white/90 dark:bg-zinc-800/90 backdrop-blur border border-zinc-200 dark:border-zinc-700 shadow-lg rounded-full px-2 py-1.5 flex items-center gap-1 transition-all">
          {/* Attachment Button Group */}
          <div ref={attachmentRef} className="flex items-center">
            <div className="flex items-center">
              {/* Expandable attachment options */}
              <div
                className={`flex items-center overflow-hidden transition-all duration-300 ease-out ${
                  isAttachmentOpen
                    ? "max-w-[80px] opacity-100"
                    : "max-w-0 opacity-0"
                }`}
              >
                <button
                  onClick={handleAttachPreview}
                  className="p-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                  title="Attach PDF preview"
                >
                  <FileText size={16} />
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="p-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                  title="Attach image from computer"
                >
                  <ImageIcon size={16} />
                </button>
              </div>

              {/* Plus button */}
              <button
                onClick={() => setIsAttachmentOpen(!isAttachmentOpen)}
                className="p-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                title={isAttachmentOpen ? "Close" : "Add attachment"}
              >
                <Plus
                  size={16}
                  className={`transition-transform duration-300 ${
                    isAttachmentOpen ? "rotate-45" : "rotate-0"
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="w-[1px] h-4 bg-zinc-200 dark:bg-zinc-700"></div>

          {/* Agent Mode Toggle */}
          <button
            onClick={() => setAgentMode(!agentMode)}
            className={`p-1.5 rounded-full transition-colors ${
              agentMode
                ? "bg-amber-100 dark:bg-amber-900 text-amber-600 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-800"
                : "hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
            title={agentMode ? "Agent Mode: ON" : "Agent Mode: OFF"}
          >
            <Zap size={16} />
          </button>

          <div className="w-[1px] h-4 bg-zinc-200 dark:bg-zinc-700"></div>

          {/* Text Input */}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder={
              pendingImage
                ? "Add a message..."
                : agentMode
                  ? "Ask the agent..."
                  : "Ask a question..."
            }
            className="flex-1 bg-transparent text-zinc-900 dark:text-zinc-100 text-sm px-2 py-1 focus:outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500 min-w-0"
          />

          {/* Send Button */}
          <button
            onClick={handleSend}
            disabled={isLoading || (!input.trim() && !pendingImage)}
            className={`p-1.5 rounded-full transition-colors ${
              !isLoading && (input.trim() || pendingImage)
                ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-300"
                : "text-zinc-300 dark:text-zinc-600 cursor-not-allowed"
            }`}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// INLINE CHAT WIDGET - Floating chatbox with expandable conversation panel
// ============================================================================

interface InlineChatWidgetProps {
  latexCode: string;
  onApplyCode?: (code: string) => void;
  onHighlightChanges?: (oldCode: string, newCode: string) => void;
  onRevertCode?: (previousCode: string) => void;
  isDarkMode?: boolean;
}

const DEFAULT_CONVERSATION_HEIGHT = 250;
const MIN_CONVERSATION_HEIGHT = 120;
const MAX_CONVERSATION_HEIGHT_RATIO = 0.6; // 60% of container

export function InlineChatWidget({
  latexCode,
  onApplyCode,
  onHighlightChanges,
  onRevertCode,
  isDarkMode = false,
}: InlineChatWidgetProps) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([DEFAULT_MESSAGE]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [isAttachmentOpen, setIsAttachmentOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [isConversationOpen, setIsConversationOpen] = useState(false);
  const [conversationHeight, setConversationHeight] = useState(
    DEFAULT_CONVERSATION_HEIGHT,
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const attachmentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isInitialized = useRef(false);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  // Handler for accepting code changes
  const handleAcceptChanges = useCallback((messageId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, codeAccepted: true } : m)),
    );
  }, []);

  // Handler for rejecting code changes (revert to previous)
  const handleRejectChanges = useCallback(
    (messageId: string, previousCode: string) => {
      if (onRevertCode) {
        onRevertCode(previousCode);
      }
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

  // Scroll to bottom when messages change
  useEffect(() => {
    if (isConversationOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading, isStreaming, isConversationOpen]);

  // Close attachment menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        attachmentRef.current &&
        !attachmentRef.current.contains(event.target as Node)
      ) {
        setIsAttachmentOpen(false);
      }
    };

    if (isAttachmentOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isAttachmentOpen]);

  // Handle paste events for images
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
              const base64 = event.target?.result as string;
              setPendingImage(base64);
            };
            reader.readAsDataURL(file);
          }
          break;
        }
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, []);

  // Drag resize handlers
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      dragStartY.current = e.clientY;
      dragStartHeight.current = conversationHeight;
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    },
    [conversationHeight],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;

      const deltaY = dragStartY.current - e.clientY; // Inverted because dragging up increases height
      const containerHeight =
        containerRef.current?.parentElement?.clientHeight || 600;
      const maxHeight = containerHeight * MAX_CONVERSATION_HEIGHT_RATIO;

      const newHeight = Math.min(
        maxHeight,
        Math.max(MIN_CONVERSATION_HEIGHT, dragStartHeight.current + deltaY),
      );
      setConversationHeight(newHeight);
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Attach PDF preview
  const handleAttachPreview = () => {
    const canvas = document.querySelector(
      ".react-pdf__Page__canvas",
    ) as HTMLCanvasElement;
    if (canvas) {
      const base64Image = canvas.toDataURL("image/png");
      setPendingImage(base64Image);
      setIsAttachmentOpen(false);
    } else {
      setError("Could not capture PDF preview. Make sure the PDF is visible.");
    }
  };

  // Handle file selection for image attachment
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        setPendingImage(base64);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = "";
    setIsAttachmentOpen(false);
  };

  const clearPendingImage = () => {
    setPendingImage(null);
  };

  const sendMessageToBackend = async (
    text: string,
    imgData?: string,
    currentMessages?: Message[],
  ) => {
    setIsLoading(true);
    setError(null);

    const history = (currentMessages || messages)
      .filter((m) => m.id !== "1")
      .map((m) => ({ role: m.role, content: m.content }));

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
          image: imgData,
          history: history,
          agent_mode: agentMode,
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
      let previousCodeSnapshot = latexCode;

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
                accumulatedThoughts += data.thought;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === aiMessageId
                      ? {
                          ...m,
                          thoughts: accumulatedThoughts,
                          currentThought: data.thought,
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

                const processed = processApplyCodeBlocksForDisplay(
                  accumulatedContent,
                  agentMode,
                );

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
                const processed = processApplyCodeBlocksForDisplay(
                  accumulatedContent,
                  agentMode,
                );

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
      setMessages((prev) =>
        prev.filter((m) => m.id !== aiMessageId || m.content !== ""),
      );
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
    }
  };

  const handleSend = async () => {
    if ((!input.trim() && !pendingImage) || isLoading) return;

    // Open conversation panel when sending a message
    setIsConversationOpen(true);

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content:
        input.trim() || (pendingImage ? "Please analyze this image." : ""),
      image: pendingImage || undefined,
    };
    const imageToSend = pendingImage;
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setPendingImage(null);
    await sendMessageToBackend(
      userMessage.content,
      imageToSend || undefined,
      updatedMessages,
    );
  };

  const clearChat = () => {
    setMessages([DEFAULT_MESSAGE]);
    localStorage.removeItem(STORAGE_KEY);
  };

  const closeConversation = () => {
    setIsConversationOpen(false);
  };

  return (
    <div
      ref={containerRef}
      className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center"
      style={{ width: "min(90%, 500px)" }}
    >
      {/* Conversation Panel - expands upward */}
      {isConversationOpen && (
        <div
          className="w-full mb-2 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md border border-zinc-200 dark:border-zinc-700 shadow-xl rounded-2xl overflow-hidden flex flex-col animate-fade-in"
          style={{ height: conversationHeight }}
        >
          {/* Drag Handle + Close Button */}
          <div
            className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-100 dark:border-zinc-800 cursor-ns-resize group shrink-0"
            onMouseDown={handleDragStart}
          >
            <div className="flex-1 flex justify-center">
              <div className="w-8 h-1 rounded-full bg-zinc-300 dark:bg-zinc-600 group-hover:bg-zinc-400 dark:group-hover:bg-zinc-500 transition-colors" />
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={clearChat}
                className="p-1 rounded-full text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                title="Clear chat history"
              >
                <Trash2 size={12} />
              </button>
              <button
                onClick={closeConversation}
                className="p-1 rounded-full text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                title="Close conversation"
              >
                <X size={12} />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-4 custom-scrollbar">
            {messages
              .filter(
                (msg) => msg.role === "user" || msg.content || msg.thoughts,
              )
              .map((msg) => (
                <MessageItem
                  key={msg.id}
                  msg={msg}
                  onHighlightChanges={onHighlightChanges}
                  onAcceptChanges={handleAcceptChanges}
                  onRejectChanges={handleRejectChanges}
                  isDarkMode={isDarkMode}
                />
              ))}

            {error && (
              <div className="flex items-start gap-2 p-2 bg-red-50 dark:bg-red-950 border border-red-100 dark:border-red-900 rounded-xl text-red-600 dark:text-red-400 text-xs shadow-sm">
                <AlertCircle size={12} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {/* Floating Input Bar */}
      <div className="w-full">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleImageSelect}
          className="hidden"
        />

        {/* Pending image preview */}
        {pendingImage && (
          <div className="mb-2 relative inline-block animate-fade-in">
            <img
              src={pendingImage}
              alt="Attachment preview"
              className="max-h-20 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-sm"
            />
            <button
              onClick={clearPendingImage}
              className="absolute -top-2 -right-2 p-1 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-full hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors shadow-md"
              title="Remove attachment"
            >
              <X size={10} />
            </button>
          </div>
        )}

        {/* Input Bar */}
        <div className="bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md border border-zinc-200 dark:border-zinc-700 shadow-lg rounded-full px-2 py-1.5 flex items-center gap-1 transition-all">
          {/* Attachment Button Group */}
          <div ref={attachmentRef} className="flex items-center">
            <div className="flex items-center">
              {/* Expandable attachment options */}
              <div
                className={`flex items-center overflow-hidden transition-all duration-300 ease-out ${
                  isAttachmentOpen
                    ? "max-w-[80px] opacity-100"
                    : "max-w-0 opacity-0"
                }`}
              >
                <button
                  onClick={handleAttachPreview}
                  className="p-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                  title="Attach PDF preview"
                >
                  <FileText size={16} />
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="p-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                  title="Attach image from computer"
                >
                  <ImageIcon size={16} />
                </button>
              </div>

              {/* Plus button */}
              <button
                onClick={() => setIsAttachmentOpen(!isAttachmentOpen)}
                className="p-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                title={isAttachmentOpen ? "Close" : "Add attachment"}
              >
                <Plus
                  size={16}
                  className={`transition-transform duration-300 ${
                    isAttachmentOpen ? "rotate-45" : "rotate-0"
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="w-[1px] h-4 bg-zinc-200 dark:bg-zinc-700"></div>

          {/* Agent Mode Toggle */}
          <button
            onClick={() => setAgentMode(!agentMode)}
            className={`p-1.5 rounded-full transition-colors ${
              agentMode
                ? "bg-amber-100 dark:bg-amber-900 text-amber-600 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-800"
                : "hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
            title={agentMode ? "Agent Mode: ON" : "Agent Mode: OFF"}
          >
            <Zap size={16} />
          </button>

          <div className="w-[1px] h-4 bg-zinc-200 dark:bg-zinc-700"></div>

          {/* Text Input */}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder={
              pendingImage
                ? "Add a message..."
                : agentMode
                  ? "Ask the agent..."
                  : "Ask a question..."
            }
            className="flex-1 bg-transparent text-zinc-900 dark:text-zinc-100 text-sm px-2 py-1 focus:outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500 min-w-0"
          />

          {/* Send Button */}
          <button
            onClick={handleSend}
            disabled={isLoading || (!input.trim() && !pendingImage)}
            className={`p-1.5 rounded-full transition-colors ${
              !isLoading && (input.trim() || pendingImage)
                ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-300"
                : "text-zinc-300 dark:text-zinc-600 cursor-not-allowed"
            }`}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
