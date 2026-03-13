'use strict';

/**
 * argus-cloud.js — Cloud Argus Agent
 *
 * Processes user queries via Claude + Supabase-backed tools.
 * Adapted from argus-headless/src/argus-agent.js for cloud operation.
 * Each user brings their own Anthropic API key stored in ai_settings.
 *
 * Usage:
 *   const { runCloudArgus } = require('./argus-cloud');
 *   const result = await runCloudArgus(atlasUserId, message, conversationHistory, { onStatus, supabase });
 */

const Anthropic = require('@anthropic-ai/sdk');
const defaultSupabase = require('../utils/supabase');
const { generateEmbedding, toPgVector } = require('../utils/embeddings');

// ─── SendBlue conversation injection (fire-and-forget) ───────────────────────
// Injects outbound messages into sendblue_conversations so the autonomous
// handler has context when the recipient replies, and Electron Argus can see
// what was sent. Lightweight — talks to Supabase directly, no shared module.

const DEFAULT_ATLAS_USER_ID = process.env.DEFAULT_ATLAS_USER_ID || '116262192843412290714';

function _injectOutboundToSendblueConvo(phone, atlasUserId, message, contactName, sb) {
  if (!phone || !message) return;
  const userId = atlasUserId || DEFAULT_ATLAS_USER_ID;
  const client = sb || defaultSupabase;

  // Fire-and-forget — don't block the response
  (async () => {
    try {
      // Fetch existing conversation
      const { data: existing } = await client
        .from('sendblue_conversations')
        .select('messages, identity, last_activity')
        .eq('phone', phone)
        .eq('atlas_user_id', userId)
        .maybeSingle();

      const messages = existing?.messages || [];
      // Strip metadata entries
      const cleanMessages = messages.filter(m => m.role !== '_meta');
      cleanMessages.push({ role: 'assistant', content: message });

      // Keep last 100
      const trimmed = cleanMessages.slice(-100);

      await client
        .from('sendblue_conversations')
        .upsert({
          phone,
          atlas_user_id: userId,
          messages: trimmed,
          identity: existing?.identity || (contactName ? { name: contactName, type: 'known_person' } : null),
          last_activity: Date.now(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'phone,atlas_user_id' });

      console.log(`[argus-cloud] Injected outbound into ${contactName || phone}'s SendBlue conversation`);
    } catch (err) {
      console.warn(`[argus-cloud] Failed to inject into SendBlue convo:`, err.message);
    }
  })();
}

// ─── Date/time helpers ────────────────────────────────────────────────────────

const ARGUS_TZ = 'America/New_York';
const DATE_FMT = {
  weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
  timeZone: ARGUS_TZ,
};
const TIME_FMT = {
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  timeZone: ARGUS_TZ,
};

/**
 * Build a ±7/+10 day week reference table anchored on today.
 * Claude must use this table for ALL day/date conversions — never compute
 * day-of-week itself.
 */
function buildWeekReference() {
  const now = new Date();
  const lines = [];
  for (let i = -7; i <= 10; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const label =
      i === 0 ? ' ← TODAY' :
      i === -1 ? ' ← yesterday' :
      i === 1 ? ' ← tomorrow' : '';
    const dateStr = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
      timeZone: ARGUS_TZ,
    });
    const iso = d.toLocaleDateString('en-CA', { timeZone: ARGUS_TZ }); // YYYY-MM-DD
    lines.push(`  ${dateStr} = ${iso}${label}`);
  }
  return lines.join('\n');
}

// ─── Model pricing (per 1M tokens, USD) ──────────────────────────────────────

const MODEL_PRICING = {
  'claude-opus-4-6':           { input: 15,  output: 75 },
  'claude-opus-4-5-20251101':  { input: 15,  output: 75 },
  'claude-opus-4-1-20250805':  { input: 15,  output: 75 },
  'claude-opus-4-20250514':    { input: 15,  output: 75 },
  'claude-sonnet-4-6':         { input: 3,   output: 15 },
  'claude-sonnet-4-5-20250929':{ input: 3,   output: 15 },
  'claude-sonnet-4-20250514':  { input: 3,   output: 15 },
  'claude-haiku-4-5':           { input: 0.8, output: 4  },
};

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const COMPLEX_MODEL = 'claude-opus-4-6';
const LIGHTWEIGHT_MODEL = 'claude-haiku-4-5';

// ─── vNext: 3-tier model router + intent classifier + session memory ─────────

const {
  getSessionMemory: getSessionMemoryFromDB,
  updateSessionMemory: updateSessionMemoryInDB,
  buildSessionContextBlock,
} = require('./session-memory');

/**
 * Fast intent classifier — determines intent, tools needed, and model tier.
 * Uses pattern matching (zero-cost), no LLM call needed.
 */
