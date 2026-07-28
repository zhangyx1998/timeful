# Timeful

A self-hosted group availability poll. Create an event, send people the link,
and everyone paints the hours they are free onto a shared grid until the overlap
is obvious.

It is built for a single owner running it on their own box: you hold the one
admin account, and everyone else is a guest who needs nothing but the link. No
sign-up, no database server, no container runtime, no third-party service in the
request path — one Node process serves the app and keeps its state in JSON files
on disk.

## Quick start

Node.js **>= 22.18** is the only requirement.

```sh
mkdir scheduling && cd scheduling
npx timeful
```

The directory you run it in becomes the **webroot**: it holds the config file
and the data directory, and nothing else is ever written there. The first run
has no config, so it asks four questions — port, bind address, data directory,
trusted proxy — writes `timeful.config.json`, and offers to start the server and
install it as a startup service. Every later run in that directory starts
straight away.

Then open <http://127.0.0.1:3000> and create the owner account.

```sh
npx timeful --yes            # take every default, no questions asked
timeful service install      # survive a reboot
timeful --help               # every flag
```

## What you get

- **Specific dates or days of the week**, any daily window, a time increment of
  your choosing.
- **Guests just get a link.** They type a name once; answers save themselves as
  they drag. No account, no email.
- **A heatmap of the overlap**, plus per-respondent detail, if-needed answers,
  a timezone selector and 12/24-hour display.
- **Data you can back up with `cp`.** One JSON file per event, written
  atomically, under `var/`.
- **Event links are capabilities.** 12 crypto-random base62 characters (~71
  bits). Failed lookups are tarpitted per IP, the site is `Disallow`ed in
  robots.txt, and event pages are `noindex`.
- **Dark mode**, and every page usable at 360px wide.

## Documentation

Full documentation — configuration, deploying behind nginx, hardened systemd
service, backup, and the complete architecture and API reference — lives at:

**<https://zhangyx1998.github.io/timeful/>**

Source and issues: <https://github.com/zhangyx1998/timeful>

## License

MIT. Copyright © 2026-present Yuxuan Zhang.
