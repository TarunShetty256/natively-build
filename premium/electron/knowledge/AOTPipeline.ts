import { AOTStatus, CompanyDossier, KnowledgeDocument, StructuredJD, StructuredResume } from './types';
import { CompanyResearchEngine, jdContextFromStructured } from './CompanyResearchEngine';
import { generateNegotiationScript, NegotiationScript } from './NegotiationEngine';

export class AOTPipeline {
    private companyResearch: CompanyResearchEngine;
    private generateContentFn: ((contents: any[]) => Promise<string>) | null = null;
    private cachedGapAnalysis: any | null = null;
    private cachedNegotiationScript: NegotiationScript | null = null;
    private cachedCultureMapping: any | null = null;
    private cachedDossier: CompanyDossier | null = null;
    private status: AOTStatus = {
        companyResearch: 'pending',
        negotiationScript: 'pending',
        gapAnalysis: 'pending',
        starMapping: 'pending'
    };
    private db: any;

    public constructor(db: any, companyResearch: CompanyResearchEngine) {
        this.db = db;
        this.companyResearch = companyResearch;
    }

    public setGenerateContentFn(fn: (contents: any[]) => Promise<string>): void {
        this.generateContentFn = fn;
    }

    public reset(): void {
        this.cachedGapAnalysis = null;
        this.cachedNegotiationScript = null;
        this.cachedCultureMapping = null;
        this.cachedDossier = null;
        this.status = {
            companyResearch: 'pending',
            negotiationScript: 'pending',
            gapAnalysis: 'pending',
            starMapping: 'pending'
        };
    }

