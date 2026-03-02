'use strict';

/**
 * get-person.js
 * Fetch a person's full profile from Supabase, including behavioral synthesis,
 * Argus learnings, and stratified communication history (emails, Slack, iMessage,
 * meetings, phone calls). Matches argus-headless depth.
 */

const supabase = require('../utils/supabase');

// Time band constants (milliseconds)
const TIME_BANDS = {
  TWO_WEEKS:   14 * 24 * 60 * 60 * 1000,
  TWO_MONTHS:  60 * 24 * 60 * 60 * 1000,
  SIX_MONTHS: 180 * 24 * 60 * 60 * 1000,
  ONE_YEAR:   365 * 24 * 60 * 60 * 1000,
};

const TZ = 'America/New_York';
const DATETIME_FMT = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ };

function fmtDate(ts) {
  if (!ts) return null;
  return new Date(typeof ts === 'number' ? ts : ts).toLocaleString('en-US', DATETIME_FMT);
}

function isLowSignal(text) {
  if (!text || text.length < 3) return true;
  const lc = text.trim().toLowerCase();
  return /^(ok|okay|k|lol|haha|ha|yes|yeah|yep|no|nah|nope|thanks|ty|thx|np|👍|👋|❤️|😂|🙏|\.+)$/i.test(lc);
}

/**
 * Stratified time-band sampling — pulls more recent data, fewer older messages.
 * Same approach as argus-headless for rich context.
 */
async function stratifiedQuery(table, atlasUserId, personId, selectCols, orderCol, bands) {
  const results = [];
  for (const band of bands) {
    let q = supabase
      .from(table)
      .select(selectCols)
      .eq('atlas_user_id', atlasUserId)
      .eq('person_id', personId)
      .order(orderCol, { ascending: false })
      .limit(band.limit);

    if (band.gte) q = q.gte(orderCol, band.gte);
    if (band.lt) q = q.lt(orderCol, band.lt);

    const { data } = await q;
    if (data) results.push(...data);
  }
  return results;
}

