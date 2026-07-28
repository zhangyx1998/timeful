---
layout: home

hero:
  name: Timeful
  text: Find the time everyone is free
  tagline: A self-hosted group availability poll. One owner, one Node process, JSON files on disk — no database, no Docker, no accounts for your guests.
  actions:
    - theme: brand
      text: Get started
      link: /guide/
    - theme: alt
      text: Architecture
      link: /reference/architecture
    - theme: alt
      text: GitHub
      link: https://github.com/zhangyx1998/timeful

features:
  - title: One command to run
    details: Node 22.18 and nothing else. `npx timeful` in an empty directory asks four questions, writes a config, and starts serving.
  - title: Guests just get a link
    details: No sign-up, no email, no app. Open the URL, type a name, paint the hours you are free. Answers save themselves as you drag.
  - title: Your data stays a directory
    details: Every event is a JSON file under `var/`. Writes are atomic, so copying that directory is a consistent backup and putting it back is a restore.
  - title: Links are the lock
    details: Event URLs are 12 characters of crypto-random base62. Failed lookups are tarpitted per IP, the whole site is `Disallow`ed, and event pages are `noindex`.
---

## What it is

You have a group and a rough window of dates. Timeful gives you a page where
everyone drags across the hours they can make, stacks those answers into one
heatmap, and shows you where the overlap is.

It is built for **one owner running it on their own box**. You hold the single
admin account, you create the events, and everyone else is a guest who needs
nothing but the link you send them. There is no database server, no container
runtime, and no third-party service anywhere in the request path — a single Node
process serves the app and keeps its state in JSON files next to itself.

## Quick start

```sh
mkdir scheduling && cd scheduling
npx timeful
```

The directory you run it in becomes the **webroot**: it holds the config file
and the data directory, and nothing else is ever written there. The first run
has no config to read, so it asks a handful of questions and writes one. Every
later run in that directory starts straight away.

Then open <http://127.0.0.1:3000> and create the owner account.

[Install and first run →](/guide/)

## Where to go next

| If you want to…                              | Read                                                  |
| -------------------------------------------- | ----------------------------------------------------- |
| get it running for the first time             | [Install and first run](/guide/)                      |
| change ports, paths or proxy trust            | [Configuration](/guide/configuration)                 |
| have it survive a reboot                      | [Running as a service](/guide/service)                |
| put it on the internet behind TLS             | [Deploying behind nginx](/guide/deployment)           |
| keep a copy of your events                    | [Backup and restore](/guide/backup)                   |
| know exactly what the server does             | [Architecture](/reference/architecture)               |
| work on the code                              | [Development](/reference/development)                 |

## License

[MIT](https://github.com/zhangyx1998/timeful/blob/main/LICENSE). Copyright ©
2026-present Yuxuan Zhang.
