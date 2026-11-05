// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem, ContentId } from '@rljson/bs';
import { createSocketPair, IoMem } from '@rljson/io';
import { PeerReadServer } from '@rljson/server';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Fleet,
  FleetHolder,
  keyHashOf,
  Webcache,
  WebcacheIndex,
  WebcacheOptions,
  WebcacheResponse,
} from '../src/index.ts';

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Webcache', () => {
  // Several blocks; random, so they do not collapse into equal blocks.
  const files: Record<string, Buffer> = {
    '/a.zip': randomBytes(5 * 1024 * 1024 + 7),
    '/b.png': randomBytes(300_000),
    '/c.png': randomBytes(1_000),
  };
  let server: Server;
  let base: string;
  let hits: string[];
  let cloud: { delayMs: number; status?: number; trickle?: boolean };

  interface TestNode {
    nodeId: string;
    io: IoMem;
    bs: BsMem;
    webcache: Webcache;
    server: PeerReadServer;
  }
  let nodes: Map<string, TestNode>;
  let now: number | undefined;

  const serve = (req: IncomingMessage, res: ServerResponse) => {
    hits.push(req.url as string);
    const content = files[(req.url as string).split('?')[0]];
    setTimeout(() => {
      if (cloud.status || !content) {
        res.writeHead(cloud.status ?? 404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(content.length),
      });
      if (!cloud.trickle) {
        res.end(content);
        return;
      }
      let at = 0;
      const timer = setInterval(() => {
        if (res.destroyed || at >= content.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(content.subarray(at, (at += 64 * 1024)));
      }, 5);
    }, cloud.delayMs);
  };

  const url = (path: string) => `${base}${path}?sv=1&sig=secret`;

  const addNode = async (
    nodeId: string,
    options: Partial<WebcacheOptions> = {},
  ): Promise<TestNode> => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const bs = new BsMem();
    const webcache = await Webcache.open({
      io,
      bs,
      nodeId,
      allowedHosts: ['127.0.0.1'],
      claimSettleMs: 30,
      pollMs: 10,
      heartbeatMs: 20,
      sweepIntervalMs: 0,
      retryDelayMs: 1,
      ...(now === undefined ? {} : { clock: () => now as number }),
      ...options,
    });
    const node = { nodeId, io, bs, webcache, server: new PeerReadServer(io, bs) };
    nodes.set(nodeId, node);
    return node;
  };

  /** Connects every node's webcache to all the others. */
  const connectAll = () => {
    for (const node of nodes.values()) {
      node.webcache.attach(
        new Fleet({
          nodeId: node.nodeId,
          nodes: () => [...nodes.keys()],
          timeoutMs: 200,
          connectTimeoutMs: 200,
          connect: async (nodeId) => {
            const target = nodes.get(nodeId);
            if (!target) return undefined;
            const [serverSide, clientSide] = createSocketPair();
            serverSide.connect();
            clientSide.connect();
            await target.server.addSocket(serverSide);
            return clientSide;
          },
        }),
      );
    }
  };

  const fetchAll = async (node: TestNode, path: string, extra = {}) => {
    const response = await node.webcache.fetch({ url: url(path), consumer: 'test', ...extra });
    const bytes = await readAll(response.body());
    response.served(bytes.length);
    const entry = await response.finished;
    return { response, bytes, entry };
  };

  beforeEach(async () => {
    hits = [];
    cloud = { delayMs: 0 };
    nodes = new Map();
    now = undefined;
    server = createServer(serve);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const node of nodes.values()) await node.webcache.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  describe('fetch(request) on one node', () => {
    it('downloads a miss from the cloud, then answers from its own store', async () => {
      const a = await addNode('a');
      const first = await fetchAll(a, '/a.zip', { size: files['/a.zip'].length });
      expect([first.response.source, first.response.contentType]).toEqual([
        'cloud',
        'application/octet-stream',
      ]);
      expect(first.bytes).toEqual(files['/a.zip']);
      const second = await fetchAll(a, '/a.zip');
      expect(second.response.source).toBe('local');
      expect(second.response.size).toBe(files['/a.zip'].length);
      expect(second.response.blobId).toBe(ContentId.of(files['/a.zip']));
      expect(second.bytes).toEqual(files['/a.zip']);
      expect(hits).toEqual(['/a.zip?sv=1&sig=secret']);
      const stats = a.webcache.stats.of(second.response.keyHash);
      expect([stats?.requests, stats?.hits.cloud, stats?.hits.local]).toEqual([2, 1, 1]);
    });

    it('serves a range of what it holds', async () => {
      const a = await addNode('a');
      await fetchAll(a, '/b.png');
      const response = await a.webcache.fetch({ url: url('/b.png') });
      expect(await readAll(response.body({ start: 10, end: 20 }))).toEqual(
        files['/b.png'].subarray(10, 20),
      );
    });

    it('downloads once for requests that come at the same time', async () => {
      const a = await addNode('a');
      cloud.delayMs = 50;
      const [x, y] = await Promise.all([fetchAll(a, '/b.png'), fetchAll(a, '/b.png')]);
      expect(hits.length).toBe(1);
      expect([x.response.source, y.response.source].sort()).toEqual(['cloud', 'local']);
      expect(y.bytes).toEqual(files['/b.png']);
    });

    it('takes a key of its own, whatever the URL', async () => {
      const a = await addNode('a');
      await fetchAll(a, '/c.png', { key: 'graphic:c|1000|2026' });
      const again = await fetchAll(a, '/b.png', { key: 'graphic:c|1000|2026' });
      expect([again.response.source, again.response.key]).toEqual(['local', 'graphic:c|1000|2026']);
      expect(again.bytes).toEqual(files['/c.png']);
    });

    it('downloads again when the size asked for differs from the one held', async () => {
      const a = await addNode('a');
      await fetchAll(a, '/c.png', { key: 'k' });
      await expect(
        a.webcache.fetch({ url: url('/c.png'), key: 'k', size: 5 }),
      ).rejects.toMatchObject({ reason: 'size-mismatch' });
      expect(hits.length).toBe(2);
    });

    it('downloads again when its blob went missing', async () => {
      const a = await addNode('a');
      const { entry } = await fetchAll(a, '/c.png');
      await a.bs.deleteBlob(entry.blobId);
      expect((await fetchAll(a, '/c.png')).response.source).toBe('cloud');
    });

    it('refuses a host that is not allowed', async () => {
      const a = await addNode('a', { allowedHosts: ['downloads.example.com'] });
      await expect(a.webcache.fetch({ url: url('/c.png') })).rejects.toMatchObject({
        reason: 'host-not-allowed',
        status: 403,
      });
    });

    it('refuses a request without a usable URL or size', async () => {
      const a = await addNode('a');
      const cases: [unknown, string][] = [
        [{ url: 'not a url' }, "Not an http(s) URL: 'not a url'"],
        [{ url: url('/c.png'), size: 1.5 }, 'The size must be a whole number of bytes'],
        [{ url: 7 }, 'The URL is missing'],
        [{ url: url('/c.png'), key: '' }, 'The key is empty'],
      ];
      for (const [request, message] of cases) {
        await expect(a.webcache.fetch(request as never)).rejects.toMatchObject({
          reason: 'bad-request',
          message,
        });
      }
    });

    it('fails every waiting request when the cloud refuses, and tries again later', async () => {
      const a = await addNode('a');
      cloud.status = 403;
      const errors = await Promise.all([
        a.webcache.fetch({ url: url('/c.png') }).catch((e) => e),
        a.webcache.fetch({ url: url('/c.png') }).catch((e) => e),
      ]);
      expect(errors.map((e) => e.upstreamStatus)).toEqual([403, 403]);
      expect(hits.length).toBe(1);
      expect((await a.webcache.entries()).length).toBe(0);
      cloud.status = undefined;
      expect((await fetchAll(a, '/c.png')).response.source).toBe('cloud');
    });

    it('marks a download the cloud refused as failed in its index', async () => {
      const a = await addNode('a');
      cloud.status = 500;
      await a.webcache.fetch({ url: url('/c.png'), key: 'k' }).catch(() => undefined);
      const index = await WebcacheIndex.open(a.io, { nodeId: 'a' });
      expect((await index.all()).map((e) => e.state)).toEqual(['failed']);
    });

    it('renews its claim while a download runs', async () => {
      const a = await addNode('a');
      cloud.trickle = true;
      const { response } = await fetchAll(a, '/a.zip');
      const rows = WebcacheIndex.rowsOf(await a.io.readRows(WebcacheIndex.query(response.keyHash)));
      expect(rows.filter((r) => r.state === 'downloading').length).toBeGreaterThan(2);
    });

    it('stops a download that connected while it closed', async () => {
      const a = await addNode('a');
      cloud.delayMs = 50;
      const fetching = a.webcache.fetch({ url: url('/a.zip') });
      await sleep(10);
      await a.webcache.close();
      const response = await fetching;
      await expect(response.finished).rejects.toThrow();
    });

    it('refuses requests once closed', async () => {
      const a = await addNode('a');
      await a.webcache.close();
      await expect(a.webcache.fetch({ url: url('/c.png') })).rejects.toMatchObject({
        reason: 'closed',
      });
    });
  });

  describe('fetch(request) in a fleet', () => {
    it('reads what another node holds from that node', async () => {
      const a = await addNode('a');
      const b = await addNode('b');
      connectAll();
      await fetchAll(a, '/a.zip');
      const fromFleet = await fetchAll(b, '/a.zip');
      expect(fromFleet.response.source).toBe('fleet');
      expect(fromFleet.bytes).toEqual(files['/a.zip']);
      expect(hits.length).toBe(1);
      expect((await fetchAll(b, '/a.zip')).response.source).toBe('local');
      const [entry] = await b.webcache.entries();
      expect([entry.source, entry.state]).toEqual(['fleet', 'cached']);
    });

    it('downloads a file once when all nodes ask for it at the same moment', async () => {
      await addNode('a');
      await addNode('b');
      await addNode('c');
      connectAll();
      cloud.delayMs = 80;
      const results = await Promise.all(
        [...nodes.values()].map((node) => fetchAll(node, '/a.zip')),
      );
      expect(hits.length).toBe(1);
      expect(results.map((r) => r.response.source).sort()).toEqual(['cloud', 'fleet', 'fleet']);
      for (const r of results) expect(r.bytes).toEqual(files['/a.zip']);
    });

    it('waits for a node that downloads the file, and reads it from there', async () => {
      const a = await addNode('a');
      const b = await addNode('b');
      connectAll();
      cloud.delayMs = 100;
      const first = fetchAll(a, '/b.png');
      await sleep(50);
      const second = await fetchAll(b, '/b.png');
      expect(second.response.source).toBe('fleet');
      expect((await first).response.source).toBe('cloud');
      expect(hits.length).toBe(1);
      expect(b.webcache.downloads()).toEqual([]);
    });

    it('downloads itself once the wait for another node ran out', async () => {
      const a = await addNode('a');
      const b = await addNode('b', { waitMs: 100 });
      connectAll();
      const { keyHash } = await fetchAll(a, '/c.png').then((r) => r.response);
      // Rows of a second writer for node a, newer than the webcache's own.
      const index = await WebcacheIndex.open(a.io, {
        nodeId: 'a',
        clock: () => Date.now() + 1_000,
      });
      await index.write(
        WebcacheIndex.exampleDraft({ keyHash, state: 'removed', key: 'x' }),
      );
      const heartbeat = setInterval(
        () =>
          void index.write(WebcacheIndex.exampleDraft({ keyHash, state: 'downloading' })),
        15,
      );
      try {
        const started = Date.now();
        expect((await fetchAll(b, '/c.png')).response.source).toBe('cloud');
        expect(Date.now() - started).toBeGreaterThanOrEqual(90);
      } finally {
        clearInterval(heartbeat);
      }
    });

    it('does not wait for a download that stopped long ago', async () => {
      now = 10_000_000;
      const a = await addNode('a');
      const b = await addNode('b');
      connectAll();
      const index = await WebcacheIndex.open(a.io, { nodeId: 'a', clock: () => 1 });
      await index.write(
        WebcacheIndex.exampleDraft({ keyHash: keyHashOf('older'), state: 'downloading' }),
      );
      const started = Date.now();
      expect((await fetchAll(b, '/b.png', { key: 'older' })).response.source).toBe('cloud');
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('stops waiting when the downloading node stops beating', async () => {
      const a = await addNode('a');
      const b = await addNode('b', { staleMs: 60, waitMs: 5_000 });
      connectAll();
      const index = await WebcacheIndex.open(a.io, { nodeId: 'a' });
      await index.write(WebcacheIndex.exampleDraft({ keyHash: 'k', state: 'downloading' }));
      const started = Date.now();
      expect((await fetchAll(b, '/c.png', { key: 'k' })).response.source).toBe('cloud');
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('downloads from the cloud when the holder cannot give the blob', async () => {
      const a = await addNode('a');
      const b = await addNode('b');
      connectAll();
      const { entry } = await fetchAll(a, '/c.png');
      // a still lists the file, but cannot give it.
      await a.bs.deleteBlob(entry.blobId);
      expect((await fetchAll(b, '/c.png')).response.source).toBe('cloud');
    });

    it('uses no fleet once detached, or when the fleet is switched off', async () => {
      const a = await addNode('a');
      const b = await addNode('b');
      connectAll();
      await fetchAll(a, '/c.png');
      b.webcache.detach();
      expect(b.webcache.fleet).toBeUndefined();
      expect((await fetchAll(b, '/c.png')).response.source).toBe('cloud');
      const c = await addNode('c', { fleetEnabled: false });
      connectAll();
      expect((await fetchAll(c, '/c.png')).response.source).toBe('cloud');
    });

    it('stops waiting when the fleet is detached meanwhile', async () => {
      const a = await addNode('a');
      const b = await addNode('b', { waitMs: 5_000 });
      connectAll();
      const index = await WebcacheIndex.open(a.io, { nodeId: 'a' });
      const beat = setInterval(
        () => void index.write(WebcacheIndex.exampleDraft({ keyHash: keyHashOf('k'), state: 'downloading' })),
        10,
      );
      try {
        const fetching = fetchAll(b, '/c.png', { key: 'k' });
        await sleep(40);
        expect(b.webcache.downloads()[0].stage).toBe('waiting');
        b.webcache.detach();
        expect((await fetching).response.source).toBe('cloud');
      } finally {
        clearInterval(beat);
      }
    });

    it('reads from a node that got the file while the claim settled', async () => {
      const a = await addNode('a');
      const b = await addNode('b', { claimSettleMs: 150 });
      connectAll();
      const fetching = fetchAll(b, '/c.png', { key: 'k' });
      await sleep(40);
      const { blobId } = await a.bs.setBlob(files['/c.png']);
      const index = await WebcacheIndex.open(a.io, { nodeId: 'a' });
      await index.write(
        WebcacheIndex.exampleDraft({ keyHash: keyHashOf('k'), key: 'k', blobId, size: 1_000 }),
      );
      expect((await fetching).response.source).toBe('fleet');
      expect(hits).toEqual([]);
    });

    it('stops a copy from the fleet when closed', async () => {
      const a = await addNode('a');
      const b = await addNode('b');
      connectAll();
      await fetchAll(a, '/a.zip');
      const fleet = b.webcache.fleet as Fleet;
      const slow = Object.create(fleet) as Fleet;
      slow.block = async (holder: FleetHolder, blockId: string) => {
        await sleep(30);
        return fleet.block(holder, blockId);
      };
      b.webcache.attach(slow);
      const response = await b.webcache.fetch({ url: url('/a.zip') });
      expect(response.source).toBe('fleet');
      await b.webcache.close();
      await expect(response.finished).rejects.toThrow('The transfer was stopped');
    });

    it('yields to a node with a lower id that claimed the file at the same time', async () => {
      const a = await addNode('a');
      const b = await addNode('b');
      connectAll();
      cloud.delayMs = 60;
      const [fromB, fromA] = await Promise.all([fetchAll(b, '/b.png'), fetchAll(a, '/b.png')]);
      expect([fromA.response.source, fromB.response.source]).toEqual(['cloud', 'fleet']);
    });
  });

  describe('entries()', () => {
    it('lists what it holds, with numbers and the end of its lifetime', async () => {
      now = 1_000_000;
      const a = await addNode('a', { lifetimeMs: 10_000 });
      await fetchAll(a, '/c.png');
      const [entry] = await a.webcache.entries();
      expect(entry).toMatchObject({
        key: `${base}/c.png`,
        state: 'cached',
        size: 1_000,
        source: 'cloud',
        consumer: 'test',
        lastAccess: 1_000_000,
        expiresAt: 1_010_000,
      });
      expect(entry.stats?.requests).toBe(1);
      await a.webcache.pin(entry.keyHash);
      expect((await a.webcache.entries())[0].expiresAt).toBeNull();
    });
  });

  describe('entries() of what nobody asked for yet', () => {
    it('count the lifetime from the download', async () => {
      now = 5_000;
      const a = await addNode('a', { lifetimeMs: 100 });
      await a.webcache.prefetch([{ url: url('/c.png') }]);
      const [entry] = await a.webcache.entries();
      expect([entry.stats, entry.lastAccess, entry.expiresAt]).toEqual([undefined, 5_000, 5_100]);
      now = 6_000;
      expect((await a.webcache.sweep()).expired).toBe(1);
    });
  });

  describe('remove(keyHash), pin(keyHash), unpin(keyHash)', () => {
    it('remove an entry and its blob, or change its pin', async () => {
      const a = await addNode('a');
      const { response, entry } = await fetchAll(a, '/c.png');
      expect(await a.webcache.pin(response.keyHash)).toBe(true);
      expect((await a.webcache.entries())[0].state).toBe('pinned');
      expect(await a.webcache.unpin(response.keyHash)).toBe(true);
      expect((await a.webcache.entries())[0].state).toBe('cached');
      expect(await a.webcache.remove(response.keyHash)).toBe(true);
      expect(await a.webcache.entries()).toEqual([]);
      expect(await a.bs.blobExists(entry.blobId)).toBe(false);
      expect(a.webcache.stats.of(response.keyHash)).toBeUndefined();
    });

    it('answer false for what it does not hold', async () => {
      const a = await addNode('a');
      expect(await a.webcache.remove('none')).toBe(false);
      expect(await a.webcache.pin('none')).toBe(false);
      expect(await a.webcache.unpin('none')).toBe(false);
    });

    it('keep a blob another entry still holds, and one that is being read', async () => {
      const a = await addNode('a');
      const one = await fetchAll(a, '/c.png', { key: 'one' });
      await fetchAll(a, '/c.png', { key: 'two' });
      await a.webcache.remove(one.response.keyHash);
      expect(await a.bs.blobExists(one.entry.blobId)).toBe(true);

      const reading = await a.webcache.fetch({ url: url('/c.png'), key: 'two' });
      const reader = reading.body().getReader();
      await a.webcache.remove(reading.keyHash);
      expect(await a.bs.blobExists(one.entry.blobId)).toBe(true);
      await reader.cancel();
    });
  });

  describe('verify(keyHash)', () => {
    it('reads an entry whole and removes it when it is damaged', async () => {
      const a = await addNode('a');
      const { response, entry } = await fetchAll(a, '/c.png');
      expect(await a.webcache.verify(response.keyHash)).toEqual({ ok: true });
      await a.bs.deleteBlob(entry.blobId);
      const result = await a.webcache.verify(response.keyHash);
      expect(result.ok).toBe(false);
      expect(await a.webcache.entries()).toEqual([]);
      expect(await a.webcache.verify('none')).toEqual({ ok: false, reason: 'Not held here' });
    });
  });

  describe('prefetch(requests)', () => {
    it('downloads ahead of the requests, and reports each', async () => {
      const a = await addNode('a');
      const results = await a.webcache.prefetch([
        { url: url('/c.png') },
        { url: url('/missing') },
      ]);
      expect(results.map((r) => [r.source, r.error])).toEqual([
        ['cloud', undefined],
        [undefined, `The cloud answered 404 for ${base}/missing`],
      ]);
      expect((await fetchAll(a, '/c.png')).response.source).toBe('local');
    });
  });

  describe('downloads()', () => {
    it('lists the downloads that run, with their progress', async () => {
      const a = await addNode('a');
      cloud.delayMs = 50;
      const response = a.webcache.fetch({ url: url('/a.zip') });
      await sleep(10);
      const [looking] = a.webcache.downloads();
      expect(looking.stage).toBe('looking');
      const r = await response;
      const [running] = a.webcache.downloads();
      expect(running).toMatchObject({
        key: `${base}/a.zip`,
        source: 'cloud',
        stage: 'downloading',
        size: files['/a.zip'].length,
      });
      await readAll(r.body());
      await r.finished;
      expect(a.webcache.downloads()).toEqual([]);
    });
  });

  describe('summary()', () => {
    it('sums up entries, disk, fleet and numbers', async () => {
      const a = await addNode('a', {
        maintenance: {
          usage: async () => ({ blobs: 1, blocks: 1, bytes: 1_000 }),
          collectGarbage: async () => ({ removedBlocks: 0, freedBytes: 0 }),
        },
        diskSpace: async () => ({ free: 50, total: 100 }),
      });
      await fetchAll(a, '/c.png');
      const summary = await a.webcache.summary();
      expect(summary).toMatchObject({
        nodeId: 'a',
        entries: 1,
        pinned: 0,
        bytes: 1_000,
        usageBytes: 1_000,
        diskBudgetBytes: 50 * 1024 ** 3,
        disk: { free: 50, total: 100 },
        downloads: 0,
        fleet: { attached: false, connectedNodes: [] },
      });
      expect(summary.totals.all.requests).toBe(1);
    });

    it('measures the disk of its folder', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'webcache-'));
      try {
        const a = await addNode('a', { folder });
        const { disk } = await a.webcache.summary();
        expect(disk?.total).toBeGreaterThan(0);
        expect(disk?.free).toBeGreaterThan(0);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    it('leaves out what it cannot measure', async () => {
      const a = await addNode('a');
      const summary = await a.webcache.summary();
      expect([summary.usageBytes, summary.disk]).toEqual([undefined, undefined]);
    });
  });

  describe('sweep()', () => {
    it('removes what outlived its lifetime, but no pinned entry', async () => {
      now = 1_000;
      const a = await addNode('a', { lifetimeMs: 100 });
      const old = (await fetchAll(a, '/c.png')).entry;
      const pinned = (await fetchAll(a, '/b.png')).response;
      await a.webcache.pin(pinned.keyHash);
      now = 2_000;
      const result = await a.webcache.sweep();
      expect([result.expired, result.evicted]).toEqual([1, 0]);
      expect((await a.webcache.entries()).map((e) => e.keyHash)).toEqual([pinned.keyHash]);
      expect(await a.bs.blobExists(old.blobId)).toBe(false);
    });

    it('evicts the least recently used above the disk budget', async () => {
      now = 1_000;
      let bytes = 0;
      const a = await addNode('a', {
        diskBudgetBytes: 300_500,
        maintenance: {
          usage: async () => ({ blobs: 0, blocks: 0, bytes }),
          collectGarbage: async () => ({ removedBlocks: 3, freedBytes: 300 }),
        },
      });
      const c = (await fetchAll(a, '/c.png')).response;
      now = 2_000;
      await fetchAll(a, '/b.png');
      bytes = 301_000;
      const result = await a.webcache.sweep();
      expect(result).toMatchObject({ expired: 0, evicted: 1, freedBytes: 300 });
      expect((await a.webcache.entries()).map((e) => e.keyHash)).not.toContain(c.keyHash);
    });

    it('evicts when the disk runs short of free space', async () => {
      const a = await addNode('a', {
        minFreeDiskPercent: 10,
        diskSpace: async () => ({ free: 5_000, total: 100_000 }),
        maintenance: {
          usage: async () => ({ blobs: 0, blocks: 0, bytes: 1_000 }),
          collectGarbage: async () => ({ removedBlocks: 0, freedBytes: 0 }),
        },
      });
      await fetchAll(a, '/c.png');
      expect((await a.webcache.sweep()).evicted).toBe(1);
    });

    it('removes blobs no entry holds any more, after a grace period', async () => {
      now = Date.now();
      const a = await addNode('a');
      const stray = await a.bs.setBlob('stray');
      expect((await a.webcache.sweep()).orphans).toBe(0);
      now += 11 * 60_000;
      expect((await a.webcache.sweep()).orphans).toBe(1);
      expect(await a.bs.blobExists(stray.blobId)).toBe(false);
    });

    it('leaves alone what is being read or downloaded', async () => {
      now = 1_000;
      const a = await addNode('a', { lifetimeMs: 10 });
      await fetchAll(a, '/c.png');
      const reading = await a.webcache.fetch({ url: url('/c.png') });
      const reader = reading.body().getReader();
      now = 5_000;
      expect((await a.webcache.sweep()).expired).toBe(0);
      await reader.cancel();
      expect((await a.webcache.sweep()).expired).toBe(1);
    });

    it('leaves an entry alone while it is fetched again', async () => {
      now = 1_000;
      const a = await addNode('a', { lifetimeMs: 10 });
      const { entry } = await fetchAll(a, '/c.png');
      await a.bs.deleteBlob(entry.blobId);
      cloud.delayMs = 80;
      const fetching = fetchAll(a, '/c.png');
      await sleep(20);
      now = 5_000;
      expect((await a.webcache.sweep()).expired).toBe(0);
      await fetching;
    });

    it('logs a sweep that failed on its own schedule', async () => {
      const warnings: string[] = [];
      const logger = {
        info: () => undefined,
        warn: (_source: string, message: string) => warnings.push(message),
        error: () => undefined,
        traffic: () => undefined,
      };
      await addNode('a', {
        sweepIntervalMs: 10,
        logger: logger as never,
        maintenance: {
          usage: async () => Promise.reject(new Error('disk gone')),
          collectGarbage: async () => ({ removedBlocks: 0, freedBytes: 0 }),
        },
      });
      await sleep(50);
      expect(warnings).toContain('A sweep failed');
    });

    it('runs on its own every interval', async () => {
      const a = await addNode('a', { sweepIntervalMs: 20, lifetimeMs: 1 });
      await fetchAll(a, '/c.png');
      await sleep(80);
      expect(await a.webcache.entries()).toEqual([]);
    });
  });

  describe('reconfigure(settings)', () => {
    it('applies new settings at once', async () => {
      const a = await addNode('a');
      a.webcache.reconfigure({ allowedHosts: ['downloads.example.com'] });
      await expect(a.webcache.fetch({ url: url('/c.png') })).rejects.toMatchObject({
        reason: 'host-not-allowed',
      });
      a.webcache.reconfigure({ allowedHosts: ['127.0.0.1'], sweepIntervalMs: 20, lifetimeMs: 1 });
      expect(a.webcache.settings.sweepIntervalMs).toBe(20);
      await fetchAll(a, '/c.png');
      await sleep(80);
      expect(await a.webcache.entries()).toEqual([]);
    });
  });

  describe('close()', () => {
    it('stops the downloads that run', async () => {
      const a = await addNode('a');
      cloud.trickle = true;
      const response: WebcacheResponse = await a.webcache.fetch({ url: url('/a.zip') });
      await a.webcache.close();
      await expect(response.finished).rejects.toThrow();
    });
  });

  describe('example()', () => {
    it('opens a webcache in memory', async () => {
      const example = await Webcache.example();
      expect(example.settings.allowedHosts).toEqual(['downloads.example.com']);
      expect((await example.summary()).entries).toBe(0);
      await example.close();
    });
  });
});