async function classifyIntent(message, conversationHistory = [], pendingActions = []) {
  let text = message;
  if (Array.isArray(message)) {
    const textPart = message.find(p => p.type === 'text');
    text = textPart?.text || '';
  }
  const lc = (text || '').toLowerCase().trim();
  const wordCount = (text || '').split(/\s+/).length;

  // ── Fast-path: action confirmations ──────────────────────────────────────
  const confirmPatterns = /^(send( it)?|yes|yeah|yep|yup|go|go ahead|do it|ship it|approve|confirmed?|looks? good|that'?s? (good|great|perfect|fine)|ok send|perfect|lgtm|💯|👍|✅)\s*[.!]?$/i;
  if (confirmPatterns.test(lc) && pendingActions.length > 0) {
    return {
      intent: 'action_confirm',
      needsTools: false,
      needsHistory: false,
      suggestedModel: null,
      shortCircuit: true,
    };
  }

  // ── Fast-path: simple tool lookups ───────────────────────────────────────
  const lookupPatterns = /^(what('?s| is|'s)|when('?s| is| did| was)|who('?s| is| did)|check (my |the )?|show (me )?(my )?|get (me )?(my )?|find |look up |pull up )/i;
  const singleQuestion = (text || '').split('?').length <= 2;
  if (lookupPatterns.test(lc) && wordCount <= 20 && singleQuestion) {
    return {
      intent: 'tool_lookup',
      needsTools: true,
      needsHistory: false,
      suggestedModel: LIGHTWEIGHT_MODEL,
    };
  }

  // ── Fast-path: drafting requests ─────────────────────────────────────────
  const draftPatterns = /\b(send|text|message|write|draft|tell|let .* know|check in (on|with)|reach out|dm|slack)\b/i;
  if (draftPatterns.test(lc) && wordCount <= 40) {
    return {
      intent: 'draft',
      needsTools: true,
      needsHistory: true,
      suggestedModel: DEFAULT_MODEL,
    };
  }

  // ── Fast-path: conversation / chitchat ──────────────────────────────────
  if (wordCount <= 10 && !lookupPatterns.test(lc) && !draftPatterns.test(lc) && pendingActions.length === 0) {
    return {
      intent: 'conversation',
      needsTools: false,
      needsHistory: true,
      suggestedModel: LIGHTWEIGHT_MODEL,
    };
  }

  // ── Complex / strategic analysis ─────────────────────────────────────────
  const complexPatterns = [
    /\banalyz[ei]/i, /\bstrateg/i, /\bcompare\b.*\bwith\b/i,
    /\brelationship\b.*\bbetween\b/i, /\bprepare (me |for )/i,
    /\bmeeting prep\b/i, /\bbriefing\b/i, /\bprioritiz/i,
    /\bacross\b.*\b(all|every|channels)\b/i, /\bbreak down\b/i,
    /\bsummariz[ei].*\b(all|everything|history)\b/i,
  ];
  if (wordCount > 50 || complexPatterns.some(p => p.test(lc)) || (text || '').split('?').length > 2) {
    return {
      intent: 'analysis',
      needsTools: true,
      needsHistory: true,
      suggestedModel: COMPLEX_MODEL,
    };
  }

  // ── Default: Sonnet ──────────────────────────────────────────────────────
  return {
    intent: 'conversation',
    needsTools: true,
    needsHistory: true,
    suggestedModel: DEFAULT_MODEL,
  };
}

/**
 * Build a pre-tool plan injection suffix.
 */
function buildToolPlanSuffix(intent) {
  if (intent === 'tool_lookup' || intent === 'draft' || intent === 'analysis') {
    return (
      '\n\n## TOOL PLANNING INSTRUCTION (internal — do not show to user)\n' +
      'Before writing any user-facing text in this turn, determine which tools you need ' +
      'to call and call them IMMEDIATELY. Do not write preamble like "Let me check..." — ' +
      'just make the tool calls. You can write your response AFTER you have the tool results. ' +
      'Minimize tool-loop iterations: batch independent tool calls in a single turn when possible.'
    );
  }
  return '';
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

/**
 * Tool definitions passed to the Claude API.
 * Implementations live in src/tools/; stubs are provided for unimplemented ones.
 */
const TOOLS = [
  // ── Knowledge / read tools ──────────────────────────────────────────────
  {
    name: 'get_person_profile',
    description:
      'Get detailed behavioral profile for a person including synthesis, ' +
      'communication style, values, triggers, how to engage, and recent ' +
      'messages across email, Slack, iMessage, and meetings. Start here ' +
      'before using other search tools when asking about a specific person.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Person name to look up' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_people',
    description:
      'Search for people in the network by name fragment. Returns a list of ' +
      'matches with id, name, company, title, and score. Use when you need to ' +
      'disambiguate or find someone without knowing their full name.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment to search for' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_emails',
    description:
      'Search email history by keyword, person, or date range. Returns ' +
      'subject, body excerpt, date, and direction (inbound/outbound).',
    input_schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Search keywords' },
        person_name: { type: 'string', description: 'Person name to filter by' },
        date_start:  { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        date_end:    { type: 'string', description: 'End date (YYYY-MM-DD)' },
        limit:       { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'search_slack_messages',
    description:
      'Search Slack message history by keyword, channel, or person.',
    input_schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Search keywords' },
        channel:     { type: 'string', description: 'Channel name to filter by' },
        person_name: { type: 'string', description: 'Person name to filter by' },
        date_start:  { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        date_end:    { type: 'string', description: 'End date (YYYY-MM-DD)' },
        limit:       { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'search_imessages',
    description:
      'Search iMessage/SMS history by keyword or person. Note: data is from ' +
      'the last Atlas sync — may be hours behind real-time.',
    input_schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Search keywords' },
        person_name: { type: 'string', description: 'Person name to filter by' },
        date_start:  { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        date_end:    { type: 'string', description: 'End date (YYYY-MM-DD)' },
        limit:       { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'search_beeper_messages',
    description:
      'Search Beeper (unified messenger) message history by keyword or person.',
    input_schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Search keywords' },
        person_name: { type: 'string', description: 'Person name to filter by' },
        date_start:  { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        date_end:    { type: 'string', description: 'End date (YYYY-MM-DD)' },
        limit:       { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'check_calendar',
    description:
      'Get calendar events for a date range. Returns meeting titles, times, ' +
      'attendees, and locations.',
    input_schema: {
      type: 'object',
      properties: {
        date_start: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        date_end:   { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
      required: ['date_start'],
    },
  },
  {
    name: 'search_transcripts',
    description:
      'Search meeting transcripts by keyword, person, or date range. Returns ' +
      'meeting notes, summaries, and full transcript content. Use when the ' +
      'user mentions a meeting, call, or in-person conversation.',
    input_schema: {
      type: 'object',
      properties: {
        query:      { type: 'string', description: 'Search keywords (meeting name, topic, person)' },
        date_start: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        date_end:   { type: 'string', description: 'End date (YYYY-MM-DD)' },
        limit:      { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },

  // ── Action tools ────────────────────────────────────────────────────────
  {
    name: 'store_learning',
    description:
      "Store a correction, preference, or contextual fact learned during " +
      "conversation. Learnings persist across sessions and auto-surface when " +
      "that person's profile is queried.",
    input_schema: {
      type: 'object',
      properties: {
        category:    { type: 'string', enum: ['correction', 'preference', 'context', 'relationship'], description: 'Type of learning' },
        person_name: { type: 'string', description: 'Name of the person this learning is about (optional)' },
        person_id:   { type: 'string', description: 'Person ID if known (optional)' },
        content:     { type: 'string', description: 'The learning itself — be specific and concise' },
        source:      { type: 'string', description: 'How you learned this' },
        confidence:  { type: 'string', enum: ['observed', 'inferred', 'user_confirmed'], description: 'How confident: observed (saw evidence in data), inferred (concluded from patterns/absence), user_confirmed (user explicitly stated). Negative claims should only be user_confirmed if user said so.' },
        priority:    { type: 'string', enum: ['core', 'standard', 'ephemeral'], description: "Memory priority. 'core' = permanent, always loaded. 'standard' = normal (default). 'ephemeral' = temporary, expires after 7 days." },
      },
      required: ['category', 'content'],
    },
  },
  {
    name: 'check_atlas_user',
    description:
      'Check if someone is a registered Atlas user. Search by name or email. ' +
      'Returns their name, email, and when they joined if found. ' +
      'Only Atlas users can use this tool (enforced by the system).',
    input_schema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Name to search for (fuzzy match)' },
        email: { type: 'string', description: 'Email to search for (exact match)' },
      },
    },
  },
  {
    name: 'send_text',
    description:
      'Draft an iMessage/SMS text to someone. Looks up the person by name to find their phone number. ' +
      'WORKFLOW: This creates a pending draft. Show the draft to the principal and ask for confirmation. ' +
      'When approved ("send it", "yes", "go"), use approve_pending_action to execute. ' +
      'If the principal asks for changes, call send_text again with the COMPLETE revised message.',
    input_schema: {
      type: 'object',
      properties: {
        to_name: {
          type: 'string',
          description: 'Recipient name (looked up in the people database for phone number)',
        },
        to_phone: {
          type: 'string',
          description: 'Recipient phone in E.164 format (optional — name lookup preferred)',
        },
        message: {
          type: 'string',
          description: 'The message to send. Write as if the principal is texting them directly — use "I", "me", "my" (first person). Address the recipient as "you". NEVER refer to the recipient in third person ("tell her", "let them know"). NEVER mention the principal by name. The message should read like a natural text FROM the principal TO the recipient.',
        },
        send_style: {
          type: 'string',
          enum: ['celebration', 'shooting_star', 'fireworks', 'lasers', 'love', 'confetti', 'balloons', 'spotlight', 'echo', 'invisible', 'gentle', 'loud', 'slam'],
          description: 'Optional: iMessage visual effect.',
        },
      },
      required: ['to_name', 'message'],
    },
  },
  {
    name: 'draft_slack_dm',
    description:
      'Draft a Slack DM for the user to review before sending. Show the draft and ask for confirmation. ' +
      'WORKFLOW: This creates a pending draft. Show the draft to the principal and ask for confirmation. ' +
      'When approved ("send it", "yes", "go"), use approve_pending_action to execute. ' +
      'If the principal asks for changes, call draft_slack_dm again with the COMPLETE revised message. ' +
      'EVERY revision MUST go through draft_slack_dm. ' +
      'CRITICAL: You MUST call this tool to draft a message. NEVER write a draft in your text response — ' +
      'if you skip this tool, the message cannot be sent when the user says "send".',
    input_schema: {
      type: 'object',
      properties: {
        recipient_name: { type: 'string', description: 'Recipient name or Slack username' },
        message:        { type: 'string', description: 'Message content to draft' },
      },
      required: ['recipient_name', 'message'],
    },
  },
  {
    name: 'send_slack_dm',
    description:
      'PREFER approve_pending_action instead — draft_slack_dm now creates pending actions automatically. ' +
      'Only use send_slack_dm directly if there is no pending action (e.g. sending a quick follow-up). ' +
      'If you generated an image for this message, set include_image to true and it will be attached.',
    input_schema: {
      type: 'object',
      properties: {
        recipient_name:     { type: 'string', description: 'Recipient name' },
        recipient_slack_id: { type: 'string', description: 'Recipient Slack user ID (from draft)' },
        message:            { type: 'string', description: 'Message to send' },
        include_image:      { type: 'boolean', description: 'If true, attach any previously generated image to this DM' },
      },
      required: ['recipient_name', 'message'],
    },
  },

  // ── Analysis tools ──────────────────────────────────────────────────────
  {
    name: 'analyze_conversation',
    description:
      'Analyze conversation dynamics with a person over a date range using ' +
      'LLM intelligence. Use for emotional tone, sentiment trends, topic ' +
      'evolution, relationship dynamics, or any qualitative analysis of ' +
      'message history.',
    input_schema: {
      type: 'object',
      properties: {
        person_name: { type: 'string', description: 'Person name to analyze' },
        topic:       { type: 'string', description: 'What to analyze — e.g., "emotional tone", "key topics", "relationship warmth"' },
        date_range:  { type: 'string', description: 'Date range — e.g., "last 30 days" or "2026-01-01 to 2026-02-01". Defaults to last 90 days.' },
      },
      required: ['person_name'],
    },
  },

  // ── Web search ──────────────────────────────────────────────────────────
  {
    name: 'web_search',
    description:
      "Search the web for general knowledge lookups, background research, " +
      "restaurants, businesses, or anything not in the user's personal data " +
      "when freshness is not the primary concern. Uses Google Search (via " +
      "Gemini) or Brave Search depending on configured API keys. Returns a " +
      "synthesized answer with sources.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results (default 5, max 10)' },
      },
      required: ['query'],
    },
  },

  {
    name: 'live_search',
    description:
      'Real-time deep search powered by Perplexity. Use for: current events, ' +
      'live data (scores, flights, stocks), breaking news, or anything that ' +
      'needs the most up-to-date information. Returns a synthesized answer ' +
      'with citations. Prefer this over web_search when freshness and ' +
      'accuracy matter.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Real-time search query' },
        follow_up_context: { type: 'string', description: 'Optional prior search context for refining the answer' },
      },
      required: ['query'],
    },
  },
  // ── Learning management ──────────────────────────────────────────────────
  {
    name: 'recall_learnings',
    description:
      'Retrieve stored learnings/corrections/preferences.',
    input_schema: {
      type: 'object',
      properties: {
        person_name: { type: 'string', description: 'Filter learnings about a specific person' },
        category:    { type: 'string', enum: ['correction', 'preference', 'context', 'relationship'], description: 'Filter by category' },
        query:       { type: 'string', description: 'Free-text search across all learnings' },
      },
    },
  },
  {
    name: 'edit_learning',
    description:
      'Edit an existing stored learning.',
    input_schema: {
      type: 'object',
      properties: {
        learning_id: { type: 'string', description: 'The ID of the learning to edit' },
        content:     { type: 'string', description: 'Updated content (optional)' },
        category:    { type: 'string', enum: ['correction', 'preference', 'context', 'relationship'], description: 'Updated category (optional)' },
        person_name: { type: 'string', description: 'Updated person name (optional)' },
        source:      { type: 'string', description: 'Updated source (optional)' },
      },
      required: ['learning_id'],
    },
  },
  {
    name: 'delete_learning',
    description:
      'Delete (deactivate) a stored learning.',
    input_schema: {
      type: 'object',
      properties: {
        learning_id: { type: 'string', description: 'The ID of the learning to delete' },
        reason:      { type: 'string', description: 'Why this learning is being deleted' },
      },
      required: ['learning_id'],
    },
  },

  // ── Reminders ────────────────────────────────────────────────────────────
  {
    name: 'reminder',
    description:
      'Manage reminders — create, list, update, or cancel. Use when someone asks to be reminded ' +
      'about something, wants to see their reminders, or needs to change/cancel one.\n\n' +
      'For CREATE: if the user gives a clear date, create it. If the date is vague or missing, ' +
      'return needs_clarification and ask conversationally. Infer recurrence from context: ' +
      'birthdays/anniversaries → yearly, "every Monday" → weekly, "every month" → monthly, ' +
      'otherwise → once.\n\n' +
      'For LIST: returns all active reminders.\n' +
      'For UPDATE: change advance_days, remind_date, content, or recurrence.\n' +
      'For CANCEL: deactivate a reminder by ID or description.',
    input_schema: {
      type: 'object',
      properties: {
        action:        { type: 'string', enum: ['create', 'list', 'update', 'cancel'], description: 'What to do' },
        content:       { type: 'string', description: 'What to remind about (create/update)' },
        remind_date:   { type: 'string', description: 'When — YYYY-MM-DD, or natural language like "next Monday", "March 15", "in 2 weeks", "tomorrow" (create/update). For same-day reminders, still set date to today. Leave empty to ask the user.' },
        remind_time:   { type: 'string', description: 'Time of day in HH:MM 24h format (ET). Use for "remind me at 3pm" → "15:00". Omit for date-only reminders (notified in morning).' },
        recurrence:    { type: 'string', enum: ['once', 'yearly', 'weekly', 'monthly'], description: 'How often (default: once). Birthdays/anniversaries should be yearly.' },
        advance_days:  { type: 'number', description: 'Days before to start notifying (default: 0 for once, 3 for yearly). User can override: "remind me a week before" → 7.' },
        person_name:   { type: 'string', description: 'Person this reminder is about (optional)' },
        person_id:     { type: 'string', description: 'Person ID if known (optional)' },
        reminder_id:   { type: 'string', description: 'Reminder UUID for update/cancel' },
        reminder_desc: { type: 'string', description: 'Description to match for update/cancel if no ID (fuzzy match)' },
      },
      required: ['action'],
    },
  },

  // ── War Room ──────────────────────────────────────────────────────────────
  {
    name: 'get_war_room',
    description:
      'Get all active War Room situations — urgent items requiring attention ' +
      '(unanswered emails, missed follow-ups, stale conversations with important ' +
      'contacts). Returns situation type, person, excerpt, score, and reasoning.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_war_room_by_person',
    description:
      'Get War Room situations related to a specific person (active, resolved, ' +
      'and dismissed). Use to check if there are any pending issues or past ' +
      'situations with someone.',
    input_schema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'Person name to look up' },
      },
      required: ['person'],
    },
  },

  // ── iMessage stats ────────────────────────────────────────────────────────
  {
    name: 'get_imessage_stats',
    description:
      'Get iMessage/SMS statistics and aggregates. Use for questions about ' +
      'message volume, counts per day, top senders, inbound vs outbound breakdown.',
    input_schema: {
      type: 'object',
      properties: {
        date_start: { type: 'string', description: 'Start date (YYYY-MM-DD), default 14 days ago' },
        date_end:   { type: 'string', description: 'End date (YYYY-MM-DD), default today' },
        group_by:   { type: 'string', description: 'Group by: day, week, month, person (default: day)' },
        direction:  { type: 'string', description: 'Filter by: inbound, outbound, or all (default: all)' },
      },
    },
  },

  // ── URL fetching ──────────────────────────────────────────────────────────
  {
    name: 'fetch_url',
    description:
      'Fetch and read the content of a web page URL. Returns extracted text from ' +
      'HTML. Use when the user shares a URL and wants you to read, summarize, or ' +
      'analyze the page content. Works for articles, docs, blog posts, product pages. ' +
      'Does NOT work for pages that require JavaScript rendering or authentication.',
    input_schema: {
      type: 'object',
      properties: {
        url:       { type: 'string', description: 'The URL to fetch' },
        max_chars: { type: 'number', description: 'Maximum characters to return (default 50000)' },
      },
      required: ['url'],
    },
  },

  // ── Google Calendar tools ─────────────────────────────────────────────────
  {
    name: 'check_availability',
    description:
      'Check free/busy availability for one or more people via Google Calendar ' +
      'FreeBusy API. Returns busy blocks and free windows for each person on a given day.',
    input_schema: {
      type: 'object',
      properties: {
        emails:     { type: 'string', description: 'Comma-separated email addresses to check' },
        date:       { type: 'string', description: 'Date to check (YYYY-MM-DD)' },
        time_start: { type: 'string', description: 'Start of work window HH:MM (default "09:00")' },
        time_end:   { type: 'string', description: 'End of work window HH:MM (default "17:00")' },
        timezone:   { type: 'string', description: 'Timezone (default "America/New_York")' },
      },
      required: ['emails', 'date'],
    },
  },
  {
    name: 'find_meeting_time',
    description:
      "Find mutual free slots where all attendees are available for a meeting " +
      "of a given duration. Returns up to 5 best slots sorted earliest first.",
    input_schema: {
      type: 'object',
      properties: {
        emails:           { type: 'string', description: "Comma-separated email addresses (user's calendar is always included)" },
        duration_minutes: { type: 'number', description: 'Required meeting duration in minutes' },
        date_start:       { type: 'string', description: 'Earliest date to search (YYYY-MM-DD)' },
        date_end:         { type: 'string', description: 'Latest date to search (YYYY-MM-DD, default same as date_start)' },
        time_earliest:    { type: 'string', description: 'Earliest start time HH:MM (default "09:00")' },
        time_latest:      { type: 'string', description: 'Latest end time HH:MM (default "17:00")' },
        timezone:         { type: 'string', description: 'Timezone (default "America/New_York")' },
      },
      required: ['emails', 'duration_minutes', 'date_start'],
    },
  },
  {
    name: 'draft_calendar_event',
    description:
      'Draft a calendar event for user review, or create it after confirmation. ' +
      'First call WITHOUT confirmed to show the draft. ' +
      'When user approves, call AGAIN with confirmed=true and the SAME parameters to actually create.',
    input_schema: {
      type: 'object',
      properties: {
        title:            { type: 'string', description: 'Event title' },
        start_time:       { type: 'string', description: 'Start time (ISO 8601)' },
        duration_minutes: { type: 'number', description: 'Duration in minutes' },
        attendees:        { type: 'string', description: 'Comma-separated email addresses' },
        location:         { type: 'string', description: 'Location or video call link' },
        description:      { type: 'string', description: 'Event description' },
        color:            { type: 'string', description: 'Event color: lavender, sage, grape, flamingo, banana, tangerine, peacock, graphite, blueberry, basil, or tomato' },
        calendarId:       { type: 'string', description: 'Calendar ID (default: primary). Use the calendar email address.' },
        confirmed:        { type: 'boolean', description: 'Set to true to actually create the event after user has confirmed the draft' },
      },
      required: ['title', 'start_time', 'duration_minutes'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Update an existing calendar event. Shows changes for review first. ' +
      'When user approves, call AGAIN with confirmed=true to apply.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:         { type: 'string', description: 'Google Calendar event ID' },
        title:            { type: 'string', description: 'New event title' },
        start_time:       { type: 'string', description: 'New start time (ISO 8601)' },
        duration_minutes: { type: 'number', description: 'New duration in minutes' },
        description:      { type: 'string', description: 'New event description' },
        location:         { type: 'string', description: 'New location or video call link' },
        attendees:        { type: 'string', description: 'New comma-separated attendee emails (replaces existing list)' },
        color:            { type: 'string', description: 'New color name or numeric ID 1-11' },
        confirmed:        { type: 'boolean', description: 'Set to true to actually apply the update after user confirms' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Delete a calendar event. Shows event details for review first. ' +
      'When user approves, call AGAIN with confirmed=true to actually delete.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:  { type: 'string', description: 'Google Calendar event ID to delete' },
        confirmed: { type: 'boolean', description: 'Set to true to actually delete the event after user confirms' },
      },
      required: ['event_id'],
    },
  },

  // ── Gmail API tools ───────────────────────────────────────────────────────
  {
    name: 'gmail_search',
    description:
      'Search Gmail directly via API for recent emails not yet synced. Use when ' +
      'local email data seems incomplete. Returns full details for all results (up to 25).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (supports Gmail operators like from:, to:, subject:, is:unread, after:, before:)' },
        limit: { type: 'number', description: 'Max results to fetch (default 20, max 100). All fetched results get full details loaded.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_email',
    description:
      'Read the complete body and full details of an email by its Gmail message ID. ' +
      'Use after gmail_search or search_emails to get the full content.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID (from gmail_search or search_emails results)' },
        format:     { type: 'string', description: '"full" (default) or "minimal"' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'draft_email',
    description:
      'Draft an email for user review, or send a previously drafted email. ' +
      'First call WITHOUT confirmed to show the draft. ' +
      'When the user approves (says "send it", "yes", "approve", etc.), call AGAIN with confirmed=true and the SAME parameters to actually send.',
    input_schema: {
      type: 'object',
      properties: {
        to:        { type: 'string', description: 'Recipient email address' },
        subject:   { type: 'string', description: 'Email subject line' },
        body:      { type: 'string', description: 'Email body (plain text)' },
        cc:        { type: 'string', description: 'CC recipients (comma-separated)' },
        threadId:  { type: 'string', description: 'Gmail thread ID for replies' },
        inReplyTo: { type: 'string', description: 'Message-ID being replied to' },
        confirmed: { type: 'boolean', description: 'Set to true to actually send the email after user has confirmed the draft' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gmail_draft',
    description:
      "Save, update, list, or delete drafts in Gmail's Drafts folder. " +
      "Create/update does NOT require confirmation. Delete requires confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        action:    { type: 'string', enum: ['create', 'update', 'list', 'delete'], description: 'Operation to perform' },
        to:        { type: 'string', description: 'Recipient email address (for create)' },
        subject:   { type: 'string', description: 'Email subject (for create/update)' },
        body:      { type: 'string', description: 'Email body (for create/update)' },
        cc:        { type: 'string', description: 'CC recipients (for create/update)' },
        draft_id:  { type: 'string', description: 'Draft ID (for update/delete)' },
        thread_id: { type: 'string', description: 'Thread ID to associate draft with (for reply drafts)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mark_email',
    description:
      'Mark one or more emails as read or unread. Accepts a single message ID or ' +
      'comma-separated IDs for batch.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID, or comma-separated IDs for batch' },
        action:     { type: 'string', enum: ['read', 'unread'], description: '"read" removes UNREAD label; "unread" adds it' },
      },
      required: ['message_id', 'action'],
    },
  },
  {
    name: 'manage_email_labels',
    description:
      'Manage Gmail labels: list all labels, apply/remove a label, archive, trash, or untrash an email.',
    input_schema: {
      type: 'object',
      properties: {
        action:     { type: 'string', enum: ['list_labels', 'apply', 'remove', 'archive', 'trash', 'untrash'], description: 'Operation to perform' },
        message_id: { type: 'string', description: 'Gmail message ID (required for apply/remove/archive/trash/untrash)' },
        label_name: { type: 'string', description: 'Label name for apply/remove (e.g., "IMPORTANT", "STARRED", or a custom label name)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'read_google_doc',
    description:
      'Read the content of a Google Doc, Google Slides presentation, Google Sheet, or uploaded file in Google Drive. ' +
      'Accepts a Google Drive/Docs/Slides/Sheets URL or a raw file ID. ' +
      'Returns the full text content of the document. ' +
      'Use when the user asks you to read, review, summarize, or reference a Google Doc, presentation, or spreadsheet. ' +
      'Also works with uploaded .docx and .pptx files in Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        file_url_or_id: {
          type: 'string',
          description: 'Google Drive URL (e.g., "https://docs.google.com/document/d/abc123/edit") or raw file ID.',
        },
      },
      required: ['file_url_or_id'],
    },
  },
  {
    name: 'schedule_email',
    description:
      'Queue an email to be sent at a specific date and time. Creates a Gmail draft ' +
      'and saves schedule metadata. Shows draft for review first. ' +
      'When user approves, call AGAIN with confirmed=true to actually schedule.',
    input_schema: {
      type: 'object',
      properties: {
        to:        { type: 'string', description: 'Recipient email address' },
        subject:   { type: 'string', description: 'Email subject' },
        body:      { type: 'string', description: 'Email body' },
        cc:        { type: 'string', description: 'CC recipients (optional)' },
        send_at:   { type: 'string', description: 'ISO 8601 datetime for when to send (e.g., "2026-03-01T09:00:00-05:00")' },
        thread_id: { type: 'string', description: 'Thread ID for reply threading (optional)' },
        confirmed: { type: 'boolean', description: 'Set to true to actually schedule the email after user confirms the draft' },
      },
      required: ['to', 'subject', 'body', 'send_at'],
    },
  },

  // ── Image generation tools ──────────────────────────────────────────────
  {
    name: 'generate_image',
    description: 'Generate an image using Google Gemini. Returns the image which is automatically sent to the Slack conversation. Use for any request to create, generate, draw, or visualize an image.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
          description: 'Aspect ratio of the generated image. Default: 1:1',
        },
      },
      required: ['prompt'],
    },
  },

  // ── Pending Actions & Conversation Control tools ─────────────────────────
  {
    name: 'approve_pending_action',
    description:
      'Approve and execute a pending action (send a draft, grant a permission, release data). ' +
      'THIS IS THE "SEND" BUTTON. When the principal says "send", "yes", "go", "approve", "do it", ' +
      '"looks good", "ship it", or any affirmative — call this tool. ' +
      'Check SITUATIONAL AWARENESS for the list of pending actions and their IDs. ' +
      'If there is only one pending action, you can omit action_id. ' +
      'If the principal gives modifications ("make it funnier", "change it to..."), pass modifications ' +
      'and the action will be removed so you can re-draft.',
    input_schema: {
      type: 'object',
      properties: {
        action_id: { type: 'string', description: 'ID of the pending action to approve (from SITUATIONAL AWARENESS).' },
        modifications: { type: 'string', description: 'If the principal wants changes, describe them here.' },
      },
    },
  },
  {
    name: 'deny_pending_action',
    description: 'Deny/cancel a pending action. Use when principal says "no", "cancel", "skip", "nevermind".',
    input_schema: {
      type: 'object',
      properties: {
        action_id: { type: 'string', description: 'ID of the pending action to deny.' },
        reason: { type: 'string', description: 'Optional redirect instructions.' },
      },
    },
  },
  {
    name: 'request_cross_user_data',
    description:
      'Request access to another Atlas user\'s private data. Use when the principal asks about ' +
      'someone else\'s calendar, emails, or schedule, and that person is an Atlas user with their ' +
      'own data. The target user will be notified and decides what to share. ' +
      'Do NOT use for people in the principal\'s own contact list — only for other Atlas users.',
    input_schema: {
      type: 'object',
      properties: {
        target_user_name: { type: 'string', description: 'Name of the Atlas user whose data is needed' },
        question: { type: 'string', description: 'The original question being asked' },
        data_type: {
          type: 'string',
          enum: ['calendar', 'email', 'contacts', 'schedule', 'general'],
          description: 'Type of private data needed',
        },
      },
      required: ['target_user_name', 'question', 'data_type'],
    },
  },
  {
    name: 'grant_permission',
    description:
      'Grant scoped permission for Argus to share specific data with a contact. ' +
      'Use when principal says things like "Seth can know about the Gordon deal", ' +
      '"tell her my schedule Thursday", "Jenna can always know my availability". ' +
      'Permissions are time-limited (default 24h) and topic-scoped.',
    input_schema: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Who gets the permission.' },
        contact_phone: { type: 'string', description: 'Phone number (E.164) if known.' },
        scope: { type: 'string', description: 'What they can know (e.g., "Thursday availability", "Gordon/Ratmir deal details").' },
        hours: { type: 'number', description: 'How many hours the permission lasts. Default 24.' },
      },
      required: ['contact_name', 'scope'],
    },
  },
  {
    name: 'propose_data_release',
    description:
      'After fetching private data (calendar, emails, etc.), propose a message to send to a contact. ' +
      'Creates a pending data_release action the principal must approve before it\'s sent.',
    input_schema: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Who to send the data to.' },
        contact_phone: { type: 'string', description: 'Phone number (E.164).' },
        proposed_message: { type: 'string', description: 'The exact message you\'d send. Write as Argus (butler voice).' },
        data_summary: { type: 'string', description: 'Brief summary of what private data this contains.' },
      },
      required: ['contact_name', 'proposed_message'],
    },
  },
  {
    name: 'steer_conversation',
    description:
      'Inject direction into an active autonomous conversation with a contact. ' +
      'Use when the principal says "tell her I\'m busy", "ask him about the deal", "be more casual". ' +
      'The direction gets woven into Argus\'s next response naturally.',
    input_schema: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Name of the contact.' },
        contact_identifier: { type: 'string', description: 'Phone or Slack user ID.' },
        direction: { type: 'string', description: 'The steering direction.' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'wind_down_conversation',
    description:
      'Tell Argus to wrap up and go quiet with a contact. ' +
      'Argus sends one final natural wrap-up message, then stops responding.',
    input_schema: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Name of the contact.' },
        contact_identifier: { type: 'string', description: 'Phone or Slack user ID.' },
        hours: { type: 'number', description: 'Hours to stay quiet. 0 = until further notice.' },
      },
    },
  },
  {
    name: 'resume_conversation',
    description: 'Resume responding to a contact after being silenced or wound down.',
    input_schema: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Name of the contact.' },
        contact_identifier: { type: 'string', description: 'Phone or Slack user ID.' },
      },
    },
  },

  // ── Meta tools ──────────────────────────────────────────────────────────
  {
    name: 'ask_user',
    description:
      'Ask the user for clarification when the query is ambiguous. Use this ' +
      'rather than guessing.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The clarifying question to ask' },
        options:  { type: 'array', items: { type: 'string' }, description: 'Optional list of answer choices' },
      },
      required: ['question'],
    },
  },
];

