// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { ContentId } from '@rljson/bs';

// .............................................................................
/**
 * Query parameters that make a URL differ per request without changing what
 * it points to: the signatures and expiry dates of signed URLs (Azure SAS,
 * Amazon S3, Google Cloud Storage). They are left out of a key, so two
 * requests for the same file with differently signed URLs hit one entry.
 */
export const VOLATILE_QUERY_PARAMS: readonly string[] = [
  // Azure shared access signatures
  'sv',
  'ss',
  'srt',
  'sp',
  'se',
  'st',
  'spr',
  'sig',
  'sr',
  'si',
  'sdd',
  'sip',
  'skoid',
  'sktid',
  'skt',
  'ske',
  'sks',
  'skv',
  'saoid',
  'suoid',
  'scid',
  'rscc',
  'rscd',
  'rsce',
  'rscl',
  'rsct',
  // Amazon S3 presigned URLs
  'x-amz-algorithm',
  'x-amz-credential',
  'x-amz-date',
  'x-amz-expires',
  'x-amz-signedheaders',
  'x-amz-signature',
  'x-amz-security-token',
  // Google Cloud Storage signed URLs
  'x-goog-algorithm',
  'x-goog-credential',
  'x-goog-date',
  'x-goog-expires',
  'x-goog-signedheaders',
  'x-goog-signature',
];

// #############################################################################
/** What a cache entry is found by. */
export interface WebcacheKey {
  /** The key: names the content, never changes it. */
  key: string;

  /** The key's hash: what the index is queried by. */
  keyHash: string;
}

// .............................................................................
/**
 * Parses an absolute http(s) URL.
 * @param url - The URL.
 * @returns The parsed URL.
 */
const _parse = (url: string): URL => {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  if (parsed?.protocol !== 'http:' && parsed?.protocol !== 'https:') {
    throw new Error(`Not an http(s) URL: '${url}'`);
  }
  return parsed;
};

// .............................................................................
/**
 * The key of a URL: the URL without its fragment and without the query
 * parameters that only sign it.
 * @param url - An absolute http(s) URL.
 * @param volatile - The parameter names to leave out, case-insensitive.
 * @returns The key.
 */
export const keyOfUrl = (
  url: string,
  volatile: readonly string[] = VOLATILE_QUERY_PARAMS,
): string => {
  const parsed = _parse(url);
  const drop = new Set(volatile.map((name) => name.toLowerCase()));
  for (const name of [...new Set(parsed.searchParams.keys())]) {
    if (drop.has(name.toLowerCase())) parsed.searchParams.delete(name);
  }
  parsed.hash = '';
  return parsed.toString();
};

// .............................................................................
/**
 * The hash of a key: 22 characters of base64url, safe to use in a query.
 * @param key - The key.
 * @returns The hash.
 */
export const keyHashOf = (key: string): string =>
  ContentId.of(Buffer.from(key, 'utf8'));

// .............................................................................
/**
 * The key of a request: the one it names, else the one of its URL.
 * @param request - A key, and the URL to download from.
 * @param request.key - The key; the URL's key when omitted.
 * @param request.url - The URL.
 * @param volatile - The query parameters a URL's key leaves out.
 * @returns The key and its hash.
 */
export const keyOf = (
  request: { key?: string; url: string },
  volatile?: readonly string[],
): WebcacheKey => {
  const key = request.key ?? keyOfUrl(request.url, volatile);
  if (key === '') throw new Error('The key is empty');
  return { key, keyHash: keyHashOf(key) };
};

// .............................................................................
/**
 * A URL as it may be logged or shown: origin and path, never the query,
 * where signatures and tokens live.
 * @param url - The URL.
 * @returns The URL without query and fragment.
 */
export const redactUrl = (url: string): string => {
  if (!URL.canParse(url)) return '(invalid URL)';
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
};
