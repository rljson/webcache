// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { runExample } from '../example/webcache-example.ts';

describe('the example of the README', () => {
  it('prints the cloud first, then the own store', async () => {
    expect(await runExample()).toEqual([
      'cloud: catalogue bytes',
      'local: catalogue bytes',
    ]);
  });
});
