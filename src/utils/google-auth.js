'use strict';

/**
 * google-auth.js
 * Google service account authentication with domain-wide delegation.
 * Impersonates users by their email address.
 *
 * Usage:
 *   const { getAuthClient } = require('./google-auth');
 *   const auth = await getAuthClient('user@example.com', ['https://www.googleapis.com/auth/calendar']);
 */

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// Cache parsed service account credentials
let _serviceAccountKey = null;

/**
 * Load the service account key from env var or local file.
 * @returns {object} Parsed service account JSON key
 */
function loadServiceAccountKey() {
  if (_serviceAccountKey) return _serviceAccountKey;

  // Try env var first (Railway)
  const envJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (envJson) {
    try {
      _serviceAccountKey = JSON.parse(envJson);
      console.log('[GoogleAuth] Loaded service account from GOOGLE_SERVICE_ACCOUNT env var');
      return _serviceAccountKey;
    } catch (err) {
      console.error('[GoogleAuth] Failed to parse GOOGLE_SERVICE_ACCOUNT env var:', err.message);
    }
  }

  // Try local file
  const localPath = path.join(__dirname, '../../.google-service-account.json');
  if (fs.existsSync(localPath)) {
    try {
      const raw = fs.readFileSync(localPath, 'utf8');
      _serviceAccountKey = JSON.parse(raw);
      console.log('[GoogleAuth] Loaded service account from local file');
      return _serviceAccountKey;
    } catch (err) {
      console.error('[GoogleAuth] Failed to read local service account file:', err.message);
    }
  }

  throw new Error(
    'Google service account not configured. Set GOOGLE_SERVICE_ACCOUNT env var ' +
    'or place .google-service-account.json in the project root.'
  );
}

/**
 * Create an authenticated Google API client that impersonates a user.
 *
 * @param {string} userEmail - Email address of the user to impersonate
 * @param {string[]} scopes  - Google API scopes
 * @returns {Promise<import('googleapis').Auth.JWT>} Authenticated client
 */
async function getAuthClient(userEmail, scopes) {
  const key = loadServiceAccountKey();

  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes,
    subject: userEmail,
  });

  // Pre-authorize to validate credentials
  await auth.authorize();

  return auth;
}

module.exports = { getAuthClient, loadServiceAccountKey };
