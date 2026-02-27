'use strict';

/**
 * conversation-memory.js — Persistent memory for autonomous conversations.
 *
 * After each conversation turn, Argus extracts noteworthy facts about the person
 * and stores them in Supabase. On the next conversation (even days later), these
 * facts are injected into the system prompt so Argus remembers personal details,
 * preferences, running jokes, and things the person cares about.
 *
 * This is what makes the difference between "talking to a bot" and
 * "talking to someone who knows me."
 *
 * Table: autonomous_user_memory
 *   - slack_user_id TEXT
 *   - fact TEXT (e.g. "Has a son who plays travel baseball")
 *   - category TEXT (personal, work, preference, humor, etc.)
 *   - source_message TEXT (the message that triggered this memory — for audit)
 *   - created_at TIMESTAMPTZ
 *   - expires_at TIMESTAMPTZ (null = permanent)
 */

const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../utils/supabase');

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_MEMORIES_PER_USER = 50;      // Cap to prevent prompt bloat
const MEMORY_EXTRACT_MODEL = 'claude-haiku-4-5';  // Cheap and fast for extraction
const MEMORY_EXTRACT_MAX_TOKENS = 512;

// ── Memory retrieval ──────────────────────────────────────────────────────────

/**
 * Fetch all memories for a Slack user.
 *
 * @param {string} slackUserId
 * @returns {Promise<Array<{fact: string, category: string}>>}
 */
async function getMemories(slackUserId) {
  try {
    const { data, error } = await supabase
      .from('autonomous_user_memory')
      .select('fact, category, created_at')
      .eq('slack_user_id', slackUserId)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(MAX_MEMORIES_PER_USER);

    if (error) {
      console.error('[memory] fetch error:', error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('[memory] getMemories error:', err.message);
    return [];
  }
}

/**
 * Format memories for injection into the system prompt.
 *
 * @param {Array<{fact: string, category: string}>} memories
 * @param {string} displayName
 * @returns {string}
 */
function formatMemories(memories, displayName) {
  if (!memories || memories.length === 0) return '';

  const firstName = displayName.split(/\s+/)[0];
  const lines = [`THINGS YOU REMEMBER ABOUT ${firstName.toUpperCase()}:`];

  // Group by category for cleaner presentation
  const grouped = {};
  for (const m of memories) {
    const cat = m.category || 'general';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(m.fact);
  }

  for (const [category, facts] of Object.entries(grouped)) {
    for (const fact of facts) {
      lines.push(`- ${fact}`);
    }
  }

  lines.push('');
  lines.push('Reference these naturally when relevant. Don\'t force it.');
  lines.push("You KNOW these things the way a colleague does — from past conversations, not a database.");

  return lines.join('\n');
}

// ── Memory extraction (runs after each conversation turn) ─────────────────────

/**
 * Extract memorable facts from the latest exchange and store them.
 * Runs asynchronously after sending the reply — never blocks the response.
 *
 * @param {string} slackUserId
 * @param {string} displayName
 * @param {string} userMessage - What the person just said
 * @param {string} argusReply - What Argus just replied
 * @param {Array<{fact: string}>} existingMemories - Current memories (to avoid duplicates)
 */
async function extractAndStoreMemories(slackUserId, displayName, userMessage, argusReply, existingMemories) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const existingFacts = existingMemories.map(m => m.fact).join('\n- ');

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MEMORY_EXTRACT_MODEL,
      max_tokens: MEMORY_EXTRACT_MAX_TOKENS,
      system: `You extract memorable personal facts from conversations. You are precise and selective.

EXTRACT facts worth remembering about the HUMAN (not the assistant). These include:
- Personal details: family, pets, hobbies, health, where they live
- Work context: projects they're working on, their role, what they care about
- Preferences: food, music, communication style, pet peeves
- Running jokes, shared references, things they find funny
- Plans, goals, things they're looking forward to
- Opinions they've expressed strongly

DO NOT extract:
- Generic pleasantries ("hi", "thanks")
- Things the assistant said (only extract facts about the human)
- Information that's too vague to be useful
- Duplicates of existing memories

EXISTING MEMORIES (do not duplicate these):
${existingFacts ? '- ' + existingFacts : '(none yet)'}

OUTPUT FORMAT:
Return a JSON array of objects. Each object has:
- "fact": a concise statement (e.g. "Has a 12-year-old son named Marcus who plays travel baseball")
- "category": one of: personal, work, preference, humor, plan, opinion

If there is NOTHING worth remembering from this exchange, return an empty array: []

Return ONLY valid JSON. No explanation, no markdown.`,
      messages: [
        {
          role: 'user',
          content: `CONVERSATION EXCHANGE:

${displayName}: ${userMessage}

Argus: ${argusReply}

Extract any new memorable facts about ${displayName}. Return JSON array.`,
        },
      ],
    });

    const textBlock = response.content?.find(b => b.type === 'text');
    if (!textBlock?.text) return;

    let facts;
    try {
      facts = JSON.parse(textBlock.text.trim());
    } catch (e) {
      // Try to extract JSON from markdown code block
      const match = textBlock.text.match(/\[[\s\S]*\]/);
      if (match) {
        try { facts = JSON.parse(match[0]); } catch (_) { return; }
      } else {
        return;
      }
    }

    if (!Array.isArray(facts) || facts.length === 0) return;

    // Store each new fact
    for (const fact of facts) {
      if (!fact.fact || typeof fact.fact !== 'string') continue;
      if (fact.fact.length < 5 || fact.fact.length > 500) continue;

      const { error } = await supabase
        .from('autonomous_user_memory')
        .insert({
          slack_user_id: slackUserId,
          fact: fact.fact,
          category: fact.category || 'general',
          source_message: userMessage.substring(0, 500),
          created_at: new Date().toISOString(),
        });

      if (error) {
        // Might be a duplicate — non-fatal
        console.warn('[memory] insert error:', error.message);
      } else {
        console.log(`[memory] Stored: "${fact.fact}" (${fact.category}) for ${displayName}`);
      }
    }
  } catch (err) {
    console.error('[memory] extractAndStoreMemories error:', err.message);
  }
}

module.exports = { getMemories, formatMemories, extractAndStoreMemories };
