// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// #############################################################################
/** Why a request could not be answered. */
export type WebcacheErrorReason =
  | 'bad-request'
  | 'host-not-allowed'
  | 'not-found'
  | 'cloud-status'
  | 'cloud-unreachable'
  | 'cloud-timeout'
  | 'cloud-changed'
  | 'size-mismatch'
  | 'integrity'
  | 'wait-timeout'
  | 'not-ready'
  | 'closed';

// .............................................................................
/** The HTTP status that answers each reason. */
const _status: Record<WebcacheErrorReason, number> = {
  'bad-request': 400,
  'host-not-allowed': 403,
  'not-found': 404,
  'cloud-status': 502,
  'cloud-unreachable': 502,
  'cloud-timeout': 504,
  'cloud-changed': 502,
  'size-mismatch': 502,
  integrity: 502,
  'wait-timeout': 504,
  'not-ready': 503,
  closed: 503,
};

// #############################################################################
/**
 * A request the webcache could not answer, with the reason and the HTTP
 * status that says so.
 */
export class WebcacheError extends Error {
  /** The HTTP status for the reason. */
  readonly status: number;

  // ...........................................................................
  /**
   * Creates the error.
   * @param reason - Why.
   * @param message - What happened, for logs and people.
   * @param upstreamStatus - The cloud's own status, when it answered.
   */
  constructor(
    readonly reason: WebcacheErrorReason,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'WebcacheError';
    this.status = _status[reason];
  }

  // ...........................................................................
  /**
   * An example, for tests and docs.
   * @returns A cloud that answered 404.
   */
  static example(): WebcacheError {
    return new WebcacheError('cloud-status', 'The cloud answered 404', 404);
  }

  // ...........................................................................
  /**
   * Whether trying again may help: the cloud was unreachable, slow, or
   * answered with a server error.
   * @param error - Anything thrown.
   * @returns True to retry.
   */
  static isTransient(error: unknown): boolean {
    if (!(error instanceof WebcacheError)) return true;
    if (error.reason === 'cloud-status') {
      return (error.upstreamStatus as number) >= 500;
    }
    return error.reason === 'cloud-unreachable' || error.reason === 'cloud-timeout';
  }
}
