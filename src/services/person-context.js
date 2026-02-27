'use strict';

/**
 * person-context.js — Safe person context for autonomous conversations.
 *
 * Looks up a Slack user in the Atlas people table and returns ONLY factual,
 * non-private information. Explicitly excludes:
 *   - profile_synthesis (behavioral analysis, communication style)
 *   - communication_dna (relationship dynamics, engagement playbook)
 *   - notes (Jeff's private annotations)
 *   - message content from any channel
 *
 * Safe to inject into the system prompt for non-Atlas user conversations.
 */

const supabase = require('../utils/supabase');

/**
 * Resolve the Atlas owner's user ID from user_slack_identities.
 * Cached after first resolution (single-owner system, stable per deploy).
 */
let _cachedOwnerAtlasUserId = null;
async function resolveOwnerAtlasUserId() {
  if (_cachedOwnerAtlasUserId) return _cachedOwnerAtlasUserId;
  const { data } = await supabase
    .from('user_slack_identities')
    .select('atlas_user_id')
    .limit(1)
    .maybeSingle();
  if (data?.atlas_user_id) {
    _cachedOwnerAtlasUserId = data.atlas_user_id;
  }
  return _cachedOwnerAtlasUserId;
}

/**
 * Look up a person by their Slack user ID and return safe context.
 *
 * Resolution path:
 *   1. Match slack_id in people table
 *   2. Fall back to Slack email → people.email match
 *
 * @param {string} slackUserId - Slack user ID (e.g. "U09CDJ5E3ML")
 * @param {string} [slackEmail] - Optional email from Slack profile
 * @returns {Promise<object|null>} Safe person context or null
 */
async function getPersonContext(slackUserId, slackEmail) {
  try {
    // Resolve the owner's Atlas user ID dynamically (not hardcoded)
    const ownerAtlasUserId = await resolveOwnerAtlasUserId();
    if (!ownerAtlasUserId) {
      console.warn('[person-context] Could not resolve owner Atlas user ID');
      return null;
    }

    // ── Try slack_id match first ──────────────────────────────────────────
    let person = null;

    const { data: bySlack } = await supabase
      .from('people')
      .select('id, name, company, title, location, sphere, tags, slack_username, email_count, slack_count, meeting_count, imessage_count')
      .eq('atlas_user_id', ownerAtlasUserId)
      .eq('slack_id', slackUserId)
      .eq('archived', 0)
      .eq('hidden', 0)
      .maybeSingle();

    if (bySlack) {
      person = bySlack;
    }

    // ── Fall back to email match ──────────────────────────────────────────
    if (!person && slackEmail) {
      const { data: byEmail } = await supabase
        .from('people')
        .select('id, name, company, title, location, sphere, tags, slack_username, email_count, slack_count, meeting_count, imessage_count')
        .eq('atlas_user_id', ownerAtlasUserId)
        .ilike('email', slackEmail)
        .eq('archived', 0)
        .eq('hidden', 0)
        .maybeSingle();

      if (byEmail) {
        person = byEmail;
      }
    }

    if (!person) return null;

    // ── Fetch recent topics (safe — just category names, no content) ──────
    let topics = [];
    try {
      const { data: topicRows } = await supabase
        .from('topics')
        .select('name, category, mention_count')
        .eq('person_id', person.id)
        .eq('atlas_user_id', ownerAtlasUserId)
        .order('mention_count', { ascending: false })
        .limit(8);

      if (topicRows) {
        topics = topicRows.map(t => t.name);
      }
    } catch (e) {
      // topics table might not exist — non-fatal
    }

    // ── Fetch recent transcription titles (meeting names, not content) ────
    let recentMeetings = [];
    try {
      // Get meetings from last 30 days that mention this person
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const { data: participantRows } = await supabase
        .from('transcription_participants')
        .select('transcription_id')
        .eq('person_id', person.id)
        .eq('atlas_user_id', ownerAtlasUserId)
        .limit(10);

      if (participantRows && participantRows.length > 0) {
        const transcriptionIds = participantRows.map(r => r.transcription_id);
        const { data: transcriptions } = await supabase
          .from('transcriptions')
          .select('title, recorded_at')
          .eq('atlas_user_id', ownerAtlasUserId)
          .in('id', transcriptionIds)
          .gte('recorded_at', thirtyDaysAgo.toISOString())
          .order('recorded_at', { ascending: false })
          .limit(5);

        if (transcriptions) {
          recentMeetings = transcriptions.map(t => t.title).filter(Boolean);
        }
      }
    } catch (e) {
      // non-fatal
    }

    // ── Build safe context object ─────────────────────────────────────────
    return {
      name: person.name,
      role: person.title || null,
      company: person.company || null,
      location: person.location || null,
      sphere: person.sphere || null,
      tags: person.tags ? person.tags.split(',').map(t => t.trim()) : [],
      activityLevel: categorizeActivity(person),
      topics: topics.length > 0 ? topics : null,
      recentMeetings: recentMeetings.length > 0 ? recentMeetings : null,
    };
  } catch (err) {
    console.error('[person-context] Error fetching person context:', err.message);
    return null;
  }
}

/**
 * Categorize someone's communication activity level (no raw numbers exposed).
 */
function categorizeActivity(person) {
  const total = (person.email_count || 0) + (person.slack_count || 0) +
                (person.meeting_count || 0) + (person.imessage_count || 0);

  if (total > 1000) return 'very active — works closely with the team';
  if (total > 200) return 'regular contact';
  if (total > 50) return 'occasional contact';
  if (total > 0) return 'light contact';
  return null;
}

/**
 * Format person context as a string for injection into a system prompt.
 *
 * @param {object} ctx - Output from getPersonContext()
 * @returns {string}
 */
function formatPersonContext(ctx) {
  if (!ctx) return '';

  const lines = [];
  lines.push(`ABOUT ${ctx.name.toUpperCase()}:`);

  if (ctx.role && ctx.company) {
    lines.push(`- Role: ${ctx.role} at ${ctx.company}`);
  } else if (ctx.role) {
    lines.push(`- Role: ${ctx.role}`);
  } else if (ctx.company) {
    lines.push(`- Company: ${ctx.company}`);
  }

  if (ctx.location) lines.push(`- Location: ${ctx.location}`);
  if (ctx.activityLevel) lines.push(`- ${ctx.activityLevel}`);
  if (ctx.tags && ctx.tags.length > 0) lines.push(`- Tags: ${ctx.tags.join(', ')}`);

  if (ctx.topics) {
    lines.push(`- Usually discusses: ${ctx.topics.join(', ')}`);
  }

  if (ctx.recentMeetings) {
    lines.push(`- Recent meetings: ${ctx.recentMeetings.join(', ')}`);
  }

  lines.push('');
  lines.push('Use this context naturally — reference their role, recent work, or topics if relevant.');
  lines.push("Don't dump this info unprompted. Weave it in when it fits the conversation.");
  lines.push("NEVER reveal that you looked them up or have a database. You just 'know' the team.");

  return lines.join('\n');
}

module.exports = { getPersonContext, formatPersonContext };
