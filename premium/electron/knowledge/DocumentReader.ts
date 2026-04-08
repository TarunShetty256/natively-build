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
        const stats = await fs.promises.stat(filePath);
        if (stats.size > 5 * 1024 * 1024) {
            throw new Error('File too large (max 5MB)');
        }

        const buffer = await fs.promises.readFile(filePath);

        let text = '';
        if (ext === '.pdf') {
            try {
                const pdfParse = await loadPdfParser();
                if (!pdfParse) {
                    throw new Error('PDF parser unavailable.');
                }
                const parsed = await pdfParse(buffer);
                text = parsed?.text || '';
            } catch (pdfError) {
                console.warn('[DocumentReader] PDF parse failed, using UTF-8 fallback:', pdfError);
                text = buffer.toString('latin1');
            }
        } else if (ext === '.docx') {
            const parsed = await mammoth.extractRawText({ buffer });
            text = parsed?.value || '';
        } else {
            text = buffer.toString('utf8');
        }

        text = text
            .replace(/\r/g, '')
            .replace(/\n{2,}/g, '\n')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/[•▪◦●]/g, '-')
            .trim();

        if (text.length > 20000) {
            text = text.slice(0, 20000);
        }

        console.log('[DocumentReader] Extracted length:', text.length);

        if (!text) {
            throw new Error('No readable text found in the document.');
        }

        return text;
    } catch (error: any) {
        if (error?.message === 'File too large (max 5MB)') {
            throw error;
        }
        console.error('[DocumentReader] Failed to extract document text:', error);
        throw new Error('Unable to read document text.');
    }
}
