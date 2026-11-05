// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { randomBytes } from 'node:crypto';
import {
  createServer,
  IncomingMessage,
  request as httpRequest,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isLoopbackHost,
  readJsonBody,
  sendWebcacheError,
  sendWebcacheResponse,
  Webcache,
  WebcacheError,
  WebcacheHttpServer,
} from '../src/index.ts';

describe('WebcacheHttpServer', () => {
  const content = randomBytes(600_000);
  let origin: Server;
  let originUrl: string;
  let originStatus: number | undefined;
  let originTrickle: boolean;
  let originCut: boolean;
  let webcache: Webcache;
  let http: WebcacheHttpServer;
  let base: string;

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  /** A raw request, to send a Host header of one's own. */
  const raw = (options: { path: string; method?: string; host?: string }) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: http.port,
          path: options.path,
          method: options.method ?? 'GET',
          setHost: options.host === undefined,
          headers: options.host ? { host: options.host } : {},
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode as number, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  beforeEach(async () => {
    originStatus = undefined;
    originTrickle = false;
    originCut = false;
    origin = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (originStatus) {
        res.writeHead(originStatus).end();
        return;
      }
      if (req.url?.startsWith('/nolength')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(content);
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(content.length),
      });
      if (originCut) {
        // Breaks off after 300 kB, and refuses whatever comes next.
        originStatus = 403;
        res.write(content.subarray(0, 300_000), () => res.destroy());
        return;
      }
      if (!originTrickle) {
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
        res.write(content.subarray(at, (at += 16 * 1024)));
      }, 5);
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;

    const io = new IoMem();
    await io.init();
    await io.isReady();
    webcache = await Webcache.open({
      io,
      bs: new BsMem(),
      nodeId: 'node-a',
      allowedHosts: ['127.0.0.1'],
      sweepIntervalMs: 0,
      retryDelayMs: 1,
    });
    http = await WebcacheHttpServer.listen(webcache, { port: 0, version: '1.2.3' });
    base = `http://127.0.0.1:${http.port}`;
  });

  afterEach(async () => {
    await http.close();
    await webcache.close();
    origin.closeAllConnections();
    await new Promise((r) => origin.close(r));
  });

  describe('POST /fetch', () => {
    it('answers the content with its headers, first from the cloud, then locally', async () => {
      const first = await post('/fetch', { url: `${originUrl}/a.zip`, size: content.length });
      expect(first.status).toBe(200);
      expect(Object.fromEntries(first.headers)).toMatchObject({
        'content-type': 'application/zip',
        'content-length': String(content.length),
        'accept-ranges': 'bytes',
        'x-webcache-source': 'cloud',
      });
      expect(Buffer.from(await first.arrayBuffer())).toEqual(content);

      const second = await post('/fetch', { url: `${originUrl}/a.zip`, consumer: 'test' });
      expect(second.headers.get('x-webcache-source')).toBe('local');
      expect(second.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
      expect(Buffer.from(await second.arrayBuffer())).toEqual(content);
      await new Promise((r) => setTimeout(r, 20));
      const stats = webcache.stats.totals();
      expect(stats.all.requests).toBe(2);
      expect(stats.all.bytesServed).toBe(2 * content.length);
      expect(stats.byConsumer.test.requests).toBe(1);
    });

    it('answers a range', async () => {
      await (await post('/fetch', { url: `${originUrl}/a.zip` })).arrayBuffer();
      const cases: [string, number, string, number, number][] = [
        ['bytes=10-19', 206, `bytes 10-19/${content.length}`, 10, 20],
        ['bytes=599990-', 206, `bytes 599990-599999/${content.length}`, 599_990, 600_000],
        ['bytes=-5', 206, `bytes 599995-599999/${content.length}`, 599_995, 600_000],
        ['bytes=10-99999999', 206, `bytes 10-599999/${content.length}`, 10, 600_000],
      ];
      for (const [range, status, contentRange, start, end] of cases) {
        const response = await post('/fetch', { url: `${originUrl}/a.zip` }, { range });
        expect([response.status, response.headers.get('content-range')]).toEqual([
          status,
          contentRange,
        ]);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(content.subarray(start, end));
      }
    });

    it('refuses a range past the end, and ignores one it does not understand', async () => {
      await (await post('/fetch', { url: `${originUrl}/a.zip` })).arrayBuffer();
      const past = await post('/fetch', { url: `${originUrl}/a.zip` }, { range: 'bytes=700000-' });
      expect([past.status, past.headers.get('content-range')]).toEqual([
        416,
        `bytes */${content.length}`,
      ]);
      await past.arrayBuffer();
      for (const range of ['bytes=1-2,5-6', 'items=1-2', 'bytes=5-1']) {
        const response = await post('/fetch', { url: `${originUrl}/a.zip` }, { range });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
    });

    it('streams content of unknown size without ranges', async () => {
      const response = await post('/fetch', { url: `${originUrl}/nolength.png` }, { range: 'bytes=0-1' });
      expect([response.status, response.headers.get('content-length')]).toEqual([200, null]);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
    });

    it('answers errors as JSON with their reason', async () => {
      originStatus = 403;
      const refused = await post('/fetch', { url: `${originUrl}/a.zip` });
      expect(refused.status).toBe(502);
      expect(await refused.json()).toEqual({
        error: 'cloud-status',
        message: `The cloud answered 403 for ${originUrl}/a.zip`,
        upstreamStatus: 403,
      });

      const message = async (r: Response) => ((await r.json()) as { message: string }).message;
      const bad = await post('/fetch', '{ not json');
      expect([bad.status, await message(bad)]).toEqual([400, 'The request body is no JSON']);

      const noUrl = await post('/fetch', { size: 1 });
      expect(await message(noUrl)).toBe('The URL is missing');

      const big = await post('/fetch', JSON.stringify({ url: 'x'.repeat(70_000) }));
      expect([big.status, await message(big)]).toEqual([400, 'The request body is too large']);

      const notObject = await post('/fetch', '[1]');
      expect(await message(notObject)).toBe('The request body must be a JSON object');
    });

    it('sends what the requester was given to the cloud, never more', async () => {
      const response = await post('/fetch', {
        url: `${originUrl}/a.zip`,
        headers: { authorization: 'Bearer x' },
        key: 'graphic:a|1|2',
      });
      expect(response.headers.get('x-webcache-key-hash')).toBeTruthy();
      await response.arrayBuffer();
    });

    it('keeps downloading when the requester hangs up', async () => {
      originTrickle = true;
      const abort = new AbortController();
      const response = await post('/fetch', { url: `${originUrl}/a.zip` });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      abort.abort();
      await reader.cancel();
      const [entry] = await new Promise<Awaited<ReturnType<Webcache['entries']>>>((resolve) => {
        const poll = setInterval(async () => {
          const entries = await webcache.entries();
          if (entries.length > 0) {
            clearInterval(poll);
            resolve(entries);
          }
        }, 20);
      });
      expect(entry.size).toBe(content.length);
    });

    it('breaks off the answer when the content fails while it is sent', async () => {
      originCut = true;
      // Before or after the first bytes: the requester sees a broken answer.
      await expect(
        post('/fetch', { url: `${originUrl}/a.zip` }).then((r) => r.arrayBuffer()),
      ).rejects.toThrow();
      expect(await webcache.entries()).toEqual([]);
    });
  });

  describe('GET /_webcache/health', () => {
    it('says the webcache is up, and for which node', async () => {
      const response = await fetch(`${base}/_webcache/health`);
      expect(await response.json()).toEqual({
        ok: true,
        nodeId: 'node-a',
        version: '1.2.3',
        fleet: false,
      });
      expect((await fetch(`${base}/_webcache/health`, { method: 'HEAD' })).status).toBe(200);
    });
  });

  describe('other requests', () => {
    it('answer 404 for an unknown path and 405 for a wrong method', async () => {
      expect((await fetch(`${base}/nothing`)).status).toBe(404);
      expect((await fetch(`${base}/fetch`)).status).toBe(405);
      expect((await post('/_webcache/health', {})).status).toBe(405);
    });

    it('are refused when the Host is not this machine', async () => {
      expect(await raw({ path: '/_webcache/health', host: 'evil.example.com' })).toEqual({
        status: 421,
        body: JSON.stringify({
          error: 'misdirected',
          message: 'Only requests to this machine are answered',
        }),
      });
      expect((await raw({ path: '/_webcache/health', host: 'localhost:1' })).status).toBe(200);
    });

    it('go to the routes given first', async () => {
      await http.close();
      http = await WebcacheHttpServer.listen(webcache, {
        port: 0,
        routes: [
          async (req, res) => {
            if (req.url !== '/graphic') return false;
            res.writeHead(204).end();
            return true;
          },
        ],
      });
      base = `http://127.0.0.1:${http.port}`;
      expect((await fetch(`${base}/graphic`)).status).toBe(204);
      expect((await fetch(`${base}/_webcache/health`)).status).toBe(200);
    });

    it('answer 500 when a route fails', async () => {
      await http.close();
      http = await WebcacheHttpServer.listen(webcache, {
        port: 0,
        routes: [
          () => {
            throw new Error('boom');
          },
        ],
      });
      base = `http://127.0.0.1:${http.port}`;
      const response = await fetch(`${base}/x`);
      expect([response.status, await response.json()]).toEqual([
        500,
        { error: 'internal', message: 'boom' },
      ]);
    });
  });

  describe('listen(webcache, options)', () => {
    it('fails when the port is taken', async () => {
      await expect(WebcacheHttpServer.listen(webcache, { port: http.port })).rejects.toThrow(
        'EADDRINUSE',
      );
    });

    it('closes twice without harm', async () => {
      await http.close();
      await http.close();
      http = await WebcacheHttpServer.listen(webcache, { port: 0 });
    });
  });
});