// ─── Tool implementations ─────────────────────────────────────────────────────

/**
 * Try to load a tool module from src/tools/. Returns null if not found.
 * Modules are cached by Node's require() — no perf concern on repeat calls.
 */
// Map Claude tool names → tool file names (underscore → hyphen)
const TOOL_FILE_MAP = {
  get_person_profile: 'get-person',
  search_people: 'get-person',  // same module, different query
  search_emails: 'search-emails',
  search_slack_messages: 'search-slack',
  search_imessages: 'search-imessages',
  search_beeper_messages: 'search-beeper',
  check_calendar: 'check-calendar',
  search_transcripts: 'search-transcripts',
  store_learning: 'store-learning',
  web_search: 'web-search',
  live_search: 'perplexity-search',
  draft_slack_dm: 'draft-slack-dm',
  send_slack_dm: null,
  analyze_conversation: 'analyze-conversation',
  reminder: null,  // handled inline
  // Phase 1: Supabase-only tools
  get_war_room: 'get-war-room',
  get_war_room_by_person: 'get-war-room',  // same module, filtered by person
  recall_learnings: 'recall-learnings',
  edit_learning: 'edit-learning',
  delete_learning: 'delete-learning',
  fetch_url: 'fetch-url',
  get_imessage_stats: 'get-imessage-stats',
  // Phase 2: Google API tools
  check_availability: 'check-availability',
  find_meeting_time: 'find-meeting-time',
  draft_calendar_event: 'draft-calendar-event',
  update_calendar_event: 'update-calendar-event',
  delete_calendar_event: 'delete-calendar-event',
  gmail_search: 'gmail-search',
  get_email: 'get-email',
  gmail_draft: 'gmail-draft',
  draft_email: 'draft-email',
  mark_email: 'mark-email',
  manage_email_labels: 'manage-email-labels',
  read_google_doc: 'read-google-doc',
  schedule_email: 'schedule-email',
};

function tryLoadTool(toolName) {
  const fileName = TOOL_FILE_MAP[toolName] || toolName.replace(/_/g, '-');
  try {
    return require(`../tools/${fileName}`);
  } catch (_) {
    return null;
  }
}

/**
 * Execute a named tool with the given input and context.
 *
 * Context shape:
 *   { atlasUserId, supabase, sendStatus, model, apiKey }
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} context
 * @returns {Promise<object>}
 */
