<!--
@license
Copyright (c) rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/webcache — API

## Webcache

`await Webcache.open(options)` opens a webcache over a node's local stores.

| Option | Meaning |
| --- | --- |
| `io`, `bs` | The local rows (the index) and blobs. Use stores on disk (`IoSqliteNode`, `BsFs`) to keep the cache across restarts. |
| `nodeId` | This node; written into every index row. |
| `allowedHosts` | Hosts it may download from: `host`, or `*.domain` for every subdomain. Nothing else is downloaded. |
| `proxy` | An HTTP proxy to the cloud, e.g. `http://proxy:3128`. |
| `statsFile` | Where the numbers are kept; in memory when omitted. |
| `folder` | The store's folder, to measure the free disk. |
| `maintenance` | `collectGarbage()` and `usage()` of the store, e.g. a `BsFs`. Without it, the disk budget is not enforced. |
| `lifetimeMs` | How long an entry lives after its last request. Default 30 days. |
| `diskBudgetBytes` | How many bytes the store may hold. Default 50 GiB. |
| `minFreeDiskPercent` | The share of the disk that must stay free. Default 10. |
| `fleetEnabled` | Whether other nodes are asked first. Default true. |
| `waitMs` | Longest a request waits for another node's download. Default 240 s. |
| `claimSettleMs`, `heartbeatMs`, `staleMs`, `pollMs` | How claims settle (250 ms), renew (10 s), go stale (30 s), and how often a waiting request asks again (500 ms). |
| `sweepIntervalMs`, `orphanGraceMs` | How often expired entries are swept (10 min, 0 never), and how long a blob nobody holds is kept (10 min). |

`webcache.fetch(request)` answers `{ url, key?, size?, consumer?, headers? }`:

- `key` names the content; without one it is the URL without fragment and
  without the query parameters that only sign it (`sig`, `se`, `X-Amz-*`, …).
  A key never changes its content.
- `size` must match exactly when given — what is held under another size does
  not answer, and a download of another size fails.
- `headers` are sent to the cloud and never stored.

The answer: `source` (`local`, `fleet` or `cloud`), `size` (-1 while unknown),
`contentType`, `body(range?)` — a stream that delivers the bytes as they
arrive —, `finished` (resolves once the content is stored here) and
`served(bytes)` to count what was sent.

Requests for the same key share one answer; every requester but the first
reads it as `local`.

A request fails with a `WebcacheError` whose `reason` decides the HTTP
status:

| Reason | Status | When |
| --- | --- | --- |
| `bad-request` | 400 | No URL, no absolute http(s) URL, an empty key, a size that is no whole number. |
| `host-not-allowed` | 403 | The URL's host is not in `allowedHosts`. |
| `cloud-status` | 502 | The cloud answered other than 200/206; `upstreamStatus` names it. |
| `cloud-unreachable` | 502 | The cloud could not be reached, or the connection broke and could not be resumed. |
| `cloud-timeout` | 504 | The cloud did not answer within 30 s, or went 60 s without a byte. |
| `cloud-changed` | 502 | The content changed while a broken download was resumed. |
| `size-mismatch` | 502 | The cloud names, or delivers, another size than asked for. Nothing is stored. |
| `integrity` | 502 | The bytes do not match the MD5 the cloud names. Nothing is stored. |
| `closed` | 503 | The webcache is closed. |

A download that fails after the first bytes went out fails the body's
stream: an HTTP requester sees the connection break off.

Further: `attach(fleet)` / `detach()`, `entries()`, `remove(keyHash)`,
`pin(keyHash)` / `unpin(keyHash)`, `verify(keyHash)`, `prefetch(requests)`,
`downloads()`, `summary()`, `sweep()`, `reconfigure(settings)`, `close()`.

## WebcacheHttpServer

`await WebcacheHttpServer.listen(webcache, { port, host?, routes?, version? })`
serves the webcache to the programs of this machine. It binds to `127.0.0.1`
and answers 421 to any request whose `Host` is not this machine.

- `POST /fetch` with a JSON body as for `fetch(request)`: 200 with the bytes,
  `Content-Type`, `Content-Length` (when known), `X-Webcache-Source`,
  `X-Webcache-Key-Hash`, and an `ETag` of the blob once stored. A single
  `Range` gives 206, a range past the end 416. Errors answer JSON
  `{ error, message, upstreamStatus? }` with the status above.
- `GET /_webcache/health`: `{ ok, nodeId, version, fleet }`.
- `routes` are asked first: build further endpoints with `readJsonBody`,
  `sendWebcacheResponse` and `sendWebcacheError`.

A requester that hangs up stops only its own stream; the download behind it
finishes and is stored.

## WebcacheRoute and webcacheHubStores

`new WebcacheRoute({ webcache, peers: { nodes, connect }, fleet?, serve? })` is
a route member for an `@rljson/server` `Node`, on the route `webcache`:

- it serves the webcache's local stores to peers, started or not;
- started, it attaches a `Fleet` that asks every node of `nodes()` over
  `connect(nodeId, signal)` — a peer connection with the handshake
  `{ treeKeys: ['webcache'], peerRead: true }` —, and connects to the hub to
  reach nodes it cannot reach directly;
- a hub that cannot be reached fails the start (the node tries again); the
  direct fleet stays.

The hub serves the route with `webcacheHubStores()`: stores that pass rows and
blocks through and keep nothing.
