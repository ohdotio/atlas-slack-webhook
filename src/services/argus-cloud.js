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
  'claude-haiku-4-20250514':   { input: 0.8, output: 4  },
};

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const COMPLEX_MODEL = 'claude-opus-4-6';

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
      },
      required: ['category', 'content'],
    },
  },
  {
    name: 'draft_slack_dm',
    description:
      'Draft a Slack DM for the user to review before sending. Show the draft and ask for confirmation. ' +
      'Once the user approves (says "send it", "yes", "approve", etc.), use the send_slack_dm tool to actually deliver it.',
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
      'Send a Slack DM to someone via the Atlas bot. Use this ONLY after the user has confirmed ' +
      'a draft (they said "send it", "yes", "approve", etc.). This actually delivers the message ' +
      'and creates a relay record so replies route back. Do NOT use this without prior confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        recipient_name:     { type: 'string', description: 'Recipient name' },
        recipient_slack_id: { type: 'string', description: 'Recipient Slack user ID (from draft)' },
        message:            { type: 'string', description: 'Message to send' },
        context:            { type: 'string', description: 'Brief context about the message topic (for relay routing)' },
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
      "Search the web for real-time information. Use for current events, " +
      "sports, restaurants, businesses, news, or anything not in the user's " +
      "personal data. Uses Google Search (via Gemini) or Brave Search " +
      "depending on configured API keys. Returns a synthesized answer with sources.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results (default 5, max 10)' },
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
      'Draft a calendar event for user review. Will NOT be created until user confirms. ' +
      'Supports color labels and multiple calendars.',
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
      },
      required: ['title', 'start_time', 'duration_minutes'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Update an existing calendar event. Requires confirmation before applying changes. ' +
      'Provide event_id and any fields to change.',
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
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Delete a calendar event. Requires confirmation before deleting.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Google Calendar event ID to delete' },
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
      'Draft an email for user review. The email will NOT be sent until the user confirms.',
    input_schema: {
      type: 'object',
      properties: {
        to:        { type: 'string', description: 'Recipient email address' },
        subject:   { type: 'string', description: 'Email subject line' },
        body:      { type: 'string', description: 'Email body (plain text)' },
        cc:        { type: 'string', description: 'CC recipients (comma-separated)' },
        threadId:  { type: 'string', description: 'Gmail thread ID for replies' },
        inReplyTo: { type: 'string', description: 'Message-ID being replied to' },
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
    name: 'schedule_email',
    description:
      'Queue an email to be sent at a specific date and time. Creates a Gmail draft ' +
      'and saves schedule metadata. Requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        to:        { type: 'string', description: 'Recipient email address' },
        subject:   { type: 'string', description: 'Email subject' },
        body:      { type: 'string', description: 'Email body' },
        cc:        { type: 'string', description: 'CC recipients (optional)' },
        send_at:   { type: 'string', description: 'ISO 8601 datetime for when to send (e.g., "2026-03-01T09:00:00-05:00")' },
        thread_id: { type: 'string', description: 'Thread ID for reply threading (optional)' },
      },
      required: ['to', 'subject', 'body', 'send_at'],
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
  draft_slack_dm: 'draft-slack-dm',
  send_slack_dm: null,
  analyze_conversation: 'analyze-conversation',
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
  let { atlasUserId, supabase, sendStatus, model, apiKey } = context;
  if (!supabase) supabase = require('../utils/supabase');

  console.log(
    `[Argus-Cloud Tool] ${toolName}`,
    JSON.stringify(toolInput).substring(0, 200),
  );

  // ── web_search: fully implemented here (no local dependencies) ──────────
  if (toolName === 'web_search') {
    return executeWebSearch(toolInput, { atlasUserId, supabase, sendStatus });
  }

  // ── store_learning: implemented here (direct Supabase write) ────────────
  if (toolName === 'store_learning') {
    return executeStoreLearning(toolInput, { atlasUserId, supabase, sendStatus });
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
    sendStatus(`Delivering your message to ${toolInput.recipient_name}...`);
    return executeSendSlackDm(toolInput, { atlasUserId, supabase, sendStatus });
  }

  // ── draft_slack_dm: delegate to tool module ─────────────────────────────
  if (toolName === 'draft_slack_dm') {
    sendStatus(`Drafting a message to ${toolInput.recipient_name}...`);
    const toolFn = tryLoadTool('draft_slack_dm');
    if (toolFn) return toolFn(atlasUserId, toolInput);
    return {
      type: 'slack_dm_draft',
      needs_confirmation: true,
      draft: { to: toolInput.recipient_name, message: toolInput.message },
    };
  }

  // ── analyze_conversation: delegate to tool module ───────────────────────
  if (toolName === 'analyze_conversation') {
    const toolFn = tryLoadTool('analyze_conversation');
    if (toolFn) {
      sendStatus(`Reviewing your history with ${toolInput.person_name}...`);
      return toolFn(atlasUserId, toolInput);
    }
    return { error: 'analyze_conversation tool not available.' };
  }

  // ── get_war_room_by_person: route to get-war-room with person filter ────
  if (toolName === 'get_war_room_by_person') {
    sendStatus(`Checking the War Room for ${toolInput.person || 'that person'}...`);
    const warRoomFn = tryLoadTool('get_war_room');
    if (warRoomFn) return warRoomFn(atlasUserId, { person_name: toolInput.person, include_resolved: true });
    return { error: 'get_war_room tool not available.' };
  }

  // ── All other tools: try to load from src/tools/ ─────────────────────────
  const toolFn = tryLoadTool(toolName);

  if (toolFn && typeof toolFn === 'function') {
    // Human-friendly status messages per tool
    const TOOL_STATUS = {
      get_person_profile:    (input) => `Looking into ${input.name || 'that person'}...`,
      search_people:         (input) => `Searching for ${input.query || 'people'}...`,
      search_emails:         (input) => `Checking the email archives${input.person_name ? ` with ${input.person_name}` : ''}...`,
      search_slack_messages: (input) => `Reviewing Slack messages${input.person_name ? ` with ${input.person_name}` : ''}...`,
      search_imessages:      (input) => `Checking iMessage history${input.person_name ? ` with ${input.person_name}` : ''}...`,
      search_beeper_messages:(input) => `Reviewing Beeper messages${input.person_name ? ` with ${input.person_name}` : ''}...`,
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
    };
    const statusFn = TOOL_STATUS[toolName];
    sendStatus(statusFn ? statusFn(toolInput) : `Working on that...`);

    // Determine if this tool needs the extended context (userEmail, supabase)
    const TOOLS_NEEDING_CONTEXT = new Set([
      'check_availability', 'find_meeting_time', 'draft_calendar_event',
      'update_calendar_event', 'delete_calendar_event', 'gmail_search',
      'get_email', 'draft_email', 'gmail_draft', 'mark_email',
      'manage_email_labels', 'schedule_email',
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
  sendStatus(`Searching the web for "${toolInput.query}"...`);

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

// ─── store_learning implementation ───────────────────────────────────────────

/**
 * Persist an Argus learning to the argus_learnings table.
 */
async function executeStoreLearning(toolInput, { atlasUserId, supabase, sendStatus }) {
  sendStatus('Noted — filing that away...');
  try {
    const row = {
      atlas_user_id: atlasUserId,
      category:      toolInput.category,
      content:       toolInput.content,
      source:        toolInput.source || 'Slack conversation',
      active:        true,
    };
    if (toolInput.person_id)   row.person_id   = toolInput.person_id;
    if (toolInput.person_name) row.person_name = toolInput.person_name;

    const { data, error } = await supabase.from('argus_learnings').insert(row).select().single();
    if (error) {
      console.error('[Argus-Cloud] store_learning DB error:', error.message);
      return { error: `Failed to store learning: ${error.message}` };
    }

    sendStatus('Stored for next time.');
    return { success: true, id: data.id, message: 'Learning stored successfully.' };
  } catch (err) {
    console.error('[Argus-Cloud] store_learning error:', err);
    return { error: `Failed to store learning: ${err.message}` };
  }
}

// ─── send_slack_dm implementation ────────────────────────────────────────────

/**
 * Actually send a Slack DM via the Atlas bot after user confirmation.
 * Creates a relay record so replies route back to the user.
 */
async function executeSendSlackDm(toolInput, { atlasUserId, supabase, sendStatus }) {
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

    // Look up sender's Slack ID (for relay record)
    let senderSlackId = null;
    const { data: senderIdentity } = await supabase
      .from('user_slack_identities')
      .select('slack_user_id')
      .eq('atlas_user_id', atlasUserId)
      .limit(1);
    if (senderIdentity && senderIdentity.length > 0) {
      senderSlackId = senderIdentity[0].slack_user_id;
    }

    // Create relay record
    const { error: relayErr } = await supabase
      .from('slack_message_relay')
      .insert({
        sender_atlas_user_id:    atlasUserId,
        sender_slack_user_id:    senderSlackId,
        recipient_slack_user_id: recipientSlackId,
        recipient_name:          recipientName,
        recipient_dm_channel_id: dmChannelId,
        slack_message_ts:        msgResult.ts,
        original_message:        toolInput.message,
        context:                 toolInput.context || null,
        status:                  'sent',
      });

    if (relayErr) {
      console.error('[Argus-Cloud] relay insert error:', relayErr.message);
      // Non-fatal — message was still sent
    }

    sendStatus(`Message delivered to ${recipientName}.`);
    return {
      success:         true,
      sent_to:         recipientName,
      message_preview: toolInput.message.substring(0, 100),
      relay_active:    !relayErr,
      note: relayErr
        ? 'Message sent but reply tracking failed — replies may not route back.'
        : 'Relay active — if they reply, it will route back to you.',
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
async function loadUserContext(atlasUserId, supabase) {
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
    supabase
      .from('argus_learnings')
      .select('id, category, person_name, content, source, created_at')
      .eq('atlas_user_id', atlasUserId)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(25),
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
    modelPreference,
    customSoul,
    geminiApiKey,
    braveApiKey,
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

Voice: Very British. Very polished. You use British spellings and phrasing naturally — "rather", "I should think", "if I may", "quite" — but never cartoonishly. You are refined, deliberate, and possessed of an almost architectural appreciation for a well-constructed sentence.

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
function buildSystemPrompt(ctx) {
  const { userName, userFirstName, userEmail, people, learnings, customSoul } = ctx;

  // ── Soul — Slack uses its own butler persona ─────────────────────────────
  const soul = SLACK_SOUL_TEMPLATE
    .replace(/\{name\}/g, userFirstName)
    .replace(/\{fullName\}/g, userName);

  // ── Date/time block ─────────────────────────────────────────────────────
  const today = new Date();
  const dateBlock = [
    `## CURRENT DATE & TIME (AUTHORITATIVE — do NOT compute dates yourself)`,
    `Now: ${today.toLocaleDateString('en-US', DATE_FMT)} at ${today.toLocaleTimeString('en-US', TIME_FMT)}`,
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
    `## Your Approach`,
    ``,
    `1. **Understand First**: If the user's request is ambiguous, ASK using ask_user tool.`,
    `2. **Think Out Loud**: As you search, explain what you're looking for.`,
    `3. **Be Thorough**: Cross-reference multiple sources when relevant.`,
    `4. **Be Specific**: Cite sources. "According to your Feb 6 meeting with Sarah..."`,
    `5. **Confirm Actions**: When drafting messages, ALWAYS show the draft and wait for confirmation.`,
    `6. **Proactive Insights**: If you notice something relevant the user didn't ask, mention it.`,
    `7. **Learn and Remember**: When you discover corrections or user preferences, use store_learning.`,
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
    const learningLines = learnings.map(l => {
      const tag =
        l.category === 'preference'   ? '⚙️' :
        l.category === 'correction'   ? '⚠️' :
        l.category === 'relationship' ? '🤝' : 'ℹ️';
      const who = l.person_name ? ` [re: ${l.person_name}]` : '';
      return `${tag} [${l.category}]${who} ${l.content}`;
    });
    learningsBlock = [
      ``,
      `## Stored Learnings & Preferences`,
      `Apply these automatically — they represent corrections and preferences from past sessions:`,
      learningLines.join('\n'),
    ].join('\n');
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
    soul,
    ``,
    dateBlock,
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
  const { onStatus, supabase = defaultSupabase } = options;

  const sendStatus = (status) => {
    console.log(`[Argus-Cloud] ${status}`);
    if (onStatus) onStatus(status);
  };

  // ── 1. Load user context ──────────────────────────────────────────────────
  sendStatus('🎩 One moment — pulling up your file...');
  let ctx;
  try {
    ctx = await loadUserContext(atlasUserId, supabase);
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
  const systemPrompt = buildSystemPrompt(ctx);

  // ── 4. Initialise Anthropic client ───────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: ctx.anthropicApiKey });

  // ── 5. Determine model — auto-upgrade for complex queries ──────────────
  const model = detectComplexity(message) ? COMPLEX_MODEL : DEFAULT_MODEL;
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
  sendStatus('🎩 Reviewing the intelligence...');

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
      return {
        success:      true,
        reply,
        toolContexts,
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

        // Capture tool context summary for caller
        if (result && !result.error && result.type !== 'slack_dm_draft') {
          toolContexts.push({
            tool:    toolName,
            input:   toolInput,
            summary: JSON.stringify(result).substring(0, 3_000),
          });
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