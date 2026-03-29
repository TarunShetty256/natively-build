import { DocType, StructuredJD, StructuredResume } from './types';

type JsonValue = Record<string, any> | any[];

function extractJsonPayload(raw: string): string {
    let text = raw.trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        text = fenced[1].trim();
    }
    text = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return text.slice(firstBrace, lastBrace + 1);
    }
    return text;
}

function parseJson(raw: string): JsonValue {
    const cleaned = extractJsonPayload(raw);
    return JSON.parse(cleaned) as JsonValue;
}

function toString(value: any): string {
    return typeof value === 'string' ? value.trim() : '';
}

function toStringArray(value: any): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => toString(item)).filter(Boolean);
}

function normalizeCompanyCandidate(value: string): string {
    const cleaned = value.trim().replace(/^[\-–•\s]+/, '').replace(/[\s,;:.]+$/, '');
    if (!cleaned) return '';
    if (cleaned.length > 80) return '';
    const lower = cleaned.toLowerCase();
    if (lower.includes('job description') || lower.includes('responsibilities')) return '';
    return cleaned;
}

function normalizeTitleCandidate(value: string): string {
    const cleaned = value.trim().replace(/^[\-–•\s]+/, '').replace(/[\s,;:.]+$/, '');
    if (!cleaned) return '';
    if (cleaned.length > 120) return '';
    const lower = cleaned.toLowerCase();
    if (lower.includes('job description') || lower.includes('responsibilities')) return '';
    return cleaned;
}

function normalizeLocationCandidate(value: string): string {
    const cleaned = value.trim().replace(/^[\-–•\s]+/, '').replace(/[\s,;:.]+$/, '');
    if (!cleaned) return '';
    if (cleaned.length > 120) return '';
    return cleaned;
}

