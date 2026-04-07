// IntelligenceEngine.ts
// LLM mode routing and orchestration.
// Extracted from IntelligenceManager to decouple LLM logic from state management.

import { EventEmitter } from 'events';
import { LLMHelper } from './LLMHelper';
import { SessionTracker, TranscriptSegment, SuggestionTrigger } from './SessionTracker';
import { InterviewStateManager } from './InterviewStateManager';
import {
    AnswerLLM, AssistLLM, BrainstormLLM, ClarifyLLM, CodeHintLLM, FollowUpLLM, RecapLLM,
    FollowUpQuestionsLLM, WhatToAnswerLLM,
    extractLatestQuestionFromTurns, buildQuestionFocusedTranscriptWindow,
    classifyIntent
} from './llm';
import type { WhatToAnswerRequest } from './llm/WhatToAnswerLLM';

// Mode types
export type IntelligenceMode = 'idle' | 'assist' | 'what_to_say' | 'follow_up' | 'recap' | 'clarify' | 'manual' | 'follow_up_questions' | 'code_hint' | 'brainstorm';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type Mode = 'answer' | 'behavioral' | 'system_design';

interface KnowledgeContextBundle {
    resume: string;
    jobDescription: string;
    company: string;
    hasStructuredContext: boolean;
}

interface ModeGenerationResult {
    answer: string;
    aborted: boolean;
}

interface ModeDetectionMetadata {
    mode: Mode;
    intent: string;
    isCoding: boolean;
}

interface LLMInitializationOptions {
    force?: boolean;
    reason?: string;
}

function detectModeMetadata(input: string): ModeDetectionMetadata {
    const text = (input || '').toLowerCase();

    const behavioralPattern = /\b(tell me about a time|describe a situation|behavioral|conflict|failure|challenge|leadership|mentor|stakeholder|disagreement|difficult teammate|pressure|feedback|mistake)\b/i;
    if (behavioralPattern.test(text)) {
        return { mode: 'behavioral', intent: 'behavioral', isCoding: false };
    }

    const systemDesignPattern = /\b(system design|design (a|an)|architecture|scalab\w*|high[ -]?level design|throughput|latency|availability|reliability|fault tolerance|trade[- ]?off|distributed|microservice|capacity|load balanc\w*|partition\w*|replication)\b/i;
    if (systemDesignPattern.test(text)) {
        return { mode: 'system_design', intent: 'system_design', isCoding: false };
    }

    const negotiationPattern = /\b(negotia\w*|salary|compensation|offer|counter[ -]?offer|bonus|equity|benefits|package|ctc|notice period|relocation|joining bonus|base pay|expected salary)\b/i;
    if (negotiationPattern.test(text)) {
        return { mode: 'answer', intent: 'negotiation', isCoding: false };
    }

    const codingPattern = /\b(code|coding|implement\w*|algorithm|debug\w*|refactor\w*|function|class|api|sql|query|complexity|time complexity|space complexity|unit test|test case|bug|fix)\b/i;
    if (codingPattern.test(text)) {
        return { mode: 'answer', intent: 'coding', isCoding: true };
    }

    return { mode: 'answer', intent: 'general', isCoding: false };
}

function detectMode(input: string): Mode {
    return detectModeMetadata(input).mode;
}

function extractKeywordAnchors(text: string, maxKeywords: number = 12): string[] {
    const blacklist = new Set([
        'with', 'from', 'have', 'this', 'that', 'your', 'about', 'into', 'using',
        'where', 'when', 'were', 'been', 'they', 'them', 'their', 'would', 'could',
        'should', 'there', 'here', 'very', 'much', 'more', 'most', 'than', 'such'
    ]);

    const tokens = (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(token => token.length >= 4)
        .filter(token => !blacklist.has(token));

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
        if (seen.has(token)) continue;
        seen.add(token);
        unique.push(token);
        if (unique.length >= maxKeywords) break;
    }

    return unique;
}

// Refinement intent detection (refined to avoid false positives)
function detectRefinementIntent(userText: string): { isRefinement: boolean; intent: string } {
    const lowercased = userText.toLowerCase().trim();
    const refinementPatterns = [
        { pattern: /make it longer|expand on this|elaborate more/i, intent: 'expand' },
        { pattern: /rephrase that|say it differently|put it another way/i, intent: 'rephrase' },
        { pattern: /give me an example|provide an instance/i, intent: 'add_example' },
        { pattern: /make it more confident|be more assertive|sound stronger/i, intent: 'more_confident' },
        { pattern: /make it casual|be less formal|sound relaxed/i, intent: 'more_casual' },
        { pattern: /make it formal|be more professional|sound professional/i, intent: 'more_formal' },
        { pattern: /simplify this|make it simpler|explain specifically/i, intent: 'simplify' },
    ];

    for (const { pattern, intent } of refinementPatterns) {
        if (pattern.test(lowercased)) {
            return { isRefinement: true, intent };
        }
    }

    return { isRefinement: false, intent: '' };
}

