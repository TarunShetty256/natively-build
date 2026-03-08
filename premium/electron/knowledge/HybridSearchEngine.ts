import { ContextNode, ScoredNode, DocType, CompanyDossier } from './types';

const RELEVANCE_THRESHOLD = 0.55;
const MAX_NODES = 4; // Increased slightly as we might draw from multiple sources

/**
 * Check if a node's end_date is recent (within 2 years of now).
 */
function isRecent(endDate: string | null): boolean {
    if (!endDate) return true; // Ongoing = recent
    try {
        const [year, month] = endDate.split('-').map(Number);
        const endMs = new Date(year, month - 1).getTime();
        const twoYearsAgo = Date.now() - (2 * 365.25 * 24 * 60 * 60 * 1000);
        return endMs >= twoYearsAgo;
    } catch {
        return false;
    }
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Extract keywords from a question for tag matching.
 */
function extractKeywords(question: string): string[] {
    return question.toLowerCase()
        .replace(/[^a-z0-9\s\-\.\/\+\#]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2);
}

/**
 * Score a single node against a question.
 * Returns a composite score between 0 and 1.
 */
function scoreNode(
    node: ContextNode,
    questionEmbedding: number[],
    keywords: string[],
    jdRequiredSkills?: string[]
): number {
    let score = 0;

    // 60% — Semantic similarity
    if (node.embedding && questionEmbedding.length > 0) {
        score += cosineSimilarity(node.embedding, questionEmbedding) * 0.6;
    }

    // 20% — Tag/keyword match
    if (keywords.some(k => node.tags.some(t => t.includes(k)))) {
        score += 0.2;
    }

    // 10% — Duration boost (if experience > 12 months)
    if (node.duration_months && node.duration_months > 12) {
        score += 0.1;
    }

    // 10% — Recency boost
    if (isRecent(node.end_date || null)) {
        score += 0.1;
    }

    // JD required skill boost: if this resume node matches a JD required skill, boost it
    if (jdRequiredSkills && jdRequiredSkills.length > 0 && node.source_type === DocType.RESUME) {
        const nodeText = node.text_content.toLowerCase();
        const nodeTags = node.tags.map(t => t.toLowerCase());
        for (const skill of jdRequiredSkills) {
            const skillLower = skill.toLowerCase();
            if (nodeText.includes(skillLower) || nodeTags.some(t => t.includes(skillLower))) {
                score += 0.15;
                break; // Only boost once per node
            }
        }
    }

    return score;
}

/**
 * Options for retrieval
 */
export interface SearchOptions {
    sourceTypes?: DocType[]; // Only retrieve nodes from these sources
    maxNodes?: number;
    threshold?: number;
    jdRequiredSkills?: string[]; // JD skills for boosting resume node relevance
}

/**
 * Get the most relevant nodes for a given question.
 */
export async function getRelevantNodes(
    question: string,
    allNodes: ContextNode[],
    embedFn: (text: string) => Promise<number[]>,
    options: SearchOptions = {}
): Promise<ScoredNode[]> {
    const threshold = options.threshold || RELEVANCE_THRESHOLD;
    const maxNodes = options.maxNodes || MAX_NODES;

    let targetNodes = allNodes;
    if (options.sourceTypes && options.sourceTypes.length > 0) {
        targetNodes = allNodes.filter(n => options.sourceTypes!.includes(n.source_type));
    }

    if (targetNodes.length === 0) {
        return [];
    }

    // Generate embedding for the question
    let questionEmbedding: number[] = [];
    try {
        questionEmbedding = await embedFn(question);
    } catch (error: any) {
        console.warn('[HybridSearchEngine] Failed to embed question, falling back to keyword-only:', error.message);
    }

    const keywords = extractKeywords(question);

    // Score all nodes
    const scored: ScoredNode[] = targetNodes
        .map(node => ({
            node,
            score: scoreNode(node, questionEmbedding, keywords, options.jdRequiredSkills)
        }))
        .filter(n => n.score > threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxNodes);

    if (scored.length > 0) {
        console.log(`[HybridSearchEngine] Found ${scored.length} relevant nodes (top score: ${scored[0].score.toFixed(3)})`);
    } else {
        console.log(`[HybridSearchEngine] No nodes above relevance threshold (${threshold}) — no injection`);
    }

    return scored;
}

/**
 * Format relevant nodes into an explicit context block, grouping by source.
 */
export function formatContextBlock(scoredNodes: ScoredNode[]): string {
    if (scoredNodes.length === 0) return '';

    const resumeNodes = scoredNodes.filter(sn => sn.node.source_type === DocType.RESUME);
    const jdNodes = scoredNodes.filter(sn => sn.node.source_type === DocType.JD);

    let blocks: string[] = [];

    if (resumeNodes.length > 0) {
        const resumeLines = resumeNodes.map((sn, i) => {
            const prefix = sn.node.category === 'experience' ? `[${sn.node.title} at ${sn.node.organization}]`
                : sn.node.category === 'project' ? `[Project: ${sn.node.title}]`
                    : sn.node.category === 'education' ? `[Education: ${sn.node.title}]`
                        : `[${sn.node.category}: ${sn.node.title}]`;
            return `${i + 1}. ${prefix} ${sn.node.text_content}`;
        });
        blocks.push(`<candidate_experience>\n${resumeLines.join('\n')}\n</candidate_experience>`);
    }

    if (jdNodes.length > 0) {
        const jdLines = jdNodes.map((sn, i) => {
            return `${i + 1}. [${sn.node.category}] ${sn.node.text_content}`;
        });
        blocks.push(`<target_job_context>\n${jdLines.join('\n')}\n</target_job_context>`);
    }

    return blocks.join('\n\n');
}

/**
 * Format a company dossier into a context block for injection.
 */
export function formatDossierBlock(dossier: CompanyDossier | null): string {
    if (!dossier) return '';

    const lines: string[] = [];
    lines.push(`Company: ${dossier.company}`);

    if (dossier.hiring_strategy) {
        lines.push(`Hiring Strategy: ${dossier.hiring_strategy}`);
    }
    if (dossier.interview_focus) {
        lines.push(`Interview Focus: ${dossier.interview_focus}`);
    }
    if (dossier.salary_estimates && dossier.salary_estimates.length > 0) {
        const salaryLines = dossier.salary_estimates.map(s =>
            `  - ${s.title} in ${s.location}: ${s.currency} ${s.min.toLocaleString()}-${s.max.toLocaleString()} (confidence: ${s.confidence}, source: ${s.source || 'general knowledge'})`
        );
        lines.push(`Salary Estimates:\n${salaryLines.join('\n')}`);
    }
    if (dossier.competitors && dossier.competitors.length > 0) {
        lines.push(`Competitors: ${dossier.competitors.join(', ')}`);
    }
    if (dossier.recent_news) {
        lines.push(`Recent News: ${dossier.recent_news}`);
    }
    if (dossier.sources && dossier.sources.length > 0) {
        lines.push(`Sources: ${dossier.sources.join(', ')}`);
    }

    return `<company_research>\n${lines.join('\n')}\n</company_research>`;
}

