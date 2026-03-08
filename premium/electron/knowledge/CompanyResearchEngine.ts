// electron/knowledge/CompanyResearchEngine.ts
// Company research engine with pluggable web search, LLM summarization, and SQLite caching

import { CompanyDossier, SalaryEstimate, StructuredJD } from './types';
import { KnowledgeDatabaseManager } from './KnowledgeDatabaseManager';

// ============================================
// Pluggable Search Provider Interface
// ============================================

export interface SearchResult {
    title: string;
    link: string;
    snippet: string;
}

export interface SearchProvider {
    search(query: string, numResults?: number): Promise<SearchResult[]>;
}

/**
 * JD context passed into research for richer, role-aware dossiers.
 * Every field is optional so callers without a JD can still use the engine.
 */
export interface JDContext {
    title?: string;           // e.g. "Technical Project Trainee"
    location?: string;        // e.g. "Gurgaon"
    level?: string;           // e.g. "entry", "senior"
    employment_type?: string; // e.g. "full_time", "internship"
    technologies?: string[];
    requirements?: string[];
    responsibilities?: string[];
    keywords?: string[];
    compensation_hint?: string;
    min_years_experience?: number;
    description_summary?: string;
}

/**
 * Build a JDContext from a StructuredJD (convenience helper).
 */
export function jdContextFromStructured(jd: StructuredJD): JDContext {
    return {
        title: jd.title || (jd as any).role || 'Unknown Role',
        location: jd.location || 'Unknown Location',
        level: jd.level,
        employment_type: jd.employment_type,
        technologies: jd.technologies,
        requirements: jd.requirements,
        responsibilities: jd.responsibilities,
        keywords: jd.keywords,
        compensation_hint: jd.compensation_hint,
        min_years_experience: jd.min_years_experience,
        description_summary: jd.description_summary,
    };
}

/**
 * Fetch text content from a URL with timeout and error handling.
 */
async function fetchPageText(url: string, timeoutMs: number = 5000): Promise<string> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; NativelyBot/1.0)',
                'Accept': 'text/html,application/xhtml+xml'
            }
        });

        clearTimeout(timeout);

        if (!response.ok) return '';
        const html = await response.text();

        // Basic HTML to text extraction (strip tags, scripts, styles)
        return html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 3000); // Limit to 3k chars per page
    } catch {
        return '';
    }
}

// ============================================
// Dossier JSON schema for LLM prompt
// ============================================

const DOSSIER_SCHEMA = `{
  "company": "",
  "hiring_strategy": "",
  "interview_focus": "",
  "salary_estimates": [
    {"title": "", "location": "", "min": 0, "max": 0, "currency": "USD", "source": "", "confidence": "low"}
  ],
  "competitors": [],
  "recent_news": "",
  "core_values": [],
  "sources": []
}`;

// ============================================
// Company Research Engine
// ============================================

export class CompanyResearchEngine {
    private db: KnowledgeDatabaseManager;
    private searchProvider: SearchProvider | null = null;
    private generateContentFn: ((contents: any[]) => Promise<string>) | null = null;

    // Rate limiting
    private lastSearchTime: number = 0;
    private minSearchIntervalMs: number = 2000; // 2 seconds between searches

    constructor(db: KnowledgeDatabaseManager) {
        this.db = db;
    }

    /**
     * Set the search provider (SerpAPI, Google Custom Search, etc.)
     */
    setSearchProvider(provider: SearchProvider): void {
        this.searchProvider = provider;
    }

    /**
     * Set the LLM content generation function.
     */
    setGenerateContentFn(fn: (contents: any[]) => Promise<string>): void {
        this.generateContentFn = fn;
    }