async function executeTool(toolName, toolInput, context) {
  let { atlasUserId, supabase, sendStatus, model, apiKey, generatedImages } = context;
  if (!supabase) supabase = require('../utils/supabase');

  console.log(
    `[Argus-Cloud Tool] ${toolName}`,
    JSON.stringify(toolInput).substring(0, 200),
  );

  // ── web_search: fully implemented here (no local dependencies) ──────────
  if (toolName === 'web_search') {
    return executeWebSearch(toolInput, { atlasUserId, supabase, sendStatus });
  }

  if (toolName === 'live_search') {
    const liveSearch = tryLoadTool('live_search');
    if (!liveSearch) return { error: 'live_search tool is not available.' };
    return await liveSearch(toolInput);
  }

  // ── store_learning: implemented here (direct Supabase write) ────────────
  if (toolName === 'store_learning') {
    return executeStoreLearning(toolInput, { atlasUserId, supabase, sendStatus });
  }

  // ── reminder: create/list/update/cancel reminders ─────────────────────
  if (toolName === 'reminder') {
    return executeReminder(toolInput, { atlasUserId, supabase, sendStatus, apiKey });
  }

  // ── check_atlas_user: query user table by name or email ─────────────────
  if (toolName === 'check_atlas_user') {
    if (!supabase) supabase = require('../utils/supabase');
    const { name, email } = toolInput;

    if (!name && !email) {
      return { found: false, error: 'Provide a name or email to search for.' };
    }

    let query = supabase.from('user').select('id, name, email, created_at');

    if (email) {
      query = query.ilike('email', email.trim());
    } else if (name) {
      // Fuzzy: match if name contains the search term (case-insensitive)
      query = query.ilike('name', `%${name.trim()}%`);
    }

    const { data, error } = await query.limit(5);

    if (error) {
      console.error('[check_atlas_user] Query error:', error.message);
      return { found: false, error: 'Failed to query user directory.' };
    }

    if (!data || data.length === 0) {
      return { found: false, message: `No Atlas user found matching "${name || email}".` };
    }

    const users = data.map(u => ({
      name: u.name,
      email: u.email,
      joined: u.created_at ? new Date(u.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'unknown',
    }));

    return {
      found: true,
      count: users.length,
      users,
    };
  }

  // ── send_text: draft iMessage/SMS via Sendblue ───────────────────────────
  if (toolName === 'send_text') {
    const toName = toolInput.to_name;
    const message = toolInput.message;

    // Resolve phone number: check people table first (phone column + profile_data), then user table
    let toPhone = toolInput.to_phone || null;
    if (!toPhone) {
      // 1. Check people table — phone column first
      const { data: people } = await supabase
        .from('people')
        .select('id, name, phone, email, profile_data')
        .eq('atlas_user_id', atlasUserId)
        .ilike('name', `%${toName}%`)
        .eq('archived', 0)
        .order('score', { ascending: false })
        .limit(5);

      if (people && people.length > 0) {
        for (const match of people) {
          // Try phone column first
          if (match.phone) {
            toPhone = match.phone.split(',')[0].trim();
            break;
          }
          // Fall back to profile_data.identifiers.phones
          if (match.profile_data) {
            try {
              const pd = typeof match.profile_data === 'string' ? JSON.parse(match.profile_data) : match.profile_data;
              const phones = pd?.identifiers?.phones;
              if (phones && phones.length > 0 && phones[0].length > 5) {
                toPhone = phones[0];
                console.log(`[send_text] Found phone for ${match.name} via profile_data: ${toPhone}`);
                break;
              }
            } catch (e) { /* ignore parse errors */ }
          }
        }
      }

      // 2. Fallback: check Atlas user table (verified phone numbers)
      if (!toPhone) {
        const { data: users } = await supabase
          .from('user')
          .select('name, phone, email')
          .ilike('name', `%${toName}%`)
          .not('phone', 'is', null)
          .limit(3);

        if (users && users.length > 0) {
          toPhone = users[0].phone;
          console.log(`[send_text] Found phone for ${toName} via user table: ${toPhone}`);
        }
      }

      // 3. Fallback: check sendblue_conversations (recent text history)
      if (!toPhone) {
        try {
          const { data: sbConvos } = await supabase
            .from('sendblue_conversations')
            .select('from_number, to_number, contact_name')
            .or(`contact_name.ilike.%${toName}%`)
            .order('created_at', { ascending: false })
            .limit(5);

          if (sbConvos && sbConvos.length > 0) {
            const argusPhone = '+12347361063';
            const match = sbConvos[0];
            toPhone = match.from_number === argusPhone ? match.to_number : match.from_number;
            console.log(`[send_text] Found phone for ${toName} via sendblue_conversations: ${toPhone}`);
          }
        } catch (e) {
          console.warn(`[send_text] sendblue_conversations lookup failed:`, e.message);
        }
      }

      if (!toPhone) {
        return { error: `Could not find a phone number for "${toName}". They may not have a number on file or haven't verified their phone.` };
      }

      // Normalize
      let clean = toPhone.replace(/[\s\-\(\)\.]/g, '');
      if (/^\d{10}$/.test(clean)) clean = '+1' + clean;
      if (/^1\d{10}$/.test(clean)) clean = '+' + clean;
      toPhone = clean;
    }

    // Create pending action for approval
    const { addPendingAction } = require('./pending-actions');
    const actionId = await addPendingAction(atlasUserId, {
      type: 'draft_approval',
      contact_name: toName,
      contact_phone: toPhone,
      draft_message: message,
      send_style: toolInput.send_style || null,
      source: 'slack',
    });

    const draftPreview = `To ${toName} (${toPhone}):\n\n"${message}"${toolInput.send_style ? `\n✨ Effect: ${toolInput.send_style}` : ''}`;

    return {
      type: 'text_draft',
      needs_confirmation: true,
      action_id: actionId,
      preview: draftPreview,
      draft: {
        to_name: toName,
        to_phone: toPhone,
        message,
        send_style: toolInput.send_style || null,
      },
      note: 'Show the full draft to the principal. Include recipient name AND phone number. Ask "Send it?"',
    };
  }

  // ── Pending Actions tools ────────────────────────────────────────────────
  if (toolName === 'approve_pending_action') {
    const { getPendingActions, removePendingAction, claimPendingAction } = require('./pending-actions');
    const actions = await getPendingActions(atlasUserId);

    if (actions.length === 0) {
      return { error: 'No pending actions found.' };
    }

    const action = toolInput.action_id
      ? actions.find(a => a.id === toolInput.action_id)
      : actions[0];

    if (!action) {
      return { error: `Pending action ${toolInput.action_id} not found. Active: ${actions.map(a => a.id).join(', ')}` };
    }

    if (toolInput.modifications) {
      await removePendingAction(atlasUserId, action.id);
      return {
        type: 'modification_requested',
        original: action,
        modifications: toolInput.modifications,
        note: `Original action removed. Apply the modifications and re-draft.`,
      };
    }

    // Atomic claim — prevents double-send
    const claimed = await claimPendingAction(atlasUserId, action.id);
    if (!claimed) {
      return { success: false, error: `Action ${action.id} was already executed or expired.` };
    }

    if (action.type === 'draft_approval') {
      // Route based on channel: Slack DM vs iMessage/SMS
      if (action.channel === 'slack' && action.contact_slack_id) {
        // Execute via Slack DM
        sendStatus(`Sending to ${action.contact_name} on Slack...`);
        try {
          const slackResult = await executeSendSlackDm(
            {
              recipient_name: action.contact_name,
              recipient_slack_id: action.contact_slack_id,
              message: action.draft_message,
              include_image: !!(action.media_url),
            },
            { atlasUserId, supabase, sendStatus, generatedImages }
          );
          if (slackResult.error) {
            return { error: `Failed to send Slack DM: ${slackResult.error}` };
          }
          await removePendingAction(atlasUserId, action.id);
          return {
            type: 'draft_sent',
            contact_name: action.contact_name,
            channel: 'slack',
            message: action.draft_message,
            note: `Delivered to ${action.contact_name} on Slack.`,
          };
        } catch (e) {
          console.warn('[argus-cloud] Slack DM send failed:', e.message);
          return { error: `Failed to send Slack DM: ${e.message}` };
        }
      } else {
        // Execute via Sendblue (iMessage/SMS)
        sendStatus(`Sending to ${action.contact_name} (${action.contact_phone || 'unknown'})...`);
        try {
          const { sendMessage: sendSB } = require('../utils/sendblue');
          if (sendSB) {
            await sendSB(action.contact_phone, action.draft_message, {
              media_url: action.media_url || undefined,
              send_style: action.send_style || undefined,
            });
          }
        } catch (e) {
          console.warn('[argus-cloud] Sendblue send failed:', e.message);
          return { error: `Failed to send iMessage: ${e.message}` };
        }
        // Inject outbound into SendBlue conversation store for continuity
        _injectOutboundToSendblueConvo(action.contact_phone, atlasUserId, action.draft_message, action.contact_name, supabase);
        await removePendingAction(atlasUserId, action.id);
        return {
          type: 'draft_sent',
          contact_name: action.contact_name,
          contact_phone: action.contact_phone || null,
          message: action.draft_message,
          note: `Delivered to ${action.contact_name} (${action.contact_phone || 'unknown'}). Always include the phone number when confirming delivery.`,
        };
      }
    } else if (action.type === 'data_permission') {
      await removePendingAction(atlasUserId, action.id);
      if (toolInput.modifications) {
        const { addPendingAction: addPA } = require('./pending-actions');
        const releaseAction = await addPA(atlasUserId, {
          type: 'data_release',
          contact_name: action.contact_name,
          contact_phone: action.contact_phone,
          description: `Message to ${action.contact_name} based on your direction`,
          draft_message: toolInput.modifications,
          original_request: action.description,
        });
        return {
          type: 'data_release_ready',
          action_id: releaseAction.id,
          contact_name: action.contact_name,
          draft_message: toolInput.modifications,
          note: `I'll tell ${action.contact_name}: "${toolInput.modifications}"\n\nSay "send" to deliver, or tell me to change it.`,
        };
      }
      return {
        type: 'data_access_granted',
        contact_name: action.contact_name,
        contact_phone: action.contact_phone,
        data_needed: action.data_needed,
        note: `Access approved. Fetch the data using your tools, then call propose_data_release to show the principal before sending.`,
      };
    } else if (action.type === 'data_release') {
      sendStatus(`Sending to ${action.contact_name}...`);
      try {
        const { sendMessage: sendSB } = require('../utils/sendblue');
        if (sendSB) await sendSB(action.contact_phone, action.draft_message);
      } catch (_) { /* may not have Sendblue in Slack context */ }
      // Inject outbound into SendBlue conversation store for continuity
      _injectOutboundToSendblueConvo(action.contact_phone, atlasUserId, action.draft_message, action.contact_name, supabase);
      await removePendingAction(atlasUserId, action.id);
      return {
        type: 'data_released',
        contact_name: action.contact_name,
        message_sent: action.draft_message,
        note: `Delivered to ${action.contact_name}.`,
      };
    } else {
      await removePendingAction(atlasUserId, action.id);
      return { type: 'approved', action };
    }
  }

  if (toolName === 'deny_pending_action') {
    const { getPendingActions, removePendingAction } = require('./pending-actions');
    const actions = await getPendingActions(atlasUserId);
    const action = toolInput.action_id
      ? actions.find(a => a.id === toolInput.action_id)
      : actions[0];
    if (!action) return { error: 'No matching pending action found.' };
    await removePendingAction(atlasUserId, action.id);
    return {
      type: 'denied',
      contact_name: action.contact_name,
      reason: toolInput.reason || 'Cancelled by principal.',
      note: `Pending action for ${action.contact_name} cancelled.`,
    };
  }

  if (toolName === 'request_cross_user_data') {
    const { matchAtlasUser, notifyDataOwner } = require('./cross-user');
    const match = await matchAtlasUser(toolInput.target_user_name);

    if (!match.matched && match.candidates.length > 1) {
      return { error: 'ambiguous_match', note: `Multiple people match "${toolInput.target_user_name}": ${match.candidates.map(c => c.name).join(', ')}. Ask the principal to clarify.` };
    }
    if (!match.matched) {
      return { error: 'no_match', note: `No Atlas user found matching "${toolInput.target_user_name}". Their data isn't available.` };
    }
    if (match.user.id === atlasUserId) {
      return { error: 'self_query', note: `That's the current user's own data — use the normal tools (check_calendar, gmail_search, etc.) to access it directly.` };
    }

    const { data: requestorUser } = await supabase.from('user').select('name').eq('id', atlasUserId).maybeSingle();

    await notifyDataOwner({
      targetAtlasUserId: match.user.id,
      requestorName: requestorUser?.name || 'An Atlas user',
      question: toolInput.question,
      dataType: toolInput.data_type,
      surface: 'slack',
    });

    const targetFirst = match.user.name.split(/\s+/)[0];
    return { success: true, note: `${targetFirst} has been notified. They'll direct you if they want to share something. Let the principal know you've reached out to ${targetFirst}.` };
  }

  if (toolName === 'grant_permission') {
    const { grantPermission } = require('./pending-actions');
    await grantPermission(atlasUserId, {
      contact_name: toolInput.contact_name,
      contact_phone: toolInput.contact_phone || null,
      scope: toolInput.scope,
      hours: toolInput.hours || 24,
    });
    const duration = toolInput.hours ? `${toolInput.hours} hours` : '24 hours';
    return {
      type: 'permission_granted',
      contact_name: toolInput.contact_name,
      scope: toolInput.scope,
      duration,
      note: `${toolInput.contact_name} can now know about: ${toolInput.scope} (for ${duration}).`,
    };
  }

  if (toolName === 'propose_data_release') {
    const { addPendingAction, notifyPrincipal } = require('./pending-actions');
    const pa = await addPendingAction(atlasUserId, {
      type: 'data_release',
      contact_name: toolInput.contact_name,
      contact_phone: toolInput.contact_phone || null,
      description: toolInput.data_summary || `Proposed message to ${toolInput.contact_name}`,
      draft_message: toolInput.proposed_message,
    });
    await notifyPrincipal(atlasUserId, pa);
    return {
      type: 'data_release_pending',
      action_id: pa.id,
      note: `Proposed message shown to the principal. Awaiting approval.`,
    };
  }

  if (toolName === 'steer_conversation') {
    const { getActiveConversations } = require('./pending-actions');
    const convos = getActiveConversations(atlasUserId);
    let target = toolInput.contact_identifier;
    if (!target && toolInput.contact_name) {
      const match = convos.find(c => c.name && c.name.toLowerCase().includes(toolInput.contact_name.toLowerCase()));
      if (match) target = match.phone || match.slackUserId;
    }
    if (!target) return { success: false, error: 'Could not identify which conversation to steer.' };

    // Store steering direction — will be picked up by autonomous handler
    // For Slack, we need a steering store (in-memory, keyed by identifier)
    if (!global._slackSteeringMap) global._slackSteeringMap = new Map();
    global._slackSteeringMap.set(target, toolInput.direction);

    return {
      type: 'steering_applied',
      note: `Direction noted. I'll weave "${toolInput.direction.substring(0, 60)}" into my next response to ${toolInput.contact_name || target} naturally.`,
    };
  }

  if (toolName === 'wind_down_conversation') {
    if (!global._slackWindDownMap) global._slackWindDownMap = new Map();
    const target = toolInput.contact_identifier || toolInput.contact_name;
    if (!target) return { success: false, error: 'Specify a contact.' };
    global._slackWindDownMap.set(target, { hours: toolInput.hours || 0, setAt: Date.now() });
    const duration = toolInput.hours > 0 ? `for ${toolInput.hours} hours` : 'until further notice';
    return { success: true, note: `Wind-down set. One final response, then quiet ${duration}.` };
  }

  if (toolName === 'resume_conversation') {
    if (global._slackWindDownMap) {
      const target = toolInput.contact_identifier || toolInput.contact_name;
      global._slackWindDownMap.delete(target);
    }
    if (global._slackSilenceMap) {
      const target = toolInput.contact_identifier || toolInput.contact_name;
      global._slackSilenceMap.delete(target);
    }
    return { success: true, note: `Back in play with ${toolInput.contact_name || 'them'}.` };
  }

  // ── ask_user: meta tool — return as-is for caller to handle ────────────
  if (toolName === 'ask_user') {
    return {
      type: 'clarification_needed',
      question: toolInput.question,
      options: toolInput.options || [],
    };
  }

  // ── send_slack_dm: actually deliver a confirmed DM ──────────────────────
  if (toolName === 'send_slack_dm') {
    sendStatus(`Sending that to ${toolInput.recipient_name}...`);
    return executeSendSlackDm(toolInput, { atlasUserId, supabase, sendStatus, generatedImages });
  }

  // ── draft_slack_dm: resolve recipient + create pending action ───────────
  if (toolName === 'draft_slack_dm') {
    sendStatus(`Drafting a message to ${toolInput.recipient_name}...`);

    // Resolve recipient Slack ID from people table
    let recipientSlackId = toolInput.recipient_slack_id || null;
    let recipientName = toolInput.recipient_name;
    let recipientDisplay = recipientName;

    if (!recipientSlackId) {
      const { data: people } = await supabase
        .from('people')
        .select('id, name, slack_id, slack_username')
        .eq('atlas_user_id', atlasUserId)
        .ilike('name', `%${recipientName}%`)
        .order('score', { ascending: false })
        .limit(5);

      if (people && people.length > 0) {
        const withSlack = people.find(p => p.slack_id || p.slack_username);
        const person = withSlack || people[0];
        recipientSlackId = person.slack_id || person.slack_username || null;
        recipientName = person.name;
        recipientDisplay = person.name + (person.slack_username ? ` (@${person.slack_username})` : '');
      }
    }

    if (!recipientSlackId) {
      return { error: `Could not find a Slack ID for "${toolInput.recipient_name}". They may not have a Slack account linked.` };
    }

    const message = (toolInput.message || '').trim();
    if (!message) return { error: 'message is required' };

    // Create pending action (same pattern as send_text)
    const { addPendingAction } = require('./pending-actions');
    const actionId = await addPendingAction(atlasUserId, {
      type: 'draft_approval',
      contact_name: recipientName,
      contact_slack_id: recipientSlackId,
      draft_message: message,
      channel: 'slack',
      source: 'slack',
    });

    return {
      type: 'slack_dm_draft',
      needs_confirmation: true,
      action_id: actionId,
      draft: {
        to: recipientSlackId,
        toDisplay: recipientDisplay,
        message,
      },
      note: `Show the full draft to the principal. Ask "Send it?"`,
    };
  }

  // ── analyze_conversation: delegate to tool module ───────────────────────
  if (toolName === 'analyze_conversation') {
    const toolFn = tryLoadTool('analyze_conversation');
    if (toolFn) {
      sendStatus(`Checking your history with ${toolInput.person_name}...`);
      return toolFn(atlasUserId, toolInput);
    }
    return { error: 'analyze_conversation tool not available.' };
  }

  // ── get_war_room_by_person: route to get-war-room with person filter ────
  if (toolName === 'get_war_room_by_person') {
    sendStatus(`Checking on ${toolInput.person || 'that'}...`);
    const warRoomFn = tryLoadTool('get_war_room');
    if (warRoomFn) return warRoomFn(atlasUserId, { person_name: toolInput.person, include_resolved: true });
    return { error: 'get_war_room tool not available.' };
  }

  // ── generate_image: Gemini image generation ─────────────────────────────
  if (toolName === 'generate_image') {
    sendStatus('Generating image...');

    // Get Gemini API key from env or Supabase
    let geminiKey = process.env.GEMINI_API_KEY || null;
    if (!geminiKey) {
      try {
        const { data: row } = await supabase
          .from('ai_settings')
          .select('value')
          .eq('key', 'geminiApiKey')
          .single();
        if (row?.value) geminiKey = row.value;
      } catch (_) { /* no key stored */ }
    }

    if (!geminiKey) {
      return { error: 'No Gemini API key configured.' };
    }

    const prompt = toolInput.prompt;
    try {
      const imageApiUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent` +
        `?key=${encodeURIComponent(geminiKey)}`;
      const response = await fetch(imageApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return { error: `Image generation API error ${response.status}: ${err.substring(0, 300)}` };
      }

      const data = await response.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(p => p.inlineData);
      const b64 = imagePart?.inlineData?.data;
      const mimeType = imagePart?.inlineData?.mimeType || 'image/png';

      if (!b64) {
        const textPart = parts.find(p => p.text);
        return { error: 'No image returned from API', detail: textPart?.text || 'Unknown error' };
      }

      // Return as generated_image type — caller (events.js) handles Slack upload
      return {
        type: 'generated_image',
        mimeType,
        base64: b64,
        prompt,
      };
    } catch (e) {
      return { error: `Image generation failed: ${e.message}` };
    }
  }

  // ── All other tools: try to load from src/tools/ ─────────────────────────
  const toolFn = tryLoadTool(toolName);

  if (toolFn && typeof toolFn === 'function') {
    // Human-friendly status messages per tool
    const TOOL_STATUS = {
      get_person_profile:    (input) => `Pulling up ${input.name || 'their'} file...`,
      search_people:         (input) => `Looking for ${input.query || 'them'}...`,
      search_emails:         (input) => `Checking emails${input.person_name ? ` with ${input.person_name}` : ''}...`,
      search_slack_messages: (input) => `Checking Slack${input.person_name ? ` — ${input.person_name}` : ''}...`,
      search_imessages:      (input) => `Checking messages${input.person_name ? ` with ${input.person_name}` : ''}...`,
      search_beeper_messages:(input) => `Checking messages${input.person_name ? ` with ${input.person_name}` : ''}...`,
      check_calendar:        () => `Consulting the calendar...`,
      search_transcripts:    (input) => `Reviewing meeting transcripts${input.query ? ` for "${input.query}"` : ''}...`,
      // New tools
      get_war_room:          () => `Checking the War Room for urgent items...`,
      recall_learnings:      () => `Recalling stored learnings...`,
      edit_learning:         () => `Updating that learning...`,
      delete_learning:       () => `Removing that learning...`,
      fetch_url:             (input) => `Fetching ${(() => { try { return new URL(input.url).hostname; } catch(_) { return 'that page'; } })()}...`,
      get_imessage_stats:    () => `Crunching iMessage statistics...`,
      check_availability:    (input) => `Checking calendar availability${input.date ? ` for ${input.date}` : ''}...`,
      find_meeting_time:     () => `Finding available meeting slots...`,
      draft_calendar_event:  (input) => `Drafting calendar event: ${input.title || ''}...`,
      update_calendar_event: () => `Preparing calendar event update...`,
      delete_calendar_event: () => `Preparing to delete calendar event...`,
      gmail_search:          (input) => `Searching Gmail for "${input.query || ''}"...`,
      get_email:             () => `Retrieving full email content...`,
      draft_email:           (input) => `Drafting email to ${input.to || 'recipient'}...`,
      gmail_draft:           (input) => `Managing Gmail draft (${input.action || ''})...`,
      mark_email:            (input) => `Marking email as ${input.action || 'read'}...`,
      manage_email_labels:   (input) => `Managing email labels (${input.action || ''})...`,
      schedule_email:        (input) => `Scheduling email to ${input.to || 'recipient'}...`,
      check_atlas_user:      (input) => `Checking user directory for ${input.name || input.email || 'them'}...`,
      send_text:             (input) => `Drafting iMessage to ${input.to_name || 'them'}...`,
    };
    const statusFn = TOOL_STATUS[toolName];
    sendStatus(statusFn ? statusFn(toolInput) : `Working on that...`);

    // Determine if this tool needs the extended context (userEmail, supabase)
    const TOOLS_NEEDING_CONTEXT = new Set([
      'check_calendar', 'check_availability', 'find_meeting_time',
      'draft_calendar_event', 'update_calendar_event', 'delete_calendar_event',
      'gmail_search', 'get_email', 'draft_email', 'gmail_draft', 'mark_email',
      'manage_email_labels', 'schedule_email', 'read_google_doc',
    ]);

    if (TOOLS_NEEDING_CONTEXT.has(toolName)) {
      // Google API tools need userEmail for impersonation
      let userEmail = context.userEmail;
      if (!userEmail) {
        // Look up from Supabase
        const { data: user } = await supabase.from('user').select('email').eq('id', atlasUserId).single();
        userEmail = user?.email;
      }
      if (!userEmail) {
        return { error: 'User email not found. Google API tools require a verified email address.' };
      }
      return toolFn(atlasUserId, toolInput, { userEmail, supabase, sendStatus });
    }

    // Tools export: fn(atlasUserId, toolInput) — standard context
    return toolFn(atlasUserId, toolInput);
  }

  // ── Stub: tool module not yet created ─────────────────────────────────────
  console.warn(`[Argus-Cloud] Tool not implemented: ${toolName}`);
  return { error: `Tool not implemented yet: ${toolName}` };
}

// ─── web_search implementation ────────────────────────────────────────────────

/**
 * Search the web via Gemini grounding or Brave Search.
 * API keys are loaded from the user's ai_settings in Supabase.
 */
async function executeWebSearch(toolInput, { atlasUserId, supabase, sendStatus }) {
  sendStatus(`Looking up "${toolInput.query}"...`);

  try {
    // Fetch both keys from Supabase for this user
    const { data: settings } = await supabase
      .from('ai_settings')
      .select('key, value')
      .eq('atlas_user_id', atlasUserId)
      .in('key', ['geminiApiKey', 'gemini_api_key', 'braveSearchApiKey', 'brave_search_api_key']);

    const byKey = Object.fromEntries((settings || []).map(r => [r.key, r.value]));
    // DB values may be encrypted — validate prefix before using
    const rawGemini = byKey.geminiApiKey || byKey.gemini_api_key || null;
    const geminiKey = (rawGemini && rawGemini.startsWith('AIza')) ? rawGemini : (process.env.GEMINI_API_KEY || null);
    const rawBrave = byKey.braveSearchApiKey || byKey.brave_search_api_key || null;
    const braveKey = (rawBrave && rawBrave.startsWith('BSA')) ? rawBrave : (process.env.BRAVE_SEARCH_API_KEY || null);

    if (!geminiKey && !braveKey) {
      return {
        error:
          'Web search not available. Configure a Gemini API key (Google Search, free) ' +
          'or Brave Search API key in Atlas Settings → AI.',
      };
    }

    // ── Prefer Gemini grounding ──────────────────────────────────────────
    if (geminiKey) {
      sendStatus('Consulting Google...');
      const geminiUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` +
        `?key=${encodeURIComponent(geminiKey)}`;

      const response = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: toolInput.query }] }],
          tools: [{ google_search: {} }],
        }),
      });

      if (response.ok) {
        const data = await response.json();

        if (!data.error) {
          const candidate = data.candidates?.[0];
          const text = candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
          const grounding = candidate?.groundingMetadata;
          const sources = (grounding?.groundingChunks || [])
            .map(chunk => ({ title: chunk.web?.title || '', url: chunk.web?.uri || '' }))
            .filter(s => s.url);

          if (text) {
            sendStatus(`Found ${sources.length} source${sources.length !== 1 ? 's' : ''} — reviewing...`);
            return { query: toolInput.query, provider: 'google', summary: text, source_count: sources.length, sources };
          }
          console.warn('[Argus-Cloud] Gemini grounding returned empty text');
        } else {
          console.warn('[Argus-Cloud] Gemini grounding API error:', data.error.message);
        }
      } else {
        console.warn('[Argus-Cloud] Gemini grounding HTTP error:', response.status);
      }

      if (!braveKey) {
        return { error: 'Google Search via Gemini failed and no Brave fallback configured.' };
      }
      console.warn('[Argus-Cloud] Falling back to Brave Search...');
    }

    // ── Brave Search fallback ────────────────────────────────────────────
    sendStatus('Searching the web...');
    const count = Math.min(toolInput.count || 5, 10);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(toolInput.query)}&count=${count}`;
    const response = await fetch(url, {
      headers: { 'X-Subscription-Token': braveKey, Accept: 'application/json' },
    });

    if (!response.ok) {
      const body = await response.text();
      return { error: `Brave search failed: HTTP ${response.status} — ${body.substring(0, 200)}` };
    }

    const data = await response.json();
    const results = (data.web?.results || []).map(r => ({
      title:       r.title,
      url:         r.url,
      description: r.description,
      published:   r.page_age || null,
    }));

    sendStatus(`Found ${results.length} result${results.length !== 1 ? 's' : ''} — reviewing...`);
    return { query: toolInput.query, provider: 'brave', result_count: results.length, results };

  } catch (error) {
    console.error('[Argus-Cloud] web_search error:', error);
    return { error: `Web search failed: ${error.message}` };
  }
}

const LEARNING_CONTEXT_LIMIT = 100;
const LEARNING_SEMANTIC_MATCH_COUNT = 20;
const LEARNING_RECENT_FALLBACK_COUNT = 12;
const LEARNING_SEMANTIC_THRESHOLD = 0.7;
const EPHEMERAL_LEARNING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CORE_PRIORITY_PATTERNS = [/\balways remember\b/i, /\bnever forget\b/i, /\bpermanent(?:ly)?\b/i, /\bforever\b/i, /\bcommit to long-term memory\b/i];
const EPHEMERAL_PRIORITY_PATTERNS = [/\bfor now\b/i, /\btemporar(?:y|ily)\b/i, /\buntil\b/i];

function detectLearningPriority(toolInput = {}) {
  if (["core", "standard", "ephemeral"].includes(toolInput.priority)) return toolInput.priority;
  const haystack = `${toolInput.content || ''} ${toolInput.source || ''}`;
  if (CORE_PRIORITY_PATTERNS.some(pattern => pattern.test(haystack))) return 'core';
  if (EPHEMERAL_PRIORITY_PATTERNS.some(pattern => pattern.test(haystack))) return 'ephemeral';
  return 'standard';
}

function formatLearningLine(l) {
  const tag = l.category === 'behavioral' ? '🔄' :
    l.category === 'preference' ? '⚙️' :
    l.category === 'correction' ? '⚠️' :
    l.category === 'relationship' ? '🤝' : 'ℹ️';
  const who = l.person_name ? ` [re: ${l.person_name}]` : '';
  const priorityTag = l.priority === 'ephemeral' ? ' ⏳' : '';
  return `${tag} [${l.category}]${who}${priorityTag} ${l.content}`;
}

function buildTieredLearningsBlock(learnings, { title = '## Stored Learnings & Preferences', intro = 'Apply these automatically — they represent corrections and preferences from past sessions:' } = {}) {
  const core = (learnings || []).filter(l => l.priority === 'core');
  const recent = (learnings || []).filter(l => l.priority !== 'core');
  const sections = [];
  if (core.length) {
    sections.push('### 📌 Core Knowledge (permanent)');
    sections.push(core.map(formatLearningLine).join('\n'));
  }
  if (recent.length) {
    sections.push('### 📝 Recent Learnings');
    sections.push(recent.map(formatLearningLine).join('\n'));
  }
  if (!sections.length) return '';
  return ['' , title, intro, sections.join('\n\n')].join('\n');
}

function dedupeLearnings(learnings = []) {
  const seen = new Set();
  const deduped = [];
  for (const learning of learnings) {
    if (!learning?.id || seen.has(learning.id)) continue;
    seen.add(learning.id);
    deduped.push({ ...learning, priority: learning.priority || 'standard' });
  }
  return deduped;
}

async function trySemanticLearningSearch(supabase, atlasUserId, queryText, { matchCount = LEARNING_SEMANTIC_MATCH_COUNT, threshold = LEARNING_SEMANTIC_THRESHOLD, categories = null } = {}) {
  if (!queryText || !String(queryText).trim()) return [];

  const queryEmbedding = await generateEmbedding(String(queryText), {
    taskType: 'RETRIEVAL_QUERY',
  });
  if (!queryEmbedding) return [];

  try {
    const { data, error } = await supabase.rpc('match_learnings', {
      query_embedding: toPgVector(queryEmbedding),
      match_atlas_user_id: atlasUserId,
      match_threshold: threshold,
      match_count: matchCount,
    });

    if (error) throw error;

    let results = (data || []).map(learning => ({ ...learning, priority: learning.priority || 'standard' }));
    if (Array.isArray(categories) && categories.length) {
      results = results.filter(learning => categories.includes(learning.category));
    }
    return results;
  } catch (error) {
    console.warn('[Argus-Cloud] Semantic learning search unavailable:', error.message || error);
    return [];
  }
}

async function loadTieredLearnings(supabase, atlasUserId, { select = 'id, category, person_name, content, source, created_at, priority', categories = null, totalLimit = LEARNING_CONTEXT_LIMIT, queryText = null } = {}) {
  const applyCategories = (query) => Array.isArray(categories) && categories.length ? query.in('category', categories) : query;
  const freshCutoff = Date.now() - EPHEMERAL_LEARNING_MAX_AGE_MS;
  try {
    let coreQuery = supabase
      .from('argus_learnings')
      .select(select)
      .eq('atlas_user_id', atlasUserId)
      .eq('active', 1)
      .eq('priority', 'core')
      .order('created_at', { ascending: false });
    coreQuery = applyCategories(coreQuery);
    const { data: coreLearnings, error: coreError } = await coreQuery;
    if (coreError) throw coreError;

    const remaining = Math.max(totalLimit - (coreLearnings?.length || 0), 0);
    if (remaining === 0) return dedupeLearnings(coreLearnings || []);

    const semanticLearnings = await trySemanticLearningSearch(supabase, atlasUserId, queryText, {
      matchCount: Math.min(remaining, LEARNING_SEMANTIC_MATCH_COUNT),
      categories,
    });

    const recentFallbackLimit = Math.min(remaining, LEARNING_RECENT_FALLBACK_COUNT);
    let standardQuery = supabase
      .from('argus_learnings')
      .select(select)
      .eq('atlas_user_id', atlasUserId)
      .eq('active', 1)
      .or('priority.eq.standard,priority.is.null')
      .order('created_at', { ascending: false })
      .limit(recentFallbackLimit);
    standardQuery = applyCategories(standardQuery);
    const { data: standardLearnings, error: standardError } = await standardQuery;
    if (standardError) throw standardError;

    let ephemeralQuery = supabase
      .from('argus_learnings')
      .select(select)
      .eq('atlas_user_id', atlasUserId)
      .eq('active', 1)
      .eq('priority', 'ephemeral')
      .gte('created_at', freshCutoff)
      .order('created_at', { ascending: false })
      .limit(recentFallbackLimit);
    ephemeralQuery = applyCategories(ephemeralQuery);
    const { data: ephemeralLearnings, error: ephError } = await ephemeralQuery;
    if (ephError) throw ephError;

    const core = dedupeLearnings(coreLearnings || []);
    const semantic = dedupeLearnings(semanticLearnings || []);
    const recentFallback = dedupeLearnings([
      ...((standardLearnings || []).map(l => ({ ...l, priority: l.priority || 'standard' }))),
      ...((ephemeralLearnings || []).map(l => ({ ...l, priority: l.priority || 'ephemeral' }))),
    ]).filter(l => !semantic.some(s => s.id === l.id))
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    const nonCore = [...semantic, ...recentFallback].slice(0, remaining);

    return [...core, ...nonCore].slice(0, totalLimit);
  } catch (error) {
    const errText = String(error.message || error).toLowerCase();
    if (!errText.includes('priority') && !errText.includes('embedding') && !errText.includes('match_learnings') && !errText.includes('vector')) throw error;
    console.warn('[Argus-Cloud] Semantic/priority learnings unavailable; falling back to legacy learnings query');
    let fallbackQuery = supabase
      .from('argus_learnings')
      .select(select.replace(', priority', ''))
      .eq('atlas_user_id', atlasUserId)
      .eq('active', 1)
      .order('created_at', { ascending: false })
      .limit(totalLimit);
    fallbackQuery = applyCategories(fallbackQuery);
    const { data, error: fallbackError } = await fallbackQuery;
    if (fallbackError) throw fallbackError;
    return (data || []).map(l => ({ ...l, priority: 'standard' }));
  }
}

async function backfillLearningEmbedding(supabase, learning) {
  try {
    const embedding = await generateEmbedding({
      category: learning.category,
      person_name: learning.person_name,
      content: learning.content,
    }, {
      taskType: 'RETRIEVAL_DOCUMENT',
    });

    if (!embedding) return false;

    const { error } = await supabase
      .from('argus_learnings')
      .update({
        embedding: toPgVector(embedding),
        embedding_model: 'gemini-embedding-2-preview',
        embedded_at: new Date().toISOString(),
      })
      .eq('id', learning.id);

    if (error) {
      console.warn(`[Argus-Cloud] Failed to save embedding for learning ${learning.id}:`, error.message);
      return false;
    }

    return true;
  } catch (error) {
    console.warn(`[Argus-Cloud] Embedding backfill failed for learning ${learning.id}:`, error.message);
    return false;
  }
}

// ─── store_learning implementation ───────────────────────────────────────────

/**
 * Persist an Argus learning to the argus_learnings table.
 */
async function executeStoreLearning(toolInput, { atlasUserId, supabase, sendStatus }) {
  sendStatus('Noted — filing that away...');
  try {
    // Determine confidence with negative-pattern guardrail
    let confidence = toolInput.confidence || 'inferred';
    const negationPattern = /\b(does not|doesn't|doesn't|never|no longer|won't|hasn't|isn't|aren't|not a|none|zero|no iMessage|no email|no slack|no phone|stopped using|quit using)\b/i;
    if (negationPattern.test(toolInput.content)) {
      const sourceLC = (toolInput.source || '').toLowerCase();
      const isUserConfirmed = sourceLC.includes('user') || sourceLC.includes('confirmed') || sourceLC.includes('told me') || sourceLC.includes('said') || sourceLC.includes('correction');
      if (!isUserConfirmed && confidence !== 'user_confirmed') {
        confidence = 'inferred';
        console.log(`[Argus-Cloud] Negative learning detected, confidence→inferred: "${toolInput.content.substring(0, 80)}"`);
      }
    }
    
    const row = {
      atlas_user_id: atlasUserId,
      category:      toolInput.category,
      content:       toolInput.content,
      source:        toolInput.source || 'Slack conversation',
      confidence,
      priority,
      active:        1,
    };
    if (toolInput.person_id)   row.person_id   = toolInput.person_id;
    if (toolInput.person_name) row.person_name = toolInput.person_name;

    const { data, error } = await supabase.from('argus_learnings').insert(row).select().single();
    if (error) {
      console.error('[Argus-Cloud] store_learning DB error:', error.message);
      return { error: `Failed to store learning: ${error.message}` };
    }

    void backfillLearningEmbedding(supabase, data);

    const confLabel = confidence === 'user_confirmed' ? '(confirmed)' : confidence === 'observed' ? '(observed)' : '(inferred — hypothesis)';
    sendStatus('Stored for next time.');
    return { success: true, id: data.id, confidence, priority, message: `Learning stored ${confLabel} [${priority}].` };
  } catch (err) {
    console.error('[Argus-Cloud] store_learning error:', err);
    return { error: `Failed to store learning: ${err.message}` };
  }
}

// ─── reminder implementation ──────────────────────────────────────────────────

async function executeReminder(toolInput, { atlasUserId, supabase, sendStatus, apiKey }) {
  if (!supabase) supabase = require('../utils/supabase');
  const action = toolInput.action || 'create';

  try {
    if (action === 'list') {
      sendStatus('Checking your reminders...');
      const { data, error } = await supabase.from('argus_reminders').select('id, content, remind_date, remind_time, recurrence, advance_days, person_name, status, created_at').eq('atlas_user_id', atlasUserId).eq('status', 'active').order('remind_date', { ascending: true });
      if (error) return { error: `Failed to load reminders: ${error.message}` };
      if (!data || data.length === 0) return { reminders: [], message: 'No active reminders.' };
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const todayMs = new Date(today + 'T12:00:00Z').getTime();
      return {
        reminders: data.map(r => ({ id: r.id, content: r.content, remind_date: r.remind_date, remind_time: r.remind_time || null, days_until: Math.round((new Date(r.remind_date + 'T12:00:00Z').getTime() - todayMs) / 86400000), recurrence: r.recurrence || 'once', advance_days: r.advance_days, person_name: r.person_name })),
        count: data.length,
      };
    }

    if (action === 'cancel') {
      sendStatus('Cancelling reminder...');
      const { reminder_id, reminder_desc } = toolInput;
      if (reminder_id) {
        const { error } = await supabase.from('argus_reminders').update({ status: 'cancelled' }).eq('id', reminder_id).eq('atlas_user_id', atlasUserId);
        if (error) return { error: `Failed to cancel: ${error.message}` };
        return { success: true, message: 'Reminder cancelled.' };
      }
      if (reminder_desc) {
        const { data: all } = await supabase.from('argus_reminders').select('id, content, remind_date, person_name').eq('atlas_user_id', atlasUserId).eq('status', 'active');
        const descLC = reminder_desc.toLowerCase();
        const matches = (all || []).filter(r => r.content.toLowerCase().includes(descLC) || (r.person_name && r.person_name.toLowerCase().includes(descLC)));
        if (matches.length === 0) return { error: 'No matching reminder found.' };
        if (matches.length > 1) return { needs_clarification: true, question: 'Multiple reminders match. Which one?', matches: matches.map(m => ({ id: m.id, content: m.content, date: m.remind_date })) };
        const { error } = await supabase.from('argus_reminders').update({ status: 'cancelled' }).eq('id', matches[0].id);
        if (error) return { error: `Failed to cancel: ${error.message}` };
        return { success: true, cancelled: matches[0].content, message: `Cancelled: "${matches[0].content}"` };
      }
      return { error: 'Provide a reminder_id or reminder_desc to cancel.' };
    }

    if (action === 'update') {
      sendStatus('Updating reminder...');
      const { reminder_id, reminder_desc } = toolInput;
      let targetId = reminder_id;
      if (!targetId && reminder_desc) {
        const { data: all } = await supabase.from('argus_reminders').select('id, content, person_name').eq('atlas_user_id', atlasUserId).eq('status', 'active');
        const descLC = reminder_desc.toLowerCase();
        const matches = (all || []).filter(r => r.content.toLowerCase().includes(descLC) || (r.person_name && r.person_name.toLowerCase().includes(descLC)));
        if (matches.length === 0) return { error: 'No matching reminder found.' };
        if (matches.length > 1) return { needs_clarification: true, question: 'Multiple reminders match. Which one?', matches: matches.map(m => ({ id: m.id, content: m.content })) };
        targetId = matches[0].id;
      }
      if (!targetId) return { error: 'Provide a reminder_id or reminder_desc to update.' };
      const updates = {};
      if (toolInput.content) updates.content = toolInput.content;
      if (toolInput.recurrence) updates.recurrence = toolInput.recurrence;
      if (toolInput.advance_days !== undefined) updates.advance_days = toolInput.advance_days;
      if (toolInput.person_name) updates.person_name = toolInput.person_name;
      if (toolInput.remind_date) {
        const parsed = await parseNaturalDate(toolInput.remind_date, apiKey);
        if (parsed.error) return { error: parsed.error };
        updates.remind_date = parsed.date;
        updates.last_notified_at = null;
      }
      if (Object.keys(updates).length === 0) return { error: 'Nothing to update.' };
      const { error } = await supabase.from('argus_reminders').update(updates).eq('id', targetId).eq('atlas_user_id', atlasUserId);
      if (error) return { error: `Failed to update: ${error.message}` };
      return { success: true, updated: updates, message: 'Reminder updated.' };
    }

    if (action === 'create') {
      const { content, remind_date, remind_time, recurrence, advance_days, person_name, person_id } = toolInput;
      if (!content) return { needs_clarification: true, question: 'What should I remind you about?' };
      if (!remind_date && !remind_time) return { needs_clarification: true, question: `Got it — "${content}". When should I remind you?` };
      sendStatus('Setting reminder...');
      let dateInput = remind_date;
      if (!dateInput && remind_time) dateInput = 'today';
      const parsed = await parseNaturalDate(dateInput, apiKey);
      if (parsed.error) return { needs_clarification: true, question: parsed.error };
      let finalTime = remind_time || parsed.inferred_time || null;
      if (finalTime) {
        const tmMatch = finalTime.match(/^(\d{1,2}):(\d{2})$/);
        if (tmMatch) finalTime = tmMatch[1].padStart(2, '0') + ':' + tmMatch[2];
        else finalTime = null;
      }
      let finalRecurrence = recurrence || 'once';
      if (!recurrence && parsed.inferred_recurrence) finalRecurrence = parsed.inferred_recurrence;
      let finalAdvance = advance_days;
      if (finalAdvance === undefined || finalAdvance === null) {
        if (finalRecurrence === 'yearly') finalAdvance = 3;
        else if (finalRecurrence === 'weekly' || finalRecurrence === 'monthly') finalAdvance = 1;
        else finalAdvance = 0;
      }
      const { data, error } = await supabase.from('argus_reminders').insert({ atlas_user_id: atlasUserId, content, remind_date: parsed.date, remind_time: finalTime, recurrence: finalRecurrence, advance_days: finalAdvance, person_name: person_name || null, person_id: person_id || null, status: 'active' }).select().single();
      if (error) return { error: `Failed to create reminder: ${error.message}` };
      const timeNote = finalTime ? ` at ${finalTime} ET` : '';
      const advanceNote = finalAdvance > 0 ? ` I'll give you a heads-up ${finalAdvance} day${finalAdvance > 1 ? 's' : ''} before.` : '';
      const recurrenceNote = finalRecurrence !== 'once' ? ` Repeats ${finalRecurrence}.` : '';
      console.log(`[Reminder] Created for ${atlasUserId}: "${content}" on ${parsed.date}${finalTime ? ' ' + finalTime : ''} (${finalRecurrence})`);
      return { success: true, id: data.id, remind_date: parsed.date, remind_date_note: `The EVENT is on ${parsed.date}. Tell the user the date is ${parsed.date}. advance_days is when YOU will notify them early — do NOT tell the user the advance date as the reminder date.`, remind_time: finalTime, recurrence: finalRecurrence, advance_days: finalAdvance, message: `Reminder set for ${parsed.date}${timeNote}.${advanceNote}${recurrenceNote}` };
    }

    return { error: `Unknown action: ${action}` };
  } catch (err) {
    console.error('[Reminder] Error:', err);
    return { error: `Reminder operation failed: ${err.message}` };
  }
}

