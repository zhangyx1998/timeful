# Architecture

This page is the **binding contract** for Timeful: the storage format, the
complete `/api` surface, the routing and SSR rules, the security design, and how
the package is built. It describes what the code actually does. Where an
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
  realtime.ts   per-event WebSocket rooms, broadcast, the upgrade listener
  proxy.ts      --trusted-proxy parsing
  config.ts     env-only runtime knobs
  http.ts       small helpers
  types.ts      type-only re-exports from src/lib (see below)
  routes/       auth.ts, sessions.ts, leases.ts, events.ts
  cli/          index.ts, args.ts, config.ts, wizard.ts, tui.ts,
                service.ts, discover.ts, errors.ts, version.ts
```

`server/types.ts` re-exports the event document and the API shapes from
`src/lib/event.ts`, `src/lib/api.ts` and `src/lib/realtime.ts` as **type-only**
imports, erased before Node sees them. There is one definition of the wire
format and both halves of the app share it.

There is exactly one exception, and it is deliberate: `server/realtime.ts`
imports `realtimeAllowed` from `src/lib/event.ts` at **runtime**. "An event with
no `realtime` field has live updates on" is a default that must have a single
definition, and both the server and the admin form need to ask it.

## Storage

Everything lives under `varDir()` — `process.env.VAR_DIR` or `<cwd>/var`.

```
var/credential.json      the single owner account
var/sessions.json        active session tokens
var/links.json           slug -> event id
var/events/<uuid>.json   one file per event, guest answers inline
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
  responses: Record<string, EventResponse>;   // keyed by guest name
}

interface EventResponse {
  availability: string[];           // ISO slot-start instants
  ifNeeded: string[];               // ISO slot-start instants
  updatedAt: string;
}
```

Each entry in `dates` is a day's start instant, one per grid column; `duration`
in hours defines the daily window. Availability entries are slot-start
timestamps aligned to `timeIncrement`.

`realtime` is the only optional field, and its absence is meaningful: every
event written before [live updates](#realtime-updates) existed lacks it, none of
them are rewritten, and **absent reads as `true`**. Code asks
`realtimeAllowed(event)` (`src/lib/event.ts`) rather than testing the field, so
the default has one definition that both halves of the app share.

The `id` must match
`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. Non-uuid
ids short-circuit to `null` in `readEvent`/`updateEvent`/`deleteEvent`, and
`listEventIds` filters on it — so a stray file in `events/` can never be
addressed.

