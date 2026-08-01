# Running as a service

A `npx timeful` in a terminal stops when the terminal does. To have Timeful come
back after a reboot, install it as a service from inside the webroot:

```sh
timeful service install      # write and activate a startup service
timeful service status       # is it installed? is it running?
timeful service stop         # stop it now
timeful service start        # start it again
timeful service restart      # both, in order
timeful service uninstall    # deactivate and remove it
```

and one verb of its own, for moving an installed service onto a new version:

```sh
npx timeful@latest upgrade   # re-pin the unit, then restart it
```

The service records the webroot as its working directory, so it serves the same
config and the same data as the interactive run you just tried. The first-run
wizard offers to do this for you at the end.

::: tip Nothing happens behind your back
`install` prints the unit or plist it generated, the path it is going to, the
commands that will activate it, and how to undo all of it — *before* doing any
of it. If you decline a step that needs elevation, it prints the commands for
you to run yourself.
:::

## Which webroot

Every verb acts on one webroot, and works it out in this order:

1. a path you name — `timeful service restart /srv/scheduling`;
2. the directory you are in, if it is a webroot;
3. the only installed one, if there is exactly one;
4. otherwise it asks, listing what it found. With no terminal to ask at, it
   prints the candidates and exits non-zero rather than guessing.

`-A` (or `--all`) means *every* installed webroot at once, and works for
`uninstall`, `start`, `stop`, `restart` and `status`:

```sh
timeful service restart -A
```

`install` does not take it: installing needs one concrete directory. `upgrade`
resolves its webroot by the same four rules and takes `-A` too.

## Upgrading an installed service

```sh
cd /srv/scheduling && npx timeful@latest upgrade
```

A unit pins the absolute path of the CLI it execs, and for an npx install that
path lives in npm's `_npx` cache. So `npx timeful@latest` on its own upgrades
the copy in your terminal and leaves the service exactly where it was.
`upgrade` fixes that, and it is the only thing it does: npx has already fetched
the new version by the time the verb runs, so it re-points the unit at the code
running it and restarts the service.

```
$ npx timeful@latest upgrade
/srv/scheduling
  user tier: timeful-9f2c1ab340.service
    was /home/ada/.npm/_npx/2f7e7bff16d1c534/node_modules/timeful/cli.js
    now /home/ada/.npm/_npx/9ed06546b0653f96/node_modules/timeful/cli.js
```

It prints both paths, then the new unit and every command, before any of them
run — the same rule `install` follows, and `--dry-run` and `-A` work here as
they do everywhere else. The hardened system tier still needs `sudo`, and asks
for it in exactly the way `install` and `restart` already do.

Running it twice in a row is a no-op that says so. `var/` and
`timeful.config.json` are never touched. A webroot with no service installed is
not an error: it is told how a serve-only setup upgrades, which is by being
started again from the new version.

A **global** install (`npm i -g timeful`) has a path that does not move, so
there is nothing to re-pin. `upgrade` says so, checks whether anything newer
has been published, and prints the two commands that would take it:

```sh
npm i -g timeful@latest
timeful service restart
```

It never runs a package manager for you. That is a machine-wide change, it may
need a privilege you did not give this command, and you may be pinned to a
version on purpose.

## What is installed here?

`timeful service` on its own answers that, from anywhere:

```
$ timeful service
Installed Timeful services:

  /srv/scheduling
    user tier, running — http://127.0.0.1:3000
    /home/ada/.config/systemd/user/timeful-9f2c1ab340.service

  /srv/team
    user tier, stopped — http://127.0.0.1:3001
    /home/ada/.config/systemd/user/timeful-4e7b02cc19.service

Manage one with: timeful service <verb> <path-to-webroot>
```

There is no registry file behind that list. Timeful reads the unit directories
your platform keeps services in — `~/Library/LaunchAgents`,
`~/.config/systemd/user`, `/etc/systemd/system`, `%LOCALAPPDATA%\Timeful` — and
takes each webroot out of the unit itself, because a service's working directory
*is* its webroot. Move or edit a unit by hand and the list follows it. A unit it
cannot read or make sense of is still listed, marked as such, so you can always
uninstall it.

## Seeing what it would do

`--dry-run` works on every verb. It prints each file it would write and each
command it would run, changes nothing, and exits 0:

