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
  "varDir": "./var",
  "trustedProxy": ["127.0.0.1", "::1"]
}
```

| Key            | Default                | Meaning                                                                                                          |
| -------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `port`         | `3000`                 | Port to listen on.                                                                                                 |
| `host`         | `127.0.0.1`            | Interface to bind. Keep this on loopback when something else terminates TLS in front of you.                        |
| `varDir`       | `"./var"`              | Data directory. Relative paths resolve against the webroot; absolute paths are taken as-is.                         |
| `trustedProxy` | `["127.0.0.1", "::1"]` | Peers allowed to speak `X-Forwarded-For` on a client's behalf. `"none"` ignores forwarded headers; `"loopback"` is shorthand for the default pair. |

The file's presence is what makes a directory a webroot. Delete it and the next
`npx timeful` will offer to set the directory up again.

## Precedence

Each of the four settings can be overridden per run. Lowest priority first:

1. `timeful.config.json`
2. environment variables — `PORT`, `HOST`, `VAR_DIR`
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
| `MISS_DELAY_MS`  | `100`     | How long each failed lookup waits before its 404.                   |
| `MISS_QUEUE_CAP` | `10`      | How many failed lookups one IP may have queued before it gets 429s. |
| `LEASE_TTL_MS`   | `900000`  | Lifetime of a slug reservation while an event is being created (15 minutes). |

Raising `MISS_DELAY_MS` makes URL guessing slower and costs a guest who
mistypes a link nothing they will notice. Lowering `MISS_QUEUE_CAP` makes
Timeful start refusing a scanner sooner.

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
