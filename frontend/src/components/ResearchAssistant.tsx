"use client";

import React, { useState, useEffect, useRef } from "react";
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
}

const STORAGE_KEY = "research-assistant-messages";
const DEFAULT_MESSAGE: Message = {
  id: "1",
  role: "assistant",
  content: "Hello! I'm your Gemini 3 co-scientist. I can help you research topics, fact-check your paper, or suggest improvements based on your LaTeX code. What are we working on?",
};

export default function ResearchAssistant({ isOpen, onClose, latexCode, screenshot, onScreenshotConsumed }: ResearchAssistantProps) {
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

  if (!isOpen) return null;

  return (
    <div className="fixed top-12 right-0 bottom-0 w-96 bg-gray-900 border-l border-gray-700 shadow-2xl flex flex-col z-50 animate-in slide-in-from-right duration-300">
      {/* Header */}
      <div className="h-12 border-b border-gray-700 bg-gray-800 flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-2 text-purple-400">
          <Sparkles size={18} />
          <span className="font-semibold text-sm">Gemini 3 Research Agent</span>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={clearChat} 
            className="text-gray-400 hover:text-red-400 transition-colors"
            title="Clear chat history"
          >
            <Trash2 size={16} />
          </button>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-900 custom-scrollbar">
        {messages.filter((msg) => msg.role === "user" || msg.content).map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
          >
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === "user" ? "bg-blue-600" : "bg-purple-600 shadow-[0_0_10px_rgba(168,85,247,0.4)]"}`}
            >
              {msg.role === "user" ? <User size={14} className="text-white" /> : <Bot size={14} className="text-white" />}
            </div>
            <div className={`max-w-[85%] flex flex-col gap-2`}>
              {msg.image && (
                <div className="rounded-lg overflow-hidden border border-gray-600 shadow-sm">
                  <img src={msg.image} alt="Visual Context" className="w-full h-auto" />
                </div>
              )}
              <div
                className={`rounded-2xl px-4 py-2 text-sm leading-relaxed ${msg.role === "user"
                    ? "bg-blue-600 text-white rounded-tr-none"
                    : "bg-gray-800 text-gray-200 border border-gray-700 rounded-tl-none"
                }`}
              >
                {msg.role === "assistant" ? (
                  <ReactMarkdown
                    components={{
                      code({ node, children, ...props }: any) {
                        const className = node?.properties?.className?.join(' ') || '';
                        const match = /language-(\w+)/.exec(className);
                        const isInline = !match && !className;
                        return !isInline && match ? (
                          <div className="my-2 rounded-md overflow-hidden text-[12px]">
                            <SyntaxHighlighter
                              style={vscDarkPlus as any}
                              language={match[1]}
                              PreTag="div"
                            >
                              {String(children).replace(/\n$/, "")}
                            </SyntaxHighlighter>
                          </div>
                        ) : (
                          <code className="bg-gray-700 px-1 rounded text-pink-400" {...props}>
                            {children}
                          </code>
                        );
                      },
                      p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                      ul: ({ children }) => <ul className="list-disc ml-4 mb-2">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal ml-4 mb-2">{children}</ol>,
                      li: ({ children }) => <li className="mb-1">{children}</li>,
                      h1: ({ children }) => <h1 className="text-lg font-bold mb-2 border-b border-gray-700 pb-1">{children}</h1>,
                      h2: ({ children }) => <h2 className="text-base font-bold mb-2">{children}</h2>,
                      h3: ({ children }) => <h3 className="text-sm font-bold mb-1">{children}</h3>,
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                ) : (
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                )}
              </div>
            </div>
          </div>
        ))}
        
        {isLoading && !isStreaming && (
          <div className="flex gap-3 animate-pulse">
            <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center flex-shrink-0">
              <Bot size={14} className="text-white" />
            </div>
            <div className="bg-gray-800 border border-gray-700 rounded-2xl rounded-tl-none px-4 py-2 flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce"></div>
              <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce [animation-delay:0.2s]"></div>
              <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce [animation-delay:0.4s]"></div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800 rounded-lg text-red-400 text-xs">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-gray-700 bg-gray-800">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Ask Gemini..."
            className="flex-1 bg-gray-900 text-white text-sm rounded-xl border border-gray-700 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all placeholder:text-gray-500"
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white p-2.5 rounded-xl transition-all shadow-lg shadow-purple-900/20"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}