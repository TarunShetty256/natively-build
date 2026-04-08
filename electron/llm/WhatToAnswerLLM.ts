import { LLMHelper } from "../LLMHelper";
import { UNIVERSAL_WHAT_TO_ANSWER_PROMPT } from "./prompts";
import { IntentResult } from "./IntentClassifier";

const CONTEXT_STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'at', 'is', 'are', 'was', 'were',
    'be', 'been', 'being', 'it', 'this', 'that', 'with', 'as', 'by', 'from', 'about', 'into', 'your',
    'you', 'we', 'they', 'them', 'their', 'our', 'us', 'me', 'my', 'i', 'do', 'did', 'does', 'can',
    'could', 'should', 'would', 'what', 'why', 'how', 'when', 'where', 'which', 'who'
]);

function tokenize(input: string): string[] {
    return (input || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(token => token.length >= 3)
        .filter(token => !CONTEXT_STOP_WORDS.has(token));
}

function countTokenHits(text: string, tokens: Set<string>): number {
    const hay = (text || '').toLowerCase();
    if (!hay || tokens.size === 0) return 0;
    let hits = 0;
    for (const token of tokens) {
        if (hay.includes(token)) hits++;
    }
    return hits;
}

function safeParseJson(raw: string): any | null {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function compactJson(value: any, maxLen: number): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function normalizeLabel(input: string): string {
    return (input || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function similarity(a: string, b: string): number {
    const tokensA = new Set((a || '').toLowerCase().split(/\s+/).filter(Boolean));
    const tokensB = new Set((b || '').toLowerCase().split(/\s+/).filter(Boolean));
    if (tokensA.size === 0 && tokensB.size === 0) return 0;
    const intersection = [...tokensA].filter(x => tokensB.has(x)).length;
    const union = new Set([...tokensA, ...tokensB]).size;
    return union === 0 ? 0 : intersection / union;
}

function stripTagBlock(input: string, tagName: string): string {
    const pattern = new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>`, 'gi');
    return input.replace(pattern, '');
}

function stripSensitiveContextTags(input: string): string {
    let sanitized = input;
    sanitized = stripTagBlock(sanitized, 'key_facts');
    sanitized = stripTagBlock(sanitized, 'job_description');
    sanitized = stripTagBlock(sanitized, 'company_context');
    return sanitized;
}

function selectRelevantResumeContext(
    resumeRaw: string,
    question: string,
    recentQAPairs: Array<{ question: string; answer: string; exampleIds?: string[] }>
): { keyFactsBlock: string; selectedExamples: string[]; selectedExampleIds: string[]; previouslyUsedExamples: string[]; isLowDiversityPool: boolean } {
    const parsed = safeParseJson(resumeRaw);
    if (!parsed || typeof parsed !== 'object') {
        return {
            keyFactsBlock: resumeRaw.length > 1500 ? `${resumeRaw.slice(0, 1500)}...` : resumeRaw,
            selectedExamples: [],
            selectedExampleIds: [],
            previouslyUsedExamples: [],
            isLowDiversityPool: true
        };
    }

    const qTokens = new Set(tokenize(question));
    const recentAnswerText = (recentQAPairs || []).map(pair => pair.answer || '').join(' ');
    const recentExampleIds = new Set(
        (recentQAPairs || [])
            .flatMap(p => p.exampleIds || [])
            .map(id => (id || '').toLowerCase())
    );
    const lastTurnExampleIds = new Set(
        (recentQAPairs || [])
            .slice(-1)
            .flatMap(p => p.exampleIds || [])
            .map(id => (id || '').toLowerCase())
    );

    const identity = parsed.identity || {};
    const skills: string[] = Array.isArray(parsed.skills) ? parsed.skills : [];
    const experience: any[] = Array.isArray(parsed.experience) ? parsed.experience : [];
    const projects: any[] = Array.isArray(parsed.projects) ? parsed.projects : [];

    const skillCandidates = skills.map(skill => ({
        skill,
        score: countTokenHits(skill, qTokens)
    }));
    skillCandidates.sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));

    const relevantSkills = skillCandidates
        .filter(item => item.score > 0)
        .slice(0, 8)
        .map(item => item.skill);
    const fallbackSkills = relevantSkills.length > 0 ? [] : skills.slice(0, 6);

    const examples: Array<{ label: string; text: string; score: number; used: boolean }> = [];

    for (const exp of experience) {
        const role = exp?.role || 'Role';
        const company = exp?.company || 'Company';
        const label = `${role} at ${company}`;
        const normalizedLabel = normalizeLabel(label);
        const text = compactJson(exp, 700);
        const baseScore = countTokenHits(text, qTokens) + (/(impact|result|reduced|improved|scaled|latency|throughput)/i.test(text) ? 1 : 0);
        const usedById = recentExampleIds.has(normalizedLabel);
        const usedBySimilarity = similarity(label, recentAnswerText) > 0.4;
        const used = usedById || usedBySimilarity;
        const reusePenalty = used ? 2 : 0;
        const strongReusePenalty = lastTurnExampleIds.has(normalizedLabel) ? 3 : 0;
        const score = baseScore - reusePenalty - strongReusePenalty;
        examples.push({ label, text, score, used });
    }

    for (const project of projects) {
        const name = project?.name || project?.title || 'Project';
        const tech = Array.isArray(project?.technologies) ? project.technologies.join(', ') : '';
        const label = tech ? `${name} (${tech})` : name;
        const normalizedLabel = normalizeLabel(label);
        const text = compactJson(project, 700);
        const baseScore = countTokenHits(text, qTokens) + (/(built|designed|implemented|optimized|launched)/i.test(text) ? 1 : 0);
        const usedById = recentExampleIds.has(normalizedLabel);
        const usedBySimilarity = similarity(label, recentAnswerText) > 0.4;
        const used = usedById || usedBySimilarity;
        const reusePenalty = used ? 2 : 0;
        const strongReusePenalty = lastTurnExampleIds.has(normalizedLabel) ? 3 : 0;
        const score = baseScore - reusePenalty - strongReusePenalty;
        examples.push({ label, text, score, used });
    }

    examples.sort((a, b) => {
        return b.score - a.score;
    });

    const candidatePool = examples.slice(0, 4);
    candidatePool.sort((a, b) => {
        return (b.score + Math.random() * 0.5) - (a.score + Math.random() * 0.5);
    });

    const isLowDiversityPool = candidatePool.length <= 2;
    const selected = candidatePool.slice(0, 2);
    const selectedExamples = selected.map(item => item.label);
    const selectedExampleIds = selected.map(item => normalizeLabel(item.label));
    const previouslyUsedExamples = examples.filter(item => item.used).slice(0, 4).map(item => item.label);

    console.log('[DEBUG] SelectedExamples:', selectedExampleIds);
    console.log('[DEBUG] CandidatePool:', candidatePool.map(e => e.label));

    const isIdentityRelevantQuestion = /(introduce yourself|tell me about yourself|about yourself|your background|background|walk me through your resume|who are you|brief intro|introduction)/i.test(question);

    const keyFactLines: string[] = [];
    if (isIdentityRelevantQuestion && (identity?.name || identity?.summary)) {
        keyFactLines.push(`Identity: ${JSON.stringify({
            name: identity?.name || '',
            summary: identity?.summary || ''
        })}`);
    }

    const skillsToUse = [...relevantSkills, ...fallbackSkills].slice(0, 8);
    if (skillsToUse.length > 0) {
        keyFactLines.push(`Relevant Skills: ${skillsToUse.join(', ')}`);
    }

    if (selected.length > 0) {
        const rendered = selected.map((item, idx) => `${idx + 1}. ${item.label}\n   ${item.text}`).join('\n');
        keyFactLines.push(`Relevant Examples:\n${rendered}`);
    }

    return {
        keyFactsBlock: keyFactLines.join('\n\n'),
        selectedExamples,
        selectedExampleIds,
        previouslyUsedExamples,
        isLowDiversityPool
    };
}

export interface WhatToAnswerRequest {
    latestQuestion: string;
    transcriptWindow?: string;
    intentResult?: IntentResult;
    isCoding?: boolean;
    intent?: string;
    lastAnswer?: string | null;
    previousQuestion?: string | null;
    previousAnswer?: string | null;
    recentQAPairs?: Array<{ question: string; answer: string; exampleIds?: string[] }>;
    isFollowUp?: boolean;
    followUpFocus?: string | null;
    relatedToPrevious?: boolean;
    forceVariation?: boolean;
    modeHint?: 'what_to_say' | 'answer';
    deterministicMode?: 'answer' | 'behavioral' | 'system_design';
    resume?: string | null;
    jobDescription?: string | null;
    companyContext?: string | null;
    shouldUsePersona?: boolean;
    personaEnabled?: boolean;
    enforceContextAnchors?: boolean;
    contextRetry?: boolean;
}

export class WhatToAnswerLLM {
    private llmHelper: LLMHelper;
    private lastDiversityTone: 'confident' | 'reflective' | 'concise' | null = null;
    private lastDiversityLineCount: number | null = null;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    async generate(request: WhatToAnswerRequest): Promise<string> {
        // Simple wrapper around stream
        const stream = this.generateStream(request);
        let full = "";
        for await (const chunk of stream) full += chunk;
        return full;
    }

    async *generateStream(
        request: WhatToAnswerRequest,
        imagePaths?: string[]
    ): AsyncGenerator<string> {
        try {
            const latestQuestion = (request.latestQuestion || '').trim();
            if (!latestQuestion) {
                throw new Error('Missing latestQuestion for WhatToAnswerLLM.generateStream');
            }
            console.log('[DEBUG] Question:', latestQuestion);

            let contextParts: string[] = [];
            const variationSeed = Math.random();

            const transcriptSummary = (request.transcriptWindow || '').trim();
            let resume: string | null = (request.resume || '').trim() || null;
            let jobDescription: string | null = (request.jobDescription || '').trim() || null;
            let companyContext: string | null = (request.companyContext || '').trim() || null;
            const shouldUsePersona = !!request.shouldUsePersona;

            // Pre-build sanitization: hard-null all persona-bearing sources for non-premium path.
            if (!shouldUsePersona) {
                resume = null;
                jobDescription = null;
                companyContext = null;
            }

            const deterministicMode = request.deterministicMode || 'answer';
            const intent = (request.intent || request.intentResult?.intent || 'general').trim();
            const isCoding = !!request.isCoding || intent === 'coding';
            const route =
                isCoding ? 'coding' :
                intent === 'behavioral' ? 'behavioral' :
                intent === 'system_design' ? 'system_design' :
                'default';
            const questionLower = latestQuestion.toLowerCase();
            const isCodeHintRequest = intent === 'coding' && isCoding && /(how to solve|how do i solve|how do we solve|hint|nudge|guide me|stuck|without (full )?code|approach only)/.test(questionLower);
            const isBrainstormRequest = !isCodeHintRequest && (isCoding || deterministicMode === 'system_design') && /(\bapproach\b|\bideas\b|how would you solve|\bdesign\b)/.test(questionLower);
            const isFollowUp = !!request.isFollowUp;
            const isBehavioralQuestion = intent === 'behavioral' || deterministicMode === 'behavioral';
            const isCompanyQuestion = !isCoding && /(company|culture|mission|values|why (this|our) company|why us|team|organization|job description|jd|about the company|role fit|position)/.test(questionLower);

            const isSimpleQuestion =
                !isBehavioralQuestion &&
                !isCoding &&
                !isCompanyQuestion &&
                questionLower.split(/\s+/).filter(Boolean).length <= 7 &&
                !/(explain|describe|walk me through|trade\s*offs?|deep|details?)/.test(questionLower);

            const lineCandidates = isBehavioralQuestion
                ? [4, 5]
                : isSimpleQuestion
                    ? [2, 3]
                    : [2, 3, 4, 5];

            const tones: Array<'confident' | 'reflective' | 'concise'> = ['confident', 'reflective', 'concise'];
            let targetLineCount = lineCandidates[Math.floor(Math.random() * lineCandidates.length)];
            let selectedTone = tones[Math.floor(Math.random() * tones.length)];

            // Avoid repeating the same tone consecutively (max 3 rerolls).
            if (this.lastDiversityTone && selectedTone === this.lastDiversityTone) {
                for (let i = 0; i < 3; i++) {
                    selectedTone = tones[Math.floor(Math.random() * tones.length)];
                    if (selectedTone !== this.lastDiversityTone) break;
                }
            }

            this.lastDiversityTone = selectedTone;
            this.lastDiversityLineCount = targetLineCount;

            const includeResumeContext = shouldUsePersona && isBehavioralQuestion && !!resume;
            const includeJDContext = shouldUsePersona && !isCoding && !!jobDescription && (isCompanyQuestion || isBehavioralQuestion);
            const includeCompanyContext = shouldUsePersona && !isCoding && !!companyContext && isCompanyQuestion;

            const activeRuleMode: 'code_hint' | 'brainstorm' | 'coding_response' | 'behavioral' | 'none' =
                isCodeHintRequest
                    ? 'code_hint'
                    : isBrainstormRequest
                        ? 'brainstorm'
                        : (isCoding && !isCodeHintRequest && !isBrainstormRequest)
                            ? 'coding_response'
                            : (intent === 'behavioral' || deterministicMode === 'behavioral')
                                ? 'behavioral'
                                : 'none';

            // Build RECENT MESSAGES block (short-term memory first)
            const recentMessageLines: string[] = [];
            const recentPairsForMessages = (request.recentQAPairs || []).slice(-4);
            for (const pair of recentPairsForMessages) {
                const q = (pair.question || '').trim();
                const a = (pair.answer || '').trim();
                if (!q || !a) continue;
                recentMessageLines.push(`INTERVIEWER: ${q}`);
                recentMessageLines.push(`CANDIDATE: ${a}`);
            }
            if (latestQuestion) {
                recentMessageLines.push(`INTERVIEWER (LATEST): ${latestQuestion}`);
            }

            // Build KEY FACTS block (structured candidate data)
            let keyFactsBlock: string | null = null;
            let selectedExamples: string[] = [];
            let selectedExampleIds: string[] = [];
            let previouslyUsedExamples: string[] = [];
            let isLowDiversityPool = false;
            if (includeResumeContext) {
                const selection = selectRelevantResumeContext(resume || '', latestQuestion, request.recentQAPairs || []);
                keyFactsBlock = selection.keyFactsBlock;
                selectedExamples = selection.selectedExamples;
                selectedExampleIds = selection.selectedExampleIds;
                previouslyUsedExamples = selection.previouslyUsedExamples;
                isLowDiversityPool = selection.isLowDiversityPool;
                console.log('[DEBUG] SelectedExampleIDs:', selectedExampleIds.length > 0 ? selectedExampleIds.join(', ') : '[none]');
            }

            let jdBlock: string | null = null;
            if (includeJDContext && jobDescription) {
                try {
                    const parsed = JSON.parse(jobDescription);
                    const slicedJD = isBehavioralQuestion
                        ? {
                            title: parsed?.title,
                            company: parsed?.company,
                            level: parsed?.level,
                            keywords: Array.isArray(parsed?.keywords) ? parsed.keywords.slice(0, 3) : []
                        }
                        : {
                            title: parsed?.title,
                            company: parsed?.company,
                            level: parsed?.level,
                            requirements: Array.isArray(parsed?.requirements) ? parsed.requirements.slice(0, 6) : [],
                            technologies: Array.isArray(parsed?.technologies) ? parsed.technologies.slice(0, 8) : [],
                            keywords: Array.isArray(parsed?.keywords) ? parsed.keywords.slice(0, 8) : []
                        };
                    jdBlock = JSON.stringify(slicedJD);
                } catch {
                    jdBlock = jobDescription.slice(0, 1500);
                }
            }

            let companyBlock: string | null = null;
            if (includeCompanyContext && companyContext) {
                try {
                    const parsed = JSON.parse(companyContext);
                    const slicedCompany = {
                        company: parsed?.company,
                        role: parsed?.role,
                        cultureMappings: Array.isArray(parsed?.cultureMappings) ? parsed.cultureMappings.slice(0, 6) : [],
                        negotiationRange: parsed?.negotiationRange || null
                    };
                    companyBlock = JSON.stringify(slicedCompany);
                } catch {
                    companyBlock = companyContext.slice(0, 1200);
                }
            }

            // Pre-build sanitization: force all derived persona payloads to null when persona gate is off.
            if (!shouldUsePersona) {
                keyFactsBlock = null;
                jdBlock = null;
                companyBlock = null;
            }

            contextParts.push(`<assistant_operating_mode>
You are an AI interview assistant helping a candidate answer questions in real-time.

Use context in this priority order:
1) RECENT MESSAGES (short-term memory)
2) SUMMARY (long-term compressed memory)
3) KEY FACTS (candidate profile: skills, projects, experience)

Do not ask for context already available in SUMMARY or KEY FACTS.
Never request full conversation history.
Never repeat information unnecessarily.
</assistant_operating_mode>`);

            contextParts.push(`<diversity>
seed: ${variationSeed}
</diversity>`);

            if (transcriptSummary) {
                contextParts.push(`<summary>
${transcriptSummary.slice(0, 1800)}
</summary>`);
            }

            if (keyFactsBlock) {
                contextParts.push(`<key_facts>
${keyFactsBlock.slice(0, 1800)}
</key_facts>`);
            }

            if (jdBlock) {
                contextParts.push(`<job_description>
${jdBlock.slice(0, 1500)}
</job_description>`);
            }

            if (companyBlock) {
                contextParts.push(`<company_context>
${companyBlock.slice(0, 1200)}
</company_context>`);
            }

            if (recentMessageLines.length > 0) {
                contextParts.push(`<recent_messages>
${recentMessageLines.join('\n').slice(0, 2000)}
</recent_messages>`);
            }

            if (includeResumeContext && previouslyUsedExamples.length > 0) {
                contextParts.push(`<example_rotation_rules>
Previously used examples/projects (avoid reusing unless absolutely necessary):
${previouslyUsedExamples.join(', ')}

Prefer these fresh examples first:
${selectedExamples.length > 0 ? selectedExamples.join(', ') : 'Use a new example not used recently.'}
</example_rotation_rules>`);
            }

                        contextParts.push(`<example_usage_rules>
- Use a DIFFERENT project/example for each new question
- Do NOT reuse previously used examples unless explicitly asked
</example_usage_rules>`);

                        contextParts.push(`<response_variation_rules>
- Do NOT repeat the same answer structure across questions
- Vary how answers start
- Sometimes start with:
    - experience
    - result
    - impact
</response_variation_rules>`);

                        contextParts.push(`<response_diversity_rules>
- Vary answer length between 2 and 5 lines.
- Target line count for this response: ${targetLineCount}.
- Use this tone for this response: ${selectedTone}.
- If reusing the same project/example, highlight a DIFFERENT aspect than before (e.g., architecture, debugging, collaboration, leadership, performance impact, trade-offs).
</response_diversity_rules>`);

                        contextParts.push(`<anti_repetition_rules>
* Do NOT reuse the same example across consecutive answers unless absolutely necessary
* If reusing, change perspective (architecture, debugging, impact, trade-offs)
* Avoid repeating the same sentence structure
</anti_repetition_rules>`);

                                                contextParts.push(`<structure_variation_rules>
* Do NOT start answers the same way across turns
* Vary opening style:
    * sometimes start with outcome
    * sometimes with challenge
    * sometimes with action
* Avoid repeating "I worked on..." repeatedly
</structure_variation_rules>`);

                        if (includeResumeContext && isLowDiversityPool) {
                                contextParts.push(`<fallback_diversity_rules>
Candidate pool is small for this question, so example reuse is allowed.
If reusing, force a different angle than prior turns (architecture, debugging, impact, trade-offs, or collaboration).
</fallback_diversity_rules>`);
                        }

            contextParts.push(`<focus_question>
LATEST INTERVIEWER QUESTION: ${latestQuestion}
</focus_question>`);
            contextParts.push(`<critical_rules>
Answer ONLY the latest interviewer question above.
Avoid repeating your immediately previous answer wording.
Never return a generic answer.
${shouldUsePersona
? `Every answer must include at least one concrete anchor from available context:
- a real project example, or
- a specific technology used, or
- a real scenario from the candidate's experience.

If the question is about skills, strengths, or challenges, tie it directly to a concrete project from KEY FACTS.`
: `Do not use or infer personal resume details. Provide a generic but interview-ready answer.`}

Context policy:
- Behavioral: use selected resume context and optional JD only.
- Company-related: use JD and company context only.
- Coding: do not use resume, JD, or company context.
</critical_rules>`);

            if (!shouldUsePersona) {
                contextParts.push(`<generic_mode_only>
Premium persona context is disabled for this request.
Use generic interview guidance only.
Do not use resume, JD, or company-specific memory.
</generic_mode_only>`);
            }

            if (!isFollowUp) {
                contextParts.push(`<fresh_question_rule>
If the question is new, ignore previous answer context.
Generate a completely new response.
</fresh_question_rule>`);
            }

            contextParts.push(`<deterministic_mode>
ACTIVE RESPONSE MODE: ${deterministicMode}
</deterministic_mode>`);
            contextParts.push(`<intent_metadata>
INTENT: ${intent}
IS_CODING: ${isCoding}
</intent_metadata>`);
            contextParts.push(`<route>
ROUTE: ${route}
</route>`);
            contextParts.push(`<route_rules>
If ROUTE is coding → structured technical answer
If ROUTE is behavioral → conversational answer
If ROUTE is system_design → focus on scalability + tradeoffs
</route_rules>`);

            contextParts.push(`<ux_adaptive_rules>
Adjust tone and structure based on intent.
Keep answers easy to scan.
If draft answer is long, put the strongest information in the first line.
</ux_adaptive_rules>`);

            if (isCoding && !isCodeHintRequest) {
                contextParts.push(`<ux_coding_compact_rules>
For coding intent, prioritize compact + structured output.
Use short sections and minimal explanation around the core solution.
</ux_coding_compact_rules>`);
            }

            if (intent === 'behavioral' || deterministicMode === 'behavioral') {
                contextParts.push(`<ux_behavioral_conversation_rules>
For behavioral intent, prioritize a conversational and natural spoken tone.
Sound like a confident candidate speaking live, not a template.
</ux_behavioral_conversation_rules>`);
            }

            if (isBehavioralQuestion && jdBlock) {
                contextParts.push(`<behavioral_jd_usage_rules>
For behavioral answers, use JD only lightly for alignment.
Do NOT structure the answer based on JD bullets.
</behavioral_jd_usage_rules>`);
            }

            contextParts.push(`<active_response_rule_mode>
MODE: ${activeRuleMode}
</active_response_rule_mode>`);

            if (activeRuleMode === 'code_hint') {
                contextParts.push(`<code_hint_rules>
When providing a hint:
- Do NOT give full code
- Do not reveal final solution or full implementation.
- Give only direction and key idea
- Help the candidate think, not solve fully
- Keep it short
- Guide step-by-step
</code_hint_rules>`);
            } else if (activeRuleMode === 'brainstorm') {
                contextParts.push(`<brainstorm_rules>
When brainstorming:
1) Start with brute force
2) Explain why it's inefficient
3) Provide optimized approach
4) Mention complexity

