'use strict';

/**
 * get-person.js
 * Fetch a person's full profile from Supabase, including behavioral synthesis
 * and Argus learnings. Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{ name?: string, person_id?: string }} params
 * @returns {Promise<object>}
 */
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
      // Search by name with ILIKE
      const { data, error } = await supabase
        .from('people')
        .select('*')
        .eq('atlas_user_id', atlasUserId)
        .ilike('name', `%${name}%`)
        .eq('archived', 0)
        .order('score', { ascending: false })
        .limit(1);

      if (error) return { error: `DB error searching by name: ${error.message}` };
      if (!data || data.length === 0) return { found: false, message: `No person found matching "${name}"` };
      person = data[0];
    }

    if (!person) return { found: false, message: 'Person not found' };

    // Fetch profile synthesis
    const { data: synthesis } = await supabase
      .from('profile_synthesis')
      .select('content_markdown, generated_at')
      .eq('person_id', person.id)
      .eq('atlas_user_id', atlasUserId)
      .maybeSingle();

    // Fetch Argus learnings for this person
    const { data: learnings } = await supabase
      .from('argus_learnings')
      .select('id, category, content, created_at')
      .eq('person_id', person.id)
      .eq('atlas_user_id', atlasUserId)
      .eq('active', true)
      .order('created_at', { ascending: false });

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
      slack_username: person.slack_username || null,
      communication_counts: {
        email_count: person.email_count || 0,
        slack_count: person.slack_count || 0,
        imessage_count: person.imessage_count || 0,
        meeting_count: person.meeting_count || 0,
      },
      profile_synthesis: synthesis?.content_markdown || null,
      synthesis_generated_at: synthesis?.generated_at || null,
      learnings: (learnings || []).map(l => ({
        id: l.id,
        category: l.category,
        content: l.content,
        created_at: l.created_at,
      })),
    };
  } catch (err) {
    return { error: `getPersonProfile failed: ${err.message}` };
  }
}

/**
 * Handle both get_person_profile and search_people depending on input.
 * If `query` is present, do a multi-result search. Otherwise, profile lookup.
 */
async function handlePersonTool(atlasUserId, params) {
  if (params.query) {
    return searchPeople(atlasUserId, params);
  }
  return getPersonProfile(atlasUserId, params);
}

/**
 * Search for people by name fragment.
 * @param {string} atlasUserId
 * @param {{ query: string, limit?: number }} params
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

module.exports = handlePersonTool;
