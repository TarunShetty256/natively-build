import { ContextNode, DocType, KnowledgeDocument } from './types';

export class KnowledgeDatabaseManager {
    private documents: KnowledgeDocument[] = [];
    private nodes: ContextNode[] = [];
    private gapAnalysis = new Map<number, any>();
    private negotiationScripts = new Map<number, any>();
    private mockQuestions = new Map<number, any>();
    private cultureMappings = new Map<number, any>();
    private nextId = 1;

    public constructor(_db?: any) {}

    public initializeSchema(): void {}

    public deleteDocumentsByType(type: DocType): void {
        const ids = new Set(this.documents.filter(doc => doc.type === type).map(doc => doc.id));
        this.documents = this.documents.filter(doc => doc.type !== type);
        this.nodes = this.nodes.filter(node => !ids.has(node.document_id));
    }

    public saveDocument(doc: KnowledgeDocument): number {
        const id = this.nextId++;
        const stored: KnowledgeDocument = { ...doc, id };
        this.documents.push(stored);
        return id;
    }

    public saveNodes(nodes: ContextNode[], docId: number): void {
        const normalized = nodes.map(node => ({ ...node, document_id: docId }));
        this.nodes.push(...normalized);
    }

    public getDocumentByType(type: DocType): KnowledgeDocument | null {
        const docs = this.documents.filter(doc => doc.type === type);
        return docs.length > 0 ? docs[docs.length - 1] : null;
    }

    public getAllNodes(): ContextNode[] {
        return [...this.nodes];
    }

    public getNodeCount(type: DocType): number {
        return this.nodes.filter(node => node.source_type === type).length;
    }

    public getGapAnalysis(jdId: number): any | null {
        return this.gapAnalysis.get(jdId) ?? null;
    }

    public saveGapAnalysis(jdId: number, data: any): void {
        this.gapAnalysis.set(jdId, data);
    }

    public getNegotiationScript(jdId: number): any | null {
        return this.negotiationScripts.get(jdId) ?? null;
    }

    public saveNegotiationScript(jdId: number, script: any): void {
        this.negotiationScripts.set(jdId, script);
    }

    public getMockQuestions(jdId: number): any | null {
        return this.mockQuestions.get(jdId) ?? null;
    }

    public getCultureMappings(jdId: number): any | null {
        return this.cultureMappings.get(jdId) ?? null;
    }

    public saveCultureMappings(jdId: number, data: any): void {
        this.cultureMappings.set(jdId, data);
    }

    public saveMockQuestions(jdId: number, data: any): void {
        this.mockQuestions.set(jdId, data);
    }
}
