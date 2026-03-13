'use strict';

const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2-preview';
const GEMINI_EMBEDDING_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent`;
const DEFAULT_BATCH_DELAY_MS = 150;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatLearningText(input, opts = {}) {
  if (typeof input === 'string') return input.trim();
  if (!input || typeof input !== 'object') return '';

  const category = opts.category ?? input.category ?? '';
  const personName = opts.personName ?? opts.person_name ?? input.personName ?? input.person_name ?? '';
  const content = opts.content ?? input.content ?? '';

  return [
    category ? `Category: ${category}` : null,
    personName ? `Person: ${personName}` : null,
    content ? `Content: ${content}` : null,
  ].filter(Boolean).join('\n').trim();
}

function getGeminiApiKey(opts = {}) {
  return opts.apiKey || opts.geminiApiKey || process.env.GEMINI_API_KEY || null;
}

function toPgVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  return `[${vector.map(value => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }).join(',')}]`;
}

async function generateEmbedding(text, opts = {}) {
  const apiKey = getGeminiApiKey(opts);
  if (!apiKey) {
    console.warn('[embeddings] GEMINI_API_KEY not configured');
    return null;
  }

  const formattedText = formatLearningText(text, opts);
  if (!formattedText) return null;

  try {
    const response = await fetch(`${GEMINI_EMBEDDING_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: {
          parts: [{ text: formattedText }],
        },
        taskType: opts.taskType || 'RETRIEVAL_DOCUMENT',
        outputDimensionality: opts.outputDimensionality || 768,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn(`[embeddings] Gemini embed failed (${response.status}): ${body.substring(0, 300)}`);
      return null;
    }

    const data = await response.json();
    const values = data?.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) {
      console.warn('[embeddings] Gemini embed returned no vector');
      return null;
    }

    return values;
  } catch (error) {
    console.warn('[embeddings] generateEmbedding error:', error.message);
    return null;
  }
}

async function generateEmbeddings(texts = [], opts = {}) {
  const results = [];
  const delayMs = opts.delayMs ?? DEFAULT_BATCH_DELAY_MS;

  for (let i = 0; i < texts.length; i++) {
    const item = texts[i];
    const embedding = await generateEmbedding(item, opts);
    results.push(embedding);
    if (delayMs > 0 && i < texts.length - 1) await sleep(delayMs);
  }

  return results;
}

module.exports = {
  GEMINI_EMBEDDING_MODEL,
  formatLearningText,
  generateEmbedding,
  generateEmbeddings,
  toPgVector,
};
