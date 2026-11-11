// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { Webcache, WebcacheRequest, WebcacheResponse } from './webcache.ts';
import { WebcacheError } from './webcache-error.ts';

// #############################################################################
/**
 * A route of one's own, asked before the built-in ones.
 * @param req - The request.
 * @param res - The response.
 * @returns True when it answered the request.
 */
export type WebcacheHttpRoute = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean> | boolean;

// #############################################################################
/** Options of {@link WebcacheHttpServer.listen}. */
export interface WebcacheHttpOptions {
  /** The port; 0 picks a free one. */
  port: number;

  /** The address to bind to. Default 127.0.0.1: this machine only. */
  host?: string;

  /** Routes of one's own, asked first. */
  routes?: WebcacheHttpRoute[];

  /** The version the health check names. */
  version?: string;

  /**
   * Answer `POST /fetch` only with complete content: `202` with an empty
   * body when the content is not complete after this long, while it keeps
   * coming; the requester asks again with the same body. When omitted, the
   * content is sent as it arrives.
   */
  pendingAfterMs?: number;
}

// .............................................................................
/** The largest request body read. */
const _MAX_BODY_BYTES = 64 * 1024;

// .............................................................................
/**
 * Whether a Host header names this machine. A request naming another host
 * reached this port through a rebound DNS name and is refused.
 * @param host - The Host header; a request without one is let through.
 * @returns True for this machine.
 */
export const isLoopbackHost = (host: string | undefined): boolean => {
  if (host === undefined) return true;
  const name = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.includes(':') && host.indexOf(':') === host.lastIndexOf(':')
      ? host.slice(0, host.indexOf(':'))
      : host;
  const lower = name.toLowerCase();
  return lower === 'localhost' || lower === '::1' || /^127\.\d+\.\d+\.\d+$/.test(lower);
};

// .............................................................................
/**
 * Reads a request's body as JSON.
 * @param req - The request.
 * @param maxBytes - The largest body accepted.
 * @returns The parsed body.
 */
export const readJsonBody = async (
  req: IncomingMessage,
  maxBytes: number = _MAX_BODY_BYTES,
): Promise<unknown> => {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of req as AsyncIterable<Buffer>) {
    length += part.length;
    if (length > maxBytes) throw new WebcacheError('bad-request', 'The request body is too large');
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new WebcacheError('bad-request', 'The request body is no JSON');
  }
};

// .............................................................................
/**
 * Sends an error as JSON with the status its reason calls for.
 * @param res - The response.
 * @param error - Anything thrown.
 */
export const sendWebcacheError = (res: ServerResponse, error: unknown): void => {
  const body =
    error instanceof WebcacheError
      ? {
          error: error.reason,
          message: error.message,
          ...(error.upstreamStatus === undefined ? {} : { upstreamStatus: error.upstreamStatus }),
        }
      : { error: 'internal', message: error instanceof Error ? error.message : String(error) };
  _sendJson(res, error instanceof WebcacheError ? error.status : 500, body);
};

// .............................................................................
/**
 * Sends an answer of the webcache: its headers, then its bytes as they
 * arrive. Honours a single `Range` when the size is known. A requester that
 * hangs up stops only its own stream, never the download behind it.
 * @param req - The request.
 * @param res - The response.
 * @param response - The answer.
 * @returns Resolves once the response ended.
 */
