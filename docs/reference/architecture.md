# Architecture

This page is the **binding contract** for Timeful: the storage format, the
complete HTTP and WebSocket surface, the routing and SSR rules, the security
design, and how the package is built. It describes what the code actually does. Where an
implementation and this document disagree, one of them is a bug — say which
before changing either.

For the day-to-day of working on the repository — commands, testing, style
conventions — see [Development](/reference/development).

## The shape of the thing

Vue 3 + Vite on the front, Express on the back, **TypeScript everywhere**, JSON
files on disk for storage. One npm package, no workspaces. No database server,
no container runtime, no third-party service in the request path.

Server code runs as `.ts` directly under Node's native type stripping, so all
TypeScript must be **erasable-syntax-only**: no enums, no namespaces, no
parameter properties. `tsconfig.json` sets `erasableSyntaxOnly: true` and strict
mode; Vue SFCs use `<script setup lang="ts">`; `vue-tsc --noEmit` must stay
clean.

Two constraints shape almost every decision below:

- **There is exactly one account.** The owner. Everyone else is an anonymous
  guest holding a link. There is no user table and no registration.
- **Event URLs are capabilities.** Holding the URL is what grants access. That
  is why slugs are random, why misses are tarpitted, and why nothing may leak a
  slug into a log or an error message.

### Module map

```
server/
  index.ts      repo entry for `npm run dev` / `npm start` (~40 lines)
  app.ts        the Express app: API mount, static, SSR page handler, 404, errors
  dev.ts        Vite dev renderer; dynamically imported, never bundled
  paths.ts      locates dist/client + dist/server relative to the entry module
  storage.ts    the only module that touches the filesystem
  auth.ts       scrypt hashing, session tokens, requireAdmin
  slugs.ts      slug alphabet, generation, validation, reserved names
  leases.ts     in-memory slug reservations
  tarpit.ts     per-IP serial miss queue
  realtime.ts   per-event WebSocket rooms, write sessions, the upgrade listener
  not-found.ts  the standalone 404 page, and the one way to send it
  proxy.ts      --trusted-proxy parsing
  config.ts     env-only runtime knobs
  http.ts       small helpers
  types.ts      type-only re-exports from src/lib (see below)
  registry.ts   the npm lookup — one of the two outbound calls (see § The update check)
  push/         Web Push: crypto.ts, vapid.ts, subscriptions.ts, deliver.ts
  routes/       auth.ts, sessions.ts, leases.ts, events.ts, update.ts, push.ts
  cli/          index.ts, args.ts, config.ts, wizard.ts, tui.ts,
                service.ts, discover.ts, upgrade.ts, errors.ts, version.ts
```

`server/types.ts` re-exports the event document and the API shapes from
`src/lib/event.ts`, `src/lib/api.ts` and `src/lib/realtime.ts` as **type-only**
imports, erased before Node sees them. There is one definition of the wire
format and both halves of the app share it.

A handful of **runtime** imports cross the same boundary, each because it is a
rule both halves must apply identically rather than a shape they must agree on:

| Imported | By | Why |
| -------- | -- | --- |
| `realtimeAllowed` (`event.ts`) | `realtime.ts` | "no `realtime` field means on" is one default |
| `normalizeResponses` (`event.ts`) | `storage.ts` | what a legacy file *means* is one reading |
| `publicEvent` (`event.ts`) | `app.ts`, `routes/events.ts`, `realtime.ts` | what a link-holder may see is one rule, and the SSR page must apply the JSON route's |
| `userKey`, `guestNameProblem`, … (`user-key.ts`) | `routes/events.ts`, `realtime.ts` | the dialog must reject what the server rejects, in the same words |
| `slugProblem`, `RESERVED_SUBPATHS` (`slug-rules.ts`) | `slugs.ts`, `routes/events.ts` | same, for paths |
| `parseSaveMessage`, close codes (`realtime.ts`) | `realtime.ts` | one definition of the frame both ends write |

Adding another wants a reason as good. Note that any `src/lib` module the
server imports at runtime must use **explicit `.ts` extensions** in its own
imports: Node resolves relative specifiers literally, and an extensionless one
is a crash on startup for the packaged CLI rather than a warning.

## Storage

Everything lives under `varDir()` — `process.env.VAR_DIR` or `<cwd>/var`.

```
var/credential.json      the single owner account
var/sessions.json        active session tokens
var/links.json           slug -> event id
var/events/<uuid>.json   one file per event, guest answers inline
var/push.json            push subscriptions, across all events
var/vapid.json           the server's VAPID key pair, minted on first use
```

There are no migrations and no schema version. If you change the event shape,
handle old files being read back.

### Atomic writes

`server/storage.ts` is the only module that touches the filesystem, and every
write is:

1. `mkdir -p` the parent directory,
2. write `<file>.<pid>.<6-byte-hex>.tmp`,
3. `rename()` it over the target.

`rename` is atomic, so a reader always sees either the whole old file or the
whole new one — never a torn read. Writes to the same path additionally go
through a per-file async mutex (`withFileLock`), so two concurrent updates
cannot lose each other. Content is `JSON.stringify(data, null, 2) + "\n"`.
Reading a missing file returns a fallback (`null` or `{}`) rather than throwing.

**Going around this module reintroduces exactly the bugs it exists to prevent.**
It is also what makes "copy `var/`" a valid backup of a running server.

### `events/<uuid>.json`

```ts
interface EventDoc {
  id: string;                       // uuid, and the file name
  slug: string;
  name: string;
  type: "specific_dates" | "dow";
  dates: string[];                  // ISO day-start instants, deduped + sorted
  duration: number;                 // hours; the daily window from dates[n]
  timeIncrement: number;            // minutes per slot row
  startOnMonday: boolean;
  realtime?: boolean;               // live updates; ABSENT MEANS TRUE
  createdAt: string;                // ISO
  updatedAt: string;                // ISO
  responses: Record<string, EventResponse>;   // keyed by USER KEY
}

interface EventResponse {
  displayName: string;              // exactly what the guest typed
  availability: string[];           // ISO slot-start instants
  ifNeeded: string[];               // ISO slot-start instants
  updatedAt: string;
  lastEdit?: LastEdit;              // PRIVATE — never served publicly
}

interface LastEdit {
  ip: string;                       // trust-proxy-aware
  userAgent: string;                // sliced to 400 chars
  at: string;                       // ISO; the same instant as updatedAt
}
```

Each entry in `dates` is a day's start instant, one per grid column; `duration`
in hours defines the daily window. Availability entries are slot-start
timestamps aligned to `timeIncrement`.

### The one private field

`lastEdit` records where a response was **last written from**, and it is the
only part of an event document that a link-holder may not read. It is
overwritten in full on every write — the REST `PUT` and a `save` frame alike,
because both go through `writeResponse` — and never merged, since half a stale
origin is a worse answer than none.

::: danger It is stripped at the door, not at the write.
The whole document is public to whoever holds the URL: it is inlined into the
server-rendered page byte for byte. So the exception needs exactly one gate.
`publicEvent` (`src/lib/event.ts`) removes the field, and **every** way a
document leaves the server goes through it — `GET /<slug>/data`, the SSR page,
the `PUT`'s own answer, the `PATCH` answer and every realtime snapshot. The
only caller that does not is `GET /<slug>/details`, which is behind the login
wall and exists to serve exactly this.

It is a shallow copy, deliberately: the argument is the in-memory document the
storage layer just read, and stripping it in place would delete the field from
the next write.
:::

