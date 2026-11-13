// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import {
  keyHashOf,
  keyOf,
  keyOfUrl,
  redactUrl,
  VOLATILE_QUERY_PARAMS,
} from '../src/index.ts';

const sas =
  'https://store.example.com/container/BITMAP/G/1/G17?sv=2023-11-03' +
  '&se=2026-11-04T18%3A01%3A32Z&sr=b&sp=r&sig=w6xx%2FY9Q%3D';

describe('keyOfUrl(url)', () => {
  it('drops the volatile query parameters of a signed URL', () => {
    expect(keyOfUrl(sas)).toBe(
      'https://store.example.com/container/BITMAP/G/1/G17',
    );
  });

  it('keeps the other query parameters in their order', () => {
    expect(keyOfUrl('https://example.com/a?b=2&sig=x&a=1')).toBe(
      'https://example.com/a?b=2&a=1',
    );
  });

  it('drops the fragment and lowercases the host', () => {
    expect(keyOfUrl('https://EXAMPLE.com/Path#top')).toBe(
      'https://example.com/Path',
    );
  });

  it('matches parameter names case-insensitively', () => {
    expect(
      keyOfUrl('https://example.com/a?X-Amz-Signature=1&X-Amz-Date=2&v=3'),
    ).toBe('https://example.com/a?v=3');
  });

  it('takes the names to drop', () => {
    expect(keyOfUrl('https://example.com/a?token=1&v=2', ['token'])).toBe(
      'https://example.com/a?v=2',
    );
  });

  it('fails for what is no absolute http(s) URL', () => {
    for (const url of ['relative/path', 'ftp://example.com/a', '']) {
      expect(() => keyOfUrl(url)).toThrow(`Not an http(s) URL: '${url}'`);
    }
  });
});

describe('keyOf(request)', () => {
  it('takes the given key', () => {
    expect(keyOf({ key: 'graphic:a|1|2', url: sas })).toEqual({
      key: 'graphic:a|1|2',
      keyHash: keyHashOf('graphic:a|1|2'),
    });
  });

  it('derives the key from the URL without one', () => {
    expect(keyOf({ url: sas }).key).toBe(keyOfUrl(sas));
  });

  it('fails for an empty key', () => {
    expect(() => keyOf({ key: '', url: sas })).toThrow('The key is empty');
  });
});

describe('keyHashOf(key)', () => {
  it('is a 22 character base64url hash, the same for the same key', () => {
    const hash = keyHashOf('a');
    expect(hash).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(keyHashOf('a')).toBe(hash);
    expect(keyHashOf('b')).not.toBe(hash);
  });
});

describe('redactUrl(url)', () => {
  it('keeps origin and path only', () => {
    expect(redactUrl(sas)).toBe(
      'https://store.example.com/container/BITMAP/G/1/G17',
    );
  });

  it('answers a placeholder for what is no URL', () => {
    expect(redactUrl('not a url')).toBe('(invalid URL)');
  });
});

describe('VOLATILE_QUERY_PARAMS', () => {
  it('covers the signatures of Azure, S3 and Google Cloud Storage', () => {
    for (const name of ['sig', 'se', 'x-amz-signature', 'x-goog-signature']) {
      expect(VOLATILE_QUERY_PARAMS).toContain(name);
    }
  });
});
