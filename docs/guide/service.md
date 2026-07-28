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

`install` does not take it: installing needs one concrete directory.

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
ProtectSystem=strict
ReadWritePaths=/srv/scheduling
ProtectHome=yes
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
```

What each buys you:

- **`DynamicUser=yes`** — systemd allocates a throwaway account for each start.
  There is no persistent user for the service, and nothing on the system is
  owned by it.
- **`ProtectSystem=strict` + `ReadWritePaths=<webroot>`** — the entire
  filesystem is read-only to the process except the webroot. A bug that wants to
  write somewhere it should not simply cannot.
- **`ProtectHome=yes`** — home directories are invisible to it.
- **`NoNewPrivileges=yes`** — the process cannot gain privileges, ever, not even
  through a setuid binary.
- **`PrivateTmp=yes`** — its own `/tmp`, thrown away on stop.
- **`RestrictAddressFamilies=…`** — IP and Unix sockets only.

### What it costs

- It needs `sudo`. The full unit text and the exact privileged commands are
  printed before anything runs.
- Files under `var/` end up owned by the ephemeral user, not by you. Back the
  data up with the same `sudo`, and do not expect to edit the JSON by hand
  afterwards.

### macOS and Windows

Neither has an equivalent. Their tasks run as you, with your privileges and your
files. If that isolation is what you are after, run Timeful on Linux with
`--system`, or give it a container or VM of its own.
