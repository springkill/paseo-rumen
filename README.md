# Paseo Rumen

Rumen is a local-first software-engineering knowledge layer implemented entirely as a Paseo plugin. It observes the workspaces and agents already managed by Paseo, detects the technologies a project uses, records evidence of what the user has actually learned, and turns unreviewed agent changes into visible knowledge debt.

There is no standalone Rumen desktop client or daemon. The trusted plugin backend runs inside Paseo's plugin subprocess and persists its local state under:

```text
$PASEO_HOME/plugin-data/paseo-rumen/state.json
```

When `PASEO_HOME` is unset it defaults to `~/.paseo`.

## Features

- Global Rumen sidebar overview across scanned workspaces.
- Workspace panel with Now, Stack, Learn, Commits, and Settings tabs.
- Deterministic stack detection across JavaScript/TypeScript, Python, Rust, Go, Ruby, PHP, Maven, Docker, GitHub Actions, Terraform, and source imports.
- Global knowledge nodes with evidence-driven mastery, confidence, and knowledge debt.
- Local project-aware Wiki guides and objective knowledge checks.
- Conservative Git commit facts and agent-authorship markers.
- Agent knowledge-impact panel using the canonical Paseo timeline; the persistent visible entry remains the left Rumen sidebar item.
- Timeline cards for completed code/manifest mutations.
- Rumen knowledge attachment source for Agent prompts.
- Redacted JSONL export that excludes paths, snippets, and project identities.
- Public/private/airgapped project privacy state.

## Privacy

- Project privacy defaults to `private`.
- `.env` files are never scanned.
- Agent analysis stores file targets only; it does not retain prompts, outputs, patches, old/new strings, or shell commands.
- Attachment text contains generic knowledge summaries and mastery metadata, not project snippets.
- Export hashes project identities and excludes project paths, evidence references, and snippets.
- An `airgapped` project is reserved for enforcing zero-egress behavior in any future provider-backed content adapter. The current implementation uses deterministic local content and does not call an external model.

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-rumen
paseo plugin reload paseo-rumen
paseo plugin logs paseo-rumen
```

Paseo source code is not modified. Use plugin reload only; do not restart Paseo to apply source changes.
