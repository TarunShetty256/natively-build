import { IntentType } from './types';

const INTRO_PATTERNS = [
    'tell me about yourself',
    'introduce yourself',
    'walk me through your background',
    'self introduction',
    'brief introduction'
];

const NEGOTIATION_PATTERNS = [
    'salary', 'compensation', 'offer', 'counter', 'negotiate', 'negotiation',
    'base', 'total comp', 'tc', 'equity', 'bonus', 'sign-on', 'signing bonus',
    'range', 'package', 'benefits', 'pay'
];

const COMPANY_PATTERNS = [
    'company', 'employer', 'culture', 'values', 'mission', 'leadership',
    'funding', 'runway', 'revenue', 'layoff', 'news', 'competitor',
    'glassdoor', 'blind', 'reviews', 'hiring', 'org', 'organization'
];

const PROFILE_PATTERNS = [
    'project', 'projects', 'experience', 'work history', 'background',
    'skills', 'stack', 'technologies', 'education', 'degree', 'certification',
    'certified', 'achievement', 'leadership'
];

const TECHNICAL_PATTERNS = [
    'system design', 'architecture', 'algorithm', 'complexity', 'debug',
    'implement', 'code', 'function', 'api', 'database', 'scalability',
    'latency', 'throughput', 'data structure'
];

function matchesAny(text: string, patterns: string[]): boolean {
    return patterns.some(p => text.includes(p));
}

export function classifyIntent(question: string): IntentType {
    const text = (question || '').toLowerCase();
    if (!text.trim()) return IntentType.GENERAL;

    if (matchesAny(text, INTRO_PATTERNS)) return IntentType.INTRO;
    if (matchesAny(text, NEGOTIATION_PATTERNS)) return IntentType.NEGOTIATION;
    if (matchesAny(text, COMPANY_PATTERNS)) return IntentType.COMPANY_RESEARCH;
    if (matchesAny(text, PROFILE_PATTERNS)) return IntentType.PROFILE_DETAIL;
    if (matchesAny(text, TECHNICAL_PATTERNS)) return IntentType.TECHNICAL;

    return IntentType.GENERAL;
}

export function needsCompanyResearch(question: string): boolean {
    const text = (question || '').toLowerCase();
    if (!text.trim()) return false;

    // Company research should trigger on explicit company/culture questions
    // or negotiation prompts that need market/benefits context.
    if (matchesAny(text, COMPANY_PATTERNS)) return true;
    if (matchesAny(text, ['compensation', 'salary', 'offer', 'benefits', 'equity'])) return true;
    return false;
}
