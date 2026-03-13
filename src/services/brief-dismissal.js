'use strict';

/**
 * brief-dismissal.js — Handle brief item dismissals via thread replies.
 *
 * When Colin or Missy reply in the thread of a brief delivery message,
 * this service parses their natural language into structured dismissals,
 * resolves war room items in Supabase, and confirms in the thread.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { WebClient } = require('@slack/web-api');
const supabase = require('../utils/supabase');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// ---------------------------------------------------------------------------
// Permitted dismissers — only these Slack users can dismiss brief items
// ---------------------------------------------------------------------------

const PERMITTED_BRIEF_DISMISSERS = {
  'U0ADV9P2XU5': { name: 'Colin', atlasUserId: '116262192843412290714' },
  'U09CDJ5E3ML': { name: 'Missy', atlasUserId: '116262192843412290714' },
};

// Bot user ID — cached on first call
let _botUserId = null;
async function getBotUserId() {
  if (_botUserId) return _botUserId;
  try {
    const result = await slack.auth.test();
    _botUserId = result.user_id;
  } catch (err) {
    console.error('[brief-dismissal] Could not resolve bot user ID:', err.message);
  }
  return _botUserId;
}

// ---------------------------------------------------------------------------
// isBriefThread — check if a thread's parent is a brief delivery message
// ---------------------------------------------------------------------------

/**
 * Determine whether the given thread is a brief delivery thread.
 * Checks if the parent message was posted by the bot and contains brief markers.
 *
 * @param {string} channelId
 * @param {string} threadTs  - The thread_ts (parent message timestamp)
 * @param {string} slackUserId - The user replying
 * @returns {Promise<boolean>}
 */
