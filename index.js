// Entry file that exists only so a package with no main/exports can be
// imported by name: Bun resolves `import 'magpie-openviking'` to index.js.
//
// This plug-in serves Magpie's async gateway hooks, which live in hooks.mjs
// and are declared as "magpie": { "hooks": "./hooks.mjs" }. The gateway
// hook API is separate from OpenCode's plug-in API, so there is nothing to
// export here: an exported function would be called by the Bun host as an
// OpenCode plug-in function.
//
// Do not delete this file. Magpie's GitHub listing (internal/plugin/
// github.go readTagged) ignores "magpie.hooks" and, for a repository whose
// package.json names no main/exports, checks that index.js is in the
// repository before showing it under Plugins → Discover → GitHub.

export const _internal = {
  hooks: './hooks.mjs',
  note: 'Gateway hook plug-in: see hooks.mjs and package.json magpie.hooks.',
};
