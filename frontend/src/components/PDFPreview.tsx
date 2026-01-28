"use client";

import React, { useEffect, useState } from "react";
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PDFPreviewProps {
  pdfBlob: Blob | null;
  setNumPages?: (num: number) => void;
  scale: number;
  pageNumber: number;
}

export default function PDFPreview({ pdfBlob, setNumPages, scale, pageNumber }: PDFPreviewProps) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!pdfBlob) {
      setPdfUrl(null);
      return;
    }

    const url = URL.createObjectURL(pdfBlob);
    setPdfUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [pdfBlob]);

  if (!pdfUrl) {
    return (
      <div className="flex items-center justify-center h-[11in] w-[8.5in] bg-white text-gray-400 text-sm shadow-sm">
        Click "Compile PDF" to see the preview
      </div>
    );
  }

  return (
    <Document
      file={pdfUrl}
      onLoadSuccess={({ numPages }) => setNumPages?.(numPages)}
      className="flex flex-col gap-4"
      loading={
        <div className="flex items-center justify-center h-[11in] w-[8.5in] bg-white text-gray-400 shadow-sm">
          Loading PDF...
        </div>
      }
    >
      <Page 
        pageNumber={pageNumber} 
        renderTextLayer={false} 
        renderAnnotationLayer={false} 
        scale={scale}
        className="shadow-md bg-white"
      />
    </Document>
  );
}