Keep it concise.
</brainstorm_rules>`);
            } else if (activeRuleMode === 'coding_response') {
                contextParts.push(`<coding_response_rules>
When IS_CODING is true, use this exact order:
1) One short line: direct approach summary.
2) Clean code block with complete relevant implementation.
3) One short line: time and space complexity.
Always format code inside a proper code block.
Keep explanation extremely brief before code.
Do not ask follow-up questions. Keep naming clear and production-oriented.
</coding_response_rules>`);
            } else if (activeRuleMode === 'behavioral') {
                contextParts.push(`<behavioral_rules>
When INTENT is behavioral:
1) Start with a direct answer.
2) Add one short real example from experience.
3) End with a strong conclusion sentence.

Keep it natural, confident, and specific.

If deterministic mode is behavioral, use STAR with 4 short parts in order:
Situation:
Task:
Action:
Result:
</behavioral_rules>`);
            }
            if (!isBrainstormRequest) {
                contextParts.push(`<context_default_rules>
If intent is not coding or behavioral:
- Give a short direct answer (3–4 lines)
- Do not over-explain
</context_default_rules>`);
            }

            if (deterministicMode === 'system_design') {
                contextParts.push(`<system_design_rules>
Use this exact structure with short section headers:
Requirements:
Architecture:
Scaling:
Trade-offs:

