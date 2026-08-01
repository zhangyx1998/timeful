# Configuration

Timeful has two kinds of settings. The four you are likely to touch live in a
config file in the webroot. The rest are environment variables that exist so you
can tune the anti-scanning machinery without editing anything.

## `timeful.config.json`

Written by the [first-run wizard](/guide/), and yours to edit afterwards:

```json
{
  "port": 3000,
  "host": "127.0.0.1",
  "varDir": "./",
  "trustedProxy": ["127.0.0.1", "::1"],
  "realtime": true
}
```

| Key            | Default                | Meaning                                                                                                          |
| -------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `port`         | `3000`                 | Port to listen on.                                                                                                 |
| `host`         | `127.0.0.1`            | Interface to bind. Keep this on loopback when something else terminates TLS in front of you.                        |
| `varDir`       | `"./"`                 | Data directory — the webroot itself by default. Relative paths resolve against the webroot; absolute paths are taken as-is. Webroots initialized by older versions say `"./var"`, which keeps working unchanged. |
| `trustedProxy` | `["127.0.0.1", "::1"]` | Peers allowed to speak `X-Forwarded-For` on a client's behalf. `"none"` ignores forwarded headers; `"loopback"` is shorthand for the default pair. |
| `realtime`     | `true`                 | Server-wide switch for [live updates](#live-updates). `false` turns them off for every event, whatever the events themselves say. |

The file's presence is what makes a directory a webroot. Delete it and the next
`npx timeful` will offer to set the directory up again.

## Precedence

Each setting can be overridden per run. Lowest priority first:

1. `timeful.config.json`
2. environment variables — `PORT`, `HOST`, `VAR_DIR`, `TIMEFUL_REALTIME`
3. command-line flags — `--port`, `--host`, `--var-dir`, `--trusted-proxy`

```sh
timeful --port=8080                       # just this run
PORT=8080 timeful                          # same, from the environment
npm start -- --port=8080                   # from a checkout
```

`timeful --help` lists every flag.

## Environment variables

`PORT`, `HOST` and `VAR_DIR` mirror the config file keys above. The remaining
variables have no config-file equivalent — they tune the miss tarpit and slug
leases described in [the security model](/reference/architecture#security), and
the defaults are sensible for a group of humans sharing a link.

| Variable         | Default   | Meaning                                                             |
| ---------------- | --------- | ------------------------------------------------------------------- |
| `PORT`           | `3000`    | Port to listen on. Overrides `port`.                                |
| `HOST`           | `127.0.0.1` | Interface to bind. Overrides `host`.                              |
| `VAR_DIR`        | `<cwd>/var` | Data directory. Overrides `varDir`.                               |
| `TIMEFUL_REALTIME` | `1`     | Live updates, server-wide. Overrides `realtime`. Accepts `1`/`0`, `true`/`false`, `on`/`off`, `yes`/`no`. |
| `MISS_DELAY_MS`  | `100`     | How long each failed lookup waits before its 404.                   |
| `MISS_QUEUE_CAP` | `10`      | How many failed lookups one IP may have queued before it gets 429s. |
| `LEASE_TTL_MS`   | `900000`  | Lifetime of a slug reservation while an event is being created (15 minutes). |

Raising `MISS_DELAY_MS` makes URL guessing slower and costs a guest who
mistypes a link nothing they will notice. Lowering `MISS_QUEUE_CAP` makes
Timeful start refusing a scanner sooner.

## Live updates

An event page left open keeps itself current: when somebody else answers, the
heatmap and the respondents list change under you, without a reload. It works
over a WebSocket at `/<slug>/ws`, and the whole of it is optional.

**The event owns the setting.** Every event has a **Live updates** checkbox in
its create and edit dialog, on by default. Turn it off and pages watching that
event are disconnected and refused if they try again; the event carries on
working exactly as it did, and a respondent sees other people's answers the next
time the page loads. Events created before this existed have no such field
stored, and that reads as on.

**The config key is a kill switch above it.** `realtime: false` — or
`TIMEFUL_REALTIME=0` — means no event gets a channel whatever its own setting
says, and the server registers no upgrade listener at all.

**Editing is one session at a time.** While live updates are on, a page that
has adopted a name holds that name's *edit session* on a second socket,
`/<slug>/users/<key>`, and there can only be one of those per name per event.
Opening the same name in another window offers to take the session over, and
the window that had it is told so and drops back to the group view.

::: tip Nothing depends on it
Turning live updates off — at either level — costs you the live updates and
nothing else. Every write still works over the ordinary REST API, which is what
the page falls back to; with no sockets there are also no edit sessions, so two
windows answering as the same person is simply last-write-wins, exactly as it
was before any of this existed. See
[the realtime channel](/reference/architecture#realtime-updates) for the
message shapes and the security reasoning.
:::

If you run Timeful behind a reverse proxy, it needs to be told to pass
WebSocket upgrades through, or pages will simply never connect and quietly fall
back. For nginx that is `proxy_set_header Upgrade $http_upgrade;` and
`proxy_set_header Connection "upgrade";` on the location block — see
[Deployment](/guide/deployment).

## `--trusted-proxy`

This is the one setting worth reading twice, because getting it wrong quietly
breaks the per-IP rate limiting.

`X-Forwarded-For` is a claim, not a fact: anyone who can reach the server can
send one. Timeful therefore honours it **only** when the request arrives from an
address you have named as a proxy, and it takes the client IP to be the
rightmost entry the trusted chain did not vouch for. `X-Forwarded-Proto` — which
decides whether session cookies get the `Secure` flag — follows the same trust.

```sh
timeful --trusted-proxy=10.0.0.0/8
timeful --trusted-proxy=none                 # ignore forwarded headers entirely
npm start -- --trusted-proxy=10.0.0.0/8      # from a checkout
```

The value is a comma-separated list of IPs and CIDR ranges. **Hostnames are
never accepted** — resolving one at request time would put DNS in the trust
path. The default, `loopback`, expands to `127.0.0.1` and `::1`.

Which value you want:

| Your setup                                     | Value                                     |
| ---------------------------------------------- | ----------------------------------------- |
| nginx / Caddy on the same host                  | the default — leave it alone              |
| a reverse proxy on another machine              | that machine's address, e.g. `203.0.113.7` |
| a proxy pool inside your network                | the range, e.g. `10.0.0.0/8`               |
| exposed directly to the internet, no proxy      | `none`                                    |

If you set it too widely, a client can forge its own address and shrug off the
tarpit. If you leave it too narrow, every request appears to come from your
proxy and one scanner's misses get charged to everyone. See
[Deploying behind nginx](/guide/deployment) for the matching proxy config.
