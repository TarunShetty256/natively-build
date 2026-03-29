import { CompanyDossier, StructuredJD } from './types';

type SearchResult = {
    title: string;
    url: string;
    content: string;
};

type SearchProvider = {
    search: (query: string, options?: { maxResults?: number; searchDepth?: 'basic' | 'advanced' }) => Promise<SearchResult[]>;
};

export function jdContextFromStructured(jd: StructuredJD): Record<string, any> {
    return {
        title: jd.title,
        company: jd.company,
        location: jd.location,
        level: jd.level,
        technologies: jd.technologies,
        requirements: jd.requirements,
        keywords: jd.keywords,
        compensation_hint: jd.compensation_hint,
        min_years_experience: jd.min_years_experience,
        employment_type: jd.employment_type
    };
}

export class CompanyResearchEngine {
    private cached = new Map<string, CompanyDossier>();
    private generateContentFn: ((contents: any[]) => Promise<string>) | null = null;
    private searchProvider: SearchProvider | null = null;

    public constructor(_db?: any) {}

    public setGenerateContentFn(fn: (contents: any[]) => Promise<string>): void {
        this.generateContentFn = fn;
    }

    public setSearchProvider(provider: SearchProvider | null): void {
        this.searchProvider = provider;
    }

    public getCachedDossier(company: string): CompanyDossier | null {
        return this.cached.get(company.toLowerCase()) ?? null;
    }

    private buildDefaultDossier(company: string): CompanyDossier {
        return {
            company,
            hiring_strategy: '',
            interview_focus: '',
            salary_estimates: [],
            competitors: [],
            recent_news: '',
            sources: [],
            fetched_at: new Date().toISOString()
        };
    }

