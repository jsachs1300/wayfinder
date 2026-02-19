# Repository Guidelines

## Project Structure and Module Organization
- `src/` contains the TypeScript server, routing engine, policy, cache, and user modules.
- `test/` holds Vitest unit and integration tests (e.g., `test/cache/langcache-integration.test.ts`).
- `docs/` and `PRODUCTION.md` contain deployment and operational guides.
- `cloudbuild.yaml` (prod) and `cloudbuild.main.yaml` (dev) define Cloud Build pipelines.
- `scripts/` includes helper tooling; see `scripts/README.md`.

## Build, Test, and Development Commands
- `npm run dev` starts the local server with ts-node-dev.
- `npm run build` compiles TypeScript to `dist/`.
- `npm start` runs the compiled server from `dist/`.
- `npm test` runs the full Vitest suite.
- `npm run test:cache:integration` runs LangCache integration tests.
- `npm run lint` runs ESLint against `src/`.

## Coding Style and Naming Conventions
- Language: TypeScript, Node.js 18+.
- Indentation: follow existing files (2 spaces in most YAML/TS).
- Files use kebab-case (example: `router-llm/default-router-llm.ts`).
- Keep exports explicit and avoid implicit side effects.

## Testing Guidelines
- Framework: Vitest.
- Test files use `*.test.ts` in `test/`.
- For LangCache integration tests, set:
  - `LANGCACHE_INTEGRATION_TEST=true`
  - `LANGCACHE_HOST`, `LANGCACHE_CACHE_ID`, `LANGCACHE_API_KEY`
- Run targeted tests with `vitest run test/path/to/file.test.ts`.

## Commit and Pull Request Guidelines
- Commits are short, imperative, and scoped by intent (example: "Add dev integration test step to Cloud Build").
- PRs should include:
  - A clear summary of changes
  - Any required environment or deployment notes
  - Testing performed (command + outcome)

## Security and Configuration Tips
- Do not commit secrets. Use Secret Manager and Cloud Build substitutions.
- Keep environment variable names consistent across environments; map to env-specific secrets in build configs.
- For production, ensure LangCache and at least one router LLM provider are enabled.
