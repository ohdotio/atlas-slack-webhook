'use strict';

/**
 * analyze-conversation.js
 * Fetches recent messages for a person across emails, Slack, and iMessages,
 * then uses a separate Claude API call to analyze tone, dynamics, and topics.
 * Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{
 *   person_name?: string,
 *   person_id?: string,
 *   topic?: string,
 *   date_range?: string  // e.g. "last 30 days", "2024-01-01 to 2024-02-01"
 * }} params
 * @returns {Promise<object>}
 */
async function analyzeConversation(atlasUserId, {
  person_name,
  person_id,
  topic,
  date_range,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };
    if (!person_name && !person_id) return { error: 'Either person_name or person_id is required' };

    // Resolve person
    let resolvedPersonId = person_id || null;
    let resolvedPersonName = person_name || null;

    if (!resolvedPersonId && person_name) {
      const { data: people, error: pErr } = await supabase
        .from('people')
        .select('id, name')
        .eq('atlas_user_id', atlasUserId)
        .ilike('name', `%${person_name}%`)
        .limit(1);

      if (pErr) return { error: `DB error resolving person: ${pErr.message}` };
      if (!people || people.length === 0) {
        return { error: `No person found matching "${person_name}"` };
      }
      resolvedPersonId = people[0].id;
      resolvedPersonName = people[0].name;
    } else if (resolvedPersonId && !resolvedPersonName) {
      const { data: p } = await supabase
        .from('people')
        .select('name')
        .eq('id', resolvedPersonId)
        .eq('atlas_user_id', atlasUserId)
        .single();
      if (p) resolvedPersonName = p.name;
    }

    // Parse date range
    let startDate = null;
    let endDate = null;
    if (date_range) {
      const rangeMatch = date_range.match(/(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i);
      if (rangeMatch) {
        startDate = rangeMatch[1];
        endDate = rangeMatch[2];
      } else if (/last\s+(\d+)\s+days?/i.test(date_range)) {
        const days = parseInt(date_range.match(/last\s+(\d+)\s+days?/i)[1]);
        const d = new Date();
        d.setDate(d.getDate() - days);
        startDate = d.toISOString().split('T')[0];
      }
    } else {
      // Default: last 90 days
      const d = new Date();
      d.setDate(d.getDate() - 90);
      startDate = d.toISOString().split('T')[0];
    }

    // Fetch messages across channels in parallel
    const [emailsResult, slackResult, imessageResult] = await Promise.all([
      fetchEmails(atlasUserId, resolvedPersonId, startDate, endDate),
      fetchSlack(atlasUserId, resolvedPersonId, startDate, endDate),
      fetchImessages(atlasUserId, resolvedPersonId, startDate, endDate),
    ]);

    const totalMessages = emailsResult.length + slackResult.length + imessageResult.length;

    if (totalMessages === 0) {
      return {
        person: resolvedPersonName,
        person_id: resolvedPersonId,
        analysis: `No messages found with ${resolvedPersonName} in the specified date range.`,
        message_counts: { emails: 0, slack: 0, imessages: 0 },
      };
    }

    // Get Anthropic API key from ai_settings for this user
    const anthropicKey = await getAnthropicKey(atlasUserId);
    if (!anthropicKey) {
      return { error: 'Anthropic API key not configured — set it in ai_settings table under key "anthropicApiKey".' };
    }

    // Build context for Claude
    const conversationContext = buildConversationContext({
      personName: resolvedPersonName,
      topic,
      emails: emailsResult,
      slackMessages: slackResult,
      imessages: imessageResult,
      dateRange: date_range,
    });

    // Call Claude for analysis
    const analysis = await callClaude(anthropicKey, conversationContext, resolvedPersonName, topic);

    return {
      person: resolvedPersonName,
      person_id: resolvedPersonId,
      analysis,
      message_counts: {
        emails: emailsResult.length,
        slack: slackResult.length,
        imessages: imessageResult.length,
      },
      date_range: date_range || 'last 90 days',
    };
  } catch (err) {
    return { error: `analyzeConversation failed: ${err.message}` };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAnthropicKey(atlasUserId) {
  try {
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) return envKey;

    const { data } = await supabase
      .from('ai_settings')
      .select('value')
      .eq('key', 'anthropicApiKey')
      .eq('atlas_user_id', atlasUserId)
      .single();
    return data?.value || null;
  } catch {
    return process.env.ANTHROPIC_API_KEY || null;
  }
}

async function fetchEmails(atlasUserId, personId, startDate, endDate) {
  let q = supabase
    .from('emails')
    .select('subject, from_name, from_address, snippet, date')
    .eq('atlas_user_id', atlasUserId)
    .eq('person_id', personId)
    .order('date', { ascending: false })
    .limit(30);

  if (startDate) q = q.gte('date', startDate);
  if (endDate) q = q.lte('date', endDate);

  const { data } = await q;
  return data || [];
}

async function fetchSlack(atlasUserId, personId, startDate, endDate) {
  let q = supabase
    .from('slack_messages')
    .select('text, sender_name, channel_name, timestamp')
    .eq('atlas_user_id', atlasUserId)
    .eq('person_id', personId)
    .order('timestamp', { ascending: false })
    .limit(40);

  if (startDate) q = q.gte('timestamp', startDate);
  if (endDate) q = q.lte('timestamp', endDate);

  const { data } = await q;
  return data || [];
}

async function fetchImessages(atlasUserId, personId, startDate, endDate) {
  let q = supabase
    .from('imessage_messages')
    .select('text, sender_name, is_from_me, timestamp')
    .eq('atlas_user_id', atlasUserId)
    .eq('person_id', personId)
    .order('timestamp', { ascending: false })
    .limit(40);

  if (startDate) q = q.gte('timestamp', startDate);
  if (endDate) q = q.lte('timestamp', endDate);

  const { data } = await q;
  return data || [];
}

function buildConversationContext({ personName, topic, emails, slackMessages, imessages, dateRange }) {
  const lines = [];

  lines.push(`Analyze my communication with ${personName}.`);
  if (topic) lines.push(`Focus specifically on: ${topic}`);
  if (dateRange) lines.push(`Time period: ${dateRange}`);
  lines.push('');

  if (emails.length > 0) {
    lines.push(`=== EMAILS (${emails.length}) ===`);
    emails.slice(0, 15).forEach(e => {
      lines.push(`[${e.date}] Subject: ${e.subject}`);
      lines.push(`From: ${e.from_name || e.from_address}`);
      if (e.snippet) lines.push(`Preview: ${e.snippet.substring(0, 300)}`);
      lines.push('');
    });
  }

  if (slackMessages.length > 0) {
    lines.push(`=== SLACK MESSAGES (${slackMessages.length}) ===`);
    slackMessages.slice(0, 20).forEach(m => {
      const sender = m.sender_name || 'Unknown';
      lines.push(`[${m.timestamp}] ${sender} in #${m.channel_name || 'unknown'}: ${(m.text || '').substring(0, 300)}`);
    });
    lines.push('');
  }

  if (imessages.length > 0) {
    lines.push(`=== IMESSAGES (${imessages.length}) ===`);
    imessages.slice(0, 20).forEach(m => {
      const direction = m.is_from_me ? 'Me' : (m.sender_name || 'Them');
      lines.push(`[${m.timestamp}] ${direction}: ${(m.text || '').substring(0, 300)}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

async function callClaude(apiKey, context, personName, topic) {
  const systemPrompt = `You are an expert relationship analyst. Given a set of communication logs, provide a concise, insightful analysis covering:
1. Overall tone and relationship dynamics
2. Key topics discussed
3. Communication patterns (frequency, who initiates, response style)
4. Notable moments or trends
5. Actionable insights or suggestions

Be specific and reference actual content from the messages. Keep the analysis focused and practical.`;

  const userPrompt = `${context}

Please analyze this communication with ${personName}${topic ? `, focusing on ${topic}` : ''}.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API error ${response.status}: ${body.substring(0, 200)}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || 'No analysis generated.';
}

module.exports = analyzeConversation;
