"use client";

import React, { useState, useEffect } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { latex } from "codemirror-lang-latex";
import ResearchAssistant from "./ResearchAssistant";
import { Eye, Loader2 } from "lucide-react";
import dynamic from "next/dynamic";

// Dynamically import PDFPreview with no SSR to avoid DOMMatrix errors
const PDFPreview = dynamic(() => import("./PDFPreview"), { 
  ssr: false,
  loading: () => <div className="text-center p-8">Loading PDF Engine...</div>
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

export default function LaTeXEditor() {
  const [code, setCode] = useState(DEFAULT_LATEX);
  const [mounted, setMounted] = useState(false);
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [screenshotData, setScreenshotData] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const onChange = React.useCallback((value: string) => {
    setCode(value);
  }, []);

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
      const canvas = document.querySelector('.react-pdf__Page__canvas') as HTMLCanvasElement;
      if (canvas) {
        const base64Image = canvas.toDataURL('image/png');
        setScreenshotData(base64Image);
        setIsAssistantOpen(true);
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
    <div className="flex flex-col h-screen w-full bg-gray-900 overflow-hidden relative">
      {/* Toolbar */}
      <div className="h-12 border-b border-gray-700 bg-gray-800 flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-4">
          <span className="text-gray-200 font-bold tracking-tight">OpenScience Prism</span>
          <div className="h-4 w-[1px] bg-gray-600"></div>
          <button 
            onClick={handleCompile}
            disabled={isCompiling}
            className={`bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded text-xs transition-colors flex items-center gap-2 ${isCompiling ? "opacity-50" : ""}`}
          >
            {isCompiling && <Loader2 size={12} className="animate-spin" />}
            Compile PDF
          </button>
          
          <button 
            onClick={handleVisionCheck}
            disabled={!pdfBlob || isAnalyzing}
            className={`text-emerald-400 hover:text-emerald-300 border border-emerald-800 hover:bg-emerald-900/20 px-3 py-1 rounded text-xs transition-colors flex items-center gap-2 ${(!pdfBlob || isAnalyzing) ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            {isAnalyzing ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
            Agentic Vision Check
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setIsAssistantOpen(!isAssistantOpen)}
            className={`px-3 py-1 rounded text-xs transition-colors border ${isAssistantOpen 
              ? "bg-purple-600 border-purple-500 text-white" 
              : "text-gray-400 hover:text-white border-gray-600"}`}
          >
            Ask Gemini 3
          </button>
        </div>
      </div>

      {/* Editor & Preview */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Editor Pane */}
        <div className="flex-1 border-r border-gray-700 overflow-auto custom-scrollbar">
          <CodeMirror
            value={code}
            height="100%"
            theme={oneDark}
            extensions={[latex()]}
            onChange={onChange}
            className="text-base h-full"
          />
        </div>

        {/* Preview Pane */}
        <div className={`flex-1 bg-gray-500 p-8 overflow-auto transition-all duration-300 flex justify-center ${isAssistantOpen ? 'mr-96' : ''}`}>
          <div className="shadow-lg">
            <PDFPreview pdfBlob={pdfBlob} />
          </div>
        </div>

        {/* Research Assistant Sidebar */}
        <ResearchAssistant 
          isOpen={isAssistantOpen} 
          onClose={() => setIsAssistantOpen(false)} 
          latexCode={code}
          screenshot={screenshotData}
          onScreenshotConsumed={() => setScreenshotData(null)}
        />
      </div>
    </div>
  );
}