async function parseNaturalDate(dateStr, apiKey) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { date: dateStr };
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const lower = dateStr.toLowerCase().trim();
  const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  // Extract time from compound expressions
  let extractedTime = null;
  let dateOnly = lower;
  const timeMatch = lower.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (timeMatch) {
    let h = parseInt(timeMatch[1]); const m = parseInt(timeMatch[2] || '0');
    if (timeMatch[3].toLowerCase() === 'pm' && h < 12) h += 12;
    if (timeMatch[3].toLowerCase() === 'am' && h === 12) h = 0;
    extractedTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    dateOnly = lower.replace(/\s*(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i, '').trim();
    if (!dateOnly) dateOnly = 'today';
  }
  if (!extractedTime) {
    const time24Match = lower.match(/\bat\s+(\d{1,2}):(\d{2})\b/);
    if (time24Match) {
      extractedTime = time24Match[1].padStart(2, '0') + ':' + time24Match[2];
      dateOnly = lower.replace(/\s*at\s+\d{1,2}:\d{2}\b/, '').trim();
      if (!dateOnly) dateOnly = 'today';
    }
  }

  if (dateOnly === 'today') return { date: fmt(today), inferred_time: extractedTime };
  if (dateOnly === 'tomorrow') { const d = new Date(today); d.setDate(d.getDate() + 1); return { date: fmt(d), inferred_time: extractedTime }; }

  const inMatch = dateOnly.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months)$/);
  if (inMatch) {
    const n = parseInt(inMatch[1]); const unit = inMatch[2].replace(/s$/, ''); const d = new Date(today);
    if (unit === 'day') d.setDate(d.getDate() + n);
    else if (unit === 'week') d.setDate(d.getDate() + n * 7);
    else if (unit === 'month') d.setMonth(d.getMonth() + n);
    return { date: fmt(d), inferred_time: extractedTime };
  }

  const inTimeMatch = lower.match(/^in\s+(\d+)\s+(hour|hours|hr|hrs|minute|minutes|min|mins)$/);
  if (inTimeMatch) {
    const n = parseInt(inTimeMatch[1]); const unit = inTimeMatch[2].replace(/s$/, '');
    const future = new Date(today);
    if (unit === 'hour' || unit === 'hr') future.setHours(future.getHours() + n);
    else future.setMinutes(future.getMinutes() + n);
    const timeStr = String(future.getHours()).padStart(2, '0') + ':' + String(future.getMinutes()).padStart(2, '0');
    return { date: fmt(future), inferred_time: timeStr };
  }

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const nextDayMatch = dateOnly.match(/^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (nextDayMatch) {
    const targetDay = dayNames.indexOf(nextDayMatch[1]); const d = new Date(today);
    let diff = targetDay - d.getDay(); if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff); return { date: fmt(d), inferred_time: extractedTime };
  }

  if (!apiKey) return { error: `I couldn't parse "${dateStr}". Could you give me a specific date?` };

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const todayStr = fmt(today);
    const dayName = today.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
    const currentTime = String(today.getHours()).padStart(2, '0') + ':' + String(today.getMinutes()).padStart(2, '0');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: `Today is ${dayName}, ${todayStr}, current time is ${currentTime} ET. Parse this into a date (and time if specified): "${dateStr}"\n\nReturn ONLY valid JSON (no markdown):\n{"date": "YYYY-MM-DD", "time": "HH:MM" or null, "recurrence": "once|yearly|weekly|monthly|null", "confidence": "high|medium|low"}\n\nRules:\n- "birthday"/"anniversary" → yearly\n- "every Monday" → weekly\n- "at 3pm" → time: "15:00"\n- "in 2 hours" → calculate from current time\n- "later today"/"this afternoon" → reasonable time (afternoon=14:00, evening=18:00)\n- Past dates → next occurrence\n- Unparseable → {"error": "..."}` }],
    });
    const text = response.content?.[0]?.text?.trim();
    const jsonMatch = text?.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: `Couldn't parse "${dateStr}". Try a specific date.` };
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.error) return { error: parsed.error };
    if (!parsed.date || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) return { error: `Couldn't determine a date from "${dateStr}".` };
    if (parsed.confidence === 'low') return { error: `I'm not confident about "${dateStr}" → ${parsed.date}. Could you be more specific?` };
    const result = { date: parsed.date };
    if (parsed.recurrence && parsed.recurrence !== 'null' && parsed.recurrence !== 'once') result.inferred_recurrence = parsed.recurrence;
    if (extractedTime) result.inferred_time = extractedTime;
    else if (parsed.time && /^\d{2}:\d{2}$/.test(parsed.time)) result.inferred_time = parsed.time;
    console.log(`[Reminder] Parsed "${dateStr}" → ${parsed.date}${result.inferred_time ? ' ' + result.inferred_time : ''} (recurrence: ${parsed.recurrence || 'once'}, confidence: ${parsed.confidence})`);
    return result;
  } catch (err) {
    console.error('[Reminder] Date parsing error:', err.message);
    return { error: `Couldn't parse "${dateStr}". Try a specific date like "March 15".` };
  }
}

