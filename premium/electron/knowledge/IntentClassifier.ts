// electron/knowledge/IntentClassifier.ts
// Lightweight keyword + pattern-based intent detection for routing queries

import { IntentType } from './types';

// Pattern sets for each intent type
const INTRO_PATTERNS = [
    'introduce yourself',
    'tell me about yourself',
    'who are you',
    'what do you do',
    'describe yourself',
    'about yourself',
    'walk me through your background',
    'brief introduction',
    'self introduction',
    'give me your introduction'
];

const COMPANY_RESEARCH_PATTERNS = [
    'company', 'about the company', 'hiring strategy', 'hiring style',
    'interview process', 'work culture', 'competitor', 'competitors',
    'funding', 'layoffs', 'glassdoor', 'levels.fyi', 'reviews',
    'what is it like to work at', 'tell me about the company'
];

const NEGOTIATION_PATTERNS = [
    'salary', 'compensation', 'package', 'negotiate', 'negotiation',
    'offer', 'counter offer', 'counteroffer', 'pay', 'ctc', 'equity',
    'stock', 'bonus', 'benefits', 'what should i ask', 'expected salary',
    'how much should', 'worth', 'market rate', 'pay range'
];

const TECHNICAL_PATTERNS = [
    'explain', 'how does', 'what is', 'difference between',
    'implement', 'design', 'architecture', 'algorithm', 'data structure',
    'system design', 'trade-off', 'tradeoff', 'pros and cons',
    'best practice', 'when to use', 'how to', 'example of',
    'code', 'debug', 'optimize', 'performance'
];

/**
 * Classify the intent of a user question.
 * Returns the most likely intent type based on keyword matching.
 */
export function classifyIntent(question: string): IntentType {
    const q = question.toLowerCase().trim();

    // Check intro first (most specific)
    if (INTRO_PATTERNS.some(p => q.includes(p))) {
        return IntentType.INTRO;
    }

    // Score each intent
    const scores: Record<IntentType, number> = {
        [IntentType.TECHNICAL]: 0,
        [IntentType.INTRO]: 0,
        [IntentType.COMPANY_RESEARCH]: 0,
        [IntentType.NEGOTIATION]: 0,
        [IntentType.GENERAL]: 0
    };

    for (const pattern of COMPANY_RESEARCH_PATTERNS) {
        if (q.includes(pattern)) scores[IntentType.COMPANY_RESEARCH]++;
    }

    for (const pattern of NEGOTIATION_PATTERNS) {
        if (q.includes(pattern)) scores[IntentType.NEGOTIATION]++;
    }

    for (const pattern of TECHNICAL_PATTERNS) {
        if (q.includes(pattern)) scores[IntentType.TECHNICAL]++;
    }

    // Find highest scoring intent
    const maxScore = Math.max(
        scores[IntentType.COMPANY_RESEARCH],
        scores[IntentType.NEGOTIATION],
        scores[IntentType.TECHNICAL]
    );

    if (maxScore === 0) return IntentType.GENERAL;

    // Priority: negotiation > company_research > technical (when scores tie)
    if (scores[IntentType.NEGOTIATION] === maxScore) return IntentType.NEGOTIATION;
    if (scores[IntentType.COMPANY_RESEARCH] === maxScore) return IntentType.COMPANY_RESEARCH;
    if (scores[IntentType.TECHNICAL] === maxScore) return IntentType.TECHNICAL;

    return IntentType.GENERAL;
}

/**
 * Check if the question needs company research (for use in orchestrator).
 */
export function needsCompanyResearch(question: string): boolean {
    const intent = classifyIntent(question);
    return intent === IntentType.COMPANY_RESEARCH || intent === IntentType.NEGOTIATION;
}
