# Deploying behind nginx

Timeful speaks plain HTTP and binds loopback by default. That is deliberate: it
expects something in front of it to terminate TLS, and it would rather not be
reachable at all than be reachable in the clear.

The whole deployment is three commands and one nginx block.

## The three commands

```sh
mkdir -p /srv/scheduling && cd /srv/scheduling
npx timeful --yes            # webroot with defaults, now serving 127.0.0.1:3000
timeful service install      # and it comes back after a reboot
```

## The nginx block

```nginx
server {
    listen 443 ssl;
    server_name timeful.example.com;

    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Live updates ride a WebSocket, and nginx only forwards an upgrade
        # when it is told to. Without these three lines event pages still
        # work — they just stop updating on their own.
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

The forwarded headers matter:

- **`X-Forwarded-For`** is how the per-IP tarpit sees real client addresses
  instead of charging every miss in the world to `127.0.0.1`.
- **`X-Forwarded-Proto`** is how Timeful knows the connection the browser
  actually made was TLS, and therefore that the session cookie should carry
  `Secure`. It is also what makes the page open a `wss://` socket rather than a
  `ws://` one a browser on an HTTPS page would refuse.

`$proxy_add_x_forwarded_for` appends the real peer address to whatever the
client sent. Timeful reads the chain from the right and stops at the first entry
its trusted proxies did not vouch for, so a client that invents its own
`X-Forwarded-For` prefix gains nothing.

## Matching the trusted-proxy setting

With nginx on the same host, the default trusted proxy — loopback — is already
correct and there is nothing to change.

If nginx runs elsewhere, name that machine. Either in `timeful.config.json`:

```json
{ "trustedProxy": ["203.0.113.7"] }
```

or per run:

```sh
timeful --trusted-proxy=203.0.113.7
```

See [Configuration](/guide/configuration#trusted-proxy) for the full rules,
including CIDR ranges and `none`.

## WebSockets, timeouts, buffering

None of these need tuning. Timeful holds no long-lived connections: guest
answers go over ordinary short `PUT` requests, and event pages are
server-rendered HTML. The default nginx proxy timeouts are generous compared to
anything the app does.

## A checklist before you point DNS at it

- The server binds `127.0.0.1`, not `0.0.0.0`. Confirm with `ss -ltnp` that
  nothing outside the box can reach port 3000 directly — otherwise the whole
  proxy story, `Secure` cookies included, can be walked around.
- TLS actually terminates at nginx and HTTP redirects to it. Event links are
  capabilities; sending them over plaintext hands them to the network.
- `trustedProxy` names the proxy and nothing wider.
- You have signed in once and created the owner account. Until you do, `/`
  offers the setup form to whoever asks — including whoever finds it first.
- You know where `var/` is and something copies it. See
  [Backup and restore](/guide/backup).

## Other proxies

Nothing here is nginx-specific. Caddy, Traefik, HAProxy or an Apache
`ProxyPass` all work the same way: forward to the loopback port, set the two
forwarded headers, pass WebSocket upgrades through, and make sure
`trustedProxy` names the proxy's address. A Caddyfile is two lines — Caddy sets
both headers and handles upgrades itself:

```text
timeful.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

A proxy that does not forward upgrades is not a broken deployment, only a
quieter one: the pages fall back to plain REST and everything still works. If
you would rather not run the channel at all, turn it off explicitly with
`realtime: false` — see [Configuration](/guide/configuration#live-updates).
