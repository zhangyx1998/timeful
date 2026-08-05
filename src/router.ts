import {
  createMemoryHistory,
  createRouter as createVueRouter,
  createWebHistory,
} from "vue-router";
import type { Router } from "vue-router";
import AdminPage from "./pages/AdminPage.vue";
import EventPage from "./pages/EventPage.vue";

// The CSR admin app at '/', and the event page (server-rendered) under its
// three stateful shapes (ARCHITECTURE.md § Routing / SSR): the landing that
// asks who is answering, the group view, and the edit view as one person. One
// component for all three — the route is state, not a different page — so
// navigating between them patches in place rather than remounting the
// scheduler. Unknown slugs never reach the client; the server answers them
// with its own 404 page.
export function createRouter(): Router {
  return createVueRouter({
    history: import.meta.env.SSR ? createMemoryHistory() : createWebHistory(),
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
    ],
  });
}