    /**
     * Research a company. Returns cached dossier if fresh, otherwise runs live research.
     * Accepts a JDContext for richer, role-aware dossiers.
     */
    async researchCompany(
        companyName: string,
        jdCtx: JDContext = {},
        forceRefresh: boolean = false
    ): Promise<CompanyDossier | null> {
        const normalizedName = companyName.toLowerCase().trim();
        console.log(`[CompanyResearch] Researching: ${companyName} (role: ${jdCtx.title}, location: ${jdCtx.location}, level: ${jdCtx.level})`);

        // Check cache
        if (!forceRefresh) {
            const cached = this.db.getDossier(normalizedName);
            if (cached && !this.db.isDossierStale(normalizedName)) {
                console.log(`[CompanyResearch] Returning cached dossier for ${companyName}`);
                return cached.dossier as CompanyDossier;
            }
        }

        // If no search provider, return a minimal dossier with available data
        if (!this.searchProvider) {
            console.warn('[CompanyResearch] No search provider configured. Returning LLM-only dossier.');
            return this.generateLLMOnlyDossier(companyName, jdCtx);
        }

        // Rate limiting
        const now = Date.now();
        if (now - this.lastSearchTime < this.minSearchIntervalMs) {
            await new Promise(resolve => setTimeout(resolve, this.minSearchIntervalMs - (now - this.lastSearchTime)));
        }

        try {
            // Build search queries
            const queries = this.buildSearchQueries(companyName, jdCtx);
            const allResults: SearchResult[] = [];
            const allUrls: string[] = [];

            // Execute searches with rate limiting
            for (const query of queries) {
                try {
                    this.lastSearchTime = Date.now();
                    const results = await this.searchProvider.search(query, 3);
                    allResults.push(...results);
                    allUrls.push(...results.map(r => r.link));
                    // Small delay between queries
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (error: any) {
                    console.warn(`[CompanyResearch] Search failed for query "${query}": ${error.message}`);
                }
            }

            if (allResults.length === 0) {
                console.warn('[CompanyResearch] No search results found. Falling back to LLM-only.');
                return this.generateLLMOnlyDossier(companyName, jdCtx);
            }

            // Fetch page content for top results (limit to 6)
            const snippets: { url: string; text: string }[] = [];
            for (const result of allResults.slice(0, 6)) {
                const text = result.snippet || await fetchPageText(result.link);
                if (text) {
                    snippets.push({ url: result.link, text: text.slice(0, 1500) });
                }
            }

            // Summarize with LLM
            const dossier = await this.summarizeWithLLM(companyName, jdCtx, snippets);

            if (dossier) {
                // Cache the dossier
                this.db.saveDossier(normalizedName, dossier, allUrls);
                return dossier;
            }

            return null;
        } catch (error: any) {
            console.error(`[CompanyResearch] Research failed for ${companyName}:`, error.message);
            return this.generateLLMOnlyDossier(companyName, jdCtx);
        }
    }

    /**
     * Build targeted search queries for a company using full JD context.
     */
    private buildSearchQueries(companyName: string, jdCtx: JDContext): string[] {
        const { title, location, technologies, level } = jdCtx;

        const queries = [
            `${companyName} hiring strategy careers`,
            `${companyName} interview process ${title || ''}`.trim(),
        ];

        // Salary query — include role, location, and level if available
        if (title && location) {
            queries.push(`${companyName} ${title} salary ${location}`);
        } else if (title) {
            queries.push(`${companyName} ${title} salary`);
        }

        queries.push(`${companyName} recent funding news layoffs`);
        queries.push(`${companyName} competitors`);
        queries.push(`${companyName} core values leadership principles culture`);
        queries.push(`${companyName} careers about us values mission`);

        // Tech-stack specific query when technologies are known
        if (technologies && technologies.length > 0) {
            queries.push(`${companyName} tech stack ${technologies.slice(0, 3).join(' ')}`);
        }

        // Level-specific interview query (e.g. "intern interview", "senior interview")
        if (level && title) {
            queries.push(`${companyName} ${level} ${title} interview`);
        }

        return queries;
    }

    /**
     * Format a compact JD summary block for LLM context.
     */
    private formatJDContextBlock(jdCtx: JDContext): string {
        const parts: string[] = [];
        if (jdCtx.title) parts.push(`Role: ${jdCtx.title}`);
        if (jdCtx.level) parts.push(`Level: ${jdCtx.level}`);
        if (jdCtx.location) parts.push(`Location: ${jdCtx.location}`);
        if (jdCtx.employment_type) parts.push(`Type: ${jdCtx.employment_type.replace('_', ' ')}`);
        if (jdCtx.min_years_experience !== undefined && jdCtx.min_years_experience > 0) {
            parts.push(`Min Experience: ${jdCtx.min_years_experience} years`);
        }
        if (jdCtx.compensation_hint) parts.push(`Compensation Hint: ${jdCtx.compensation_hint}`);
        if (jdCtx.technologies && jdCtx.technologies.length > 0) {
            parts.push(`Technologies: ${jdCtx.technologies.join(', ')}`);
        }
        if (jdCtx.requirements && jdCtx.requirements.length > 0) {
            parts.push(`Key Requirements: ${jdCtx.requirements.slice(0, 5).join('; ')}`);
        }
        if (jdCtx.responsibilities && jdCtx.responsibilities.length > 0) {
            parts.push(`Key Responsibilities: ${jdCtx.responsibilities.slice(0, 5).join('; ')}`);
        }
        if (jdCtx.keywords && jdCtx.keywords.length > 0) {
            parts.push(`Keywords: ${jdCtx.keywords.join(', ')}`);
        }
        if (jdCtx.description_summary) parts.push(`Summary: ${jdCtx.description_summary}`);
        return parts.join('\n');
    }

    /**
     * Use LLM to summarize search snippets into a structured dossier.
     */
    private async summarizeWithLLM(
        companyName: string,
        jdCtx: JDContext,
        snippets: { url: string; text: string }[]
    ): Promise<CompanyDossier | null> {
        if (!this.generateContentFn) return null;

        const snippetText = snippets.map(s => `[Source: ${s.url}]\n${s.text}`).join('\n\n---\n\n');
        const jdBlock = this.formatJDContextBlock(jdCtx);

        const prompt = `You are a web research assistant. Using the following web snippets, create a structured company dossier JSON for ${companyName}.

${jdBlock ? `The candidate is applying for the following position — tailor salary estimates, interview focus, and hiring strategy to this specific role:\n${jdBlock}\n` : ''}
Match this exact JSON schema:
${DOSSIER_SCHEMA}

Rules:
- For each salary estimate, include a source URL and confidence level (low/medium/high).
- Tailor salary estimates to the specific role, level, and location from the JD context above.
- For interview_focus, consider the specific technologies, requirements, and responsibilities listed.
- If information is not available, use empty strings or empty arrays.
- Do NOT fabricate data. Only use information from the snippets.
- Return JSON only. No markdown fences.

Web Snippets:
${snippetText}`;

        try {
            const response = await this.generateContentFn([{ text: prompt }]);
            let cleaned = response.trim();
            if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
            if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
            if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);

            const dossier = JSON.parse(cleaned.trim()) as CompanyDossier;
            dossier.fetched_at = new Date().toISOString();
            dossier.core_values = dossier.core_values || [];
            dossier.sources = [...new Set([...(dossier.sources || []), ...snippets.map(s => s.url)])];

            console.log(`[CompanyResearch] Dossier generated for ${companyName} with ${dossier.sources.length} sources`);
            return dossier;
        } catch (error: any) {
            console.error(`[CompanyResearch] Failed to parse LLM dossier response:`, error.message);
            return null;
        }
    }

