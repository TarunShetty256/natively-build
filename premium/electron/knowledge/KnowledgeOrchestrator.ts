import { KnowledgeDatabaseManager } from './KnowledgeDatabaseManager';
import { DocType, KnowledgeDocument, ContextNode, KnowledgeStatus, StructuredResume, StructuredJD, IntentType, CompanyDossier } from './types';
import { extractDocumentText } from './DocumentReader';
import { extractStructuredData } from './StructuredExtractor';
import { chunkAndEmbedDocument } from './DocumentChunker';
import { processResume } from './PostProcessor';
import { getRelevantNodes, formatDossierBlock } from './HybridSearchEngine';
import { assemblePromptContext, PromptAssemblyResult } from './ContextAssembler';
import { classifyIntent, needsCompanyResearch } from './IntentClassifier';
import { CompanyResearchEngine, jdContextFromStructured } from './CompanyResearchEngine';
import { TechnicalDepthScorer } from './TechnicalDepthScorer';
import { AOTPipeline } from './AOTPipeline';
import { generateStarStories, generateStarStoryNodes } from './StarStoryGenerator';
import { generateMockQuestions } from './MockInterviewGenerator';
import { findRelevantValueAlignments, formatValueAlignmentBlock, CultureMappingResult } from './CultureValuesMapper';

export class KnowledgeOrchestrator {
    private db: KnowledgeDatabaseManager;
    private knowledgeModeActive: boolean = false;
    private depthScorer: TechnicalDepthScorer;
    private aotPipeline: AOTPipeline;

    // Cached state for fast retrieval
    private activeResume: KnowledgeDocument | null = null;
    private activeJD: KnowledgeDocument | null = null;
    private cachedNodes: ContextNode[] = [];

    // Injected dependencies
    private generateContentFn: ((contents: any[]) => Promise<string>) | null = null;
    private embedFn: ((text: string) => Promise<number[]>) | null = null;

    // Company research engine
    private companyResearch: CompanyResearchEngine;

    constructor(db: KnowledgeDatabaseManager) {
        this.db = db;
        this.db.initializeSchema();
        this.companyResearch = new CompanyResearchEngine(db);
        this.depthScorer = new TechnicalDepthScorer();
        this.aotPipeline = new AOTPipeline(db, this.companyResearch);
        this.refreshCache();
    }

    // ============================================
    // Configuration
    // ============================================

    setGenerateContentFn(fn: (contents: any[]) => Promise<string>): void {
        this.generateContentFn = fn;
        this.companyResearch.setGenerateContentFn(fn);
        this.aotPipeline.setGenerateContentFn(fn);
    }

    setEmbedFn(fn: (text: string) => Promise<number[]>): void {
        this.embedFn = fn;
    }

