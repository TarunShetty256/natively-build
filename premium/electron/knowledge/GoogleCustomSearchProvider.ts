// electron/knowledge/GoogleCustomSearchProvider.ts
// Google Custom Search JSON API integration for company research

import https from 'https';
import { SearchProvider, SearchResult } from './CompanyResearchEngine';

const GOOGLE_CSE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

export interface GoogleSearchOptions {
    num?: number;       // 1–10, default 10
    start?: number;     // pagination offset
    safe?: 'off' | 'active';
    gl?: string;        // country code, e.g. "us", "in"
    lr?: string;        // language restriction, e.g. "lang_en"
}

export interface GoogleSearchError {
    code: number;
    message: string;
}

/**
 * Google Custom Search provider implementing the SearchProvider interface.
 * Uses the Google Custom Search JSON API (REST GET).
 */
export class GoogleCustomSearchProvider implements SearchProvider {
    private apiKey: string;
    private cseId: string;

    constructor(apiKey: string, cseId: string) {
        this.apiKey = apiKey;
        this.cseId = cseId;
    }

    async search(query: string, numResults: number = 5, options?: GoogleSearchOptions): Promise<SearchResult[]> {
        const num = Math.min(Math.max(numResults, 1), 10);

        const params = new URLSearchParams({
            key: this.apiKey,
            cx: this.cseId,
            q: query,
            num: num.toString(),
        });

        if (options?.start) params.set('start', options.start.toString());
        if (options?.safe) params.set('safe', options.safe);
        if (options?.gl) params.set('gl', options.gl);
        if (options?.lr) params.set('lr', options.lr);

        const url = `${GOOGLE_CSE_ENDPOINT}?${params.toString()}`;

        try {
            const data = await this.httpGet(url);
            const parsed = JSON.parse(data);

            // Handle API error responses
            if (parsed.error) {
                const err: GoogleSearchError = {
                    code: parsed.error.code || 0,
                    message: parsed.error.message || 'Unknown Google API error',
                };
                console.error(`[GoogleSearch] API error (${err.code}): ${err.message}`);
                return [];
            }

            // Map items to SearchResult format
            if (!parsed.items || !Array.isArray(parsed.items)) {
                console.warn('[GoogleSearch] No items in response');
                return [];
            }

            const results: SearchResult[] = parsed.items.map((item: any) => ({
                title: item.title || '',
                link: item.link || '',
                snippet: item.snippet || '',
            }));

            console.log(`[GoogleSearch] Got ${results.length} results for: "${query}"`);
            return results;
        } catch (error: any) {
            console.error(`[GoogleSearch] Request failed: ${error.message}`);
            return [];
        }
    }

    /**
     * Simple HTTPS GET request using Node's built-in https module.
     */
    private httpGet(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = https.get(url, { timeout: 10000 }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            });

            req.on('error', (err) => reject(err));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });
        });
    }
}
