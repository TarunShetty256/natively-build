export interface InterviewRuntimeState {
    lastQuestion: string | null;
    lastAnswer: string | null;
    mode: string;
}

export class InterviewStateManager {
    private state: InterviewRuntimeState = {
        lastQuestion: null,
        lastAnswer: null,
        mode: 'idle'
    };

    getState(): InterviewRuntimeState {
        return { ...this.state };
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

    reset(): void {
        this.state = {
            lastQuestion: null,
            lastAnswer: null,
            mode: 'idle'
        };
    }
}
