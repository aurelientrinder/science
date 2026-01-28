"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { latex } from "codemirror-lang-latex";
import { githubLight } from "@uiw/codemirror-theme-github";
import { EditorView, Decoration, DecorationSet } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import ResearchAssistant from "./ResearchAssistant";
import {
  Eye,
  Loader2,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  GripVertical,
  Save,
  Check,
} from "lucide-react";
import dynamic from "next/dynamic";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";

// Dynamically import PDFPreview with no SSR to avoid DOMMatrix errors

// Dynamically import PDFPreview with no SSR to avoid DOMMatrix errors
const PDFPreview = dynamic(() => import("./PDFPreview"), {
  ssr: false,
  loading: () => <div className="text-center p-8">Loading PDF Engine...</div>,
});

const DEFAULT_LATEX = `\\documentclass{article}
\\title{OpenScience Prism Paper}
\\author{Scientist Name}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
This is a paper written in OpenScience Prism. 

\\section{Methods}
We use Gemini 3 Flash Thinking for research.

\\end{document}
`;

const PANEL_LAYOUT_KEY = "openscience-panel-layout";
const LATEX_CODE_KEY = "openscience-latex-code";
const DEFAULT_LAYOUTS = {
  core: { editor: 50, preview: 50 },
  withAssistant: { editor: 40, preview: 35, assistant: 25 },
};