function tokenizeForSimilarity(text: string): string[] {
    return (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(token => token.length > 2);
}

function jaccardSimilarity(a: string, b: string): number {
    const left = new Set(tokenizeForSimilarity(a));
    const right = new Set(tokenizeForSimilarity(b));
    if (left.size === 0 || right.size === 0) return 0;

    let intersection = 0;
    for (const token of left) {
        if (right.has(token)) intersection++;
    }
    const union = left.size + right.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

function detectAutoFollowUpFocus(question: string): string | null {
    const q = (question || '').trim().toLowerCase();
    if (!q) return null;

    if (/\b(why|how)\b\s*\??$/.test(q) || /^why\b|^how\b/.test(q)) return 'reasoning';
    if (/go deeper|deeper|elaborate|expand|explain more|tell me more|can you go deeper/.test(q)) return 'depth';
    if (/scalability|scale|throughput|latency|availability|reliability|fault tolerance|trade[- ]?off/.test(q)) return 'scalability';
    if (/what about\b|edge cases?\??/.test(q)) return 'edge_cases';
    return null;
}

function isShortFollowUpPrompt(question: string): boolean {
    const q = (question || '').trim().toLowerCase();
    if (!q) return false;
    if (q.split(/\s+/).length > 5) return false;
    if (/^(why|how|edge cases?|what else|details|examples?)\??$/.test(q)) return true;
    return /^(and|also|then)\??$/.test(q);
}

function isRelatedToPreviousQuestion(currentQuestion: string, previousQuestion: string | null): boolean {
    const current = (currentQuestion || '').trim().toLowerCase();
    const previous = (previousQuestion || '').trim().toLowerCase();
    if (!current || !previous) return false;

    if (current === previous) return true;
    if (/(that|this|it|those|them|these)/.test(current) && current.split(/\s+/).length <= 8) return true;
    return jaccardSimilarity(current, previous) >= 0.35;
}

function isLikelyAutoFollowUp(currentQuestion: string, previousQuestion: string | null): boolean {
    if (isShortFollowUpPrompt(currentQuestion)) return true;

    const focus = detectAutoFollowUpFocus(currentQuestion);
    if (focus) return true;

    const q = (currentQuestion || '').trim().toLowerCase();
    if (!q) return false;
    if (/^(and|also|then|okay|right|so)\b/.test(q) && q.split(/\s+/).length <= 10) return true;

    return isRelatedToPreviousQuestion(currentQuestion, previousQuestion);
}

// Events emitted by IntelligenceEngine
export interface IntelligenceModeEvents {
    'assist_update': (insight: string) => void;
    'suggested_answer': (answer: string, question: string, confidence: number, confidenceLevel?: ConfidenceLevel) => void;
    'suggested_answer_token': (token: string, question: string, confidence: number) => void;
    'refined_answer': (answer: string, intent: string) => void;
    'refined_answer_token': (token: string, intent: string) => void;
    'recap': (summary: string) => void;
    'recap_token': (token: string) => void;
    'clarify': (clarification: string) => void;
    'clarify_token': (token: string) => void;
    'follow_up_questions_update': (questions: string) => void;
    'follow_up_questions_token': (token: string) => void;
    'manual_answer_started': () => void;
    'manual_answer_result': (answer: string, question: string) => void;
    'mode_changed': (mode: IntelligenceMode) => void;
    'response_mode_changed': (mode: Mode) => void;
    'error': (error: Error, mode: IntelligenceMode) => void;
}

export class IntelligenceEngine extends EventEmitter {
    // Mode state
    private activeMode: IntelligenceMode = 'idle';
    private isInitialized: boolean = false;

    // Mode-specific LLMs
    private answerLLM: AnswerLLM | null = null;
    private assistLLM: AssistLLM | null = null;
    private clarifyLLM: ClarifyLLM | null = null;
    private followUpLLM: FollowUpLLM | null = null;
    private recapLLM: RecapLLM | null = null;
    private followUpQuestionsLLM: FollowUpQuestionsLLM | null = null;
    private whatToAnswerLLM: WhatToAnswerLLM | null = null;
    private codeHintLLM: CodeHintLLM | null = null;
    private brainstormLLM: BrainstormLLM | null = null;

    // Concurrency tracking
    private assistCancellationToken: AbortController | null = null;
    private currentGenerationId: number = 0;

    // Prevent stale looped "what to say" generations when transcript input has not changed.
    private lastWhatToSayInputKey: string | null = null;
    private lastWhatToSayOutput: string | null = null;
    private lastWhatToSayTime: number = 0;

    // User-selected deterministic response mode override.
    private responseModeOverride: Mode | null = null;

    // Keep reference to LLMHelper for client access
    private llmHelper: LLMHelper;

    // Reference to SessionTracker for context
    private session: SessionTracker;

    // Minimal state for the live interview loop
    private stateManager: InterviewStateManager;

    // Timestamps for tracking
    private lastTranscriptTime: number = 0;
    private lastTriggerTime: number = 0;
    private readonly triggerCooldown: number = 3000; // 3 seconds
    private sessionLastQuestion: string | null = null;
    private sessionLastTimestamp: number = 0;
    private readonly sessionIdleResetMs: number = 180000; // 3 minutes

    constructor(llmHelper: LLMHelper, session: SessionTracker) {
        super();
        this.llmHelper = llmHelper;
        this.session = session;
        this.stateManager = new InterviewStateManager();
        this.initializeLLMs();
    }

    getLLMHelper(): LLMHelper {
        return this.llmHelper;
    }

    getRecapLLM(): RecapLLM | null {
        return this.recapLLM;
    }

    setResponseModeOverride(mode: Mode | null): void {
        this.responseModeOverride = mode;
        this.emit('response_mode_changed', this.getResponseModeOverride());
    }

    getResponseModeOverride(): Mode {
        return this.responseModeOverride || 'answer';
    }

    private getKnowledgeContextBundle(): KnowledgeContextBundle {
        const fallbackResume = '[RESUME CONTEXT UNAVAILABLE]';
        const fallbackJD = '[JOB DESCRIPTION CONTEXT UNAVAILABLE]';
        const fallbackCompany = '[COMPANY CONTEXT UNAVAILABLE]';

        const knowledgeOrchestrator = this.llmHelper.getKnowledgeOrchestrator?.();
        const profileData = knowledgeOrchestrator?.getProfileData?.();
        if (!profileData) {
            return {
                resume: fallbackResume,
                jobDescription: fallbackJD,
                company: fallbackCompany,
                hasStructuredContext: false
            };
        }

        const resumeData = {
            identity: profileData.identity,
            skills: (profileData.skills || []).slice(0, 15),
            experience: (profileData.experience || []).slice(0, 5),
            projects: (profileData.projects || []).slice(0, 4),
            education: (profileData.education || []).slice(0, 3)
        };

        const jdData = profileData.activeJD
            ? {
                title: profileData.activeJD.title,
                company: profileData.activeJD.company,
                level: profileData.activeJD.level,
                location: profileData.activeJD.location,
                requirements: (profileData.activeJD.requirements || []).slice(0, 8),
                technologies: (profileData.activeJD.technologies || []).slice(0, 10),
                keywords: (profileData.activeJD.keywords || []).slice(0, 10)
            }
            : null;

        const companyData = profileData.activeJD
            ? {
                company: profileData.activeJD.company,
                role: profileData.activeJD.title,
                cultureMappings: profileData.cultureMappings?.core_values || [],
                negotiationRange: profileData.negotiationScript?.salary_range || null
            }
            : null;

        return {
            resume: JSON.stringify(resumeData),
            jobDescription: jdData ? JSON.stringify(jdData) : fallbackJD,
            company: companyData ? JSON.stringify(companyData) : fallbackCompany,
            hasStructuredContext: !!profileData.identity
        };
    }

    private isProviderFailureMessage(answer: string): boolean {
        const normalized = (answer || '').trim().toLowerCase();
        return normalized.includes('no ai provider') ||
            normalized.includes('no ai providers configured') ||
            normalized.includes('all ai services are currently unavailable');
    }

    private getRoutingCandidatesForMode(mode: Mode): string[] {
        if (mode === 'answer') {
            return ['llama', 'gpt-5.4'];
        }
        return ['gpt-5.4', 'llama'];
    }

    private canOverrideModel(modelId: string): boolean {
        return /^(gpt-|o1-|o3-|claude-|gemini-|models\/|llama-|mixtral-|gemma-|allam-|qwen-|deepseek-|mistral-|compound-)/.test(modelId);
    }

    private async executeWithModeRouting(
        mode: Mode,
        operation: () => Promise<ModeGenerationResult>
    ): Promise<ModeGenerationResult> {
        const currentProvider = this.llmHelper.getActiveProvider?.() || this.llmHelper.getCurrentProvider();
        const originalModel = this.llmHelper.getCurrentModel();

        if (currentProvider !== 'gemini' || !this.canOverrideModel(originalModel)) {
            return operation();
        }

        const candidates = this.getRoutingCandidatesForMode(mode);
        let lastResult: ModeGenerationResult = { answer: '', aborted: false };
        let lastError: Error | null = null;

        try {
            for (const candidate of candidates) {
                this.llmHelper.setModel(candidate);
                try {
                    const result = await operation();
                    lastResult = result;

                    if (result.aborted) {
                        return result;
                    }

                    if (result.answer && !this.isProviderFailureMessage(result.answer)) {
                        return result;
                    }
                } catch (error) {
                    lastError = error as Error;
                    console.warn(`[IntelligenceEngine] Mode route candidate failed (${candidate}): ${(error as Error).message}`);
                }
            }

            if (lastError && !lastResult.answer) {
                throw lastError;
            }
            return lastResult;
        } finally {
            this.llmHelper.setModel(originalModel);
        }
    }

    private async runRoutedResponse<TInput, TResult>(
        input: TInput,
        metadata: {
            mode?: Mode;
            execute: (input: TInput) => Promise<TResult>;
        }
    ): Promise<TResult> {
        const runPrimary = async (): Promise<TResult> => {
            if (metadata.mode) {
                const executeModeOperation = metadata.execute as unknown as (input: TInput) => Promise<ModeGenerationResult>;
                return this.executeWithModeRouting(metadata.mode, () => executeModeOperation(input)) as unknown as TResult;
            }

            return metadata.execute(input);
        };

        try {
            return await runPrimary();
        } catch (primaryError) {
            const originalModel = this.llmHelper.getCurrentModel();
            const lowerModel = (originalModel || '').toLowerCase();
            const fallbackCandidates = lowerModel.includes('gpt-') || lowerModel.includes('o1-') || lowerModel.includes('o3-')
                ? ['llama', 'gemini']
                : lowerModel.includes('llama') || lowerModel.includes('mixtral') || lowerModel.includes('gemma') || lowerModel.includes('qwen') || lowerModel.includes('mistral')
                    ? ['gpt-5.4', 'gemini']
                    : ['llama', 'gpt-5.4'];

            let lastError: Error = primaryError as Error;

            try {
                for (const fallbackModel of fallbackCandidates) {
                    if (!fallbackModel || fallbackModel === originalModel) {
                        continue;
                    }

                    try {
                        this.llmHelper.setModel(fallbackModel);
                        console.warn(`[IntelligenceEngine] Primary model failed (${originalModel}). Retrying with fallback: ${fallbackModel}`);
                        return await runPrimary();
                    } catch (fallbackError) {
                        lastError = fallbackError as Error;
                        console.warn(`[IntelligenceEngine] Fallback model failed (${fallbackModel}): ${(fallbackError as Error).message}`);
                    }
                }
            } finally {
                if (this.llmHelper.getCurrentModel() !== originalModel) {
                    this.llmHelper.setModel(originalModel);
                }
            }

            throw lastError;
        }
    }

    private isWeakModeResponse(answer: string, mode: Mode, knowledgeContext: KnowledgeContextBundle): boolean {
        const trimmed = (answer || '').trim();
        if (trimmed.length < 24) return true;

        const normalized = trimmed.toLowerCase();
        if (mode === 'behavioral') {
            const starSignals = ['situation', 'task', 'action', 'result'];
            const starHits = starSignals.filter(signal => normalized.includes(signal)).length;
            if (starHits < 2 && !/i\s+(led|owned|implemented|handled|delivered|resolved)/i.test(trimmed)) {
                return true;
            }
        }

        if (mode === 'system_design') {
            const requiredSections = ['requirements', 'architecture', 'scaling', 'trade-offs'];
            const sectionHits = requiredSections.filter(section => normalized.includes(section)).length;
            if (sectionHits < 2) {
                return true;
            }
        }

        if (!knowledgeContext.hasStructuredContext) return false;

        const anchors = [
            ...extractKeywordAnchors(knowledgeContext.resume, 8),
            ...extractKeywordAnchors(knowledgeContext.jobDescription, 8),
            ...extractKeywordAnchors(knowledgeContext.company, 6)
        ];

        if (anchors.length === 0) return false;
        const hits = anchors.filter(anchor => normalized.includes(anchor)).length;
        return hits < 2;
    }

    private async generateModeAwareAnswer(
        mode: Mode,
        request: WhatToAnswerRequest,
        generationId: number,
        inferredQuestion: string,
        confidence: number,
        knowledgeContext: KnowledgeContextBundle,
        imagePaths?: string[]
    ): Promise<ModeGenerationResult> {
        if (!this.whatToAnswerLLM) {
            return { answer: '', aborted: false };
        }

        const modeRequest: WhatToAnswerRequest = {
            ...request,
            deterministicMode: mode,
            enforceContextAnchors: true
        };

        const firstPass = await this.runRoutedResponse(modeRequest, {
            mode,
            execute: async (routedModeRequest) => {
            let fullAnswer = '';
            const stream = await this.runRoutedResponse(
                { routedModeRequest, imagePaths },
                {
                    execute: async ({ routedModeRequest: requestForStream, imagePaths: streamImagePaths }) =>
                        this.whatToAnswerLLM!.generateStream(requestForStream, streamImagePaths)
                }
            );
            let streamAborted = false;

            for await (const token of stream) {
                if (this.currentGenerationId !== generationId) {
                    console.log('[IntelligenceEngine] _what_to_say stream aborted by new generation');
                    await stream.return(undefined);
                    streamAborted = true;
                    break;
                }
                this.emit('suggested_answer_token', token, inferredQuestion, confidence);
                fullAnswer += token;
            }

            return { answer: fullAnswer, aborted: streamAborted };
            }
        });

        if (firstPass.aborted) {
            return firstPass;
        }

        let finalAnswer = firstPass.answer;
        if (this.isWeakModeResponse(finalAnswer, mode, knowledgeContext)) {
            const retryRequest: WhatToAnswerRequest = {
                ...modeRequest,
                contextRetry: true,
                forceVariation: true
            };

            const retryPass = await this.runRoutedResponse(retryRequest, {
                mode,
                execute: async (routedRetryRequest) => {
                const retried = (await this.runRoutedResponse(routedRetryRequest, {
                    execute: async (requestForRetry) => this.whatToAnswerLLM!.generate(requestForRetry)
                })).trim();
                return { answer: retried, aborted: false };
                }
            });

            if (retryPass.answer && !this.isProviderFailureMessage(retryPass.answer)) {
                finalAnswer = retryPass.answer;
            }
        }

        return { answer: finalAnswer, aborted: false };
    }

    private async handleSystemDesign(
        request: WhatToAnswerRequest,
        generationId: number,
        inferredQuestion: string,
        confidence: number,
        knowledgeContext: KnowledgeContextBundle,
        imagePaths?: string[]
    ): Promise<ModeGenerationResult> {
        return this.generateModeAwareAnswer(
            'system_design',
            request,
            generationId,
            inferredQuestion,
            confidence,
            knowledgeContext,
            imagePaths
        );
    }

    private async handleBehavioral(
        request: WhatToAnswerRequest,
        generationId: number,
        inferredQuestion: string,
        confidence: number,
        knowledgeContext: KnowledgeContextBundle,
        imagePaths?: string[]
    ): Promise<ModeGenerationResult> {
        return this.generateModeAwareAnswer(
            'behavioral',
            request,
            generationId,
            inferredQuestion,
            confidence,
            knowledgeContext,
            imagePaths
        );
    }

    private async handleAnswerMode(
        request: WhatToAnswerRequest,
        generationId: number,
        inferredQuestion: string,
        confidence: number,
        knowledgeContext: KnowledgeContextBundle,
        imagePaths?: string[]
    ): Promise<ModeGenerationResult> {
        return this.generateModeAwareAnswer(
            'answer',
            request,
            generationId,
            inferredQuestion,
            confidence,
            knowledgeContext,
            imagePaths
        );
    }

    // ============================================
    // LLM Initialization
    // ============================================

    /**
     * Initialize or Re-Initialize mode-specific LLMs with shared Gemini client and Groq client
     * Must be called after API keys are updated.
     */
    initializeLLMs(options: LLMInitializationOptions = {}): void {
        const { force = false, reason } = options;

        if (this.isInitialized && !force) {
            console.log('[IntelligenceEngine] Already initialized, skipping');
            return;
        }

        if (this.isInitialized && force) {
            const reasonSuffix = reason ? ` due to ${reason}` : '';
            console.log(`[IntelligenceEngine] Reinitializing${reasonSuffix}`);
        } else {
            console.log('[IntelligenceEngine] Initializing...');
        }

        this.answerLLM = new AnswerLLM(this.llmHelper);
        this.assistLLM = new AssistLLM(this.llmHelper);
        this.clarifyLLM = new ClarifyLLM(this.llmHelper);
        this.followUpLLM = new FollowUpLLM(this.llmHelper);
        this.recapLLM = new RecapLLM(this.llmHelper);
        this.followUpQuestionsLLM = new FollowUpQuestionsLLM(this.llmHelper);
        this.whatToAnswerLLM = new WhatToAnswerLLM(this.llmHelper);
        this.codeHintLLM = new CodeHintLLM(this.llmHelper);
        this.brainstormLLM = new BrainstormLLM(this.llmHelper);

        // Sync RecapLLM reference to SessionTracker for epoch compaction
        this.session.setRecapLLM(this.recapLLM);
        const activeProvider = this.llmHelper.getActiveProvider?.() || this.llmHelper.getCurrentProvider();
        console.log(`[LLM] Active Provider: ${activeProvider}`);
        this.isInitialized = true;
    }

    reinitializeLLMs(reason: string = 'credential update'): void {
        this.initializeLLMs({ force: true, reason });
    }

    // ============================================
    // Transcript Handling (delegates to SessionTracker)
    // ============================================

    /**
     * Process transcript from native audio, and trigger follow-up if appropriate
     */
    handleTranscript(segment: TranscriptSegment, skipRefinementCheck: boolean = false): void {
        const result = this.session.handleTranscript(segment);
        this.lastTranscriptTime = Date.now();

        // Check for follow-up intent if user is speaking
        if (result && !skipRefinementCheck && result.role === 'user' && this.session.getLastAssistantMessage()) {
            const { isRefinement, intent } = detectRefinementIntent(segment.text.trim());
            if (isRefinement) {
                this.runFollowUp(intent, segment.text.trim());
            }
        }
    }

    /**
     * Handle suggestion trigger from native audio service
     * This is the primary auto-trigger path
     */
    async handleSuggestionTrigger(trigger: SuggestionTrigger): Promise<void> {
        if (trigger.confidence < 0.5) {
            return;
        }

        // Auto suggestion triggers should never preempt explicit user actions
        // like Clarify/Recap/Follow-up. Those modes set activeMode away from idle.
        if (this.activeMode !== 'idle' && this.activeMode !== 'what_to_say') {
            console.log(`[IntelligenceEngine] Skipping auto trigger while mode=${this.activeMode}`);
            return;
        }

        await this.runWhatShouldISay(trigger.lastQuestion, trigger.confidence);
    }

    // ============================================
    // Mode Executors
    // ============================================

    /**
     * MODE 1: Assist (Passive)
     * Low-priority observational insights
     */
    async runAssistMode(): Promise<string | null> {
        if (this.activeMode !== 'idle' && this.activeMode !== 'assist') {
            return null;
        }

        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
        }

        this.assistCancellationToken = new AbortController();
        this.setMode('assist');

        try {
            if (!this.assistLLM) {
                this.setMode('idle');
                return null;
            }

            const context = this.session.getFormattedContext(60);
            if (!context) {
                this.setMode('idle');
                return null;
            }

            const insight = await this.runRoutedResponse(context, {
                execute: async (assistContext) => this.assistLLM!.generate(assistContext)
            });

            if (this.assistCancellationToken?.signal.aborted) {
                return null;
            }

            if (insight) {
                this.emit('assist_update', insight);
            }
            this.setMode('idle');
            return insight;

        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                return null;
            }
            this.emit('error', error as Error, 'assist');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 2: What Should I Say (Primary)
     * Manual trigger - uses clean transcript pipeline for question inference
     * NEVER returns null - always provides a usable response
     */
    async runWhatShouldISay(question?: string, confidence: number = 0.8, imagePaths?: string[]): Promise<string | null> {
        const now = Date.now();
        const explicitQuestion = (question || '').trim();
        const isExplicitRequest = explicitQuestion.length > 0 || !!(imagePaths && imagePaths.length > 0);

        // Cooldown is only for inferred/auto triggers. Explicit user requests (typed/speech/image)
        // should run immediately to keep manual actions responsive.
        if (!isExplicitRequest && now - this.lastTriggerTime < this.triggerCooldown) {
            return null;
        }

        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }

        this.setMode('what_to_say');
        this.lastTriggerTime = now;

        try {
            if (!this.whatToAnswerLLM) {
                if (!this.answerLLM) {
                    this.setMode('idle');
                    return "Please configure your API Keys in Settings to use this feature.";
                }
                const context = this.session.getFormattedContext(180);
                const manualQuestion = explicitQuestion || this.stateManager.getState().lastQuestion || '';
                const answer = await this.runRoutedResponse(
                    { manualQuestion, context },
                    {
                        execute: async ({ manualQuestion: questionForFallback, context: fallbackContext }) =>
                            this.answerLLM!.generate(questionForFallback, fallbackContext)
                    }
                );
                if (answer) {
                    const confidenceResult = this.calculateAnswerConfidence(
                        manualQuestion || 'inferred',
                        answer,
                        this.stateManager.getState().lastAnswer
                    );
                    this.session.addAssistantMessage(answer);
                    this.stateManager.setLastQuestion(manualQuestion || null);
                    this.stateManager.setLastAnswer(answer);
                    if (manualQuestion) {
                        this.sessionLastQuestion = manualQuestion;
                        this.sessionLastTimestamp = Date.now();
                    }
                    this.emit('suggested_answer', answer, manualQuestion || 'inferred', confidenceResult.score, confidenceResult.level);
                }
                this.setMode('idle');
                return answer || "Could you repeat that? I want to make sure I address your question properly.";
            }

            const contextItems = this.session.getContext(180);

            // Inject latest interim transcript if available
            const lastInterim = this.session.getLastInterimInterviewer();
            if (lastInterim && lastInterim.text.trim().length > 0) {
                const lastItem = contextItems[contextItems.length - 1];
                const isDuplicate = lastItem &&
                    lastItem.role === 'interviewer' &&
                    (lastItem.text === lastInterim.text || Math.abs(lastItem.timestamp - lastInterim.timestamp) < 1000);

                if (!isDuplicate) {
                    console.log(`[IntelligenceEngine] Injecting interim transcript: "${lastInterim.text.substring(0, 50)}..."`);
                    contextItems.push({
                        role: 'interviewer',
                        text: lastInterim.text,
                        timestamp: lastInterim.timestamp
                    });
                }
            }

            const transcriptTurns = contextItems.map(item => ({
                role: item.role,
                text: item.text,
                timestamp: item.timestamp
            }));

            const extracted = extractLatestQuestionFromTurns(
                transcriptTurns,
                lastInterim?.text || null
            );

            if (this.sessionLastTimestamp > 0 && (now - this.sessionLastTimestamp) > this.sessionIdleResetMs) {
                console.log('[IntelligenceEngine] Session idle for >3m, resetting runtime state.');
                this.stateManager.reset();
                this.sessionLastQuestion = null;
            }

            const runtimeState = this.stateManager.getState();
            const previousQuestion = this.sessionLastQuestion || runtimeState.lastQuestion;
            const rawQuestion = explicitQuestion || extracted.question || previousQuestion || '';
            const isShortFollowUp = isShortFollowUpPrompt(rawQuestion);
            const resolvedQuestion = (isShortFollowUp && previousQuestion)
                ? `${previousQuestion} (${rawQuestion})`
                : rawQuestion;
            const inferredQuestion = rawQuestion || 'inferred';
            const questionWindow = extracted.transcriptWindow || buildQuestionFocusedTranscriptWindow(transcriptTurns, 8);
            const autoFollowUp = isShortFollowUp || isLikelyAutoFollowUp(rawQuestion, previousQuestion);
            const followUpFocus = detectAutoFollowUpFocus(rawQuestion);
            const relatedToPrevious = isShortFollowUp || isRelatedToPreviousQuestion(rawQuestion, previousQuestion);
            const forceVariation = autoFollowUp || relatedToPrevious;
            const recentQAPairs = this.stateManager.getRecentQAPairs(5);

            // If this is an inferred request with unchanged source text+context, skip regeneration
            // for a short window to avoid repeating stale answers in a loop.
            const isInferredRun = !(explicitQuestion.length > 0);
            const hasImages = !!(imagePaths && imagePaths.length > 0);
            const inputKey = `${inferredQuestion}\n---\n${questionWindow}`;
            if (
                isInferredRun &&
                !hasImages &&
                this.lastWhatToSayInputKey === inputKey &&
                (now - this.lastWhatToSayTime) < 12000
            ) {
                console.log('[IntelligenceEngine] Skipping duplicate what_to_say generation (unchanged transcript input).');
                this.setMode('idle');
                return this.lastWhatToSayOutput;
            }

            const intentResult = await classifyIntent(
                resolvedQuestion || null,
                questionWindow,
                this.session.getAssistantResponseHistory().length
            );

            const modeMetadata = detectModeMetadata(resolvedQuestion || questionWindow);
            const resolvedIntent = modeMetadata.intent === 'general' ? intentResult.intent : modeMetadata.intent;
            const responseMetadata = {
                isCoding: modeMetadata.isCoding || intentResult.intent === 'coding',
                intent: resolvedIntent
            };

            const detectedMode: Mode = this.responseModeOverride || (
                intentResult.intent === 'behavioral'
                    ? 'behavioral'
                    : detectMode(resolvedQuestion || questionWindow)
            );

            const knowledgeContext = this.getKnowledgeContextBundle();

            const baseRequest: WhatToAnswerRequest = {
                latestQuestion: resolvedQuestion || 'Please repeat the interviewer question clearly.',
                transcriptWindow: questionWindow,
                intentResult,
                lastAnswer: runtimeState.lastAnswer,
                previousQuestion: runtimeState.lastQuestion,
                previousAnswer: runtimeState.lastAnswer,
                recentQAPairs,
                isFollowUp: autoFollowUp,
                followUpFocus,
                relatedToPrevious,
                forceVariation,
                modeHint: 'what_to_say',
                isCoding: responseMetadata.isCoding,
                intent: responseMetadata.intent,
                resume: knowledgeContext.resume,
                jobDescription: knowledgeContext.jobDescription,
                companyContext: knowledgeContext.company,
                personaEnabled: true,
                enforceContextAnchors: true
            };

            console.log(`[IntelligenceEngine] Question-focused generation: intent=${responseMetadata.intent}, coding=${responseMetadata.isCoding}, mode=${detectedMode}, source=${extracted.source}${imagePaths?.length ? `, with ${imagePaths.length} image(s)` : ''}`);

            const generationId = ++this.currentGenerationId;
            let fullAnswer = '';
            let modeResult: ModeGenerationResult;

            if (detectedMode === 'system_design') {
                modeResult = await this.handleSystemDesign(
                    baseRequest,
                    generationId,
                    inferredQuestion,
                    confidence,
                    knowledgeContext,
                    imagePaths
                );
            } else if (detectedMode === 'behavioral') {
                modeResult = await this.handleBehavioral(
                    baseRequest,
                    generationId,
                    inferredQuestion,
                    confidence,
                    knowledgeContext,
                    imagePaths
                );
            } else {
                modeResult = await this.handleAnswerMode(
                    baseRequest,
                    generationId,
                    inferredQuestion,
                    confidence,
                    knowledgeContext,
                    imagePaths
                );
            }

            if (modeResult.aborted) {
                // Aborted mid-stream — don't update session or emit final event
                this.setMode('idle');
                return null;
            }

            fullAnswer = modeResult.answer;

            if (!fullAnswer || fullAnswer.trim().length < 5) {
                fullAnswer = "Could you repeat that? I want to make sure I address your question properly.";
            }

            if (this.isProviderFailureMessage(fullAnswer)) {
                this.emit('error', new Error(fullAnswer), 'what_to_say');
                this.setMode('idle');
                return null;
            }

            if (runtimeState.lastAnswer) {
                fullAnswer = await this.diversifyAnswerIfNeeded(
                    fullAnswer,
                    resolvedQuestion || inferredQuestion,
                    runtimeState.lastAnswer,
                    forceVariation
                );
            }

            this.session.addAssistantMessage(fullAnswer);
            this.stateManager.setLastAnswer(fullAnswer);
            if (resolvedQuestion) {
                this.stateManager.setLastQuestion(resolvedQuestion);
                this.sessionLastQuestion = resolvedQuestion;
                this.sessionLastTimestamp = Date.now();
            }
            this.stateManager.pushQAPair(resolvedQuestion || inferredQuestion, fullAnswer);

            this.lastWhatToSayInputKey = inputKey;
            this.lastWhatToSayOutput = fullAnswer;
            this.lastWhatToSayTime = Date.now();

            const confidenceResult = this.calculateAnswerConfidence(
                resolvedQuestion || inferredQuestion,
                fullAnswer,
                runtimeState.lastAnswer
            );

            this.session.pushUsage({
                type: 'assist',
                timestamp: Date.now(),
                question: inferredQuestion,
                answer: fullAnswer,
                mode: detectedMode,
                intent: responseMetadata.intent,
                isCoding: responseMetadata.isCoding
            });

            // CQ-05 fix: only emit the "complete" event after a non-aborted stream.
            // The renderer already has all tokens — this is for metadata only (e.g. copying, history).
            this.emit('suggested_answer', fullAnswer, inferredQuestion, confidenceResult.score, confidenceResult.level);

            this.setMode('idle');
            return fullAnswer;

        } catch (error) {
            this.emit('error', error as Error, 'what_to_say');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 3: Follow-Up (Refinement)
     * Modify the last assistant message
     */
    async runFollowUp(intent: string, userRequest?: string): Promise<string | null> {
        console.log(`[IntelligenceEngine] runFollowUp called with intent: ${intent}`);
        const runtimeState = this.stateManager.getState();
        const lastMsg = runtimeState.lastAnswer || this.session.getLastAssistantMessage();
        if (!lastMsg) {
            console.warn('[IntelligenceEngine] No lastAssistantMessage found for follow-up');
            return null;
        }

        this.setMode('follow_up');

        try {
            if (!this.followUpLLM) {
                console.error('[IntelligenceEngine] FollowUpLLM not initialized');
                this.setMode('idle');
                return null;
            }

            const contextParts: string[] = [];
            if (runtimeState.lastQuestion) {
                contextParts.push(`[LATEST QUESTION]: ${runtimeState.lastQuestion}`);
            }
            const formattedContext = this.session.getFormattedContext(60);
            if (formattedContext) {
                contextParts.push(formattedContext);
            }
            const context = contextParts.join('\n\n');
            const refinementRequest = userRequest || intent;

            const generationId = ++this.currentGenerationId;
            let fullRefined = "";
            const stream = await this.runRoutedResponse(
                { lastMsg, refinementRequest, context },
                {
                    execute: async ({ lastMsg: followUpMessage, refinementRequest: followUpRequest, context: followUpContext }) =>
                        this.followUpLLM!.generateStream(
                            followUpMessage,
                            followUpRequest,
                            followUpContext
                        )
                }
            );
            let streamAborted = false;

            for await (const token of stream) {
                if (this.currentGenerationId !== generationId) {
                    console.log('[IntelligenceEngine] _follow_up stream aborted by new generation');
                    await stream.return(undefined);
                    streamAborted = true;
                    break;
                }
                this.emit('refined_answer_token', token, intent);
                fullRefined += token;
            }

            if (!streamAborted && fullRefined) {
                this.session.addAssistantMessage(fullRefined);
                this.stateManager.setLastAnswer(fullRefined);
                this.stateManager.pushQAPair(runtimeState.lastQuestion, fullRefined);
                this.emit('refined_answer', fullRefined, intent);

                const intentMap: Record<string, string> = {
                    'expand': 'Expand Answer',
                    'rephrase': 'Rephrase Answer',
                    'add_example': 'Add Example',
                    'more_confident': 'Make More Confident',
                    'more_casual': 'Make More Casual',
                    'more_formal': 'Make More Formal',
                    'simplify': 'Simplify Answer'
                };

                const displayQuestion = userRequest || intentMap[intent] || `Refining: ${intent}`;

                this.session.pushUsage({
                    type: 'followup',
                    timestamp: Date.now(),
                    question: displayQuestion,
                    answer: fullRefined
                });
            }

            this.setMode('idle');
            return fullRefined;

        } catch (error) {
            this.emit('error', error as Error, 'follow_up');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 4: Recap (Summary)
     * Neutral conversation summary
     */
    async runRecap(): Promise<string | null> {
        console.log('[IntelligenceEngine] runRecap called');
        this.setMode('recap');

        try {
            if (!this.recapLLM) {
                console.error('[IntelligenceEngine] RecapLLM not initialized');
                this.setMode('idle');
                return null;
            }

            // Use full session context so recap reflects the whole conversation,
            // not only the most recent rolling window.
            const context = this.session.getFullSessionContext() || this.session.getFormattedContext(120);
            if (!context) {
                console.warn('[IntelligenceEngine] No context available for recap');
                this.setMode('idle');
                return null;
            }

            const generationId = ++this.currentGenerationId;
            let fullSummary = "";
            const stream = await this.runRoutedResponse(context, {
                execute: async (recapContext) => this.recapLLM!.generateStream(recapContext)
            });
            let streamAborted = false;

            for await (const token of stream) {
                if (this.currentGenerationId !== generationId) {
                    console.log('[IntelligenceEngine] _recap stream aborted by new generation');
                    await stream.return(undefined);
                    streamAborted = true;
                    break;
                }
                this.emit('recap_token', token);
                fullSummary += token;
            }

            // Only emit final if not aborted
            if (!streamAborted && fullSummary && this.currentGenerationId === generationId) {
                this.emit('recap', fullSummary);

                this.session.pushUsage({
                    type: 'chat',
                    timestamp: Date.now(),
                    question: 'Recap Meeting',
                    answer: fullSummary
                });
            }
            if (this.currentGenerationId === generationId) {
                this.setMode('idle');
            }
            return fullSummary;

        } catch (error) {
            this.emit('error', error as Error, 'recap');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE: Clarify
     * Ask a clarifying question to the interviewer
     */
    async runClarify(): Promise<string | null> {
        console.log('[IntelligenceEngine] runClarify called');
        this.setMode('clarify');

        try {
            if (!this.clarifyLLM) {
                console.error('[IntelligenceEngine] ClarifyLLM not initialized');
                this.setMode('idle');
                return null;
            }

            const contextItems = this.session.getContext(180);
            const transcriptTurns = contextItems.map(item => ({
                role: item.role,
                text: item.text,
                timestamp: item.timestamp
            }));
            const extracted = extractLatestQuestionFromTurns(
                transcriptTurns,
                this.session.getLastInterimInterviewer()?.text || null
            );

            const state = this.stateManager.getState();
            const focusQuestion = state.lastQuestion || extracted.question;
            const transcriptWindow = extracted.transcriptWindow || buildQuestionFocusedTranscriptWindow(transcriptTurns, 8);

            const context = focusQuestion
                ? `LATEST QUESTION TO CLARIFY:\n${focusQuestion}\n\nRECENT TRANSCRIPT:\n${transcriptWindow}`
                : '[No transcript available yet. The candidate just joined the interview. Generate an opening clarifying question to understand the scope and constraints of the upcoming problem.]';

            const generationId = ++this.currentGenerationId;
            let fullClarification = "";
            const stream = await this.runRoutedResponse(context, {
                execute: async (clarifyContext) => this.clarifyLLM!.generateStream(clarifyContext)
            });
            let streamAborted = false;

            for await (const token of stream) {
                if (this.currentGenerationId !== generationId) {
                    console.log('[IntelligenceEngine] _clarify stream aborted by new generation');
                    await stream.return(undefined);
                    streamAborted = true;
                    break;
                }
                this.emit('clarify_token', token);
                fullClarification += token;
            }

            if (streamAborted) {
                this.setMode('idle');
                return null;
            }

            // Only update history and emit final if not aborted
            if (fullClarification && this.currentGenerationId === generationId) {
                this.emit('clarify', fullClarification);
                this.session.addAssistantMessage(fullClarification);

                this.session.pushUsage({
                    type: 'chat',
                    timestamp: Date.now(),
                    question: 'Clarify Question',
                    answer: fullClarification
                });
            }
            if (this.currentGenerationId === generationId) {
                this.setMode('idle');
            }
            return fullClarification;

        } catch (error) {
            this.emit('error', error as Error, 'clarify');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 6: Follow-Up Questions
     * Suggest strategic questions for the user to ask
     */
    async runFollowUpQuestions(): Promise<string | null> {
        console.log('[IntelligenceEngine] runFollowUpQuestions called');
        this.setMode('follow_up_questions');

        try {
            if (!this.followUpQuestionsLLM) {
                console.error('[IntelligenceEngine] FollowUpQuestionsLLM not initialized');
                this.setMode('idle');
                return null;
            }

            const context = this.session.getFormattedContext(120);
            if (!context) {
                console.warn('[IntelligenceEngine] No context available for follow-up questions');
                this.setMode('idle');
                return null;
            }

            const generationId = ++this.currentGenerationId;
            let fullQuestions = "";
            const stream = await this.runRoutedResponse(context, {
                execute: async (followUpContext) => this.followUpQuestionsLLM!.generateStream(followUpContext)
            });

            for await (const token of stream) {
                if (this.currentGenerationId !== generationId) {
                    console.log('[IntelligenceEngine] _follow_up_questions stream aborted by new generation');
                    break;
                }
                this.emit('follow_up_questions_token', token);
                fullQuestions += token;
            }

            if (fullQuestions && this.currentGenerationId === generationId) {
                this.emit('follow_up_questions_update', fullQuestions);
                this.session.pushUsage({
                    type: 'followup_questions',
                    timestamp: Date.now(),
                    question: 'Generate Follow-up Questions',
                    answer: fullQuestions
                });
            }
            if (this.currentGenerationId === generationId) {
                this.setMode('idle');
            }
            return fullQuestions;

        } catch (error) {
            this.emit('error', error as Error, 'follow_up_questions');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 5: Manual Answer (Fallback)
     * Explicit bypass when auto-detection fails
     */
    async runManualAnswer(question: string): Promise<string | null> {
        this.emit('manual_answer_started');
        this.setMode('manual');
        this.stateManager.setLastQuestion(question);

        try {
            if (!this.answerLLM) {
                this.setMode('idle');
                return null;
            }

            const context = this.session.getFormattedContext(120);
            const answer = await this.runRoutedResponse(
                { question, context },
                {
                    execute: async ({ question: manualQuestion, context: manualContext }) =>
                        this.answerLLM!.generate(manualQuestion, manualContext)
                }
            );

            if (answer) {
                this.session.addAssistantMessage(answer);
                this.stateManager.setLastAnswer(answer);
                this.stateManager.pushQAPair(question, answer);
                this.emit('manual_answer_result', answer, question);

                this.session.pushUsage({
                    type: 'chat',
                    timestamp: Date.now(),
                    question: question,
                    answer: answer
                });
            }

            this.setMode('idle');
            return answer;

        } catch (error) {
            this.emit('error', error as Error, 'manual');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 7: Code Hint (Live Code Reviewer)
     * Analyzes a screenshot of partially written code against the detected/provided question
     * and returns a short targeted hint. Question comes from (priority order):
     *   1. problemStatement passed in from ipcHandler (screenshot extraction — highest confidence)
     *   2. session.detectedCodingQuestion (detected from interviewer transcript)
     *   3. transcriptContext (last N seconds of conversation — fallback for inference)
     */
    async runCodeHint(imagePaths?: string[], problemStatement?: string): Promise<string | null> {
        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }

        this.setMode('code_hint');

        try {
            if (!this.codeHintLLM) {
                this.setMode('idle');
                return "Please configure your API Keys in Settings to use this feature.";
            }

            // Resolve question context from available sources (priority order)
            const sessionQuestion = this.session.getDetectedCodingQuestion();
            const questionContext = problemStatement ?? sessionQuestion.question ?? null;
            const questionSource = problemStatement
                ? 'screenshot'
                : sessionQuestion.source;

            // Pull transcript as fallback context when no question is pinned
            const transcriptContext = questionContext === null
                ? this.session.getFormattedContext(180)
                : null;

            console.log(`[IntelligenceEngine] Code hint — question source: ${questionContext ? (questionSource ?? 'passed') : 'none'}, transcript lines: ${transcriptContext ? transcriptContext.split('\n').length : 0}, images: ${imagePaths?.length ?? 0}`);

            const generationId = ++this.currentGenerationId;
            let fullHint = "";
            const stream = await this.runRoutedResponse(
                { imagePaths, questionContext, questionSource, transcriptContext },
                {
                    execute: async ({ imagePaths: hintImagePaths, questionContext: hintQuestionContext, questionSource: hintQuestionSource, transcriptContext: hintTranscriptContext }) =>
                        this.codeHintLLM!.generateStream(
                            hintImagePaths,
                            hintQuestionContext ?? undefined,
                            hintQuestionSource,
                            hintTranscriptContext ?? undefined
                        )
                }
            );

            for await (const token of stream) {
                if (this.currentGenerationId !== generationId) {
                    console.log('[IntelligenceEngine] code_hint stream aborted by new generation');
                    break;
                }
                this.emit('suggested_answer_token', token, 'Code Hint', 1.0);
                fullHint += token;
            }

            if (!fullHint || fullHint.trim().length < 5) {
                fullHint = "I couldn't detect any code in the screenshot. Try screenshotting your code editor directly.";
            }

            this.session.addAssistantMessage(fullHint);
            this.session.pushUsage({
                type: 'assist',
                timestamp: Date.now(),
                question: 'Code Hint',
                answer: fullHint
            });

            this.emit('suggested_answer', fullHint, 'Code Hint', 1.0, this.confidenceLevelFromScore(1.0));
            this.setMode('idle');
            return fullHint;

        } catch (error) {
            this.emit('error', error as Error, 'code_hint');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 8: Brainstorm (Strategic Approach Generator)
     * Generates a spoken script outlining 2-3 problem-solving approaches with trade-offs.
     */
    async runBrainstorm(imagePaths?: string[], problemStatement?: string): Promise<string | null> {
        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }

        this.setMode('brainstorm');

        try {
            if (!this.brainstormLLM) {
                this.setMode('idle');
                return "Please configure your API Keys in Settings to use this feature.";
            }

            const state = this.stateManager.getState();
            const contextItems = this.session.getContext(180);

            // Keep brainstorm focused on the active interview turn by including interim
            // interviewer text when available and avoiding assistant echo context.
            const lastInterim = this.session.getLastInterimInterviewer();
            if (lastInterim && lastInterim.text.trim().length > 0) {
                const lastItem = contextItems[contextItems.length - 1];
                const isDuplicate = lastItem &&
                    lastItem.role === 'interviewer' &&
                    (lastItem.text === lastInterim.text || Math.abs(lastItem.timestamp - lastInterim.timestamp) < 1000);

                if (!isDuplicate) {
                    contextItems.push({
                        role: 'interviewer',
                        text: lastInterim.text,
                        timestamp: lastInterim.timestamp
                    });
                }
            }

            const transcriptTurns = contextItems.map(item => ({
                role: item.role,
                text: item.text,
                timestamp: item.timestamp
            }));

            const nonAssistantTurns = transcriptTurns.filter(turn => turn.role !== 'assistant');
            const extracted = extractLatestQuestionFromTurns(
                nonAssistantTurns,
                lastInterim?.text || null
            );
            const transcriptWindow = buildQuestionFocusedTranscriptWindow(nonAssistantTurns, 10);

            const isGenericFallbackQuestion =
                extracted.source === 'fallback' &&
                /tell me about your most recent project/i.test(extracted.question);

            const extractedQuestion = isGenericFallbackQuestion ? null : extracted.question;
            const detectedQuestion = this.session.getDetectedCodingQuestion().question?.trim() || null;

            // Prepend a specific problem/question so brainstorm mode stays focused.
            const resolvedProblem =
                problemStatement?.trim() ||
                extractedQuestion ||
                detectedQuestion ||
                state.lastQuestion ||
                null;

            let context = '';
            if (resolvedProblem) {
                this.stateManager.setLastQuestion(resolvedProblem);
                context += `<problem_statement>\n${resolvedProblem}\n</problem_statement>\n`;
            }

            if (transcriptWindow.trim()) {
                context += `\n<recent_transcript>\n${transcriptWindow}\n</recent_transcript>\n`;
            }

            if (!context.trim() && imagePaths && imagePaths.length > 0) {
                context = `<recent_transcript>\n[No usable transcript found. Infer the problem from the attached screenshot(s).]\n</recent_transcript>`;
            }

            if (!context.trim() && (!imagePaths || imagePaths.length === 0)) {
                this.setMode('idle');
                const msg = "There's nothing to brainstorm right now. Make sure your question is visible or spoken aloud, then try again.";
                this.session.addAssistantMessage(msg);
                this.emit('suggested_answer', msg, 'Brainstorming Approaches', 1.0, this.confidenceLevelFromScore(1.0));
                return msg;
            }

            const generationId = ++this.currentGenerationId;
            let fullResult = "";
            const stream = await this.runRoutedResponse(
                { context, imagePaths },
                {
                    execute: async ({ context: brainstormContext, imagePaths: brainstormImagePaths }) =>
                        this.brainstormLLM!.generateStream(brainstormContext, brainstormImagePaths)
                }
            );
            let streamAborted = false;

            for await (const token of stream) {
                if (this.currentGenerationId !== generationId) {
                    console.log('[IntelligenceEngine] brainstorm stream aborted by new generation');
                    await stream.return(undefined);
                    streamAborted = true;
                    break;
                }
                this.emit('suggested_answer_token', token, 'Brainstorming Approaches', 1.0);
                fullResult += token;
            }

            if (streamAborted) {
                this.setMode('idle');
                return null;
            }

            if (!fullResult || fullResult.trim().length < 5) {
                fullResult = "I couldn't generate brainstorm approaches. Make sure your question is visible and try again.";
            }

            this.session.addAssistantMessage(fullResult);
            this.session.pushUsage({
                type: 'assist',
                timestamp: Date.now(),
                question: 'Brainstorm',
                answer: fullResult
            });

            this.emit('suggested_answer', fullResult, 'Brainstorming Approaches', 1.0, this.confidenceLevelFromScore(1.0));
            this.setMode('idle');
            return fullResult;

        } catch (error) {
            this.emit('error', error as Error, 'brainstorm');
            this.setMode('idle');
            return null;
        }
    }

    // ============================================
    // State Management
    // ============================================

    private isAnswerTooSimilar(candidate: string, previousAnswer: string): boolean {
        const a = (candidate || '').trim();
        const b = (previousAnswer || '').trim();
        if (!a || !b) return false;
        if (a.toLowerCase() === b.toLowerCase()) return true;

        const similarity = jaccardSimilarity(a, b);
        // High lexical overlap suggests repetitive answer structure/content.
        return similarity >= 0.72;
    }

    private async diversifyAnswerIfNeeded(
        candidate: string,
        question: string,
        previousAnswer: string,
        forceVariation: boolean
    ): Promise<string> {
        const shouldDiversify = forceVariation || this.isAnswerTooSimilar(candidate, previousAnswer);
        if (!shouldDiversify || !this.followUpLLM) {
            return candidate;
        }

        try {
            const diversified = await this.runRoutedResponse(
                { candidate, question },
                {
                    execute: async ({ candidate: answerCandidate, question: answerQuestion }) =>
                        this.followUpLLM!.generate(
                            answerCandidate,
                            `Rephrase this answer with a different structure and a different concrete example while preserving correctness. Keep it concise and directly answer: "${answerQuestion}".`
                        )
                }
            );
            const clean = (diversified || '').trim();
            return clean.length > 0 ? clean : candidate;
        } catch {
            return candidate;
        }
    }

    private confidenceLevelFromScore(score: number): ConfidenceLevel {
        if (score >= 0.8) return 'high';
        if (score >= 0.5) return 'medium';
        return 'low';
    }

    private calculateAnswerConfidence(
        question: string,
        answer: string,
        previousAnswer: string | null
    ): { level: ConfidenceLevel; score: number } {
        const a = (answer || '').trim();
        const wordCount = a.split(/\s+/).filter(Boolean).length;

        const sentenceCount = a
            .split(/[.!?]+/)
            .map(part => part.trim())
            .filter(Boolean)
            .length;

        const hasRealExample = /\b(project|experience|in my previous role|at my last|i worked on|we built|for example|for instance|i led|i implemented)\b/i.test(a);
        const hasMeasurableImpact =
            /\b\d+(?:\.\d+)?(?:%|x|ms|s|sec|seconds|minutes|hours|users|requests|rps|qps|months|years|k|m|million|billion)?\b/i.test(a) ||
            /\b(scale|scaled|performance|latency|throughput|uptime|availability|reduced|improved|faster|slower)\b/i.test(a);
        const hasStrongConfidenceLanguage = /\b(definitely|certainly|clearly|absolutely|i can|i will|i led|i delivered|i improved|i reduced)\b/i.test(a);
        const hasVagueLanguage = /\b(maybe|generally|it depends)\b/i.test(a);
        const lessThanOneSentence = sentenceCount < 1 || wordCount < 4;
        const similarToPrevious = !!previousAnswer && this.isAnswerTooSimilar(a, previousAnswer);

        let points = 0;
        if (hasRealExample) points += 2;
        if (hasMeasurableImpact) points += 2;
        if (hasStrongConfidenceLanguage) points += 1;
        if (hasVagueLanguage) points -= 2;
        if (lessThanOneSentence) points -= 2;
        if (similarToPrevious) points -= 1;

        let level: ConfidenceLevel;
        if (points >= 3) {
            level = 'high';
        } else if (points >= 1) {
            level = 'medium';
        } else {
            level = 'low';
        }

        const score = level === 'high' ? 0.9 : level === 'medium' ? 0.65 : 0.35;
        return { level, score };
    }

    private setMode(mode: IntelligenceMode): void {
        this.stateManager.setMode(mode);
        if (this.activeMode !== mode) {
            this.activeMode = mode;
            this.emit('mode_changed', mode);
        }
    }

    getActiveMode(): IntelligenceMode {
        return this.activeMode;
    }

    /**
     * Reset engine state (cancels any in-flight operations)
     */
    reset(): void {
        this.activeMode = 'idle';
        this.stateManager.reset();
        this.sessionLastQuestion = null;
        this.sessionLastTimestamp = 0;
        this.currentGenerationId++; // Increment to break all active LLM streams
        this.lastWhatToSayInputKey = null;
        this.lastWhatToSayOutput = null;
        this.lastWhatToSayTime = 0;
        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }
    }
}