### The other three files

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
```

The CLI also writes `timeful.config.json` in the webroot, and an installed
service writes `timeful.out.log` / `timeful.err.log` inside `varDir`.

### Zero-record invariant

**An event never stores a response with nothing in it.** A `PUT` whose
`availability` and `ifNeeded` both come out empty *deletes* the response (a
no-op if it was not there). Events only ever contain respondents with at least
one slot, so the respondents list needs no filtering and a guest who clears
their answer disappears from it entirely.

## API

Everything is JSON under `/api`. Routers mount in the order `auth` → `sessions`
→ `leases` → `events`, then a catch-all `404 {"error": "Not found"}`. The body
parser is `express.json({ limit: "2mb" })`; malformed JSON yields `400`.

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

### Slug leases

Admin-only. See [Slug leases](#slug-leases-1) for what they are for.

| Route | Response |
| ----- | -------- |
| `POST /api/slug-leases` | `201 { slug, expiresAt }` — or `503` after 32 failed allocation attempts |
| `DELETE /api/slug-leases/:slug` | `204`, idempotent |

### Events

| Route | Auth | Notes |
| ----- | ---- | ----- |
| `GET /api/events` | admin | `{ id, slug, name, type, responseCount, createdAt, updatedAt }[]`, newest-updated first |
| `POST /api/events` | admin | body `{ name, type, dates, duration, timeIncrement, startOnMonday, slug? }` → `201` full event |
| `PATCH /api/events/:id` | admin | any subset of the same fields; `:id` **must be the uuid** |
| `DELETE /api/events/:id` | admin | `:id` **must be the uuid** → `{ ok: true }` |
| `GET /api/events/:idOrSlug` | **public** | the full event document — this is what the event page reads |
| `PUT /api/events/:id/responses/:name` | **public** | `{ availability?, ifNeeded? }` → `{ ok, name, response \| null }` |
| `DELETE /api/events/:id/responses/:name` | **public** | `{ ok: true }`; `404 "Response not found"` if the event exists but the guest does not |
| `GET /api/events/:idOrSlug/ws` | **public** | WebSocket upgrade — [live updates](#realtime-updates), read-only. A non-upgrade `GET` is a plain `404` |

The public response routes accept **either** the uuid or the slug; the
admin-only `PATCH`/`DELETE` accept only the uuid.

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
| guest `:name` | trimmed, non-empty, ≤ 100 chars |
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

`src/lib/api.ts` prefixes `/api` when absent, sends `credentials: "include"`,
and throws `ApiError { message, status, body }` on any non-2xx, taking the
message from the `{ error }` field. `fetchIsAdmin()` fails **closed**.

## Realtime updates

An event page left open keeps itself current: someone else's answer changes the
heatmap and the respondents list without a reload, and the list shows who is
looking at the event right now. It is a **read-only server→client notification
channel** over one WebSocket, and it is optional at two levels.

### The contract

::: danger The socket is read-only. The REST API is the sole write path.
No `message` listener is ever registered on an accepted socket. Bytes a client
sends are read off the wire by the protocol layer and dropped: they reach no
state, no handler and no storage. The only inbound traffic that means anything
is protocol-level — pong frames answering the heartbeat, and close. **Presence
does not bend this**: a page's name arrives once, in the handshake the
connection is made of, so a forged `presence` frame changes nothing either.

Nothing here adds a write capability or an authentication surface. Disabling
realtime, or any WebSocket failure at all, degrades to standard REST behaviour
with **zero feature loss**.
:::

`GET /api/events/:idOrSlug/ws` takes the upgrade. It never reaches Express: the
listener is on the HTTP server, registered by `serve()` in `server/app.ts`.
A plain `GET` of that path is not an upgrade and falls through to the events
catch-all as a `404`.

**Identity rides in the URL.** A page that has adopted a name connects to
`…/ws?name=<urlencoded>`; one that is only browsing connects without the
parameter. The name is connection metadata, validated for shape only — trimmed,
and treated as **absent** when empty or longer than the 100-character guest-name
limit rather than truncated. Adopting a name, switching to another, or going back
to browsing all reconnect, because the handshake is the only place a name can be
stated.

### Messages

Server to client, JSON text frames, defined once in `src/lib/realtime.ts` and
re-exported type-only by `server/types.ts`:

```ts
type RealtimeMessage =
  | { type: "event"; event: EventDoc }     // the whole document, responses inline
  | { type: "presence"; names: string[] }  // who is looking, sorted and deduped
  | { type: "gone" };                      // the event was deleted; terminal