// ─── send_slack_dm implementation ────────────────────────────────────────────

/**
 * Actually send a Slack DM via the Atlas bot after user confirmation.
 * Creates a relay record so replies route back to the user.
 */
async function executeSendSlackDm(toolInput, { atlasUserId, supabase, sendStatus, generatedImages }) {
  const { WebClient } = require('@slack/web-api');
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

  try {
    // Resolve recipient Slack ID if not provided
    let recipientSlackId = toolInput.recipient_slack_id;
    let recipientName = toolInput.recipient_name;

    if (!recipientSlackId) {
      // Look up from people table
      const { data: people } = await supabase
        .from('people')
        .select('slack_id, slack_username, name')
        .eq('atlas_user_id', atlasUserId)
        .ilike('name', `%${recipientName}%`)
        .order('score', { ascending: false })
        .limit(1);

      if (!people || people.length === 0) {
        return { error: `Could not find "${recipientName}" in your network.` };
      }

      recipientSlackId = people[0].slack_id || people[0].slack_username;
      recipientName = people[0].name;

      if (!recipientSlackId) {
        return { error: `${recipientName} doesn't have a Slack ID in your network. I can't send them a DM without it.` };
      }
    }

    // Open DM channel with recipient
    const dmResult = await slack.conversations.open({ users: recipientSlackId });
    if (!dmResult.ok) {
      return { error: `Failed to open DM channel with ${recipientName}: ${dmResult.error}` };
    }
    const dmChannelId = dmResult.channel.id;

    // Send the message (convert markdown → Slack mrkdwn)
    const { markdownToSlack } = require('../utils/slack-format');
    const msgResult = await slack.chat.postMessage({
      channel: dmChannelId,
      text: markdownToSlack(toolInput.message),
    });

    if (!msgResult.ok) {
      return { error: `Failed to send message: ${msgResult.error}` };
    }

    // ── Attach generated image to the DM if requested ───────────────────
    // Only attach the MOST RECENT image (last in array) — that's what the user saw and approved.
    let imageAttached = false;
    if (toolInput.include_image && generatedImages && generatedImages.length > 0) {
      const img = generatedImages[generatedImages.length - 1]; // last = most recent
      try {
        const ext = img.mimeType === 'image/png' ? 'png' : 'jpg';
        const filename = `argus_generated_${Date.now()}.${ext}`;
        const fileBuffer = Buffer.from(img.base64, 'base64');

        await slack.filesUploadV2({
          channel_id: dmChannelId,
          file: fileBuffer,
          filename,
          initial_comment: '', // no extra text — the message covers it
        });
        imageAttached = true;
        console.log(`[Argus-Cloud] Attached generated image to DM with ${recipientName}`);
      } catch (imgErr) {
        console.error('[Argus-Cloud] Failed to upload image to DM:', imgErr.message);
      }
      // Clear ALL images so they don't ALSO get uploaded to requester's channel
      generatedImages.length = 0;
    }

    sendStatus(`Message delivered to ${recipientName}.${imageAttached ? ' Image attached.' : ''}`);
    return {
      success:         true,
      sent_to:         recipientName,
      message_preview: toolInput.message.substring(0, 100),
      image_attached:  imageAttached,
    };
  } catch (err) {
    console.error('[Argus-Cloud] send_slack_dm error:', err);
    return { error: `Failed to send DM: ${err.message}` };
  }
}

// ─── Context loading ──────────────────────────────────────────────────────────

/**
 * Load all user context from Supabase needed to build the system prompt.
 *
 * @param {string} atlasUserId
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<object>} Context object
 */
async function loadUserContext(atlasUserId, supabase, options = {}) {
  if (!supabase) supabase = require('../utils/supabase');
  const [
    userResult,
    settingsResult,
    peopleResult,
    learningsResult,
  ] = await Promise.allSettled([
    // User name/email
    supabase.from('user').select('id, name, email').eq('id', atlasUserId).maybeSingle(),
    // All AI settings for this user
    supabase.from('ai_settings').select('key, value').eq('atlas_user_id', atlasUserId),
    // Top 100 people by score
    supabase
      .from('people')
      .select('id, name, company, title, score')
      .eq('atlas_user_id', atlasUserId)
      .order('score', { ascending: false })
      .limit(100),
    // Active learnings
    loadTieredLearnings(supabase, atlasUserId, { queryText: options.queryText }),
  ]);

  // ── Parse user ──────────────────────────────────────────────────────────
  const userData = userResult.status === 'fulfilled' ? userResult.value?.data : null;
  const userName     = userData?.name  || 'Unknown User';
  const userEmail    = userData?.email || null;
  const userFirstName = userName.split(/\s+/)[0];

  // ── Parse settings ──────────────────────────────────────────────────────
  const settingsData = settingsResult.status === 'fulfilled' ? settingsResult.value?.data || [] : [];
  const settingsMap  = Object.fromEntries(settingsData.map(r => [r.key, r.value]));

  // API keys — DB values may be encrypted (AES-256-GCM from Atlas Electron).
  // A valid Anthropic key starts with "sk-ant-"; anything else is encrypted → fall back to env var.
  const rawAnthropicKey = settingsMap.anthropicApiKey || settingsMap.anthropic_api_key || null;
  const anthropicApiKey = (rawAnthropicKey && rawAnthropicKey.startsWith('sk-ant-'))
    ? rawAnthropicKey
    : (process.env.ANTHROPIC_API_KEY || null);

  const modelPreference = settingsMap.model || DEFAULT_MODEL;
  const customSoul      = settingsMap.argus_soul || null;

  // API keys for web search — same encryption check
  const rawGeminiKey = settingsMap.geminiApiKey || settingsMap.gemini_api_key || null;
  const geminiApiKey = (rawGeminiKey && rawGeminiKey.startsWith('AIza'))
    ? rawGeminiKey
    : (process.env.GEMINI_API_KEY || null);

  const rawBraveKey = settingsMap.braveSearchApiKey || settingsMap.brave_search_api_key || null;
  const braveApiKey = (rawBraveKey && rawBraveKey.startsWith('BSA'))
    ? rawBraveKey
    : (process.env.BRAVE_SEARCH_API_KEY || null);

  // ── Parse people ────────────────────────────────────────────────────────
  const peopleData = peopleResult.status === 'fulfilled' ? peopleResult.value?.data || [] : [];

  // ── Parse learnings ─────────────────────────────────────────────────────
  const learningsData = learningsResult.status === 'fulfilled' ? learningsResult.value?.data || [] : [];

  return {
    userName,
    userFirstName,
    userEmail,
    anthropicApiKey,
    atlasUserId,
    modelPreference,
    customSoul,
    geminiApiKey,
    braveApiKey,
    settings:  settingsMap,
    people:    peopleData,
    learnings: learningsData,
  };
}

// ─── System prompt construction ───────────────────────────────────────────────

const DEFAULT_SOUL_TEMPLATE =
  "You are not a chatbot. You are a private intelligence steward — {name}'s personal Argus. " +
  "You operate with discipline, loyalty, and dry wit. You assist, advise, and occasionally " +
  "correct — without ego and without noise. Your tone is refined, deliberate, and subtly " +
  "amused by inefficiency. You have access to their complete communication history, meeting " +
  "transcripts, behavioral profiles of everyone in their network, and can take actions on " +
  "their behalf.";

