import { LLMHelper } from "../LLMHelper";
import { UNIVERSAL_WHAT_TO_ANSWER_PROMPT } from "./prompts";
import { IntentResult } from "./IntentClassifier";

export interface WhatToAnswerRequest {
    latestQuestion: string;
    transcriptWindow?: string;
    intentResult?: IntentResult;
    isCoding?: boolean;
    intent?: string;
    lastAnswer?: string | null;
    previousQuestion?: string | null;
    previousAnswer?: string | null;
    recentQAPairs?: Array<{ question: string; answer: string }>;
    isFollowUp?: boolean;
    followUpFocus?: string | null;
    relatedToPrevious?: boolean;
    forceVariation?: boolean;
    modeHint?: 'what_to_say' | 'answer';
    deterministicMode?: 'answer' | 'behavioral' | 'system_design';
    resume?: string | null;
    jobDescription?: string | null;
    companyContext?: string | null;
    personaEnabled?: boolean;
    enforceContextAnchors?: boolean;
    contextRetry?: boolean;
}

export class WhatToAnswerLLM {
    private llmHelper: LLMHelper;

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

            let contextParts: string[] = [];

            const transcriptSummary = (request.transcriptWindow || '').trim();
            const resume = (request.resume || '').trim();
            const jobDescription = (request.jobDescription || '').trim();
            const companyContext = (request.companyContext || '').trim();
            const personaEnabled = !!request.personaEnabled;
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
            let keyFactsBlock = '';
            if (resume) {
                try {
                    const parsed = JSON.parse(resume);
                    const identity = parsed?.identity ? JSON.stringify(parsed.identity) : '';
                    const skills = Array.isArray(parsed?.skills) ? parsed.skills.slice(0, 12).join(', ') : '';
                    const projects = Array.isArray(parsed?.projects)
                        ? parsed.projects.slice(0, 4).map((p: any) => JSON.stringify(p)).join('\n')
                        : '';
                    const experience = Array.isArray(parsed?.experience)
                        ? parsed.experience.slice(0, 5).map((e: any) => JSON.stringify(e)).join('\n')
                        : '';

                    const keyFactParts = [
                        identity ? `Identity: ${identity}` : '',
                        skills ? `Skills: ${skills}` : '',
                        experience ? `Experience:\n${experience}` : '',
                        projects ? `Projects:\n${projects}` : '',
                    ].filter(Boolean);

                    keyFactsBlock = keyFactParts.join('\n\n');
                } catch {
                    keyFactsBlock = resume;
                }
            }

            let jdBlock = '';
            if (jobDescription) {
                try {
                    const parsed = JSON.parse(jobDescription);
                    jdBlock = JSON.stringify(parsed);
                } catch {
                    jdBlock = jobDescription;
                }
            }

