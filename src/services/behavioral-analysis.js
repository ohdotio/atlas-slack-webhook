'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const defaultSupabase = require('../utils/supabase');
const {
  generateEmbedding,
  toPgVector,
  formatLearningText,
} = require('../utils/embeddings');

const ANALYSIS_MODEL = 'claude-opus-4-6';
const ANALYSIS_WINDOW_DAYS = 7;
const MIN_EVIDENCE_COUNT = 3;
const MAX_EXCERPTS_PER_CHANNEL = 18;
const MAX_EXISTING_BEHAVIORALS = 40;
const DEDUP_SIMILARITY_THRESHOLD = 0.85;

function truncate(text, max = 280) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    const match = String(text).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeEvidence(evidence = []) {
  if (!Array.isArray(evidence)) return [];
  const seen = new Set();
  const out = [];
  for (const item of evidence) {
    if (!item) continue;
    const normalized = {
      date: item.date || item.timestamp || null,
      channel: item.channel || item.source || null,
      conversation_key: item.conversation_key || item.conversationKey || null,
      counterpart: item.counterpart || item.contact_name || item.person_name || null,
      excerpt: truncate(item.excerpt || item.content || item.summary || '', 300),
      source_table: item.source_table || null,
      source_id: item.source_id || item.id || null,
    };
    if (!normalized.excerpt) continue;
    const key = [normalized.channel, normalized.conversation_key, normalized.excerpt].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function latestTimestampFromEvidence(evidence = []) {
  return evidence
    .map(item => item?.date || item?.timestamp || null)
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || new Date().toISOString();
}

function toIsoDate(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 100000000000) return new Date(n).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function conversationKey(channel, counterpart, dateValue) {
  const iso = toIsoDate(dateValue) || new Date().toISOString();
  return `${channel}:${counterpart || 'unknown'}:${iso.slice(0, 10)}`;
}

async function resolveAiKeys(atlasUserId, supabase = defaultSupabase) {
  try {
    const { data: rows } = await supabase
      .from('ai_settings')
      .select('key, value')
      .eq('atlas_user_id', atlasUserId);

    const settingsMap = Object.fromEntries((rows || []).map(row => [row.key, row.value]));
    const rawAnthropic = settingsMap.anthropicApiKey || settingsMap.anthropic_api_key || null;
    const rawGemini = settingsMap.geminiApiKey || settingsMap.gemini_api_key || null;

    return {
      anthropicApiKey: (rawAnthropic && rawAnthropic.startsWith('sk-ant-')) ? rawAnthropic : (process.env.ANTHROPIC_API_KEY || null),
      geminiApiKey: (rawGemini && rawGemini.startsWith('AIza')) ? rawGemini : (process.env.GEMINI_API_KEY || null),
    };
  } catch (error) {
    console.warn('[behavioral-analysis/webhook] Failed loading ai_settings:', error.message);
    return {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
      geminiApiKey: process.env.GEMINI_API_KEY || null,
    };
  }
}

async function loadExistingBehavioralLearnings(atlasUserId, supabase = defaultSupabase) {
  const baseSelect = 'id, category, person_name, content, source, confidence, priority, active, created_at, updated_at, reinforcement_count, last_reinforced_at, evidence_sources';
  try {
    const { data, error } = await supabase
      .from('argus_learnings')
      .select(baseSelect)
      .eq('atlas_user_id', atlasUserId)
      .eq('active', 1)
      .eq('category', 'behavioral')
      .order('updated_at', { ascending: false })
      .limit(MAX_EXISTING_BEHAVIORALS);
    if (error) throw error;
    return data || [];
  } catch (error) {
    const message = String(error.message || error).toLowerCase();
    if (!message.includes('reinforcement_count') && !message.includes('last_reinforced_at') && !message.includes('evidence_sources')) throw error;

    const { data, error: fallbackError } = await supabase
      .from('argus_learnings')
      .select('id, category, person_name, content, source, confidence, priority, active, created_at, updated_at')
      .eq('atlas_user_id', atlasUserId)
      .eq('active', 1)
      .eq('category', 'behavioral')
      .order('updated_at', { ascending: false })
      .limit(MAX_EXISTING_BEHAVIORALS);
    if (fallbackError) throw fallbackError;
    return (data || []).map(item => ({ ...item, reinforcement_count: 0, last_reinforced_at: null, evidence_sources: [] }));
  }
}

async function fetchSlackExcerpts(atlasUserId, sinceIso, supabase = defaultSupabase) {
  const { data, error } = await supabase
    .from('slack_messages')
    .select('id, channel_name, channel_type, from_user_name, text, timestamp')
    .eq('atlas_user_id', atlasUserId)
    .gte('timestamp', sinceIso)
    .not('text', 'is', null)
    .order('timestamp', { ascending: false })
    .limit(250);
  if (error) return [];

  const grouped = new Map();
  for (const row of data || []) {
    const counterpart = row.from_user_name || row.channel_name || 'Unknown';
    const key = conversationKey('slack', `${row.channel_name || 'channel'}:${counterpart}`, row.timestamp);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  return Array.from(grouped.entries()).slice(0, MAX_EXCERPTS_PER_CHANNEL).map(([key, rows]) => {
    const newest = rows[0];
    return {
      id: key,
      channel: 'slack',
      conversation_key: key,
      date: toIsoDate(newest.timestamp),
      counterpart: newest.from_user_name || newest.channel_name || 'Unknown',
      location: newest.channel_name ? `#${newest.channel_name}` : (newest.channel_type || 'slack'),
      excerpt: rows.slice(0, 3).reverse().map(item => `${item.from_user_name || 'Unknown'}: ${truncate(item.text, 180)}`).join(' | '),
      source_table: 'slack_messages',
      source_id: newest.id,
    };
  });
}

async function fetchImessageExcerpts(atlasUserId, sinceIso, supabase = defaultSupabase) {
  const { data, error } = await supabase
    .from('imessage_messages')
    .select('id, person_id, chat_id, message_text, is_from_me, sent_at')
    .eq('atlas_user_id', atlasUserId)
    .gte('sent_at', sinceIso)
    .not('message_text', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(250);
  if (error) return [];

  const personIds = [...new Set((data || []).map(row => row.person_id).filter(Boolean))];
  let peopleMap = new Map();
  if (personIds.length) {
    const { data: people } = await supabase.from('people').select('id, name').in('id', personIds);
    peopleMap = new Map((people || []).map(person => [person.id, person.name]));
  }

  const grouped = new Map();
  for (const row of data || []) {
    const counterpart = peopleMap.get(row.person_id) || row.chat_id || 'Unknown';
    const key = conversationKey('imessage', counterpart, row.sent_at);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ...row, counterpart });
  }

  return Array.from(grouped.entries()).slice(0, MAX_EXCERPTS_PER_CHANNEL).map(([key, rows]) => {
    const newest = rows[0];
    return {
      id: key,
      channel: 'imessage',
      conversation_key: key,
      date: toIsoDate(newest.sent_at),
      counterpart: newest.counterpart,
      location: newest.chat_id || 'iMessage',
      excerpt: rows.slice(0, 4).reverse().map(item => `${item.is_from_me ? 'User' : item.counterpart}: ${truncate(item.message_text, 180)}`).join(' | '),
      source_table: 'imessage_messages',
      source_id: newest.id,
    };
  });
}

async function fetchSendblueExcerpts(atlasUserId, sinceIso, supabase = defaultSupabase) {
  const { data, error } = await supabase
    .from('sendblue_messages')
    .select('id, phone, direction, content, media_url, contact_name, timestamp')
    .eq('atlas_user_id', atlasUserId)
    .gte('timestamp', sinceIso)
    .order('timestamp', { ascending: false })
    .limit(250);
  if (error) return [];

  const grouped = new Map();
  for (const row of data || []) {
    const counterpart = row.contact_name || row.phone || 'Unknown';
    const key = conversationKey('sendblue', counterpart, row.timestamp);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  return Array.from(grouped.entries()).slice(0, MAX_EXCERPTS_PER_CHANNEL).map(([key, rows]) => {
    const newest = rows[0];
    return {
      id: key,
      channel: 'sendblue',
      conversation_key: key,
      date: toIsoDate(newest.timestamp),
      counterpart: newest.contact_name || newest.phone || 'Unknown',
      location: newest.phone || 'sendblue',
      excerpt: rows.slice(0, 4).reverse().map(item => `${item.direction === 'outbound' ? 'User' : (item.contact_name || item.phone || 'Them')}: ${item.content ? truncate(item.content, 180) : (item.media_url ? '[media attachment]' : '[empty]')}`).join(' | '),
      source_table: 'sendblue_messages',
      source_id: newest.id,
    };
  });
}

async function loadRecentConversationExcerpts(atlasUserId, opts = {}) {
  const supabase = opts.supabase || defaultSupabase;
  const since = new Date(Date.now() - (opts.windowDays || ANALYSIS_WINDOW_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  const [slack, imessage, sendblue] = await Promise.all([
    fetchSlackExcerpts(atlasUserId, since, supabase),
    fetchImessageExcerpts(atlasUserId, since, supabase),
    fetchSendblueExcerpts(atlasUserId, since, supabase),
  ]);
  return [...slack, ...imessage, ...sendblue].sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
}

function buildAnalysisPrompt(excerpts, existingLearnings) {
  const existingText = existingLearnings.length ? existingLearnings.map((item, index) => `${index + 1}. ${item.content}`).join('\n') : 'None currently stored.';
  const excerptText = excerpts.map((item, index) => [
    `ID: ${index + 1}`,
    `DATE: ${item.date}`,
    `CHANNEL: ${item.channel}`,
    `COUNTERPART: ${item.counterpart}`,
    `LOCATION: ${item.location}`,
    `CONVERSATION_KEY: ${item.conversation_key}`,
    `EXCERPT: ${item.excerpt}`,
  ].join('\n')).join('\n\n---\n\n');

  return `You are identifying conservative behavioral patterns for long-term memory.\n\nExisting behavioral learnings already stored for this user:\n${existingText}\n\nAnalyze the conversation excerpts from the last 7 days and identify only durable behavioral patterns that are supported by evidence from at least 3 separate conversations.\n\nFocus areas:\n- Communication style patterns (tone, message length, formality, emoji usage)\n- Decision-making patterns (how options are evaluated, what gets prioritized)\n- Relationship management patterns (how the user interacts with different people)\n- Work/productivity patterns (when they are active, how they handle tasks)\n- Preferences demonstrated repeatedly but never explicitly stated\n\nRules:\n- Only identify patterns supported by evidence from at least 3 separate conversations\n- Do not repeat patterns already captured in existing behavioral learnings\n- Be conservative: if the evidence is weak, omit it\n- Evidence must cite the excerpt IDs you used\n- Ignore one-off moods, isolated incidents, and facts that are really preferences/corrections already better stored elsewhere unless the pattern is behavioral\n\nReturn ONLY valid JSON with this exact shape:\n{\n  "patterns": [\n    {\n      "pattern": "string",\n      "category_hint": "communication|decision_making|relationship|productivity|preference_signal|other",\n      "confidence_score": 0.0,\n      "evidence_ids": [1, 2, 3],\n      "evidence": [\n        {"id": 1, "why_it_supports": "short explanation"}\n      ]\n    }\n  ]\n}\n\nConversation excerpts:\n\n${excerptText}`;
}

async function analyzeBehavioralPatterns(atlasUserId, opts = {}) {
  const supabase = opts.supabase || defaultSupabase;
  try {
    if (!atlasUserId) return { success: false, skipped: 'missing_user_id' };

    const keys = await resolveAiKeys(atlasUserId, supabase);
    if (!keys.anthropicApiKey) return { success: true, skipped: 'missing_anthropic_key', stored: 0, candidates: [] };

    const excerpts = await loadRecentConversationExcerpts(atlasUserId, { ...opts, supabase });
    if (!excerpts.length) return { success: true, skipped: 'no_recent_conversations', stored: 0, candidates: [] };

    const existingLearnings = await loadExistingBehavioralLearnings(atlasUserId, supabase);
    const client = new Anthropic({ apiKey: keys.anthropicApiKey });
    const response = await client.messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 2200,
      temperature: 0.1,
      messages: [{ role: 'user', content: buildAnalysisPrompt(excerpts, existingLearnings) }],
    });

    const rawText = response.content?.map(block => block.text || '').join('\n').trim();
    const parsed = safeJsonParse(rawText);
    const rawPatterns = Array.isArray(parsed?.patterns) ? parsed.patterns : [];
    const candidates = rawPatterns.map(item => {
      const evidenceIds = Array.isArray(item.evidence_ids) ? item.evidence_ids : [];
      const matchedEvidence = evidenceIds.map(id => excerpts[Number(id) - 1]).filter(Boolean);
      if (new Set(matchedEvidence.map(ev => ev.conversation_key)).size < MIN_EVIDENCE_COUNT) return null;
      return {
        pattern: truncate(item.pattern || '', 400),
        category_hint: item.category_hint || 'other',
        confidence_score: Number(item.confidence_score || 0),
        evidence: normalizeEvidence(matchedEvidence),
      };
    }).filter(item => item && item.pattern && item.evidence.length >= MIN_EVIDENCE_COUNT);

    if (!opts.store) return { success: true, stored: 0, candidates, excerpts_analyzed: excerpts.length, existing_behavioral_count: existingLearnings.length };

    const results = [];
    let stored = 0;
    for (const candidate of candidates) {
      const result = await storeWithDedup(atlasUserId, candidate, { ...opts, supabase, geminiApiKey: keys.geminiApiKey });
      results.push(result);
      if (result?.success) stored += 1;
    }

    return { success: true, stored, candidates, results, excerpts_analyzed: excerpts.length, existing_behavioral_count: existingLearnings.length };
  } catch (error) {
    console.warn('[behavioral-analysis/webhook] analyze failed:', error.message);
    return { success: true, skipped: 'analysis_failed', error: error.message, stored: 0, candidates: [] };
  }
}

async function tryBehavioralMatch(supabase, atlasUserId, embedding, threshold = DEDUP_SIMILARITY_THRESHOLD) {
  try {
    const { data, error } = await supabase.rpc('match_learnings', {
      query_embedding: toPgVector(embedding),
      match_atlas_user_id: atlasUserId,
      match_threshold: Math.max(0.7, threshold - 0.1),
      match_count: 25,
    });
    if (error) throw error;
    return (data || []).filter(item => item.category === 'behavioral').sort((a, b) => Number(b.similarity || 0) - Number(a.similarity || 0));
  } catch (error) {
    console.warn('[behavioral-analysis/webhook] match_learnings unavailable:', error.message);
    return [];
  }
}

async function storeWithDedup(atlasUserId, candidatePattern, opts = {}) {
  const supabase = opts.supabase || defaultSupabase;
  try {
    if (!atlasUserId || !candidatePattern?.pattern) return { success: false, skipped: 'invalid_candidate' };

    const keys = await resolveAiKeys(atlasUserId, supabase);
    const geminiApiKey = opts.geminiApiKey || keys.geminiApiKey;
    if (!geminiApiKey) return { success: true, skipped: 'missing_gemini_key', pattern: candidatePattern.pattern };

    const evidence = normalizeEvidence(candidatePattern.evidence || []);
    if (new Set(evidence.map(item => item.conversation_key)).size < MIN_EVIDENCE_COUNT) {
      return { success: true, skipped: 'insufficient_evidence', pattern: candidatePattern.pattern };
    }

    const embedding = await generateEmbedding(formatLearningText({ category: 'behavioral', content: candidatePattern.pattern }), {
      apiKey: geminiApiKey,
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 768,
    });
    if (!embedding) return { success: true, skipped: 'embedding_failed', pattern: candidatePattern.pattern };

    const matches = await tryBehavioralMatch(supabase, atlasUserId, embedding, DEDUP_SIMILARITY_THRESHOLD);
    const bestMatch = matches.find(item => Number(item.similarity || 0) >= DEDUP_SIMILARITY_THRESHOLD);

    if (bestMatch?.id) {
      const { data: existingRow } = await supabase.from('argus_learnings').select('id, reinforcement_count, evidence_sources').eq('id', bestMatch.id).maybeSingle();
      const mergedEvidence = normalizeEvidence([...(existingRow?.evidence_sources || []), ...evidence]);
      const reinforcementCount = Number(existingRow?.reinforcement_count || 0) + 1;
      const { error: updateError } = await supabase
        .from('argus_learnings')
        .update({
          updated_at: Date.now(),
          last_reinforced_at: latestTimestampFromEvidence(evidence),
          reinforcement_count: reinforcementCount,
          evidence_sources: mergedEvidence,
          priority: 'standard',
          confidence: 'inferred',
        })
        .eq('id', bestMatch.id);

      if (updateError) {
        const message = String(updateError.message || updateError).toLowerCase();
        if (message.includes('reinforcement_count') || message.includes('last_reinforced_at') || message.includes('evidence_sources')) {
          return { success: false, skipped: 'missing_migration_columns', pattern: candidatePattern.pattern, match_id: bestMatch.id };
        }
        throw updateError;
      }

      return { success: true, action: 'reinforced', id: bestMatch.id, similarity: Number(bestMatch.similarity || 0), reinforcement_count: reinforcementCount, pattern: candidatePattern.pattern };
    }

    const row = {
      id: `learning_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      atlas_user_id: atlasUserId,
      user_id: atlasUserId,
      category: 'behavioral',
      content: candidatePattern.pattern,
      source: opts.source || 'weekly_behavioral_analysis',
      confidence: 'inferred',
      priority: 'standard',
      active: true,
      reinforcement_count: 0,
      last_reinforced_at: null,
      evidence_sources: evidence,
      embedding: toPgVector(embedding),
      embedding_model: 'gemini-embedding-2-preview',
      embedded_at: new Date().toISOString(),
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const { data, error } = await supabase.from('argus_learnings').insert(row).select('id, content').single();
    if (error) {
      const message = String(error.message || error).toLowerCase();
      if (message.includes('reinforcement_count') || message.includes('last_reinforced_at') || message.includes('evidence_sources')) {
        return { success: false, skipped: 'missing_migration_columns', pattern: candidatePattern.pattern };
      }
      throw error;
    }

    return { success: true, action: 'inserted', id: data.id, pattern: candidatePattern.pattern };
  } catch (error) {
    console.warn('[behavioral-analysis/webhook] storeWithDedup failed:', error.message);
    return { success: false, skipped: 'store_failed', pattern: candidatePattern?.pattern || null, error: error.message };
  }
}

module.exports = {
  ANALYSIS_MODEL,
  ANALYSIS_WINDOW_DAYS,
  DEDUP_SIMILARITY_THRESHOLD,
  MIN_EVIDENCE_COUNT,
  analyzeBehavioralPatterns,
  loadExistingBehavioralLearnings,
  loadRecentConversationExcerpts,
  resolveAiKeys,
  storeWithDedup,
};
