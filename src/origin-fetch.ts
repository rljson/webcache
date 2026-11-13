// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { WebcacheError } from './webcache-error.ts';
import { redactUrl } from './webcache-key.ts';

// #############################################################################
/** The part of `fetch` a download needs. */
export type FetchLike = (
  url: string,
  init: {
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'follow';
  },
) => Promise<Response>;

// #############################################################################
/** Options of {@link OriginFetch}. */
export interface OriginFetchOptions {
  /**
   * The hosts it may download from: `host`, or `*.domain` for every
   * subdomain. Anything else is refused, so the webcache never becomes an
   * open proxy.
   */
  allowedHosts: readonly string[];

  /** The fetch to use; the platform's when omitted. */
  fetch?: FetchLike;

  /** An HTTP proxy to reach the cloud through, e.g. `http://proxy:3128`. */
  proxy?: string;

  /** Longest the cloud may take to answer a request. Default 30 000 ms. */
  timeoutMs?: number;

  /** Longest a download may go without a byte. Default 60 000 ms. */
  idleMs?: number;

  /** The user agent sent. Default `rljson-webcache`. */
  userAgent?: string;
}

// #############################################################################
/** An open download. */
export interface OriginResponse {
  /** 200 for the whole content, 206 for the rest of it. */
  status: number;

  /** The byte the body starts with. */
  start: number;

  /** The size of the whole content, -1 when the cloud does not say. */
  total: number;

  /** The content type, empty when the cloud does not say. */
  contentType: string;

  /** The ETag, else the Last-Modified date: what resuming sends back. */
  validator?: string;

  /** The base64 MD5 of the whole content, when the cloud names it. */
  md5?: string;

  /** The bytes. */
  body: ReadableStream<Uint8Array>;
}

// #############################################################################
/**
 * Opens downloads from the cloud: only from allowed hosts, uncompressed,
 * resumable, and bounded in time.
 */
export class OriginFetch {
  private readonly _fetch: FetchLike;
  private readonly _timeoutMs: number;
  private readonly _idleMs: number;

  // ...........................................................................
  /**
   * Creates the fetcher.
   * @param _options - Allowed hosts, proxy, bounds.
   */
  constructor(private readonly _options: OriginFetchOptions) {
    this._timeoutMs = _options.timeoutMs ?? 30_000;
    this._idleMs = _options.idleMs ?? 60_000;
    if (_options.proxy) {
      const dispatcher = new ProxyAgent(_options.proxy);
      this._fetch = (url, init) =>
        undiciFetch(url, { ...init, dispatcher }) as unknown as Promise<Response>;
    } else {
      this._fetch = _options.fetch ?? ((url, init) => fetch(url, init));
    }
  }

  // ...........................................................................
  /**
   * A fetcher allowing `downloads.example.com`, for tests and docs.
   * @returns The fetcher.
   */
  static example(): OriginFetch {
    return new OriginFetch({ allowedHosts: ['downloads.example.com'] });
  }

  // ...........................................................................
  /**
   * Whether a URL's host is allowed.
   * @param url - The URL.
   * @returns True when allowed.
   */
  isAllowed(url: string): boolean {
    if (!URL.canParse(url)) return false;
    const host = new URL(url).hostname.toLowerCase();
    return this._options.allowedHosts.some((pattern) => {
      const p = pattern.toLowerCase();
      return p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p;
    });
  }

  // ...........................................................................
  /**
   * Opens a download, or the rest of one.
   * @param url - The URL.
   * @param options - Where to start, what to send.
   * @param options.start - The first byte; 0 when omitted.
   * @param options.validator - The ETag or date the first part came with.
   * @param options.headers - Headers to send along, e.g. an authorization.
   * @param options.signal - Aborts the download.
   * @returns The download.
   */
  async open(
    url: string,
    options: {
      start?: number;
      validator?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<OriginResponse> {
    const shown = redactUrl(url);
    if (!this.isAllowed(url)) {
      throw new WebcacheError('host-not-allowed', `Downloads from ${shown} are not allowed`);
    }
    const start = options.start ?? 0;
    const headers: Record<string, string> = {
      ...options.headers,
      'accept-encoding': 'identity',
      'user-agent': this._options.userAgent ?? 'rljson-webcache',
    };
    if (start > 0) {
      headers.range = `bytes=${start}-`;
      if (options.validator) headers['if-range'] = options.validator;
    }

    const abort = new AbortController();
    options.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    const timer = setTimeout(() => abort.abort(new _Timeout()), this._timeoutMs);
    let response: Response;
    try {
      response = await this._fetch(url, { headers, signal: abort.signal, redirect: 'follow' });
    } catch (error) {
      throw OriginFetch._failure(error, abort.signal, shown);
    } finally {
      clearTimeout(timer);
    }

    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel();
      throw new WebcacheError(
        'cloud-status',
        `The cloud answered ${response.status} for ${shown}`,
        response.status,
      );
    }

    const contentRange = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    const first = /^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '');
    const length = response.headers.get('content-length');
    const partial = response.status === 206;
    return {
      status: response.status,
      start: partial && first ? Number(first[1]) : 0,
      total: contentRange
        ? Number(contentRange[1])
        : length !== null && !partial
          ? Number(length)
          : -1,
      contentType: response.headers.get('content-type') ?? '',
      validator:
        response.headers.get('etag') ?? response.headers.get('last-modified') ?? undefined,
      md5: partial
        ? undefined
        : (response.headers.get('x-ms-blob-content-md5') ??
          response.headers.get('content-md5') ??
          undefined),
      body: this._watched(response.body as ReadableStream<Uint8Array>, abort, shown),
    };
  }

  // ...........................................................................
  /**
   * A body that fails when no byte arrives for too long, and that turns
   * network errors into webcache errors.
   * @param body - The body.
   * @param abort - Aborts the request.
   * @param shown - The URL as it may be shown.
   * @returns The watched body.
   */
  private _watched(
    body: ReadableStream<Uint8Array>,
    abort: AbortController,
    shown: string,
  ): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const timer = setTimeout(() => abort.abort(new _Timeout()), this._idleMs);
        try {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          throw OriginFetch._failure(error, abort.signal, shown);
        } finally {
          clearTimeout(timer);
        }
      },
      cancel: async (reason) => {
        await reader.cancel(reason);
      },
    });
  }

  // ...........................................................................
  /**
   * The webcache error for a failed request or body.
   * @param error - What was thrown.
   * @param signal - The request's signal.
   * @param shown - The URL as it may be shown.
   * @returns The error.
   */
  private static _failure(error: unknown, signal: AbortSignal, shown: string): WebcacheError {
    if (signal.reason instanceof _Timeout) {
      return new WebcacheError('cloud-timeout', `The cloud took too long for ${shown}`);
    }
    const cause = error instanceof Error ? error.message : String(error);
    return new WebcacheError('cloud-unreachable', `The cloud is unreachable for ${shown}: ${cause}`);
  }
}

// .............................................................................
/** The reason a request was aborted by its own timer. */
class _Timeout extends Error {}
