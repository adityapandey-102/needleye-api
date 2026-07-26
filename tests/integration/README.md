# Integration tests

Real Postgres, real Supabase Auth (GoTrue), real Express app in-process --
nothing mocked. This is the middle layer of the testing pyramid (see
`needleye-api/CLAUDE.md`): repository <-> database, service <-> repository,
authentication, and API-endpoint coverage.

## Prerequisites

The local Supabase stack must be running (same as local dev):

```
npx supabase start
```

`.env` must point at it (the checked-in `.env.example` defaults already do).

## Running

```
npm run test:integration
```

Each file creates its own fixture users/orders (via `authProvider.createUser`
directly, the same bypass-the-Application-layer pattern `src/db/seed.ts`
uses) and tears them down in `afterAll`/`afterEach` -- no dependency on
`npm run seed` having been run first, and safe to run repeatedly against the
same local database.

## What's covered here vs. `tests/rbac-matrix.mjs`

`tests/rbac-matrix.mjs` is a broader ad hoc per-role 200/403 smoke script
that needs `npm run dev` running separately in another terminal (`npm run
test:rbac`). The suite in this folder runs the app in-process via
`supertest`, so it's part of `npm run test` / CI with no separately-running
server required -- narrower per file, but self-contained.
