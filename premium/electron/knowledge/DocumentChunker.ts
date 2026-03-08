// electron/knowledge/DocumentChunker.ts
// Converts structured data into atomic ContextNodes with optional embeddings

import { DocType, StructuredResume, StructuredJD, ContextNode } from './types';

/**
 * Calculate duration in months between two YYYY-MM dates.
 */
export function calculateDurationMonths(startDate: string | null, endDate: string | null): number {
    if (!startDate) return 0;
    try {
        const [startYear, startMonth] = startDate.split('-').map(Number);
        let endYear: number, endMonth: number;
        if (endDate) {
            [endYear, endMonth] = endDate.split('-').map(Number);
        } else {
            const now = new Date();
            endYear = now.getFullYear();
            endMonth = now.getMonth() + 1;
        }
        const months = (endYear - startYear) * 12 + (endMonth - startMonth);
        return Math.max(0, months);
    } catch {
        return 0;
    }
}

/**
 * Extract keyword tags from a text string.
 */
export function extractTags(text: string): string[] {
    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s\-\.\/\+\#]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2);

    const bigrams: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
        bigrams.push(`${words[i]} ${words[i + 1]}`);
    }
    return [...new Set([...words, ...bigrams])];
}

/**
 * Convert structured data into generic ContextNodes.
 */
export function createDocumentNodes(structuredData: any, type: DocType): Omit<ContextNode, 'embedding'>[] {
    const nodes: Omit<ContextNode, 'embedding'>[] = [];

    if (type === DocType.RESUME) {
        const resume = structuredData as StructuredResume;

        // Experience bullets
        if (resume.experience) {
            for (const exp of resume.experience) {
                const duration = calculateDurationMonths(exp.start_date, exp.end_date);
                const contextPrefix = `[${exp.role} @ ${exp.company}, ${exp.start_date}–${exp.end_date || 'Present'}]`;
                for (const bullet of exp.bullets) {
                    nodes.push({
                        source_type: DocType.RESUME,
                        category: 'experience',
                        title: exp.role,
                        organization: exp.company,
                        start_date: exp.start_date,
                        end_date: exp.end_date,
                        duration_months: duration,
                        text_content: `${contextPrefix} ${bullet}`,
                        tags: extractTags(`${exp.role} ${exp.company} ${bullet}`)
                    });
                }
            }
        }

        // Projects
        if (resume.projects) {
            for (const project of resume.projects) {
                const text = `${project.name}: ${project.description}. Technologies: ${project.technologies.join(', ')}`;
                nodes.push({
                    source_type: DocType.RESUME,
                    category: 'project',
                    title: project.name,
                    text_content: text,
                    tags: extractTags(`${project.name} ${project.description} ${project.technologies.join(' ')}`)
                });
            }
        }

        // Education
        if (resume.education) {
            for (const edu of resume.education) {
                const duration = calculateDurationMonths(edu.start_date, edu.end_date);
                const text = `${edu.degree} in ${edu.field} from ${edu.institution}${edu.gpa ? ` (GPA: ${edu.gpa})` : ''}`;
                nodes.push({
                    source_type: DocType.RESUME,
                    category: 'education',
                    title: `${edu.degree} in ${edu.field}`,
                    organization: edu.institution,
                    start_date: edu.start_date,
                    end_date: edu.end_date,
                    duration_months: duration,
                    text_content: text,
                    tags: extractTags(`${edu.degree} ${edu.field} ${edu.institution}`)
                });
            }
        }

        // Achievements and others...
        if (resume.achievements) {
            for (const achievement of resume.achievements) {
                nodes.push({
                    source_type: DocType.RESUME,
                    category: 'achievement',
                    title: achievement.title,
                    start_date: achievement.date || null,
                    text_content: `${achievement.title}: ${achievement.description}`,
                    tags: extractTags(`${achievement.title} ${achievement.description}`)
                });
            }
        }
    }
    else if (type === DocType.JD) {
        const jd = structuredData as StructuredJD;
        const levelTag = jd.level ? `level:${jd.level}` : '';

        // Requirements
        if (jd.requirements) {
            for (const req of jd.requirements) {
                nodes.push({
                    source_type: DocType.JD,
                    category: 'requirement',
                    title: 'Required Skill',
                    organization: jd.company,
                    text_content: req,
                    tags: [...extractTags(req), ...(levelTag ? [levelTag] : [])]
                });
            }
        }

        // Nice to haves
        if (jd.nice_to_haves) {
            for (const nice of jd.nice_to_haves) {
                nodes.push({
                    source_type: DocType.JD,
                    category: 'nice_to_have',
                    title: 'Nice to Have',
                    organization: jd.company,
                    text_content: nice,
                    tags: extractTags(nice)
                });
            }
        }

        // Responsibilities
        if (jd.responsibilities) {
            for (const resp of jd.responsibilities) {
                nodes.push({
                    source_type: DocType.JD,
                    category: 'responsibility',
                    title: 'Job Responsibility',
                    organization: jd.company,
                    text_content: resp,
                    tags: extractTags(resp)
                });
            }
        }

        // Keywords (new)
        if (jd.keywords) {
            for (const keyword of jd.keywords) {
                nodes.push({
                    source_type: DocType.JD,
                    category: 'keyword',
                    title: 'Job Keyword',
                    organization: jd.company,
                    text_content: keyword,
                    tags: [keyword.toLowerCase(), ...(levelTag ? [levelTag] : [])]
                });
            }
        }
    }

    console.log(`[DocumentChunker] Created ${nodes.length} atomic nodes for ${type}`);
    return nodes;
}

/**
 * Generate embeddings for all nodes.
 */
export async function chunkAndEmbedDocument(
    structuredData: any,
    type: DocType,
    embedFn: (text: string) => Promise<number[]>
): Promise<ContextNode[]> {
    const rawNodes = createDocumentNodes(structuredData, type);
    const nodesWithEmbeddings: ContextNode[] = [];

    console.log(`[DocumentChunker] Generating embeddings for ${rawNodes.length} nodes (batched)...`);

    const EMBED_BATCH_SIZE = 10;
    for (let i = 0; i < rawNodes.length; i += EMBED_BATCH_SIZE) {
        const batch = rawNodes.slice(i, i + EMBED_BATCH_SIZE);

        const results = await Promise.allSettled(
            batch.map(node => embedFn(node.text_content))
        );

        for (let j = 0; j < batch.length; j++) {
            const result = results[j];
            nodesWithEmbeddings.push({
                ...batch[j],
                embedding: result.status === 'fulfilled' ? result.value : undefined
            });
            if (result.status === 'rejected') {
                console.warn(`[DocumentChunker] Failed to embed node ${i + j}: ${(result.reason as Error)?.message}. Skipping embedding.`);
            }
        }

        console.log(`[DocumentChunker] Embedded batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1}/${Math.ceil(rawNodes.length / EMBED_BATCH_SIZE)} (${Math.min(i + EMBED_BATCH_SIZE, rawNodes.length)}/${rawNodes.length})`);

        // Small delay between batches to avoid rate limiting
        if (i + EMBED_BATCH_SIZE < rawNodes.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    return nodesWithEmbeddings;
}