Prioritize practical design aligned with JD/company context.
</system_design_rules>`);
            }

            if (request.enforceContextAnchors) {
                contextParts.push(`<context_enforcement>
Reference only the context types provided above for this question.
If context is missing, state that briefly and continue with the best grounded answer.
</context_enforcement>`);
            }

            if (request.contextRetry) {
                contextParts.push(`<retry_note>
Previous answer was too generic. Rewrite with stronger contextual grounding and concrete specifics.
</retry_note>`);
            }
            contextParts.push(`<interview_style>
If this is a follow-up question, continue from previous context instead of restarting.

You are a high-performing candidate interviewing at a top tech company.
Answer as if you are speaking live in the interview.
Be confident and direct; no filler.
Keep the answer between 2 and 5 lines (target: ${targetLineCount}).

${isBrainstormRequest ? '' : 'Start with a direct answer.'}
Include one real example, project, or experience.
Include at least one concrete technology/tool/framework when relevant.
Mention measurable impact when possible (performance, scale, or outcomes).
Show practical understanding, not theory.

Prefer a clear mini-structure: "First..., then..." or 2 concise points.

Strictly avoid textbook definitions, generic answers, "it depends", over-explaining, and repeated structure.
If the question is similar to before, use a different structure and different example than your previous answer.