```
$ timeful service install --dry-run
Dry run: nothing below is written or executed.

Service file: /home/ada/.config/systemd/user/timeful-9f2c1ab340.service
------------------------------------------------------------
[Unit]
Description=Timeful (/srv/scheduling)
...
------------------------------------------------------------

Commands to activate it:
  systemctl --user daemon-reload
  systemctl --user enable --now timeful-9f2c1ab340.service

  would write /home/ada/.config/systemd/user/timeful-9f2c1ab340.service (contents above)
  would run: systemctl --user daemon-reload
  would run: systemctl --user enable --now timeful-9f2c1ab340.service
```

It is also how to get the commands for a machine you would rather drive by hand.
(`TIMEFUL_SERVICE_DRY_RUN=1` in the environment does the same thing; the flag
came later and is the one to reach for.)

## Tiers

There are two tiers. The user tier exists everywhere; the system tier is Linux
and systemd only.

| Platform | Tier   | What gets installed                                                        |
| -------- | ------ | -------------------------------------------------------------------------- |
| macOS    | user   | a LaunchAgent in `~/Library/LaunchAgents/`, loaded with `launchctl`          |
| Linux    | user   | a systemd **user** unit in `~/.config/systemd/user/`, enabled with `systemctl --user` |
| Linux    | system | a hardened unit in `/etc/systemd/system/` — see below                        |
| Windows  | user   | a `schtasks` logon task running a launcher script                           |

Pick one explicitly with `timeful service install --user` or
`timeful service install --system`. On an interactive Linux box with systemd,
`install` offers you the choice as a list; everywhere else the user tier is the
only one there is. The other verbs act on whichever tier they find installed,
unless you narrow them with the same two flags.

## The user tier

The default. All three platforms' user-tier services are per-user, need no
administrator rights, start when you log in, and **run as you** — meaning the
server has exactly your access to the machine. For a laptop or a box you are the
only user of, that is usually the right trade.

## The hardened system tier (Linux)

If systemd is present, `install` offers a stronger option: a unit in
`/etc/systemd/system` that starts at boot rather than at login and runs under
systemd's sandboxing.

```ini
DynamicUser=yes
SupplementaryGroups=timeful
UMask=0002
ProtectSystem=strict
ProtectHome=off
ReadWritePaths=/srv/scheduling/var
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
```

What each buys you:

- **`DynamicUser=yes`** — systemd allocates a throwaway account for each start.
  There is no persistent user for the service, and nothing on the system is
  owned by it.
- **`ProtectSystem=strict`** — the entire filesystem is read-only to the
  process. A bug that wants to write somewhere it should not simply cannot.
- **`ReadWritePaths=<data dir>`** — the one exception: the only writable path
  the service has. Not the whole webroot when the two differ: the config file
  is only ever read, and the unit logs to the journal rather than to a file.
- **`ProtectHome=off`** — deliberate, and the product of testing on a real
  box: every combination of `ProtectHome=tmpfs` with bind mounts left the
  data directory visible but *read-only* (saves failed with EROFS however
  the writable bind was spelled), so homes are not hidden. They are still
  protected by their own permissions — as against any other unprivileged
  account — and read-only to the service like everything else.
- **`NoNewPrivileges=yes`** — the process cannot gain privileges, ever, not even
  through a setuid binary.
- **`PrivateTmp=yes`** — its own `/tmp`, thrown away on stop.
- **`RestrictAddressFamilies=…`** — IP and Unix sockets only.

After activating it, `install` (and `upgrade`) watches the unit for a few
seconds and refuses to claim success over a service that did not stay up — a
crash loop is reported immediately, with the `journalctl` command that shows
why. The server also probes its own data directory at boot and exits with a
diagnosis rather than starting unwritable.

### The `timeful` group

`install` creates one thing on your machine besides the unit: a system group
called `timeful`. It exists because `DynamicUser` picks a new UID whenever it
feels like it, so a file that belongs to *this* boot's service user may not
belong to the next one's. Group ownership is the part that survives, so install
also does this to your data directory:

```sh
sudo chown -R :timeful /srv/scheduling/var
sudo chmod -R g+rwX /srv/scheduling/var
sudo find /srv/scheduling/var -type d -exec chmod g+s {} +
```

— group-owned, group-writable, and setgid so everything created later inherits
the group. The unit picks the group up with `SupplementaryGroups=timeful` and
`UMask=0002`.

One group serves every webroot on the machine, and `uninstall` does not remove
it — another unit may be using it, and an empty group owns nothing. It does not
remove your data either.

To read or edit `var/` yourself afterwards, either use `sudo`, or add yourself
to the group and log in again:

```sh
sudo usermod -aG timeful $USER
```

### The permissions it needs from you

The service reaches your webroot by ordinary permission checks, as any other
account would:

