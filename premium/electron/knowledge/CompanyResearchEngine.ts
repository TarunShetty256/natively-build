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
            employee_reviews: employeeReviews,
            critics: Array.isArray(data?.critics) ? data.critics : [],
            benefits: this.toStringArray(data?.benefits),
            competitors: competitors,
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

        // If the search provider returned a source that already contains structured JSON
        // matching the dossier schema, accept it directly and skip LLM generation.
        if (hasSources) {
            for (const src of sourceList) {
                if (!src.content) continue;
                try {
                    const parsed = this.parseJson(src.content);
                    if (parsed && (parsed.company || parsed.salary_estimates || parsed.hiring_strategy || parsed.sources || parsed.recent_news)) {
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
                    // Merge sources lists and prefer refined fields when present
                    const mergedSources = Array.from(new Set([...(refined.sources || []), ...(dossier.sources || [])]));
                    dossier = { ...dossier, ...refined, sources: mergedSources } as CompanyDossier;
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
