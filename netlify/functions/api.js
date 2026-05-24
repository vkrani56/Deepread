exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Simple test response first
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad JSON', received: event.body }) };
  }

  const { action, password } = body;

  // Log what we received
  console.log('Action:', action, 'Has password:', !!password);

  // Check env vars
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasPassword = !!process.env.ACCESS_PASSWORD;
  console.log('Env vars - ANTHROPIC_API_KEY:', hasAnthropicKey, 'ACCESS_PASSWORD:', hasPassword);

  if (!hasPassword) {
    return { statusCode: 500, headers, body: JSON.stringify({ 
      error: 'ACCESS_PASSWORD not set in environment variables',
      debug: { hasAnthropicKey, hasPassword, action }
    })};
  }

  if (password !== process.env.ACCESS_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ 
      error: 'Invalid password',
      debug: { action, passwordLength: password?.length }
    })};
  }

  // Password correct — handle actions
  if (action === 'auth') {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (action === 'europe_pmc') {
    const { query, limit = 15 } = body;
    try {
      const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&resultType=core&pageSize=${Math.min(limit,25)}&format=json&sort=RELEVANCE`;
      console.log('Fetching Europe PMC:', url);
      const response = await fetch(url);
      const data = await response.json();
      console.log('Europe PMC hits:', data.hitCount, 'results:', data.resultList?.result?.length);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch(e) {
      console.error('Europe PMC error:', e.message);
      return { statusCode: 200, headers, body: JSON.stringify({ resultList: { result: [] }, error: e.message }) };
    }
  }

  if (action === 'semantic_scholar') {
    const { query, year_filter, limit = 15 } = body;
    try {
      const fields = 'title,year,citationCount,authors,publicationVenue,isOpenAccess,openAccessPdf,externalIds,abstract';
      const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${Math.min(limit,25)}&fields=${fields}${year_filter||''}`;
      console.log('Fetching Semantic Scholar:', url);
      const response = await fetch(url);
      console.log('SS status:', response.status);
      if (!response.ok) return { statusCode: 200, headers, body: JSON.stringify({ data: [], error: `SS HTTP ${response.status}` }) };
      const data = await response.json();
      console.log('SS results:', data.data?.length);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch(e) {
      console.error('SS error:', e.message);
      return { statusCode: 200, headers, body: JSON.stringify({ data: [], error: e.message }) };
    }
  }

  if (action === 'pubmed_search') {
    const { query, reldate, limit = 10 } = body;
    try {
      const dateFilter = reldate ? `&datetype=pdat&reldate=${reldate}` : '';
      const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${Math.min(limit*2,100)}&retmode=json&sort=relevance${dateFilter}`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();
      const pmids = searchData.esearchresult?.idlist || [];
      if (pmids.length === 0) return { statusCode: 200, headers, body: JSON.stringify({ result: {}, pmids: [] }) };
      const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json`;
      const summaryRes = await fetch(summaryUrl);
      const summaryData = await summaryRes.json();
      return { statusCode: 200, headers, body: JSON.stringify({ ...summaryData, pmids }) };
    } catch(e) {
      return { statusCode: 200, headers, body: JSON.stringify({ result: {}, pmids: [], error: e.message }) };
    }
  }

  if (action === 'claude') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
    const { messages, system, max_tokens = 4000, model = 'claude-opus-4-5' } = body;
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens, system, messages })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (action === 'proxy_url') {
    const { url } = body;
    try {
      const response = await fetch(url);
      const text = await response.text();
      return { statusCode: 200, headers, body: JSON.stringify({ contents: text, status: response.status }) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}`, debug: { action, hasPassword, hasAnthropicKey } }) };
};
