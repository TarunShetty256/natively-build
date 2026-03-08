// electron/knowledge/StarStoryGenerator.ts
// Expands resume experience bullets into structured STAR stories during ingestion

import { StructuredResume, StarStory, ContextNode, DocType } from './types';
import { extractTags, calculateDurationMonths } from './DocumentChunker';
import { extractJSONArray, callWithTimeout } from './llmUtils';

const BATCH_SIZE = 5;

/**
 * Generate STAR stories for all experience bullets in a resume.
 * Batches bullets to minimize LLM calls.
 */
export async function generateStarStories(
    resume: StructuredResume,
    generateContentFn: (contents: any[]) => Promise<string>
): Promise<StarStory[]> {
    if (!resume.experience || resume.experience.length === 0) {
        console.log('[StarStoryGenerator] No experience entries to expand');
        return [];
    }

    // Collect all bullets with their context
    const bulletContexts: { bullet: string; role: string; company: string; timeline: string }[] = [];
    for (const exp of resume.experience) {
        const timeline = `${exp.start_date}–${exp.end_date || 'Present'}`;
        for (const bullet of exp.bullets) {
            bulletContexts.push({
                bullet,
                role: exp.role,
                company: exp.company,
                timeline
            });
        }
    }

    console.log(`[StarStoryGenerator] Expanding ${bulletContexts.length} bullets into STAR stories (batches of ${BATCH_SIZE})...`);

    const allStories: StarStory[] = [];

    // Process in batches
    for (let i = 0; i < bulletContexts.length; i += BATCH_SIZE) {
        const batch = bulletContexts.slice(i, i + BATCH_SIZE);
        try {
            const stories = await expandBatch(batch, generateContentFn);
            allStories.push(...stories);
            console.log(`[StarStoryGenerator] Expanded batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(bulletContexts.length / BATCH_SIZE)} (${stories.length} stories)`);
        } catch (error: any) {
            console.warn(`[StarStoryGenerator] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${error.message}. Skipping.`);
        }

        // Rate limit between batches
        if (i + BATCH_SIZE < bulletContexts.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    console.log(`[StarStoryGenerator] ✅ Generated ${allStories.length} STAR stories total`);
    return allStories;
}

/**
 * Expand a batch of bullets into STAR stories via a single LLM call.
 */
async function expandBatch(
    batch: { bullet: string; role: string; company: string; timeline: string }[],
    generateContentFn: (contents: any[]) => Promise<string>
): Promise<StarStory[]> {
    const bulletList = batch.map((b, i) =>
        `${i + 1}. [${b.role} @ ${b.company}, ${b.timeline}] "${b.bullet}"`
    ).join('\n');

    const prompt = `You are a career coach expanding resume bullets into STAR stories.

For each bullet below, generate a realistic, detailed STAR (Situation, Task, Action, Result) expansion.
IMPORTANT RULES:
- Base the story ONLY on what the bullet states. Do not fabricate technologies, companies, or outcomes not implied.
- The "full_narrative" should be a natural, first-person spoken answer (~80-120 words).
- Keep the tone confident and professional.
- If the bullet already contains metrics, preserve them exactly.

Bullets:
${bulletList}

Return a JSON array (no markdown fences, no explanation), one object per bullet:
[
  {
    "index": 1,
    "situation": "...",
    "task": "...",
    "action": "...",
    "result": "...",
    "full_narrative": "..."
  }
]

Return ONLY the JSON array.`;

    const response = await callWithTimeout(
        () => generateContentFn([{ text: prompt }]),
        30000
    );
    const parsed = extractJSONArray(response);

    return parsed.map((item, idx) => {
        const ctx = batch[idx]; // Trust array order, not LLM-reported index
        return {
            original_bullet: ctx.bullet,
            situation: item.situation || '',
            task: item.task || '',
            action: item.action || '',
            result: item.result || '',
            full_narrative: item.full_narrative || '',
            parent_role: ctx.role,
            parent_company: ctx.company,
            timeline: ctx.timeline
        };
    });
}

/**
 * Convert STAR stories into ContextNodes for storage and retrieval.
 */
export function starStoriesToNodes(
    stories: StarStory[],
    embedFn?: (text: string) => Promise<number[]>
): Omit<ContextNode, 'embedding'>[] {
    return stories.map(story => {
        const contextPrefix = `[${story.parent_role} @ ${story.parent_company}, ${story.timeline}]`;
        const text = `${contextPrefix} ${story.full_narrative}`;
        return {
            source_type: DocType.RESUME,
            category: 'star_story',
            title: `STAR: ${story.parent_role} at ${story.parent_company}`,
            organization: story.parent_company,
            text_content: text,
            parent_context: contextPrefix,
            tags: extractTags(`${story.parent_role} ${story.parent_company} ${story.original_bullet} star behavioral`)
        };
    });
}

/**
 * Generate STAR story nodes with embeddings.
 */
export async function generateStarStoryNodes(
    resume: StructuredResume,
    generateContentFn: (contents: any[]) => Promise<string>,
    embedFn: (text: string) => Promise<number[]>
): Promise<ContextNode[]> {
    const stories = await generateStarStories(resume, generateContentFn);
    const rawNodes = starStoriesToNodes(stories);

    console.log(`[StarStoryGenerator] Embedding ${rawNodes.length} STAR story nodes (batched)...`);

    const nodesWithEmbeddings: ContextNode[] = [];
    const EMBED_BATCH = 10;
    for (let i = 0; i < rawNodes.length; i += EMBED_BATCH) {
        const batch = rawNodes.slice(i, i + EMBED_BATCH);
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
                console.warn(`[StarStoryGenerator] Failed to embed STAR story ${i + j}: ${(result.reason as Error)?.message}`);
            }
        }
        if (i + EMBED_BATCH < rawNodes.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    return nodesWithEmbeddings;
}
