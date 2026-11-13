// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WebcacheStats } from '../src/index.ts';

describe('WebcacheStats', () => {
  let dir: string;
  let file: string;
  let now: number;
  const day1 = new Date(2026, 10, 5, 8, 0).getTime();
  const day2 = new Date(2026, 10, 6, 8, 0).getTime();

  const open = (options: Partial<Parameters<typeof WebcacheStats.open>[0]> = {}) =>
    WebcacheStats.open({ file, clock: () => now, flushMs: 0, ...options });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webcache-stats-'));
    file = join(dir, 'stats.json');
    now = day1;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('request(keyHash, source, consumer) and served(keyHash, bytes, source, consumer)', () => {
    it('count requests, hits and bytes per file, per consumer and today', async () => {
      const stats = await open();
      stats.request('a', 'cloud', 'graphics');
      stats.served('a', 100, 'cloud', 'graphics');
      now += 1_000;
      stats.request('a', 'local', 'graphics');
      stats.served('a', 100, 'local', 'graphics');
      stats.request('b', 'fleet', 'catalogues');
      stats.served('b', 50, 'fleet', 'catalogues');

      expect(stats.of('a')).toEqual({
        requests: 2,
        hits: { local: 1, fleet: 0, cloud: 1 },
        bytesServed: 200,
        bytesFromCloud: 100,
        firstAccess: day1,
        lastAccess: day1 + 1_000,
      });
      const totals = stats.totals();
      expect(totals.all).toEqual({
        requests: 3,
        hits: { local: 1, fleet: 1, cloud: 1 },
        bytesServed: 250,
        bytesFromCloud: 100,
      });
      expect(totals.today.day).toBe('2026-11-05');
      expect(totals.today.requests).toBe(3);
      expect(totals.byConsumer.graphics.requests).toBe(2);
      expect(totals.byConsumer.catalogues.bytesServed).toBe(50);
    });

    it('start a new day at midnight, local time', async () => {
      const stats = await open();
      stats.request('a', 'cloud', 'graphics');
      now = day2;
      stats.request('a', 'local', 'graphics');
      expect(stats.totals().today).toEqual({
        day: '2026-11-06',
        requests: 1,
        hits: { local: 1, fleet: 0, cloud: 0 },
        bytesServed: 0,
        bytesFromCloud: 0,
      });
      expect(stats.totals().all.requests).toBe(2);
    });

    it('starts a new day also when only the totals are asked', async () => {
      const stats = await open();
      stats.request('a', 'cloud', 'x');
      now = day2;
      expect(stats.totals().today.requests).toBe(0);
    });

    it('counts bytes of a file it never saw a request for', async () => {
      const stats = await open();
      stats.served('z', 7, 'local');
      expect(stats.of('z')?.bytesServed).toBe(7);
      expect(stats.totals().byConsumer).toEqual({});
    });
  });

  describe('lastAccess(keyHash) and forget(keyHash)', () => {
    it('answer when a file was last asked for, until it is forgotten', async () => {
      const stats = await open();
      stats.request('a', 'local', 'x');
      expect(stats.lastAccess('a')).toBe(day1);
      stats.forget('a');
      expect(stats.lastAccess('a')).toBeUndefined();
      expect(stats.of('a')).toBeUndefined();
    });
  });

  describe('flush() and open(options)', () => {
    it('keep the numbers across a restart', async () => {
      const stats = await open();
      stats.request('a', 'cloud', 'graphics');
      stats.served('a', 9, 'cloud');
      await stats.close();
      const again = await open();
      expect(again.of('a')?.bytesServed).toBe(9);
      expect(again.totals().byConsumer.graphics.requests).toBe(1);
    });

    it('write nothing when nothing changed', async () => {
      const stats = await open();
      await stats.flush();
      expect(() => readFileSync(file)).toThrow();
    });

    it('flush on their own after the flush period', async () => {
      const stats = await open({ flushMs: 10 });
      stats.request('a', 'cloud', 'x');
      await new Promise((r) => setTimeout(r, 60));
      expect(JSON.parse(readFileSync(file, 'utf8')).files.a.requests).toBe(1);
      await stats.close();
    });

    it('start empty from a file that is broken', async () => {
      writeFileSync(file, '{ broken');
      expect((await open()).totals().all.requests).toBe(0);
    });

    it('keep everything in memory without a file', async () => {
      const stats = await open({ file: undefined });
      stats.request('a', 'cloud', 'x');
      await stats.close();
      expect(stats.of('a')?.requests).toBe(1);
    });

    it('use the system clock and the default flush period when not given', async () => {
      const stats = await WebcacheStats.open({});
      stats.request('a', 'cloud', 'x');
      expect(stats.lastAccess('a')).toBeGreaterThan(day1);
      await stats.close();
    });
  });

  describe('example()', () => {
    it('is an empty journal in memory', () => {
      expect(WebcacheStats.example().totals().all.requests).toBe(0);
    });
  });
});
