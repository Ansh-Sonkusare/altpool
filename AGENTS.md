# Agent guide: Altpool + QuietSend

Read `README.md` first. The full plan (owners, timeline, gates, cut list) is `docs/08-gates-and-tasks.md` in the research repo `Ansh-Sonkusare/quietsend-research`; contract spec `docs/03`, devnet constants `docs/01`, pitch `docs/09`.

Rules:
1. Edit only the folders your owner owns (table in `README.md`). `packages/core` takes additive changes only, announced to the team.
2. Never block on a teammate: build against `@altpool/core/fixtures` (real captured devnet responses) until the integration points.
3. Encode frame txs only with `@forshtat/hegota-support` (profile `ethrex-eip8141-tracer`). The devnet rejects the viem-PR and frametx-kit codecs.
4. Never use published devnet keys or commit `.env`. Fresh key, faucet-funded.
5. Small commits, merged to `main` every 1–2 h. Run `bun run typecheck && bun run test` before pushing.
