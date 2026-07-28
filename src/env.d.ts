/// <reference types="vite/client" />
/// <reference types="@zhangyx1998/svg-loader/client" />

// Ambient types for the client bundle: Vite's `import.meta.env` (used by
// src/router.ts to pick a history implementation) and the CSS side-effect
// imports in src/app.ts.
//
// The svg-loader reference is what makes `import Icon from "./icon.svg"` a Vue
// component to TypeScript. It has to be a triple-slash reference rather than an
// entry in tsconfig's `compilerOptions.types`, because that key is already
// pinned to ["node"] and is all-or-nothing -- adding to it there would drop the
// automatic @types resolution the server code relies on.
