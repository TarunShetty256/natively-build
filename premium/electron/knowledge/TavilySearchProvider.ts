export class TavilySearchProvider {
  private apiKey: string;
  private client: any;
  private debug: boolean;

  constructor(apiKey: string, opts?: { debug?: boolean }) {
    this.apiKey = apiKey;
    this.client = null;
    this.debug = opts?.debug ?? (process.env.TAVILY_DEBUG === '1' || false);
    if (this.debug) console.debug('[TavilySearchProvider] initializing (debug=true)');
    try {
      // Try a few common shapes for the Tavily core package so this stays resilient
      let tavily: any = require('@tavily/core');
      if (!tavily) {
        if (this.debug) console.debug('[TavilySearchProvider] @tavily/core returned falsy');
        return;
      }

      // Unwrap nested exports commonly seen in transpiled packages (e.g., { tavily: ... } or { default: ... })
      if (tavily?.tavily) {
        if (this.debug) console.debug('[TavilySearchProvider] unwrapping nested .tavily export');
        tavily = tavily.tavily;
      }
      if (tavily?.default) {
        if (this.debug) console.debug('[TavilySearchProvider] unwrapping nested .default export');
        tavily = tavily.default;
      }
      if (tavily?.tavily) {
        if (this.debug) console.debug('[TavilySearchProvider] unwrapping nested .tavily export (2nd pass)');
        tavily = tavily.tavily;
      }

      if (typeof tavily.createClient === 'function') {
        this.client = tavily.createClient({ apiKey });
      } else if (typeof tavily.Client === 'function') {
        this.client = new tavily.Client({ apiKey });
      } else if (typeof tavily === 'function') {
        try { this.client = tavily({ apiKey }); } catch { try { this.client = new (tavily as any)({ apiKey }); } catch { this.client = tavily; } }
      } else if (typeof tavily.default === 'function') {
        try { this.client = tavily.default({ apiKey }); } catch { this.client = new tavily.default({ apiKey }); }
      } else {
        // Some versions export a singleton factory or namespaced object
        this.client = tavily;
      }
      if (this.debug) console.debug('[TavilySearchProvider] client initialized', !!this.client);
    } catch (e) {
      // Leave client null — caller will handle absence
      if (this.debug) console.warn('[TavilySearchProvider] failed to initialize client:', e?.message || e);
      this.client = null;
    }
  }

  public async search(query: string, options?: { maxResults?: number; searchDepth?: 'basic' | 'advanced' }) {
    const max = options?.maxResults ?? 4;
    if (!this.client) throw new Error('Tavily client not initialized');

    // Try a few likely method names that different versions might provide.
    const methodsToTry = ['search', 'webSearch', 'query', 'searchWeb', 'searchAsync', 'searchAll'];
    let raw: any = null;

    if (this.debug) {
      try {
        const clientKeys = Object.keys(this.client || {}).slice(0, 200);
        console.debug('[TavilySearchProvider] client type:', typeof this.client, 'client keys (sample):', clientKeys);
      } catch (e) {
        console.debug('[TavilySearchProvider] could not enumerate client keys');
      }
    }

    // Helper: try a function with multiple signature shapes and log attempts
    const tryFnWithSignatures = async (fn: Function, methodName: string) => {
      const signatures: Array<{ args: any[]; desc: string }> = [
        { args: [query, { limit: max }], desc: 'fn(query, {limit})' },
        { args: [query, { limit: max, apiKey: this.apiKey }], desc: 'fn(query, {limit, apiKey})' },
        { args: [{ query, limit: max }], desc: 'fn({query, limit})' },
        { args: [{ q: query, limit: max }], desc: 'fn({q, limit})' },
        { args: [query], desc: 'fn(query)' },
        { args: [{ prompt: query, limit: max }], desc: 'fn({prompt, limit})' },
        { args: [{ input: query, limit: max }], desc: 'fn({input, limit})' }
      ];

      for (const sig of signatures) {
        try {
          if (this.debug) console.debug(`[TavilySearchProvider] trying ${methodName} with signature ${sig.desc}`);
          const result = await (fn as any).apply(this.client, sig.args);
          if (result != null) {
            if (this.debug) console.debug(`[TavilySearchProvider] ${methodName} ${sig.desc} returned type:`, typeof result);
            return result;
          } else {
            if (this.debug) console.debug(`[TavilySearchProvider] ${methodName} ${sig.desc} returned null/undefined`);
          }
        } catch (err: any) {
          if (this.debug) console.debug(`[TavilySearchProvider] ${methodName} ${sig.desc} threw:`, err?.message || err);
        }
      }

      return null;
    };

    // First try the well-known method names
    for (const m of methodsToTry) {
      try {
        const fn = this.client[m];
        if (typeof fn === 'function') {
          raw = await tryFnWithSignatures(fn, m);
          if (raw) break;
        } else {
          if (this.debug) console.debug(`[TavilySearchProvider] method ${m} not available on client`);
        }
      } catch (err) {
        if (this.debug) console.debug(`[TavilySearchProvider] invoking ${m} failed:`, err?.message || err);
      }
    }

    // If not found, scan client methods for anything that looks like a search/query runner
    if (!raw) {
      try {
        const clientMethodNames = Object.keys(this.client || {});
        const candidateNames = clientMethodNames.filter(n => !methodsToTry.includes(n) && /search|query|run|find|lookup|web|fetch/i.test(n));
        for (const name of candidateNames.slice(0, 50)) {
          try {
            const fn = (this.client as any)[name];
            if (typeof fn === 'function') {
              raw = await tryFnWithSignatures(fn, name);
              if (raw) break;
            }
          } catch (err: any) {
            if (this.debug) console.debug(`[TavilySearchProvider] candidate ${name} failed:`, err?.message || err);
          }
        }
      } catch (e) {
        if (this.debug) console.debug('[TavilySearchProvider] failed scanning client methods:', e?.message || e);
      }
    }

    // If we didn't get results from client methods, some clients accept a single-call API
    if (!raw) {
      try {
        // e.g. tavily.search(query, { apiKey }) style
        const tavily = require('@tavily/core');
        if (typeof tavily === 'function') {
          if (this.debug) console.debug('[TavilySearchProvider] trying @tavily/core as function');
          try {
            raw = await tavily(query, { apiKey: this.apiKey, limit: max });
          } catch (err: any) {
            if (this.debug) console.debug('[TavilySearchProvider] @tavily/core(query) threw:', err?.message || err);
          }
        }
      } catch (err) {
        if (this.debug) console.debug('[TavilySearchProvider] require(@tavily/core) as fallback failed:', err?.message || err);
      }
    }

    // Normalize a variety of response shapes into SearchResult[]
    const hits = raw?.results || raw?.hits || raw?.items || raw?.data || raw?.web_results || raw?.rows || [];
    const arr = Array.isArray(hits) ? hits : [];

    if (this.debug) {
      try {
        const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
        console.debug('[TavilySearchProvider] raw response (truncated):', rawStr ? rawStr.slice(0, 2000) : rawStr);
      } catch (e) {
        console.debug('[TavilySearchProvider] raw response could not be stringified');
      }
      console.debug('[TavilySearchProvider] normalized hits count:', arr.length);
      const sample = arr.slice(0, 3).map((h: any) => ({
        title: h?.title || h?.headline || h?.name || h?.source_title || '',
        url: h?.url || h?.link || h?.canonical_url || h?.uri || h?.source_url || '',
        snippet: (h?.snippet || h?.excerpt || h?.summary || h?.content || h?.text || '').slice(0, 200)
      }));
      console.debug('[TavilySearchProvider] sample hits:', sample);
    }

    // Return an empty array rather than throwing when no results are available.
    return arr.slice(0, max).map((h: any) => {
      const title = h.title || h.headline || h.name || h.source_title || '';
      const url = h.url || h.link || h.canonical_url || h.uri || h.source_url || '';
      const content = h.snippet || h.excerpt || h.summary || h.content || h.text || '';
      return { title, url, content };
    });
  }
}

export default TavilySearchProvider;
