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

The wizard never writes an `oidc` block; add one by hand to turn on
[OIDC sign-in](#oidc-sign-in).

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
| `TIMEFUL_OIDC_ISSUER`, `TIMEFUL_OIDC_CLIENT_ID`, `TIMEFUL_OIDC_CLIENT_SECRET`, `TIMEFUL_OIDC_ALLOWED_EMAILS`, `TIMEFUL_OIDC_NAME` | — | Override the matching `oidc` key, or configure OIDC without a config file. `ALLOWED_EMAILS` is comma-separated. |
| `TIMEFUL_PASSWORD_LOGIN` | `1` | Overrides `oidc.passwordLogin`. |

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

## OIDC sign-in

You can sign in to the admin side through your own OpenID Connect provider,
such as Pocket ID, Authelia, Authentik or Keycloak, instead of a password or as
well as one. Guests are unaffected: they never sign in to anything.

```json
{
  "oidc": {
    "issuer": "https://id.example.com",
    "clientId": "4b1c…",
    "clientSecret": "…",
    "allowedEmails": ["you@example.com"],
    "passwordLogin": false,
    "name": "Example ID"
  }
}
```

| Key             | Default             | Meaning |
| --------------- | ------------------- | ------- |
| `issuer`        | required            | The provider's issuer URL, exactly as its discovery document states it. Must be `https` (plain `http` only for `localhost`). |
| `clientId`      | required            | The client registered at the provider. |
| `clientSecret`  | none                | The client's secret. Leave it out for a public client, which then relies on PKCE alone. Can come from `TIMEFUL_OIDC_CLIENT_SECRET` instead of the file. |
| `allowedEmails` | the password account's email | Who may sign in. The provider must vouch for the address (`email_verified`). Required when `passwordLogin` is `false`. |
| `passwordLogin` | `true`              | `false` removes the password form. Opening the admin page then goes straight to the provider, with no Timeful sign-in screen in between. |
| `name`          | the issuer's host   | The label on the "Continue with …" button. |

At the provider, register a client with this callback URL:

```
https://<your timeful host>/api/auth/oidc/callback
```

PKCE is always used, so turn it on there if the provider makes it optional.
Restricting the client to a group of users at the provider is a good second
lock, but it is not the first one: Timeful checks `allowedEmails` itself, so an
account the provider knows but you did not list is still turned away.

The callback URL is built from the address the request arrived on. Behind a
reverse proxy that means the proxy must pass `Host` and `X-Forwarded-Proto`, and
[`--trusted-proxy`](#trusted-proxy) must name it. Otherwise the provider will
reject the callback as unregistered.

Signing out of Timeful does not sign you out of the provider. With
`passwordLogin: false`, the sign-in screen after a sign-out offers a
"Continue with …" button instead of sending you straight back.

::: tip Getting back in from the shell
Provider-only sign-in assumes you have shell access to the server. That shell
is the recovery path if the provider is down or misconfigured. Set
`"passwordLogin": true` in the config, or start one run with
`TIMEFUL_PASSWORD_LOGIN=1`, and restart. The password form comes back. If no
password account was ever created, the first-run setup screen appears instead,
and whoever reaches it first claims the account. So finish setup before you
step away, or do it over an SSH tunnel with Timeful bound to loopback.
:::

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
