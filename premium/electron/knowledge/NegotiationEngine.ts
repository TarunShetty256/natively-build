// electron/knowledge/NegotiationEngine.ts
// Generates negotiation scripts using resume achievements, JD context, and company salary data

import { KnowledgeDocument, StructuredResume, StructuredJD, CompanyDossier } from './types';

export interface NegotiationScript {
    opening_line: string;
    justification: string;
    counter_offer_fallback: string;
    salary_range: { min: number; max: number; currency: string; confidence: string } | null;
    sources: string[];
}

/**
 * Generate a negotiation script using LLM.
 */
export async function generateNegotiationScript(
    resumeDoc: KnowledgeDocument,
    jdDoc: KnowledgeDocument | null,
    dossier: CompanyDossier | null,
    generateContentFn: (contents: any[]) => Promise<string>
): Promise<NegotiationScript | null> {
    const resume = resumeDoc.structured_data as StructuredResume;
    const name = resume.identity.name;

    // Build resume highlights
    const topExperience = resume.experience?.slice(0, 3).map(e =>
        `${e.role} at ${e.company} (${e.bullets?.slice(0, 2).join('; ')})`
    ).join('\n') || 'No experience data';

    const topSkills = resume.skills?.slice(0, 8).join(', ') || 'Not specified';

    // Build JD context
    let jdContext = '';
    if (jdDoc) {
        const jd = jdDoc.structured_data as StructuredJD;
        jdContext = `Target Role: ${jd.title} at ${jd.company} (${jd.level || 'mid'}-level, ${jd.location || 'unspecified location'})`;
    }

    // Build salary context
    let salaryContext = 'No salary data available.';
    let salaryRange: NegotiationScript['salary_range'] = null;
    const sources: string[] = [];

    if (dossier?.salary_estimates && dossier.salary_estimates.length > 0) {
        const estimates = dossier.salary_estimates;
        const avgMin = Math.round(estimates.reduce((s, e) => s + e.min, 0) / estimates.length);
        const avgMax = Math.round(estimates.reduce((s, e) => s + e.max, 0) / estimates.length);
        const currency = estimates[0].currency || 'USD';
        const avgConfidence = estimates[0].confidence || 'low';

        salaryRange = { min: avgMin, max: avgMax, currency, confidence: avgConfidence };
        salaryContext = `Market data indicates compensation of ~${currency} ${avgMin.toLocaleString()}-${avgMax.toLocaleString()} (confidence: ${avgConfidence})`;
        sources.push(...estimates.filter(e => e.source).map(e => e.source));
    }

    const prompt = `You are a career negotiation coach. Generate a negotiation script for ${name}.

Resume Highlights:
${topExperience}
Top Skills: ${topSkills}

${jdContext}

${salaryContext}

Generate EXACTLY this JSON (no markdown, no fences):
{
  "opening_line": "2 sentences: what to say when the recruiter asks about expected salary",
  "justification": "1 paragraph linking 3 specific resume achievements to justify the ask",
  "counter_offer_fallback": "2 sentences: what to say if employer counters with a lower offer"
}

Rules:
- Use first person, confident but professional tone.
- Reference REAL achievements from the resume.
- If salary data is available, anchor the opening to the upper range.
- DO NOT fabricate achievements.
- Return JSON only.`;

    try {
        const response = await generateContentFn([{ text: prompt }]);
        let cleaned = response.trim();
        if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
        if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
        if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);

        const parsed = JSON.parse(cleaned.trim());

        return {
            opening_line: parsed.opening_line || '',
            justification: parsed.justification || '',
            counter_offer_fallback: parsed.counter_offer_fallback || '',
            salary_range: salaryRange,
            sources: [...new Set(sources)]
        };
    } catch (error: any) {
        console.error('[NegotiationEngine] Failed to generate script:', error.message);
        return null;
    }
}
