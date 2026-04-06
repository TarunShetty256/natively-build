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

    private clampRating(value: any): number {
        const n = this.toNumber(value);
        if (n <= 0) return 0;
        if (n > 5) return 5;
        return Math.round(n * 10) / 10;
    }

    private normalizeCultureRatings(value: any, fallbackSources: string[] = []): any {
        if (!value || typeof value !== 'object') return undefined;

        const ratings = {
            overall: this.clampRating(value?.overall),
            work_life_balance: this.clampRating(value?.work_life_balance),
            career_growth: this.clampRating(value?.career_growth),
            compensation: this.clampRating(value?.compensation),
            management: this.clampRating(value?.management),
            diversity: this.clampRating(value?.diversity),
            review_count: this.toString(value?.review_count),
            data_sources: this.toStringArray(value?.data_sources)
        };

        if (ratings.data_sources.length === 0 && fallbackSources.length > 0) {
            ratings.data_sources = fallbackSources.slice(0, 3);
        }

        const hasNumeric = [
            ratings.overall,
            ratings.work_life_balance,
            ratings.career_growth,
            ratings.compensation,
            ratings.management,
            ratings.diversity
        ].some(n => n > 0);

        if (!hasNumeric && !ratings.review_count && ratings.data_sources.length === 0) {
            return undefined;
        }

        return ratings;
    }

    private hasCultureData(value: any): boolean {
        if (!value || typeof value !== 'object') return false;
        const ratings = [
            this.toNumber(value?.overall),
            this.toNumber(value?.work_life_balance),
            this.toNumber(value?.career_growth),
            this.toNumber(value?.compensation),
            this.toNumber(value?.management),
            this.toNumber(value?.diversity)
        ];
        const hasRatings = ratings.some(n => n > 0);
        const hasMeta = !!this.toString(value?.review_count) || this.toStringArray(value?.data_sources).length > 0;
        return hasRatings || hasMeta;
    }

    private nonEmptyString(preferred: string, fallback: string): string {
        return preferred && preferred.trim().length > 0 ? preferred : fallback;
    }

    private mergeDossiers(base: CompanyDossier, incoming: CompanyDossier): CompanyDossier {
        const mergedSources = Array.from(new Set([...(incoming.sources || []), ...(base.sources || [])])).filter(Boolean);
        return {
            ...base,
            company: this.nonEmptyString(incoming.company, base.company),
            hiring_strategy: this.nonEmptyString(incoming.hiring_strategy, base.hiring_strategy),
            interview_focus: this.nonEmptyString(incoming.interview_focus, base.interview_focus),
            interview_difficulty: incoming.interview_difficulty || base.interview_difficulty,
            core_values: incoming.core_values && incoming.core_values.length > 0 ? incoming.core_values : base.core_values,
            salary_estimates: incoming.salary_estimates && incoming.salary_estimates.length > 0 ? incoming.salary_estimates : base.salary_estimates,
            culture_ratings: this.hasCultureData(incoming.culture_ratings) ? incoming.culture_ratings : base.culture_ratings,
            employee_reviews: incoming.employee_reviews && incoming.employee_reviews.length > 0 ? incoming.employee_reviews : base.employee_reviews,
            critics: incoming.critics && incoming.critics.length > 0 ? incoming.critics : base.critics,
            benefits: incoming.benefits && incoming.benefits.length > 0 ? incoming.benefits : base.benefits,
            competitors: incoming.competitors && incoming.competitors.length > 0 ? incoming.competitors : base.competitors,
            recent_news: this.nonEmptyString(incoming.recent_news, base.recent_news),
            sources: mergedSources,
            fetched_at: this.nonEmptyString(incoming.fetched_at, base.fetched_at)
        };
    }

    private isLikelyStructuredDossier(candidate: any, expectedCompany: string): boolean {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;

        const signalCount = [
            this.toString(candidate?.hiring_strategy).length > 20,
            this.toString(candidate?.interview_focus).length > 20,
            Array.isArray(candidate?.salary_estimates) && candidate.salary_estimates.length > 0,
            this.hasCultureData(candidate?.culture_ratings),
            Array.isArray(candidate?.employee_reviews) && candidate.employee_reviews.length > 0,
            Array.isArray(candidate?.critics) && candidate.critics.length > 0,
            Array.isArray(candidate?.benefits) && candidate.benefits.length > 0,
            Array.isArray(candidate?.competitors) && candidate.competitors.length > 0,
            this.toString(candidate?.recent_news).length > 20,
            Array.isArray(candidate?.sources) && candidate.sources.length > 0
        ].filter(Boolean).length;

        const candidateCompany = this.toString(candidate?.company).toLowerCase();
        const expected = this.toString(expectedCompany).toLowerCase();
        const companyLooksValid = !candidateCompany || !expected || candidateCompany.includes(expected) || expected.includes(candidateCompany);

        return companyLooksValid && signalCount >= 3;
    }

    private normalizeDossier(company: string, data: any): CompanyDossier {
        const salaryEstimates = Array.isArray(data?.salary_estimates) ? data.salary_estimates : [];
        // Normalize competitors: accept arrays or comma/newline/semicolon-separated strings
        let competitors: string[] = [];
        if (Array.isArray(data?.competitors)) {
            competitors = this.toStringArray(data.competitors);
        } else if (typeof data?.competitors === 'string') {
            competitors = data.competitors.split(/[,;\n]+/).map((s: string) => s.trim()).filter(Boolean);
        }

        // Normalize employee reviews: accept arrays or a single string (possibly JSON)
        let employeeReviews: any[] = [];
        if (Array.isArray(data?.employee_reviews)) {
            employeeReviews = data.employee_reviews.map((r: any) => {
                if (typeof r === 'string') {
                    return { quote: this.toString(r), sentiment: 'mixed', source: '' };
                }
                return {
                    quote: this.toString(r?.quote) || this.toString(r),
                    sentiment: r?.sentiment || 'mixed',
                    source: this.toString(r?.source) || '',
                    role: this.toString(r?.role) || ''
                };
            });
        } else if (typeof data?.employee_reviews === 'string') {
            try {
                const parsed = JSON.parse(data.employee_reviews);
                if (Array.isArray(parsed)) {
                    employeeReviews = parsed.map((r: any) => ({
                        quote: this.toString(r?.quote) || this.toString(r),
                        sentiment: r?.sentiment || 'mixed',
                        source: this.toString(r?.source) || '',
                        role: this.toString(r?.role) || ''
                    }));
                } else {
                    employeeReviews = [{ quote: this.toString(data.employee_reviews), sentiment: 'mixed', source: '' }];
                }
            } catch {
                employeeReviews = [{ quote: this.toString(data.employee_reviews), sentiment: 'mixed', source: '' }];
            }
        }

        // Remove any empty or blank review quotes so that placeholder/empty
        // entries do not prevent the synthesis fallback from running.
        employeeReviews = employeeReviews
            .map((r: any) => ({
                quote: this.toString(r?.quote) || this.toString(r),
                sentiment: r?.sentiment || 'mixed',
                source: this.toString(r?.source) || '',
                role: this.toString(r?.role) || ''
            }))
            .filter((r: any) => r.quote && r.quote.length > 0);

        const normalizedSources = this.toStringArray(data?.sources);

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
                confidence: ['low', 'medium', 'high'].includes(this.toString(s?.confidence)) ? this.toString(s?.confidence) : 'low'
            })).filter((s: any) => s.title || s.min || s.max),
            culture_ratings: this.normalizeCultureRatings(data?.culture_ratings, normalizedSources),
            employee_reviews: employeeReviews,
            critics: Array.isArray(data?.critics) ? data.critics : [],
            benefits: this.toStringArray(data?.benefits),
            competitors: competitors,
            recent_news: this.toString(data?.recent_news),
            sources: normalizedSources,
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
            `${company} recent news`,
            // Targeted queries to surface employee reviews and competitors
            `${company} employee reviews Glassdoor Indeed`,
            `${company} competitors similar companies`
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

        // If the search provider returned a strong, schema-matching dossier JSON,
        // accept it directly; otherwise continue with LLM synthesis to avoid sparse data.
        if (hasSources) {
            for (const src of sourceList) {
                if (!src.content) continue;
                try {
                    const parsed = this.parseJson(src.content);
                    if (this.isLikelyStructuredDossier(parsed, normalizedCompany)) {
                        const providerDossier = this.normalizeDossier(normalizedCompany, parsed);
                        providerDossier.fetched_at = new Date().toISOString();
                        this.cached.set(cacheKey, providerDossier);
                        console.log('[CompanyResearch] Using structured dossier directly from search provider:', src.url || src.title);
                        return providerDossier;
                    }
                } catch (e) {
                    // Not structured JSON — continue to next source
                }
            }
        }

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
            ? 'Use provided sources as PRIMARY evidence. If a field is missing from sources, infer a cautious estimate from general knowledge instead of leaving it blank; mark confidence low and identify inferred content in source attribution.'
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
            'Extraction Instructions: Extract up to 5 representative employee review quotes from the provided Sources (Glassdoor/Indeed/other). For each review include the quote, sentiment (positive|mixed|negative), source name, and role if available.',
            'Also extract up to 8 competitor company names (short names only). If the sources do not contain this information, return empty arrays for those fields.',
            'Sources:',
            sourceBlock || '(no sources provided)'
        ].join('\n');

        let dossier = this.buildDefaultDossier(normalizedCompany);
        try {
            let raw: string = '';
            try {
                raw = await this.generateContentFn([{ text: prompt }]);
                const parsed = this.parseJson(raw);
                dossier = this.normalizeDossier(normalizedCompany, parsed);
            } catch (innerErr: any) {
                console.warn('[CompanyResearch] Failed to build dossier:', innerErr?.message || innerErr);
                if (raw && typeof raw === 'string') {
                    console.log('[CompanyResearch] Raw LLM output (truncated):', raw.slice(0, 2000));
                }
            }
        } catch (error: any) {
            console.warn('[CompanyResearch] Failed to build dossier (outer):', error?.message || error);
        }

        // If provider sources were available, run a refinement pass that merges
        // the initial LLM-generated dossier with the provider snippets so the
        // final dossier benefits from both sources.
        if (hasSources) {
            try {
                const refinePrompt = [
                    'You are refining a previously-generated company dossier using additional source snippets.',
                    'Return ONLY valid JSON using the SAME schema as provided previously. No markdown or commentary.',
                    'Initial Dossier:',
                    JSON.stringify(dossier),
                    'Sources (snippets):',
                    sourceBlock || '(no sources provided)',
                    'Task: Merge, correct, and enrich the Initial Dossier using the Sources. Preserve field names and types. Where sources provide concrete facts or figures, prefer them and include source attributions. If values cannot be verified, keep confidence low. Return only the final JSON dossier.'
                ].join('\n');

                const refinedRaw = await this.generateContentFn([{ text: refinePrompt }]);
                try {
                    const refinedParsed = this.parseJson(refinedRaw);
                    const refined = this.normalizeDossier(normalizedCompany, refinedParsed);
                    // Merge without allowing sparse refined fields to wipe useful existing values.
                    dossier = this.mergeDossiers(dossier, refined);
                    console.log('[CompanyResearch] Dossier refined using provider snippets and LLM.');
                    } catch (e) {
                    console.warn('[CompanyResearch] Failed to parse refined dossier, keeping initial dossier:', e?.message || e);
                    if (refinedRaw && typeof refinedRaw === 'string') {
                        console.log('[CompanyResearch] Raw refined LLM output (truncated):', refinedRaw.slice(0, 2000));
                    }
                }
            } catch (refineErr: any) {
                console.warn('[CompanyResearch] Dossier refinement step failed:', refineErr?.message || refineErr);
            }
        }

        // If employee reviews are still empty, ask the LLM to synthesize representative
        // employee review quotes (marked as inferred) so the UI's reviews component
        // can show useful content instead of an empty section.
        if ((!Array.isArray(dossier.employee_reviews) || dossier.employee_reviews.length === 0) && this.generateContentFn) {
            try {
                const synthPrompt = [
                    'You are an assistant that produces representative employee review quotes for a company.',
                    'Return ONLY valid JSON with a top-level key `employee_reviews` containing an array of objects with the fields: {"quote":"","sentiment":"positive|mixed|negative","source":"inferred|Glassdoor|Indeed|...","role":""}.',
                    `Company: ${normalizedCompany}`,
                    'Instruction: If the provided Sources contain explicit employee review quotes, extract them. Otherwise, PREDICT up to 5 plausible representative employee review quotes based on the Sources and general knowledge. For predicted quotes set `source` to "inferred". Keep quotes concise (1-2 sentences).',
                    'Sources:',
                    sourceBlock || '(no sources provided)'
                ].join('\n');

                const synthRaw = await this.generateContentFn([{ text: synthPrompt }]);
                try {
                    const parsed = this.parseJson(synthRaw);
                    const reviews = Array.isArray(parsed?.employee_reviews) ? parsed.employee_reviews : (Array.isArray(parsed) ? parsed : []);
                    if (reviews.length > 0) {
                        dossier.employee_reviews = reviews.map((r: any) => ({
                            quote: this.toString(r?.quote) || this.toString(r),
                            sentiment: r?.sentiment || 'mixed',
                            source: this.toString(r?.source) || 'inferred',
                            role: this.toString(r?.role) || ''
                        })).filter((r: any) => r.quote);
                        console.log('[CompanyResearch] Employee reviews synthesized via fallback LLM.');
                    }
                } catch (e) {
                    console.warn('[CompanyResearch] Failed to parse synthesized employee reviews:', e?.message || e);
                    if (synthRaw && typeof synthRaw === 'string') {
                        console.log('[CompanyResearch] Raw synthesized reviews output (truncated):', synthRaw.slice(0, 2000));
                    }
                }
            } catch (err: any) {
                console.warn('[CompanyResearch] Employee review synthesis failed:', err?.message || err);
            }
        }

        if (!dossier.sources || dossier.sources.length === 0) {
            dossier.sources = sourceList.map(s => s.url || s.title).filter(Boolean);
        }
        if (!hasSources && (!dossier.sources || dossier.sources.length === 0)) {
            dossier.sources = ['general knowledge'];
        }
        dossier.fetched_at = new Date().toISOString();
        // Debug output for final dossier to help diagnose missing fields
        try {
            console.debug('[CompanyResearch] Final dossier (truncated):', JSON.stringify(dossier).slice(0, 2000));
        } catch (e) {
            /* ignore serialization errors */
        }
        this.cached.set(cacheKey, dossier);
        return dossier;
    }
}
