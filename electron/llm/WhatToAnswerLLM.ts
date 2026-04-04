import { LLMHelper } from "../LLMHelper";
import { UNIVERSAL_WHAT_TO_ANSWER_PROMPT } from "./prompts";
import { IntentResult } from "./IntentClassifier";

export interface WhatToAnswerRequest {
    latestQuestion: string;
    transcriptWindow?: string;
    intentResult?: IntentResult;
    lastAnswer?: string | null;
    previousQuestion?: string | null;
    previousAnswer?: string | null;
    recentQAPairs?: Array<{ question: string; answer: string }>;
    isFollowUp?: boolean;
    followUpFocus?: string | null;
    relatedToPrevious?: boolean;
    forceVariation?: boolean;
    modeHint?: 'what_to_say' | 'answer';
    resume?: string | null;
    personaEnabled?: boolean;
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

            contextParts.push(`<focus_question>
LATEST INTERVIEWER QUESTION: ${latestQuestion}
</focus_question>`);
            contextParts.push(`<critical_rules>
Answer ONLY the latest interviewer question above.
Avoid repeating your immediately previous answer wording.
</critical_rules>`);
            contextParts.push(`<interview_style>
You are a high-performing candidate interviewing at a top tech company.
Answer as if you are speaking live in the interview.
Be confident and direct; no filler.
Keep the answer to 2-3 sentences maximum.

Start with a direct answer.
Include one real example, project, or experience.
Mention measurable impact when possible (performance, scale, or outcomes).
Show practical understanding, not theory.

Strictly avoid textbook definitions, generic answers, "it depends", over-explaining, and repeated structure.
If the question is similar to before, use a different structure and different example than your previous answer.

If your answer sounds generic, rewrite it with a concrete example before responding.
If persona is enabled, strongly prioritize using the candidate's real experience.
If the question is unclear, ask exactly one short clarification question instead of guessing.
Output only the spoken answer in natural English.
No bullet points.
</interview_style>`);

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
            const resume = (request.resume || '').trim();
            const personaEnabled = !!request.personaEnabled;
            if (resume && personaEnabled) {
                prompt += `\nUse this experience if relevant:\n${resume}`;
            }

            yield* this.llmHelper.streamChat(fullMessage, imagePaths, undefined, prompt);

        } catch (error) {
            console.error("[WhatToAnswerLLM] Stream failed:", error);
            throw error;
        }
    }
}
