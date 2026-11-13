// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createHash } from 'node:crypto';
import {
  createServer,
  IncomingMessage,
  request as httpRequest,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OriginFetch, WebcacheError } from '../src/index.ts';

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
};

describe('OriginFetch', () => {
  const content = Buffer.from('0123456789abcdefghij');
  let server: Server;
  let base: string;
  let behaviour: {
    status?: number;
    stallAfter?: number;
    md5?: boolean;
    noLength?: boolean;
    ignoreRange?: boolean;
  };
  let seen: IncomingMessage[];

  const serve = (req: IncomingMessage, res: ServerResponse) => {
    seen.push(req);
    if (behaviour.status) {
      res.writeHead(behaviour.status).end('nope');
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = range && !behaviour.ignoreRange ? Number(range[1]) : 0;
    const headers: Record<string, string> = {
      'content-type': 'application/zip',
      etag: '"v1"',
    };
    if (!behaviour.noLength) {
      headers['content-length'] = String(content.length - start);
    }
    if (behaviour.md5) {
      headers['x-ms-blob-content-md5'] = createHash('md5')
        .update(content)
        .digest('base64');
    }
    if (start > 0) {
      headers['content-range'] = `bytes ${start}-${content.length - 1}/${content.length}`;
    }
    res.writeHead(start > 0 ? 206 : 200, headers);
    if (behaviour.stallAfter !== undefined) {
      res.write(content.subarray(start, start + behaviour.stallAfter));
      return;
    }
    res.end(content.subarray(start));
  };

  const origin = (options: Partial<ConstructorParameters<typeof OriginFetch>[0]> = {}) =>
    new OriginFetch({ allowedHosts: ['127.0.0.1'], ...options });

  beforeEach(async () => {
    behaviour = {};
    seen = [];
    server = createServer(serve);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  describe('isAllowed(url)', () => {
    it('matches hosts exactly or by a wildcard for subdomains', () => {
      const o = new OriginFetch({
        allowedHosts: ['store.example.com', '*.blob.example.net'],
      });
      const cases: [string, boolean][] = [
        ['https://store.example.com/a', true],
        ['https://STORE.example.com:8443/a', true],
        ['https://other.example.com/a', false],
        ['https://acc.blob.example.net/a', true],
        ['https://blob.example.net/a', false],
        ['not a url', false],
      ];
      for (const [url, allowed] of cases) {
        expect(o.isAllowed(url)).toBe(allowed);
      }
    });
  });

  describe('open(url, options)', () => {
    it('opens a download with its size, type, validator and body', async () => {
      const response = await origin().open(`${base}/a.zip`);
      expect({ ...response, body: undefined }).toEqual({
        status: 200,
        start: 0,
        total: content.length,
        contentType: 'application/zip',
        validator: '"v1"',
        md5: undefined,
        body: undefined,
      });
      expect(await readAll(response.body)).toEqual(content);
      expect(seen[0].headers['accept-encoding']).toBe('identity');
      expect(seen[0].headers['user-agent']).toBe('rljson-webcache');
    });

    it('names the MD5 the cloud gives for the whole content', async () => {
      behaviour.md5 = true;
      const response = await origin().open(`${base}/a.zip`);
      expect(response.md5).toBe(createHash('md5').update(content).digest('base64'));
      await response.body.cancel();
    });

    it('resumes from a byte, sending the validator', async () => {
      const response = await origin().open(`${base}/a.zip`, {
        start: 12,
        validator: '"v1"',
      });
      expect([response.status, response.start, response.total]).toEqual([206, 12, 20]);
      expect((await readAll(response.body)).toString()).toBe('cdefghij');
      expect(seen[0].headers.range).toBe('bytes=12-');
      expect(seen[0].headers['if-range']).toBe('"v1"');
    });

    it('answers a total of -1 when the cloud names no length', async () => {
      behaviour.noLength = true;
      const response = await origin().open(`${base}/a.zip`);
      expect(response.total).toBe(-1);
      await response.body.cancel();
    });

    it('forwards the given headers', async () => {
      const response = await origin().open(`${base}/a.zip`, {
        headers: { authorization: 'Bearer t' },
      });
      await response.body.cancel();
      expect(seen[0].headers.authorization).toBe('Bearer t');
    });

    it('refuses a host that is not allowed', async () => {
      await expect(
        origin({ allowedHosts: ['example.com'] }).open(`${base}/a.zip`),
      ).rejects.toMatchObject({ reason: 'host-not-allowed', status: 403 });
      expect(seen).toEqual([]);
    });

    it('fails with the cloud status for anything but 200 and 206', async () => {
      behaviour.status = 403;
      const error = await origin()
        .open(`${base}/a.zip`)
        .catch((e: WebcacheError) => e);
      expect(error).toMatchObject({ reason: 'cloud-status', upstreamStatus: 403 });
      expect((error as Error).message).toBe(`The cloud answered 403 for ${base}/a.zip`);
    });

    it('fails as unreachable when nothing listens', async () => {
      const port = (server.address() as AddressInfo).port;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      server = createServer(serve).listen(0, '127.0.0.1');
      await expect(
        origin().open(`http://127.0.0.1:${port}/a.zip`),
      ).rejects.toMatchObject({ reason: 'cloud-unreachable' });
    });

    it('fails with a timeout when the answer takes too long', async () => {
      server.removeAllListeners('request');
      server.on('request', () => undefined);
      await expect(
        origin({ timeoutMs: 50 }).open(`${base}/a.zip`),
      ).rejects.toMatchObject({ reason: 'cloud-timeout' });
    });

    it('gives up when the caller aborts', async () => {
      server.removeAllListeners('request');
      server.on('request', () => undefined);
      const abort = new AbortController();
      const opening = origin().open(`${base}/a.zip`, { signal: abort.signal });
      abort.abort();
      await expect(opening).rejects.toMatchObject({ reason: 'cloud-unreachable' });
    });

    it('fails the body when it stalls longer than allowed', async () => {
      behaviour.stallAfter = 5;
      const response = await origin({ idleMs: 50 }).open(`${base}/a.zip`);
      await expect(readAll(response.body)).rejects.toMatchObject({
        reason: 'cloud-timeout',
      });
    });

    it('fails the body as unreachable when the connection breaks', async () => {
      behaviour.stallAfter = 5;
      const response = await origin().open(`${base}/a.zip`);
      const reading = readAll(response.body);
      await new Promise((r) => setTimeout(r, 20));
      server.closeAllConnections();
      await expect(reading).rejects.toMatchObject({ reason: 'cloud-unreachable' });
    });
  });

  describe('with headers of other clouds', () => {
    const answering =
      (status: number, headers: Record<string, string>) =>
      async (_url: string, init: { headers: Record<string, string> }) => {
        answered.push(init.headers);
        return new Response('abc', { status, headers });
      };
    let answered: Record<string, string>[];

    beforeEach(() => {
      answered = [];
    });

    it('takes Last-Modified as validator and Content-MD5 as checksum', async () => {
      const response = await origin({
        fetch: answering(200, {
          'last-modified': 'Wed, 04 Nov 2026 16:01:32 GMT',
          'content-md5': 'kAFQmDzST7DWlj99KOF/cg==',
        }),
      }).open('http://127.0.0.1/a');
      expect([response.validator, response.md5, response.contentType]).toEqual([
        'Wed, 04 Nov 2026 16:01:32 GMT',
        'kAFQmDzST7DWlj99KOF/cg==',
        'text/plain;charset=UTF-8',
      ]);
    });

    it('answers neither when the cloud names none', async () => {
      const response = await origin({ fetch: answering(200, {}) }).open(
        'http://127.0.0.1/a',
      );
      expect([response.validator, response.md5]).toEqual([undefined, undefined]);
    });

    it('answers an empty content type when the cloud names none', async () => {
      const response = await origin({
        fetch: async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
      }).open('http://127.0.0.1/a');
      expect(response.contentType).toBe('');
    });

    it('resumes without If-Range when there is no validator', async () => {
      await origin({ fetch: answering(206, {}) }).open('http://127.0.0.1/a', {
        start: 3,
      });
      expect(answered[0].range).toBe('bytes=3-');
      expect(answered[0]['if-range']).toBeUndefined();
    });

    it('takes a part without Content-Range as starting at 0', async () => {
      const response = await origin({ fetch: answering(206, {}) }).open(
        'http://127.0.0.1/a',
        { start: 3 },
      );
      expect([response.start, response.total]).toEqual([0, -1]);
    });

    it('reports what was thrown when it was no error', async () => {
      await expect(
        origin({
          fetch: async () => {
            throw 'socket hang up';
          },
        }).open('http://127.0.0.1/a'),
      ).rejects.toThrow('The cloud is unreachable for http://127.0.0.1/a: socket hang up');
    });
  });

  describe('with a proxy', () => {
    it('goes through the proxy', async () => {
      // A plain-http URL is handed to the proxy whole, as an HTTP proxy
      // expects it; an https URL goes through a CONNECT tunnel instead, which
      // needs a TLS origin this test does not have.
      const forwarded: string[] = [];
      const proxy = createServer((req, res) => {
        forwarded.push(`${req.method} ${req.url}`);
        const upstream = httpRequest(
          req.url as string,
          { method: req.method, headers: req.headers },
          (answer) => {
            res.writeHead(answer.statusCode as number, answer.headers);
            answer.pipe(res);
          },
        );
        req.pipe(upstream);
      });
      await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      try {
        const response = await origin({ proxy: proxyUrl }).open(`${base}/a.zip`);
        expect(await readAll(response.body)).toEqual(content);
        expect(forwarded).toEqual([`GET ${base}/a.zip`]);
      } finally {
        proxy.closeAllConnections();
        await new Promise((r) => proxy.close(r));
      }
    });
  });

  describe('example()', () => {
    it('allows the example host', () => {
      expect(OriginFetch.example().isAllowed('https://downloads.example.com/a')).toBe(true);
    });
  });
});