```

**Full snapshots, never deltas.** The `event` payload is byte-for-byte what
`GET /api/events/:idOrSlug` would return, so the client has one path for "the
event changed" rather than one per kind of change — the same path a refresh
takes. A snapshot goes out after every successful mutation, and only after it is
persisted:

| Mutation | Broadcast |
| -------- | --------- |
| `PUT /api/events/:id/responses/:name` | snapshot — including the zero-record delete-by-empty, when it removed something |
| `DELETE /api/events/:id/responses/:name` | snapshot |
| `PATCH /api/events/:id` | snapshot, carrying a renamed slug if it changed |
| `DELETE /api/events/:id` | `gone`, then the room closes |

A create broadcasts nothing: nobody can be subscribed to an event that did not
exist a moment ago.

### Presence

A room also knows who is in it, and a `presence` message goes out whenever that
changes: somebody arrived with a name, somebody's last connection closed, or a
named socket was terminated by the heartbeat. A newly connected page is sent the
current list immediately — including its own name, if it gave one — so the list
is never waiting on somebody else to move.

- **Refcounted per name.** One person is routinely several connections (two tabs,
  a phone beside a laptop, a reconnect overlapping the drop it replaces), so the
  room holds a `Map<name, count>`. A second connection under a name already
  present changes nothing anyone can see and broadcasts nothing; the name leaves
  the list when its last connection does.
- **Never persisted.** Presence lives only in the room. Nothing is written to
  disk, there is nothing to clean up after a restart, and an event document has
  no presence field.
- **Nothing rests on it.** Names are self-asserted, exactly like the name on a
  response: anyone holding the capability URL could already write a response
  under any name they liked — the capability URL is the trust boundary, below.
  Presence decides which row gets a pair of dots beside it, and that is the whole
  of its authority.
- **Off means absent, not empty.** With the event's live updates off, or the
  server-wide switch off, there are no sockets at all and so no presence —
  the same page as before the feature existed.

### Rooms, and the two switches

Rooms live in an in-memory `Map<eventId, { sockets, names }>`, keyed by the
**uuid** and never the slug — a rename must not orphan its subscribers. A room is
deleted when its last member leaves. The server pings every socket every 30s and
terminates any that did not answer the previous round; the close that follows is
the same exit any other departure takes, so a reaped socket's name leaves the
presence list with it.

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

### Security

The capability URL remains the entire auth boundary, and subscribing is
deliberately no cheaper to scan than fetching:

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
- accounting uses `req.socket.remoteAddress`. An upgrade never reaches Express,
  so there is no `req.ip` and no trust-proxy evaluation behind it. Behind a
  reverse proxy that groups every client under the proxy's address — which costs
  a shared queue on **misses only** and never delays a real subscriber — and it
  is unspoofable in exchange;
- inbound frames are capped at 1 KiB. Nothing a client sends is read, so this is
  not a protocol limit, only how much of a hostile frame is buffered before the
  connection is closed. permessage-deflate stays off.

Slugs are never logged here either.

### The client

`connectRealtime(eventId, { name, onEvent, onPresence, onGone })` in
`src/lib/realtime.ts` returns a handle with `setName()` and `close()`. It is
silent by design — there is no connection indicator anywhere in the UI, because a
page whose socket never opened has to look exactly like one that never had a
socket.

- **Never during SSR.** No `window` means no URL to derive and no connection; a
  socket per server-rendered page would be a denial of service against
  ourselves.
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
- **`setName(name)`** reconnects under a new identity straight away — not on the
  backoff schedule, since the visitor just did something deliberate — resetting
  both counters, and does nothing when the name has not actually changed.
- **A drop clears presence.** `onPresence([])` fires when the connection goes,
  because dots beside a name the page can no longer vouch for are worse than no
  dots at all. A `setName` switch is not a drop and clears nothing: the new
  connection's own list is a moment away.

`EventPage.vue` connects on mount by uuid (stable across renames) and feeds
snapshots through `applyEvent`, the same function the edit dialog and `refresh`
use: it swaps the document, updates the title, and corrects the address bar with
`replaceState` on a renamed slug. `gone` clears the event and shows a short
"Event deleted" panel instead of leaving the scheduler autosaving into a 404.

`EventPage.vue` also owns the presence list, because it owns the socket presence
arrives on: `EventScheduler` reports its adopted name upwards (`@identity`, from a
watcher on the name, so it fires *after* the flush a switch begins with) and takes
the list back down as a prop. `RespondentsPanel` merges it with the respondents:

- every online name gets three CSS-animated dots and a visually hidden
  " (online)", the visitor's own row included — `prefers-reduced-motion` gets the
  same three dots without the animation;
- somebody online who has **not** answered is shown as a row of their own, with
  the person icon whatever slot is active (they marked nothing, so "unavailable"
  would be a lie about them), no delete button, and no place in the `M/N` count
  or the heatmap's maximum — both of which are computed from the response index,
  which presence never enters. Clicking the row still offers to answer as them.

An incoming snapshot deliberately **does not** touch a visitor's half-finished
answer. The marks live in `EventScheduler`, which re-seeds from a new document
only when it asked for one (`awaitingIdentityRefresh`), and the current name is
layered back over the group's answers by the response-index override. The edit
dialog is safe for a related reason: its form seeds from the prop once and never
watches it.

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
- `GET` / `PUT` / `DELETE` under `/api/events/…`, and the events catch-all;
- failed `POST /api/auth/setup` and `POST /api/auth/login`.

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

There are exactly three kinds of URL.

### `/` — the admin app, client-rendered

`GET`/`HEAD` return the template with the SSR placeholders replaced by empty
strings: no `data-ssr`, no `window.__EVENT__`, the title left as `Timeful`. The
client then shows Setup (first run) → Login → the admin panel. Any other method
on `/` gets the 404 page, with no delay.

### `/api/*` — the Express API

Described [above](#api). Unknown routes under it answer
`404 {"error": "Not found"}` immediately.

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
but it means anything ever added to the document is public to link-holders.

Injected meta: `robots=noindex`, a description, `og:type`, `og:site_name`,
`og:title`, `og:description`, `og:url`, and the `twitter:` card equivalents.

The interactive grid mounts client-side only, which sidesteps server/client
timezone hydration mismatches.

### Static assets

Mounted after `/api` and before the page handler:

- `/assets` → `<root>/client/assets` with `immutable, max-age=1y`;
- then `<root>/client` (favicon, `robots.txt`), both with `index: false` so the
  page handler keeps ownership of `/`.

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
- A resize commits on every step, so its undo is a record that **grows** rather
  than a snapshot taken once (`selectionStep` in `src/lib/grid.ts`): a cell is
  recorded the first time the rectangle takes it in and never again, since after
  that what it holds is the selection's own doing. Cancelling therefore restores
  the state the tap interrupted however far the handles travelled, and a deletion
  region dragged over a mixed block puts each mark back as its own kind.
- Every column is laid out once inside a **native scroll container**, which the
  track may rest anywhere on — there is no paging and no snapping. Native
  because `getBoundingClientRect()` already carries the scroll offset, so
  hit-testing stays correct mid-scroll, and because momentum, shift+wheel and
  keyboard scrolling come with it. The time gutter and the day headings sit
  inside that container, pinned with `position: sticky` on their own axis. A
  paint drag — or a handle drag — held at a clipped edge glides the scroll
  position under it, quantised to whole columns under `prefers-reduced-motion`.
- Below **820px** the event page is an app rather than a document: the page
  itself does not scroll, the chart fills the space between the header bar and
  the identity bar and scrolls inside it on both axes, and the respondents and
  the view settings move into bottom-sheet drawers. The chart's foot keeps the
  clock and the mode's own control on one row and drops the legend, because
  every pixel it spends there comes off the grid.
- Two readings of the group's answer that the desktop gets from the column
  beside the chart are given back to the phone, where that column is behind a
  drawer. A **tap** on a cell raises a card over it naming who is free at that
  slot in the respondents list's own glyphs — the pinned slot, read a second
  way, not a second kind of selection. And an **eye** on each answered row of
  the drawer puts that one person's answer on the chart alone, since a heatmap
  is a sum and a sum cannot say who is behind it. The single-person view lives
  exactly as long as the drawer does; turning it on collapses the drawer to that
  row and stops it dimming, or it would be covering the chart it just changed.
- The heatmap tints each cell with the `--color-slot-available` green at an
  alpha scaled by respondent-count over the maximum, and a separate tone for
  if-needed. Because the token is declared with `light-dark()`, the actual
  channels are resolved through computed styles (`src/lib/colors.ts`), never by
  parsing the token text.

### Guest UX

1. A visitor whose name is in `localStorage["timeful.guestName"]` (site-wide) is
   restored silently: no dialog, their answers loaded, the grid ready. Everyone
   else gets the identity dialog.
2. That dialog's input **always opens blank**. A stored name skips the dialog
   entirely; it never pre-fills it. Existing respondent names for the event are
   suggested, and typing one shows an inline hint that continuing will load and
   overwrite that answer.
3. "Just browsing" drops the identity and deletes the stored name, so the next
   visit asks again.
4. After confirming there is **no Save button**. Every grid mutation autosaves
   after a short debounce, with a status indicator: syncing (spinner), saved
   (green), or failed (red, with Retry).
5. An admin visiting an event page sees the guest view. Event management lives
   in the admin panel, not on the event page.

## Packaging & CLI

The published package is **`dist/`**. The root `package.json` is
`private: true` and stays that way.

```
dist/
  cli.js        the CLI and the entire server, bundled, #!/usr/bin/env node, 0755
  client/       the Vite client build
  server/       the Vite SSR bundle
  package.json  bare, generated
  LICENSE
  README.md     from docs/npm-README.md
```

`rollup.config.ts`'s `packageMeta` plugin writes `dist/package.json` from a
picked set of root keys — name, version, description, engines, license, author,
repository, homepage, bugs, keywords — plus `type: "module"`,
`bin: { timeful: "cli.js" }` and `publishConfig`. It emits **no
`dependencies`**: everything runtime is bundled, so there is nothing left to
install. Node builtins are the only externals. A debug build
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

Three actions, and bare `timeful` decides between the first two by looking at
the directory:

| Command | What it does |
| ------- | ------------ |
| `timeful` | config present → serve; `--yes` → initialize with defaults and serve; no TTY → error, exit 1, write nothing; otherwise the wizard |
| `timeful init` | the wizard, explicitly. **Already a webroot → error and exit 1**, never a second config. `init --yes` writes the config and stops there — it does not serve |
| `timeful serve` | serve. **Not a webroot → error and exit 1**, never the wizard |
| `timeful service [verb] [webroot]` | see [Services](#services) |

Flags: `--port`, `--host`, `--var-dir`, `--trusted-proxy` (each accepting
`--flag value` or `--flag=value`), and the switches `-y/--yes`, `-A/--all`,
`--dry-run`, `-h/--help`, `-v/--version`, `--user`, `--system`. Anything
unrecognised exits 1.

`timeful init` and `timeful serve` take no positional argument; only
`timeful service` does. `-A/--all` means something only there, and never for
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

Running state comes from the cheapest question each platform answers:
`systemctl [--user] is-active`, `launchctl list`, `schtasks /query /fo list`.
A dry run reports `unknown` rather than asking.

| Platform / tier | File |
| --------------- | ---- |
| macOS, user | `~/Library/LaunchAgents/app.timeful.<hash>.plist` |
| Linux, user | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/timeful-<hash>.service` |
| Linux, system | `/etc/systemd/system/timeful-<hash>.service` (staged in `os.tmpdir()` first) |
| Windows, user | `%LOCALAPPDATA%\Timeful\Timeful-<hash>.cmd`, run by a `schtasks` logon task |

The hardened system unit's directives:

```ini
DynamicUser=yes
WorkingDirectory=<webroot>
ReadWritePaths=<webroot>
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure
RestartSec=5
```

Everything that touches the machine goes through `ServiceHost` in
`server/cli/service.ts`. Unit generation is **pure** — it returns a string —
and the host is what writes and executes. Rules:

- The full unit text and every activation command are printed **before** any of
  them run. A privileged install additionally warns about `DynamicUser`, checks
  for `sudo`, and asks; declining stages the file and prints the commands.
- `--dry-run` (or `TIMEFUL_SERVICE_DRY_RUN=1`) makes the host print
  `would run: <cmd>` instead of executing, and skips all file writes and
  removals.
- Unit *generation* is pure and so is *control*: `controlFor` and `probeFor`
  turn a `ServiceRef` — platform, tier, id, file, uid — into commands without
  touching anything, which is what lets a service found by scanning be started
  and stopped without recovering its whole spec.
- **Never activate a real service from a test or a dev session.** Stub the host.

## Scope

Timeful is a rewrite of a much larger hosted product, and most of that product
was deliberately left behind. Absent, and intended to stay absent:

ads; analytics; payments and pricing tiers; OAuth sign-in; calendar
integrations of any kind; contacts, friends, groups and folders; chat-bot
integrations; transactional email; reminders; sign-up-sheet event types; blind
availability; marketing pages, privacy policy and cookie consent; service worker
and PWA; the browser-plugin messaging API.

Dropped from the event model and not coming back: `daysOnly`,
`blindAvailabilityEnabled`, `collectEmails` (guest **name** only — no email is
ever collected from a guest), `hasSpecificTimes`/`times`, sign-up blocks,
remindees, archiving, third-party import, and a guest-rename endpoint.

What is in scope: specific-date and day-of-week events, configurable time
increments, guest availability plus if-needed, the group heatmap, the
respondents list, a timezone selector, 12/24-hour display, and a best-times
toggle.

The through-line: **no account for guests, no network dependency at runtime, and
no state that is not a JSON file you can read.**
