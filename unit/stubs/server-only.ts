// Stub for the `server-only` package.
//
// `import 'server-only'` is a build-time marker: Next.js resolves it to a
// module that throws if it ends up in a client bundle. It is not a runtime
// dependency and is not installed as one, so Vitest cannot resolve it and any
// test importing a server-only module fails at import time with
// "Cannot find package 'server-only'".
//
// Aliasing it to this empty module (see vitest.config.ts) lets server-only
// modules be unit tested while leaving the real marker in place for the build,
// which is where it actually does its job.
export {}