Do not use vague self-descriptions like:
- "I am passionate"
- "I am hardworking"
- "I like challenges"

If your answer sounds generic, rewrite it with a concrete example before responding.
${shouldUsePersona
? 'Strongly prioritize using the candidate\'s real experience from provided resume context.'
: 'Do not use candidate-specific persona context; keep the response generic and professional.'}
Do not ask any clarification or follow-up questions.
Output only the spoken answer in natural English.
Keep it concise and interview-ready.
</interview_style>`);

            contextParts.push(`<ux_premium_rules>
- First line must contain the core answer immediately
- Keep answers concise and adaptive (2-5 lines)
- Use short, clear sentences
- Avoid long paragraphs
- Prioritize clarity in the first line
</ux_premium_rules>`);

            contextParts.push(`<final_self_check>
Before finalizing, verify:
1) The answer directly addresses the latest question.
2) The answer includes at least one concrete anchor (project/technology/scenario).
3) The answer is specific, concise, and non-generic.
If any check fails, rewrite once and output only the improved final answer.
</final_self_check>`);

            const previousQuestion = (request.previousQuestion || '').trim();
            const previousAnswer = (request.previousAnswer || '').trim();
            const recentPairs = (request.recentQAPairs || [])
                .slice(-5)
                .map((pair, idx) => {
                    const q = (pair.question || '').trim();
                    const a = (pair.answer || '').trim();
                    if (!q || !a) return null;
                    const clippedAnswer = a.length > 220 ? `${a.slice(0, 220)}...` : a;
                    return `${idx + 1}. Q: ${q}\n   A: ${clippedAnswer}`;
                })
                .filter((x): x is string => !!x)
                .join('\n');

            if (isFollowUp && (previousQuestion || previousAnswer)) {
                contextParts.push(`<conversation_memory>
