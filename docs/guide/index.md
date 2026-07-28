# Install and first run

Node.js **>= 22.18** is the only prerequisite. There is nothing else to
install: no database to provision, no container runtime, no service account to
create anywhere.

## Create a webroot

Timeful is directory-oriented. The directory you launch it from is its
**webroot**, and it is the answer to every "where does this live?" question:
the config file sits there, the data directory sits there, and nothing else is
ever written into it. You can keep as many webroots as you like — a personal
one and a team one, say — and they know nothing about each other.

```sh
mkdir scheduling && cd scheduling
npx timeful
```

## The three things it does

Bare `timeful` looks at the directory and picks between the first two:

```sh
timeful init      # make this directory a webroot (the wizard)
timeful serve     # serve this webroot
timeful service   # install and control the background service
```

Saying which you meant is worth it in a script or a unit file, because each one
refuses to be the other: `serve` in a directory with no config exits non-zero
instead of starting a wizard nobody is watching, and `init` in a directory that
already has one exits non-zero instead of overwriting it.

Any of them takes `--dry-run`, which prints every file it would write and every
command it would run, changes nothing, and exits 0.

## The first-run wizard

With no `timeful.config.json` to read, the CLI assumes you meant to set this
directory up and asks:

```
This directory is not a Timeful webroot: no timeful.config.json in /srv/scheduling
Answer a few questions and it will be. Press Enter to take a default.

Initialize a Timeful webroot here? (Y/n) yes

Port [3000]:
Bind address [127.0.0.1]:
Data directory [./var]:
Trusted proxy — who may speak for a client's address?
  > loopback — trust 127.0.0.1 and ::1 — a reverse proxy on this machine
    none — ignore X-Forwarded-* entirely
    specific addresses
  ↑/↓ to move, Enter to select, Ctrl+C to cancel
```

Then, once the config file and the data directory exist:

```
Wrote /srv/scheduling/timeful.config.json
Created /srv/scheduling/var

Start the server now? (Y/n) yes
Install as a system service so Timeful starts automatically? (y/N) no
```

Every answer has a default that is right for the common case — a server on
loopback, proxied by something in front of it — so pressing Enter four times is
a legitimate way to answer. Lists take the arrow keys (or `j`/`k`), Enter
chooses, and Ctrl+C leaves without writing anything. What each answer means is
spelled out in [Configuration](/guide/configuration).

Once the config exists, later runs skip all of this and start the server.

### Unattended setup

```sh
npx timeful --yes      # initialize with the defaults, then serve
timeful init --yes     # initialize with the defaults and stop there
```

`--yes` takes every default and does not offer a service. It is also the only
way to initialize a webroot without a terminal: with no config to read, no
`--yes`, and a stdin that is not a TTY, Timeful explains the situation on stderr
and exits non-zero rather than blocking forever on a question nobody can answer.
Nothing is written in that case.

To see what a fresh webroot would get without creating one:

```sh
timeful init --yes --dry-run
```

## Create the owner account

Start the server and open `/` — <http://127.0.0.1:3000> with the defaults.

With no credential on disk, the root page is a **setup form**: pick the email
and password for the single owner account. Submitting it writes
`var/credential.json` and signs you in.

That form is a one-time door. Once a credential exists it is never offered
again — `/` becomes the login screen, and behind it is the admin panel where you
create events, copy their links, and manage the sessions you are signed in on.

::: tip There is only ever one account
Timeful has no user table and no registration. The owner is whoever holds that
credential; everyone else is an anonymous guest holding an event link. Changing
the email or password invalidates every existing session, everywhere.
:::

## Create your first event

From the admin panel:

1. **New event** — give it a name, choose *specific dates* or *days of the
   week*, pick the dates and the daily window, and choose a time increment.
2. Timeful reserves a random 12-character URL for it. You can replace that with
   a path of your own if you would rather send something memorable — but see
   [the security model](/reference/architecture#security) first, because the
   URL *is* the access control.
3. **Copy link**, send it to the group.

Guests open the link, type a name once, and drag across the grid. Their answers
save themselves a moment after they stop dragging — there is no Save button —
and everyone's answers stack into a heatmap underneath.

## Working from a checkout

If you would rather run the source than the published package:

```sh
git clone https://github.com/zhangyx1998/timeful
cd timeful
npm install

npm run dev      # Vite middleware + HMR on http://127.0.0.1:3000
```

For a production-shaped run from the same checkout:

```sh
npm run build    # client bundle, SSR bundle, and dist/cli.js
npm start        # serve the built app
```

`npm start` reads `var/` from the working directory exactly as the packaged CLI
does; only the built assets come from `dist/`. See
[Development](/reference/development) for the full set of commands.
