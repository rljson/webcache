// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, ContentId, forEachBlock } from '@rljson/bs';
import { createHash, Hash } from 'node:crypto';

import { BlobFill } from './blob-fill.ts';
import { OriginFetch, OriginResponse } from './origin-fetch.ts';
import { WebcacheError } from './webcache-error.ts';
import { redactUrl } from './webcache-key.ts';

// #############################################################################
/** Options of {@link CloudDownload.start}. */
export interface CloudDownloadOptions {
  /** The store the blocks go to. */
  bs: Bs;

  /** Opens the requests. */
  origin: OriginFetch;

  /** What to download. */
  url: string;

  /** The size the content must have; unchecked when omitted or -1. */
  expectedSize?: number;

  /** Headers to send along, e.g. an authorization. */
  headers?: Record<string, string>;

  /** How often a broken download is resumed. Default 3. */
  retries?: number;

  /** The wait before the first retry; it doubles with each. Default 1000 ms. */
  retryDelayMs?: number;
}

// #############################################################################
/**
 * A download from the cloud into a store, block by block, read while it runs.
 *
 * The body is cut into content-defined blocks as it arrives; each is stored
 * and appended to {@link fill}. A connection that breaks is resumed from the
 * last block boundary — the blocks cut after it come out the same as without
 * the break. The blob is stored only when its size and the MD5 the cloud names
 * are right.
 */
export class CloudDownload {
  private readonly _abort = new AbortController();
  private readonly _whole = new ContentId();
  private readonly _md5?: Hash;
  private readonly _expectedMd5?: string;

  // ...........................................................................
  /**
   * Use {@link CloudDownload.start}.
   * @param _options - What to download.
   * @param fill - Where it goes.
   * @param contentType - What the cloud said it is.
   * @param _validator - The ETag or date of the first response.
   * @param md5 - The MD5 the cloud named.
   */
  private constructor(
    private readonly _options: CloudDownloadOptions,
    readonly fill: BlobFill,
    readonly contentType: string,
    private readonly _validator: string | undefined,
    md5: string | undefined,
  ) {
    if (md5) this._md5 = createHash('md5');
    this._expectedMd5 = md5;
  }

  /** Resolves with the stored blob; rejects when the download failed. */
  finished!: Promise<{ blobId: string; size: number }>;

  // ...........................................................................
  /**
   * Opens a download and runs it in the background. Fails at once when the
   * cloud refuses it or names another size than expected.
   * @param options - What to download.
   * @returns The running download.
   */
  static async start(options: CloudDownloadOptions): Promise<CloudDownload> {
    const abort = new AbortController();
    const first = await options.origin.open(options.url, {
      headers: options.headers,
      signal: abort.signal,
    });
    const expected = options.expectedSize ?? -1;
    if (expected >= 0 && first.total >= 0 && first.total !== expected) {
      await first.body.cancel();
      throw new WebcacheError(
        'size-mismatch',
        `${redactUrl(options.url)} is ${first.total} bytes, not ${expected}`,
      );
    }
    const download = new CloudDownload(
      options,
      new BlobFill(options.bs, expected >= 0 ? expected : first.total),
      first.contentType,
      first.validator,
      first.md5,
    );
    download._abort.signal.addEventListener('abort', () => abort.abort(), {
      once: true,
    });
    download.finished = download._run(first);
    download.finished.catch(() => undefined);
    return download;
  }

  // ...........................................................................
  /** Stops the download. */
  abort(): void {
    this._abort.abort();
  }

  // ...........................................................................
  /**
   * Feeds the first response and every resumed one into the fill.
   * @param first - The first response.
   * @returns The stored blob.
   */
  private async _run(first: OriginResponse): Promise<{ blobId: string; size: number }> {
    const retries = this._options.retries ?? 3;
    let delay = this._options.retryDelayMs ?? 1_000;
    let response: OriginResponse | undefined = first;
    let attempt = 0;
    try {
      for (;;) {
        try {
          response ??= await this._resume();
          await this._feed(response);
          break;
        } catch (error) {
          const stopped = this._abort.signal.aborted;
          if (stopped || !WebcacheError.isTransient(error) || attempt >= retries) throw error;
          attempt++;
          response = undefined;
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2;
        }
      }
      return await this._store();
    } catch (error) {
      this.fill.fail(error as Error);
      throw error;
    }
  }

  // ...........................................................................
  /**
   * Opens the rest of the download.
   * @returns The response, positioned at the first byte not stored yet.
   */
  private async _resume(): Promise<OriginResponse> {
    const response = await this._options.origin.open(this._options.url, {
      start: this.fill.bytes,
      validator: this._validator,
      headers: this._options.headers,
      signal: this._abort.signal,
    });
    if (response.start === this.fill.bytes) return response;
    // The cloud sent the whole content again: fine if it is the same content.
    if (response.validator === undefined || response.validator !== this._validator) {
      await response.body.cancel();
      throw new WebcacheError(
        'cloud-changed',
        `The content of ${redactUrl(this._options.url)} changed while it downloaded`,
      );
    }
    return { ...response, start: this.fill.bytes, body: _skip(response.body, this.fill.bytes) };
  }

  // ...........................................................................
  /**
   * Cuts a response into blocks, stores them and appends them to the fill.
   * Bytes after the last block are dropped when the response breaks off, and
   * downloaded again on resuming.
   * @param response - The response.
   */
  private async _feed(response: OriginResponse): Promise<void> {
    await forEachBlock(response.body, async (bytes) => {
      const block = await this._options.bs.setBlock(Buffer.from(bytes));
      this._whole.update(bytes);
      this._md5?.update(bytes);
      this.fill.append(block);
    });
  }

  // ...........................................................................
  /**
   * Checks size and checksum, stores the blob and completes the fill.
   * @returns The blob.
   */
  private async _store(): Promise<{ blobId: string; size: number }> {
    const shown = redactUrl(this._options.url);
    const expected = this.fill.expectedSize;
    if (expected >= 0 && this.fill.bytes !== expected) {
      throw new WebcacheError(
        'size-mismatch',
        `${shown} arrived with ${this.fill.bytes} bytes, not ${expected}`,
      );
    }
    if (this._md5 && this._md5.digest('base64') !== this._expectedMd5) {
      throw new WebcacheError('integrity', `${shown} does not match the MD5 the cloud names`);
    }
    const blobId = this._whole.digest();
    await this._options.bs.setBlobBlocks(blobId, [...this.fill.blocks]);
    this.fill.complete(blobId);
    return { blobId, size: this.fill.bytes };
  }
}

// .............................................................................
/**
 * A stream without its first bytes.
 * @param body - The stream.
 * @param count - How many bytes to drop.
 * @returns The rest.
 */
const _skip = (body: ReadableStream<Uint8Array>, count: number): ReadableStream<Uint8Array> => {
  let left = count;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        if (left >= chunk.length) {
          left -= chunk.length;
          return;
        }
        controller.enqueue(chunk.subarray(left));
        left = 0;
      },
    }),
  );
};
