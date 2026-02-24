# JS → TS Migration (Backend Only)

## Plan

Convert 6 backend JS files to TypeScript. Frontend (public/) stays vanilla JS.

### Files to convert
- `probe.js` → `src/probe.ts` (571 lines, CLI entry point)
- `lib/parser.js` → `src/lib/parser.ts` (232 lines)
- `lib/server.js` → `src/lib/server.ts` (1006 lines)
- `lib/state.js` → `src/lib/state.ts` (112 lines)
- `lib/store.js` → `src/lib/store.ts` (176 lines)
- `lib/watchdog.js` → `src/lib/watchdog.ts` (112 lines)

### Steps

- [ ] 1. Setup: tsconfig.json, add `typescript` + `@types/ws` + `@types/node` devDeps
- [ ] 2. Create `src/` dir, convert `lib/state.js` → `src/lib/state.ts` (simplest, no deps)
- [ ] 3. Convert `lib/watchdog.js` → `src/lib/watchdog.ts` (simple, no deps)
- [ ] 4. Convert `lib/parser.js` → `src/lib/parser.ts` (standalone)
- [ ] 5. Convert `lib/store.js` → `src/lib/store.ts` (fs only)
- [ ] 6. Convert `lib/server.js` → `src/lib/server.ts` (biggest, depends on all above + ws)
- [ ] 7. Convert `probe.js` → `src/probe.ts` (CLI entry, depends on server + store)
- [ ] 8. Update package.json: bin→dist/, scripts (build, start, dev), engine
- [ ] 9. Update .gitignore: add `dist/`
- [ ] 10. Delete old JS files (probe.js, lib/)
- [ ] 11. Build + verify: `tsc` compiles cleanly, `node dist/probe.js serve` works

### Key decisions
- **Source dir**: `src/` — compiled output goes to `dist/`
- **Module system**: CJS output (`"module": "commonjs"`) — same as current
- **Target**: ES2022 (Node 18+)
- **Strict mode**: enabled
- **Types**: Add interfaces for Session, Event, etc. — real benefit of the migration
- **Shebang**: tsc doesn't emit shebangs → add a thin `bin/probe` wrapper or use a plugin
  - Simplest: `bin/probe.js` with `#!/usr/bin/env node\nrequire('../dist/probe.js')`

### Unresolved questions
None — straightforward migration.
