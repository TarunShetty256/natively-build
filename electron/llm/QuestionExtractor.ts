import { TranscriptTurn } from "./transcriptCleaner";

export interface QuestionExtractionResult {
    question: string;
    source: 'interim' | 'interviewer' | 'user' | 'fallback';
    transcriptWindow: string;
}

const MIN_FRAGMENT_LENGTH = 5;
const DEFAULT_FALLBACK_QUESTION = 'tell me about your most recent project and your role in it';

const STARTS_WITH_PATTERNS = [
    'what',
    'why',
    'how',
    'when',
    'where',
    'tell me',
    'explain',
    'describe',
    'walk me through'
];

const CONTAINS_PATTERNS = [
    'how would you',
    'difference between',
    'can you',
    'could you'
];

function normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function isUsableFragment(text: string): boolean {
    return normalizeText(text).length >= MIN_FRAGMENT_LENGTH;
}

function isQuestionLike(text: string): boolean {
    const candidate = normalizeText(text);
    if (!isUsableFragment(candidate)) return false;

    const lower = candidate.toLowerCase();

    const startsWithMatch = STARTS_WITH_PATTERNS.some(pattern =>
        lower.startsWith(pattern)
    );

    const containsMatch = CONTAINS_PATTERNS.some(pattern =>
        lower.includes(pattern)
    );

    return lower.includes('?') || startsWithMatch || containsMatch;
}

function formatWindowLine(turn: TranscriptTurn): string {
    const label = turn.role === 'interviewer'
        ? 'INTERVIEWER'
        : turn.role === 'user'
            ? 'ME'
            : 'ASSISTANT';
    return `[${label}]: ${turn.text}`;
}

export function buildQuestionFocusedTranscriptWindow(
    turns: TranscriptTurn[],
    maxTurns: number = 8
): string {
    const cleaned = turns
        .map(t => ({ ...t, text: normalizeText(t.text) }))
        .filter(t => isUsableFragment(t.text))
        .slice(-maxTurns)
        .map(formatWindowLine);

    return cleaned.join('\n');
}

export function extractLatestQuestionFromTurns(
    turns: TranscriptTurn[],
    interimInterviewerText?: string | null
): QuestionExtractionResult {
    const transcriptWindow = buildQuestionFocusedTranscriptWindow(turns);
    const interim = normalizeText(interimInterviewerText || '');
    const hasInterim = isUsableFragment(interim);

    // Prioritize the latest interviewer utterance sources first (interim + recent finalized).
    const interviewerCandidates: Array<{ text: string; source: 'interim' | 'interviewer' }> = [];

    if (hasInterim) {
        interviewerCandidates.push({ text: interim, source: 'interim' });
    }

    for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        const text = normalizeText(turn.text);
        if (turn.role !== 'interviewer') continue;
        if (!isUsableFragment(text)) continue;

        // Avoid repeating same interim text as first finalized candidate.
        if (hasInterim && text === interim) {
            continue;
        }

        interviewerCandidates.push({ text, source: 'interviewer' });
    }

    // 1) Best-case: latest question-like interviewer utterance
    for (const candidate of interviewerCandidates) {
        if (isQuestionLike(candidate.text)) {
            return {
                question: candidate.text,
                source: candidate.source,
                transcriptWindow
            };
        }
    }

    // 2) Hard fallback: latest non-empty interviewer message (MANDATORY)
    if (interviewerCandidates.length > 0) {
        return {
            question: interviewerCandidates[0].text,
            source: 'fallback',
            transcriptWindow
        };
    }

    // 3) Defensive fallback for unusual stream ordering: latest usable non-interviewer turn
    for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        const text = normalizeText(turn.text);
        if (!isUsableFragment(text)) continue;

        return {
            question: text,
            source: turn.role === 'user' ? 'user' : 'fallback',
            transcriptWindow
        };
    }

    // 4) Absolute non-empty fallback: never return empty/latestQuestion null.
    return {
        question: DEFAULT_FALLBACK_QUESTION,
        source: 'fallback',
        transcriptWindow
    };
}
