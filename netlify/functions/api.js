// Deep Read — Netlify serverless function
// Handles: password auth, Anthropic API, Semantic Scholar, Europe PMC, PubMed
// Environment variables required in Netlify dashboard:
//   ANTHROPIC_API_KEY — your Anthropic API key
//   ACCESS_PASSWORD  — the password users must enter to access the tool

const ALLOWED_ORIGINS = ['*'];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Password',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json'
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || '*';

  // Handle preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  // Parse request
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch(e) {
    return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { action, password } = body;

  // ── PASSWORD CHECK ────────────────────────────────────────
  const correctPassword = process.env.ACCESS_PASSWORD;
  if (!correctPassword) {
    return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Server misconfigured — ACCESS_PASSWORD not set' }) };
  }
  if (!password || password !== correctPassword) {
    return { statusCode: 401, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid password' }) };
  }

  // ── ROUTE BY ACTION ───────────────────────────────────────
  try {
    switch (action) {

      // Verify password only
      case 'auth':
        return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ ok: true }) };

      // Proxy a URL (for multi-paper URL input)
      case 'proxy_url': {
        const { url } = body;
        if(!url) throw new Error('No URL provided');
        const response = await fetch(url);
        const text = await response.text();
        return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ contents: text, status: response.status }) };
      }

      // Anthropic Claude API
      case 'claude': {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

        const { messages, system, max_tokens = 4000, model = 'claude-opus-4-5' } = body;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({ model, max_tokens, system, messages })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || `Anthropic error ${response.status}`);
        return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(data) };
      }

      // Semantic Scholar search
      case 'semantic_scholar': {
        const { query, year_filter, limit = 15 } = body;
        const fields = 'title,year,citationCount,authors,publicationVenue,isOpenAccess,openAccessPdf,externalIds,abstract';
        const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${Math.min(limit, 50)}&fields=${fields}${year_filter || ''}`;

        const response = await fetch(url, {
          headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) {
          // Return empty rather than error so other sources still work
          console.error(`Semantic Scholar HTTP ${response.status}`);
          return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ data: [] }) };
        }
        const data = await response.json();
        return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(data) };
      }

      // Europe PMC search — retries without year filter if needed
      case 'europe_pmc': {
        const { query, base_query, limit = 15 } = body;

        const trySearch = async (q) => {
          const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&resultType=core&pageSize=${Math.min(limit, 25)}&format=json&sort=RELEVANCE`;
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Europe PMC error ${response.status}`);
          return await response.json();
        };

        let data = await trySearch(query);

        // If year-filtered query returned nothing, retry with base query
        if ((!data.resultList?.result?.length) && base_query && base_query !== query) {
          console.log('Europe PMC: retrying without year filter');
          data = await trySearch(base_query);
        }

        return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(data) };
      }

      // PubMed search (two-step: search then summary)
      case 'pubmed_search': {
        const { query, reldate, limit = 10 } = body;
        const dateFilter = reldate ? `&datetype=pdat&reldate=${reldate}` : '';
        const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${Math.min(limit * 2, 100)}&retmode=json&sort=relevance&filter=simsearch2.ffrft${dateFilter}`;

        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();
        const pmids = searchData.esearchresult?.idlist || [];
        if (pmids.length === 0) return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ result: {} }) };

        const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json`;
        const summaryRes = await fetch(summaryUrl);
        const summaryData = await summaryRes.json();
        return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ ...summaryData, pmids }) };
      }

      default:
        return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: `Unknown action: ${action}` }) };
    }
  } catch (err) {
    console.error('API function error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: err.message || 'Internal server error' })
    };
  }
};
