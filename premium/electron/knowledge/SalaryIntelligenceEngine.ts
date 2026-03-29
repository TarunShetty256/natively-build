import { ResumeSalaryEstimate, StructuredResume } from './types';

export class SalaryIntelligenceEngine {
    private cached: ResumeSalaryEstimate | null = null;

    public async estimateFromResume(
        resume: StructuredResume,
        _totalExperienceYears: number,
        _generateContentFn: (contents: any[]) => Promise<string>
    ): Promise<ResumeSalaryEstimate> {
        const fallback: ResumeSalaryEstimate = {
            role: resume.experience?.[0]?.role || 'Unknown',
            location: resume.identity.location || '',
            currency: 'USD',
            min: 0,
            max: 0,
            confidence: 'low',
            justification_factors: [],
            estimated_at: new Date().toISOString()
        };

        const prompt = [
            'You are estimating a salary range from a resume summary.',
            'Return ONLY valid JSON. No markdown, no commentary.',
            'Schema:',
            '{',
            '  "role": "",',
            '  "location": "",',
            '  "currency": "USD",',
            '  "min": 0,',
            '  "max": 0,',
            '  "confidence": "low|medium|high",',
            '  "justification_factors": [""]',
            '}',
            `Candidate Role: ${fallback.role}`,
            `Location: ${fallback.location}`,
            `Skills: ${(resume.skills || []).slice(0, 10).join(', ')}`,
            `Experience: ${(resume.experience || []).slice(0, 3).map(e => `${e.role} at ${e.company}`).join('; ')}`,
            'Rules:',
            '- Ensure min < max and both are positive numbers.',
            '- If uncertain, set confidence to low.'
        ].join('\n');

        try {
            const raw = await _generateContentFn([{ text: prompt }]);
            const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);
            const min = Number(parsed?.min);
            const max = Number(parsed?.max);
            const currency = typeof parsed?.currency === 'string' ? parsed.currency.trim() : 'USD';
            const confidence = parsed?.confidence || 'low';
            const justifications = Array.isArray(parsed?.justification_factors)
                ? parsed.justification_factors.map((j: any) => typeof j === 'string' ? j.trim() : '').filter(Boolean)
                : [];

            if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || min >= max) {
                this.cached = fallback;
                return fallback;
            }

            const estimate: ResumeSalaryEstimate = {
                role: typeof parsed?.role === 'string' && parsed.role.trim() ? parsed.role.trim() : fallback.role,
                location: typeof parsed?.location === 'string' ? parsed.location.trim() : fallback.location,
                currency,
                min,
                max,
                confidence,
                justification_factors: justifications,
                estimated_at: new Date().toISOString()
            };
            this.cached = estimate;
            return estimate;
        } catch {
            this.cached = fallback;
            return fallback;
        }
    }

    public getCachedEstimate(): ResumeSalaryEstimate | null {
        return this.cached;
    }

    public clearCache(): void {
        this.cached = null;
    }

    public static buildSalaryContextBlock(
        resumeEstimate: ResumeSalaryEstimate | null,
        negotiationScript: { salary_range?: { min: number; max: number; currency: string; confidence: string } } | null,
        _isJDMode: boolean
    ): string {
        if (!resumeEstimate && !negotiationScript) return '';
        const range = negotiationScript?.salary_range
            ? `${negotiationScript.salary_range.currency} ${negotiationScript.salary_range.min}-${negotiationScript.salary_range.max}`
            : resumeEstimate
            ? `${resumeEstimate.currency} ${resumeEstimate.min}-${resumeEstimate.max}`
            : '';
        return range ? `<salary_intelligence>${range}</salary_intelligence>` : '';
    }
}
