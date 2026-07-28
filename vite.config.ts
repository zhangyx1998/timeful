import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import svgLoader from "@zhangyx1998/svg-loader";

// Every event URL is a capability link (docs/reference/architecture.md
// § Security): knowing one is permission to answer it, so nothing here should
// ever be indexed. The file is generated rather than kept in public/ so that
// this reasoning lives next to the rule, and so the dev server and the build
// cannot disagree about what it says.
const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

function robotsTxt(emit: boolean): Plugin {
  return {
    name: "timeful-robots-txt",
    // Dev has no client build to emit into, so serve the same bytes inline.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/robots.txt") return next();
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(ROBOTS_TXT);
      });
    },
    generateBundle() {
      if (!emit) return;
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: ROBOTS_TXT,
      });
    },
  };
}

// Client bundle -> dist/client, SSR bundle -> dist/server (see the `build`
// script, which passes --outDir for the SSR pass).
export default defineConfig(({ isSsrBuild }) => ({
  // svgLoader compiles src/assets/icons/*.svg into inline, style-scoped Vue
  // components. It declares enforce: "pre", so it claims .svg ahead of Vite's
  // asset handling wherever it sits in this array -- and because both build
  // passes and Vitest share this list, the icons compile the same way in the
  // client bundle, the SSR bundle and the tests.
  plugins: [vue(), svgLoader(), robotsTxt(!isSsrBuild)],
  ssr: {
    // The published package declares no dependencies: cli.js bundles its own,
    // and the SSR bundle has to do the same or `import "vue"` would fail in an
    // installed copy. Build only -- dev SSR keeps loading modules through Vite.
    noExternal: isSsrBuild ? true : undefined,
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    // public/ belongs to the client tree; copying it into dist/server as well
    // would ship a second, unreachable favicon.
    copyPublicDir: !isSsrBuild,
  },
}));
