// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { Webcache } from '../src/webcache.ts';

describe('Webcache', () => {
  it('greets with the greeting', () => {
    expect(new Webcache('Hi').greet('Ada')).toBe('Hi, Ada!');
  });

  it('example() greets with Hello', () => {
    expect(Webcache.example().greet('Ada')).toBe('Hello, Ada!');
    expect(Webcache.example({ greeting: 'Hey' }).greeting).toBe('Hey');
  });
});
