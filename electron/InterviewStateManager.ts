export interface InterviewRuntimeState {
    lastQuestion: string | null;
    lastAnswer: string | null;
    previousQuestions: string[];
    previousAnswers: string[];
    mode: string;
}

export interface InterviewQAPair {
    question: string;
    answer: string;
}

export class InterviewStateManager {
    private state: InterviewRuntimeState = {
        lastQuestion: null,
        lastAnswer: null,
        previousQuestions: [],
        previousAnswers: [],
        mode: 'idle'
    };

    private readonly maxMemoryPairs = 5;

    getState(): InterviewRuntimeState {
        return {
            ...this.state,
            previousQuestions: [...this.state.previousQuestions],
            previousAnswers: [...this.state.previousAnswers]
        };
    }

    setMode(mode: string): void {
        this.state.mode = mode;
    }

    setLastQuestion(question: string | null): void {
        const clean = (question || '').trim();
        this.state.lastQuestion = clean.length > 0 ? clean : null;
    }

    setLastAnswer(answer: string | null): void {
        const clean = (answer || '').trim();
        this.state.lastAnswer = clean.length > 0 ? clean : null;
    }

    pushQAPair(question: string | null, answer: string | null): void {
        const q = (question || '').trim();
        const a = (answer || '').trim();
        if (!q || !a) return;

        const qs = this.state.previousQuestions;
        const as = this.state.previousAnswers;

        // If this is the same question as the latest pair, update answer in place.
        if (qs.length > 0 && qs[qs.length - 1].toLowerCase() === q.toLowerCase()) {
            as[as.length - 1] = a;
            return;
        }

        qs.push(q);
        as.push(a);

        while (qs.length > this.maxMemoryPairs) qs.shift();
        while (as.length > this.maxMemoryPairs) as.shift();
    }

    getRecentQAPairs(limit: number = 5): InterviewQAPair[] {
        const safeLimit = Math.max(1, Math.min(limit, this.maxMemoryPairs));
        const start = Math.max(0, this.state.previousQuestions.length - safeLimit);
        const pairs: InterviewQAPair[] = [];

        for (let i = start; i < this.state.previousQuestions.length; i++) {
            const question = this.state.previousQuestions[i];
            const answer = this.state.previousAnswers[i];
            if (question && answer) {
                pairs.push({ question, answer });
            }
        }

        return pairs;
    }

    reset(): void {
        this.state = {
            lastQuestion: null,
            lastAnswer: null,
            previousQuestions: [],
            previousAnswers: [],
            mode: 'idle'
        };
    }
}
