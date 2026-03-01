#!/usr/bin/env node
'use strict';

/**
 * Test script for cross-channel conversation context.
 * 
 * Tests:
 * 1. Identity resolution (Slack ID → person_id)
 * 2. Identity resolution (phone → person_id)
 * 3. Conversation store (write + read + cross-channel merge)
 * 4. Memory retrieval by person_id
 * 
 * Run: node test/test-cross-channel.js
 * Requires: SUPABASE_URL and SUPABASE_SERVICE_KEY env vars
 */

// Load .env
require('dotenv').config();

const { resolveBySlackId, resolveByPhone, resolveByEmail, resolvePerson } = require('../src/services/identity-resolver');
const conversationStore = require('../src/services/conversation-store');
const { getMemories, formatMemories } = require('../src/services/conversation-memory');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

(async () => {
  console.log('\n🧪 Cross-Channel Conversation Context Tests\n');

  // ── Test 1: Identity Resolution ────────────────────────────────────────
  console.log('── Identity Resolution ──');

  // Missy Perdue: slack=U09CDJ5E3ML
  const missyBySlack = await resolveBySlackId('U09CDJ5E3ML');
  assert(missyBySlack === 'missy-perdue', `Slack ID U09CDJ5E3ML → "${missyBySlack}" (expected "missy-perdue")`);

  // Liam Heard: slack=U09PDDNGJEB, phone=+16143640172
  const liamBySlack = await resolveBySlackId('U09PDDNGJEB');
  assert(liamBySlack === 'lheard-oh-io', `Slack ID U09PDDNGJEB → "${liamBySlack}" (expected "lheard-oh-io")`);

  const liamByPhone = await resolveByPhone('+16143640172');
  assert(liamByPhone === 'lheard-oh-io', `Phone +16143640172 → "${liamByPhone}" (expected "lheard-oh-io")`);

  // Same person via both channels
  assert(liamBySlack === liamByPhone, `Slack and phone resolve to same person_id: ${liamBySlack} === ${liamByPhone}`);

  // Email resolution
  const missyByEmail = await resolveByEmail('missy@oh.io');
  assert(missyByEmail === 'missy-perdue', `Email missy@oh.io → "${missyByEmail}" (expected "missy-perdue")`);

  // Combined resolver
  const combined = await resolvePerson({ slackUserId: 'U09CDJ5E3ML' });
  assert(combined === 'missy-perdue', `resolvePerson({slackUserId}) → "${combined}"`);

  // Unknown user
  const unknown = await resolveBySlackId('U_NONEXISTENT_999');
  assert(unknown === null, `Unknown Slack ID → ${unknown} (expected null)`);

  // Cache test (second call should be instant)
  const start = Date.now();
  await resolveBySlackId('U09CDJ5E3ML');
  const elapsed = Date.now() - start;
  assert(elapsed < 5, `Cached lookup took ${elapsed}ms (expected <5ms)`);

  // ── Test 2: Conversation Store ─────────────────────────────────────────
  console.log('\n── Conversation Store ──');

  // Check if schema is ready (person_id column exists)
  const testHistory = await conversationStore.getHistory('missy-perdue', { limit: 5 });
  if (testHistory !== null) {
    console.log(`  📋 Schema check: getHistory returned ${testHistory.length} messages (schema ${testHistory.length >= 0 ? 'ready' : 'not ready'})`);
    
    if (Array.isArray(testHistory)) {
      assert(true, 'getHistory returns an array');

      // Test formatHistoryForPrompt
      const formatted = conversationStore.formatHistoryForPrompt([
        { role: 'user', content: 'Hey, about the event...', source: 'slack' },
        { role: 'assistant', content: 'Of course! What about it?', source: 'slack' },
        { role: 'user', content: 'What time is it?', source: 'imessage' },
      ]);
      assert(formatted.length === 3, `formatHistoryForPrompt returned ${formatted.length} messages`);
      assert(formatted[2].content.includes('[via iMessage]'), `iMessage tag present: "${formatted[2].content}"`);
      assert(!formatted[0].content.includes('[via'), `Slack messages not tagged (same channel): "${formatted[0].content}"`);
    }
  } else {
    console.log('  ⚠️  Conversation store schema not migrated yet — store tests skipped');
    console.log('  ℹ️  Run migrations/001_cross_channel_conversations.sql in Supabase SQL Editor');
  }

  // ── Test 3: Memory Retrieval ───────────────────────────────────────────
  console.log('\n── Memory Retrieval ──');

  // Missy has memories keyed by slack_user_id U09CDJ5E3ML
  const missyMemories = await getMemories('U09CDJ5E3ML', 'missy-perdue');
  assert(missyMemories.length > 0, `Missy has ${missyMemories.length} memories`);
  
  const hasTateFact = missyMemories.some(m => m.fact.toLowerCase().includes('tate'));
  assert(hasTateFact, `Missy's memories include baby Tate: ${hasTateFact}`);

  const formatted = formatMemories(missyMemories, 'Missy Perdue');
  assert(formatted.includes('MISSY'), `Memory prompt includes name: ${formatted.substring(0, 60)}...`);

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Check:');
    console.log('  - Supabase connection (SUPABASE_URL, SUPABASE_SERVICE_KEY)');
    console.log('  - Migration status (run migrations/001_cross_channel_conversations.sql)');
    process.exit(1);
  } else {
    console.log('\n🎉 All tests passed!\n');
  }
})().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
