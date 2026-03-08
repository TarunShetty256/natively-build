// electron/knowledge/KnowledgeDatabaseManager.ts
// SQLite CRUD for documents and context_nodes tables

import Database from 'better-sqlite3';
import { ContextNode, KnowledgeDocument, DocType } from './types';

export class KnowledgeDatabaseManager {
    private db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
    }

    /**
     * Initializes the necessary tables for the Knowledge Engine.
     */
    initializeSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS knowledge_documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                source_uri TEXT NOT NULL,
                structured_data TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS context_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER,
                source_type TEXT NOT NULL,
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                organization TEXT,
                start_date TEXT,
                end_date TEXT,
                duration_months INTEGER DEFAULT 0,
                text_content TEXT NOT NULL,
                tags TEXT NOT NULL,
                embedding BLOB,
                FOREIGN KEY(document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS company_dossiers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_name TEXT UNIQUE NOT NULL,
                last_checked DATETIME DEFAULT CURRENT_TIMESTAMP,
                dossier_json TEXT NOT NULL,
                source_trace TEXT,
                ttl_hours INTEGER DEFAULT 24
            );

            CREATE TABLE IF NOT EXISTS aot_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER NOT NULL,
                result_type TEXT NOT NULL,
                result_json TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE,
                UNIQUE(document_id, result_type)
            );

            -- Indexes for fast retrieval
            CREATE INDEX IF NOT EXISTS idx_nodes_source_type ON context_nodes(source_type);
            CREATE INDEX IF NOT EXISTS idx_nodes_doc_id ON context_nodes(document_id);
            CREATE INDEX IF NOT EXISTS idx_dossier_company ON company_dossiers(company_name);
            CREATE INDEX IF NOT EXISTS idx_aot_results_doc ON aot_results(document_id, result_type);
        `);
        console.log('[KnowledgeDB] Schema initialized successfully');
    }

    // ============================================
    // Documents CRUD
    // ============================================

    saveDocument(doc: Omit<KnowledgeDocument, 'id' | 'created_at'>): number {
        const stmt = this.db.prepare(`
            INSERT INTO knowledge_documents (type, source_uri, structured_data)
            VALUES (?, ?, ?)
        `);
        const info = stmt.run(
            doc.type,
            doc.source_uri,
            JSON.stringify(doc.structured_data)
        );
        console.log(`[KnowledgeDB] Document saved: ${doc.type} (ID: ${info.lastInsertRowid})`);
        return info.lastInsertRowid as number;
    }

    getDocumentByType(type: DocType): KnowledgeDocument | null {
        // For Resume and active JD, we typically assume the most recent one is active
        const row = this.db.prepare('SELECT * FROM knowledge_documents WHERE type = ? ORDER BY created_at DESC LIMIT 1').get(type) as any;
        if (!row) return null;
        return {
            id: row.id,
            type: row.type as DocType,
            source_uri: row.source_uri,
            structured_data: JSON.parse(row.structured_data),
            created_at: row.created_at
        };
    }

    deleteDocumentsByType(type: DocType): void {
        this.db.exec(`PRAGMA foreign_keys = ON;`); // Ensure cascade delete works
        const stmt = this.db.prepare('DELETE FROM knowledge_documents WHERE type = ?');
        stmt.run(type);
        console.log(`[KnowledgeDB] All documents of type ${type} deleted`);
    }

    // ============================================
    // Context Nodes CRUD
    // ============================================

    saveNodes(nodes: ContextNode[], documentId?: number): void {
        const insert = this.db.prepare(`
            INSERT INTO context_nodes (
                document_id, source_type, category, title, organization, 
                start_date, end_date, duration_months, text_content, tags, embedding
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertAll = this.db.transaction(() => {
            for (const node of nodes) {
                insert.run(
                    documentId || null,
                    node.source_type,
                    node.category,
                    node.title,
                    node.organization || null,
                    node.start_date || null,
                    node.end_date || null,
                    node.duration_months || 0,
                    node.text_content,
                    JSON.stringify(node.tags),
                    node.embedding ? this.embeddingToBlob(node.embedding) : null
                );
            }
        });

        insertAll();
        console.log(`[KnowledgeDB] Saved ${nodes.length} nodes for Document ID: ${documentId}`);
    }

    getNodesBySourceType(sourceType: DocType): ContextNode[] {
        const rows = this.db.prepare('SELECT * FROM context_nodes WHERE source_type = ? ORDER BY id ASC').all(sourceType) as any[];
        return rows.map(row => this.mapRowToContextNode(row));
    }

    getAllNodes(): ContextNode[] {
        const rows = this.db.prepare('SELECT * FROM context_nodes ORDER BY id ASC').all() as any[];
        return rows.map(row => this.mapRowToContextNode(row));
    }

    getNodeCount(sourceType?: DocType): number {
        if (sourceType) {
            const row = this.db.prepare('SELECT COUNT(*) as count FROM context_nodes WHERE source_type = ?').get(sourceType) as any;
            return row.count;
        }
        const row = this.db.prepare('SELECT COUNT(*) as count FROM context_nodes').get() as any;
        return row.count;
    }

    // ============================================
    // Company Dossiers CRUD
    // ============================================

    saveDossier(companyName: string, dossierJson: any, sourceTrace: string[]): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO company_dossiers (company_name, last_checked, dossier_json, source_trace)
            VALUES (?, datetime('now'), ?, ?)
        `);
        stmt.run(companyName.toLowerCase().trim(), JSON.stringify(dossierJson), JSON.stringify(sourceTrace));
        console.log(`[KnowledgeDB] Dossier saved for: ${companyName}`);
    }

    getDossier(companyName: string): any | null {
        const row = this.db.prepare('SELECT * FROM company_dossiers WHERE company_name = ?').get(companyName.toLowerCase().trim()) as any;
        if (!row) return null;
        return {
            id: row.id,
            company_name: row.company_name,
            last_checked: row.last_checked,
            dossier: JSON.parse(row.dossier_json),
            sources: JSON.parse(row.source_trace || '[]'),
            ttl_hours: row.ttl_hours
        };
    }

    isDossierStale(companyName: string): boolean {
        const row = this.db.prepare(
            `SELECT last_checked, ttl_hours FROM company_dossiers WHERE company_name = ?`
        ).get(companyName.toLowerCase().trim()) as any;
        if (!row) return true;

        const lastChecked = new Date(row.last_checked).getTime();
        const ttlMs = (row.ttl_hours || 24) * 60 * 60 * 1000;
        return Date.now() - lastChecked > ttlMs;
    }

    deleteDossier(companyName: string): void {
        this.db.prepare('DELETE FROM company_dossiers WHERE company_name = ?').run(companyName.toLowerCase().trim());
        console.log(`[KnowledgeDB] Dossier deleted for: ${companyName}`);
    }

    // ============================================
    // Helpers
    // ============================================

    private mapRowToContextNode(row: any): ContextNode {
        return {
            id: row.id,
            document_id: row.document_id,
            source_type: row.source_type as DocType,
            category: row.category,
            title: row.title,
            organization: row.organization,
            start_date: row.start_date,
            end_date: row.end_date,
            duration_months: row.duration_months,
            text_content: row.text_content,
            tags: JSON.parse(row.tags || '[]'),
            embedding: row.embedding ? this.blobToEmbedding(row.embedding) : undefined
        };
    }

    private embeddingToBlob(embedding: number[]): Buffer {
        const buffer = Buffer.alloc(embedding.length * 4);
        for (let i = 0; i < embedding.length; i++) {
            buffer.writeFloatLE(embedding[i], i * 4);
        }
        return buffer;
    }

    private blobToEmbedding(blob: Buffer): number[] {
        const embedding: number[] = [];
        for (let i = 0; i < blob.length; i += 4) {
            embedding.push(blob.readFloatLE(i));
        }
        return embedding;
    }

    // ============================================
    // AOT Results CRUD
    // ============================================

    saveNegotiationScript(documentId: number, script: any): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO aot_results (document_id, result_type, result_json)
            VALUES (?, 'negotiation_script', ?)
        `);
        stmt.run(documentId, JSON.stringify(script));
        console.log(`[KnowledgeDB] Negotiation script saved for doc ID: ${documentId}`);
    }

    getNegotiationScript(documentId: number): any | null {
        const row = this.db.prepare(
            `SELECT result_json FROM aot_results WHERE document_id = ? AND result_type = 'negotiation_script'`
        ).get(documentId) as any;
        return row ? JSON.parse(row.result_json) : null;
    }

    saveGapAnalysis(documentId: number, analysis: any): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO aot_results (document_id, result_type, result_json)
            VALUES (?, 'gap_analysis', ?)
        `);
        stmt.run(documentId, JSON.stringify(analysis));
        console.log(`[KnowledgeDB] Gap analysis saved for doc ID: ${documentId}`);
    }

    getGapAnalysis(documentId: number): any | null {
        const row = this.db.prepare(
            `SELECT result_json FROM aot_results WHERE document_id = ? AND result_type = 'gap_analysis'`
        ).get(documentId) as any;
        return row ? JSON.parse(row.result_json) : null;
    }

    saveMockQuestions(documentId: number, questions: any): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO aot_results (document_id, result_type, result_json)
            VALUES (?, 'mock_questions', ?)
        `);
        stmt.run(documentId, JSON.stringify(questions));
        console.log(`[KnowledgeDB] Mock questions saved for doc ID: ${documentId}`);
    }

    getMockQuestions(documentId: number): any | null {
        const row = this.db.prepare(
            `SELECT result_json FROM aot_results WHERE document_id = ? AND result_type = 'mock_questions'`
        ).get(documentId) as any;
        return row ? JSON.parse(row.result_json) : null;
    }

    saveCultureMappings(documentId: number, mappings: any): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO aot_results (document_id, result_type, result_json)
            VALUES (?, 'culture_mappings', ?)
        `);
        stmt.run(documentId, JSON.stringify(mappings));
        console.log(`[KnowledgeDB] Culture mappings saved for doc ID: ${documentId}`);
    }

    getCultureMappings(documentId: number): any | null {
        const row = this.db.prepare(
            `SELECT result_json FROM aot_results WHERE document_id = ? AND result_type = 'culture_mappings'`
        ).get(documentId) as any;
        return row ? JSON.parse(row.result_json) : null;
    }

    deleteAOTResults(documentId: number): void {
        this.db.prepare('DELETE FROM aot_results WHERE document_id = ?').run(documentId);
        console.log(`[KnowledgeDB] AOT results deleted for doc ID: ${documentId}`);
    }
}
