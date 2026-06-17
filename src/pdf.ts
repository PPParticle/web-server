/**
 * PDF detection + handoff.
 *
 * The reader does not parse PDFs (Python's PyMuPDF/pdfplumber is the right
 * tool, run by the calling agent). PDFs are detected by URL suffix or by the
 * response content-type, and a clear handoff message is returned so the agent
 * can act on it.
 */

export interface PdfHandoff {
  title: string;
  content: string;
}

/** True if the URL's path ends in `.pdf` (case-insensitive). */
export function isPdfUrl(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** True if a Content-Type header value denotes a PDF. */
export function isPdfContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/pdf");
}

/** Build the handoff message returned to the agent for a PDF URL. */
export function buildPdfHandoff(url: string): PdfHandoff {
  const content = [
    `This URL is a PDF: ${url}`,
    ``,
    `The web reader does not parse PDFs.`,
    `Recommended: download with curl and parse with Python (PyMuPDF/pdfplumber).`,
  ].join("\n");
  return { title: `PDF handoff: ${url}`, content };
}
