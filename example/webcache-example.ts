// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { Webcache } from '../src/index.ts';

/**
 * Downloads a file through a webcache twice: the first answer comes from the
 * cloud, the second from the webcache's own store.
 * @returns What it printed.
 */
export const runExample = async (): Promise<string[]> => {
  const printed: string[] = [];

  // A cloud to download from
  const cloud = createServer((_req, res) => res.end('catalogue bytes'));
  await new Promise<void>((resolve) => cloud.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}/catalogue.zip`;

  // A webcache over in-memory stores
  const io = new IoMem();
  await io.init();
  const webcache = await Webcache.open({
    io,
    bs: new BsMem(),
    nodeId: 'my-node',
    allowedHosts: ['127.0.0.1'],
  });

  for (let i = 0; i < 2; i++) {
    const response = await webcache.fetch({ url });
    const text = await new Response(response.body()).text();
    printed.push(`${response.source}: ${text}`);
    await response.finished;
  }

  await webcache.close();
  cloud.close();
  return printed;
};