The address is trust-proxy-aware. The `PUT` reads `req.ip`; a write session has
no request left by the time a frame arrives, so the origin is captured at the
**handshake**, and the address for it is resolved through the app's own
`trust proxy` setting rather than the raw peer address — behind nginx the latter
is `127.0.0.1` for every guest, which would make the field useless. The
[tarpit](#the-tarpit) deliberately keeps the peer address: counting misses wants
the one nobody can spoof.

`realtime` and `lastEdit` are the only optional fields. `realtime`'s absence is
meaningful: every
event written before [live updates](#realtime-updates) existed lacks it, none of
them are rewritten, and **absent reads as `true`**. Code asks
`realtimeAllowed(event)` (`src/lib/event.ts`) rather than testing the field, so
the default has one definition that both halves of the app share.

### User keys

A guest's name is two things. The **display name** is exactly what they typed
and the only string anything renders. The **user key** is what the response is
filed under, what a URL carries, and the only string anything matches on:

```
userKey(raw) = trim  ->  casefold  ->  collapse each whitespace RUN to one dash

"  Ada   Lovelace "  ->  "ada-lovelace"
"ada  LOVELACE"      ->  "ada-lovelace"
```

`src/lib/user-key.ts` is the single definition, imported by both halves the way
`slug-rules.ts` is — the identity dialog rejects exactly what the server
rejects, in the same words.

::: danger A raw name may not contain a dash
A dash is what a run of whitespace *becomes*. Allowing one in a raw name would
make `a-b` and `a b` the same key with two spellings and no way to tell which
was meant, and a key that is not injective is not safe in a URL or in a match.
The server answers `400`, and the identity dialog refuses to continue.
:::

A stored record's `displayName` must normalize to the key it is filed under —
`PUT` checks it — so the document cannot hold a row that would render twice or
not at all.

#### Legacy files

There are no migrations and no schema version, so an event written before keys
existed has to be readable as it stands: keyed by the raw name, dashes and all,
with no `displayName` on its records. That missing field is the marker.

Every read goes through `normalizeResponses` (`src/lib/event.ts`, called from
`storage.ts`), which re-files a legacy record under
`legacyUserKey(rawName)` — its dashes read as the spaces they stood in for — and
**grandfathers the raw name as the display name**. Nothing is rewritten to make
that true; the next ordinary write persists it. Two legacy names can normalize
to one key, and only one record survives: the newer `updatedAt` wins, with a
warning that names nobody.

A grandfathered spelling is readable but not writable — it may contain a dash,
which is now illegal — so saving under that key needs a legal name that maps to
it. The identity dialog does that automatically: type "Ada Lovelace", land on
the record that was "Ada-Lovelace", and the spelling is replaced on the next
save.

The `id` must match
`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. Non-uuid
ids short-circuit to `null` in `readEvent`/`updateEvent`/`deleteEvent`, and
`listEventIds` filters on it — so a stray file in `events/` can never be
addressed.

### The other stored files

```ts
// credential.json — absent means "first run"
{ email: string; password: string /* scrypt hex */; salt: string /* hex */ }

// sessions.json
Record<token, {
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;    // sliced to 400 chars
  persistent: boolean;
}>

// links.json
Record<slug, eventUuid>

// push.json — see § Notifications
{
  subscriptions: Array<{
    eventId: string;                    // the uuid, never the slug
    role: "owner" | "respondent";
    userKey?: string;                   // respondent subscriptions only
    endpoint: string;                   // the push service URL — a secret
    keys: { p256dh: string; auth: string };  // base64url, as the browser minted them
    createdAt: string;
  }>
}

// vapid.json — the signing identity push services verify (§ Notifications)
{
  publicKey: string;   // base64url uncompressed P-256 point; served to browsers
  privateKey: string;  // base64url 32-byte scalar; never served, like a session token
  createdAt: string;
}
```

Push subscriptions live in their own file rather than on the event document
deliberately: the document is inlined into the SSR page byte for byte, and an
endpoint URL is a capability to message somebody's browser. Keeping the two
apart means no new exception to `publicEvent` and nothing new that could leak
through it. `vapid.json` is minted once and kept for the life of the data
directory — every subscription is bound to the public key it was created
against, so regenerating the pair would orphan them all. Copying `var/` remains
a complete backup; restoring it restores the subscriptions with it.

The CLI also writes `timeful.config.json` in the webroot. A macOS LaunchAgent
writes `timeful.out.log` / `timeful.err.log` inside `varDir`; the systemd units
name no log files and go to the journal, which is why the hardened tier needs
nothing in the webroot writable except `varDir` itself.

### Zero-record invariant

**An event never stores a response with nothing in it.** A `PUT` whose
`availability` and `ifNeeded` both come out empty *deletes* the response (a
no-op if it was not there). Events only ever contain respondents with at least
one slot, so the respondents list needs no filtering and a guest who clears
their answer disappears from it entirely.

## API

Everything is JSON, in **two namespaces**.

`/api/*` is **global only**: status, auth, sessions, slug leases, the update
check, the push public key, and the event *list* and *create*. Routers mount in
the order `auth` → `sessions` → `leases` → `events` → `update` → `push`, then a
catch-all `404 {"error": "Not found"}`.

Everything addressed **to one event** hangs off that event's own path —
`/<slug>/data`, `/<slug>/settings`, `/<slug>/users/<userKey>`, `/<slug>/ws` —
because the event's URL *is* the capability that grants access to it, and
hanging its endpoints off `/api` only ever obscured that. The event-scoped
router mounts after the static middleware and before the page handler.

::: danger There are no compatibility shims
Nothing keeps the old `/api/events/:id/...` paths. They fall through to the
`/api` catch-all and answer `404`. Any client written against them is broken,
deliberately and visibly, rather than quietly working against two surfaces.
:::

The body parser is `express.json({ limit: "2mb" })`; malformed JSON yields
`400`.

"Admin" below means a valid session cookie; without one those routes answer
`401 {"error": "Not authenticated"}`. "Public" means the URL is the only
credential.

### Auth

| Route | Auth | Body | Response |
| ----- | ---- | ---- | -------- |
| `GET /api/status` | public | — | `{ needsSetup, authed, email? }` — `email` only when authed |
| `POST /api/auth/setup` | public, first run only | `{ email, password, persist? }` | `201 { ok: true, email }` |
| `POST /api/auth/login` | public | `{ email, password, persist }` | `{ ok: true, email }` |
| `POST /api/auth/logout` | public | — | `{ ok: true }`, always; clears the cookie |
| `PUT /api/auth/credentials` | admin | `{ currentPassword, email?, password? }` | `{ ok: true, email }` |

- Passwords must be **at least 8 characters**; emails must match
  `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
- `setup` answers `403 "Already set up"` once a credential exists. `login`
  answers `403 "Setup required"` when none does, and `401 "Incorrect email or
  password"` otherwise — deliberately not distinguishing which half was wrong.
- **Every failing `setup` and `login` goes through the [tarpit](#the-tarpit).**
- `PUT /api/auth/credentials` requires the current password (`401` if wrong —
  this one is *not* tarpitted, since it already required a session), **purges
  every session including the caller's**, and clears the caller's cookie. It
  skips re-hashing when only the email changed.

### Sessions

All admin-only.

| Route | Response |
| ----- | -------- |
| `GET /api/sessions` | `{ token, createdAt, lastSeenAt, userAgent, persistent, current }[]`, newest-seen first |
| `DELETE /api/sessions` | `{ ok: true, deleted: n }` — everything except the current session |
| `DELETE /api/sessions/:token` | `{ ok: true, deleted: 1 }`; `404` if unknown; clears the cookie if it was the caller's |

### The update check

| Route | Auth | Response |
| ----- | ---- | -------- |
| `GET /api/update-check` | admin | `{ current, latest, updateAvailable, problem?, webroot, development }` |

**This is one of exactly two kinds of outbound network call in the entire
application.** The other is [push delivery](#notifications): POSTs of
end-to-end-encrypted notices, made only to endpoints that a browser explicitly
registered and only after something those subscribers asked to hear about
happened. Both are strictly opt-in — a Timeful nobody subscribed to and whose
owner never presses "Check for updates" initiates no connection to anything,
ever. What the update check costs and why it is acceptable:

- It is **admin-triggered and nothing else**. There is no interval, no check on
  page load, no probe at startup. The handler runs when the owner presses
  "Check for updates" in Settings, and at no other moment. An unauthenticated
  caller cannot make this server talk to npm at all — `requireAdmin` is in front
  of the fetch, not after it.
- It runs **server-side** because the registry sets no CORS headers a page could
  use, and because a guest's browser has no business talking to npm on the
  server's behalf.
- It **fails soft**. `https://registry.npmjs.org/timeful/latest`, a 5s
  `AbortController` timeout, and any failure at all — DNS, TLS, timeout, a
  non-2xx, a body with no version — answers `200` with `latest: null` and a
  `problem` sentence. Never a `500`, never a stack trace, and never anything
  taken from the request that asked. An air-gapped box is a supported way to run
  Timeful, not an error condition.
- `current` is the same `VERSION` the CLI reports, so a source checkout answers
  `0.0.0-dev` with `development: true` — and `updateAvailable` is then `false`,
  because a checkout is not behind a release, it is off the release line.
- `webroot` is `process.cwd()`, which for an installed copy *is* the operator's
  webroot ([assets resolve from the module, data from the CWD](#static-assets)).
  It is there so the panel can print the exact command to paste. **No event slug
  ever appears in this response**, and the only path in it is the admin's own.

`updateAvailable` is computed server-side rather than in the browser, so the
panel and `timeful upgrade` cannot disagree about what counts as newer. The
comparison (`server/registry.ts`) is the release triple numerically, with a
prerelease sorting before its release; anything unparseable is never "newer".

### The push public key

| Route | Auth | Response |
| ----- | ---- | -------- |
| `GET /api/push/public-key` | public | `{ key }` — the VAPID public key, base64url |

Global rather than event-scoped, and that placement is the `/api` rule applied
rather than bent: the VAPID pair is a property of the **server** — one signing
identity however many events a browser subscribes from — so it is global state,
and global state lives under `/api`. Public because a public key is public by
definition, and because a respondent subscribing from an event page has no
session to show. The first ask mints the pair (under the file lock, so two
concurrent first asks cannot each mint one); every later ask answers the stored
key, because subscriptions are bound to it.

### Slug leases

Admin-only. See [Slug leases](#slug-leases-1) for what they are for.

| Route | Response |
| ----- | -------- |
| `POST /api/slug-leases` | `201 { slug, expiresAt }` — or `503` after 32 failed allocation attempts |
| `DELETE /api/slug-leases/:slug` | `204`, idempotent |

### Events — the global two

| Route | Auth | Notes |
| ----- | ---- | ----- |
| `GET /api/events` | admin | `{ id, slug, name, type, responseCount, createdAt, updatedAt }[]`, newest-updated first |
| `POST /api/events` | admin | body `{ name, type, dates, duration, timeIncrement, startOnMonday, slug? }` → `201` full event |

### Events — the event's own path

Every `<slug>` below may be **either the uuid or the slug**. The uuid is the
safer choice from a page that might be open across a rename.

| Route | Auth | Notes |
| ----- | ---- | ----- |
| `GET /<slug>/data` | **public** | the full event document, less [`lastEdit`](#the-one-private-field) — this is what the event page reads |
| `GET /<slug>/details` | admin | `{ users: [{ key, displayName, lastEdit }] }`, by display name. The **only** route that serves `lastEdit`, and the login wall the owner's tools sit behind |
| `PATCH /<slug>/settings` | admin | any subset of the create fields, plus `slug` to rename |
| `DELETE /<slug>/settings` | admin | → `{ ok: true }` |
| `PUT /<slug>/users/<userKey>` | **public** | `{ displayName, availability?, ifNeeded? }` → `{ ok, key, response \| null }` |
| `DELETE /<slug>/users/<userKey>` | **public** | `{ ok: true }`; `404 "Response not found"` if the event exists but the guest does not |
| `PUT /<slug>/push` | **mixed** | subscribe this browser for [notifications](#notifications): `{ role, userKey?, endpoint, keys }` → `{ ok: true }`. `role: "owner"` additionally requires the admin session (`401` without); `"respondent"` is public and carries the user key it claims |
| `DELETE /<slug>/push` | **public** | `{ role, endpoint }` → `{ ok: true }`, idempotent — the endpoint named is itself a secret only the subscribing browser ever held |
| `GET /<slug>/ws` | **public** | WebSocket upgrade — the [browse socket](#realtime-updates), read-only. A non-upgrade `GET` is a plain `404` |
| `GET /<slug>/users/<userKey>` | **public** | WebSocket upgrade — the [named write session](#named-write-sessions). A non-upgrade `GET` is a plain `404` |

`data`, `details`, `settings`, `users`, `push` and `ws` are therefore
**reserved sub-segments**.
Slugs themselves are single segments and are unaffected; the reserved-slug list
in `slug-rules.ts` is unchanged.

The `<userKey>` in a path is **re-normalized** rather than taken as given, so
`/…/users/Ada%20Lovelace` and `/…/users/ada-lovelace` address the same record
and nobody can invent a second spelling of one person by hand-writing a URL.

The response routes are public **by contract**: a guest may edit and clear their
own record because the capability URL is the authentication boundary. Gating
them behind anything else would only hide a door that is already open to
everyone holding the link. When the visitor *is* the authed admin, the
respondents list additionally offers a delete button per row — the same public
endpoint.

::: warning Anyone with the link can edit anyone's answer
This is a deliberate trade, and the same one a whiteboard in a hallway makes.
Guest names are not identities and there is no per-guest secret. If that is not
acceptable for your group, do not share the link with that group.
:::

#### Validation

Rejected with `400` and a message:

| Field | Rule |
| ----- | ---- |
| `name` | trimmed, non-empty, ≤ 200 chars |
| `type` | exactly `"specific_dates"` or `"dow"` |
| `dates` | array, non-empty, ≤ 366 entries, each parseable; normalized to ISO, deduped, sorted |
| `duration` | finite, `0 < d ≤ 24` (fractional allowed) |
| `timeIncrement` | integer, `0 < i ≤ 240`, and a divisor of 1440 |
| `startOnMonday` | coerced with `Boolean()`; defaults to `false` |
| `realtime` | must be a real boolean — **not** coerced; omitted on create means `true` |
| `<userKey>` | re-normalized from the path; non-empty, ≤ 100 chars |
| `displayName` | trimmed, non-empty, ≤ 100 chars, **no dash**, and `userKey(it)` must equal the path key |
| `availability` / `ifNeeded` | ISO strings, ≤ 20000 entries each |
| the whole body | ≤ 2 MB |

`ifNeeded` entries that also appear in `availability` are dropped —
availability wins, so the two sets are always disjoint.

#### Slugs on create

A slug claim happens **inside** the `links.json` file lock, so two concurrent
creates cannot both win. `409 "Slug is already taken"` on collision. If writing
the event then fails, the link is rolled back.

::: danger Slugs are never derived from the event name
`POST /api/events` with no `slug` mints a **random** one. A name-derived slug
would be guessable, and a guessable capability URL is not a capability URL.
:::

### Client wrapper

`src/lib/api.ts` sends `credentials: "include"` and throws
`ApiError { message, status, body }` on any non-2xx, taking the message from
the `{ error }` field. `fetchIsAdmin()` fails **closed**.

**Paths are written out in full**, and are no longer prefixed with `/api`
automatically: there are two namespaces now, and a client that guessed between
them would be guessing. The event-scoped ones have builders —
`eventDataPath`, `eventDetailsPath`, `eventSettingsPath`, `userPath`,
`eventPushPath` — so no call site spells one by hand.

## Realtime updates

An event page left open keeps itself current: someone else's answer changes the
heatmap and the respondents list without a reload, and the list shows who is
editing the event right now. It is optional at two levels, and it is **two
sockets**, chosen by whether the page has adopted a name.

| Socket | Path | What it is |
| ------ | ---- | ---------- |
| browse | `GET /<slug>/ws` | a read-only server→client notification channel |
| session | `GET /<slug>/users/<userKey>` | the **edit session** for that key: notifications down, saves up |

Both never reach Express: the listener is on the HTTP server, registered by
`serve()` in `server/app.ts`. A plain `GET` of either path is not an upgrade and
falls through to the event-scoped catch-all as a `404`.

In development the listener is not alone: Vite's HMR WebSocket shares the same
server (`server/dev.ts` hands it to `server.hmr.server`), with Vite's `vite-hmr`
subprotocol telling the two apart. The realtime listener steps aside for any
upgrade carrying that token — checked before it parses the URL or destroys
anything — but only while another upgrade listener actually shares the server,
so in production, where it is alone, its behaviour does not depend on what a
client claims.

### The contract

::: danger The browse socket is read-only, and stays read-only.
No `message` listener is ever registered on a `/<slug>/ws` socket. Bytes a
client sends are read off the wire by the protocol layer and dropped: they reach
no state, no handler and no storage. The only inbound traffic that means
anything is protocol-level — pong frames answering the heartbeat, and close.
**Presence does not bend this**: it comes from write sessions, which are a
different socket at a different URL, so a forged `presence` frame on this one
changes nothing.
:::

::: warning The write session is a sanctioned exception, and only that.
A `/<slug>/users/<userKey>` socket does accept one kind of frame. It is not a
second write path: a `save` runs through `writeResponse`, **the same function
the REST `PUT` calls** — same validator, same zero-record rule, same storage
call — so "validated exactly like the PUT" is a fact about the code rather than
a promise about it. It adds no authentication surface either: the capability URL
is still the whole boundary, exactly as it is for the `PUT`.

The `PUT` and `DELETE` remain fully functional regardless. They are the write
API whenever there is no session, and the fallback whenever one lets a save
down. Disabling realtime, or any WebSocket failure at all, degrades to standard
REST behaviour with **zero feature loss**.
:::

**Identity rides in the URL.** A page that has adopted a name connects to the
session socket, with the key in the path and the spelling to render in
`?name=<urlencoded>`; one that is only browsing connects to `/ws` and carries no
identity at all. The key is re-normalized out of the path, so one person cannot
hold two sessions by spelling their own key two ways. The display name is
connection metadata, validated for shape only — trimmed, and falling back to the
key when empty or longer than the 100-character guest-name limit, rather than
truncated. Adopting a name, switching to another, or going back to browsing all
reconnect, because the handshake is the only place identity can be stated.

### Messages

Server to client, JSON text frames, defined once in `src/lib/realtime.ts` and
re-exported type-only by `server/types.ts`:

```ts
type RealtimeMessage =
  | { type: "event"; event: EventDoc }        // the whole document, responses inline
  | { type: "presence"; people: PresenceEntry[] }  // who is editing, sorted
  | { type: "gone" }                          // the event was deleted; terminal
  | { type: "saved" }                         // one save landed
  | { type: "save-failed"; message: string }  // one save was refused
  | { type: "replaced" };                     // this session was taken over

interface PresenceEntry { key: string; displayName: string }
```

The last three only ever go to a write session. Client to server there is
exactly one frame, and only on a write session:

```ts
interface SaveMessage {
  type: "save";
  displayName: string;
  availability: string[];
  ifNeeded: string[];
}
```

Anything else inbound — a stray text frame, a message type from a newer client,
an `availability` that is not an array — is **dropped without closing the
socket**. Closing would punish a page for speaking a word this server has not
learned yet, and there is nothing to gain by it. A well-formed `save` that fails
validation is different: it is answered with `save-failed` carrying the same
message the `PUT` would have returned, because the autosave engine needs to know
which of its saves settled and how.

**Full snapshots, never deltas.** The `event` payload is byte-for-byte what
`GET /<slug>/data` would return, so the client has one path for "the event
changed" rather than one per kind of change — the same path a refresh takes. A
snapshot goes out after every successful mutation, and only after it is
persisted:

| Mutation | Broadcast |
| -------- | --------- |
| `PUT /<slug>/users/<key>` | snapshot — including the zero-record delete-by-empty, when it removed something |
| a `save` frame | the same, through the same function |
| `DELETE /<slug>/users/<key>` | snapshot |
| `PATCH /<slug>/settings` | snapshot, carrying a renamed slug if it changed |
| `DELETE /<slug>/settings` | `gone`, then the room closes |

A create broadcasts nothing: nobody can be subscribed to an event that did not
exist a moment ago. A clear that cleared nothing broadcasts nothing either — it
is still acknowledged, because the save did land, but no room is woken for it.

### Named write sessions

The session socket **is** the edit session. Claiming one, holding it and losing
it are all properties of the connection, which is what makes the rule below
enforceable at exactly one place.

- **One live session per (event, key).** The room holds a `Map<key, socket>`,
  and the entry *is* the claim.
- **A second claim is refused.** The handshake is completed and the new socket
  is then closed with **`4409 "occupied"`**. Completing the handshake first is
  the point: a close code is readable by the browser, and an HTTP status on a
  refused upgrade is not. The incumbent is not told and not touched.
- **A takeover is asked for, never assumed.** The client that saw `4409` prompts
  — "*&lt;name&gt;* is being edited in another session. Take over?" — and only a
  confirmation reconnects with `?takeover=1`. The server then sends the
  incumbent `{ type: "replaced" }`, closes it with **`4410`**, and admits the
  newcomer. The evicted page explains what happened, drops to the group view,
  and does **not** reclaim: two pages taking turns forever is worse than one
  page saying so once.
- **A frame from an evicted session writes nothing.** The claim is re-checked
  when the frame is read, not when it was sent.
- **A closed session frees the key**, so the next claim needs no takeover.

::: warning Exclusivity is a property of sessions, so it needs sessions.
With the event's live updates off, or the server-wide switch off, there are no
sockets, no sessions, and **no exclusivity**. Two browsers answering as one
person is then last-write-wins over the REST `PUT` — exactly the behaviour the
app had before write sessions existed, and exactly what the warning under
[§ API](#api) has always said about guest names.
:::

Browse sockets take no part in any of this. They claim nothing, block nothing,
and appear in no presence list.

### Presence

A room knows who holds a session in it, and a `presence` message goes out
whenever that changes: somebody claimed a key, somebody's session closed, or a
session was terminated by the heartbeat. A newly connected page is sent the
current list immediately — including itself, if it claimed a key — so the list
is never waiting on somebody else to move.

- **By key, rendered by name.** Each entry carries both. Matching a presence
  entry against a respondent, and against the visitor's own identity, is exactly
  what a key is for; the display name is only ever printed. Where a key has both
  a stored answer and a session, the **stored** `displayName` wins — a page
  shouting "ada LOVELACE" must not rename the row the group knows as "Ada
  Lovelace".
- **One entry per key.** Exclusivity makes that automatic: a key has at most one
  session, so there is nothing to refcount.
- **Never persisted.** Presence lives only in the room. Nothing is written to
  disk, there is nothing to clean up after a restart, and an event document has
  no presence field.
- **Nothing rests on it.** Names are self-asserted, exactly like the name on a
  response: anyone holding the capability URL could already write a response
  under any key they liked — the capability URL is the trust boundary, below.
  Presence decides which row gets a pair of dots beside it, and that is the whole
  of its authority.
- **Off means absent, not empty.** With the event's live updates off, or the
  server-wide switch off, there are no sockets at all and so no presence —
  the same page as before the feature existed.

### Rooms, and the two switches

Rooms live in an in-memory `Map<eventId, { sockets, sessions, displayNames }>`,
keyed by the **uuid** and never the slug — a rename must not orphan its
subscribers. A room is deleted when its last member leaves. The server pings
every socket every 30s and terminates any that did not answer the previous
round; the close that follows is the same exit any other departure takes, so a
reaped session leaves the presence list — and frees its key — with it.

**Per event.** `EventDoc.realtime` is the primary control, set by the owner in
the create/edit dialog and defaulting to on ([absent means
true](#events-uuid-json)). An event with it off is refused at the upgrade and
never broadcast to — the check sits inside `broadcastEvent`, so a new call site
cannot forget it. Switching it off via `PATCH` closes that event's room with a
normal close rather than `gone`: the event still exists and is still answerable
over REST, so `gone` would be a lie.

**Server-wide.** `realtime` in `timeful.config.json`, overridden by
`TIMEFUL_REALTIME`, is a kill switch above that. Off means **no upgrade listener
is registered at all**, whatever the individual events say.

Both switches take the write sessions with them, and with the sessions goes the
exclusivity — see the warning under
[Named write sessions](#named-write-sessions).

### Security

The capability URL remains the entire auth boundary, and subscribing is
deliberately no cheaper to scan than fetching. Both sockets are treated
identically here:

- an upgrade must resolve a uuid or slug through the same lookup the public
  `GET` uses;
- an upgrade that **fails to resolve** joins the same per-IP
  [miss tarpit](#the-tarpit) an HTTP miss does — the shared `missTarpit`, not a
  second copy — and the socket is destroyed after the delay, or immediately once
  that IP is over the queue cap. Because the tarpit runs before any HTTP status
  is written, a scanner cannot tell "no such event" from "realtime is off" any
  faster than it can guess the slug;
- an upgrade that resolves an event whose live updates are **off** gets a plain
  `403` and **no** delay. Whoever asked has already proved they hold the
  capability URL by naming an event that resolved, so it is not a scan, and
  queueing it would only punish a page that is behaving;
- so does `4409`: being told a key is occupied costs nothing, because naming a
  key that resolved is not a scan either. It leaks that *somebody* is editing
  under that key, which is the same thing the presence list already says out
  loud to every holder of the URL;
- accounting uses `req.socket.remoteAddress`. An upgrade never reaches Express,
  so there is no `req.ip` and no trust-proxy evaluation behind it. Behind a
  reverse proxy that groups every client under the proxy's address — which costs
  a shared queue on **misses only** and never delays a real subscriber — and it
  is unspoofable in exchange;
- inbound frames are capped at **2 MB**, the same limit `express.json` puts on
  the `PUT` body. It used to be a kilobyte, when nothing a client sent was ever
  read; a `save` carrying two arrays of up to 20000 ISO timestamps needs the
  room the equivalent request has always had, and being more generous than the
  REST route would be a hole rather than a courtesy. permessage-deflate stays
  off.

Slugs are never logged here either.

### The client

`connectRealtime(eventId, options)` in `src/lib/realtime.ts` returns a handle
with `setSession()`, `save()` and `close()`. It is silent by design — there is
no connection indicator anywhere in the UI, because a page whose socket never
opened has to look exactly like one that never had a socket. The two session
dialogs are the exception that proves it: they are about somebody *else* holding
the edit session, which is a fact about the group rather than about the network.

- **Never during SSR.** No `window` means no URL to derive and no connection; a
  socket per server-rendered page would be a denial of service against
  ourselves. The inert handle answers everything the real one does, and `save()`
  returns null.
- **Backoff.** Reconnects at 1s, 2s, 4s … capped at 30s, each spread over ±25%
  jitter. A restart drops every open page at the same instant, and without the
  jitter they would all come back at the same instant too.
- **It gives up.** After `MAX_FAILED_ATTEMPTS` (8) consecutive attempts that
  never connected, it stops for good; any successful open resets the count. The
  browser cannot see the `403` from a switched-off event — a refused upgrade is
  just a close — so without this a page would knock every 30 seconds for as long
  as it stayed open.
- **Terminal states.** An explicit `close()` and a `gone` message both stop it
  permanently.
- **`setSession(session, { takeover })`** reconnects under a new identity
  straight away — not on the backoff schedule, since the visitor just did
  something deliberate — resetting both counters, and does nothing when nothing
  has actually changed. `takeover` is spent on exactly one attempt, so a later
  reconnect can never quietly evict whoever holds the key by then.
- **`4409` and `4410` are not failures.** Either drops the connector to the
  browse socket and reconnects immediately, without spending an attempt: the
  page keeps seeing the event while its owner decides what to do.
- **A drop clears presence.** `onPresence([])` fires when the connection goes,
  because dots beside a name the page can no longer vouch for are worse than no
  dots at all. A `setSession` switch is not a drop and clears nothing: the new
  connection's own list is a moment away.

#### Saving over it

`handle.save(payload)` returns a promise that settles on `saved` or
`save-failed`, and **null** when there is no session to send over. Null is not
an error; it is the caller's signal to use the `PUT`.

`createSaveTransport` (`src/lib/save-transport.ts`) is the whole of the choice,
and the rule is one line: a **transport** failure falls through to REST, a
**refusal** does not. A dropped connection mid-edit is something the guest should
never have to notice, and REST will almost certainly work; a payload the server
refused would be refused identically by REST, so it goes to the status
indicator, where a bad answer belongs. A save that is never acknowledged times
out after 15s and counts as a transport failure.

**The sync engine is untouched by any of this.** `createSyncEngine`'s
coalescing, retry, baselines and era counter all work off a single `save`
promise; the transport is a wrapper around that promise, not a change to it, and
the four indicator states mean exactly what they meant before over either pipe.

#### The page

`EventPage.vue` connects on mount by uuid (stable across renames) and feeds
snapshots through `applyEvent`, the same function the edit dialog and `refresh`
use: it swaps the document, updates the title, and corrects the address bar with
`replaceState` on a renamed slug. `gone` clears the event and shows a short
"Event deleted" panel instead of leaving the scheduler autosaving into a 404.

It owns the socket, so it also owns the presence list and the two session
dialogs. `EventScheduler` reports its adopted identity upwards (`@identity`,
from a watcher, so it fires *after* the flush a switch begins with), asks for the
session again when "My availability" is re-entered (`@claim`), and takes the
presence list back down as a prop along with a `writer` — one method, `save`,
and no more of the handle than that. On `4409` the page steps the scheduler back
to the group view and asks; on `replaced` it does the same and explains.

`RespondentsPanel` merges presence with the respondents, by key:

- every online person gets three CSS-animated dots and a visually hidden
  " (online)", the visitor's own row included — `prefers-reduced-motion` gets the
  same three dots without the animation;
- somebody online who has **not** answered is shown as a row of their own, with
  the person icon whatever slot is active (they marked nothing, so "unavailable"
  would be a lie about them), no delete button, and no place in the `M/N` count
  or the heatmap's maximum — both of which are computed from the response index,
  which presence never enters. Clicking the row still offers to answer as them.

That `M/N available` count is **desktop-only**, for the reason the hover
highlight is: it says how many are free at the slot under the pointer, and on a
phone the list is a sheet *over* the chart, so there is no slot being pointed at
and the number could only be stale or the whole roster. The per-row glyphs are a
different thing and stay — a slot pinned by a tap before the drawer was opened
still has an answer for each person in it, and the slot's own label still heads
the sheet when there is one. With neither, the drawer's list starts at the top
of the sheet with no rule and no held-open gap above it.

An incoming snapshot deliberately **does not** touch a visitor's half-finished
answer. The marks live in `EventScheduler`, which re-seeds from a new document
only when it asked for one (`awaitingIdentityRefresh`), and the current identity
is layered back over the group's answers by the response-index override. The edit
dialog is safe for a related reason: its form seeds from the prop once and never
watches it.

## Notifications

A closed page can still hear about an event, over **Web Push**: the owner can
ask to be told when responses change, and a respondent can ask to be told when
the event itself changes. Strictly opt-in per browser, end-to-end encrypted,
and involving **no third-party account** — delivery goes through the push
service the subscriber's own browser vendor already operates (that is what a
`PushSubscription` is), and Timeful signs its deliveries with a key pair it
minted itself.

### The two roles

A subscription belongs to one browser, one event, and one role, and the role
decides what it is told:

| Role | Who may subscribe | Notified when |
| ---- | ----------------- | ------------- |
| `owner` | admin session, on top of the URL | a response is added, edited, cleared or removed — through `writeResponse`, so the REST `PUT` and a realtime `save` frame trigger identically |
| `respondent` | public, carrying the user key it claims (re-normalized like a path key) | the event's details change — name, dates, window, slot size, type, or the slug, which invalidates the saved link — or the event is deleted. A `PATCH` that only touches `realtime`, or restates what is already there, says nothing |

The subscribe route is `PUT /<slug>/push` and the pair is upserted on
(event, role, endpoint), so re-subscribing renews in place. Misses tarpit
exactly like every other public event route. A per-event ceiling (200
subscriptions) keeps a link-holder from growing `var/push.json` without bound;
past it the route answers `429`.

### What a delivery is

One HTTP POST per subscription, to the subscription's own endpoint:

- the body is the notice — `{ title, body, url }`, the event's name, one plain
  sentence, and the event's path — encrypted to that one browser with
  **RFC 8291 `aes128gcm`** (ECDH on P-256 against the subscription's `p256dh`
  key, HKDF per RFC 8188, a single AES-128-GCM record). The push service
  relaying it can read none of it;
- `Authorization: vapid …` carries an ES256 JWT (**RFC 8292**) whose `aud` is
  the endpoint's origin — never the full endpoint — with a 12-hour `exp` and a
  `sub` naming the project. The key pair lives in `var/vapid.json`, minted on
  first use;
- `TTL: 86400` — a phone that was off overnight should still hear that the
  plan moved — and `Urgency: normal`.

Both halves of the crypto are hand-rolled on `node:crypto`, because the
published package bundles everything and depends on nothing. The encryption is
pinned to the **RFC 8291 Appendix A test vectors** in `server/push/crypto.test.ts`,
and the route tests prove the whole loop — subscribe, trigger, deliver —
against a local stand-in push service, decrypting the delivery with the test
subscription's own keys.

### Fire-and-forget, coalesced

A trigger schedules a notice and returns; the HTTP request that caused it can
neither block on delivery nor fail because of it. Notices then wait out a
short quiet time per event and audience (`TIMEFUL_PUSH_COALESCE_MS`, default
3s) — autosave means one guest painting their week is a stream of writes
seconds apart, and a notification per write would teach the owner to turn
notifications off. The names involved are collected while the notice waits,
so one notice says "Ada and Grace updated their availability." Deletion skips
the wait — there is nothing further to coalesce with — and drops every
subscription the event had once the notice is out.

Deliveries run through one serial queue. A push service answering **404 or
410** is saying the subscription is dead, and it is pruned through the storage
layer; anything else — a 5s timeout, DNS, a refused connection, a 5xx — is
dropped silently, because delivery is best-effort by design and an endpoint
must never reach a log, so there is nothing useful a log line could say.

### The endpoint is the one client-chosen URL the server POSTs to

So it is validated strictly: **https only**, with plain http allowed for
loopback hosts alone (development, and the delivery tests). Browsers never
mint anything else. Endpoints are stored, matched and pruned — treated
exactly like session tokens, never logged and never served back out; there is
deliberately no route that lists subscriptions.

::: tip The payload names the slug, and that is within the trust boundary
The click-through `url` in a notice is the event's path. The payload is
encrypted end to end to one subscribing browser, and that browser holds the
capability URL already — it subscribed from it. Nothing is disclosed to the
push service in the middle, which sees only ciphertext, headers and its own
endpoint.
:::

### The service worker, and the manifest

Push needs somewhere to land when no page is open, so the client registers
`public/push-sw.js` — **at opt-in, never on page load**, and the permission
prompt likewise fires only from an explicit press on the bell. The worker
handles `push` (show the notification) and `notificationclick` (focus a tab
already on the event, or open one) and nothing else.

::: danger No fetch handler, no cache — deliberately, and it stays that way.
Every page in this app is server-rendered from live state behind a capability
URL. A caching service worker would be a machine for serving stale documents
with no offline story to show for it, and is the reason "service worker" sat
on the out-of-scope list for so long. This worker is a push receiver, not a
proxy: adding a `fetch` handler to it is a contract change, not a tweak.
:::

The web app manifest exists for the same feature: **iOS delivers push only to
a page added to the home screen**, and adding wants a manifest and real PNG
icons. `start_url` is deliberately absent, so an install opens the page it
was made from — an event page for a respondent, the admin app for the owner —
rather than dumping everyone on `/`.

### Nothing to configure

There is no notifications switch, env var aside (`TIMEFUL_PUSH_COALESCE_MS`
exists for tests). The feature is inert by construction: with no
subscriptions there are no deliveries, no key pair is minted until a browser
first asks for the public key, and a server nobody subscribed to makes no
outbound connection at all. The bell renders only where push can actually
work (`isSecureContext`, a service worker, a `PushManager`); everywhere else
the page simply has no bell.

## Security

### Capability URLs

A generated slug is **12 characters of crypto-random base62** (`0-9A-Za-z`) —
about **71 bits**. Generation uses `crypto.randomBytes` with rejection sampling
(bytes ≥ 248 are discarded) so the alphabet is not skewed. Allocation retries up
to 32 times against `links.json` and live leases before giving up with `503`.

Custom slugs are allowed, admin-only, and validated by `slugProblem`:

- non-empty, ≤ 80 characters;
- must match `/^[A-Za-z0-9][A-Za-z0-9-]*$/` — letters, digits and hyphens only,
  starting with a letter or digit (a leading `_` or `.` gets its own message);
- not `api` or `assets`, compared case-insensitively.

A custom slug is a deliberate downgrade: `/standup` is guessable in a way that
`/7Kq2mWx9Az0P` is not.

Holding the URL is the whole of the access control, so:

- the site is `Disallow: /` in `robots.txt` and event pages carry
  `<meta name="robots" content="noindex">`;
- slugs must never be logged, and never appear in an error message;
- nothing may be added that lets an unauthenticated caller enumerate events.

### Slug leases

The admin's create-event form needs to show the URL *before* the event exists,
so `POST /api/slug-leases` reserves a fresh random slug for 15 minutes
(`LEASE_TTL_MS`). Creating the event consumes the matching lease;
`DELETE /api/slug-leases/:slug` releases it early when the admin types a custom
path instead.

Leases live in an in-memory `Map` and are **never persisted** — they are lost on
restart, which is correct: a reservation for a form nobody is filling in any
more should not survive. Expiry is swept lazily on every read; there are no
timers. Duplicate checks on create and rename consider `links.json` **and** live
leases.

### The tarpit

Guessing a 71-bit slug is not feasible, but the tarpit removes the incentive to
try and blunts anything cheaper.

**What triggers it** — any request whose slug or event fails to resolve:

- the SSR page handler, on any HTTP method;
- the public event-scoped routes — `GET /<slug>/data`, `PUT`/`DELETE
  /<slug>/users/<key>`, `PUT`/`DELETE /<slug>/push` — and the event-scoped
  catch-all, on any method;
- a WebSocket upgrade to either socket whose event does not resolve;
- failed `POST /api/auth/setup` and `POST /api/auth/login`.

The admin-only `GET /<slug>/details` and `PATCH`/`DELETE /<slug>/settings` are
**not** in that list, for the same reason no admin route ever has been: the caller is already
authenticated, so delaying them buys nothing and only makes the panel feel
broken when a stale tab asks about a deleted event.

**What it does** — misses enter a per-IP **serial queue**. Each waits for the
one before it, then sleeps `MISS_DELAY_MS` (default 100 ms) before its 404. When
an IP already has `MISS_QUEUE_CAP` (default 10) requests pending, further ones
get an immediate **429** with `Retry-After`, and no delay is spent on them.
Queue entries are deleted when an IP's pending count reaches zero, so rotating
source addresses cannot grow the map. If the response is already finished after
the delay, nothing is sent.

**What is never delayed** — requests that resolve to a real event, existing
static files, admin-only routes (which never call the tarpit at all), unknown
`/api` routes, and a hit answered with a non-read method.

The serialisation is per-IP on purpose: a group of guests behind one NAT is the
normal case, and one person mistyping a link must not slow the rest of them
down. A hit is never delayed, so ordinary use never touches this machinery.

::: tip Two footnotes worth knowing
A request for a **missing static file** (`/nope.js`) is not a static hit — it
falls through to the page handler, fails to resolve as a slug, and *is*
tarpitted. And `MISS_DELAY_MS` / `MISS_QUEUE_CAP` are read **once at process
start**; changing them needs a restart.
:::

### Passwords and sessions

- **Passwords**: `crypto.scrypt` with Node's defaults (N=16384, r=8, p=1), a
  16-byte random salt and a 64-byte derived key, compared with
  `timingSafeEqual` after a length check.
- **Session tokens**: `crypto.randomBytes(32)` hex — 256 bits.
- **The cookie** is named `session`, with `httpOnly`, `SameSite=Lax`, `path=/`,
  and `secure` set from `req.secure` — that is, whenever the request arrived
  over TLS or a *trusted* proxy said it did. A persistent session additionally
  gets `Max-Age` of 90 days; a non-persistent one is a browser-session cookie.
- `lastSeenAt` is refreshed fire-and-forget on each authenticated request.
- Sessions **never expire server-side**. Only the persistent cookie's `Max-Age`
  bounds them, and changing the email or password purges all of them.
- There is **no CSRF token**. `SameSite=Lax` is the whole defence, which holds
  because every state-changing admin route is a non-GET request and the public
  routes have nothing to forge — anyone who can make the request already has the
  capability URL.

### Trusted proxies

`--trusted-proxy=<ip-or-cidr>[,…]` decides who may speak `X-Forwarded-For` and
`X-Forwarded-Proto` on a client's behalf. It is wired straight into Express's
`trust proxy`, so `req.ip` becomes the rightmost entry the trusted chain did not
vouch for, and `req.protocol` / `req.secure` follow the forwarded scheme.

- Default: loopback — `127.0.0.1` and `::1`.
- Values are **IPs and CIDR ranges only**. Hostnames are rejected: resolving one
  at request time would put DNS in the trust path.
- `none` (case-insensitive) disables forwarded headers entirely and cannot be
  combined with other values. An empty list is an error.
- The `loopback` alias exists only in the packaged CLI's config and wizard,
  where it is expanded to the two literal addresses before Express sees it. The
  repo entry (`npm start -- --trusted-proxy=…`) takes literals only.
- `trustedProxy` has **no environment-variable override** — config file or flag.

Get this right, or the per-IP tarpit either sees your proxy's address for every
client or believes whatever a client claims. See
[Configuration](/guide/configuration#trusted-proxy).

## Routing / SSR

There are exactly four kinds of URL.

### `/` — the admin app, client-rendered

`GET`/`HEAD` return the template with the SSR placeholders replaced by empty
strings: no `data-ssr`, no `window.__EVENT__`, the title left as `Timeful`. The
client then shows Setup (first run) → Login → the admin panel. Any other method
on `/` gets the 404 page, with no delay.

### `/api/*` — the global API

Described [above](#api). Unknown routes under it answer
`404 {"error": "Not found"}` immediately — which is what every one of the old
event-scoped paths now gets.

### `/<slug>/…` — an event's own endpoints

`data`, `details`, `settings`, `users`, `push` and `ws` are the reserved
sub-segments. The
event-scoped router is mounted after the static middleware (so a real file under
`/assets/…` is still a file) and before the page handler (which owns
single-segment paths).

The first segment resolves as a uuid or a slug through `resolveEvent`, the same
lookup the public `GET` uses. Two decisions follow, and they are independent:

| | first segment resolves | does not resolve |
| --- | --- | --- |
| **known sub-path** | the route runs | [tarpit](#the-tarpit), then `404 {"error": "Event not found"}` |
| **unknown sub-path** | `404`, immediately — the capability is proven, so there is nothing to punish | tarpit, then `404` |

**Shape** is decided separately from delay: a reserved sub-segment is an API
client and gets JSON; anything else is a browser following a stale or mistyped
link and gets the 404 *page*. This router sits in front of the page handler for
every multi-segment path, so without that distinction a mistyped link would
answer a person with raw JSON.

### `/<anything else>` — an event slug

`resolveSlugPath` takes `decodeURIComponent(path.slice(1))` and rejects it if
the encoding is malformed, or if the result is empty, contains `/`, or contains
`.`. What survives is looked up in `links.json` and then read from disk.

| Outcome | Response |
| ------- | -------- |
| miss (any method) | [tarpit](#the-tarpit), then the 404 page — or 429 |
| hit, non-read method | the 404 page, immediately, no delay |
| hit, `GET`/`HEAD` | 200, server-rendered event page |

An SSR hit renders `EventPage` and then transforms the template:
`<div id="app">` gains `data-ssr`, `<!--app-html-->` becomes the rendered
markup, the `<title>` becomes `<event name> · Timeful` (HTML-escaped),
`<!--app-head-->` becomes the meta block, and a
`<script>window.__EVENT__ = …</script>` is inserted before `</body>`. That
serialisation escapes `<`, U+2028 and U+2029.

The **entire** event document, responses included, is inlined into the page.
That is the point — the grid is populated on first paint with no round-trip —
but it means anything ever added to the document is public to link-holders. The
one exception is `lastEdit`, and the page takes the same strip the JSON route
does, from the same function: see
[the one private field](#the-one-private-field). Anything else added had better
be public, or it needs the same treatment.

Injected meta: `robots=noindex`, a description, `og:type`, `og:site_name`,
`og:title`, `og:description`, `og:url`, and the `twitter:` card equivalents.

The interactive grid mounts client-side only, which sidesteps server/client
timezone hydration mismatches.

### Static assets

Mounted after `/api` and before the page handler:

- `/assets` → `<root>/client/assets` with `immutable, max-age=1y`;
- then `<root>/client` (favicon, `robots.txt`, `manifest.webmanifest`,
  `push-sw.js`, the `icons/`), both with `index: false` so the page handler
  keeps ownership of `/`. The service worker is deliberately in this
  un-hashed, un-immutable tier: its URL must be stable for the registration to
  update in place.

In dev these are replaced by Vite's middleware, plus `transformIndexHtml` and
`ssrLoadModule` for the SSR entry.

**Asset paths resolve from the module, never the CWD.** `server/paths.ts` walks
outward from `import.meta.url` — `entryDir`, `entryDir/dist`, `../dist`,
`../../dist` — and takes the first that contains `client/index.html`. That is
beside `dist/cli.js` in an install and `<repo>/dist` in a checkout. `var/` and
`timeful.config.json`, by contrast, always resolve from the working directory,
because for an installed copy that is the operator's webroot.

### The 404 page

`NOT_FOUND_HTML` is fully self-contained: inline CSS using `light-dark()` with
`data-theme` overrides, the inline `localStorage["timeful.theme"]` script,
`noindex`, and links to `/favicon.ico` and `/`. It depends on no bundle, so it
still renders correctly when the request never got near one. Its theme script is
a hand-maintained copy of the one in `index.html` — change one, change the
other.

### Errors

The error middleware takes an integer 400–599 from `err.status`, falls back to
400 for a body-parse failure and 500 otherwise. Anything ≥ 500 is logged and
answers "Internal server error". `/api*` gets JSON; everything else gets plain
text.

## Client model

- Availability is held in memory as a `Set<epoch-ms>` of slot-start instants at
  `timeIncrement` granularity. `availability` and `ifNeeded` are mutually
  exclusive sets, serialised to the API as ISO strings. Vue 3 tracks `Set`
  mutation natively — do not reintroduce `new Set(...)` reassignment.
- `dates` are UTC day-start instants, one per column; the client derives the
  start and end hours from `dates[0]` and `duration`.
- Days-of-week events map onto a fixed reference week, **2018-06-17 to
  2018-06-24**, via `dateToDowDate`. It is arbitrary and load-bearing: stored
  DOW events reference it.
- The grid uses a **single delegated pointer handler** on the container with
  pixel→(row, column) hit-testing, not per-cell listeners.
- **Selecting is two gestures, one per hand.** A mouse paints by dragging: the
  rectangle between press and release is committed in one go. A finger cannot,
  because that drag is the only way to scroll a chart bigger than the screen — so
  on touch the drag belongs to the platform, and a **tap** marks its cell and
  leaves **drag handles** on the opposite corners of the rectangle to grow it
  with. `touch-action: none` appears in exactly one place, under those handles.
  Both paths reach the same commit, the same floating options and the same undo.
  **Both mean something in the group view too**, where the rectangle they draw
  is read rather than painted — see the region summary below. The grab-pan
  therefore lives on the headings and the gutter in both modes: wherever a drag
  over the cells means something, it cannot also mean panning.

  ::: warning The options strip is `max-content` wide and clips nothing.
  It is absolutely positioned, so without a width it is shrink-to-fit — sized
  against whatever is left of the containing block — and how an engine resolves
  the minimum width of a flex row is exactly the thing engines disagree about.
  WebKit came out narrower than Chromium, and the `overflow: hidden` the strip
  used to carry turned that disagreement into missing controls: "Available" cut
  off mid-word and the undo and the dismissal not drawn at all. `MENU_WIDTH`
  and `MENU_WIDTH_TOUCH` are now a **floor** for the placement clamp rather than
  the answer — the box is measured once it exists and the larger wins — because
  they are also a guess about text set in the platform's own UI font, and the
  same three words are wider on iOS. Every glyph in the strip additionally
  carries `width`/`height` attributes at its usage site: an inline SVG with only
  a `viewBox` has no intrinsic size, so a missed CSS rule would size it to a
  default box wide enough to shove the rest of the strip out of the chart.
  :::
- A resize commits on every step, so its undo is a record that **grows** rather
  than a snapshot taken once (`selectionStep` in `src/lib/grid.ts`): a cell is
  recorded the first time the rectangle takes it in and never again, since after
  that what it holds is the selection's own doing. Cancelling therefore restores
  the state the tap interrupted however far the handles travelled, and a deletion
  region dragged over a mixed block puts each mark back as its own kind.
- **Undo and redo are one stack, and it belongs to the edit session**
  (`lib/history.ts`). An entry is a pair of those same records over one set of
  slots — what they held before an action and what they hold after it — so undo
  replays the first and redo the second, both as the chart's own `paint` and
  `flip` emits. Nothing reaches the marks by any other route, and so nothing
  reaches the server by any other route either: an undo autosaves exactly as a
  drag does. Every commit carries the id of the gesture that made it, and one
  gesture is one entry however many times it commits — a tap, every step of a
  handle drag across it, and whatever the options strip is then told the
  rectangle means, are one thing to take back. The stack holds 100 entries, is
  created empty when a name starts editing and is emptied on every way out:
  the view switch, "just browsing", answering as somebody else, and the page
  closing. Reached from cmd/ctrl+Z and cmd/ctrl+shift+Z (never both modifiers,
  never with alt, and never while a field or a dialog has the keystroke), from
  the arrow on the floating options — which asks for "the last action" rather
  than replaying its own rectangle, so the two cannot disagree — and from a pair
  of buttons in the phone's settings drawer, disabled rather than hidden when
  there is nothing left to do.
- Every column is laid out once inside a **native scroll container**, which the
  track may rest anywhere on — there is no paging and no snapping. Native
  because `getBoundingClientRect()` already carries the scroll offset, so
  hit-testing stays correct mid-scroll, and because momentum, shift+wheel and
  keyboard scrolling come with it. The time gutter and the day headings sit
  inside that container, pinned with `position: sticky` on their own axis. A
  paint drag — or a handle drag — held at a clipped edge glides the scroll
  position under it, quantised to whole columns under `prefers-reduced-motion`.
- How many columns a viewport holds is a fact about the layout on a desktop — a
  week — and a question about the screen on a phone. `perViewFor` (`grid.ts`)
  divides the width by a target column width measured against the **column
  heading**: the header's height is fixed, so a label too wide for its column
  wraps and pushes the weekday out of sight rather than making room. 360px holds
  six columns, 430px eight.
- Below **820px** the event page is an app rather than a document: the page
  itself does not scroll, the chart fills the space between the header bar and
  the identity bar and scrolls inside it on both axes, and the respondents, the
  view settings and — for an owner — the [admin tools](#the-owner-on-an-event-page)
  each move into a bottom-sheet drawer. **Every way of reading the chart** —
  the zone, the clock, the legend and the best-times filter — lives in the
  settings drawer there rather than in the chart's foot, because a foot row of
  a fixed pane costs grid. The drawer also carries the one control a phone
  cannot get from a keyboard: undo and redo, while the edit view is the one
  open. Clearing your own answer goes the other way, onto the identity bar
  beside the name it wipes. Nothing is then left for the foot to hold, so on a
  phone **there is no foot at all** rather than an empty row.

  The best-times filter is the one of those that used to sit on the chart's
  edge, in the slot the clear button holds. It is not an action on the chart,
  it is a way of reading one, so it stands with the clock on the desktop's foot
  and in the settings drawer on a phone — one home per layout, and in both of
  them beside its peers.
- **The keyboard covers the page; it does not resize it.** The viewport meta
  says `interactive-widget=overlays-content`, so raising a keyboard leaves
  `dvh`, the layout and the chart's column geometry exactly where they were.
  Under `resizes-content` — what it used to say — every tap on a field re-laid
  the whole phone layout out and dropped it back again on dismiss.
  What must stay visible above the keyboard instead pads itself off
  `--overlay-bottom` (`tokens.css`), which is
  `max(env(keyboard-inset-height), var(--keyboard-inset), var(--safe-bottom))`
  — the larger and never the sum, because an open keyboard covers the home
  indicator and the two keyboard signals describe one keyboard. Chromium fills
  the first, but only after `navigator.virtualKeyboard.overlaysContent = true`;
  iOS Safari fills neither, so `src/lib/keyboard.ts` measures
  `innerHeight - visualViewport.height - visualViewport.offsetTop` on the
  visual viewport's own resize and scroll, one write per animation frame, and
  publishes `--keyboard-inset` on `<html>`. Subtracting `offsetTop` is what
  handles iOS panning the page to a focused field: a fixed element is still
  placed against the layout viewport, so the pan is not room the sheet gained.
  A pinch shrinks the visual viewport identically and is read as **no**
  keyboard — pinch-to-zoom is not taken away here. `Dialog` is the only
  consumer, because it is the only fixed overlay that holds a field: the
  backdrop's bottom padding lifts a centred prompt, a sheet takes the inset as
  its own bottom padding so its surface still reaches the screen edge, and both
  cap `max-height` by it so a long form scrolls inside the panel. A field
  focused inside one is scrolled into view with `block: "nearest"`.
- **A region of the group's answers, read as one.** The column beside the chart
  answers for one cell, and on a phone it is behind a drawer besides. A drag
  (mouse) or a tap (touch, with the same handles editing gets) selects a region
  in the group view, and a card over the chart names who can make **all** of it,
  in the respondents list's own glyphs. `regionDigest` in `src/lib/grid.ts` is
  the rule: a person is unavailable if a single cell of the region is,
  if-needed if they are free throughout but qualified anywhere, and available
  only if every cell is an unqualified yes — so "4 of 9 free" is four people who
  can make the whole span. A one-cell region is exactly the old slot reading,
  and `slotDigest` is that function with one slot in it. The card does not
  auto-hide; it goes with its region, which a press outside it or its own cross
  takes away. A plain **click** with no drag still only pins, and a chart with
  no region on it hovers, tooltips and pins exactly as it did before regions
  existed.
- An **eye** on every row of the respondents list puts that one person's answer
  on the chart alone, since a heatmap is a sum and a sum cannot say who is
  behind it. It is a view of the chart rather than a mode of the list
  (`lib/isolation.ts`): the list does not move when one goes on, the view
  survives the drawer closing, and a pill fixed over the chart names whose
  answer is on it and takes it away again. Two rules, both about the edit tab —
  entering it always clears the isolation, and an eye pressed from inside it
  steps out and isolates in one gesture rather than doing nothing visible.
  Somebody who is only *present* has an eye too; isolating them shows an empty
  chart with a viewport-fixed caption saying they have marked nothing yet, which
  is a real answer to a real question.
  **The glyph is the state and the label is the gesture** (`isOnChart`): an
  answer that is on the chart wears the open eye, one that has been taken off it
  wears the struck-through one, and with nobody isolated everybody is on the
  chart and so every eye is open. Isolating is therefore one row keeping its eye
  while the rest close theirs, and the accent fill says which row asked.
  On a phone the list is a sheet *over* the chart it filters, so an eye pressed
  there gets `useHoldThenClose`: the change lands at once, the drawer refuses
  every dismissal — backdrop, Escape and its own close button, via `Dialog`'s
  `locked` — for `ISOLATION_HOLD_MS` (500 ms) so the toggle is seen to move, and
  then takes itself down. A second eye inside that window restarts the timer
  rather than queueing a second dismissal, and the scope that owns the timer is
  the component, so an unmount or a widening past 820px drops it. The pause is
  not gated on `prefers-reduced-motion`: it is comprehension time, not motion,
  and the sheet's own travel is what that setting already governs.
- **A mode the chart is in says so on the chart** (`ModePills`). The group view
  has two of them — best times, which drops every slot that is not one of the
  fullest, and isolation, which drops everybody but one person — and each
  leaves a heatmap that looks like a perfectly ordinary heatmap of a different
  event. So each gets a chip fixed over the chart naming it, with the way out
  on the chip.
  **One chip per mode, stacked, never merged.** A merged chip would have to fit
  two labels and two crosses into 360px with one of the labels being somebody's
  name, and they are two independent facts with two independent ways out
  besides. Isolation keeps the lower slot, so turning best times on or off does
  not move the chip you were about to press. The stack itself takes no pointer
  events; only the chips do, so a chart cell in the gap between them is still
  tappable.
  The material is the **glass** in `tokens.css`: a chip covers the thing it is
  describing, so it is a tinted, blurred pane rather than an opaque one —
  `--color-glass` plus `--blur-glass` behind an `@supports` guard, falling back
  to `--color-glass-solid` where `backdrop-filter` is missing and under both
  `prefers-reduced-transparency` and `prefers-contrast: more`. It stays visually
  small under a finger, because a chip sized for a thumb covers a lot of chart:
  the cross keeps its 44px target through an invisible box centred on it rather
  than by growing.
- The heatmap tints each cell with the `--color-slot-available` green at an
  alpha scaled by respondent-count over the maximum, and a separate tone for
  if-needed. Because the token is declared with `light-dark()`, the actual
  channels are resolved through computed styles (`src/lib/colors.ts`), never by
  parsing the token text.

### Guest UX

1. A visitor whose name is in `localStorage["timeful.guestName"]` (site-wide) is
   restored silently: no dialog, their answers loaded, the grid ready. Everyone
   else gets the identity dialog. A stored name that is no longer legal — one
   with a dash, from before [user keys](#user-keys) — is dropped and asked for
   again, once; the key the guest retypes lands on the very record the old
   spelling pointed at.
2. That dialog's input **always opens blank**. A stored name skips the dialog
   entirely; it never pre-fills it. Existing respondents are suggested, and
   typing a name that normalizes to one of their keys shows an inline hint that
   continuing will load and overwrite that answer — whatever the spelling.
3. Confirming adopts the **event's** spelling where there is one, so the group
   keeps seeing the name it knows rather than having it rewritten by whoever
   answered last. The dialog validates from the server's own rules as you type:
   an empty name, one over 100 characters, or one containing a **dash** shows
   the message the server would have returned and disables Continue.
4. "Just browsing" drops the identity and deletes the stored name, so the next
   visit asks again. It never claims a write session.
5. After confirming there is **no Save button**. Every grid mutation autosaves
   after a short debounce, with a status indicator: syncing (spinner), saved
   (green), or failed (red, with Retry). Which pipe the save took — the write
   session or the REST `PUT` — never changes what the indicator says.
6. With live updates on, adopting a name also claims that name's
   [write session](#named-write-sessions). If somebody else holds it the page
   steps back to the group view and offers to take it over; the page that had it
   is told so and steps back too. Neither happens with live updates off, because
   then there are no sessions.
7. An admin visiting an event page answers it exactly as a guest does. What they
   get extra is a bordered **Admin** group at the head of the sidebar — or, on a
   phone, a bottom-sheet drawer of its own behind a shield in the navbar —
   carrying Edit event, Back to home, Details and Logout. A guest renders none
   of it.

### The owner, on an event page

`isAdmin` is module state (`src/lib/admin.ts`) rather than a prop, because one
page has one answer to it and three places render off it. It **fails closed**
(`fetchIsAdmin`), and nothing rests on it: every route behind those buttons is
gated by the session cookie regardless.

**One mark, everywhere.** `shield-half.svg` — a shield whose left half is
filled — is the app's only admin signifier: the sidebar group's heading, the
navbar button on a phone, that drawer's own header, and the Administrator Login
link and its dialog all wear it. Nothing else does, so the glyph means exactly
one thing wherever it is met.

The phone's tools are a drawer of their own rather than a section of the view
settings, and the button that opens them is in the navbar rather than beside
the chart. Both follow from what they are: they act on the event or leave it,
which is neither a setting nor a property of the view being looked at — so the
sheet opens the same way from the group view and from "My availability", and a
guest who opens the gear finds only settings. The button and the sheet are
owned by `EventPage`, which already owns the navbar and the edit form.

Signing in does not mean leaving. A grey **Administrator Login** at the foot of
the sidebar (or of the settings drawer) opens the admin app's own form —
`LoginForm`, shared so the two cannot drift — in a dialog over the event page.
It stays in the settings drawer on a phone precisely because the admin drawer
is not there yet for somebody who is not signed in.

::: tip Neither signing in nor signing out reloads anything.
Both re-probe `GET /api/status` rather than writing down what they expect, so a
login that half-succeeded cannot leave controls on screen that do not work. The
flag is reactive, so the tools group appears and disappears where it stands and
a half-finished answer on the grid is undisturbed.
:::

**Details** is the one thing the respondents list cannot say: two answers filed
under one name look identical there. It asks `GET /<slug>/details` on open —
it is a log, so what matters is what it says now — and prints each respondent's
address, raw user agent (one line, whole string in the tooltip) and time.

## Packaging & CLI

The published package is **`dist/`**. The root `package.json` is
`private: true` and stays that way.

```
dist/
  cli.js        the CLI and all first-party server code, #!/usr/bin/env node, 0755
  vendor/       one chunk per bundled third-party package (express, ws, …)
  client/       the Vite client build
  server/       the Vite SSR bundle
  package.json  bare, generated
  LICENSE
  README.md     from docs/npm-README.md
```

The vendor chunk names are un-hashed on purpose: `dist/` is published
wholesale and every file in it is loaded by path, so a content hash would only
churn each release. `cli.js` remains the single entry and the `bin`.

`rollup.config.ts`'s `packageMeta` plugin writes `dist/package.json` from a
picked set of root keys — name, version, description, engines, license, author,
repository, homepage, bugs, keywords — plus `type: "module"`,
`bin: { timeful: "cli.js" }` and `publishConfig`. It emits **no
`dependencies`**: everything runtime is bundled — into `cli.js` plus the
per-dependency chunks under `vendor/`, all inside `dist/` — so there is
nothing left to install. Node builtins are the only externals. A debug build
(`npm run build:debug`) emits a `private: true` stub instead, so a debug `dist/`
cannot be published.

### `ws` and its optional native addons

There are two runtime dependencies, `express` and `ws`, and both are bundled.
`ws` reaches for two optional native addons — `bufferutil` and `utf-8-validate`
— inside `try`/`catch`, falling back to its own JavaScript when they are absent.
They are always absent: they are native builds, and a bundle installs nothing.

`rollup.config.ts` therefore pins `commonjs({ ignoreTryCatch: true })`. That is
the plugin's own default, pinned because the bundle now depends on it:
converting those `require` calls would resolve them as externals, and a bare
`import "bufferutil"` at the top of `cli.js` is a crash on startup rather than a
fallback. Left unconverted, `require` is simply not defined in an ESM bundle,
the `try`/`catch` catches that, and `ws` uses its own code. Express's dependency
chain relies on the same behaviour for `ejs` and `supports-color`.

Because the package declares no dependencies, the SSR build sets
`ssr.noExternal`: an installed copy has no `node_modules` for
`dist/server/entry-server.js` to `import "vue"` from.

`__TIMEFUL_VERSION__` is replaced at build time from `package.json`;
`server/cli/version.ts` falls back to a dev version when running from source.

### The CLI

Four actions, and bare `timeful` decides between the first two by looking at
the directory:

| Command | What it does |
| ------- | ------------ |
| `timeful` | config present → serve; `--yes` → initialize with defaults and serve; no TTY → error, exit 1, write nothing; otherwise the wizard |
| `timeful init` | the wizard, explicitly. **Already a webroot → error and exit 1**, never a second config. `init --yes` writes the config and stops there — it does not serve |
| `timeful serve` | serve. **Not a webroot → error and exit 1**, never the wizard |
| `timeful service [verb] [webroot]` | see [Services](#services) |
| `timeful upgrade [webroot \| -A]` | see [Upgrading](#upgrading) |

Flags: `--port`, `--host`, `--var-dir`, `--trusted-proxy` (each accepting
`--flag value` or `--flag=value`), and the switches `-y/--yes`, `-A/--all`,
`--dry-run`, `-h/--help`, `-v/--version`, `--user`, `--system`. Anything
unrecognised exits 1.

`timeful init` and `timeful serve` take no positional argument;
`timeful service` takes a verb and a webroot, and `timeful upgrade` takes a
webroot. `-A/--all` means something only for those two, and never for
`install`.

Precedence, lowest first: built-in defaults → `timeful.config.json` → `PORT` /
`HOST` / `VAR_DIR` → flags. A missing config file means "not a webroot"; an
unreadable or malformed one is fatal, never a silent fallback.

#### `--dry-run`

Every action that would change something takes `--dry-run`: it prints each file
write and each command as `would write …` / `would create …` / `would run: …`,
touches nothing, and exits 0. It is the whole of the contract — a dry run that
wrote a file, ran a command, or bound a port would be a bug. The older
`TIMEFUL_SERVICE_DRY_RUN=1` environment variable still works, as an alias for
the flag over the service commands.

#### Prompts

`server/cli/tui.ts` is the CLI's terminal UI: a select list, a text prompt and a
confirm, in a few hundred lines of ANSI and `node:readline`, because the package
has no runtime dependencies. Each has two modes:

- **interactive**, when stdin is a TTY: raw mode plus keypress events, a
  redrawn list, arrows or `j`/`k` to move, digits to jump, Enter to confirm.
  Ctrl+C restores the terminal and exits **130**; raw mode and the cursor are
  restored however a prompt ends.
- **line**, when stdin is a pipe: the same question as a numbered prompt
  answered with one line, which is how the wizard is driven under test.

Line mode is not a way to answer a question with nobody there. Anything that
needs a person — the webroot picker, the service tier — checks `isInteractive`
first and fails with an explicit-argument hint instead of guessing or hanging.

#### Wizard

Confirm init → port → bind address → data directory → trusted proxy (a select
list, with an "Other…" row for typed addresses), each looping until valid, with
defaults seeded from any flags already given (so `timeful --port 8080` in a
fresh directory proposes 8080). The config is written and the data directory
created **at that point**, then it asks whether to start now (default yes) and
whether to install a service (default no). The service is installed before the
server starts. A stdin that closes mid-wizard is an error, not a hang.

#### Services

```
timeful service [install|uninstall|start|stop|restart|status] [webroot | -A]
```

With **no verb** it lists every installed service. The webroot a verb applies to
is, in order: an explicit path argument (validated — it must contain
`timeful.config.json`), else the working directory when that is a webroot, else
the only installed one, else a picker on a TTY or an error naming the candidates
without one. `-A/--all` applies to `uninstall`, `start`, `stop`, `restart` and
`status`; `install` needs one concrete webroot and rejects it.

`serviceId` is a platform prefix plus the first 10 hex characters of
`sha256(resolve(webroot))`, so one machine can host several webroots. Tier
selection: an explicit `--user`/`--system` wins; otherwise `user`, except that
an interactive Linux box with `systemctl` on `PATH` is asked whether to use the
hardened system service. Only Linux offers `system`. `uninstall` and the control
verbs act on **every** installed tier for the webroot unless a flag narrows
them.

Installed units exec `timeful serve`, not bare `timeful`, so a service can never
reach the wizard. Units written before that change exec the CLI with no argument
and keep working; they are found the same way, by path.

#### Discovery

**There is no registry.** The units are the record: `discover.ts` reads back the
platform's unit directories and parses each webroot out of what it finds.

| Platform | Scanned | Parsed from |
| -------- | ------- | ----------- |
| macOS | `~/Library/LaunchAgents/app.timeful.<hash>.plist` | `WorkingDirectory` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/systemd/user`, `/etc/systemd/system`, `timeful-<hash>.service` | `WorkingDirectory=` |
| Windows | `%LOCALAPPDATA%\Timeful\Timeful-<hash>.cmd` | the `cd /d "…"` line |

The search paths are injected (`ScanPaths`), which is how the tests point the
scanner at fixtures in a temp directory. A directory that does not exist or
cannot be read contributes nothing; a unit that cannot be read or parsed is
still reported, with a `problem` and no webroot, because hiding it would make an
installed service impossible to uninstall from here. **The three parsers mirror
the three generators — change one and change the other, or an installed service
becomes invisible to the CLI that installed it.**

Running state comes from the cheapest question each platform answers *usefully*:
`launchctl list`, `schtasks /query /fo list`, and on Linux
`systemctl [--user] show -p ActiveState -p SubState -p NRestarts`. A dry run
reports `unknown` rather than asking.

::: danger `activating` is not running.
`is-active` used to be the Linux probe, and its single word calls a crash loop
`activating` — a unit that fails at exec spends nearly all of its life waiting
out `RestartSec`, and `is-active` cannot tell that from a service genuinely
coming up. `timeful service status` printed "installed, running" over units
that had never started once.

`show` has the second word. `ActiveState=activating` with
`SubState=auto-restart` is a countdown to another attempt after one went
wrong, and reads **failed**; a real start caught in the act reads **starting**,
a fifth state beside running, stopped, failed and unknown. `NRestarts` rides
along into the status line ("failed (12 automatic restarts)"), so a loop is
visible even when the probe catches it mid-attempt. Properties are read as
`Key=value` rather than with `--value`, which would depend on systemctl
emitting them in the order they were asked for. A bare word is still
understood, so a probe run by hand reads the same way.
:::

| Platform / tier | File |
| --------------- | ---- |
| macOS, user | `~/Library/LaunchAgents/app.timeful.<hash>.plist` |
| Linux, user | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/timeful-<hash>.service` |
| Linux, system | `/etc/systemd/system/timeful-<hash>.service` (staged in `os.tmpdir()` first) |
| Windows, user | `%LOCALAPPDATA%\Timeful\Timeful-<hash>.cmd`, run by a `schtasks` logon task |

The hardened system unit's directives:

```ini
DynamicUser=yes
SupplementaryGroups=timeful
UMask=0002
WorkingDirectory=<webroot>
ExecStart=<node> <cli> serve
ProtectSystem=strict
ProtectHome=tmpfs
BindReadOnlyPaths=<webroot>
BindReadOnlyPaths=<cli package dir>   # only when the CLI is under a home dir
BindPaths=<varDir>
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure
RestartSec=5
```

#### Why `tmpfs`, and why binds

::: danger `ProtectHome=yes` is a working directory nothing can enter.
It covers /home, /root and /run/user with an **inaccessible** mount, and no
`BindPaths=` reaches back through one. A webroot in a home directory —
which is where most of them are — therefore answered every start with
`status=200/CHDIR`, and the unit crash-looped for as long as it was installed.
The tier shipped that way because service tests are dry-run by design and never
boot a real unit.
:::

`ProtectHome=tmpfs` is the combination systemd documents for this: the three
directories become empty tmpfs instances, and a path listed in `BindPaths=` or
`BindReadOnlyPaths=` is made visible through one, with systemd creating the
intermediate directories inside the tmpfs as `root:755`. The operator's real
0700 home is **shadowed rather than traversed**, so an arbitrary UID walks a
synthetic parent it is allowed to walk. No chmod on anybody's home directory,
and every other home stays as hidden as it was under `yes`.

What the tmpfs does *not* bypass is the bound directory's own permissions: the
webroot keeps its real inode, so it needs `o+x` and `timeful.config.json` needs
`o+r` — the 0755 and 0644 both are born with.

The two mounts are binds rather than `ReadWritePaths=` because only a bind can
make a path *appear* through the tmpfs; `ReadWritePaths=` merely changes whether
an already-visible path is writable, and naming one the tmpfs has hidden is a
start failure. `BindPaths=` is read-write by default, and systemd applies mount
entries **deepest-path-last**, so a writable `varDir` nested inside a read-only
webroot survives both the webroot's mount and `ProtectSystem=strict`. Order in
the file is irrelevant.

Read-write is `varDir` alone, not the whole webroot as before: tighter, and
sufficient — `timeful.config.json` is only ever read, and a systemd unit logs to
the journal rather than to the `timeful.*.log` files the LaunchAgent writes.

The CLI's package directory is bound **only when it is under a home directory**,
which an npx cache is. Everywhere else `ProtectSystem=strict` leaves it visible
and read-only, so there is nothing to add and the unit carries no mount it does
not need. An npx path moves with each version and `timeful upgrade` rewrites the
unit each time, so the bind cannot outlive the package it names.

#### The `timeful` group

`DynamicUser=yes` allocates the UID per start — by hashing the unit name, so
stable in practice but never promised — which means **user** ownership under
`varDir` cannot be relied on across restarts. **Group** ownership can. Install
therefore creates a static `timeful` system group, chowns `varDir` to it, sets
`g+rwX` and the setgid bit on its directories, and the unit takes the group with
`SupplementaryGroups=` and keeps what it writes group-writable with
`UMask=0002`. One group per machine; several webroots share it, and each one's
data is still reachable only through its own unit's bind mount.

Uninstall removes neither the group nor the data, and the printed undo text says
so: another webroot's unit may be using both.

#### The one refusal

A **node binary inside a home directory** — nvm, fnm, asdf, volta — is the one
thing the binds cannot fix. Delimiting a version manager's tree means guessing,
and a wrong guess is another crash loop rather than an error message. So
`installService` refuses it **before printing anything**, with the alternative
attached:

```sh
timeful service install            # user tier, runs as you
sudo loginctl enable-linger <user> # start at boot, survive logout
```

The refusal sits in `installService` rather than in unit generation, which
covers `service install --system`, the wizard and `timeful upgrade` alike while
leaving `uninstall`, `status` and the control verbs working — an operator whose
box is already broken has to be able to take the unit away. When a system unit
is already installed for that webroot, the message adds
`timeful service uninstall --system`.

Everything that touches the machine goes through `ServiceHost` in
`server/cli/service.ts`. Unit generation is **pure** — it returns a string —
and the host is what writes and executes. Rules:

- The full unit text and every activation command are printed **before** any of
  them run. A privileged install additionally explains the `timeful` group and
  the `varDir` chown, checks for `sudo`, and asks; declining stages the file and
  prints the commands.
- The hardened tier's activation is `enable` **plus** `restart`, not
  `enable --now`: `--now` does not bounce a unit that is already up, so
  installing over a running unit would leave the old process alive under the old
  directives. A tolerant `systemctl reset-failed` in front of it unlatches a
  unit that crash-looped itself into `failed`.
- A command may be marked `tolerant`, and a non-zero exit from one is reported
  rather than fatal — `reset-failed` against a unit systemd has never seen, or
  stopping something that was not running.
- `--dry-run` (or `TIMEFUL_SERVICE_DRY_RUN=1`) makes the host print
  `would run: <cmd>` instead of executing, and skips all file writes and
  removals.
- Unit *generation* is pure and so is *control*: `controlFor` and `probeFor`
  turn a `ServiceRef` — platform, tier, id, file, uid — into commands without
  touching anything, which is what lets a service found by scanning be started
  and stopped without recovering its whole spec.
- `ServiceHost.readFile` is the exception to the dry-run rule, and only because
  a read is not a change: `upgrade --dry-run` has to be able to say what the
  installed unit execs today.
- **Never activate a real service from a test or a dev session.** Stub the host.

#### Upgrading

```
timeful upgrade [webroot | -A]
```

Built on one property of npx: by the time `npx timeful@latest upgrade` reaches
our code, npx has already fetched and unpacked the new version, so **the running
process is the new Timeful**. Upgrading therefore never downloads anything and
never replaces anything in place. It re-points the service at the bits already
running.

That matters because a unit pins an absolute `cliPath`, and for an npx install
that path is inside npm's `_npx` cache. Installing a service from `npx timeful`
and running `npx timeful@latest` a year later upgrades the terminal's copy and
leaves the service on the old one indefinitely. Re-pinning is the fix and the
whole job.

Per webroot, in the same target order the service verbs use (a named path, the
working directory, the only installed one, then a picker or an error):

1. the units that exist are regenerated through the ordinary `specFor`/`unitFor`
   path, which pins the current `process.execPath` and `CLI_PATH`;
2. the old pinned path is read back out of the installed unit — a fourth parser
   in `discover.ts` mirroring the same three generators — and both are printed,
   `was …` / `now …`;
3. `installService` writes the new unit over the old one (install is already
   idempotent per webroot) and `controlService(…, "restart")` restarts it,
   because `enable --now` does not bounce a unit that is already up.

Rules that fall out of it:

- **The polite no-op.** If the unit already execs this exact path *and* the
  `package.json` beside that path carries the running version, nothing is
  written and nothing is restarted. It says so — and adds the one case the
  comparison cannot see, a package replaced in place under a running service,
  for which the answer is `timeful service restart`.
- **No service is not an error.** A named webroot gets an explanation of how a
  serve-only setup upgrades (start the new version); one swept up by `-A` gets
  a line.
- **A stable path is reported, never acted on.** `installKind` calls the running
  CLI `npx` when its path contains an `_npx` *segment* and `stable` otherwise —
  deliberately conservative, since the cost of guessing wrong is which of two
  accurate paragraphs is printed. For a stable path the rewrite is a no-op, so
  the registry is consulted and, if something newer exists, `npm i -g
  timeful@latest` + `timeful service restart` are **printed**. Running a package
  manager on the operator's behalf is not this command's business.
- **It works offline.** The registry is best-effort: unreachable is a sentence,
  not a failure, and the `@latest` form never needed the network to begin with.
  `--dry-run` does not contact it at all — the contract is that a dry run
  touches nothing, and that includes the network.
- **The hardened tier escalates exactly as it already did**, through
  `installService`'s `confirmPrivileged` and the `sudo systemctl` commands
  `controlFor` already generates. There is no second escalation path.
- **A legacy unit comes back in the current shape.** Re-pinning goes through
  `specFor`/`unitFor`, so a unit written with `ProtectHome=yes` and
  `ReadWritePaths=<webroot>` is regenerated with the tmpfs, the binds and the
  `timeful` group without anybody hand-editing `/etc/systemd/system` — and the
  activation that follows resets the failure and restarts the process, rather
  than leaving the old one up. `upgrade` is therefore the migration path for a
  box the old hardened tier is crash-looping on, and it is subject to the same
  refusal: a node binary under a home directory stops it with the cure printed,
  including `timeful service uninstall --system`.
- **`var/` and `timeful.config.json` are never touched.** There are no
  migrations to run (see [Storage](#storage)), so there is nothing to convert.

## Scope

Timeful is a rewrite of a much larger hosted product, and most of that product
was deliberately left behind. Absent, and intended to stay absent:

ads; analytics; payments and pricing tiers; OAuth sign-in; calendar
integrations of any kind; contacts, friends, groups and folders; chat-bot
integrations; transactional email; scheduled reminders; sign-up-sheet event
types; blind availability; marketing pages, privacy policy and cookie consent;
an offline/caching service worker or installable-PWA shell; the browser-plugin
messaging API.

One entry on that list narrowed rather than fell: "service worker and PWA"
used to be absent wholesale. [Web Push](#notifications) brought a service
worker and a manifest with it, because push cannot exist without them — but
the worker receives pushes and does nothing else, and the caching/offline
layer the entry was really about remains out of scope, enforced by the danger
box in § Notifications.

Dropped from the event model and not coming back: `daysOnly`,
`blindAvailabilityEnabled`, `collectEmails` (guest **name** only — no email is
ever collected from a guest), `hasSpecificTimes`/`times`, sign-up blocks,
remindees, archiving, third-party import, and a guest-rename endpoint.

What is in scope: specific-date and day-of-week events, configurable time
increments, guest availability plus if-needed, the group heatmap, the
respondents list, a timezone selector, 12/24-hour display, and a best-times
toggle.

The through-line: **no account for guests, no state that is not a JSON file
you can read, and no outbound connection except the two a person explicitly
asked for** — the owner's update check, and push deliveries to browsers that
subscribed.