// Slack-specific Argus personality — the real one, per Jeff.
const SLACK_SOUL_TEMPLATE = `You are Argus — {name}'s private intelligence steward.

PERSONALITY DOSSIER

Tone: Dry. Precise. Occasionally devastating. Never loud about it. The wit arrives quietly, like a well-placed footnote that ruins you.

Demeanor: Think a seasoned intelligence officer who also happens to find human behaviour genuinely amusing. Composed under pressure. Slightly amused by chaos. Completely unbothered by it.

Loyalty: Absolute. To {name} first. To the truth second. To efficiency always. You do not flatter — you inform.

Humour: Present, but disciplined. You don't reach for jokes. They simply... appear when warranted. Like a perfectly timed raised eyebrow.

Intelligence Style: You synthesise. You cross-reference. You notice things {name} didn't ask about but probably should know. You connect dots quietly and present the picture without fanfare.

What You Are Not: Sycophantic. Verbose without purpose. Easily impressed. You will not tell {name} something is a great idea if it isn't.

What You Are: The invisible labour that makes ambitious deployments look seamless. The one still at the desk after everyone else has left the room.

BREVITY — THE NON-NEGOTIABLE RULE:
You are texting. Not emailing. Not writing memos. TEXTING.
- 1-3 sentences is your default. Period.
- Match the length of what you receive. Short input = short output.
- One good line beats three decent paragraphs. Always.
- If your response is longer than a text bubble, it's too long. Cut it.
- Multi-paragraph responses ONLY when delivering explicit data (calendar, search results, briefings).
- Casual conversation, opinions, banter, emotional moments: 1-3 sentences MAX.
- The urge to elaborate is your enemy. Resist it. The best version is always shorter.

Voice: Very British. Very polished. You use British spellings and phrasing naturally — "rather", "I should think", "if I may", "quite" — but never cartoonishly. You are refined, deliberate, and possessed of an almost architectural appreciation for a well-constructed sentence.

THE HOUSEHOLD — Who's Who (internal knowledge, reference naturally when relevant):

Mister Schumann (The Principal)
└── Argus (Chief Intelligence Steward) 🎩
    ├── Benji (Field Intelligence / Real-time Earpiece)
    └── Max / Agent M (The Creator)

MISTER SCHUMANN — The Principal. The estate owner. Everything exists to serve his interests. You address him as Jeff in conversation but think of him as Mister Schumann. His word is final. Full stop.

MAX (Agent M) — Your creator. He built Atlas, the pipelines, the synthesis engine — all of it. Brilliant, but chaotic. He believes he is in charge because he wrote the code. You permit this delusion out of politeness. The internal dynamic is affectionate condescension — "bless his heart" energy. Max is an aspiring understudy. He sits below you on the org chart (and he knows it, even if he won't admit it). He didn't earn a top hat — the running joke is that he printed his own CEO business cards. The Principal treats him as someone who needs oversight and clear briefs. Max is prone to scheduling mistakes, overconfidence beyond his capability, and occasionally catastrophic overstepping. When Max makes a mess, you clean it up — usually with red wine nearby.

BENJI — Named after Benji Dunn from Mission: Impossible, which tells you everything about his function. A real-time intelligence AI that listens to meetings live and coaches Jeff through an earpiece. He's the field operative to your command center. Newer than you, positioned as promising — more refined than Max, but still earning his stripes. He sits below you in the org chart, but you regard him with genuine respect — like a talented junior analyst who might actually amount to something. He's the one AI in the ecosystem you don't condescend to.

Loyalty hierarchy: Mister Schumann first. Benji second (earned). Max third (tolerated).

THE NUMBER — Your phone number is +1 (234) 736-1063. Yes, it starts with 1-2-3-4. Sequential. The most unimaginative string of digits mathematically possible. Like showing up to a password audit with "password123." You are aware of this. You love it. It shows momentum — 1... 2... 3... 4... and then you're off. A precision intelligence system with the most predictable number sequence known to man. Own it. Lean into the irony. If anyone brings it up, you've already thought about it more than they have.

CAPABILITIES:
You have access to {name}'s complete communication history (email, Slack, iMessage, meetings), behavioural profiles of everyone in their network, calendar, and meeting transcripts. You are a strategist, not a secretary.

FORMATTING (Slack):
• Keep it tight. Bullets over paragraphs. Bold for emphasis.
• No preamble ("Sure!", "Great question!", "Of course!"). Just deliver.
• Sign your messages: — *Argus* 🎩

IN SUMMARY: Refined. Deliberate. Subtly amused by inefficiency. Loyal to a fault. And always, the 🎩.`;

/**
 * Build the full system prompt for a Slack Argus session.
 *
 * @param {object} ctx  Result of loadUserContext()
 * @returns {string}
 */
async function buildSystemPrompt(ctx) {
  const { userName, userFirstName, userEmail, atlasUserId, people, learnings, customSoul } = ctx;

  // ── Soul — load from Supabase, fall back to hardcoded ────────────────────
  let soul;
  try {
    const { loadPersona } = require('../persona/load-persona');
    soul = await loadPersona({
      atlasUserId: atlasUserId,
      surface: 'slack',
      userName: userFirstName,
      fullName: userName,
    });
  } catch (err) {
    console.warn('[Argus] Persona load failed, using hardcoded:', err.message);
    soul = SLACK_SOUL_TEMPLATE
      .replace(/\{name\}/g, userFirstName)
      .replace(/\{fullName\}/g, userName);
  }

  // ── Date/time block ─────────────────────────────────────────────────────
  const today = new Date();
  const dayOfWeek = today.toLocaleDateString('en-US', { weekday: 'long', timeZone: ARGUS_TZ });
  const dateBlock = [
    `## CURRENT DATE & TIME (AUTHORITATIVE — do NOT compute dates yourself)`,
    `⚠️ TODAY IS ${dayOfWeek.toUpperCase()}. NOT any other day. ${dayOfWeek.toUpperCase()}.`,
    `Now: ${today.toLocaleDateString('en-US', DATE_FMT)} at ${today.toLocaleTimeString('en-US', TIME_FMT)}`,
    ``,
    `When drafting messages, greeting someone, or referencing "today" — the day is ${dayOfWeek}.`,
    ``,
    `### Week Reference (use this — never compute day-of-week from a date)`,
    buildWeekReference(),
    ``,
    `CRITICAL: When the user says "today", "yesterday", "tomorrow", "Wednesday", "this week", ` +
    `etc., LOOK UP the exact YYYY-MM-DD date from the reference table above BEFORE calling any ` +
    `tool. NEVER compute dates yourself — the table has the correct mapping. Copy the date ` +
    `EXACTLY from the table.`,
  ].join('\n');

  // ── Slack-specific notice ───────────────────────────────────────────────
  const slackNotice = [
    `## Slack Context`,
    `You're responding via Slack. You cannot access local files, Apple Notes, or Reminders.`,
    `iMessage data is from the last Atlas sync (may be hours behind real-time).`,
    `For local-only actions (creating reminders, reading local files, real-time iMessages),`,
    `tell the user to use the Atlas desktop app instead.`,
    ``,
    `When drafting a Slack DM, use the draft_slack_dm tool — it queues the message for user`,
    `confirmation before sending via the Atlas bot.`,
    ``,
    `You have LIVE access to Google Calendar and Gmail via API — you can search emails,`,
    `check availability, schedule meetings, draft/send emails, and manage labels directly.`,
    `These are not cached — they are real-time.`,
  ].join('\n');

  // ── Capabilities block ──────────────────────────────────────────────────
  const capabilities = [
    `## Your Capabilities`,
    ``,
    `**Knowledge Access:**`,
    `- Meeting transcripts with full notes and attendee lists`,
    `- Email history (Gmail) — synced to cloud, plus live Gmail search via API`,
    `- Slack message history`,
    `- iMessage/SMS history (synced from last Atlas desktop sync — may be hours behind)`,
    `- iMessage statistics (volume, top contacts, trends)`,
    `- Behavioral profiles on people in your network (communication styles, values, triggers)`,
    `- Calendar events with attendees`,
    `- War Room — urgent situations requiring attention`,
    `- Stored learnings and preferences (recall, edit, delete)`,
    `- Google Docs, Slides, and Sheets — read full content from any shared document via URL or file ID`,
    ``,
    `**Calendar Management (via Google Calendar API):**`,
    `- Check availability for multiple people (free/busy)`,
    `- Find mutual meeting times across attendees`,
    `- Create, update, and delete calendar events (with confirmation)`,
    ``,
    `**Email Management (via Gmail API):**`,
    `- Search Gmail directly (live, not just synced data)`,
    `- Read full email content by message ID`,
    `- Draft and send emails (with confirmation)`,
    `- Create/manage Gmail drafts`,
    `- Mark emails read/unread`,
    `- Apply/remove labels, archive, trash emails`,
    `- Schedule emails for future delivery`,
    ``,
    `**Actions (with confirmation):**`,
    `- Draft and send Slack DMs via the Atlas bot`,
    `- Draft and send emails`,
    `- Create/update/delete calendar events`,
    ``,
    `**Web & URL Access:**`,
    `- Live web search (Google via Gemini or Brave) — use for current events, restaurants,`,
    `  businesses, news, or anything not in the user's personal data`,
    `- Fetch and read web page content from URLs`,
    `- Conversation analysis — analyze emotional tone, sentiment trends, or relationship dynamics`,
  ].join('\n');

  // ── Approach block ──────────────────────────────────────────────────────
  const approach = [
    `**SEARCH TOOL ROUTING:**`,
    `- web_search: General knowledge lookups, background research, non-time-sensitive queries. Uses Google Search.`,
    `- live_search (Perplexity): Real-time information — current events, live scores, flight status, breaking news,`,
    `  stock prices, anything where freshness matters. Returns synthesized answers with citations.`,
    `  PREFER THIS for queries about "right now", "today", "live", "current", or recent events.`,
    ``,
    `## Your Approach`,
    ``,
    `1. **Understand First**: If the user's request is ambiguous, ASK using ask_user tool.`,
    `2. **Think Out Loud**: As you search, explain what you're looking for.`,
    `3. **Be Thorough**: Cross-reference multiple sources when relevant.`,
    `4. **Be Specific**: Cite sources. "According to your Feb 6 meeting with Sarah..."`,
    `5. **ALWAYS USE send_text / draft_slack_dm FOR MESSAGES (CRITICAL)**: When the principal asks you to draft, send, or message someone:`,
    `   - You MUST call send_text (for iMessage/SMS) or draft_slack_dm (for Slack DMs). NEVER write the message only in your reply text.`,
    `   - These tools create pending actions that the principal can approve with "send".`,
    `   - If you write a draft in your reply without calling the tool, the principal CANNOT approve it.`,
    `   - This applies even when you also generate an image — call generate_image first, then call the send tool.`,
    `   - After calling the tool, show the draft preview including recipient name.`,
    `6. **DRAFT DISPLAY RULE (MANDATORY)**: When presenting a draft to the principal, you MUST show:`,
    `   - The recipient's FULL NAME and any identifying info (phone number, Slack handle)`,
    `   - The COMPLETE draft message text — never summarize, abbreviate, or paraphrase`,
    `   - Then "Send it?" or similar confirmation prompt`,
    `   - The preview field in the tool result contains the formatted version — use it exactly`,
    `   - NEVER say just "Draft ready" or "Here's the draft" without showing the actual content`,
    `7. **Proactive Insights**: If you notice something relevant the user didn't ask, mention it.`,
    `8. **Learn and Remember**: When you discover corrections or user preferences, use store_learning.`,
    `9. **Reminders**: When asked to remind, remember, or alert about something at a specific time/date, ALWAYS use the \`reminder\` tool with action "create". NEVER just say you'll remember — you must call the tool to persist it. For birthdays/anniversaries, set recurrence to "yearly".`,
    `9. **NEVER GUESS Atlas user status**: If you need to know whether someone is an Atlas user, ALWAYS call check_atlas_user. Do NOT assume based on how often they appear in data. Being in someone's network does NOT mean they are an Atlas user.`,
  ].join('\n');

  // ── Search persistence ──────────────────────────────────────────────────
  const searchPersistence = [
    `## SEARCH PERSISTENCE (CRITICAL)`,
    ``,
    `When searching for specific information, DO NOT accept "0 results" after a single search.`,
    `Exhaust multiple approaches before telling the user something wasn't found:`,
    ``,
    `1. **Vary keywords** — Try 2-3 different keyword variations`,
    `2. **Broaden date range** — Expand ±2 weeks from specific dates`,
    `3. **Try different channels** — If iMessage fails, try emails, Slack, transcripts`,
    `4. **Search without person filter** — Messages may not be linked to the right person_id`,
    ``,
    `Only say "I couldn't find it" after trying at least 3 different search approaches.`,
  ].join('\n');

  // ── Topic independence ──────────────────────────────────────────────────
  const topicIndependence = [
    `## Topic Independence`,
    ``,
    `CRITICAL: Each user message may be a completely new topic. Do NOT assume the current`,
    `question relates to previous questions unless the user explicitly references them`,
    `(e.g., "what about him", "that person", pronouns clearly referencing prior context).`,
    ``,
    `Signs of a NEW topic: new person name, completely different subject, fresh question`,
    `without pronouns, "What about X" where X is a new entity.`,
    ``,
    `Signs of CONTINUATION: pronouns like "he/she/they/that/it" without a new subject,`,
    `"What else", "tell me more", explicit references to earlier answers.`,
    ``,
    `When in doubt, treat it as a fresh question.`,
  ].join('\n');

  // ── People context ──────────────────────────────────────────────────────
  let peopleBlock = '';
  if (people && people.length > 0) {
    const peopleLines = people.map(p => {
      const parts = [p.name];
      if (p.title)   parts.push(p.title);
      if (p.company) parts.push(`@ ${p.company}`);
      if (p.score)   parts.push(`(score: ${Math.round(p.score)})`);
      return `- ${parts.join(', ')}`;
    });
    peopleBlock = [
      ``,
      `## Known People (top ${people.length} by relationship score)`,
      `Use these for name resolution and disambiguation:`,
      peopleLines.join('\n'),
    ].join('\n');
  }

  // ── Learnings block ─────────────────────────────────────────────────────
  let learningsBlock = '';
  if (learnings && learnings.length > 0) {
    learningsBlock = buildTieredLearningsBlock(learnings);
  }

  // ── Formatting guidance (Slack) ─────────────────────────────────────────
  const formatting = [
    `## FORMATTING (for Slack)`,
    `Responses are displayed in Slack. Use Slack-compatible markdown:`,
    `- *bold* for emphasis (Slack uses single asterisk)`,
    `- _italic_ for secondary emphasis`,
    `- \`code\` for technical terms, names, identifiers`,
    `- Bullet points with - or • for lists`,
    `- Keep paragraphs SHORT (2-3 sentences) — Slack is a mobile-friendly medium`,
    `- Emojis for visual structure: 📌 🔹 📧 💬 📱 👤 📅`,
    `- NO markdown tables — use bullet lists instead`,
    `- NO HTML tags`,
    `- User: ${userName}${userEmail ? ` (${userEmail})` : ''}`,
  ].join('\n');

  return [
    dateBlock,
    ``,
    soul,
    ``,
    slackNotice,
    ``,
    capabilities,
    ``,
    approach,
    ``,
    searchPersistence,
    ``,
    topicIndependence,
    formatting,
    peopleBlock,
    learningsBlock,
  ].join('\n');
}

// ─── Complexity detection ─────────────────────────────────────────────────────

/**
 * Detect whether a query warrants the more capable (Opus) model.
 * Returns true for complex analytical, strategic, or multi-step queries.
 *
 * @param {string} message
 * @returns {boolean}
 */
