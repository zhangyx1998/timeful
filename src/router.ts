import {
  createMemoryHistory,
  createRouter as createVueRouter,
  createWebHistory,
} from "vue-router";
import type { Router } from "vue-router";
import AdminPage from "./pages/AdminPage.vue";
import EventPage from "./pages/EventPage.vue";
import { parseEventPath } from "./lib/event-routes";

// One component for the event page's three canonical shapes (ARCHITECTURE.md
// § Routing / SSR), so navigating between them patches in place. The catch-all
// mirrors the server's guard from the same parser; `strict` keeps
// trailing-slash forms in that fallback, matching the server byte for byte.
// Unknown slugs never reach the client — the server 404s them.
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