export const sendWebcacheResponse = (
  req: IncomingMessage,
  res: ServerResponse,
  response: WebcacheResponse,
): Promise<void> => {
  const headers: Record<string, string> = {
    'content-type': response.contentType || 'application/octet-stream',
    'x-webcache-source': response.source,
    'x-webcache-key-hash': response.keyHash,
  };
  if (response.blobId) headers.etag = `"${response.blobId}"`;
  let status = 200;
  let range: { start: number; end?: number } | undefined;
  if (response.size >= 0) {
    headers['accept-ranges'] = 'bytes';
    const asked = _range(req.headers.range, response.size);
    if (asked === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${response.size}` }).end();
      return Promise.resolve();
    }
    range = asked;
    const start = range?.start ?? 0;
    const end = range?.end ?? response.size;
    if (range) {
      status = 206;
      headers['content-range'] = `bytes ${start}-${end - 1}/${response.size}`;
    }
    headers['content-length'] = String(end - start);
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return Promise.resolve();
  }

  const body = Readable.fromWeb(response.body(range) as never);
  let sent = 0;
  body.on('data', (chunk: Buffer) => (sent += chunk.length));
  return new Promise<void>((resolve) => {
    const done = () => {
      response.served(sent);
      resolve();
    };
    res.on('close', () => {
      // The requester hung up: stop reading for it; the download goes on.
      // Destroying a stream that ended or broke already does nothing.
      body.destroy();
      done();
    });
    body.on('error', (error) => res.destroy(error));
    body.pipe(res);
  });
};

// .............................................................................
/**
 * The range a `Range` header asks for.
 * @param header - The header.
 * @param size - The size of the content.
 * @returns The range; undefined for the whole content, or a header that is
 * not one single byte range; 'unsatisfiable' for a range past the end.
 */
const _range = (
  header: string | undefined,
  size: number,
): { start: number; end: number } | undefined | 'unsatisfiable' => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  if (match[1] === '') {
    const suffix = Math.min(Number(match[2]), size);
    return { start: size - suffix, end: size };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size : Math.min(Number(match[2]) + 1, size);
  if (start >= size) return 'unsatisfiable';
  if (end <= start) return undefined;
  return { start, end };
};

// .............................................................................
/**
 * Sends JSON.
 * @param res - The response.
 * @param status - The status.
 * @param body - The body.
 */
const _sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
};

// #############################################################################
/**
 * The webcache over HTTP, for the programs of this machine:
 *
 * - `POST /fetch` with `{ url, key?, size?, consumer?, headers? }` answers the
 *   content — from this node, the fleet or the cloud; with `pendingAfterMs`,
 *   only complete content, else `202` to ask again
 * - `GET /_webcache/health` says whether the webcache is up
 *
 * It listens on 127.0.0.1 and refuses requests naming another host, so no
 * other machine and no web page can use it.
 */
export class WebcacheHttpServer {
  private _closing?: Promise<void>;

  // ...........................................................................
  /**
   * Use {@link WebcacheHttpServer.listen}.
   * @param _server - The HTTP server.
   */
  private constructor(private readonly _server: Server) {}

  // ...........................................................................
  /**
   * Starts listening.
   * @param webcache - The webcache to serve.
   * @param options - Port, address, own routes.
   * @returns The listening server.
   */
  static async listen(webcache: Webcache, options: WebcacheHttpOptions): Promise<WebcacheHttpServer> {
    const server = createServer((req, res) => void WebcacheHttpServer._handle(webcache, options, req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return new WebcacheHttpServer(server);
  }

  // ...........................................................................
  /** The port it listens on. */
  get port(): number {
    return (this._server.address() as AddressInfo).port;
  }

  // ...........................................................................
  /** Stops listening and ends every open connection. */
  close(): Promise<void> {
    this._closing ??= new Promise<void>((resolve) => {
      this._server.close(() => resolve());
      this._server.closeAllConnections();
    });
    return this._closing;
  }

  // ...........................................................................
  /**
   * Answers one request.
   * @param webcache - The webcache.
   * @param options - The server's options.
   * @param req - The request.
   * @param res - The response.
   */
  private static async _handle(
    webcache: Webcache,
    options: WebcacheHttpOptions,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (!isLoopbackHost(req.headers.host)) {
        _sendJson(res, 421, {
          error: 'misdirected',
          message: 'Only requests to this machine are answered',
        });
        return;
      }
      for (const route of options.routes ?? []) {
        if (await route(req, res)) return;
      }
      const path = (req.url as string).split('?')[0];
      if (path === '/fetch') {
        if (req.method !== 'POST') return _sendJson(res, 405, { error: 'method-not-allowed' });
        const body = await readJsonBody(req);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new WebcacheError('bad-request', 'The request body must be a JSON object');
        }
        const request = body as WebcacheRequest;
        if (options.pendingAfterMs === undefined) {
          await sendWebcacheResponse(req, res, await webcache.fetch(request));
          return;
        }
        const answer = await webcache.poll(request, options.pendingAfterMs);
        if (answer.state === 'pending') {
          res.writeHead(202, { 'content-length': '0' }).end();
          return;
        }
        await sendWebcacheResponse(req, res, answer.response);
        return;
      }
      if (path === '/_webcache/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return _sendJson(res, 405, { error: 'method-not-allowed' });
        }
        return _sendJson(res, 200, {
          ok: true,
          nodeId: (await webcache.summary()).nodeId,
          version: options.version,
          fleet: webcache.fleet !== undefined,
        });
      }
      _sendJson(res, 404, { error: 'not-found' });
    } catch (error) {
      sendWebcacheError(res, error);
    }
  }
}
