"use client";

import React, { useState } from "react";
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PDFPreviewProps {
  pdfBlob: Blob | null;
  setNumPages?: (num: number) => void;
}

export default function PDFPreview({ pdfBlob, setNumPages }: PDFPreviewProps) {
  if (!pdfBlob) {
    return (
      <div className="flex items-center justify-center h-[11in] w-[8.5in] bg-white text-gray-400 text-sm">
        Click "Compile PDF" to see the preview
      </div>
    );
  }

  return (
    <Document
      file={pdfBlob}
      onLoadSuccess={({ numPages }) => setNumPages?.(numPages)}
      className="flex flex-col gap-4"
      loading={
        <div className="flex items-center justify-center h-[11in] w-[8.5in] bg-white text-gray-400">
          Loading PDF...
        </div>
      }
    >
      <Page 
        pageNumber={1} 
        renderTextLayer={false} 
        renderAnnotationLayer={false} 
        scale={1.0}
        className="shadow-md"
      />
    </Document>
  );
}
