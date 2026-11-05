// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/** Greets whoever asks. */
export class Webcache {
  /**
   * Creates a greeter.
   * @param greeting - The word to greet with.
   */
  constructor(public readonly greeting: string = 'Hello') {}

  /**
   * A realistic instance; tests pass only what they care about.
   * @param options - The values to change.
   */
  static example(options: Partial<{ greeting: string }> = {}): Webcache {
    return new Webcache(options.greeting ?? 'Hello');
  }

  /**
   * Greets someone.
   * @param name - Who to greet.
   */
  greet(name: string): string {
    return `${this.greeting}, ${name}!`;
  }
}
