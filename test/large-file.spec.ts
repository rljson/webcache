// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// A file of gigabytes through the webcache, with a real BsFs on disk:
// downloaded from a cloud that breaks off once, then copied by a second node
// through the fleet. Measures memory and time. Off by default — it writes a
// few GB to the temp folder; run it with
//
//   WEBCACHE_LARGE_MB=2048 pnpm exec vitest run test/large-file.spec.ts

import { BsFs } from '@rljson/bs-fs';
import { ContentId } from '@rljson/bs';
import { createSocketPair, IoMem } from '@rljson/io';
import { PeerReadServer } from '@rljson/server';
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Fleet, Webcache } from '../src/index.ts';

const megabytes = Number(process.env.WEBCACHE_LARGE_MB ?? 0);

describe.skipIf(megabytes === 0)(`a file of ${megabytes} MB`, () => {
  const size = megabytes * 1024 * 1024;
  const key = Buffer.alloc(32, 7);

  /** Deterministic random bytes at any offset: AES-256-CTR over zeros. */
  const bytesAt = (offset: number, length: number): Buffer => {
    const aligned = offset - (offset % 16);
    const iv = Buffer.alloc(16);
    iv.writeBigUInt64BE(BigInt(aligned / 16), 8);
    const cipher = createCipheriv('aes-256-ctr', key, iv);
    const out = cipher.update(Buffer.alloc(length + (offset - aligned)));
    return out.subarray(offset - aligned);
  };

  it('downloads once, resumes, copies through the fleet, in bounded memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webcache-large-'));
    const whole = new ContentId();
    for (let at = 0; at < size; at += 8 * 1024 * 1024) {
      whole.update(bytesAt(at, Math.min(8 * 1024 * 1024, size - at)));
    }
    const blobId = whole.digest();

    // The cloud: streams the bytes, breaks off once at half the file.
    let requests = 0;
    const cloud = createServer((req, res) => {
      requests++;
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      const headers: Record<string, string> = {
        'content-length': String(size - start),
        etag: '"v1"',
      };
      if (start > 0) headers['content-range'] = `bytes ${start}-${size - 1}/${size}`;
      res.writeHead(start > 0 ? 206 : 200, headers);
      let at = start;
      const cutAt = requests === 1 ? Math.floor(size / 2) : size;
      const pump = () => {
        while (at < cutAt) {
          const length = Math.min(256 * 1024, cutAt - at);
          const ok = res.write(bytesAt(at, length));
          at += length;
          if (!ok) return void res.once('drain', pump);
        }
        if (cutAt < size) res.destroy();
        else res.end();
      };
      pump();
    });
    await new Promise<void>((r) => cloud.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}/big.zip`;

    // Peak memory, sampled.
    let peakRss = 0;
    let peakBuffers = 0;
    const sampler = setInterval(() => {
      const m = process.memoryUsage();
      peakRss = Math.max(peakRss, m.rss);
      peakBuffers = Math.max(peakBuffers, m.arrayBuffers);
    }, 50);

    const node = async (nodeId: string) => {
      const io = new IoMem();
      await io.init();
      await io.isReady();
      const bs = new BsFs(join(dir, nodeId));
      const webcache = await Webcache.open({
        io,
        bs,
        nodeId,
        allowedHosts: ['127.0.0.1'],
        sweepIntervalMs: 0,
        retryDelayMs: 10,
        claimSettleMs: 10,
        maintenance: bs,
      });
      return { webcache, bs, server: new PeerReadServer(io, bs) };
    };
    const a = await node('a');
    const b = await node('b');
    b.webcache.attach(
      new Fleet({
        nodeId: 'b',
        nodes: () => ['a'],
        blockTimeoutMs: 60_000,
        connect: async () => {
          const [serverSide, clientSide] = createSocketPair();
          serverSide.connect();
          clientSide.connect();
          await a.server.addSocket(serverSide);
          return clientSide;
        },
      }),
    );

    const drain = async (webcache: Webcache) => {
      const started = performance.now();
      const response = await webcache.fetch({ url, size });
      let bytes = 0;
      for await (const part of response.body()) bytes += part.length;
      const entry = await response.finished;
      return { source: response.source, bytes, entry, seconds: (performance.now() - started) / 1000 };
    };

    try {
      const fromCloud = await drain(a.webcache);
      const fromFleet = await drain(b.webcache);
      const usage = await a.bs.usage();
      const report = {
        megabytes,
        cloud: { seconds: fromCloud.seconds, requests, source: fromCloud.source },
        fleet: { seconds: fromFleet.seconds, source: fromFleet.source },
        peakRssMb: Math.round(peakRss / 1024 / 1024),
        peakArrayBuffersMb: Math.round(peakBuffers / 1024 / 1024),
        storeBytes: usage.bytes,
      };
      if (process.env.WEBCACHE_LARGE_REPORT) {
        writeFileSync(process.env.WEBCACHE_LARGE_REPORT, JSON.stringify(report, null, 2));
      }
      expect([fromCloud.source, fromFleet.source, requests]).toEqual(['cloud', 'fleet', 2]);
      expect([fromCloud.bytes, fromFleet.bytes]).toEqual([size, size]);
      expect([fromCloud.entry.blobId, fromFleet.entry.blobId]).toEqual([blobId, blobId]);
      // Memory stays at a few blocks, whatever the size.
      expect(peakBuffers).toBeLessThan(256 * 1024 * 1024);
    } finally {
      clearInterval(sampler);
      await a.webcache.close();
      await b.webcache.close();
      cloud.closeAllConnections();
      cloud.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 1_800_000);
});