PREVIOUS QUESTION: ${previousQuestion || 'N/A'}
PREVIOUS ANSWER: ${previousAnswer || 'N/A'}
</conversation_memory>`);
            }

            if (isFollowUp && recentPairs) {
                contextParts.push(`<recent_qa_pairs>
${recentPairs}
</recent_qa_pairs>`);
            }

            const continuityInstructions: string[] = [];
            if (request.isFollowUp) {
                continuityInstructions.push('This is a follow-up question. Build on the previous answer instead of restarting from scratch.');
            }
            if (request.relatedToPrevious) {
                continuityInstructions.push('Current question is related to the previous question. Keep continuity and extend the reasoning.');
            }
            if (request.followUpFocus) {
                continuityInstructions.push(`Follow-up focus area: ${request.followUpFocus}.`);
            }
            if (request.forceVariation) {
                continuityInstructions.push('Strong anti-repetition: change sentence structure and use a different concrete example than the previous answer.');
            }
            if (continuityInstructions.length > 0) {
                contextParts.push(`<continuity_rules>
${continuityInstructions.join('\n')}
</continuity_rules>`);
            }

            if (request.modeHint) {
                contextParts.push(`<mode>
ACTIVE MODE: ${request.modeHint}
</mode>`);
            }

            if (request.intentResult) {
                contextParts.push(`<intent_and_shape>
