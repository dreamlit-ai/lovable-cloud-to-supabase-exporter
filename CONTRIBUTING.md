# Contributing

Issues and pull requests are welcome.

Please keep changes focused and include context on what changed and why.

Before opening a pull request, run:

```bash
pnpm check
pnpm test
pnpm build
```

`pnpm install` also installs local git hooks via `lefthook`. Staged JS/TS files
are lint-fixed and then formatted on `pre-commit`, and `pre-push` runs
`pnpm check` plus `pnpm test`.

Guidelines:

- Add or update tests when behavior changes, when practical.
- Update docs when CLI, UI, or setup steps change.
- Keep pull requests small and easy to review.
- Maintainers may ask for a changeset when a change should affect a release.

We review contributions on a best-effort basis and may be selective about what
we merge.

By submitting a contribution, you agree that your contributions will be
licensed under the MIT License for this project.