    private extractJsonPayload(raw: string): string {
        let text = raw.trim();
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced?.[1]) {
            text = fenced[1].trim();
        }
        text = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            return text.slice(firstBrace, lastBrace + 1);
        }
        return text;
    }

    private parseJson(raw: string): any {
        const cleaned = this.extractJsonPayload(raw);
        return JSON.parse(cleaned);
    }

    private toString(value: any): string {
        return typeof value === 'string' ? value.trim() : '';
    }

    private toStringArray(value: any): string[] {
        if (!Array.isArray(value)) return [];
        return value.map(v => this.toString(v)).filter(Boolean);
    }

    private toNumber(value: any): number {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    private async buildGapAnalysis(resume: StructuredResume, jd: StructuredJD): Promise<any | null> {
        if (!this.generateContentFn) return null;

        const prompt = [
            'You are analyzing a resume against a job description.',
            'Return ONLY valid JSON. No markdown, no commentary.',
            'Schema:',
            '{',
            '  "matched_skills": [""],',
            '  "gaps": [{ "skill": "", "gap_type": "missing|weak", "pivot_script": "", "transferable_skills": [""] }],',
            '  "match_percentage": 0',
            '}',
            `Resume Skills: ${resume.skills?.join(', ') || ''}`,
            `Resume Experience Highlights: ${(resume.experience || []).slice(0, 3).map(e => `${e.role} at ${e.company}`).join('; ')}`,
            `JD Requirements: ${jd.requirements?.join(', ') || ''}`,
            `JD Technologies: ${jd.technologies?.join(', ') || ''}`,
            'Rules:',
            '- Use 0-100 for match_percentage.',
            '- Keep pivot_script short and speakable.'
        ].join('\n');

        const raw = await this.generateContentFn([{ text: prompt }]);
        const parsed = this.parseJson(raw);
        return {
            matched_skills: this.toStringArray(parsed?.matched_skills),
            gaps: Array.isArray(parsed?.gaps) ? parsed.gaps.map((g: any) => ({
                skill: this.toString(g?.skill),
                gap_type: g?.gap_type || 'missing',
                pivot_script: this.toString(g?.pivot_script),
                transferable_skills: this.toStringArray(g?.transferable_skills)
            })) : [],
            match_percentage: this.toNumber(parsed?.match_percentage)
        };
    }

    private async buildCultureMapping(jd: StructuredJD, dossier: CompanyDossier | null): Promise<any | null> {
        if (!this.generateContentFn) return null;
        const coreValues = dossier?.core_values?.join(', ') || '';

        const prompt = [
            'You are mapping candidate messaging to company values.',
            'Return ONLY valid JSON. No markdown, no commentary.',
            'Schema:',
            '{',
            '  "core_values": [""],',
            '  "mappings": [{ "value": "", "evidence": "" }]',
            '}',
            `Company: ${jd.company}`,
            `Role: ${jd.title}`,
            `Known Values: ${coreValues}`,
            `JD Summary: ${jd.description_summary || ''}`,
            `JD Keywords: ${jd.keywords?.join(', ') || ''}`,
            'Rules:',
            '- Evidence should reference JD language or known values.'
        ].join('\n');

        const raw = await this.generateContentFn([{ text: prompt }]);
        const parsed = this.parseJson(raw);
        return {
            core_values: this.toStringArray(parsed?.core_values),
            mappings: Array.isArray(parsed?.mappings)
                ? parsed.mappings.map((m: any) => ({
                    value: this.toString(m?.value),
                    evidence: this.toString(m?.evidence)
                })).filter((m: any) => m.value)
                : []
        };
    }

    public async runForJD(
        jdDoc: KnowledgeDocument,
        resumeDoc?: KnowledgeDocument | null
    ): Promise<void> {
        if (!jdDoc) return;
        const jd = jdDoc.structured_data as StructuredJD;

        this.status.companyResearch = 'running';
        try {
            this.cachedDossier = await this.companyResearch.researchCompany(
                jd.company || 'Unknown',
                jdContextFromStructured(jd),
                true
            );
            this.status.companyResearch = 'done';
        } catch (error: any) {
            console.warn('[AOTPipeline] Company research failed:', error?.message || error);
            this.status.companyResearch = 'failed';
        }

        if (resumeDoc && this.generateContentFn) {
            this.status.negotiationScript = 'running';
            try {
                this.cachedNegotiationScript = await generateNegotiationScript(
                    resumeDoc,
                    jdDoc,
                    this.cachedDossier,
                    this.generateContentFn
                );
                if (this.db?.saveNegotiationScript && jdDoc.id) {
                    this.db.saveNegotiationScript(jdDoc.id, this.cachedNegotiationScript);
                }
                this.status.negotiationScript = 'done';
            } catch (error: any) {
                console.warn('[AOTPipeline] Negotiation script failed:', error?.message || error);
                this.status.negotiationScript = 'failed';
            }
        }

        if (resumeDoc && this.generateContentFn) {
            this.status.gapAnalysis = 'running';
            try {
                const resume = resumeDoc.structured_data as StructuredResume;
                this.cachedGapAnalysis = await this.buildGapAnalysis(resume, jd);
                if (this.db?.saveGapAnalysis && jdDoc.id) {
                    this.db.saveGapAnalysis(jdDoc.id, this.cachedGapAnalysis);
                }
                this.status.gapAnalysis = 'done';
            } catch (error: any) {
                console.warn('[AOTPipeline] Gap analysis failed:', error?.message || error);
                this.status.gapAnalysis = 'failed';
            }
        }

        if (this.generateContentFn) {
            this.status.starMapping = 'running';
            try {
                this.cachedCultureMapping = await this.buildCultureMapping(jd, this.cachedDossier);
                if (this.db?.saveCultureMappings && jdDoc.id) {
                    this.db.saveCultureMappings(jdDoc.id, this.cachedCultureMapping);
                }
                this.status.starMapping = 'done';
            } catch (error: any) {
                console.warn('[AOTPipeline] Culture mapping failed:', error?.message || error);
                this.status.starMapping = 'failed';
            }
        }
    }

    public getCachedGapAnalysis(): any | null {
        return this.cachedGapAnalysis;
    }

    public getCachedNegotiationScript(): any | null {
        return this.cachedNegotiationScript;
    }

    public getCachedCultureMapping(): any | null {
        return this.cachedCultureMapping;
    }

    public getCachedDossier(): CompanyDossier | null {
        return this.cachedDossier;
    }

    public getStatus(): AOTStatus {
        return { ...this.status };
    }
}