    setKnowledgeMode(enabled: boolean): void {
        if (enabled && !this.activeResume) {
            console.warn('[KnowledgeOrchestrator] Cannot enable knowledge mode: no resume loaded');
            return;
        }
        this.knowledgeModeActive = enabled;
        console.log(`[KnowledgeOrchestrator] Knowledge mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }

    isKnowledgeMode(): boolean {
        return this.knowledgeModeActive && this.activeResume !== null;
    }

    /**
     * Get the company research engine for external use (e.g., IPC handlers).
     */
    getCompanyResearchEngine(): CompanyResearchEngine {
        return this.companyResearch;
    }

    /**
     * Get the AOT pipeline for status and results.
     */
    getAOTPipeline(): AOTPipeline {
        return this.aotPipeline;
    }

    /**
     * Get cached gap analysis from AOT pipeline or DB.
     */
    getGapAnalysis(): any | null {
        const cached = this.aotPipeline.getCachedGapAnalysis();
        if (cached) return cached;
        // Fallback to DB
        if (this.activeJD?.id) {
            return this.db.getGapAnalysis(this.activeJD.id);
        }
        return null;
    }

    /**
     * Get cached negotiation script from AOT pipeline or DB.
     */
    getNegotiationScript(): any | null {
        const cached = this.aotPipeline.getCachedNegotiationScript();
        if (cached) return cached;
        if (this.activeJD?.id) {
            return this.db.getNegotiationScript(this.activeJD.id);
        }
        return null;
    }

    /**
     * Get cached mock questions from DB.
     */
    getMockQuestions(): any | null {
        if (this.activeJD?.id) {
            return this.db.getMockQuestions(this.activeJD.id);
        }
        return null;
    }

    /**
     * Get cached culture value mappings from AOT pipeline or DB.
     */
    getCultureMappings(): CultureMappingResult | null {
        const cached = this.aotPipeline.getCachedCultureMapping();
        if (cached) return cached;
        if (this.activeJD?.id) {
            return this.db.getCultureMappings(this.activeJD.id) as CultureMappingResult | null;
        }
        return null;
    }

    // ============================================
    // Status & UI
    // ============================================

    getStatus(): KnowledgeStatus {
        const hasResume = this.activeResume !== null;
        const hasJD = this.activeJD !== null;

        let resumeSummary;
        if (hasResume) {
            try {
                const structured = this.activeResume!.structured_data as StructuredResume;
                const { totalExperienceYears } = processResume(structured);
                resumeSummary = {
                    name: structured.identity.name,
                    role: structured.experience?.[0]?.role || 'Professional',
                    totalExperienceYears
                };
            } catch { /* ignore */ }
        }

        let jdSummary;
        if (hasJD) {
            try {
                const structured = this.activeJD!.structured_data as StructuredJD;
                jdSummary = {
                    title: structured.title || (structured as any).role || 'Unknown Title',
                    company: structured.company || 'Unknown Company'
                };
            } catch { /* ignore */ }
        }

        return {
            hasResume,
            hasActiveJD: hasJD,
            activeMode: this.knowledgeModeActive,
            resumeSummary,
            jdSummary
        };
    }

    // ============================================
    // Ingestion
    // ============================================

    async ingestDocument(filePath: string, type: DocType = DocType.RESUME): Promise<{ success: boolean; error?: string }> {
        if (!this.generateContentFn || !this.embedFn) {
            return { success: false, error: 'LLM and embedding functions not configured.' };
        }

        try {
            console.log(`[KnowledgeOrchestrator] Starting ingestion for ${type} from: ${filePath}`);

            // 1. Extract Text
            const rawText = await extractDocumentText(filePath);

            // 2. Extract Structured JSON
            let structuredData = await extractStructuredData<any>(rawText, type, this.generateContentFn);

            // 3. Post-Process (if resume)
            if (type === DocType.RESUME) {
                const processed = processResume(structuredData as StructuredResume);
                structuredData = processed.structured; // Save the normalized version
            }

            // 4. Delete old documents of this type (we assume 1 active resume and 1 active JD for now)
            this.db.deleteDocumentsByType(type);

            // 5. Save Document Metadata
            const docId = this.db.saveDocument({
                type,
                source_uri: filePath,
                structured_data: structuredData
            });

            // Steps 6-8 can fail — recover by deleting the partially saved document
            try {
                // 6. Chunk and Embed
                const nodesWithEmbeddings = await chunkAndEmbedDocument(structuredData, type, this.embedFn);

                // 7. Save Nodes
                this.db.saveNodes(nodesWithEmbeddings, docId);

                // 8. Generate STAR Stories (Resume Only)
                if (type === DocType.RESUME) {
                    try {
                        console.log(`[KnowledgeOrchestrator] Generating STAR stories for resume...`);
                        const starNodes = await generateStarStoryNodes(structuredData as StructuredResume, this.generateContentFn, this.embedFn);
                        this.db.saveNodes(starNodes, docId);
                    } catch (err: any) {
                        console.error('[KnowledgeOrchestrator] Failed to generate STAR stories:', err.message);
                        // Non-fatal — STAR stories are optional enrichment
                    }
                }
            } catch (embedError: any) {
                // Rollback: delete the partially saved document + any nodes (cascade)
                console.error(`[KnowledgeOrchestrator] Embedding/storage failed, rolling back document ${docId}:`, embedError.message);
                this.db.deleteDocumentsByType(type);
                this.refreshCache();
                return { success: false, error: `Embedding failed: ${embedError.message}. Document rolled back.` };
            }

            this.refreshCache();
            console.log(`[KnowledgeOrchestrator] ✅ Ingestion complete for ${type}`);

            // 9. Fire AOT Pipeline (JD Only)
            if (type === DocType.JD) {
                this.aotPipeline.reset();
                this.aotPipeline.runForJD(
                    this.db.getDocumentByType(DocType.JD)!,
                    this.db.getDocumentByType(DocType.RESUME)
                ).catch((err: Error) => console.error('[KnowledgeOrchestrator] AOT Pipeline failed:', err));
            }

            return { success: true };

        } catch (error: any) {
            console.error('[KnowledgeOrchestrator] Ingestion failed:', error);
            return { success: false, error: error.message };
        }
    }

    // ============================================
    // Chat Integration
    // ============================================

    async processQuestion(question: string): Promise<PromptAssemblyResult | null> {
        if (!this.isKnowledgeMode() || !this.activeResume) {
            return null;
        }

        // Classify intent
        const intent = classifyIntent(question);
        console.log(`[KnowledgeOrchestrator] Intent classified: ${intent}`);

        // Get JD required skills for boosting
        let jdRequiredSkills: string[] = [];
        if (this.activeJD) {
            const jd = this.activeJD.structured_data as StructuredJD;
            jdRequiredSkills = [...(jd.requirements || []), ...(jd.technologies || [])];
        }

        // Retrieve relevant nodes with JD boost
        let relevantNodes: ContextNode[] = [];
        if (this.embedFn && this.cachedNodes.length > 0) {
            try {
                const scoredNodes = await getRelevantNodes(question, this.cachedNodes, this.embedFn, {
                    sourceTypes: [DocType.RESUME, DocType.JD],
                    jdRequiredSkills
                });
                relevantNodes = scoredNodes.map(sn => sn.node);
            } catch (error: any) {
                console.warn('[KnowledgeOrchestrator] Relevance scoring failed:', error.message);
            }
        }

        // Company research — prefer pre-computed AOT dossier, fallback to DB cache
        let dossierContext = '';
        if (needsCompanyResearch(question) && this.activeJD) {
            const jd = this.activeJD.structured_data as StructuredJD;
            if (jd.company) {
                try {
                    // 1. Try AOT pipeline cache (in-memory)
                    let dossier = this.aotPipeline.getCachedDossier();
                    // 2. Fallback: DB cache (persisted from previous AOT runs)
                    if (!dossier) {
                        dossier = this.companyResearch.getCachedDossier(jd.company);
                    }
                    // 3. Last resort: live research (only if no cached data exists at all)
                    if (!dossier) {
                        console.warn('[KnowledgeOrchestrator] No cached dossier found, running live research (consider uploading JD first)');
                        dossier = await this.companyResearch.researchCompany(
                            jd.company, jdContextFromStructured(jd)
                        );
                    }
                    dossierContext = formatDossierBlock(dossier);
                } catch (error: any) {
                    console.warn('[KnowledgeOrchestrator] Company research failed:', error.message);
                }
            }
        }
        // Gap analysis pivot injection — if question mentions a gap skill, inject the pre-computed pivot script
        let gapContext = '';
        if (this.activeJD) {
            const gapAnalysis = this.getGapAnalysis() as import('./types').GapAnalysisResult | null;
            if (gapAnalysis && gapAnalysis.gaps && gapAnalysis.gaps.length > 0) {
                const questionLower = question.toLowerCase();
                const matchingGaps = gapAnalysis.gaps.filter(gap =>
                    questionLower.includes(gap.skill.toLowerCase())
                );
                if (matchingGaps.length > 0) {
                    const pivotLines = matchingGaps.map(gap =>
                        `[Gap: ${gap.skill} (${gap.gap_type})] Pivot: ${gap.pivot_script}${gap.transferable_skills.length > 0 ? ` Transferable skills: ${gap.transferable_skills.join(', ')}` : ''}`
                    );
                    gapContext = `<gap_pivot_scripts>\n${pivotLines.join('\n')}\n</gap_pivot_scripts>`;
                    console.log(`[KnowledgeOrchestrator] Injecting ${matchingGaps.length} pivot script(s) for detected gap skills`);
                }
            }
        }

        // Get tone directive from technical depth scorer
        const toneXML = this.depthScorer.getToneXML();

        // Pass everything to the Context Assembler for JIT prompt construction
        const result = await assemblePromptContext(
            question,
            this.activeResume,
            this.activeJD,
            relevantNodes.map(n => ({ node: n, score: 1 })),
            this.generateContentFn,
            toneXML
        );

        // Append dossier context if available
        if (dossierContext && result) {
            result.contextBlock = result.contextBlock
                ? `${result.contextBlock}\n\n${dossierContext}`
                : dossierContext;
        }

        // Append gap pivot scripts if available
        if (gapContext && result) {
            result.contextBlock = result.contextBlock
                ? `${result.contextBlock}\n\n${gapContext}`
                : gapContext;
        }

        // Culture values alignment injection
        const cultureMappings = this.getCultureMappings();
        if (cultureMappings && cultureMappings.mappings.length > 0 && this.activeJD && result) {
            const jd = this.activeJD.structured_data as StructuredJD;
            const alignments = findRelevantValueAlignments(
                question, cultureMappings.mappings, cultureMappings.core_values, 2
            );
            if (alignments.length > 0) {
                const cultureBlock = formatValueAlignmentBlock(alignments, jd.company);
                if (cultureBlock) {
                    result.contextBlock = result.contextBlock
                        ? `${result.contextBlock}\n\n${cultureBlock}`
                        : cultureBlock;
                    console.log(`[KnowledgeOrchestrator] Injecting ${alignments.length} culture alignment(s) for ${jd.company}`);
                }
            }
        }

        return result;
    }

    // ============================================
    // Management
    // ============================================

    deleteDocumentsByType(type: DocType): void {
        this.db.deleteDocumentsByType(type);
        if (type === DocType.RESUME) this.knowledgeModeActive = false;
        this.refreshCache();
    }

    private refreshCache(): void {
        this.activeResume = this.db.getDocumentByType(DocType.RESUME);
        this.activeJD = this.db.getDocumentByType(DocType.JD);
        this.cachedNodes = this.db.getAllNodes();
        console.log(`[KnowledgeOrchestrator] Cache refreshed: ${this.cachedNodes.length} total nodes across all docs`);
    }

    // ============================================
    // Compact JD Header
    // ============================================

    /**
     * Generate a compact JD header (~150 tokens) for persona injection.
     */
    async generateCompactJDHeader(): Promise<string | null> {
        if (!this.activeJD || !this.generateContentFn) return null;

        const jd = this.activeJD.structured_data as StructuredJD;
        const prompt = `Create a compact summary (~150 tokens) of this job for persona tuning. Include: role title, level, company, top 3 technical themes, and key focus areas. Output a single paragraph, no markdown.

Job: ${jd.title} at ${jd.company}
Level: ${jd.level || 'mid'}
Location: ${jd.location}
Key Requirements: ${jd.requirements?.slice(0, 5).join(', ')}
Technologies: ${jd.technologies?.join(', ')}
Keywords: ${jd.keywords?.join(', ')}`;

        try {
            const header = await this.generateContentFn([{ text: prompt }]);
            return header.trim();
        } catch (error: any) {
            console.warn('[KnowledgeOrchestrator] Failed to generate compact JD header:', error.message);
            return `${jd.level || 'Mid-level'} ${jd.title} at ${jd.company}. Focus: ${jd.keywords?.slice(0, 3).join(', ') || jd.technologies?.slice(0, 3).join(', ') || 'general'}.`;
        }
    }

    /**
     * Get a deterministic compact JD header for persona merging.
     */
    getCompactJDHeader(): string | null {
        if (!this.activeJD) return null;
        const jd = this.activeJD.structured_data as StructuredJD;
        const levelStr = jd.level ? jd.level.charAt(0).toUpperCase() + jd.level.slice(1) : 'Mid-level';
        const techFocus = jd.technologies?.slice(0, 4).join(', ') || '';
        const keyThemes = jd.keywords?.slice(0, 3).join(', ') || '';
        return `${levelStr} ${jd.title} at ${jd.company}${jd.location ? ` (${jd.location})` : ''}. Tech: ${techFocus}. Themes: ${keyThemes}.`;
    }

    // Temporary helper for UI compatibility while refactoring
    getProfileData(): any {
        if (!this.activeResume) return null;
        try {
            const structured = this.activeResume.structured_data as StructuredResume;

            // JD data
            let jdData = null;
            if (this.activeJD) {
                const jd = this.activeJD.structured_data as StructuredJD;
                jdData = {
                    title: jd.title || (jd as any).role || 'Unknown Title',
                    company: jd.company || 'Unknown Company',
                    location: jd.location || 'Unknown Location',
                    level: jd.level,
                    requirements: jd.requirements,
                    technologies: jd.technologies,
                    keywords: jd.keywords,
                    compensation_hint: jd.compensation_hint,
                    min_years_experience: jd.min_years_experience
                };
            }

            // Get AOT results
            const gapAnalysis = this.getGapAnalysis();
            const negotiationScript = this.getNegotiationScript();
            const mockQuestions = this.getMockQuestions();
            const cultureMappings = this.getCultureMappings();
            const aotStatus = this.aotPipeline.getStatus();

            return {
                identity: structured.identity,
                skills: structured.skills,
                experienceCount: structured.experience?.length || 0,
                projectCount: structured.projects?.length || 0,
                educationCount: structured.education?.length || 0,
                nodeCount: this.db.getNodeCount(DocType.RESUME),

                // Expose raw data for detailed visualizations
                experience: structured.experience || [],
                projects: structured.projects || [],
                education: structured.education || [],

                // JD context
                activeJD: jdData,
                hasActiveJD: this.activeJD !== null,

                // AOT pipeline results
                gapAnalysis,
                negotiationScript,
                mockQuestions,
                cultureMappings,
                aotStatus,

                // Dynamic persona info
                compactPersona: this.getCompactJDHeader() || 'Resume-Aware Mode Active',
                toneDirective: this.depthScorer.getToneDirective()
            };
        } catch {
            return null;
        }
    }

    /**
     * Feed an interviewer's STT transcript to the technical depth scorer.
     */
    feedInterviewerUtterance(text: string): void {
        this.depthScorer.addUtterance(text);
    }

    /**
     * Get extracted vocabulary for STT hints, filtering out long sentences.
     */
    getVocabularyHints(): string[] {
        const hints = new Set<string>();
        if (this.activeJD) {
            const jd = this.activeJD.structured_data as StructuredJD;
            if (jd.company) hints.add(jd.company);
            if (jd.title) hints.add(jd.title);
            jd.technologies?.forEach(t => hints.add(t));
            jd.keywords?.forEach(k => hints.add(k));

            // Only include short, keyword-like entries for STT hints
            for (const req of (jd.requirements || [])) {
                if (req.trim().split(/\s+/).length <= 3) {
                    hints.add(req.trim());
                }
            }
        }
        return Array.from(hints);
    }
}

