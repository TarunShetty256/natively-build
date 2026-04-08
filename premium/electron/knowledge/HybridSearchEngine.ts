import { CompanyDossier, ContextNode, ScoredNode } from './types';

export interface RelevanceOptions {
    sourceTypes?: string[];
    jdRequiredSkills?: string[];
    categoryHintKeywords?: string[];
    recentNodeIds?: number[];
    maxNodes?: number;
}

export function detectCategoryHints(question: string): string[] {
    const text = question.toLowerCase();
    const hints = new Set<string>();

    if (/(project|side project|portfolio)/.test(text)) hints.add('project');
    if (/(experience|work history|employment|role at)/.test(text)) hints.add('experience');
    if (/(education|degree|school|university|college)/.test(text)) hints.add('education');
    if (/(skill|stack|technology|tech stack|tools)/.test(text)) hints.add('skills');
    if (/(certification|certified|license)/.test(text)) hints.add('certification');
    if (/(leadership|managed|mentored|lead|manager)/.test(text)) hints.add('leadership');
    if (/(requirement|qualification|must have)/.test(text)) hints.add('jd_requirements');
    if (/(responsibilit|duties|you will)/.test(text)) hints.add('jd_responsibilities');
    if (/(compensation|salary|pay|offer|range)/.test(text)) hints.add('jd_compensation');
    if (/(company|employer|organization|team)/.test(text)) hints.add('jd_summary');

    return Array.from(hints);
}

function cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < len; i += 1) {
        const av = a[i];
        const bv = b[i];
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function includesTerm(haystack: string, term: string): boolean {
    const t = term.trim().toLowerCase();
    if (!t || t.length < 2) return false;
    return haystack.includes(t);
}

function tokenizeQuestion(question: string): string[] {
    return question
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length > 2);
}

export async function getRelevantNodes(
    _question: string,
    nodes: ContextNode[],
    _embedFn: (text: string) => Promise<number[]>,
    options: RelevanceOptions = {}
): Promise<ScoredNode[]> {
    const maxNodes = Math.min(5, options.maxNodes ?? 5);
    if (!nodes.length) return [];

    const filteredNodes = options.sourceTypes && options.sourceTypes.length > 0
        ? nodes.filter(node => options.sourceTypes!.includes(node.source_type))
        : nodes;
    if (!filteredNodes.length) return [];

    let questionEmbedding: number[] = [];
    try {
        questionEmbedding = await _embedFn(_question);
    } catch {
        questionEmbedding = [];
    }

    const requiredSkills = options.jdRequiredSkills || [];
    const categoryHints = options.categoryHintKeywords || [];
    const recentNodeIds = new Set(options.recentNodeIds || []);
    const questionLower = _question.toLowerCase();
    const questionTokens = tokenizeQuestion(_question);

    const prioritizeProject = questionLower.includes('project');
    const prioritizeExperience = questionLower.includes('experience');

    const scored = filteredNodes.map(node => {
        const text = `${node.title || ''} ${node.text_content || ''}`.toLowerCase();
        const baseScore = questionTokens.reduce((acc, token) => {
            return acc + (text.includes(token) ? 1.2 : 0);
        }, 0);

        let score = baseScore;

        if (node.category === 'project') score += 2;
        if (node.category === 'experience') score += 2;
        if (node.category === 'skills') score += 1;

        const recentlyUsed = node.id !== undefined && recentNodeIds.has(node.id);
        if (recentlyUsed) {
            score -= 2;
        }

        if (node.embedding && questionEmbedding.length) {
            score += cosineSimilarity(questionEmbedding, node.embedding) * 1.5;
        }

        if (requiredSkills.length > 0) {
            let matches = 0;
            for (const skill of requiredSkills) {
                if (includesTerm(text, skill)) matches += 1;
            }
            score += Math.min(0.25, matches * 0.03);
        }

        if (categoryHints.length > 0) {
            for (const hint of categoryHints) {
                if (node.category === hint) {
                    score += 0.15;
                } else if (hint.startsWith('jd_') && node.category.startsWith('jd_')) {
                    score += 0.08;
                }
            }
        }

        if (prioritizeProject && node.category === 'project') {
            score += 2;
        }

        if (prioritizeExperience && node.category === 'experience') {
            score += 2;
        }

        if (questionLower.includes('salary') && node.category === 'jd_compensation') {
            score += 0.2;
        }

        return { node, score };
    });

    let filtered = scored.filter(item => item.score > 0.5);

    if (filtered.length === 0) {
        filtered = scored.slice(0, 2);
    }

    const sorted = filtered.sort((a, b) => {
        return (b.score + Math.random() * 0.3) - (a.score + Math.random() * 0.3);
    });

    const categoryCounts = new Map<string, number>();
    const diversified: ScoredNode[] = [];
    for (const item of sorted) {
        const category = item.node.category || 'unknown';
        const count = categoryCounts.get(category) || 0;
        if (count >= 2) continue;

        categoryCounts.set(category, count + 1);
        diversified.push({
            ...item,
            node: {
                ...item.node,
                text_content: (item.node.text_content || '').slice(0, 1200)
            }
        });

        if (diversified.length >= maxNodes) break;
    }

    return diversified;
}

export function formatDossierBlock(dossier: CompanyDossier | null): string {
    if (!dossier) return '';
    return JSON.stringify(dossier);
}

export function formatContextBlock(scoredNodes: ScoredNode[], maxNodes: number = 6): string {
    return scoredNodes
    .slice(0, Math.min(maxNodes, 5))
    .map(sn => (sn.node.text_content || '').slice(0, 1200))
        .filter(Boolean)
        .join('\n');
}
