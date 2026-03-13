'use strict';

/**
 * perplexity-search.js
 * Real-time deep search using Perplexity Sonar Pro.
 */

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const DEFAULT_TIMEOUT_MS = 15000;

function normalizeCitations(payload) {
  const rawCitations = [];

  if (Array.isArray(payload?.citations)) rawCitations.push(...payload.citations);

  const choice = payload?.choices?.[0];
  const message = choice?.message || {};

  if (Array.isArray(message?.citations)) rawCitations.push(...message.citations);
  if (Array.isArray(message?.sources)) rawCitations.push(...message.sources);
  if (Array.isArray(choice?.citations)) rawCitations.push(...choice.citations);

  const normalized = [];
  const seen = new Set();

  for (const citation of rawCitations) {
    let url = '';
    let title = '';

    if (typeof citation === 'string') {
      url = citation;
    } else if (citation && typeof citation === 'object') {
      url = citation.url || citation.uri || citation.link || citation.source || '';
      title = citation.title || citation.name || citation.text || '';
    }

    if (!url) continue;
    const key = `${title}::${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ title, url });
  }

  return normalized;
}

/**
 * @param {{ query: string, follow_up_context?: string }} params
 * @returns {Promise<object>}
 */
async function perplexitySearch({ query, follow_up_context } = {}) {
  const apiKey = process.env.PERPLEXITY_API_KEY;

  try {
    if (!apiKey) {
      return { error: 'Perplexity API key not configured' };
    }

    if (!query || !query.trim()) {
      return { error: 'query is required' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const messages = [
      {
        role: 'system',
        content: 'You are a real-time search assistant. Provide accurate, up-to-date information with sources. Be concise but thorough.',
      },
    ];

    if (follow_up_context && follow_up_context.trim()) {
      messages.push({
        role: 'user',
        content: `Follow-up context from the prior search:\n${follow_up_context.trim()}`,
      });
    }

    messages.push({ role: 'user', content: query.trim() });

    const response = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages,
        max_tokens: 1024,
        return_citations: true,
        return_related_questions: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text();
      return {
        error: `Perplexity search failed: HTTP ${response.status} — ${body.substring(0, 300)}`,
        provider: 'perplexity',
      };
    }

    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content?.trim() || '';
    const citations = normalizeCitations(data);

    if (!answer) {
      return {
        error: 'Perplexity search returned no answer',
        provider: 'perplexity',
        query,
        citations,
      };
    }

    return {
      query,
      answer,
      citations,
      provider: 'perplexity',
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { error: 'Perplexity search timed out after 15 seconds', provider: 'perplexity', query };
    }

    return { error: `perplexitySearch failed: ${err.message}`, provider: 'perplexity', query };
  }
}

module.exports = perplexitySearch;
