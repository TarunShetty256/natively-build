// electron/knowledge/DocumentReader.ts
// Raw text extraction from PDF and DOCX files

import fs from 'fs';
import path from 'path';

/**
 * Extract raw text from a document file (PDF or DOCX).
 * Returns clean text ready for LLM-based structured extraction.
 */
export async function extractDocumentText(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();
    const fileBuffer = fs.readFileSync(filePath);

    if (ext === '.pdf') {
        return extractFromPdf(fileBuffer);
    } else if (ext === '.docx') {
        return extractFromDocx(fileBuffer);
    } else if (ext === '.txt') {
        return fileBuffer.toString('utf-8');
    } else {
        throw new Error(`Unsupported file format: ${ext}. Supported: .pdf, .docx, .txt`);
    }
}

async function extractFromPdf(buffer: Buffer): Promise<string> {
    try {
        const { PDFParse } = require('pdf-parse');
        const uint8 = new Uint8Array(buffer);
        const parser = new PDFParse(uint8);
        const result = await parser.getText();
        const text = result.text?.trim();
        if (!text || text.length < 50) {
            throw new Error('PDF appears to contain very little text. It may be a scanned document.');
        }
        console.log(`[DocumentReader] Extracted ${text.length} chars from PDF`);
        return text;
    } catch (error: any) {
        console.error('[DocumentReader] PDF extraction failed:', error.message);
        throw new Error(`Failed to extract text from PDF: ${error.message}`);
    }
}

async function extractFromDocx(buffer: Buffer): Promise<string> {
    try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        const text = result.value?.trim();
        if (!text || text.length < 50) {
            throw new Error('DOCX appears to contain very little text.');
        }
        console.log(`[DocumentReader] Extracted ${text.length} chars from DOCX`);
        return text;
    } catch (error: any) {
        console.error('[DocumentReader] DOCX extraction failed:', error.message);
        throw new Error(`Failed to extract text from DOCX: ${error.message}`);
    }
}