function inferCompanyFromText(rawText: string): string {
    const lines = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const scanLines = lines.slice(0, 40);
    const directPatterns = [
        /^(?:company|employer|organization|about)\s*[:\-]\s*(.+)$/i,
        /^about\s+(.+)$/i,
        /^at\s+(.+)$/i,
    ];

    for (const line of scanLines) {
        for (const pattern of directPatterns) {
            const match = line.match(pattern);
            if (match?.[1]) {
                const candidate = normalizeCompanyCandidate(match[1]);
                if (candidate) return candidate;
            }
        }
    }

    const inlineMatch = rawText.match(/\b(?:at|@)\s+([A-Z][A-Za-z0-9&.,'\-\s]{2,60})/);
    if (inlineMatch?.[1]) {
        const candidate = normalizeCompanyCandidate(inlineMatch[1]);
        if (candidate) return candidate;
    }

    return '';
}

function inferTitleFromText(rawText: string): string {
    const lines = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const scanLines = lines.slice(0, 40);
    const directPatterns = [
        /^(?:title|role|position|job title)\s*[:\-]\s*(.+)$/i,
        /^(?:we are hiring|hiring for|seeking|looking for)\s+(.+)$/i
    ];

    for (const line of scanLines) {
        for (const pattern of directPatterns) {
            const match = line.match(pattern);
            if (match?.[1]) {
                const candidate = normalizeTitleCandidate(match[1]);
                if (candidate) return candidate;
            }
        }
    }

    return '';
}

function inferLocationFromText(rawText: string): string {
    const lines = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const scanLines = lines.slice(0, 50);
    const directPatterns = [
        /^(?:location)\s*[:\-]\s*(.+)$/i,
        /^(?:based in|location is)\s+(.+)$/i
    ];

    for (const line of scanLines) {
        for (const pattern of directPatterns) {
            const match = line.match(pattern);
            if (match?.[1]) {
                const candidate = normalizeLocationCandidate(match[1]);
                if (candidate) return candidate;
            }
        }
        if (/\bremote\b/i.test(line)) return 'Remote';
        if (/\bhybrid\b/i.test(line)) return 'Hybrid';
        if (/\bon[-\s]?site\b/i.test(line)) return 'On-site';
    }

    return '';
}

async function inferJDFieldsWithLLM(
    rawText: string,
    generateContentFn: (contents: any[]) => Promise<string>
): Promise<{ company: string; title: string; location: string }> {
    const prompt = [
        'You are extracting key fields from a job description.',
        'Return ONLY valid JSON. No markdown, no commentary.',
        'Schema:',
        '{ "company": "", "title": "", "location": "" }',
        'Rules:',
        '- If a field is not found, return empty string.',
        '- Do not guess. Use the JD text only.',
        'Job description text:',
        rawText.slice(0, 4000)
    ].join('\n');

    try {
        const rawResponse = await generateContentFn([{ text: prompt }]);
        const parsed = parseJson(rawResponse) as Record<string, any>;
        return {
            company: toString(parsed?.company),
            title: toString(parsed?.title),
            location: toString(parsed?.location)
        };
    } catch {
        return { company: '', title: '', location: '' };
    }
}

function normalizeResume(data: any): StructuredResume {
    const identity = data?.identity ?? {};
    const experience = Array.isArray(data?.experience) ? data.experience : [];
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    const education = Array.isArray(data?.education) ? data.education : [];
    const achievements = Array.isArray(data?.achievements) ? data.achievements : [];
    const certifications = Array.isArray(data?.certifications) ? data.certifications : [];
    const leadership = Array.isArray(data?.leadership) ? data.leadership : [];

    return {
        identity: {
            name: toString(identity.name),
            email: toString(identity.email),
            phone: toString(identity.phone),
            location: toString(identity.location),
            linkedin: toString(identity.linkedin),
            github: toString(identity.github),
            website: toString(identity.website),
            summary: toString(identity.summary),
        },
        skills: toStringArray(data?.skills),
        experience: experience.map((item: any) => ({
            company: toString(item?.company),
            role: toString(item?.role),
            start_date: toString(item?.start_date),
            end_date: item?.end_date === null ? null : toString(item?.end_date) || null,
            bullets: toStringArray(item?.bullets),
        })),
        projects: projects.map((item: any) => ({
            name: toString(item?.name),
            description: toString(item?.description),
            technologies: toStringArray(item?.technologies),
            url: toString(item?.url),
        })),
        education: education.map((item: any) => ({
            institution: toString(item?.institution),
            degree: toString(item?.degree),
            field: toString(item?.field),
            start_date: toString(item?.start_date),
            end_date: item?.end_date === null ? null : toString(item?.end_date) || null,
            gpa: toString(item?.gpa),
        })),
        achievements: achievements.map((item: any) => ({
            title: toString(item?.title),
            description: toString(item?.description),
            date: toString(item?.date),
        })),
        certifications: certifications.map((item: any) => ({
            name: toString(item?.name),
            issuer: toString(item?.issuer),
            date: toString(item?.date),
        })),
        leadership: leadership.map((item: any) => ({
            role: toString(item?.role),
            organization: toString(item?.organization),
            description: toString(item?.description),
        })),
    };
}

function normalizeJD(data: any): StructuredJD {
    const levelRaw = toString(data?.level);
    const employmentRaw = toString(data?.employment_type);
    const level = (['intern', 'entry', 'mid', 'senior', 'staff', 'principal'] as const).includes(levelRaw as any)
        ? (levelRaw as StructuredJD['level'])
        : 'mid';
    const employment_type = (['full_time', 'part_time', 'contract', 'internship'] as const).includes(employmentRaw as any)
        ? (employmentRaw as StructuredJD['employment_type'])
        : 'full_time';

    const minYears = Number.isFinite(Number(data?.min_years_experience))
        ? Number(data.min_years_experience)
        : 0;

    return {
        title: toString(data?.title),
        company: toString(data?.company),
        location: toString(data?.location),
        description_summary: toString(data?.description_summary),
        level,
        employment_type,
        min_years_experience: minYears,
        compensation_hint: toString(data?.compensation_hint),
        requirements: toStringArray(data?.requirements),
        nice_to_haves: toStringArray(data?.nice_to_haves),
        responsibilities: toStringArray(data?.responsibilities),
        technologies: toStringArray(data?.technologies),
        keywords: toStringArray(data?.keywords),
    };
}

function buildResumePrompt(rawText: string): string {
    return [
        'You are a resume parser.',
        'Return ONLY valid JSON. No markdown, no commentary.',
        'Schema:',
        '{',
        '  "identity": { "name": "", "email": "", "phone": "", "location": "", "linkedin": "", "github": "", "website": "", "summary": "" },',
        '  "skills": [""],',
        '  "experience": [{ "company": "", "role": "", "start_date": "YYYY-MM", "end_date": "YYYY-MM or null", "bullets": [""] }],',
        '  "projects": [{ "name": "", "description": "", "technologies": [""], "url": "" }],',
        '  "education": [{ "institution": "", "degree": "", "field": "", "start_date": "YYYY-MM", "end_date": "YYYY-MM or null", "gpa": "" }],',
        '  "achievements": [{ "title": "", "description": "", "date": "" }],',
        '  "certifications": [{ "name": "", "issuer": "", "date": "" }],',
        '  "leadership": [{ "role": "", "organization": "", "description": "" }]',
        '}',
        'Rules:',
        '- Use empty strings for unknown scalar fields, empty arrays for missing lists.',
        '- Convert dates to YYYY-MM when possible; otherwise use the original string.',
        '- Keep bullets concise.',
        'Resume text:',
        rawText
    ].join('\n');
}

function buildJDPrompt(rawText: string): string {
    return [
        'You are a job description parser.',
        'Return ONLY valid JSON. No markdown, no commentary.',
        'Schema:',
        '{',
        '  "title": "",',
        '  "company": "",',
        '  "location": "",',
        '  "description_summary": "",',
        '  "level": "intern|entry|mid|senior|staff|principal",',
        '  "employment_type": "full_time|part_time|contract|internship",',
        '  "min_years_experience": 0,',
        '  "compensation_hint": "",',
        '  "requirements": [""],',
        '  "nice_to_haves": [""],',
        '  "responsibilities": [""],',
        '  "technologies": [""],',
        '  "keywords": [""]',
        '}',
        'Rules:',
        '- Use empty strings for unknown scalar fields, empty arrays for missing lists.',
        '- If level/employment type is not specified, use "mid" and "full_time".',
        '- min_years_experience must be a number (0 if unknown).',
        'Job description text:',
        rawText
    ].join('\n');
}

export async function extractStructuredData<T>(
    _rawText: string,
    _type: DocType,
    _generateContentFn: (contents: any[]) => Promise<string>
): Promise<T> {
    const rawText = _rawText || '';
    if (!rawText.trim()) {
        throw new Error('No text extracted from the document.');
    }

    const prompt = _type === DocType.JD
        ? buildJDPrompt(rawText)
        : buildResumePrompt(rawText);

    const rawResponse = await _generateContentFn([{ text: prompt }]);
    try {
        const parsed = parseJson(rawResponse);
        if (_type === DocType.JD) {
            let normalized = normalizeJD(parsed);
            const inferredCompany = normalized.company || inferCompanyFromText(rawText);
            const inferredTitle = normalized.title || inferTitleFromText(rawText);
            const inferredLocation = normalized.location || inferLocationFromText(rawText);

            normalized = {
                ...normalized,
                company: inferredCompany || normalized.company,
                title: inferredTitle || normalized.title,
                location: inferredLocation || normalized.location,
            };

            if (!normalized.company || !normalized.title || !normalized.location) {
                const llmFields = await inferJDFieldsWithLLM(rawText, _generateContentFn);
                normalized = {
                    ...normalized,
                    company: normalized.company || llmFields.company,
                    title: normalized.title || llmFields.title,
                    location: normalized.location || llmFields.location,
                };
            }
            return normalized as unknown as T;
        }
        return normalizeResume(parsed) as unknown as T;
    } catch (error: any) {
        console.error('[StructuredExtractor] Failed to parse structured JSON:', error?.message || error);
        throw new Error('Structured extraction failed.');
    }
}
