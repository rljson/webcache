<!--
@license
Copyright (c) rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/webcache

English | [Deutsch](README.de.md)

[![CI](https://github.com/rljson/webcache/actions/workflows/quick_check.yaml/badge.svg)](https://github.com/rljson/webcache/actions/workflows/quick_check.yaml)
[![npm](https://img.shields.io/npm/v/@rljson/webcache.svg)](https://www.npmjs.com/package/@rljson/webcache)

The RLJSON webcache provides downloaded web content like media, images and
texts as a local requestable cache. Based on a blob store (rljson/bs), it
serves downloaded data through an rljson network (rljson/server,
rljson/network), so that other rljson clients can retrieve it from the fleet
first before downloading it on their own.

## Motivation

- Several machines of one network often download the same files from the
  same cloud: N downloads of every file, N times the traffic and the cost.
- A webcache answers each request from its own store, else from another
  machine of the network that holds the file, else from the cloud — and then
  holds the file for everybody else.
- Machines that ask for the same file at the same moment agree on one of them
  to download it; the others wait and copy it from there.
- When the cloud is unreachable, what the network holds is still served.

## Installation

```bash
pnpm add @rljson/webcache
```

## Usage

A webcache over in-memory stores, downloading one file twice:

```typescript
import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { Webcache } from '@rljson/webcache';

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
  console.log(`${response.source}: ${text}`);
  await response.finished;
}

await webcache.close();
cloud.close();
```

It prints:

```text
cloud: catalogue bytes
local: catalogue bytes
```

The same code is in [example/webcache-example.ts](example/webcache-example.ts).

To share the cache between machines, run a `WebcacheRoute` as a member of an
`@rljson/server` `Node`, serve the hub's route with `webcacheHubStores()`, and
let the programs of each machine ask `WebcacheHttpServer` — see
[README.public.md](README.public.md).

## Limitations

- A key never changes its content: a new version needs a new key (or URL).
  There is no revalidation against the cloud.
- It downloads only from the hosts it is given (`allowedHosts`), so it is no
  open proxy. The HTTP server answers this machine only.
- Machines of other networks or sites are not asked; only the nodes of the
  same network domain.
- Two machines that cannot see each other's claim — a split network — may
  both download a file.

## Documentation

- [README.public.md](README.public.md) — the API, the HTTP endpoint and its
  answers
- [README.architecture.md](README.architecture.md) — how lookups, claims,
  transfers and the sweep work
- [CHANGELOG.md](CHANGELOG.md) — the releases

## Status

Before 1.0 — the API may change between minor versions.

## Contributing

Follow [the develop guide](doc/guides/develop-guide.md) and
[the rljson guide](doc/guides/rljson-guide.md).

## License

MIT — see [LICENSE](LICENSE).
