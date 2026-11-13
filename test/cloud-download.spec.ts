// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem, ContentId } from '@rljson/bs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CloudDownload, OriginFetch } from '../src/index.ts';

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
};

describe('CloudDownload', () => {
  // Random bytes: repeating data would collapse into a few equal blocks.
  const content = randomBytes(9 * 1024 * 1024 + 123);
  let server: Server;
  let url: string;
  let bs: BsMem;
  let requests: IncomingMessage[];
  let cloud: {
    cutAfter?: number;
    etag: string;
    noLength?: boolean;
    md5?: string;
    onResume?: 'ignore-range' | 'change' | number;
  };

  const serve = (req: IncomingMessage, res: ServerResponse) => {
    requests.push(req);
    const resuming = requests.length > 1;
    if (resuming && typeof cloud.onResume === 'number') {
      res.writeHead(cloud.onResume).end();
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const ignore = resuming && cloud.onResume !== undefined;
    const start = range && !ignore ? Number(range[1]) : 0;
    const etag = resuming && cloud.onResume === 'change' ? '"v2"' : cloud.etag;
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      etag,
    };
    if (!cloud.noLength) headers['content-length'] = String(content.length - start);
    if (cloud.md5 && start === 0) headers['x-ms-blob-content-md5'] = cloud.md5;
    if (start > 0) {
      headers['content-range'] = `bytes ${start}-${content.length - 1}/${content.length}`;
    }
    res.writeHead(start > 0 ? 206 : 200, headers);
    if (!resuming && cloud.cutAfter !== undefined) {
      res.write(content.subarray(0, cloud.cutAfter), () => res.destroy());
      return;
    }
    res.end(content.subarray(start));
  };

  const start = (options: Partial<Parameters<typeof CloudDownload.start>[0]> = {}) =>
    CloudDownload.start({
      bs,
      origin: new OriginFetch({ allowedHosts: ['127.0.0.1'] }),
      url,
      retryDelayMs: 1,
      ...options,
    });

  beforeEach(async () => {
    bs = new BsMem();
    requests = [];
    cloud = { etag: '"v1"' };
    server = createServer(serve);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/catalogue.zip`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  describe('start(options)', () => {
    it('stores the download as blocks and completes the fill', async () => {
      const download = await start({ expectedSize: content.length });
      expect([download.contentType, download.fill.expectedSize]).toEqual([
        'application/octet-stream',
        content.length,
      ]);
      const read = readAll(download.fill.stream());
      expect(await download.finished).toEqual({
        blobId: ContentId.of(content),
        size: content.length,
      });
      expect(await read).toEqual(content);
      expect(download.fill.blocks.length).toBeGreaterThan(2);
      expect((await bs.getBlob(ContentId.of(content))).content).toEqual(content);
    });

    it('takes the size from the cloud when none is expected', async () => {
      const download = await start({ retryDelayMs: undefined });
      expect(download.fill.expectedSize).toBe(content.length);
      await download.finished;
    });

    it('resumes after a broken connection at the last block boundary', async () => {
      cloud.cutAfter = 6 * 1024 * 1024;
      const download = await start({ expectedSize: content.length });
      expect(await download.finished).toEqual({
        blobId: ContentId.of(content),
        size: content.length,
      });
      expect(requests.length).toBe(2);
      const resumedAt = Number(/bytes=(\d+)-/.exec(requests[1].headers.range ?? '')?.[1]);
      expect(resumedAt).toBeGreaterThan(0);
      expect(resumedAt).toBeLessThanOrEqual(cloud.cutAfter);
      expect(requests[1].headers['if-range']).toBe('"v1"');
    });

    it('skips what it has when the cloud ignores the range but kept the content', async () => {
      cloud.cutAfter = 6 * 1024 * 1024;
      cloud.onResume = 'ignore-range';
      const download = await start();
      expect((await download.finished).blobId).toBe(ContentId.of(content));
    });

    it('fails when the content changed while resuming', async () => {
      cloud.cutAfter = 6 * 1024 * 1024;
      cloud.onResume = 'change';
      const download = await start();
      await expect(download.finished).rejects.toMatchObject({ reason: 'cloud-changed' });
      expect(download.fill.error?.message).toBe(
        `The content of ${url} changed while it downloaded`,
      );
    });

    it('fails without retrying when resuming is refused for good', async () => {
      cloud.cutAfter = 6 * 1024 * 1024;
      cloud.onResume = 403;
      const download = await start({ retries: 5 });
      await expect(download.finished).rejects.toMatchObject({ upstreamStatus: 403 });
      expect(requests.length).toBe(2);
    });

    it('gives up after its retries', async () => {
      cloud.cutAfter = 6 * 1024 * 1024;
      cloud.onResume = 503;
      const download = await start({ retries: 2 });
      await expect(download.finished).rejects.toMatchObject({ upstreamStatus: 503 });
      expect(requests.length).toBe(3);
    });

    it('refuses before downloading when the cloud names another size', async () => {
      await expect(start({ expectedSize: 5 })).rejects.toMatchObject({
        reason: 'size-mismatch',
        message: `${url} is ${content.length} bytes, not 5`,
      });
    });

    it('fails at the end when the bytes are not the expected size', async () => {
      cloud.noLength = true;
      const download = await start({ expectedSize: content.length + 1 });
      expect(download.fill.expectedSize).toBe(content.length + 1);
      await expect(download.finished).rejects.toMatchObject({
        reason: 'size-mismatch',
        message: `${url} arrived with ${content.length} bytes, not ${content.length + 1}`,
      });
      expect(await bs.blobExists(ContentId.of(content))).toBe(false);
    });

    it('checks the MD5 the cloud names', async () => {
      cloud.md5 = createHash('md5').update(content).digest('base64');
      expect((await (await start()).finished).size).toBe(content.length);

      cloud.md5 = createHash('md5').update('other').digest('base64');
      const download = await start();
      await expect(download.finished).rejects.toMatchObject({ reason: 'integrity' });
    });

    it('fails at once when the cloud refuses the download', async () => {
      cloud.onResume = 404;
      requests.push({} as IncomingMessage);
      await expect(start()).rejects.toMatchObject({ upstreamStatus: 404 });
    });
  });

  describe('abort()', () => {
    it('ends the download as unreachable', async () => {
      cloud.noLength = true;
      const download = await start({ retries: 5 });
      download.abort();
      await expect(download.finished).rejects.toMatchObject({
        reason: 'cloud-unreachable',
      });
      expect(requests.length).toBe(1);
    });
  });
});
