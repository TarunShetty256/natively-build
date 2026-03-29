import { CompanyDossier, ContextNode, ScoredNode } from './types';

export interface RelevanceOptions {
    sourceTypes?: string[];
    jdRequiredSkills?: string[];
    categoryHintKeywords?: string[];
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

export async function getRelevantNodes(
    _question: string,
    nodes: ContextNode[],
    _embedFn: (text: string) => Promise<number[]>,
    options: RelevanceOptions = {}
): Promise<ScoredNode[]> {
    const maxNodes = options.maxNodes ?? nodes.length;
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
    const questionLower = _question.toLowerCase();

    const scored = filteredNodes.map(node => {
        const text = `${node.title || ''} ${node.text_content || ''}`.toLowerCase();
        const baseScore = node.embedding && questionEmbedding.length
            ? cosineSimilarity(questionEmbedding, node.embedding)
            : 0;

        let boost = 0;

        if (requiredSkills.length > 0) {
            let matches = 0;
            for (const skill of requiredSkills) {
                if (includesTerm(text, skill)) matches += 1;
            }
            boost += Math.min(0.25, matches * 0.03);
        }

        if (categoryHints.length > 0) {
            for (const hint of categoryHints) {
                if (node.category === hint) {
                    boost += 0.15;
                } else if (hint.startsWith('jd_') && node.category.startsWith('jd_')) {
                    boost += 0.08;
                }
            }
        }

        if (questionLower.includes('salary') && node.category === 'jd_compensation') {
            boost += 0.2;
        }

        return { node, score: baseScore + boost };
    });

    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, maxNodes);
}

export function formatDossierBlock(dossier: CompanyDossier | null): string {
    if (!dossier) return '';
    return JSON.stringify(dossier);
}

export function formatContextBlock(scoredNodes: ScoredNode[], maxNodes: number = 6): string {
    return scoredNodes
        .slice(0, maxNodes)
        .map(sn => sn.node.text_content)
        .filter(Boolean)
        .join('\n');
}