    /**
     * Generate a minimal dossier using only LLM knowledge (no web search).
     */
    private async generateLLMOnlyDossier(
        companyName: string,
        jdCtx: JDContext = {}
    ): Promise<CompanyDossier | null> {
        if (!this.generateContentFn) return null;

        const jdBlock = this.formatJDContextBlock(jdCtx);

        const prompt = `Based on your general knowledge, provide a brief company dossier for ${companyName}.

${jdBlock ? `The candidate is applying for the following position — tailor salary estimates, interview focus, and hiring strategy to this specific role:\n${jdBlock}\n` : ''}
Match this exact JSON schema:
${DOSSIER_SCHEMA}

Rules:
- Mark ALL confidence levels as "low" since this is from general knowledge, not live data.
- Use empty string for source URLs.
- Be conservative with salary estimates but tailor them to the role, level, and location.
- Return JSON only. No markdown fences.`;

        try {
            const response = await this.generateContentFn([{ text: prompt }]);
            let cleaned = response.trim();
            if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
            if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
            if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);

            const dossier = JSON.parse(cleaned.trim()) as CompanyDossier;
            dossier.fetched_at = new Date().toISOString();
            dossier.core_values = dossier.core_values || [];
            dossier.sources = [];

            // Cache even LLM-only dossiers (shorter TTL could be set)
            this.db.saveDossier(companyName, dossier, []);

            console.log(`[CompanyResearch] LLM-only dossier generated for ${companyName} (low confidence)`);
            return dossier;
        } catch (error: any) {
            console.error(`[CompanyResearch] LLM-only dossier generation failed:`, error.message);
            return null;
        }
    }

    /**
     * Get cached dossier without triggering research.
     */
    getCachedDossier(companyName: string): CompanyDossier | null {
        const cached = this.db.getDossier(companyName);
        return cached ? cached.dossier as CompanyDossier : null;
    }
}