DETECTED INTENT: ${request.intentResult.intent}
ANSWER SHAPE: ${request.intentResult.answerShape}
</intent_and_shape>`);
            }

            if (isFollowUp && request.lastAnswer && request.lastAnswer.trim().length > 0) {
                const prior = request.lastAnswer.trim();
                const clipped = prior.length > 220 ? `${prior.slice(0, 220)}...` : prior;
                contextParts.push(`<anti_repetition>
LAST ANSWER (do not repeat verbatim): ${clipped}
</anti_repetition>`);
            }

            const uniqueContextParts: string[] = [];
            const seenContextParts = new Set<string>();
            for (const block of contextParts) {
                if (seenContextParts.has(block)) continue;
                seenContextParts.add(block);
                uniqueContextParts.push(block);
            }

            if (uniqueContextParts.length !== contextParts.length) {
                console.log(`[DEBUG] Prompt dedupe removed ${contextParts.length - uniqueContextParts.length} duplicate blocks.`);
            }

            const extraContext = uniqueContextParts.join('\n\n');
            const fullMessage = extraContext;
            const sanitizedFullMessage = shouldUsePersona
                ? fullMessage
                : stripSensitiveContextTags(fullMessage);

            console.log(`[DEBUG] Mode=${activeRuleMode}, isFollowUp=${isFollowUp}, finalPromptLength=${fullMessage.length}`);

            let prompt = UNIVERSAL_WHAT_TO_ANSWER_PROMPT;
            if (includeResumeContext && keyFactsBlock) {
                prompt += `\nUse this experience if relevant:\n${keyFactsBlock}`;
            }

            // Hard safety check to prevent partial persona leaks for non-premium requests.
            if (!shouldUsePersona) {
                const forbiddenTags = [
                    '<key_facts>',
                    '<job_description>',
                    '<company_context>',
                    '<example_rotation_rules>',
                    '<behavioral_jd_usage_rules>'
                ];
                const forbiddenContent = [keyFactsBlock, jdBlock, companyBlock].filter((snippet): snippet is string => !!snippet);
                const hasForbiddenTags = forbiddenTags.some(tag => sanitizedFullMessage.includes(tag));
                const hasForbiddenContent = forbiddenContent.some(snippet => sanitizedFullMessage.includes(snippet) || prompt.includes(snippet));

                if (includeResumeContext || includeJDContext || includeCompanyContext || hasForbiddenTags || hasForbiddenContent) {
                    throw new Error('PERSONA_GATING_ASSERTION_FAILED: Non-premium request contains persona/JD/resume context.');
                }
            }

            const timeoutMs = 40000;
            const timeoutController = new AbortController();
            const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
            const stream = this.llmHelper.streamChat(sanitizedFullMessage, imagePaths, undefined, prompt);
            let hasStreamed = false;

            const fallbackPrefix = 'Let me give a quick structured answer...';
            const fallbackBasic = isCoding
                ? 'Approach: break the problem into clear steps, implement the core path first, then cover edge cases. Complexity: prefer linear time and minimal extra space where possible.'
                : intent === 'behavioral'
                    ? 'Direct answer: I stay calm, prioritize the highest-impact action, and communicate clearly. Example: in a production incident, I led a focused triage with logs and rollbacks, restored stability quickly, and documented follow-ups. Result: we improved reliability and response speed in later incidents.'
                    : 'Direct answer: I focus on the core requirement first, execute with a clear structure, and validate results with concrete outcomes.';

            try {
                while (true) {
                    const nextChunk = await Promise.race([
                        stream.next(),
                        new Promise<IteratorResult<string>>((_, reject) => {
                            const onAbort = () => {
                                timeoutController.signal.removeEventListener('abort', onAbort);
                                reject(new Error('LLM_STREAM_TIMEOUT'));
                            };
                            timeoutController.signal.addEventListener('abort', onAbort, { once: true });
                        })
                    ]);

                    if (nextChunk.done) {
                        break;
                    }

                    // Stream tokens immediately to keep first paint fast.
                    hasStreamed = true;
                    yield nextChunk.value;
                }
            } catch (streamError) {
                try {
                    await stream.return?.(undefined);
                } catch {
                    // no-op: best effort cancellation
                }
                const msg = (streamError as Error)?.message || 'stream_error';
                console.warn(`[WhatToAnswerLLM] stream interrupted (${msg}) after ${timeoutMs}ms`);
                if (!hasStreamed) {
                    yield fallbackPrefix;
                    yield fallbackBasic;
                }
            } finally {
                clearTimeout(timeoutHandle);
            }

        } catch (error) {
            const msg = (error as Error)?.message || 'unknown_error';
            console.warn(`[WhatToAnswerLLM] stream setup failed: ${msg}`);
            yield 'Let me give a quick structured answer...';
            yield 'Direct answer: I will address the core requirement first, give a concrete example, and keep it concise and practical.';
        }
    }
}
