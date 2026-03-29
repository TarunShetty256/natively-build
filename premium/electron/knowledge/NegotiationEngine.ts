import { CompanyDossier, KnowledgeDocument, StructuredJD, StructuredResume } from './types';

export type NegotiationScript = {
    opening_line?: string;
    salary_range?: {
        min: number;
        max: number;
        currency: string;
        confidence: 'low' | 'medium' | 'high';
    };
};

export async function generateNegotiationScript(
    resumeDoc: KnowledgeDocument,
    jdDoc: KnowledgeDocument,
    dossier: CompanyDossier | null,
    generateContentFn: (contents: any[]) => Promise<string>
): Promise<NegotiationScript> {
    const fallback: NegotiationScript = {
        opening_line: 'I am excited to discuss the role and compensation.',
        salary_range: {
            min: 0,
            max: 0,
            currency: 'USD',
            confidence: 'low'
        }
    };

    const resume = resumeDoc.structured_data as StructuredResume;
    const jd = jdDoc.structured_data as StructuredJD;
    const resumeRole = resume.experience?.[0]?.role || 'Professional';
    const resumeCompany = resume.experience?.[0]?.company || '';
    const skills = (resume.skills || []).slice(0, 8).join(', ');
    const highlights = (resume.experience || []).slice(0, 3)
        .map(e => `${e.role} at ${e.company}: ${(e.bullets || []).slice(0, 2).join('; ')}`)
        .filter(Boolean)
        .join('\n');

    const marketRange = dossier?.salary_estimates?.[0]
        ? `${dossier.salary_estimates[0].currency} ${dossier.salary_estimates[0].min}-${dossier.salary_estimates[0].max} (${dossier.salary_estimates[0].source})`
        : '';

    const prompt = [
        'You are generating a salary negotiation script for a candidate.',
        'Return ONLY valid JSON. No markdown, no commentary.',
        'Schema:',
        '{',
        '  "opening_line": "",',
        '  "salary_range": { "min": 0, "max": 0, "currency": "USD", "confidence": "low|medium|high" }',
        '}',
        `Candidate: ${resumeRole}${resumeCompany ? ` at ${resumeCompany}` : ''}`,
        `Skills: ${skills}`,
        `Highlights: ${highlights || 'N/A'}`,
        `Target Role: ${jd.title} at ${jd.company}`,
        `Level: ${jd.level}`,
        `Location: ${jd.location}`,
        `JD Requirements: ${(jd.requirements || []).slice(0, 6).join(', ')}`,
        `Compensation Hint: ${jd.compensation_hint || ''}`,
        `Market Range: ${marketRange}`,
        'Rules:',
        '- If market range is unknown, infer a reasonable range based on role, level, and location and set confidence to low.',
        '- Ensure min < max and both are positive numbers.',
        '- Opening line should be one confident sentence.'
    ].join('\n');

    try {
        const raw = await generateContentFn([{ text: prompt }]);
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);
        const min = Number(parsed?.salary_range?.min);
        const max = Number(parsed?.salary_range?.max);
        const currency = typeof parsed?.salary_range?.currency === 'string'
            ? parsed.salary_range.currency.trim()
            : 'USD';
        const confidence = parsed?.salary_range?.confidence || 'low';

        if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || min >= max) {
            return fallback;
        }

        return {
            opening_line: typeof parsed?.opening_line === 'string' && parsed.opening_line.trim()
                ? parsed.opening_line.trim()
                : fallback.opening_line,
            salary_range: {
                min,
                max,
                currency,
                confidence
            }
        };
    } catch {
        return fallback;
    }
}