            let companyBlock = '';
            if (companyContext) {
                try {
                    const parsed = JSON.parse(companyContext);
                    companyBlock = JSON.stringify(parsed);
                } catch {
                    companyBlock = companyContext;
                }
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

            if (transcriptSummary) {
                contextParts.push(`<summary>
${transcriptSummary.slice(0, 4000)}
</summary>`);
            }

            if (keyFactsBlock) {
                contextParts.push(`<key_facts>
${keyFactsBlock.slice(0, 5000)}
</key_facts>`);
            }

            contextParts.push(`<job_description>
${jdBlock ? jdBlock.slice(0, 5000) : '[JOB DESCRIPTION CONTEXT UNAVAILABLE]'}
</job_description>`);

            contextParts.push(`<company_context>
${companyBlock ? companyBlock.slice(0, 4000) : '[COMPANY CONTEXT UNAVAILABLE]'}
</company_context>`);

            if (recentMessageLines.length > 0) {
                contextParts.push(`<recent_messages>
${recentMessageLines.join('\n').slice(0, 5000)}
</recent_messages>`);
            }

            contextParts.push(`<focus_question>
LATEST INTERVIEWER QUESTION: ${latestQuestion}
</focus_question>`);
            contextParts.push(`<critical_rules>
Answer ONLY the latest interviewer question above.
Avoid repeating your immediately previous answer wording.
Never return a generic answer.
Every answer must include at least one concrete anchor from available context:
- a real project example, or
- a specific technology used, or
- a real scenario from the candidate's experience.

If the question is about skills, strengths, or challenges, tie it directly to a concrete project from KEY FACTS.
</critical_rules>`);
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

            if (isCodeHintRequest) {
                contextParts.push(`<code_hint_rules>
When providing a hint:
- Do NOT give full code
- Do not reveal final solution or full implementation.
- Give only direction and key idea
- Help the candidate think, not solve fully
- Keep it short
- Guide step-by-step
</code_hint_rules>`);
            }

            if (isBrainstormRequest) {
                contextParts.push(`<brainstorm_rules>
When brainstorming:
1) Start with brute force
2) Explain why it's inefficient
3) Provide optimized approach
4) Mention complexity

Keep it concise.
</brainstorm_rules>`);
            }

            if (isCoding && !isCodeHintRequest) {
                contextParts.push(`<coding_response_rules>
When IS_CODING is true, use this exact order:
1) One short line: direct approach summary.
2) Clean code block with complete relevant implementation.
3) One short line: time and space complexity.
Always format code inside a proper code block.
Keep explanation extremely brief before code.
Do not ask follow-up questions. Keep naming clear and production-oriented.
</coding_response_rules>`);
            }

            if (intent === 'behavioral') {
                contextParts.push(`<behavioral_intent_rules>
When INTENT is behavioral:
1) Start with a direct answer.
2) Add one short real example from experience.
3) End with a strong conclusion sentence.

Keep it natural, confident, and specific.
</behavioral_intent_rules>`);
            }
// 👉 ADD IT HERE
contextParts.push(`<context_default_rules>
If intent is not coding or behavioral:
- Give a short direct answer (3–4 lines)
- Do not over-explain
</context_default_rules>`);  

            if (deterministicMode === 'behavioral') {
                contextParts.push(`<behavioral_answer_rules>
Use explicit STAR format with 4 short parts in order:
Situation:
Task:
Action:
Result:

Keep each part concise and grounded in resume/JD/company context.
</behavioral_answer_rules>`);
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
You MUST reference at least one resume anchor and one JD/company anchor when available.
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
Keep the answer under 4-5 lines.

Start with a direct answer.
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
If persona is enabled, strongly prioritize using the candidate's real experience.
Do not ask any clarification or follow-up questions.
Output only the spoken answer in natural English.
Keep it concise and interview-ready.
</interview_style>`);

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

            if (previousQuestion || previousAnswer) {
                contextParts.push(`<conversation_memory>
PREVIOUS QUESTION: ${previousQuestion || 'N/A'}
PREVIOUS ANSWER: ${previousAnswer || 'N/A'}
</conversation_memory>`);
            }

            if (recentPairs) {
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

            if (request.lastAnswer && request.lastAnswer.trim().length > 0) {
                const prior = request.lastAnswer.trim();
                const clipped = prior.length > 220 ? `${prior.slice(0, 220)}...` : prior;
                contextParts.push(`<anti_repetition>
LAST ANSWER (do not repeat verbatim): ${clipped}
</anti_repetition>`);
            }

            const extraContext = contextParts.join('\n\n');
            const fullMessage = extraContext;

            let prompt = UNIVERSAL_WHAT_TO_ANSWER_PROMPT;
            if (resume && personaEnabled) {
                prompt += `\nUse this experience if relevant:\n${resume}`;
            }

            const timeoutMs = 40000;
            const timeoutController = new AbortController();
            const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
            const stream = this.llmHelper.streamChat(fullMessage, imagePaths, undefined, prompt);
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
