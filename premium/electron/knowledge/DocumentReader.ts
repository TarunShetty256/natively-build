import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';

type PdfParseFn = (data: Buffer) => Promise<{ text?: string }>;

let cachedPdfParse: PdfParseFn | null | undefined;

async function loadPdfParser(): Promise<PdfParseFn | null> {
    if (cachedPdfParse !== undefined) return cachedPdfParse;
    try {
        const mod: any = await import('pdf-parse');
        const candidate = mod?.PDFParse ?? mod?.default ?? mod;
        if (typeof candidate === 'function') {
            if (candidate.prototype?.getText) {
                cachedPdfParse = async (data: Buffer) => {
                    const parser = new candidate({ data });
                    try {
                        const result = await parser.getText();
                        return { text: result?.text || '' };
                    } finally {
                        await parser.destroy?.();
                    }
                };
            } else {
                cachedPdfParse = candidate as PdfParseFn;
            }
        } else {
            cachedPdfParse = null;
        }
        return cachedPdfParse;
    } catch (error) {
        console.error('[DocumentReader] Failed to load PDF parser:', error);
        cachedPdfParse = null;
        return null;
    }
}

export async function extractDocumentText(filePath: string): Promise<string> {
    try {
        const ext = path.extname(filePath).toLowerCase();
        const buffer = await fs.promises.readFile(filePath);

        let text = '';
        if (ext === '.pdf') {
            const pdfParse = await loadPdfParser();
            if (!pdfParse) {
                throw new Error('PDF parser unavailable.');
            }
            const parsed = await pdfParse(buffer);
            text = parsed?.text || '';
        } else if (ext === '.docx') {
            const parsed = await mammoth.extractRawText({ buffer });
            text = parsed?.value || '';
        } else {
            text = buffer.toString('utf8');
        }

        const trimmed = text.trim();
        if (!trimmed) {
            throw new Error('No readable text found in the document.');
        }

        return trimmed;
    } catch (error: any) {
        console.error('[DocumentReader] Failed to extract document text:', error);
        throw new Error('Unable to read document text.');
    }
}
