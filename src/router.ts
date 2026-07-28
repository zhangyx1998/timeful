import {
  createMemoryHistory,
  createRouter as createVueRouter,
  createWebHistory,
} from "vue-router";
import type { Router } from "vue-router";
import AdminPage from "./pages/AdminPage.vue";
import EventPage from "./pages/EventPage.vue";

// Only two routes exist: the CSR admin app at '/', and event pages at
// '/<slug>' (server-rendered). Unknown slugs never reach the client — the
// server answers them with its own 404 page.
export function createRouter(): Router {
  return createVueRouter({
    history: import.meta.env.SSR ? createMemoryHistory() : createWebHistory(),
    routes: [
      { path: "/", name: "admin", component: AdminPage },
      { path: "/:slug", name: "event", component: EventPage, props: true },
    ],
  });
}
