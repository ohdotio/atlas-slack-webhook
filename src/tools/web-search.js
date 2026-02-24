'use strict';

/**
 * web-search.js
 * Search the web using Gemini grounding (preferred) or Brave (fallback).
 * No atlasUserId needed — public data only.
 */

/**
 * @param {{ query: string }} params
 * @returns {Promise<object>}
 */
async function webSearch({ query } = {}) {
  try {
    if (!query || !query.trim()) return { error: 'query is required' };

    const geminiKey = process.env.GEMINI_API_KEY || null;
    const braveKey = process.env.BRAVE_SEARCH_API_KEY || null;

    if (!geminiKey && !braveKey) {
      return { error: 'Web search not available — configure GEMINI_API_KEY or BRAVE_SEARCH_API_KEY env vars.' };
    }

    // Prefer Gemini grounding (free with existing key, uses Google Search)
    if (geminiKey) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(geminiKey)}`;
        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: query }] }],
            tools: [{ google_search: {} }],
          }),
        });

        if (response.ok) {
          const data = await response.json();

          if (!data.error) {
            const candidate = data.candidates?.[0];
            const text = (candidate?.content?.parts || [])
              .map(p => p.text)
              .filter(Boolean)
              .join('\n');

            const grounding = candidate?.groundingMetadata;
            const sources = (grounding?.groundingChunks || [])
              .map(chunk => ({
                title: chunk.web?.title || '',
                url: chunk.web?.uri || '',
              }))
              .filter(s => s.url);

            if (text) {
              return {
                query,
                provider: 'google',
                summary: text,
                source_count: sources.length,
                sources,
              };
            }
          } else {
            console.warn('[web-search] Gemini error:', data.error.message);
          }
        } else {
          console.warn('[web-search] Gemini HTTP error:', response.status);
        }
      } catch (geminiErr) {
        console.warn('[web-search] Gemini exception:', geminiErr.message);
      }
      // Fall through to Brave if Gemini failed
    }

    // Brave Search fallback
    if (braveKey) {
      const count = 5;
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
      const response = await fetch(url, {
        headers: {
          'X-Subscription-Token': braveKey,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const body = await response.text();
        return { error: `Brave search failed: HTTP ${response.status} — ${body.substring(0, 200)}` };
      }

      const data = await response.json();
      const results = (data.web?.results || []).map(r => ({
        title: r.title,
        url: r.url,
        description: r.description || null,
        published: r.page_age || null,
      }));

      return {
        query,
        provider: 'brave',
        result_count: results.length,
        results,
      };
    }

    return { error: 'Web search not available — no API keys configured.' };
  } catch (err) {
    return { error: `webSearch failed: ${err.message}` };
  }
}

module.exports = webSearch;
