/**
 * Intent Classifier for Atlas Slack Bot
 *
 * Determines whose data a message is about so queries can be routed
 * to the correct Atlas user. Uses claude-haiku-4-5 for fast, cheap classification.
 */

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Classifies the intent of a Slack message in the context of Atlas multi-user routing.
 *
 * @param {string} message - The raw message text from Slack
 * @param {string} requestorName - Display name of the person who sent the message
 * @param {boolean} requestorIsAtlasUser - Whether the requestor has an Atlas account
 * @param {Array<{name: string, email: string}>} atlasUserNames - All known Atlas users
 * @returns {Promise<{
 *   type: 'self_query'|'other_query'|'general'|'action',
 *   data_owner_name: string|null,
 *   data_types: string[],
 *   confidence: number,
 *   reasoning: string
 * }>}
 */
async function classifyIntent(message, requestorName, requestorIsAtlasUser, atlasUserNames) {
  const atlasUserList = atlasUserNames.map(u => u.name).join(', ') || '(none)';

  const systemPrompt = `You are an intent classifier for an AI assistant called Atlas. Atlas has access to personal data (calendar, email, Slack messages, contacts) for a set of registered users.

Your job: Given a user's message, classify what type of query it is and whose data is needed to answer it.

## Atlas Users (registered, have data)
${atlasUserList}

## Classification Types
- **self_query**: The requestor is asking about their own data ("my calendar", "my emails", "what do I have today")
- **other_query**: The requestor is asking about someone else's data ("Kaitlyn's schedule", "when is Jeff free", "what did Sarah send")
- **general**: A general/factual question that doesn't require personal Atlas data ("what's the weather", "what time is it", "how do I use git")
- **action**: A request to take an action ("send Kaitlyn a message", "draft an email to Jeff", "schedule a meeting with Sarah")

## Data Types
Only include what is actually needed:
- **calendar**: Schedule, meetings, availability, events, free time
- **email**: Emails, messages sent/received, inbox
- **slack**: Slack messages, DMs, channels
- **contacts**: People, contact info, relationships
- **general**: No specific personal data needed

## Rules
1. For self_query: data_owner_name = the requestor's name (provided below)
2. For other_query: data_owner_name = the person whose data is needed (must be an Atlas user, or the closest match)
3. For general/action with no specific data owner: data_owner_name = null
4. For action targeting another person: data_owner_name = the target person's name
5. If the referenced person is NOT in the Atlas user list, still classify correctly but note low confidence

Respond with ONLY a JSON object, no markdown fences, no explanation outside the JSON:
{
  "type": "self_query|other_query|general|action",
  "data_owner_name": "Name or null",
  "data_types": ["calendar", "email", "slack", "contacts", "general"],
  "confidence": 0.0,
  "reasoning": "Brief 1-2 sentence explanation"
}`;

  const userPrompt = `Requestor: ${requestorName}
Requestor has Atlas account: ${requestorIsAtlasUser}
Message: "${message}"

Classify this message.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt,
    });

    const raw = response.content[0]?.text?.trim() ?? '';

    // Strip markdown fences if the model adds them despite instructions
    const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const parsed = JSON.parse(jsonText);

    // Validate and normalise the result
    const validTypes = ['self_query', 'other_query', 'general', 'action'];
    const validDataTypes = ['calendar', 'email', 'slack', 'contacts', 'general'];

    return {
      type: validTypes.includes(parsed.type) ? parsed.type : 'general',
      data_owner_name: parsed.data_owner_name ?? null,
      data_types: Array.isArray(parsed.data_types)
        ? parsed.data_types.filter(d => validDataTypes.includes(d))
        : ['general'],
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch (err) {
    console.error('[intent-classifier] Classification failed:', err.message);
    return {
      type: 'general',
      data_owner_name: null,
      data_types: ['general'],
      confidence: 0.5,
      reasoning: 'Classification failed; defaulting to general query.',
    };
  }
}

/**
 * Fetches all Atlas users from Supabase for use as context in classifyIntent.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<Array<{id: string, name: string, email: string}>>}
 */
async function getAtlasUserList(supabase) {
  // Get all Atlas users with their Slack IDs (via join on user_slack_identities)
  // Filter out test harness and placeholder accounts
  const { data: users, error } = await supabase
    .from('user')
    .select('id, name, email')
    .not('email', 'like', '%@test.harness')
    .not('id', 'like', 'harness_%')
    .order('name', { ascending: true });

  if (error) {
    console.error('[intent-classifier] Failed to fetch Atlas users:', error.message);
    return [];
  }

  if (!users || users.length === 0) return [];

  // Fetch Slack IDs for all Atlas users
  const { data: identities } = await supabase
    .from('user_slack_identities')
    .select('atlas_user_id, slack_user_id');

  const slackIdMap = new Map(
    (identities || []).map(i => [i.atlas_user_id, i.slack_user_id])
  );

  return users.map(u => ({
    atlasId: u.id,
    name: u.name,
    email: u.email,
    slackId: slackIdMap.get(u.id) || null,
  }));
}

module.exports = { classifyIntent, getAtlasUserList };
