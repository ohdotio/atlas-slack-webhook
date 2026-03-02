'use strict';

/**
 * read-google-doc.js
 * Read content from Google Docs, Slides, Sheets, or uploaded files in Google Drive.
 * Uses Drive API export for native Google formats, download + parse for uploads.
 * Service account impersonation via domain-wide delegation.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// Max content to return (avoid blowing up context window)
const MAX_CONTENT_CHARS = 50_000;

/**
 * Extract a Google Drive file ID from various URL formats or raw ID.
 *
 * Handles:
 *   - https://docs.google.com/document/d/FILE_ID/edit
 *   - https://docs.google.com/presentation/d/FILE_ID/edit
 *   - https://docs.google.com/spreadsheets/d/FILE_ID/edit
 *   - https://drive.google.com/file/d/FILE_ID/view
 *   - https://drive.google.com/open?id=FILE_ID
 *   - Raw file ID string
 */
function extractFileId(input) {
  if (!input) return null;
  input = input.trim();

  // URL pattern: /d/FILE_ID/
  const dMatch = input.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (dMatch) return dMatch[1];

  // URL pattern: ?id=FILE_ID
  const idMatch = input.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (idMatch) return idMatch[1];

  // Raw ID (alphanumeric + hyphens + underscores, 20+ chars)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;

  return null;
}

/**
 * Determine the Google Drive MIME type category.
 */
function classifyMimeType(mimeType) {
  if (mimeType === 'application/vnd.google-apps.document') return 'google_doc';
  if (mimeType === 'application/vnd.google-apps.presentation') return 'google_slides';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'google_sheets';
  if (mimeType === 'application/vnd.google-apps.folder') return 'folder';
  if (mimeType?.startsWith('application/vnd.google-apps.')) return 'google_other';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mimeType?.startsWith('text/')) return 'text';
  return 'other';
}

/**
 * Main tool function.
 *
 * @param {string} atlasUserId
 * @param {object} input - { file_url_or_id: string }
 * @param {object} context - { userEmail }
 * @returns {Promise<object>}
 */
module.exports = async function readGoogleDoc(atlasUserId, input, context) {
  const { file_url_or_id } = input;
  if (!file_url_or_id) {
    return { error: 'Missing file_url_or_id. Provide a Google Drive/Docs/Slides URL or file ID.' };
  }

  const fileId = extractFileId(file_url_or_id);
  if (!fileId) {
    return { error: `Could not extract a file ID from: "${file_url_or_id}". Provide a Google Drive URL or file ID.` };
  }

  const userEmail = context?.userEmail;
  if (!userEmail) {
    return { error: 'No user email available for Google API impersonation.' };
  }

  let auth;
  try {
    auth = await getAuthClient(userEmail, SCOPES);
  } catch (err) {
    return { error: `Google auth failed: ${err.message}` };
  }

  const drive = google.drive({ version: 'v3', auth });

  // Step 1: Get file metadata
  let fileMeta;
  try {
    const res = await drive.files.get({
      fileId,
      fields: 'id,name,mimeType,size,modifiedTime,owners',
      supportsAllDrives: true,
    });
    fileMeta = res.data;
  } catch (err) {
    if (err.code === 404) {
      return { error: `File not found: ${fileId}. Check the URL and make sure the service account has access.` };
    }
    return { error: `Failed to get file metadata: ${err.message}` };
  }

  const category = classifyMimeType(fileMeta.mimeType);
  console.log(`[read-google-doc] File: "${fileMeta.name}" (${fileMeta.mimeType}) → category: ${category}`);

  if (category === 'folder') {
    return { error: `"${fileMeta.name}" is a folder, not a file. Use a direct file URL.` };
  }

  // Step 2: Export or download content
  let content = '';
  let contentType = 'text';

  try {
    if (category === 'google_doc') {
      // Export as plain text
      const res = await drive.files.export({
        fileId,
        mimeType: 'text/plain',
      }, { responseType: 'text' });
      content = res.data;

    } else if (category === 'google_slides') {
      // Export as plain text (gets all slide text content)
      const res = await drive.files.export({
        fileId,
        mimeType: 'text/plain',
      }, { responseType: 'text' });
      content = res.data;

    } else if (category === 'google_sheets') {
      // Export as CSV (first sheet)
      const res = await drive.files.export({
        fileId,
        mimeType: 'text/csv',
      }, { responseType: 'text' });
      content = res.data;
      contentType = 'csv';

    } else if (category === 'text') {
      // Plain text file — download directly
      const res = await drive.files.get({
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      }, { responseType: 'text' });
      content = res.data;

    } else if (category === 'docx' || category === 'pptx') {
      // Uploaded Office files — Google Drive can export them as text if we
      // first copy to a Google native format, but simpler: export via Drive
      // which auto-converts uploaded Office docs
      try {
        const res = await drive.files.export({
          fileId,
          mimeType: 'text/plain',
        }, { responseType: 'text' });
        content = res.data;
      } catch (exportErr) {
        // If export fails (not a Google native format), download raw and note limitation
        return {
          error: `"${fileMeta.name}" is an uploaded ${category.toUpperCase()} file that Google can't export as text. ` +
                 `Try opening it in Google Docs/Slides first (File → Save as Google Docs/Slides), then share that version.`,
        };
      }

    } else if (category === 'pdf') {
      return {
        file_name: fileMeta.name,
        file_type: 'PDF',
        note: `"${fileMeta.name}" is a PDF. Google Drive cannot export PDFs as text directly. ` +
              `If this PDF was created from a Google Doc, ask for the original Doc URL instead. ` +
              `Otherwise, the user can copy-paste the relevant sections.`,
      };

    } else {
      return {
        file_name: fileMeta.name,
        file_type: fileMeta.mimeType,
        note: `Unsupported file type: ${fileMeta.mimeType}. Supported: Google Docs, Slides, Sheets, plain text files, and uploaded .docx/.pptx.`,
      };
    }
  } catch (err) {
    return { error: `Failed to read file content: ${err.message}` };
  }

  // Step 3: Truncate if needed
  let truncated = false;
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.substring(0, MAX_CONTENT_CHARS);
    truncated = true;
  }

  // Clean up excessive whitespace
  content = content.replace(/\n{4,}/g, '\n\n\n').trim();

  const owner = fileMeta.owners?.[0]?.displayName || 'Unknown';
  const modified = fileMeta.modifiedTime ? new Date(fileMeta.modifiedTime).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  }) : 'Unknown';

  return {
    success: true,
    file_name: fileMeta.name,
    file_type: category,
    owner,
    last_modified: modified,
    content_type: contentType,
    content,
    char_count: content.length,
    truncated,
    ...(truncated ? { note: `Content truncated to ${MAX_CONTENT_CHARS.toLocaleString()} characters. Ask for a specific section if you need more.` } : {}),
  };
};