async function getPersonProfile(atlasUserId, { name, person_id } = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };
    if (!name && !person_id) return { error: 'Either name or person_id is required' };

    let person = null;

    if (person_id) {
      const { data, error } = await supabase
        .from('people')
        .select('*')
        .eq('id', person_id)
        .eq('atlas_user_id', atlasUserId)
        .single();
      if (error) return { error: `DB error fetching by id: ${error.message}` };
      person = data;
    } else {
      const { data, error } = await supabase
        .from('people')
        .select('*')
        .eq('atlas_user_id', atlasUserId)
        .ilike('name', `%${name}%`)
        .eq('archived', 0)
        .order('score', { ascending: false })
        .limit(5);

      if (error) return { error: `DB error searching by name: ${error.message}` };
      if (!data || data.length === 0) return { found: false, message: `No person found matching "${name}"` };

      // If multiple matches, return candidates
      if (data.length > 1 && data[0].name.toLowerCase() !== name.toLowerCase()) {
        return {
          found: false,
          message: `Multiple people match "${name}". Did you mean one of these?`,
          candidates: data.map(c => `${c.name} (${c.email || c.company || 'no details'})`),
        };
      }
      person = data[0];
    }

    if (!person) return { found: false, message: 'Person not found' };

    const now = Date.now();

    // Run all enrichment queries in parallel for speed
    const [synthesisResult, learningsResult, emails, slackMsgs, imessages, transcriptParticipants, callsResult] = await Promise.all([
      // Profile synthesis
      supabase
        .from('profile_synthesis')
        .select('content_markdown, generated_at')
        .eq('person_id', person.id)
        .eq('atlas_user_id', atlasUserId)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Learnings about this person
      supabase
        .from('argus_learnings')
        .select('id, category, content, created_at')
        .eq('person_id', person.id)
        .eq('atlas_user_id', atlasUserId)
        .eq('active', 1)
        .order('created_at', { ascending: false })
        .limit(20),

      // Stratified emails
      stratifiedQuery('emails', atlasUserId, person.id,
        'subject, snippet, received_at, direction',
        'received_at',
        [
          { gte: now - TIME_BANDS.TWO_WEEKS, limit: 30 },
          { gte: now - TIME_BANDS.TWO_MONTHS, lt: now - TIME_BANDS.TWO_WEEKS, limit: 20 },
          { gte: now - TIME_BANDS.SIX_MONTHS, lt: now - TIME_BANDS.TWO_MONTHS, limit: 10 },
          { lt: now - TIME_BANDS.SIX_MONTHS, limit: 5 },
        ]),

      // Stratified Slack messages
      stratifiedQuery('slack_messages', atlasUserId, person.id,
        'text, timestamp, from_user_name, channel_name',
        'timestamp',
        [
          { gte: now - TIME_BANDS.TWO_WEEKS, limit: 50 },
          { gte: now - TIME_BANDS.TWO_MONTHS, lt: now - TIME_BANDS.TWO_WEEKS, limit: 30 },
          { gte: now - TIME_BANDS.SIX_MONTHS, lt: now - TIME_BANDS.TWO_MONTHS, limit: 15 },
          { lt: now - TIME_BANDS.SIX_MONTHS, limit: 5 },
        ]),

      // Stratified iMessages
      stratifiedQuery('imessage_messages', atlasUserId, person.id,
        'message_text, sent_at, is_from_me',
        'sent_at',
        [
          { gte: now - TIME_BANDS.TWO_WEEKS, limit: 50 },
          { gte: now - TIME_BANDS.TWO_MONTHS, lt: now - TIME_BANDS.TWO_WEEKS, limit: 30 },
          { gte: now - TIME_BANDS.SIX_MONTHS, lt: now - TIME_BANDS.TWO_MONTHS, limit: 15 },
          { lt: now - TIME_BANDS.SIX_MONTHS, limit: 5 },
        ]),

      // Meeting transcripts (via participants join)
      supabase
        .from('transcription_participants')
        .select('transcription_id')
        .eq('atlas_user_id', atlasUserId)
        .or(`person_id.eq.${person.id},extracted_name.ilike.%${(person.name || '').split(' ')[0]}%`)
        .limit(15),

      // Phone calls
      supabase
        .from('phone_calls')
        .select('direction, answered, duration_seconds, call_type, call_date')
        .eq('atlas_user_id', atlasUserId)
        .eq('person_id', person.id)
        .order('call_date', { ascending: false })
        .limit(10),
    ]);

    const synthesis = synthesisResult?.data;
    const learnings = learningsResult?.data || [];

    // Filter low-signal messages
    const filteredSlack = (slackMsgs || []).filter(m => !isLowSignal(m.text));
    const filteredIm = (imessages || []).filter(m => !isLowSignal(m.message_text));

    // Fetch actual transcripts from participant IDs
    let transcripts = [];
    const participants = transcriptParticipants?.data;
    if (participants && participants.length > 0) {
      const tIds = [...new Set(participants.map(p => p.transcription_id))];
      const { data: tData } = await supabase
        .from('transcriptions')
        .select('title, recorded_at, summary, source')
        .in('id', tIds)
        .order('recorded_at', { ascending: false })
        .limit(10);
      transcripts = tData || [];
    }

    const calls = callsResult?.data || [];

    return {
      found: true,
      id: person.id,
      name: person.name,
      email: person.email || null,
      phone: person.phone || null,
      company: person.company || null,
      title: person.title || null,
      score: person.score || 0,
      rank: person.rank || null,
      sphere: person.sphere || null,
      tags: person.tags || [],
      notes: person.notes || null,
      slack_id: person.slack_id || null,

      profile_synthesis: synthesis?.content_markdown || null,
      synthesis_generated_at: synthesis?.generated_at || null,

      learnings: learnings.map(l => ({
        category: l.category,
        content: l.content,
      })),

      recent_emails: (emails || []).map(e => ({
        subject: e.subject,
        snippet: (e.snippet || '').substring(0, 200),
        date: fmtDate(e.received_at),
        direction: e.direction,
      })),

      recent_slack: filteredSlack.map(m => ({
        text: (m.text || '').substring(0, 300),
        date: fmtDate(m.timestamp),
        from: m.from_user_name,
        channel: m.channel_name,
      })),

      recent_imessages: filteredIm.map(m => ({
        text: (m.message_text || '').substring(0, 300),
        date: fmtDate(m.sent_at),
        from_me: m.is_from_me === 1,
      })),

      recent_meetings: transcripts.map(t => ({
        title: t.title,
        date: fmtDate(t.recorded_at),
        summary: (t.summary || '').substring(0, 300),
        source: t.source,
      })),

      recent_calls: calls.map(c => ({
        direction: c.direction,
        answered: c.answered,
        duration_seconds: c.duration_seconds,
        type: c.call_type,
        date: fmtDate(c.call_date),
      })),

      _counts: {
        emails: (emails || []).length,
        slack: filteredSlack.length,
        imessages: filteredIm.length,
        meetings: transcripts.length,
        calls: calls.length,
      },
    };
  } catch (err) {
    return { error: `getPersonProfile failed: ${err.message}` };
  }
}

/**
 * Search for people by name fragment.
 */
async function searchPeople(atlasUserId, { query, limit = 10 }) {
  try {
    const effectiveLimit = Math.min(limit || 10, 50);
    const { data, error } = await supabase
      .from('people')
      .select('id, name, company, title, score')
      .eq('atlas_user_id', atlasUserId)
      .ilike('name', `%${query}%`)
      .eq('archived', 0)
      .order('score', { ascending: false })
      .limit(effectiveLimit);

    if (error) return { error: `DB error searching people: ${error.message}` };

    return {
      found: (data || []).length,
      query,
      people: (data || []).map(p => ({
        id: p.id,
        name: p.name,
        company: p.company || null,
        title: p.title || null,
        score: Math.round(p.score || 0),
      })),
    };
  } catch (err) {
    return { error: `searchPeople failed: ${err.message}` };
  }
}

function handlePersonTool(atlasUserId, params) {
  if (params.query) return searchPeople(atlasUserId, params);
  return getPersonProfile(atlasUserId, params);
}

module.exports = handlePersonTool;
