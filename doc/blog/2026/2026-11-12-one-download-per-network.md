<!--
@license
Copyright (c) rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# One download per network: the first webcache

## Motivation

- Several machines of one network often download the same files from the
  same cloud: N downloads of every file, N times the traffic and the cost.
- Most of them could get the file from a neighbour on the LAN, much faster
  than from the cloud, if they knew who holds it.
- `@rljson/webcache` is that knowledge: a cache of downloaded content that
  the nodes of one rljson network share.

## Strategy

- Answer every request from the own store, else from another node of the
  network that holds the content, else from the cloud — and keep what came
  from the cloud for everybody else.
- Let machines that ask for the same content at the same moment agree who
  downloads: one claims, the others wait and copy from it.
- Store content as content-defined blocks of `@rljson/bs`, so a large file
  never sits in memory and a copy moves only the blocks a store lacks.
- Push nothing: every node keeps its own index, and the others ask it.
- Download only from the hosts it is given, and answer only the programs of
  the own machine, so it is no open proxy.

## The order of sources

1. **Own store** — a live entry whose size fits and whose blob exists.
2. **Fleet** — every node of the network is asked in parallel for its
   newest row of the key. Holders found: the blocks are copied from all of
   them at once, in a window of eight, each checked against its id.
3. **Cloud** — the node claims the key, waits a moment and looks again. A
   holder that appeared is copied from; a fresh claim of a node with a
   lower id wins, and this node waits for it. Otherwise it downloads.

- Machines that start together and ask in the same order thus download each
  file once: they all claim, the lowest id downloads, the others copy.
- A claim is judged by this machine's own monotonic clock: alive while its
  heartbeat changes within `staleMs`.

## Downloads

- A download is cut into blocks as it arrives and served while it fills.
- A broken connection resumes from the last block boundary (`Range`,
  `If-Range`); the blocks are the same as without the break.
- An entry is stored only when the size asked for and the MD5 the cloud
  names are right. Requests to the cloud are bounded in time, uncompressed
  and may go through a proxy.
- Requests for the same key share one flight.

## Lifetime and space

- Entries live for a sliding lifetime, counted from the last request.
  Pinned entries never expire.
- A disk budget and a free-disk floor evict the least recently used
  entries. What is being downloaded, copied or read is never removed.
- The sweep then frees the blocks no blob references any more.

## Serving it

- `WebcacheHttpServer` — `POST /fetch` and `GET /_webcache/health`, on the
  loopback only.
- `poll(request, waitMs)` answers only complete content, else pending while
  it keeps coming. With `pendingAfterMs`, `POST /fetch` answers `202` with
  an empty body, so a requester with a short timeout gets content of any
  size by asking again.
- `WebcacheRoute` runs the webcache as a member of an `@rljson/server`
  `Node`. `webcacheHubStores()` lets a hub relay lookups and blocks between
  nodes that cannot reach each other, without keeping any of them.
- An admin API lists, pins, verifies, deletes, prefetches and clears
  entries, and counts requests and bytes per file, consumer and day.

## Dependency updates

- `undici` 7 → 8: a plain-http URL now goes to a proxy as a forwarded
  request; https still goes by `CONNECT`. The proxy test was adapted.

## Result

- 205 tests at 100 % coverage, among them nodes that ask for a file at the
  same moment and download it once between them, and a large file that is
  downloaded, resumed and copied through the fleet in bounded memory.

## Open Points

- A key never changes its content: a new version needs a new key or URL.
  There is no revalidation against the cloud.
- Two machines that cannot see each other's claim — a split network — may
  both download a file.
- Only the nodes of the same network domain are asked, never another site.