export default function LaTeXEditor() {
  const [code, setCode] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(LATEX_CODE_KEY);
      if (saved) return saved;
    }
    return DEFAULT_LATEX;
  });
  const [mounted, setMounted] = useState(false);
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [screenshotData, setScreenshotData] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const assistantCloseTimer = useRef<number | null>(null);
  const transitionTimer = useRef<number | null>(null);
  const autoSaveTimer = useRef<number | null>(null);
  const initialCompileDone = useRef(false);
  const savedCodeRef = useRef<string>(code);
  const groupRef = useGroupRef();

  // PDF Controls State
  const [numPages, setNumPages] = useState<number>(1);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);

  // Highlighted lines state (1-indexed line numbers)
  const [highlightedLines, setHighlightedLines] = useState<Set<number>>(
    new Set(),
  );
  const highlightTimeoutRef = useRef<number | null>(null);

  // State effect to update highlighted lines in CodeMirror
  const setHighlightEffect = useMemo(
    () => StateEffect.define<Set<number>>(),
    [],
  );

  // Line decoration for highlighting changed lines
  const highlightDecoration = useMemo(
    () =>
      Decoration.line({
        attributes: {
          style:
            "background-color: rgba(34, 197, 94, 0.2); border-left: 3px solid rgb(34, 197, 94);",
        },
      }),
    [],
  );

  // State field that manages the highlighted line decorations
  const highlightField = useMemo(
    () =>
      StateField.define<DecorationSet>({
        create() {
          return Decoration.none;
        },
        update(decorations, tr) {
          // Check for our custom effect
          for (const effect of tr.effects) {
            if (effect.is(setHighlightEffect)) {
              const lines = effect.value;
              if (lines.size === 0) {
                return Decoration.none;
              }
              const decorationList: any[] = [];
              const doc = tr.state.doc;
              for (const lineNum of lines) {
                if (lineNum >= 1 && lineNum <= doc.lines) {
                  const line = doc.line(lineNum);
                  decorationList.push(highlightDecoration.range(line.from));
                }
              }
              return Decoration.set(decorationList, true);
            }
          }
          // Map decorations through document changes
          return decorations.map(tr.changes);
        },
        provide: (f) => EditorView.decorations.from(f),
      }),
    [setHighlightEffect, highlightDecoration],
  );

  // Ref to store the editor view for dispatching effects
  const editorViewRef = useRef<EditorView | null>(null);

  // Compute which lines changed between old and new code
  const computeChangedLines = (
    oldCode: string,
    newCode: string,
  ): Set<number> => {
    const oldLines = oldCode.split("\n");
    const newLines = newCode.split("\n");
    const changedLines = new Set<number>();

    // Simple line-by-line diff
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      const oldLine = oldLines[i] ?? "";
      const newLine = newLines[i] ?? "";
      if (oldLine !== newLine) {
        changedLines.add(i + 1); // 1-indexed
      }
    }

    return changedLines;
  };

  // Handler to highlight changes when "Updated document" is clicked
  const handleHighlightChanges = React.useCallback(
    (oldCode: string, newCode: string) => {
      const changedLines = computeChangedLines(oldCode, newCode);
      setHighlightedLines(changedLines);

      // Dispatch the effect to CodeMirror
      if (editorViewRef.current) {
        editorViewRef.current.dispatch({
          effects: setHighlightEffect.of(changedLines),
        });
      }

      // Clear highlights after 5 seconds
      if (highlightTimeoutRef.current) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
      highlightTimeoutRef.current = window.setTimeout(() => {
        setHighlightedLines(new Set());
        if (editorViewRef.current) {
          editorViewRef.current.dispatch({
            effects: setHighlightEffect.of(new Set()),
          });
        }
      }, 5000);
    },
    [setHighlightEffect],
  );

  useEffect(() => {
    setMounted(true);
    // Initial compilation
    handleCompile();
    initialCompileDone.current = true;
  }, []);

  useEffect(() => {
    return () => {
      if (assistantCloseTimer.current) {
        window.clearTimeout(assistantCloseTimer.current);
      }
      if (transitionTimer.current) {
        window.clearTimeout(transitionTimer.current);
      }
      if (highlightTimeoutRef.current) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
      if (autoSaveTimer.current) {
        window.clearTimeout(autoSaveTimer.current);
      }
    };
  }, []);

  // Manual save function
  const handleSave = React.useCallback(() => {
    localStorage.setItem(LATEX_CODE_KEY, code);
    savedCodeRef.current = code;
    setHasUnsavedChanges(false);
    setLastSavedAt(new Date());
  }, [code]);

  // Keyboard shortcut for save (Cmd+S / Ctrl+S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (hasUnsavedChanges) {
          handleSave();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasUnsavedChanges, handleSave]);

  // Track unsaved changes and auto-save after 10 seconds of inactivity
  useEffect(() => {
    if (!mounted) return;

    // Check if there are unsaved changes
    const hasChanges = code !== savedCodeRef.current;
    setHasUnsavedChanges(hasChanges);

    // Clear existing auto-save timer
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
    }

    // Set up auto-save after 10 seconds of inactivity
    if (hasChanges) {
      autoSaveTimer.current = window.setTimeout(() => {
        localStorage.setItem(LATEX_CODE_KEY, code);
        savedCodeRef.current = code;
        setHasUnsavedChanges(false);
        setLastSavedAt(new Date());
      }, 10000);
    }

    return () => {
      if (autoSaveTimer.current) {
        window.clearTimeout(autoSaveTimer.current);
      }
    };
  }, [code, mounted]);

  // Auto-compile after 0.5 seconds of no changes
  useEffect(() => {
    if (!mounted || !initialCompileDone.current) return;

    const timer = setTimeout(() => {
      handleCompile();
    }, 500);

    return () => clearTimeout(timer);
  }, [code, mounted]);

  const onChange = React.useCallback((value: string) => {
    setCode(value);
  }, []);

  // Handler for agent mode to apply code changes
  const handleApplyCode = React.useCallback((newCode: string) => {
    setCode(newCode);
  }, []);

  // Handler for reverting code changes
  const handleRevertCode = React.useCallback((previousCode: string) => {
    setCode(previousCode);
  }, []);

  const getLayoutKey = (withAssistant: boolean) =>
    `${PANEL_LAYOUT_KEY}:${withAssistant ? "with-assistant" : "core"}`;

  const loadLayout = (withAssistant: boolean): Record<string, number> => {
    if (typeof window === "undefined")
      return withAssistant
        ? DEFAULT_LAYOUTS.withAssistant
        : DEFAULT_LAYOUTS.core;
    try {
      const raw = localStorage.getItem(getLayoutKey(withAssistant));
      if (!raw)
        return withAssistant
          ? DEFAULT_LAYOUTS.withAssistant
          : DEFAULT_LAYOUTS.core;
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (!parsed || typeof parsed !== "object")
        return withAssistant
          ? DEFAULT_LAYOUTS.withAssistant
          : DEFAULT_LAYOUTS.core;
      return parsed;
    } catch {
      return withAssistant
        ? DEFAULT_LAYOUTS.withAssistant
        : DEFAULT_LAYOUTS.core;
    }
  };

  const saveLayout = (layout: Record<string, number>) => {
    if (typeof window === "undefined") return;
    // Only save if assistant is open (has meaningful size)
    const hasAssistant = (layout.assistant ?? 0) > 1;
    try {
      localStorage.setItem(getLayoutKey(hasAssistant), JSON.stringify(layout));
    } catch {
      // Ignore storage errors
    }
  };

  const startTransition = () => {
    setIsTransitioning(true);
    if (transitionTimer.current) {
      window.clearTimeout(transitionTimer.current);
    }
    transitionTimer.current = window.setTimeout(() => {
      setIsTransitioning(false);
    }, 350);
  };

  const applyLayout = (withAssistant: boolean) => {
    startTransition();
    const layout = loadLayout(withAssistant);
    // If closing, collapse assistant to 0 and redistribute to editor/preview
    if (!withAssistant) {
      const coreLayout = loadLayout(false);
      requestAnimationFrame(() => {
        groupRef.current?.setLayout({
          editor: coreLayout.editor,
          preview: coreLayout.preview,
          assistant: 0,
        });
      });
    } else {
      requestAnimationFrame(() => {
        groupRef.current?.setLayout(layout);
      });
    }
  };

  // Apply layout on mount only
  useEffect(() => {
    if (!mounted) return;
    // Don't animate on initial load
    const layout = loadLayout(false);
    groupRef.current?.setLayout({ ...layout, assistant: 0 });
  }, [mounted]);

  const openAssistant = () => {
    if (assistantCloseTimer.current) {
      window.clearTimeout(assistantCloseTimer.current);
      assistantCloseTimer.current = null;
    }
    setIsAssistantOpen(true);
    applyLayout(true);
  };

  const closeAssistant = () => {
    setIsAssistantOpen(false);
    applyLayout(false);
  };

  const toggleAssistant = () => {
    if (isAssistantOpen) {
      closeAssistant();
    } else {
      openAssistant();
    }
  };

  const handleCompile = async () => {
    setIsCompiling(true);
    try {
      const response = await fetch("http://localhost:8000/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latex_source: code }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Compilation failed");
      }

      const blob = await response.blob();
      setPdfBlob(blob);
    } catch (error: any) {
      console.error("Error compiling PDF:", error);
      alert(`Failed to compile PDF: ${error.message}`);
    } finally {
      setIsCompiling(false);
    }
  };

  const handleVisionCheck = async () => {
    if (!pdfBlob) {
      alert("Please compile the PDF first!");
      return;
    }

    setIsAnalyzing(true);

    try {
      // Find the canvas rendered by react-pdf
      // We look for it inside the preview area
      const canvas = document.querySelector(
        ".react-pdf__Page__canvas",
      ) as HTMLCanvasElement;
      if (canvas) {
        const base64Image = canvas.toDataURL("image/png");
        setScreenshotData(base64Image);
        openAssistant();
      } else {
        alert("Could not capture PDF preview. Ensure the PDF is visible.");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  if (!mounted) return null;

  return (
    <div className="flex flex-col h-screen w-full bg-zinc-50 overflow-hidden relative">
      {/* Toolbar */}
      <div className="h-12 border-b border-zinc-200 bg-white flex items-center px-4 justify-between shrink-0 z-10">
        <div className="flex items-center gap-4">
          <span className="text-zinc-900 font-bold tracking-tight">
            OpenScience Prism
          </span>
          <div className="h-4 w-[1px] bg-zinc-200"></div>
          <button
            onClick={handleCompile}
            disabled={isCompiling}
            className={`bg-black hover:bg-zinc-800 text-white px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-2 ${isCompiling ? "opacity-50" : "shadow-sm"}`}
          >
            {isCompiling && <Loader2 size={12} className="animate-spin" />}
            Compile PDF
          </button>

          <button
            onClick={handleSave}
            disabled={!hasUnsavedChanges}
            className={`text-zinc-600 hover:text-zinc-900 border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-2 ${!hasUnsavedChanges ? "opacity-50 cursor-default" : "shadow-sm"}`}
          >
            {hasUnsavedChanges ? (
              <Save size={12} />
            ) : (
              <Check size={12} className="text-green-600" />
            )}
            {hasUnsavedChanges ? "Save" : "Saved"}
          </button>

          <button
            onClick={handleVisionCheck}
            disabled={!pdfBlob || isAnalyzing}
            className={`text-zinc-600 hover:text-zinc-900 border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-2 ${!pdfBlob || isAnalyzing ? "opacity-50 cursor-not-allowed" : "shadow-sm"}`}
          >
            {isAnalyzing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Eye size={12} />
            )}
            Agentic Vision Check
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleAssistant}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all border shadow-sm flex items-center gap-2 ${
              isAssistantOpen
                ? "bg-zinc-900 border-zinc-900 text-white"
                : "bg-white text-zinc-600 hover:text-zinc-900 border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
            }`}
          >
            Agent
          </button>
        </div>
      </div>

      {/* Editor & Preview */}
      <div
        className={`flex flex-1 overflow-hidden relative ${isTransitioning ? "panel-transition" : ""}`}
      >
        <Group
          orientation="horizontal"
          groupRef={groupRef}
          onLayoutChanged={(layout) => saveLayout(layout)}
        >
          {/* Editor Pane */}
          <Panel
            id="editor"
            defaultSize={50}
            minSize={5}
            className="flex flex-col"
          >
            <div className="h-full w-full py-2 pl-2 pr-0">
              <div className="h-full w-full bg-white rounded-xl shadow-sm border border-zinc-200 overflow-hidden flex flex-col">
                <div className="flex-1 overflow-auto custom-scrollbar">
                  <CodeMirror
                    value={code}
                    height="100%"
                    theme={githubLight}
                    extensions={[latex(), highlightField]}
                    onChange={onChange}
                    onCreateEditor={(view) => {
                      editorViewRef.current = view;
                    }}
                    className="text-base h-full border-none"
                  />
                </div>
              </div>
            </div>
          </Panel>

          <Separator className="w-2 bg-transparent hover:bg-zinc-200/50 transition-colors flex items-center justify-center cursor-col-resize group z-10 rounded-sm">
            <div className="h-8 w-1 rounded-full bg-zinc-300 group-hover:bg-zinc-400 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
              <GripVertical size={12} className="text-zinc-500" />
            </div>
          </Separator>

          {/* Preview Pane */}
          <Panel id="preview" defaultSize={50} minSize={5}>
            <div
              className={`h-full w-full py-2 pl-0 ${isAssistantOpen ? "pr-0" : "pr-2"}`}
            >
              <div className="h-full w-full bg-zinc-100 rounded-xl shadow-sm border border-zinc-200 overflow-hidden flex flex-col relative">
                <div className="h-full w-full transition-all duration-300 relative overflow-hidden flex flex-col">
                  <div className="flex-1 overflow-auto p-8 flex justify-center custom-scrollbar">
                    <div className="shadow-xl mb-16">
                      <PDFPreview
                        pdfBlob={pdfBlob}
                        scale={scale}
                        pageNumber={pageNumber}
                        setNumPages={setNumPages}
                      />
                    </div>
                  </div>

                  {/* Floating PDF Toolbar */}
                  <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur border border-zinc-200 shadow-lg rounded-full px-4 py-2 flex items-center gap-4 transition-all z-20">
                    {/* Zoom Controls */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setScale((s) => Math.max(0.5, s - 0.1))}
                        className="p-1.5 rounded-full hover:bg-zinc-100 text-zinc-600 hover:text-zinc-900 transition-colors"
                        title="Zoom Out"
                      >
                        <ZoomOut size={16} />
                      </button>
                      <span className="text-xs font-medium w-12 text-center text-zinc-600">
                        {Math.round(scale * 100)}%
                      </span>
                      <button
                        onClick={() => setScale((s) => Math.min(2.5, s + 0.1))}
                        className="p-1.5 rounded-full hover:bg-zinc-100 text-zinc-600 hover:text-zinc-900 transition-colors"
                        title="Zoom In"
                      >
                        <ZoomIn size={16} />
                      </button>
                      <button
                        onClick={() => setScale(1.0)}
                        className="p-1.5 rounded-full hover:bg-zinc-100 text-zinc-600 hover:text-zinc-900 transition-colors ml-1"
                        title="Reset Zoom"
                      >
                        <RotateCcw size={14} />
                      </button>
                    </div>

                    <div className="w-[1px] h-4 bg-zinc-200"></div>

                    {/* Page Navigation */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                        disabled={pageNumber <= 1}
                        className="p-1.5 rounded-full hover:bg-zinc-100 text-zinc-600 hover:text-zinc-900 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <span className="text-xs font-medium text-zinc-600">
                        {pageNumber} / {numPages || 1}
                      </span>
                      <button
                        onClick={() =>
                          setPageNumber((p) => Math.min(numPages, p + 1))
                        }
                        disabled={pageNumber >= numPages}
                        className="p-1.5 rounded-full hover:bg-zinc-100 text-zinc-600 hover:text-zinc-900 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Panel>

          <Separator
            className={`${isAssistantOpen ? "w-2" : "w-0 opacity-0 pointer-events-none"} bg-transparent hover:bg-zinc-200/50 transition-all flex items-center justify-center cursor-col-resize group z-10 rounded-sm`}
          >
            <div className="h-8 w-1 rounded-full bg-zinc-300 group-hover:bg-zinc-400 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
              <GripVertical size={12} className="text-zinc-500" />
            </div>
          </Separator>

          <Panel
            id="assistant"
            defaultSize={0}
            minSize={10}
            collapsible
            collapsedSize={0}
            className="bg-transparent overflow-hidden"
          >
            <div className="h-full w-full py-2 pl-0 pr-2">
              <div className="h-full w-full bg-white rounded-xl shadow-sm border border-zinc-200 overflow-hidden flex flex-col">
                <ResearchAssistant
                  isOpen={isAssistantOpen}
                  docked
                  onClose={closeAssistant}
                  latexCode={code}
                  screenshot={screenshotData}
                  onScreenshotConsumed={() => setScreenshotData(null)}
                  onApplyCode={handleApplyCode}
                  onHighlightChanges={handleHighlightChanges}
                  onRevertCode={handleRevertCode}
                />
              </div>
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  );
}