describe('isLoopbackHost(host)', () => {
  it('accepts this machine only', () => {
    const cases: [string | undefined, boolean][] = [
      ['127.0.0.1:4802', true],
      ['127.1.2.3', true],
      ['localhost', true],
      ['LOCALHOST:4802', true],
      ['[::1]:4802', true],
      ['::1', true],
      [undefined, true],
      ['192.168.1.5:4802', false],
      ['evil.example.com', false],
      ['localhost.evil.example.com', false],
    ];
    for (const [host, loopback] of cases) expect([host, isLoopbackHost(host)]).toEqual([host, loopback]);
  });
});

describe('readJsonBody(req, maxBytes) and the senders', () => {
  it('are what a route of its own builds on', async () => {
    let server: Server | undefined;
    try {
      server = createServer(async (req, res) => {
        try {
          const body = (await readJsonBody(req)) as { fail?: boolean };
          if (body.fail) throw new WebcacheError('not-found', 'Nothing here');
          throw 'not an error';
        } catch (error) {
          sendWebcacheError(res, error);
        }
      });
      await new Promise<void>((r) => (server as Server).listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`;
      const notFound = await fetch(url, { method: 'POST', body: '{"fail":true}' });
      expect([notFound.status, await notFound.json()]).toEqual([
        404,
        { error: 'not-found', message: 'Nothing here' },
      ]);
      const odd = await fetch(url, { method: 'POST', body: '{}' });
      expect([odd.status, await odd.json()]).toEqual([
        500,
        { error: 'internal', message: 'not an error' },
      ]);
    } finally {
      server?.closeAllConnections();
      await new Promise((r) => server?.close(r));
    }
  });

  it('send headers only for HEAD, and a neutral type when none is known', async () => {
    let served = -1;
    const server = createServer((req, res) => {
      void sendWebcacheResponse(req, res, {
        source: 'local',
        key: 'k',
        keyHash: 'h',
        size: 3,
        contentType: '',
        body: () => new Blob(['abc']).stream(),
        finished: new Promise(() => undefined),
        served: (bytes) => (served = bytes),
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const head = await fetch(url, { method: 'HEAD' });
      expect([head.status, head.headers.get('content-type'), head.headers.get('content-length')]).toEqual([
        200,
        'application/octet-stream',
        '3',
      ]);
      const get = await fetch(url);
      expect(await get.text()).toBe('abc');
      await new Promise((r) => setTimeout(r, 20));
      expect(served).toBe(3);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