    private extractJsonPayload(raw: string): string {
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

    private parseJson(raw: string): any {
        const cleaned = this.extractJsonPayload(raw);
        return JSON.parse(cleaned);
    }

    private toString(value: any): string {
        return typeof value === 'string' ? value.trim() : '';
    }

    private toStringArray(value: any): string[] {
        if (!Array.isArray(value)) return [];
        return value.map(v => this.toString(v)).filter(Boolean);
    }

    private toNumber(value: any): number {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    private normalizeDossier(company: string, data: any): CompanyDossier {
        const salaryEstimates = Array.isArray(data?.salary_estimates) ? data.salary_estimates : [];
        return {
            company: this.toString(data?.company) || company,
            hiring_strategy: this.toString(data?.hiring_strategy),
            interview_focus: this.toString(data?.interview_focus),
            interview_difficulty: data?.interview_difficulty,
            core_values: this.toStringArray(data?.core_values),
            salary_estimates: salaryEstimates.map((s: any) => ({
                title: this.toString(s?.title),
                location: this.toString(s?.location),
                min: this.toNumber(s?.min),
                max: this.toNumber(s?.max),
                currency: this.toString(s?.currency) || 'USD',
                source: this.toString(s?.source),
                confidence: s?.confidence || 'low'
            })).filter((s: any) => s.title || s.min || s.max),
            culture_ratings: data?.culture_ratings,
            employee_reviews: Array.isArray(data?.employee_reviews) ? data.employee_reviews : [],
            critics: Array.isArray(data?.critics) ? data.critics : [],
            benefits: this.toStringArray(data?.benefits),
            competitors: this.toStringArray(data?.competitors),
            recent_news: this.toString(data?.recent_news),
            sources: this.toStringArray(data?.sources),
            fetched_at: this.toString(data?.fetched_at) || new Date().toISOString()
        };
    }

    private buildSearchQueries(company: string, jdContext?: Record<string, any>): string[] {
        const title = this.toString(jdContext?.title);
        const location = this.toString(jdContext?.location);

        return [
            `${company} company overview business model`,
            `${company} interview process hiring`,
            `${company} ${title || 'software engineer'} compensation range ${location}`.trim(),
            `${company} culture values mission`,
            `${company} recent news`
        ];
    }

    public async researchCompany(
        company: string,
        jdContext?: Record<string, any>,
        force?: boolean
    ): Promise<CompanyDossier> {
        const normalizedCompany = this.toString(company);
        if (!normalizedCompany) return this.buildDefaultDossier('');

        const cacheKey = normalizedCompany.toLowerCase();
        if (!force && this.cached.has(cacheKey)) {
            return this.cached.get(cacheKey)!;
        }

        let sources: SearchResult[] = [];
        if (this.searchProvider) {
            const queries = this.buildSearchQueries(normalizedCompany, jdContext);
            for (const query of queries) {
                try {
                    const results = await this.searchProvider.search(query, { maxResults: 4, searchDepth: 'basic' });
                    sources.push(...results);
                } catch (error: any) {
                    console.warn('[CompanyResearch] Search provider failed:', error?.message || error);
                }
            }
        }

        const uniqueSources = new Map<string, SearchResult>();
        for (const result of sources) {
            if (!result.url && !result.content) continue;
            const key = result.url || result.title;
            if (!uniqueSources.has(key)) uniqueSources.set(key, result);
        }
        const sourceList = Array.from(uniqueSources.values()).slice(0, 10);
        const hasSources = sourceList.length > 0;

        if (!this.generateContentFn) {
            const fallback = this.buildDefaultDossier(normalizedCompany);
            fallback.sources = sourceList.map(s => s.url || s.title).filter(Boolean);
            this.cached.set(cacheKey, fallback);
            return fallback;
        }

        const sourceBlock = sourceList.map((s, idx) => {
            const snippet = s.content ? s.content.slice(0, 400).replace(/\s+/g, ' ').trim() : '';
            return `Source ${idx + 1}:\nTitle: ${s.title}\nURL: ${s.url}\nSnippet: ${snippet}`;
        }).join('\n\n');

        const sourcePolicy = hasSources
            ? 'Use ONLY the sources provided. If data is missing, use empty strings or empty arrays and keep confidence low.'
            : 'No sources are provided. Use general knowledge to give rough estimates. Mark confidence low and set sources to ["general knowledge"].';

        const prompt = [
            'You are compiling company research for interview preparation.',
            'Return ONLY valid JSON. No markdown, no commentary.',
            sourcePolicy,
            'Schema:',
            '{',
            '  "company": "",',
            '  "hiring_strategy": "",',
            '  "interview_focus": "",',
            '  "interview_difficulty": "easy|medium|hard|very_hard",',
            '  "core_values": [""],',
            '  "salary_estimates": [{ "title": "", "location": "", "min": 0, "max": 0, "currency": "USD", "source": "", "confidence": "low|medium|high" }],',
            '  "culture_ratings": { "overall": 0, "work_life_balance": 0, "career_growth": 0, "compensation": 0, "management": 0, "diversity": 0, "review_count": "", "data_sources": [""] },',
            '  "employee_reviews": [{ "quote": "", "sentiment": "positive|mixed|negative", "source": "", "role": "" }],',
            '  "critics": [{ "category": "", "complaint": "", "frequency": "occasionally|frequently|widespread" }],',
            '  "benefits": [""],',
            '  "competitors": [""],',
            '  "recent_news": "",',
            '  "sources": [""],',
            '  "fetched_at": ""',
            '}',
            `Company: ${normalizedCompany}`,
            `Job Context: ${JSON.stringify(jdContext || {})}`,
            'Sources:',
            sourceBlock || '(no sources provided)'
        ].join('\n');

        let dossier = this.buildDefaultDossier(normalizedCompany);
        try {
            const raw = await this.generateContentFn([{ text: prompt }]);
            const parsed = this.parseJson(raw);
            dossier = this.normalizeDossier(normalizedCompany, parsed);
        } catch (error: any) {
            console.warn('[CompanyResearch] Failed to build dossier:', error?.message || error);
        }

        if (!dossier.sources || dossier.sources.length === 0) {
            dossier.sources = sourceList.map(s => s.url || s.title).filter(Boolean);
        }
        if (!hasSources && (!dossier.sources || dossier.sources.length === 0)) {
            dossier.sources = ['general knowledge'];
        }
        dossier.fetched_at = new Date().toISOString();
        this.cached.set(cacheKey, dossier);
        return dossier;
    }
}
