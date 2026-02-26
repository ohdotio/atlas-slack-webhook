'use strict';

/**
 * fetch-url.js
 * Fetch a URL and return extracted text content.
 * No external dependencies — uses built-in fetch.
 * Truncates to 50KB.
 */

const MAX_CHARS = 50_000;

/**
 * Basic HTML to text extraction.
 */
function htmlToText(html, maxChars = MAX_CHARS) {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';

  let text = html;

  // Remove script, style, nav, header, footer, noscript tags and their content
  text = text.replace(/<(script|style|nav|footer|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Convert links to text (URL) format
  text = text.replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, linkText) => {
    const cleanText = linkText.replace(/<[^>]*>/g, '').trim();
    if (!cleanText) return '';
    if (href.startsWith('#') || href.startsWith('javascript:')) return cleanText;
    return `${cleanText} (${href})`;
  });

  // Convert block elements to newlines
  text = text.replace(/<(br)\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|article|section)>/gi, '\n');
  text = text.replace(/<(p|div|h[1-6]|li|tr|blockquote|article|section)[^>]*>/gi, '\n');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]*>/g, '');

  // Decode HTML entities
  const entities = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&#x27;': "'", '&apos;': "'",
    '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—',
    '&hellip;': '…', '&copy;': '©', '&reg;': '®',
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.replaceAll(entity, char);
  }
  // Numeric entities
  text = text.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  // Truncate
  if (text.length > maxChars) {
    text = text.substring(0, maxChars) + '\n\n[... content truncated at 50KB ...]';
  }

  return { title, text };
}

/**
 * @param {string} atlasUserId
 * @param {{
 *   url: string,
 *   max_chars?: number
 * }} params
 * @returns {Promise<object>}
 */
async function fetchUrl(atlasUserId, {
  url,
  max_chars,
} = {}) {
  try {
    if (!url) return { error: 'url is required' };

    // Validate URL
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (_) {
      return { error: `Invalid URL: ${url}` };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { error: 'Only HTTP and HTTPS URLs are supported.' };
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Atlas/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return { error: `HTTP ${response.status} ${response.statusText}` };
    }

    const contentType = response.headers.get('content-type') || '';
    const effectiveMax = max_chars || MAX_CHARS;

    // If it's plain text or JSON, return directly
    if (contentType.includes('text/plain') || contentType.includes('application/json')) {
      let text = await response.text();
      if (text.length > effectiveMax) {
        text = text.substring(0, effectiveMax) + '\n\n[... content truncated ...]';
      }
      return {
        url,
        title: null,
        content_type: contentType.split(';')[0],
        text,
        chars: text.length,
      };
    }

    // HTML content — extract text
    const html = await response.text();
    const { title, text } = htmlToText(html, effectiveMax);

    return {
      url,
      title: title || null,
      content_type: contentType.split(';')[0],
      text,
      chars: text.length,
    };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { error: `Request timed out after 15 seconds: ${url}` };
    }
    return { error: `fetchUrl failed: ${err.message}` };
  }
}

module.exports = fetchUrl;