- every directory above the webroot — including your home, if it lives there —
  needs `o+x`, so the service user can pass through. Traverse-only: `o+x`
  without `o+r` lets a process walk a path it names exactly, without listing
  or reading anything;
- the webroot itself needs `o+x` — the 0755 a directory is normally born with;
- `timeful.config.json` needs `o+r` — the 0644 the CLI writes it as.

`install` checks the home-directory part for you and refuses with the exact
`chmod o+x` command when a directory would block the service (a 0700 or 0750
home, for instance). If you have tightened the others, loosen them again or
the service cannot read its own configuration. Nothing else in the webroot
needs to be readable, and the data directory itself is opened up by the
`timeful` group instead.

### What it costs

- It needs `sudo`. The full unit text and the exact privileged commands are
  printed before anything runs.
- Files under `var/` are group-owned rather than yours. See above.

### When it refuses

There is one setup the hardened tier cannot serve, and it says so instead of
installing something that would crash-loop: **a home directory the service
user cannot pass through**. The install checks every home-directory ancestor
of the paths the service uses (the webroot, the data directory, `node`, the
CLI), and a directory without `o+x` — a 0700 or 0750 home — is refused with
the exact one-bit cure printed:

```sh
chmod o+x /home/you   # traverse-only; nothing becomes listable or readable
```

If you would rather not touch your home's permissions, run it as yourself
instead. Lingering is what makes a user service start at boot rather than at
login, which is the part people usually want the system tier for:

```sh
timeful service install             # user tier, runs as you
sudo loginctl enable-linger $USER   # start at boot, survive logout
```

(A version manager's `node` — nvm, fnm, asdf, volta — is fine now, as long as
its directories are traversable like everything else. Earlier versions
refused it outright.)

### If you have an old, broken hardened unit

Two earlier generations of this unit were broken, each differently:

- **`ProtectHome=yes`** (the first shape) covered `/home` with a mount nothing
  can be bound through. A webroot in a home directory could never be entered,
  and the unit crash-looped with `status=200/CHDIR` — while
  `timeful service status` cheerfully reported it as running, because
  `systemctl is-active` calls a restart loop `activating`. The status command
  now says `failed (12 automatic restarts)`, and install itself watches the
  unit after starting it.
- **`ProtectHome=tmpfs` + `BindPaths=`** (the 0.0.2 shape) started fine and
  *read* fine — and every save failed, because the bind surfaces the data
  directory read-only under `ProtectSystem=strict`. See below.

Upgrading regenerates the unit in the proven shape, resets any latched failure
and restarts it:

```sh
cd /srv/scheduling && npx timeful@latest upgrade
```

`timeful service install --system` does the same thing from a copy you already
have. If you patched the unit by hand in the meantime — a drop-in under
`/etc/systemd/system/timeful-<hash>.service.d/` — delete that directory once the
new unit is in place and run `sudo systemctl daemon-reload`. The generated unit
now carries the same fix natively, and a stale override will only fight it.

### If saves fail with EROFS after an upgrade

The symptom of the 0.0.2 unit: the site loads, every event page reads
perfectly, and saving availability fails ("Could not save your availability"),
with the journal showing `EROFS` on a `…events/<uuid>.json.<pid>.<hex>.tmp`
path. The server now also refuses to start in this state, naming the same
errno and this cure.

The fix is the upgrade above, which rewrites the unit as
`ProtectHome=off` + `ReadWritePaths=<data dir>`. Until you can run it, a
drop-in gets a 0.0.2 unit writing again — this exact combination is what the
regenerated unit converges on:

```ini
# /etc/systemd/system/timeful-<hash>.service.d/override.conf
[Service]
ProtectHome=off
BindPaths=
ReadWritePaths=/path/to/your/data-dir
```

(`BindPaths=` with an empty value clears the unit's bind list; the plain
`ReadWritePaths=` carve-out is what actually makes the path writable. Adding
`ReadWritePaths=` *without* clearing the tmpfs and the bind does **not** work
— that combination was tested on a real box and still returns EROFS.) Then:

```sh
sudo systemctl daemon-reload && sudo systemctl restart timeful-<hash>.service
```

Delete the drop-in directory and `daemon-reload` again after your next
`npx timeful@latest upgrade`; the regenerated unit makes it redundant, and a
stale override will only fight some future shape.

### macOS and Windows

Neither has an equivalent. Their tasks run as you, with your privileges and your
files. If that isolation is what you are after, run Timeful on Linux with
`--system`, or give it a container or VM of its own.