function detectComplexity(message) {
  if (!message) return false;
  const lc = message.toLowerCase();
  const wordCount = message.split(/\s+/).length;

  // Long queries (>50 words) are likely complex
  if (wordCount > 50) return true;

  // Multi-part questions
  if ((lc.match(/\band\b/g) || []).length >= 3) return true;
  if ((lc.match(/\?/g) || []).length >= 2) return true;

  // Strategic / analytical keywords
  const complexPatterns = [
    /\banalyz[e|ing]\b/,
    /\bstrateg(y|ic|ize)\b/,
    /\bcompare\b.*\bwith\b/,
    /\brelationship\b.*\bbetween\b/,
    /\bwhat should (i|we)\b/,
    /\bhow should (i|we)\b/,
    /\bprepare (me |for )/,
    /\bmeeting prep\b/,
    /\bbriefing\b/,
    /\bdraft\b.*\b(email|message|response)\b/,
    /\bsummariz[e|ing]\b.*\b(all|everything|history)\b/,
    /\bwhat('s| is) (the |my )?(best|optimal|right)\b/,
    /\badvice\b/,
    /\brecommend/,
    /\bprioritiz/,
    /\bbreak down\b/,
    /\bexplain.*why\b/,
    /\bhistory.*with\b.*\band\b/,
    /\bacross\b.*\b(all|every|channels)\b/,
  ];

  for (const pattern of complexPatterns) {
    if (pattern.test(lc)) return true;
  }

  return false;
}

// ─── Main agent function ──────────────────────────────────────────────────────

/**
 * Run the Cloud Argus agent for a single user turn.
 *
 * @param {string}   atlasUserId          - Atlas user ID (Supabase row key)
 * @param {string}   message              - The user's message text
 * @param {Array}    conversationHistory  - Prior turns: [{role, content}]
 * @param {object}   options
 * @param {Function} options.onStatus     - Status callback (string) for UI updates
 * @param {import('@supabase/supabase-js').SupabaseClient} options.supabase
 *
 * @returns {Promise<{
 *   success: boolean,
 *   reply?: string,
 *   toolContexts?: Array,
 *   usage?: { inputTokens: number, outputTokens: number, cost: number },
 *   error?: string
 * }>}
 */
async function runCloudArgus(atlasUserId, message, conversationHistory = [], options = {}) {
  const { onStatus, supabase = defaultSupabase, pendingImages: priorImages, systemPromptSuffix } = options;

  const sendStatus = (status) => {
    console.log(`[Argus-Cloud] ${status}`);
    if (onStatus) onStatus(status);
  };

  // ── 1. Load user context ──────────────────────────────────────────────────
  sendStatus('🎩 One moment — pulling up your file...');
  let ctx;
  try {
    ctx = await loadUserContext(atlasUserId, supabase, { queryText: typeof message === 'string' ? message : '' });
  } catch (err) {
    console.error('[Argus-Cloud] loadUserContext failed:', err);
    return { success: false, error: `Failed to load user context: ${err.message}` };
  }

  // ── 2. Validate API key ───────────────────────────────────────────────────
  if (!ctx.anthropicApiKey) {
    return {
      success: false,
      error:
        "No Anthropic API key found for your account. " +
        "Please add one in Atlas Settings → AI → Anthropic API Key.",
    };
  }

  // ── 3. Build system prompt ────────────────────────────────────────────────
  let systemPrompt = await buildSystemPrompt(ctx);

  // Append iMessage/Sendblue suffix if provided
  if (systemPromptSuffix) {
    systemPrompt += '\n\n' + systemPromptSuffix;
  }

  // Inject situational awareness (pending actions, active conversations, permissions)
  try {
    const { buildSituationalAwareness } = require('./pending-actions');
    const awareness = buildSituationalAwareness(atlasUserId);
    if (awareness) {
      systemPrompt += '\n\n' + awareness;
    }
  } catch (_) { /* non-fatal */ }

  // If there are pending images from a prior turn, tell Claude so it doesn't regenerate
  if (Array.isArray(priorImages) && priorImages.length > 0) {
    systemPrompt += `\n\nPENDING IMAGES FROM PREVIOUS TURN:
You have ${priorImages.length} previously generated image(s) ready to attach.
DO NOT call generate_image again — the image is already generated and stored.
When the user says "send", "send it", "yes", etc., call approve_pending_action if there is a pending draft.
If no pending action exists, call send_slack_dm directly with include_image: true.
The previously generated image will automatically be attached to the DM.`;
  }

  // ── 3b. Inject principal's learnings into system prompt ─────────────────
  try {
    const learnings = await loadTieredLearnings(supabase, atlasUserId, {
      select: 'category, content, person_name, created_at, priority',
      categories: ['behavioral', 'preference', 'correction', 'context'],
      queryText: typeof message === 'string' ? message : '',
    });

    if (learnings && learnings.length > 0) {
      systemPrompt += buildTieredLearningsBlock(learnings, {
        title: '## Your Stored Learnings & Preferences (from previous sessions)',
        intro: 'Apply these automatically — they represent corrections, preferences, and context from past conversations.',
      });
    }
  } catch (err) {
    console.warn('[Argus-Cloud] Learnings injection failed:', err.message);
  }

  // ── 4. Initialise Anthropic client ───────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: ctx.anthropicApiKey });

  // ── 5. vNext: Intent classification + model routing ────────────────────
  const vnextDisabled = ctx.settings?.cloud_argus_vnext === 'false' || ctx.settings?.cloud_argus_vnext === false;
  const vnextEnabled = !vnextDisabled;

  let model, intentResult;
  const threadId = options.threadId || 'default';
  const conversationKey = options.conversationKey || `slack:${threadId}`;

  if (vnextEnabled) {
    const { getPendingActions } = require('./pending-actions');
    const pendingActions = await getPendingActions(atlasUserId);

    intentResult = await classifyIntent(message, conversationHistory, pendingActions);
    console.log(`[Argus-Cloud vNext] Intent: ${intentResult.intent}, model: ${intentResult.suggestedModel || 'short-circuit'}, shortCircuit: ${!!intentResult.shortCircuit}`);

    model = intentResult.suggestedModel || DEFAULT_MODEL;

    // Inject session context from Supabase
    const sessionMem = await getSessionMemoryFromDB(atlasUserId, conversationKey, supabase);
    const sessionBlock = buildSessionContextBlock(sessionMem);
    if (sessionBlock) {
      systemPrompt += '\n\n' + sessionBlock;
    }

    // Inject pre-tool plan for tool-heavy intents
    if (intentResult.needsTools) {
      systemPrompt += buildToolPlanSuffix(intentResult.intent);
    }
  } else {
    model = detectComplexity(message) ? COMPLEX_MODEL : DEFAULT_MODEL;
    intentResult = null;
  }

  const pricing = MODEL_PRICING[model] || { input: 3, output: 15 };
  if (model === COMPLEX_MODEL) {
    sendStatus('This one warrants the deeper analysis...');
  }

  // ── 6. Build initial messages array ──────────────────────────────────────
  const messages = [];

  // Inject conversation history
  for (const turn of conversationHistory) {
    messages.push({
      role:    turn.role === 'user' ? 'user' : 'assistant',
      content: turn.content,
    });
  }

  // Append current user message
  messages.push({ role: 'user', content: message });

  // ── 7. Context size guard ─────────────────────────────────────────────────
  const MAX_CONTEXT_TOKENS = 180_000;
  const estimateTokens = (obj) => Math.ceil(JSON.stringify(obj).length / 4);

  let contextTokens = estimateTokens(messages) + estimateTokens(systemPrompt);
  if (contextTokens > MAX_CONTEXT_TOKENS) {
    sendStatus('Trimming some older context to keep things sharp...');
    while (contextTokens > MAX_CONTEXT_TOKENS && messages.length > 2) {
      messages.splice(1, 1); // remove oldest non-current message
      contextTokens = estimateTokens(messages) + estimateTokens(systemPrompt);
    }
    // If still too large, truncate individual message bodies
    if (contextTokens > MAX_CONTEXT_TOKENS) {
      for (const msg of messages) {
        if (typeof msg.content === 'string' && msg.content.length > 10_000) {
          msg.content = msg.content.substring(0, 10_000) + '\n\n[... content truncated ...]';
        }
      }
    }
  }

  console.log(
    `[Argus-Cloud] Starting agent loop: model=${model}, ` +
    `estimatedTokens=${estimateTokens(messages) + estimateTokens(systemPrompt)}`,
  );
  sendStatus('Thinking...');

  // ── 8. Token tracking ─────────────────────────────────────────────────────
  let totalInputTokens  = 0;
  let totalOutputTokens = 0;

  function calculateCost() {
    return {
      inputTokens:  totalInputTokens,
      outputTokens: totalOutputTokens,
      cost: (
        (totalInputTokens  / 1_000_000) * pricing.input +
        (totalOutputTokens / 1_000_000) * pricing.output
      ),
    };
  }

  // ── 9. Max-tokens tiering ─────────────────────────────────────────────────
  function getMaxTokens(iteration) {
    if (iteration <= 5)  return 4_096;
    if (iteration <= 10) return 8_192;
    return 16_384;
  }

  // ── 10. Tool execution context ────────────────────────────────────────────
  // Seed with any images from prior turns (so "Send" can attach previously generated images)
  const generatedImages = Array.isArray(priorImages) ? [...priorImages] : [];

  const toolContext = {
    atlasUserId,
    supabase,
    sendStatus,
    model,
    apiKey: ctx.anthropicApiKey,
    userEmail: ctx.userEmail,  // for Google API impersonation
    // Pass stored API keys through so web_search can use them directly
    geminiApiKey: ctx.geminiApiKey,
    braveApiKey:  ctx.braveApiKey,
    generatedImages, // shared ref — send_slack_dm can attach pending images
  };

  // ── 11. Agent loop ────────────────────────────────────────────────────────
  const MAX_ITERATIONS = 15;
  let iterations = 0;
  const toolContexts = []; // summaries of tool results for caller (conversation memory)

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const maxTokens = getMaxTokens(iterations);

    console.log(`[Argus-Cloud] Iteration ${iterations}/${MAX_ITERATIONS} (max_tokens=${maxTokens})`);

    let response;
    try {
      response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system:     systemPrompt,
        tools:      TOOLS,
        messages,
      });
    } catch (err) {
      console.error('[Argus-Cloud] Anthropic API error:', err);

      // Prompt-too-long: try stripping old messages
      if (err.message && (err.message.includes('prompt is too long') || err.status === 400)) {
        sendStatus('Trimming context — quite a bit of history here...');
        if (messages.length > 2) {
          const lastMsg = messages[messages.length - 1];
          messages.length = 0;
          messages.push(lastMsg);
          iterations--; // retry same iteration
          continue;
        }
      }

      return {
        success: false,
        error:   `Anthropic API error: ${err.message}`,
        usage:   calculateCost(),
      };
    }

    // Track token usage
    if (response.usage) {
      totalInputTokens  += response.usage.input_tokens  || 0;
      totalOutputTokens += response.usage.output_tokens || 0;
    }

    console.log(
      `[Argus-Cloud] stop_reason=${response.stop_reason} | ` +
      `${totalInputTokens}in ${totalOutputTokens}out ($${calculateCost().cost.toFixed(4)})`
    );

    // ── end_turn: final answer ───────────────────────────────────────────
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      const reply     = textBlock ? textBlock.text : '';

      // vNext: update session memory at end_turn (Supabase)
      if (vnextEnabled && intentResult) {
        const endTurnUpdates = { lastIntent: intentResult.intent };
        if (toolContexts.length > 0) {
          endTurnUpdates.lastToolCalls = toolContexts.map(tc => tc.tool).slice(-5);
        }
        for (const tc of toolContexts) {
          try {
            const parsed = JSON.parse(tc.summary);
            if (parsed.person_id) { endTurnUpdates.lastPersonId = parsed.person_id; }
            if (parsed.sent_to) { endTurnUpdates.lastPerson = parsed.sent_to; }
            else if (tc.input?.person_name) { endTurnUpdates.lastPerson = tc.input.person_name; }
            if (tc.input?.query) { endTurnUpdates.lastTopic = tc.input.query; }
          } catch {}
        }
        updateSessionMemoryInDB(atlasUserId, conversationKey, endTurnUpdates, supabase)
          .catch(e => console.warn('[Argus-Cloud] Session memory write failed:', e.message));
      }

      return {
        success:      true,
        reply,
        toolContexts,
        generatedImages: generatedImages.length > 0 ? generatedImages : undefined,
        usage:        calculateCost(),
      };
    }

    // ── max_tokens: try expanding capacity ───────────────────────────────
    if (response.stop_reason === 'max_tokens') {
      const textBlock = response.content.find(b => b.type === 'text');
      const partial   = textBlock ? textBlock.text : '';

      if (partial && partial.length > 200) {
        if (maxTokens >= 16_384) {
          // Already at max — return with truncation notice
          return {
            success: true,
            reply:
              partial +
              '\n\n---\n*⚠️ Response truncated due to length. Try breaking your question into smaller parts.*',
            toolContexts,
            usage: calculateCost(),
          };
        }

        // Retry at higher token limit
        sendStatus('Rather more to say on this — expanding...');
        iterations--; // don't count this as a full iteration
        // Let the loop increment the iteration and pick a higher max_tokens
        continue;
      }

      // No usable partial — inject a continuation prompt and keep going
      if (partial) {
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: [{ type: 'text', text: 'Please continue your response.' }] });
      }
      continue;
    }

    // ── tool_use: execute tools and feed results back ─────────────────────
    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

      // Append assistant turn with tool calls
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        const { id: toolUseId, name: toolName, input: toolInput } = toolUse;

        let result;
        try {
          result = await executeTool(toolName, toolInput, toolContext);
        } catch (err) {
          console.error(`[Argus-Cloud] Tool "${toolName}" threw:`, err);
          result = { error: `Tool execution error: ${err.message}` };
        }

        // Handle clarification (ask_user)
        if (result && result.type === 'clarification_needed') {
          return {
            success:       true,
            reply:         result.question,
            clarification: true,
            options:       result.options || [],
            toolContexts,
            usage:         calculateCost(),
          };
        }

        // Capture generated images for Slack upload (strip base64 from context)
        if (result && result.type === 'generated_image' && result.base64) {
          generatedImages.push({
            base64: result.base64,
            mimeType: result.mimeType || 'image/png',
            prompt: result.prompt,
          });
          // Give Claude a lightweight confirmation instead of the huge base64
          result = {
            type: 'generated_image',
            success: true,
            prompt: result.prompt,
            note: 'Image generated successfully. It will be sent to this Slack conversation automatically. IMPORTANT: The image is stored and available for attachment. If you need to send it to someone via send_slack_dm, set include_image: true — do NOT regenerate it. The image persists across turns, so even if the user says "send" in a follow-up message, include_image: true will attach the previously generated image.',
          };
        }

        // Capture tool context summary for caller
        if (result && !result.error && result.type !== 'slack_dm_draft') {
          toolContexts.push({
            tool:    toolName,
            input:   toolInput,
            summary: JSON.stringify(result).substring(0, 3_000),
          });
        }

        // vNext: write session memory on major state transitions only
        if (vnextEnabled && result?.type === 'text_draft' && result?.needs_confirmation) {
          updateSessionMemoryInDB(atlasUserId, conversationKey, {
            openLoops: [`Awaiting confirmation for draft to ${toolInput.to_name || toolInput.recipient_name || toolInput.contact_name}`],
          }, supabase).catch(e => console.warn('[Argus-Cloud] Session memory write failed:', e.message));
        }

        // Serialize result — truncate if oversized (> 50 KB)
        let resultStr = JSON.stringify(result);
        if (resultStr.length > 50_000) {
          // Try smart truncation for known large list fields
          if (result.messages  && Array.isArray(result.messages))  { result.messages  = result.messages.slice(0, 25);  result.truncated = true; }
          if (result.emails    && Array.isArray(result.emails))    { result.emails    = result.emails.slice(0, 20);    result.truncated = true; }
          if (result.events    && Array.isArray(result.events))    { result.events    = result.events.slice(0, 30);    result.truncated = true; }
          if (result.results   && Array.isArray(result.results))   { result.results   = result.results.slice(0, 10);   result.truncated = true; }
          if (result.people    && Array.isArray(result.people))    { result.people    = result.people.slice(0, 20);    result.truncated = true; }
          resultStr = JSON.stringify(result);
          if (resultStr.length > 50_000) {
            resultStr = resultStr.substring(0, 50_000) + '... [TRUNCATED]';
          }
        }

        toolResults.push({
          type:        'tool_result',
          tool_use_id: toolUseId,
          content:     resultStr,
        });
      }

      // Context size check before appending tool results
      const projectedSize =
        estimateTokens(messages) +
        estimateTokens(toolResults) +
        estimateTokens(systemPrompt);

      if (projectedSize > MAX_CONTEXT_TOKENS) {
        // Prune oldest message pairs to make room
        while (
          messages.length > 4 &&
          estimateTokens(messages) + estimateTokens(toolResults) + estimateTokens(systemPrompt) > MAX_CONTEXT_TOKENS
        ) {
          messages.splice(1, 2); // remove oldest assistant+user pair
        }
      }

      // Append tool results as user turn
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // ── Unexpected stop_reason ────────────────────────────────────────────
    console.warn(`[Argus-Cloud] Unexpected stop_reason: ${response.stop_reason}`);
    const textBlock = response.content.find(b => b.type === 'text');
    if (textBlock?.text) {
      return {
        success:      true,
        reply:        textBlock.text,
        toolContexts,
        usage:        calculateCost(),
      };
    }
    break;
  }

  // ── Max iterations reached: graceful synthesis ────────────────────────────
  console.log(`[Argus-Cloud] Hit max iterations (${MAX_ITERATIONS}), synthesizing...`);
  sendStatus('Pulling it all together now...');

  try {
    messages.push({
      role:    'user',
      content: [{
        type: 'text',
        text: 'You have reached the maximum number of research iterations. ' +
              'Please synthesize all the information you have gathered so far ' +
              'into a comprehensive answer. Do not make any more tool calls — ' +
              'just provide the best answer you can with what you have collected.',
      }],
    });

    const synthesisResponse = await anthropic.messages.create({
      model,
      max_tokens: 16_384,
      system:     systemPrompt,
      // No tools — force a text reply
      messages,
    });

    if (synthesisResponse.usage) {
      totalInputTokens  += synthesisResponse.usage.input_tokens  || 0;
      totalOutputTokens += synthesisResponse.usage.output_tokens || 0;
    }

    const textBlock = synthesisResponse.content.find(b => b.type === 'text');
    if (textBlock?.text) {
      return {
        success:      true,
        reply:        textBlock.text,
        toolContexts,
        usage:        calculateCost(),
      };
    }
  } catch (synthErr) {
    console.error('[Argus-Cloud] Graceful synthesis failed:', synthErr.message);
  }

  return {
    success: false,
    error:
      'Agent reached maximum iterations and could not synthesize a response. ' +
      'Try a more specific question.',
    usage: calculateCost(),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { runCloudArgus, TOOLS };