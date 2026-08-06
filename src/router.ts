import {
  createMemoryHistory,
  createRouter as createVueRouter,
  createWebHistory,
} from "vue-router";
import type { Router } from "vue-router";
import AdminPage from "./pages/AdminPage.vue";
import EventPage from "./pages/EventPage.vue";
import { parseEventPath } from "./lib/event-routes";

// The CSR admin app at '/', and the event page (server-rendered) under its
// three canonical shapes (ARCHITECTURE.md § Routing / SSR): the landing that
// asks who is answering, the group view, and the edit view as one person. One
// component for all three — the route is state, not a different page — so
// navigating between them patches in place rather than remounting the
// scheduler.
//
// The catch-all mirrors the server's guard from the same parser
// (`event-routes.ts`): any other page-like path under a slug redirects to the
// event root, query preserved, so an in-SPA navigation can no more land on a
// non-canonical event path than a full load can (the server answers those
// with a 302). `strict` keeps trailing-slash forms out of the exact routes
// and in that fallback, matching the server byte for byte. Unknown slugs
// never reach the client — the server answers them with its own 404 page.
export function createRouter(): Router {
  return createVueRouter({
    history: import.meta.env.SSR ? createMemoryHistory() : createWebHistory(),
    strict: true,
    routes: [
      { path: "/", name: "admin", component: AdminPage },
      { path: "/:slug", name: "event", component: EventPage, props: true },
      { path: "/:slug/view", name: "event-view", component: EventPage, props: true },
      {
        path: "/:slug/edit/:userKey",
        name: "event-edit",
        component: EventPage,
        props: true,
      },
      {
        path: "/:slug/:rest(.*)*",
        name: "event-fallback",
        redirect: (to) => {
          const shape = parseEventPath(to.path);
          const slug = shape?.slug ?? String(to.params.slug ?? "");
          return { path: `/${slug}`, query: to.query, hash: to.hash };
        },
      },
    ],
  });
}
