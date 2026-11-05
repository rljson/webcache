// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { WebcacheError } from '../src/index.ts';

describe('WebcacheError', () => {
  it('carries reason, HTTP status and the cloud status', () => {
    const error = WebcacheError.example();
    expect([error.reason, error.status, error.upstreamStatus]).toEqual([
      'cloud-status',
      502,
      404,
    ]);
    expect(error.message).toBe('The cloud answered 404');
    expect(error.name).toBe('WebcacheError');
  });

  it('maps every reason to its status', () => {
    const reasons = {
      'bad-request': 400,
      'host-not-allowed': 403,
      'not-found': 404,
      'cloud-timeout': 504,
      'wait-timeout': 504,
      'not-ready': 503,
      closed: 503,
      integrity: 502,
    } as const;
    for (const [reason, status] of Object.entries(reasons)) {
      expect(new WebcacheError(reason as never, reason).status).toBe(status);
    }
  });

  describe('isTransient(error)', () => {
    it('retries what the network or a server error caused', () => {
      const cases: [unknown, boolean][] = [
        [new TypeError('fetch failed'), true],
        [new WebcacheError('cloud-unreachable', ''), true],
        [new WebcacheError('cloud-timeout', ''), true],
        [new WebcacheError('cloud-status', '', 503), true],
        [new WebcacheError('cloud-status', '', 403), false],
        [new WebcacheError('size-mismatch', ''), false],
      ];
      for (const [error, transient] of cases) {
        expect(WebcacheError.isTransient(error)).toBe(transient);
      }
    });
  });
});
