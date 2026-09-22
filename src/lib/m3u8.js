/**
 * m3u8.js — Dedicated HLS/M3U8 Manifest Handler
 *
 * Responsibilities:
 *  1. Detect whether an upstream response is an M3U8 manifest
 *     (by Content-Type or URL extension).
 *  2. Rewrite all relative URIs inside any M3U8 playlist
 *     (Master or Media/Flavor) to absolute URLs, using the
 *     original upstream URL as the resolution base.
 *
 * Supported URI forms:
 *  - Bare segment/playlist lines   (.ts / .m4s / .mp4 / .aac / .vtt / .m3u8 …)
 *  - URI="..."  attribute inside any #EXT-X-* tag
 *    (#EXT-X-STREAM-INF, #EXT-X-MEDIA, #EXT-X-MAP,
 *     #EXT-X-I-FRAME-STREAM-INF, #EXT-X-SESSION-DATA …)
 *
 * Non-goals:
 *  - Full M3U8 spec parsing / AST — line-based rewriting only.
 *  - Modifying query-string tokens inside already-absolute URLs.
 */

'use strict';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Returns true if this response should be treated as an M3U8 manifest.
 *
 * @param {string} contentType   Value of the upstream Content-Type header.
 * @param {string} targetUrl     The upstream URL that was fetched.
 * @returns {boolean}
 */
function isM3u8(contentType, targetUrl) {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('mpegurl') || ct.includes('m3u8')) return true;
  }
  try {
    // Strip query string before checking extension
    const pathname = new URL(targetUrl).pathname.toLowerCase();
    return pathname.endsWith('.m3u8') || pathname.endsWith('.m3u');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Base URL derivation
// ---------------------------------------------------------------------------

/**
 * Derive the "directory" base URL from the full playlist URL.
 *
 * Example:
 *   https://cdn.example.com/hls/stream/master.m3u8?token=abc
 *   → https://cdn.example.com/hls/stream/
 *
 * Query strings are intentionally stripped from the base because relative
 * segment URLs never inherit query parameters from the playlist URL.
 *
 * @param {string} playlistUrl
 * @returns {string}  Always ends with '/'.
 */
function deriveBaseDir(playlistUrl) {
  const u = new URL(playlistUrl);
  const pathWithoutFile = u.pathname.substring(0, u.pathname.lastIndexOf('/') + 1);
  return `${u.protocol}//${u.host}${pathWithoutFile}`;
}

// ---------------------------------------------------------------------------
// URI resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a potentially-relative URI against a base directory URL string.
 * Returns the URI unchanged if it is already absolute.
 *
 * @param {string} uri
 * @param {string} baseDirUrl   Must end with '/'.
 * @returns {string}
 */
function resolveUri(uri, baseDirUrl) {
  if (!uri || uri.startsWith('data:')) return uri;
  try {
    new URL(uri); // throws if not absolute
    return uri;   // already absolute — leave untouched
  } catch {
    return new URL(uri, baseDirUrl).toString();
  }
}

// ---------------------------------------------------------------------------
// Line-level rewriters
// ---------------------------------------------------------------------------

/**
 * Rewrite all `URI="..."` attribute values in a single tag line.
 * Handles multiple URI attributes on one line (edge case, but safe).
 *
 * @param {string} line
 * @param {string} baseDirUrl
 * @returns {string}
 */
function rewriteTagUris(line, baseDirUrl) {
  return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${resolveUri(uri, baseDirUrl)}"`);
}

/**
 * Rewrite a bare segment/playlist URI line.
 *
 * @param {string} line
 * @param {string} baseDirUrl
 * @returns {string}
 */
function rewriteSegmentLine(line, baseDirUrl) {
  const trimmed = line.trim();
  const resolved = resolveUri(trimmed, baseDirUrl);
  // Preserve any leading whitespace the original line had
  return resolved;
}

// ---------------------------------------------------------------------------
// Main export: rewriteM3u8ToAbsolute
// ---------------------------------------------------------------------------

/**
 * Parse an M3U8 text body line-by-line and rewrite every relative URI
 * to an absolute URL resolved against the playlist's own location.
 *
 * Handles both Master playlists (variant stream URIs) and
 * Media playlists (segment / init / map URIs).
 *
 * @param {string} content      Raw M3U8 text from the upstream server.
 * @param {string} playlistUrl  The URL that was used to fetch `content`.
 * @returns {string}            M3U8 text with all URIs absolutised.
 */
function rewriteM3u8ToAbsolute(content, playlistUrl) {
  let baseDirUrl;
  try {
    baseDirUrl = deriveBaseDir(playlistUrl);
  } catch {
    // Cannot derive a base → return unmodified rather than breaking the stream
    return content;
  }

  // Normalise line endings: CDNs may send \r\n; split on \n and strip \r
  const lines = content.split('\n');

  const rewritten = lines.map(rawLine => {
    // Strip trailing \r from CRLF sequences
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();

    // Preserve blank lines exactly
    if (!trimmed) return '';

    if (trimmed.startsWith('#')) {
      // Tag line — only URI="..." attributes are rewritten; everything else preserved
      return rewriteTagUris(line, baseDirUrl);
    }

    // Bare URI line (segment path, sub-playlist path, etc.)
    return rewriteSegmentLine(line, baseDirUrl);
  });

  // Re-join with Unix line endings (valid per HLS spec RFC 8216 §4)
  return rewritten.join('\n');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  isM3u8,
  rewriteM3u8ToAbsolute,
};
