# Notifications

Timeful can send **push notifications**: the event's owner can be told when
responses change, and anyone who has answered an event can be told when the
event itself changes — its dates, its times, its name, its link, or that it
was deleted. Notifications arrive even when no Timeful tab is open.

There is nothing to install, nothing to configure, and **no third-party
account involved**. Delivery uses the Web Push service built into the
subscriber's own browser, the message content is encrypted end to end so that
service can read none of it, and the signing keys are minted by your own
server on first use. A Timeful nobody has subscribed to sends nothing to
anyone.

## Turning it on

Notifications are opt-in, per browser, from the bell on an event page:

- **As the owner** — the bell sits with the admin tools ("Notify me about
  responses"), in the sidebar on a desktop or behind the shield in the navbar
  on a phone.
- **As a respondent** — pick your name first; the bell then sits with your
  identity ("Notify me if the event changes"), on the identity card on a
  desktop or in the view-settings drawer on a phone.

The first press asks the browser's permission. Pressing the bell again turns
it back off. If you have denied permission, the bell shows as disabled with a
short note — the browser will not ask again until you clear the block in its
own site settings.

## Requirements

- **HTTPS.** Browsers only allow push on secure pages, so the bell simply
  does not appear over plain HTTP. Put Timeful behind TLS (see
  [Deploying behind nginx](/guide/deployment)); `http://localhost` also
  counts as secure for development.
- **iPhone and iPad.** iOS only delivers push to a web app that has been
  **added to the home screen** (Share → Add to Home Screen, from the event's
  page). Until then the bell is on the page but greyed out and says so;
  opening the app from its home-screen icon brings it to life. This is an iOS
  platform rule, not a Timeful one; Android and desktop browsers need no
  install.

## What gets stored

Two files join the data directory, both owned by the storage layer and both
covered by an ordinary [backup](/guide/backup) of `var/`:

- `var/push.json` — the subscriptions: which browser endpoints asked to hear
  about which events. Endpoints are secrets and are never shown or logged.
- `var/vapid.json` — the server's signing key pair, created the first time a
  browser subscribes. Keep it with the rest of `var/`: subscriptions are bound
  to it, and a regenerated pair would silently orphan every existing one.

Dead subscriptions clean themselves up: when a push service reports that a
browser is gone, the server drops that entry. Deleting an event drops all of
its subscriptions after the deletion notice goes out.

## No configuration

There is no notifications setting. The feature is inert until somebody
subscribes, works out of the box when somebody does, and adds no outbound
traffic beyond the deliveries those subscribers asked for. An air-gapped
Timeful keeps working exactly as before — the bells will show, but a browser
that cannot reach its vendor's push service simply will not manage to
subscribe.
