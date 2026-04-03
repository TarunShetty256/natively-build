import { LLMHelper } from "../LLMHelper";
import { UNIVERSAL_WHAT_TO_ANSWER_PROMPT } from "./prompts";
import { TemporalContext } from "./TemporalContextBuilder";
import { IntentResult } from "./IntentClassifier";

export class WhatToAnswerLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    // Deprecated non-streaming method (redirect to streaming or implement if needed)
    async generate(cleanedTranscript: string): Promise<string> {
        // Simple wrapper around stream
        const stream = this.generateStream(cleanedTranscript);
        let full = "";
        for await (const chunk of stream) full += chunk;
        return full;
    }

    async *generateStream(
        cleanedTranscript: string,
        temporalContext?: TemporalContext,
        intentResult?: IntentResult,
        imagePaths?: string[]
    ): AsyncGenerator<string> {
        try {
            const isOllama = this.llmHelper.getCurrentProvider() === 'ollama';

            const lines = (cleanedTranscript || '')
                .split('\n')
                .map(l => l.trim())
                .filter(Boolean);

            const latestInterviewerLine = [...lines].reverse().find(l => l.startsWith('[INTERVIEWER')) || '';
            const latestInterviewerQuestion = latestInterviewerLine
                .replace(/^\[INTERVIEWER[^\]]*\]:\s*/i, '')
                .trim();

            // Smaller local models perform better with concise, role-focused context.
            const compactConversation = isOllama
                ? lines
                    .filter(l => !l.startsWith('[ASSISTANT'))
                    .slice(-8)
                    .join('\n')
                : cleanedTranscript;

            // Build a rich message context
            // Note: We can't easily inject the complex temporal/intent logic into universal prompt *variables* 
            // but we can prepend it to the message.

            let contextParts: string[] = [];

            if (latestInterviewerQuestion) {
                contextParts.push(`<focus_question>
LATEST INTERVIEWER QUESTION: ${latestInterviewerQuestion}
</focus_question>`);
                contextParts.push(`<critical_rules>
Answer ONLY the latest interviewer question above.
Do not repeat a previous self-introduction unless interviewer explicitly asks to introduce yourself again.
Avoid repeating your immediately previous answer.
</critical_rules>`);
            }

            if (intentResult) {
                contextParts.push(`<intent_and_shape>
DETECTED INTENT: ${intentResult.intent}
ANSWER SHAPE: ${intentResult.answerShape}
</intent_and_shape>`);
            }

            if (temporalContext && temporalContext.hasRecentResponses) {
                // ... simplify temporal context injection for universal prompt ...
                // Just dump it in context if possible
                const history = temporalContext.previousResponses.map((r, i) => `${i + 1}. "${r}"`).join('\n');
                contextParts.push(`PREVIOUS RESPONSES (Avoid Repetition):\n${history}`);
            }

            const extraContext = contextParts.join('\n\n');
            const fullMessage = extraContext
                ? `${extraContext}\n\nCONVERSATION:\n${compactConversation}`
                : compactConversation;

            // Use Universal Prompt
            // Note: WhatToAnswer has a very specific prompt. 
            // We should use UNIVERSAL_WHAT_TO_ANSWER_PROMPT as override

            yield* this.llmHelper.streamChat(fullMessage, imagePaths, undefined, UNIVERSAL_WHAT_TO_ANSWER_PROMPT);

        } catch (error) {
            console.error("[WhatToAnswerLLM] Stream failed:", error);
            throw error;
        }
    }
}
