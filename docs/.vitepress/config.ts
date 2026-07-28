import { defineConfig } from "vitepress";

// The site is served from the domain root during local preview and from
// /timeful/ on GitHub Pages (a project site lives under the repo name). The
// deploy workflow sets DOCS_BASE=/timeful/; everything else gets the root.
const base = process.env.DOCS_BASE ?? "/";

export default defineConfig({
  base,
  lang: "en-US",
  title: "Timeful",
  description:
    "A self-hosted group availability poll. One owner, one Node process, JSON files on disk.",
  cleanUrls: true,
  lastUpdated: true,
  // Written for the npm listing page, not for this site: rollup's packageMeta
  // plugin copies it into dist/ as the published package's README.
  srcExclude: ["npm-README.md"],
  head: [["link", { rel: "icon", href: `${base}favicon.ico` }]],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
      { text: "Reference", link: "/reference/architecture", activeMatch: "/reference/" },
      { text: "npm", link: "https://www.npmjs.com/package/timeful" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Install and first run", link: "/guide/" },
            { text: "Configuration", link: "/guide/configuration" },
            { text: "Running as a service", link: "/guide/service" },
            { text: "Deploying behind nginx", link: "/guide/deployment" },
            { text: "Backup and restore", link: "/guide/backup" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Architecture", link: "/reference/architecture" },
            { text: "Development", link: "/reference/development" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Architecture", link: "/reference/architecture" },
            { text: "Development", link: "/reference/development" },
          ],
        },
        {
          text: "Guide",
          items: [
            { text: "Install and first run", link: "/guide/" },
            { text: "Configuration", link: "/guide/configuration" },
            { text: "Running as a service", link: "/guide/service" },
            { text: "Deploying behind nginx", link: "/guide/deployment" },
            { text: "Backup and restore", link: "/guide/backup" },
          ],
        },
      ],
    },
    outline: { level: [2, 3] },
    socialLinks: [
      { icon: "github", link: "https://github.com/zhangyx1998/timeful" },
    ],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/zhangyx1998/timeful/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026-present Yuxuan Zhang",
    },
  },
});
