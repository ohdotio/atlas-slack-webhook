'use strict';

/**
 * Convert standard markdown formatting to Slack mrkdwn.
 *
 * Slack mrkdwn reference:
 *   Bold:          *text*
 *   Italic:        _text_
 *   Strikethrough: ~text~
 *   Inline code:   `text`
 *   Code block:    ```text```
 *   Block quote:   > text
 *   Lists:         • for bullets, 1. for numbered
 *   Links:         <url|text>
 *
 * @param {string} text
 * @returns {string}
 */
function markdownToSlack(text) {
  if (!text) return text;

  // Preserve code blocks from being mangled — extract, convert later
  const codeBlocks = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push('```' + code.trimEnd() + '```');
    return `__CODEBLOCK_${idx}__`;
  });

  // Preserve inline code
  const inlineCodes = [];
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push('`' + code + '`');
    return `__INLINECODE_${idx}__`;
  });

  result = result
    // Headings: ### Foo → *Foo*
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // Bold: **text** or __text__ → *text* (must do before italic)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    // Strikethrough: ~~text~~ → ~text~
    .replace(/~~(.+?)~~/g, '~$1~')
    // Links: [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    // Bare URLs not already in <> — wrap them for Slack
    .replace(/(?<![<|])https?:\/\/[^\s>)]+/g, '<$&>')
    // Horizontal rules
    .replace(/^[-*_]{3,}$/gm, '───')
    // Bullet lists: - or * at start → •
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    // Clean up any resulting double-asterisks from nested bold
    .replace(/\*\*+/g, '*');

  // Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`__INLINECODE_${i}__`, inlineCodes[i]);
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`__CODEBLOCK_${i}__`, codeBlocks[i]);
  }

  return result;
}

module.exports = { markdownToSlack };
