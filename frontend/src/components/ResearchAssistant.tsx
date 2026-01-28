"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { Send, Sparkles, Bot, User, X, AlertCircle, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  image?: string; // Base64 string
}

interface ResearchAssistantProps {
  isOpen: boolean;
  onClose: () => void;
  latexCode: string;
  screenshot: string | null;
  onScreenshotConsumed: () => void;
  docked?: boolean;
}

const STORAGE_KEY = "research-assistant-messages";
const DEFAULT_MESSAGE: Message = {
  id: "1",
  role: "assistant",
  content: "Hello! I'm your Gemini 3 co-scientist. I can help you research topics, fact-check your paper, or suggest improvements based on your LaTeX code. What are we working on?",
};

// Define Markdown components outside to ensure stability and prevent re-mounting
const MARKDOWN_COMPONENTS = {
  code({ node, children, ...props }: any) {
    const className = node?.properties?.className?.join(' ') || '';
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
      <code className="bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-900 font-mono text-xs border border-zinc-200" {...props}>
        {children}
      </code>
    );
  },
  p: ({ children }: any) => <p className="mb-2 last:mb-0 animate-fade-in">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc ml-4 mb-2 marker:text-zinc-400 animate-fade-in">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal ml-4 mb-2 marker:text-zinc-400 animate-fade-in">{children}</ol>,
  li: ({ children }: any) => <li className="mb-1 animate-fade-in">{children}</li>,
  h1: ({ children }: any) => <h1 className="text-base font-bold mb-2 text-zinc-900 animate-fade-in">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-sm font-bold mb-2 text-zinc-900 animate-fade-in">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-sm font-semibold mb-1 text-zinc-900 animate-fade-in">{children}</h3>,
};

// Memoized Message Item to prevent re-renders when input changes
const MessageItem = React.memo(({ msg }: { msg: Message }) => {
  return (
    <div className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
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
        {msg.image && (
          <div className="rounded-sm overflow-hidden border border-zinc-200 shadow-sm animate-fade-in">
            <img src={msg.image} alt="Visual Context" className="w-full h-auto" />
          </div>
        )}
        <div
          className={`text-sm leading-relaxed ${msg.role === "user"
              ? "text-zinc-900 font-medium text-right"
              : "text-zinc-600"
          }`}
        >
          {msg.role === "assistant" ? (
            <ReactMarkdown components={MARKDOWN_COMPONENTS}>
              {msg.content}
            </ReactMarkdown>
          ) : (
            <div className="whitespace-pre-wrap animate-fade-in">{msg.content}</div>
          )}
        </div>
      </div>
    </div>
  );
});
MessageItem.displayName = "MessageItem";

export default function ResearchAssistant({
  isOpen,
  onClose,
  latexCode,
  screenshot,
  onScreenshotConsumed,
  docked = false,
}: ResearchAssistantProps) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([DEFAULT_MESSAGE]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isInitialized = useRef(false);

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
          content: "Please analyze the visual layout and content of this PDF page.",
          image: screenshot
        };
        const updatedMessages = [...messages, userMessage];
        setMessages(updatedMessages);
        onScreenshotConsumed(); // Clear parent state
        await sendMessageToBackend(userMessage.content, screenshot, updatedMessages);
      };
      runAnalysis();
    }
  }, [screenshot]);

  const sendMessageToBackend = async (text: string, imgData?: string, currentMessages?: Message[]) => {
    setIsLoading(true);
    setError(null);

    // Build conversation history for context (exclude images to reduce payload)
    const history = (currentMessages || messages)
      .filter(m => m.id !== "1") // Exclude the default greeting
      .map(m => ({ role: m.role, content: m.content }));

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
          history: history // Conversation history for context
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
              
              if (data.content) {
                if (!accumulatedContent) {
                  setIsStreaming(true);
                }
                accumulatedContent += data.content;
                // Update the message with accumulated content
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === aiMessageId ? { ...m, content: accumulatedContent } : m
                  )
                );
              }
              
              if (data.done) {
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
      setMessages((prev) => prev.filter((m) => m.id !== aiMessageId || m.content !== ""));
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
          <span className="font-medium text-sm tracking-tight">Research Assistant</span>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={clearChat} 
            className="text-zinc-400 hover:text-zinc-900 transition-colors"
            title="Clear chat history"
          >
            <Trash2 size={16} />
          </button>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-900 transition-colors">
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6 bg-white custom-scrollbar">
        {messages.filter((msg) => msg.role === "user" || msg.content).map((msg) => (
          <MessageItem key={msg.id} msg={msg} />
        ))}
        
        {isLoading && !isStreaming && (
          <div className="flex gap-3 animate-pulse">
            <div className="w-8 h-8 rounded-full bg-white border border-zinc-200 flex items-center justify-center flex-shrink-0">
              <img 
                src="https://upload.wikimedia.org/wikipedia/commons/thumb/1/1d/Google_Gemini_icon_2025.svg/960px-Google_Gemini_icon_2025.svg.png" 
                alt="Gemini" 
                className="w-5 h-5 object-contain opacity-50"
              />
            </div>
            <div className="flex items-center gap-1.5 pt-2">
              <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce"></div>
              <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:0.2s]"></div>
              <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:0.4s]"></div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-md text-red-600 text-xs">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-zinc-200 bg-white">
        <div className="relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Ask a question..."
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
  );
}