async function isBriefThread(channelId, threadTs, slackUserId) {
  // Only process for permitted dismissers
  if (!PERMITTED_BRIEF_DISMISSERS[slackUserId]) return false;

  try {
    // Fetch the parent message
    const result = await slack.conversations.history({
      channel: channelId,
      latest: threadTs,
      inclusive: true,
      limit: 1,
    });

    if (!result.ok || !result.messages?.length) return false;

    const parentMsg = result.messages[0];

    // Also check if the bot posted it
    const botId = await getBotUserId();
    const isFromBot = parentMsg.bot_id || (botId && parentMsg.user === botId);
    if (!isFromBot) return false;

    // Check if parent message looks like a brief delivery
    const text = parentMsg.text || '';
    const files = parentMsg.files || [];
    const hasFiles = files.some(f => {
      const name = f.name || '';
      const title = f.title || '';
      return name.startsWith('atlas-brief-') ||
        name.startsWith('Atlas_Brief_') ||
        title.startsWith('Atlas Intelligence Brief');
    });
    const hasBriefMarker = text.includes('Atlas Intelligence Brief') ||
      text.includes('intelligence brief') ||
      text.includes('📎 Full PDF brief attached.') ||
      text.includes('📎 Full brief for');

    if (hasBriefMarker || hasFiles) return true;

    // Backstop: if a companion message already exists in-thread, trust it
    const itemIndex = await extractItemIndex(channelId, threadTs);
    return Boolean(itemIndex && Object.keys(itemIndex).length > 0);
  } catch (err) {
    console.error('[brief-dismissal] isBriefThread error:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// extractItemIndex — get the item index from the companion message in thread
// ---------------------------------------------------------------------------

/**
 * Extract the item index from the companion message in the brief thread.
 * The companion message contains a ```item_index:{...}``` code block.
 *
 * @param {string} channelId
 * @param {string} threadTs
 * @returns {Promise<object|null>} Item index object or null
 */
async function extractItemIndex(channelId, threadTs) {
  try {
    // Fetch thread replies to find the companion message
    const result = await slack.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 10,
    });

    if (!result.ok || !result.messages) return null;

    // Look for the companion message with item_index metadata
    for (const msg of result.messages) {
      const text = msg.text || '';
      const match = text.match(/```item_index:(\{.*?\})```/s);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch (e) {
          console.warn('[brief-dismissal] Failed to parse item_index JSON:', e.message);
        }
      }
    }

    return null;
  } catch (err) {
    console.error('[brief-dismissal] extractItemIndex error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fallback: load item index from most recent brief in Supabase
// ---------------------------------------------------------------------------

/**
 * Load the most recent brief's war room items from Supabase.
 * Used as fallback when the companion message isn't found.
 *
 * @param {string} atlasUserId
 * @returns {Promise<object|null>}
 */
async function loadItemIndexFromBrief(atlasUserId) {
  try {
    const { data, error } = await supabase
      .from('intelligence_briefs')
      .select('brief_data, date')
      .eq('atlas_user_id', atlasUserId)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data?.brief_data) return null;

    const briefData = typeof data.brief_data === 'string'
      ? JSON.parse(data.brief_data)
      : data.brief_data;

    const warRoom = briefData?.debug?.activeWarRoomPreview || [];
    if (!warRoom.length) return null;

    const itemIndex = {};
    warRoom.forEach((wr, i) => {
      const num = String(i + 1);
      const person = wr.person_name || 'Unknown';
      const excerpt = (wr.excerpt || '').substring(0, 120);
      itemIndex[num] = {
        type: 'war_room',
        id: wr.id || '',
        person,
        text: `${person} — ${excerpt}`,
        score: wr.score || 0,
        source_channel: wr.source_channel || '',
      };
    });

    return { itemIndex, briefDate: data.date };
  } catch (err) {
    console.error('[brief-dismissal] loadItemIndexFromBrief error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// parseDismissalIntent — use Claude to parse natural language dismissals
// ---------------------------------------------------------------------------

/**
 * Use Claude to parse the user's message into structured dismissal intents.
 *
 * @param {string} messageText - The user's message
 * @param {object} itemIndex   - The numbered item index
 * @returns {Promise<object>}  - { items: [1,3], confidence: "high"|"low", notes: "...", clarification?: "..." }
 */
async function parseDismissalIntent(messageText, itemIndex) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  // Build the numbered item list for the prompt
  const itemList = Object.entries(itemIndex)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([num, item]) => `${num}. ${item.text}`)
    .join('\n');

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: `You are parsing a brief item dismissal request. Given a numbered item list and the user's message, determine which items they want to mark as done/resolved/dismissed.

Return ONLY a JSON object (no markdown, no code fences):
- If you can confidently identify the items: {"items": [1, 3], "confidence": "high", "notes": "brief description of what was said"}
- If "all" or "everything" is mentioned: return all item numbers
- If you're unsure or the message is ambiguous: {"items": [], "confidence": "low", "clarification": "A specific question to ask for clarity"}
- If the message is clearly NOT a dismissal request (just a question, greeting, etc.): {"items": [], "confidence": "not_dismissal", "notes": "This doesn't appear to be a dismissal request"}

Be generous in interpretation — "the Ben thing is handled" should match an item with Ben in it. Numbers are unambiguous.`,
    messages: [
      {
        role: 'user',
        content: `Here are the numbered action items from today's brief:\n\n${itemList}\n\nThe user said: "${messageText}"\n\nWhich items are they dismissing?`,
      },
    ],
  });

  const text = response.content?.find(b => b.type === 'text')?.text || '';

  try {
    // Strip any markdown code fences if present
    const cleaned = text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('[brief-dismissal] Failed to parse LLM response:', text);
    return { items: [], confidence: 'low', clarification: 'I had trouble understanding that. Could you try again with item numbers?' };
  }
}

// ---------------------------------------------------------------------------
// handleBriefDismissal — main entry point
// ---------------------------------------------------------------------------

/**
 * Handle a brief item dismissal request from a thread reply.
 *
 * @param {string} slackUserId
 * @param {string} channelId
 * @param {string} threadTs
 * @param {string} messageText
 */
async function handleBriefDismissal(slackUserId, channelId, threadTs, messageText) {
  const dismisser = PERMITTED_BRIEF_DISMISSERS[slackUserId];
  if (!dismisser) {
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "I appreciate the enthusiasm, but only authorized team members can dismiss brief items. 🎩",
    });
    return;
  }

  const { name: dismisserName, atlasUserId } = dismisser;

  // ── Get the item index ─────────────────────────────────────────────────
  let itemIndex = await extractItemIndex(channelId, threadTs);
  let briefDate = null;

  if (!itemIndex) {
    // Fallback: load from most recent brief in Supabase
    console.log('[brief-dismissal] No companion message found, falling back to Supabase brief');
    const fallback = await loadItemIndexFromBrief(atlasUserId);
    if (fallback) {
      itemIndex = fallback.itemIndex;
      briefDate = fallback.briefDate;
    }
  }

  if (!itemIndex || Object.keys(itemIndex).length === 0) {
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "I couldn't find the item list for this brief. This might be an older brief that predates the dismissal feature. 🎩",
    });
    return;
  }

  // ── Parse the user's intent ────────────────────────────────────────────
  const intent = await parseDismissalIntent(messageText, itemIndex);

  // ── Not a dismissal request — let it fall through ──────────────────────
  if (intent.confidence === 'not_dismissal') {
    // Don't handle — this is a regular message that happens to be in a brief thread
    // Post a helpful hint
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `If you'd like to mark items as done, just say which ones — e.g., "1 and 3 are done" or "the Ben Pierson thing is handled". 🎩`,
    });
    return;
  }

  // ── Low confidence — ask for clarification ─────────────────────────────
  if (intent.confidence === 'low') {
    const itemList = Object.entries(itemIndex)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([num, item]) => `${num}. ${item.text}`)
      .join('\n');

    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `I want to make sure I get this right — which item(s) are you referring to?\n\n${itemList}\n\n_Reply with the numbers._ 🎩`,
    });
    return;
  }

  // ── High confidence — process dismissals ───────────────────────────────
  if (!intent.items || intent.items.length === 0) {
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "I didn't catch which items you want to dismiss. Try something like \"1 and 3 are done\". 🎩",
    });
    return;
  }

  const dismissed = [];
  const alreadyDone = [];
  const notFound = [];

  for (const itemNum of intent.items) {
    const key = String(itemNum);
    const item = itemIndex[key];

    if (!item) {
      notFound.push(itemNum);
      continue;
    }

    // ── Check for duplicates ───────────────────────────────────────────
    try {
      const { data: existing } = await supabase
        .from('brief_cc_dismissals')
        .select('id, dismisser_name, dismissed_at')
        .eq('atlas_user_id', atlasUserId)
        .eq('item_number', itemNum)
        .eq('brief_date', briefDate || new Date().toISOString().split('T')[0])
        .is('undone_at', null)
        .limit(1)
        .maybeSingle();

      if (existing) {
        alreadyDone.push({
          num: itemNum,
          text: item.text,
          dismissedBy: existing.dismisser_name,
        });
        continue;
      }
    } catch (err) {
      // Table might not exist yet — continue with dismissal
      console.warn('[brief-dismissal] Duplicate check failed:', err.message);
    }

    // ── Resolve war room situation in Supabase ─────────────────────────
    if (item.type === 'war_room' && item.id) {
      try {
        await supabase
          .from('war_room_situations')
          .update({
            resolved_at: new Date().toISOString(),
            resolved_by: 'cc_dismissal',
          })
          .eq('id', item.id)
          .eq('atlas_user_id', atlasUserId)
          .is('resolved_at', null);

        console.log(`[brief-dismissal] Resolved war room situation: ${item.id} (${item.person})`);
      } catch (err) {
        console.error(`[brief-dismissal] Failed to resolve war room ${item.id}:`, err.message);
      }
    }

    // ── Record in brief_cc_dismissals ──────────────────────────────────
    try {
      const dismissalId = `${atlasUserId}-${key}-${Date.now()}`;
      await supabase
        .from('brief_cc_dismissals')
        .insert({
          id: dismissalId,
          atlas_user_id: atlasUserId,
          dismisser_slack_id: slackUserId,
          dismisser_name: dismisserName,
          item_type: item.type,
          war_room_situation_id: item.type === 'war_room' ? item.id : null,
          brief_date: briefDate || new Date().toISOString().split('T')[0],
          item_number: itemNum,
          item_fingerprint: item.fingerprint || null,
          item_text: item.text,
          matched_text: messageText.substring(0, 500),
          person_name: item.person,
          notes: intent.notes || null,
        });
    } catch (err) {
      console.warn(`[brief-dismissal] Failed to record dismissal for item ${itemNum}:`, err.message);
      // Non-fatal — the war room resolution is what matters most
    }

    dismissed.push({ num: itemNum, text: item.text });
  }

  // ── Build confirmation message ─────────────────────────────────────────
  const parts = [];

  if (dismissed.length > 0) {
    parts.push(`✅ Marked ${dismissed.length} item${dismissed.length > 1 ? 's' : ''} as done:`);
    for (const d of dismissed) {
      parts.push(`• ${d.num}. ${d.text}`);
    }
    parts.push("These won't appear in future briefs.");
  }

  if (alreadyDone.length > 0) {
    for (const a of alreadyDone) {
      parts.push(`ℹ️ Item ${a.num} (${a.text}) was already marked done by ${a.dismissedBy}.`);
    }
  }

  if (notFound.length > 0) {
    parts.push(`⚠️ Item${notFound.length > 1 ? 's' : ''} ${notFound.join(', ')} not found in this brief.`);
  }

  if (parts.length === 0) {
    parts.push("Nothing to update — all those items were already handled. 🎩");
  }

  await slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: parts.join('\n'),
  });

  console.log(`[brief-dismissal] ${dismisserName} dismissed ${dismissed.length} items, ${alreadyDone.length} already done, ${notFound.length} not found`);
}

module.exports = {
  isBriefThread,
  handleBriefDismissal,
  PERMITTED_BRIEF_DISMISSERS,
};
