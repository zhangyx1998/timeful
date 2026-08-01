# Backup and restore

The backup procedure is: **copy the data directory**. The restore procedure
is: **put it back**. There is no dump command, no export format, and nothing
to remember, because there is no database to be consistent with.

The data directory is wherever `varDir` in `timeful.config.json` points — the
webroot itself for newly initialized webroots, `var/` inside it for older
ones. The examples below say `var/`; read them as your data directory.

## What is in there

```
var/credential.json      the single owner account (email + salt + scrypt hash)
var/sessions.json        active session tokens
var/links.json           slug -> event id
var/events/<uuid>.json   one file per event, guest answers included
```

Everything the server knows is in those files. Nothing lives in memory that
matters across a restart, except slug reservations for events that are still
half-created in a form somewhere.

## Why a plain copy is safe

Every write goes through one module that writes to a temporary file and then
`rename()`s it over the target. A rename is atomic, so at any instant each file
on disk is either entirely the old version or entirely the new one — a reader
can never catch a half-written event. Writes to the same file are also
serialised, so two guests saving at once cannot interleave into a mangled
result.

That means a copy taken while the server is running is a valid backup. The worst
case is that one event is a few seconds stale relative to another; no file is
ever corrupt.

## Copying it

```sh
cd /srv/scheduling
tar czf ~/timeful-$(date +%F).tar.gz var/
```

Or with rsync, on a timer:

```sh
rsync -a --delete /srv/scheduling/var/ backup-host:/backups/timeful/var/
```

::: warning If you installed the hardened system service
Under the Linux `--system` tier, files in `var/` are owned by systemd's
throwaway `DynamicUser` account, not by you. Back them up with `sudo` — a plain
user-level cron job will silently copy nothing.
:::

## Restoring

Stop the server, replace the directory, start it again:

```sh
systemctl --user stop timeful         # or: launchctl bootout, or Ctrl-C
rm -rf var && tar xzf ~/timeful-2026-07-01.tar.gz
systemctl --user start timeful
```

Every event link keeps working: slugs live in `links.json`, which came back with
everything else.

Sessions come back too, which means anyone who was signed in before the backup
was taken is signed in again. If the reason you are restoring is that something
went wrong, delete `var/sessions.json` — it is regenerated empty, and you simply
log in again.

## Moving to another machine

The webroot is self-contained and path-independent. Copy `var/` and
`timeful.config.json` to the new box, `npx timeful` in that directory, and you
are running. Nothing in the data references the old hostname, the old absolute
path, or the old port.

## Keeping the data somewhere else

If you would rather the data did not live in the webroot — a mounted volume, a
directory your backup tool already watches — point `varDir` at it:

```json
{ "varDir": "/mnt/backup-me/timeful" }
```

The webroot then holds only `timeful.config.json`. The hardened system
service's write grant (`ReadWritePaths=`) and the `timeful` group ownership
both follow `varDir` itself, so a data directory outside the webroot works —
but they are applied at install time, so after moving `varDir`, rerun
`timeful service install --system` (or `npx timeful@latest upgrade`) to point
the unit and the ownership at the new location.
