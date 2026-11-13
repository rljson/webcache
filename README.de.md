<!--
@license
Copyright (c) rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/webcache

[English](README.md) | Deutsch

[![CI](https://github.com/rljson/webcache/actions/workflows/quick_check.yaml/badge.svg)](https://github.com/rljson/webcache/actions/workflows/quick_check.yaml)
[![npm](https://img.shields.io/npm/v/@rljson/webcache.svg)](https://www.npmjs.com/package/@rljson/webcache)

Der RLJSON-Webcache stellt heruntergeladene Webinhalte wie Medien, Bilder und
Texte als lokal abrufbaren Zwischenspeicher bereit. Auf Basis eines
Blob-Speichers (rljson/bs) liefert er heruntergeladene Daten über ein
rljson-Netzwerk (rljson/server, rljson/network) aus, sodass andere
rljson-Clients sie zuerst aus der Flotte holen, bevor sie sie selbst
herunterladen.

## Motivation

- Mehrere Rechner eines Netzwerks laden oft dieselben Dateien aus derselben
  Cloud: N Downloads jeder Datei, N-mal der Verkehr und die Kosten.
- Ein Webcache beantwortet jede Anfrage aus seinem eigenen Speicher, sonst von
  einem anderen Rechner des Netzwerks, der die Datei hat, sonst aus der Cloud
  — und hält die Datei danach für alle anderen bereit.
- Rechner, die im selben Moment nach derselben Datei fragen, einigen sich auf
  einen, der sie lädt; die anderen warten und kopieren sie von dort.
- Ist die Cloud nicht erreichbar, wird weiter ausgeliefert, was das Netzwerk
  hat.

## Installation

```bash
pnpm add @rljson/webcache
```

## Verwendung

Ein Webcache über Speicher im Arbeitsspeicher, der eine Datei zweimal lädt:

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

Ausgabe:

```text
cloud: catalogue bytes
local: catalogue bytes
```

Derselbe Code steht in [example/webcache-example.ts](example/webcache-example.ts).

Um den Zwischenspeicher zwischen Rechnern zu teilen, läuft eine
`WebcacheRoute` als Mitglied eines `Node` aus `@rljson/server`, der Hub bedient
die Route mit `webcacheHubStores()`, und die Programme jedes Rechners fragen
`WebcacheHttpServer` — siehe [README.public.md](README.public.md).

## Grenzen

- Ein Schlüssel ändert seinen Inhalt nie: Eine neue Version braucht einen
  neuen Schlüssel (oder eine neue URL). Gegen die Cloud wird nicht erneut
  geprüft.
- Er lädt nur von den Hosts, die er bekommt (`allowedHosts`), und ist so kein
  offener Proxy. Der HTTP-Server antwortet nur diesem Rechner.
- Rechner anderer Netzwerke oder Standorte werden nicht gefragt, nur die
  Knoten derselben Netzwerk-Domain.
- Zwei Rechner, die den Anspruch des anderen nicht sehen — ein geteiltes
  Netzwerk —, laden eine Datei unter Umständen beide.

## Dokumentation

- [README.public.md](README.public.md) — die API, der HTTP-Endpunkt und
  seine Antworten
- [README.architecture.md](README.architecture.md) — wie Abfragen, Ansprüche,
  Übertragungen und das Aufräumen funktionieren
- [CHANGELOG.md](CHANGELOG.md) — die Versionen

## Status

Vor 1.0 — die API kann sich zwischen Minor-Versionen ändern.

## Mitwirken

Siehe [den Develop Guide](doc/guides/develop-guide.md) und
[den rljson Guide](doc/guides/rljson-guide.md).

## Lizenz

MIT — siehe [LICENSE](LICENSE).
