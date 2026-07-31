# Development

How to work on Timeful itself: the layout of the repository, the commands, how
the build produces a publishable package, and the conventions the codebase holds
itself to.

For *what the software does* — the storage format, the API contract, the
security design — see [Architecture](/reference/architecture), which is the
binding document. Where this page and that one disagree, that one wins.

## Requirements

Node.js **>= 22.18**. Server code runs as `.ts` directly under Node's native
type stripping, which is why the floor is that high and why the TypeScript is
constrained (see [Conventions](#conventions)).

```sh
git clone https://github.com/zhangyx1998/timeful
cd timeful
npm install
```

## Commands

```sh
npm run dev          # Express + Vite middleware, HMR, http://127.0.0.1:3000
npm run build        # typecheck, then client + SSR bundles and dist/cli.js
npm start            # serve the built app
npm test             # vitest run
npm run typecheck    # vue-tsc --noEmit
```

`npm run dev` and `npm start` both read `var/` from the working directory, the
same way the packaged CLI does — a checkout is just another webroot. Server
flags pass through after `--`:

```sh
npm start -- --port=8080 --trusted-proxy=10.0.0.0/8
```

To test from a phone on the same network, bind every interface and open the
printed `network:` URL:

```sh
npm run dev -- --host      # bare --host means 0.0.0.0; --host <addr> binds one
```

Hot reload works there too: in dev the HMR WebSocket rides the app's own port
(see `server/dev.ts`), so the one address the phone can reach is the only one
it needs. The `HOST` environment variable still works; the flag wins.

## Repository layout

```
index.html            SPA shell; also the SSR template for event pages
vite.config.ts        client -> dist/client, SSR -> dist/server
rollup.config.ts      CLI + server -> dist/cli.js + per-package vendor/ chunks

src/
  app.ts              app factory shared by both entries
  entry-client.ts     hydrates event pages, plain-mounts '/'
  entry-server.ts     renderToString for event pages
  router.ts           '/' -> Admin (CSR), '/:slug' -> Event (SSR)
  pages/              AdminPage.vue, EventPage.vue
  components/         admin/, event/, shared/, ui/
  lib/                dates, grid model, api client, sync engine, user keys,
                      realtime client, save transport, theme, colors, and the
                      event page's composables (response session, preferences,
                      viewport, isolation, admin state)
  styles/tokens.css   the palette — single source of truth

server/
  index.ts            repo entry for `npm run dev` / `npm start`
  app.ts              the Express app: API mount, SSR/static middleware, 404 page
  dev.ts              Vite dev renderer; imported dynamically, never bundled
  paths.ts            finds dist/client + dist/server relative to the entry module
  storage.ts          atomic JSON store (temp file + rename, per-file queue)
  auth.ts             scrypt hashing, session tokens, requireAdmin
  slugs.ts leases.ts tarpit.ts proxy.ts config.ts http.ts not-found.ts
  realtime.ts         per-event WebSocket rooms, write sessions, the upgrade listener
  registry.ts         the npm version lookup — see architecture § The update check
  push/               Web Push: aes128gcm + VAPID crypto, subscriptions, delivery
  routes/             auth, sessions, leases, events, update, push
  cli/                the `npx timeful` CLI, bundled into dist/cli.js
    index.ts          entry: webroot detection, wizard, service subcommands
    args.ts config.ts wizard.ts service.ts upgrade.ts errors.ts version.ts

public/               favicon.ico, push-sw.js, manifest.webmanifest, icons
                      (copied into dist/client)
docs/                 this site — a standalone VitePress package
var/                  data root, gitignored, overridable via VAR_DIR
```

`docs/` is deliberately **not** an npm workspace. It has its own
`package.json` and its own lockfile, installs its own copy of VitePress, and the
root package neither knows nor cares that it exists. Building the app never
builds the docs, and a docs dependency can never reach the published bundle.

## Testing

```sh
npm test                                  # everything
npx vitest run src/lib/grid.test.ts       # one file
npx vitest run -t "clears the response"   # one test by name
npx vitest                                # watch
```

Tests live beside the code they cover, in both `src/` and `server/`. Server
tests exercise the real Express app against a temporary `var/` directory rather
than mocking the storage layer, so the atomic-write and queueing behaviour is
actually under test.

Three rules worth knowing before you write a new one:

- **Never activate a real service from a test.** Everything that touches the
  machine goes through `ServiceHost` in `server/cli/service.ts`. Unit generation
  is pure and tested as a string; the host is stubbed. `TIMEFUL_SERVICE_DRY_RUN=1`
  makes the CLI print commands instead of running them.
- **Never write outside a temp directory.** Anything that needs a `var/` makes
  one under the OS temp dir and removes it afterwards.
- **Never reach the npm registry.** The
  [update check](/reference/architecture#the-update-check) is the one thing in
  the app that can, and a test that needed npm to be up is a test that fails on
  a train. `fetchLatestVersion` takes an injected `fetchImpl` for unit tests;
  the route test spies on the global `fetch` and passes anything that is not the
  registry URL through to the real one, which is also how it asserts that an
  unauthenticated caller never causes a lookup. `timeful upgrade --dry-run`
  makes no lookup at all, so the CLI's end-to-end tests are offline by
  construction.
- **Never reach a real push service either.** The push delivery tests
  (`server/routes/push.test.ts`) subscribe endpoints that point at a local
  HTTP server the test itself runs, and `flushPushDelivery()` drains the
  coalescing queue deterministically — no vendor endpoint, no sleeping on
  timers. The crypto needs no network at all: it is pinned to the RFC 8291
  Appendix A vectors.

## Build and packaging

`npm run build` is four steps:

| Step           | What it does                                        |
| -------------- | --------------------------------------------------- |
| `prebuild`     | `rm -rf dist`                                        |
| `typecheck`    | `vue-tsc --noEmit`                                   |
| `build:client` | `vite build` → `dist/client`                         |
| `build:ssr`    | `vite build --ssr` → `dist/server`                   |
| `build:cli`    | `rollup` → `dist/cli.js` + `dist/vendor/`            |

The published package is **`dist/`**, not the repository. The root
`package.json` is `private: true` and stays that way; `npm publish` runs from
`dist/`.

### `packageMeta`

The rollup config's `packageMeta` plugin writes the package that gets
published: a bare `dist/package.json` carrying a picked set of keys from the
root one (name, version, description, engines, license, author, repository,
homepage, bugs, keywords) plus `type: "module"`, `bin: { timeful: "cli.js" }`
and `publishConfig`. It deliberately emits **no `dependencies`** — everything
runtime is bundled at build time, into `cli.js` and the per-package chunks
under `dist/vendor/`, so there is nothing left to install. It also
copies `LICENSE` and `docs/npm-README.md` (as `README.md`) into `dist/`.

The root manifest follows the same rule: its `dependencies` field is
**reserved for packages the published artifact must have installed at
runtime** — none today — and `packageMeta` forwards the field verbatim
whenever it is non-empty (the artifact test pins the two to matching).
Everything that is bundled at build time — `express`, `ws`, `vue`,
`vue-router`, `dayjs` — lives in `devDependencies`, because it is build
tooling from the package's point of view. The trade-off is deliberate: a
checkout always uses plain `npm install`, since `--omit=dev` would leave
`npm run dev` and `npm start` without the server's own packages.

`npm run build:debug` writes a `private: true` stub instead, so a debug `dist/`
cannot be published by accident.

### Things the build will bite you on

- **Rollup must not clean `dist/`.** Vite has already written `client/` and
  `server/` into it. The clean belongs to `prebuild`.
- **The SSR bundle sets `ssr.noExternal`.** An installed copy has no
  `node_modules` for `dist/server/entry-server.js` to `import "vue"` from, so the
  SSR build has to inline its dependencies just as the CLI bundle does.
- **`__TIMEFUL_VERSION__`** is replaced at build time with the version from
  `package.json`. `server/cli/version.ts` falls back to a dev version when the
  identifier is undefined, i.e. when running from source.
- **Assets resolve from the module; data resolves from the CWD.** `paths.ts`
  finds `client/` and `server/` relative to the running entry — beside
  `dist/cli.js` when packaged, `<repo>/dist` in a checkout. `var/` and
  `timeful.config.json` always come from the working directory, which for an
  install is the operator's webroot. Do not reintroduce a CWD lookup for assets.

## Conventions

### TypeScript only, erasable syntax only

Server code is executed as `.ts` by Node's type stripping, which erases types
without evaluating them. That rules out anything with a runtime effect: **no
enums, no namespaces, no parameter properties** (`erasableSyntaxOnly` is on).
Server modules import each other with an explicit `.ts` extension, because Node
resolves relative specifiers literally. Strict mode is on and
`npm run typecheck` must stay clean.

### Shared types live on the client side

`server/types.ts` re-exports the event document and API shapes from
`src/lib/event.ts`, `src/lib/api.ts` and `src/lib/realtime.ts` as type-only
imports, erased before Node ever sees them. One definition, both halves — the
wire format cannot drift. Edit those files, not a server-side copy.

A handful of **runtime** imports cross the same boundary on purpose — the
defaults and rules both halves have to apply identically rather than merely
agree about: `realtimeAllowed` and `normalizeResponses` from `src/lib/event.ts`,
the guest-name rules from `src/lib/user-key.ts`, the path rules from
`src/lib/slug-rules.ts`, and the frame parser and close codes from
`src/lib/realtime.ts`. See
[the module map](/reference/architecture#module-map) for which module takes
which, and why. Adding another wants a reason as good.

**A `src/lib` module the server imports at runtime must use explicit `.ts`
extensions in its own imports.** Node resolves relative specifiers literally, so
an extensionless one there is a crash on startup for the packaged CLI, not a
warning — and nothing in the browser build will tell you, because Vite resolves
it happily.

### Styling: scoped CSS with semantic class names

No Tailwind, no utility classes. `<style scoped>` and class names that say what
the thing is. Every colour comes from a `var(--*)` token in
`src/styles/tokens.css`, declared once as a `light-dark()` pair — **never
hardcode a hex in a component**. Code that needs a colour at runtime resolves it
through computed styles (`src/lib/colors.ts`) rather than parsing the token.

### Theming

`prefers-color-scheme` by default, overridden by `data-theme="light|dark"` on
`<html>` from `localStorage["timeful.theme"]`. The before-first-paint script in
`index.html` is duplicated by hand in the standalone 404 page in
`server/app.ts`; if you change one, change the other.

### Mobile matters

Every view has to work at 360px wide: tap targets ≥ 44px, no horizontal page
overflow, and a finger's drag doing what a finger's drag does everywhere else on
the phone — scrolling. Where a gesture has to mean something other than that,
it is a tap on something 44px wide, and `touch-action: none` goes on that thing
alone rather than on the surface around it.

### Storage goes through `storage.ts`

It is the only module that touches the filesystem. It serialises writes per file
and writes atomically. Bypassing it reintroduces exactly the torn-read and
lost-update bugs it exists to prevent.

### Event URLs are secrets

Generated slugs are the only thing protecting an event. Do not log them, do not
put them in error messages, and do not add anything that would let an
unauthenticated caller enumerate events. Misses go through the tarpit for that
reason; see [the security model](/reference/architecture#security).

### Commits

Plain prose: a short imperative subject, then why the change was needed. No AI
or `Co-Authored-By` signatures. Several focused commits beat one large one.

### Killing processes you started

Track the PIDs of servers and browsers you spawn and kill exactly those
(`kill $(cat pidfile)` or by port: `lsof -ti :<your-port> | xargs kill`).
Never `pkill -f` a repo-generic pattern like `server/index.ts` or
`dist/cli.js` — it kills every Timeful instance on the machine, including a
dev server someone else is using. In dev, `npm run dev` picks the first free
port from 3000–3019 when `PORT` is unset, so parallel instances coexist — and
each instance's HMR WebSocket rides its own HTTP port rather than Vite's fixed
default (24678), so two checkouts never fight over that either.

## Documentation

This site is a standalone VitePress package under `docs/`:

```sh
cd docs
npm install
npm run dev       # http://localhost:5173
npm run build     # -> docs/.vitepress/dist
npm run preview
```

The base path is `process.env.DOCS_BASE ?? "/"`, because GitHub Pages serves a
project site under `/timeful/`. The deploy workflow sets `DOCS_BASE=/timeful/`;
local builds get the root and the links work either way.

`docs/npm-README.md` is a tracked file that becomes the published package's
`README.md`. The root `README.md`, `CLAUDE.md` and `ARCHITECTURE.md` are **not
tracked** — they are pointer stubs kept in the working tree for local tooling,
and this site is where their content lives now.
