# NormWind

Normalize Tailwinds.

NormWind is a small Tailwind CSS utility-class auditor and autofixer. It finds verbose utility combinations and non-canonical arbitrary values, then reports or rewrites them as shorter, canonical Tailwind classes.

Examples:

- `px-4 py-4` -> `p-4`
- `pl-2 pr-2` -> `px-2`
- `w-6 h-6` -> `size-6`
- `content-center justify-center` -> `place-content-center`
- `rounded-[24px]` -> `rounded-3xl`
- `w-[100%]` -> `w-full`

## Why use it?

Tailwind codebases drift. Over time, teams and AI tools generate class strings that are valid but noisier than they need to be. NormWind keeps those class strings compact and consistent without forcing a formatter or sorting policy onto the project.

NormWind is useful when you want:

- shorter class strings
- consistent shorthand usage
- fewer arbitrary values when a named Tailwind token exists
- CI enforcement for utility cleanup
- safe autofixes for Vue projects
- broader codemod-style fixes when explicitly requested

## Install

```bash
npm i -D @lunawerx/normwind
```

Run without installing globally:

```bash
npx @lunawerx/normwind
```

The package exposes both command names:

```bash
normwind
normwinds
```

## Quick start

Audit the current project:

```bash
npx @lunawerx/normwind
```

Apply safe Vue-first fixes, then re-audit:

```bash
npx @lunawerx/normwind --fix
```

Apply fixes across all supported file types:

```bash
npx @lunawerx/normwind --fixall
```

Emit JSON for CI or custom tooling:

```bash
npx @lunawerx/normwind --json
```

## What NormWind checks

### Shorthand utility combinations

NormWind detects class groups that Tailwind can express with a shorter shorthand:

| Verbose                               | Canonical shorthand    |
| ------------------------------------- | ---------------------- |
| `px-4 py-4`                           | `p-4`                  |
| `pl-2 pr-2`                           | `px-2`                 |
| `mt-3 mb-3`                           | `my-3`                 |
| `left-0 right-0`                      | `inset-x-0`            |
| `top-0 bottom-0`                      | `inset-y-0`            |
| `gap-x-4 gap-y-4`                     | `gap-4`                |
| `overflow-x-hidden overflow-y-hidden` | `overflow-hidden`      |
| `w-6 h-6`                             | `size-6`               |
| `content-center justify-center`       | `place-content-center` |
| `items-start justify-items-start`     | `place-items-start`    |
| `self-end justify-self-end`           | `place-self-end`       |

The shorthand family data comes from `eslint-plugin-tailwindcss`'s Tailwind utility group definitions. NormWind uses that authoritative group data directly while keeping a Tailwind v4-compatible matcher.

### Canonical arbitrary values

NormWind also detects arbitrary values that Tailwind's own design-system canonicalizer can express as named utilities:

| Arbitrary        | Canonical     |
| ---------------- | ------------- |
| `rounded-[24px]` | `rounded-3xl` |
| `w-[100%]`       | `w-full`      |
| `h-[1.5rem]`     | `h-6`         |
| `p-[1rem]`       | `p-4`         |
| `m-[8px]`        | `m-2`         |

Canonical mappings come from Tailwind's own `designSystem.canonicalizeCandidates` engine.

## Canonical replacement snapshot

NormWind ships a generated Tailwind canonical replacement snapshot:

- `docs/reference/canonical-replacements.json`
- `docs/reference/canonical-replacements.md`

This snapshot is generated from Tailwind's own canonicalization engine for the Tailwind version bundled by this package. It gives users fast, deterministic first-run canonical checks without writing generated files into their projects.

Lookup order:

1. A project-local snapshot at `docs/reference/canonical-replacements.json`, if present.
2. The package-bundled snapshot.
3. Tailwind's live design-system canonicalizer for cache misses or missing snapshots.

Maintainers can regenerate and verify the snapshot with:

```bash
npm run canonical:extract
npm run canonical:check
```

`canonical:check` is deterministic and suitable for CI.

## File matching

By default, NormWind scans:

```text
**/*.{vue,js,mjs,ts,jsx,tsx}
```

It ignores common generated or dependency folders such as:

- `.git`
- `node_modules`
- `dist`
- `test-results`
- `cdk.out`
- `.tmp`
- `.saydeploy`

Target specific paths or globs:

```bash
npx @lunawerx/normwind src
npx @lunawerx/normwind "src/**/*.vue"
npx @lunawerx/normwind "apps/web/**/*.{tsx,ts}"
```

## CLI reference

| Command                                                  | Behavior                                                                                                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normwind`                                               | Audit supported files. Exits `1` when findings exist.                                                                                                                                        |
| `normwind --json`                                        | Print machine-readable audit output.                                                                                                                                                         |
| `normwind --fix`                                         | Apply safe Vue-first fixes, then re-run the audit.                                                                                                                                           |
| `normwind --fixall`                                      | Apply broader fixes across Vue, JS, MJS, TS, JSX, and TSX, then re-run the audit.                                                                                                            |
| `normwind --extract-canonical`                           | Extract canonical replacements in memory and print a summary.                                                                                                                                |
| `normwind --extract-canonical --write-canonical-files`   | Write `docs/reference/canonical-replacements.{json,md}`.                                                                                                                                     |
| `normwind --check-canonical`                             | Fail if generated canonical files are missing or stale.                                                                                                                                      |
| `normwind --cleanup-canonical-files`                     | Remove generated canonical files from `docs/reference`.                                                                                                                                      |
| `normwind --suggest-named-theme-vars --theme-css <path>` | (opt-in) Suggest replacing `utility-(--md-sys-color-x)` with the project's named theme class (e.g. `utility-x`) when the project's `@theme` defines a single-step forwarder. Off by default. |

## Output

Text output groups findings by file:

```text
normwinds v3.1.1: 2 finding(s) across 1 linted file(s).

src/components/Card.vue
    42:14 Classnames 'px-4, py-4' could be replaced by the 'p-4' shorthand!
    67:10 The class 'rounded-[24px]' can be written as 'rounded-3xl'
```

JSON output is stable for CI and tooling:

```json
{
  "version": "3.1.1",
  "ruleId": "tailwindcss/enforces-shorthand",
  "lintedFiles": 1,
  "findingCount": 1,
  "findings": [
    {
      "filePath": "src/components/Card.vue",
      "line": 42,
      "column": 14,
      "message": "Classnames 'px-4, py-4' could be replaced by the 'p-4' shorthand!"
    }
  ]
}
```

## Exit codes

| Exit code | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `0`       | No findings, or requested maintenance command completed successfully. |
| `1`       | Audit findings exist, or canonical drift was detected.                |
| `2`       | Runtime failure.                                                      |

## Fix modes

### `--fix`

`--fix` is intentionally conservative. It targets Vue-first class-string rewrites and is the best default for application projects that want safe cleanup.

### `--fixall`

`--fixall` applies the broader class-string rewrite pass across all supported source file types. Use this for explicit cleanup branches, codemods, or repositories with review coverage.

Always review autofix diffs before committing.

### `--suggest-named-theme-vars` (opt-in, audit) / `--theme-css` (auto-engaged at fix)

NormWind can rewrite class tokens that reference a Tailwind v4 `@theme` variable in their long form (`border-(--color-ink-400)`, `border-[var(--color-ink-400)]/40`, `rounded-[var(--radius-sm)]`) to the equivalent named-utility form (`border-ink-400`, `border-ink-400/40`, `rounded-sm`).

Two `@theme` patterns are supported:

**Direct pattern** — the project authors the theme key itself:

```css
@theme {
  --color-ink-400: var(--color-zinc-400);
  --radius-sm: 0.125rem;
}
```

`border-(--color-ink-400)/40` → `border-ink-400/40`, `rounded-[var(--radius-sm)]` → `rounded-sm`.

**Forwarder pattern** — the project forwards a Tailwind-namespaced theme var to a foreign root variable:

```css
@theme {
  --color-outline-variant: var(--md-sys-color-outline-variant);
}
```

`border-(--md-sys-color-outline-variant)` → `border-outline-variant`.

Both rewrites are gated by a per-token CSS rule-body equivalence check: NormWind asks Tailwind to compile both candidates and only emits the rewrite when the produced rule bodies are byte-equivalent (after substituting the forwarder, where applicable). Ambiguous forwarders, unknown variables, and prefix-mismatches (e.g. `rounded-(--color-ink-400)` — `rounded-` is not a color utility) are silently skipped.

**Audit (opt-in via flag):**

```bash
npx @lunawerx/normwind \
  --suggest-named-theme-vars \
  --theme-css src/assets/css/theme.css \
  --json
```

**Fix (auto-engaged when `--theme-css` is provided):**

```bash
npx @lunawerx/normwind \
  --fixall \
  --theme-css src/assets/css/theme.css
```

The audit suggestion flag is intentionally still opt-in to preserve the existing public audit contract. During `--fix`/`--fixall` the safety gate is the per-token equivalence check, so passing `--theme-css` alone is sufficient. When neither `--theme-css` nor `--suggest-named-theme-vars` is passed, NormWind produces identical output to v3.0.0; existing CI pipelines are unaffected.

## CI examples

Fail a pull request when shorthand or canonical findings exist:

```bash
npx @lunawerx/normwind --json
```

Run the package's full maintainer verification suite:

```bash
npm test
```

Maintainer pre-push check:

```bash
npm run prepush
```

The pre-push suite verifies:

- package metadata
- canonical snapshot integrity
- canonical drift
- regression fixtures
- live Tailwind canonicalizer vs snapshot parity
- CLI audit/fix smoke behavior
- `npm pack --dry-run` package contents

## Package contents

The npm package intentionally publishes only runtime assets and reference docs:

- `bin/normwind.mjs`
- `docs/reference/canonical-replacements.json`
- `docs/reference/canonical-replacements.md`
- `README.md`
- `package.json`

Tests and fixtures are kept in the source repository but excluded from the packed npm artifact.

## Development

Run all checks:

```bash
npm test
```

Update regression fixtures after an intentional behavior change:

```bash
npm run test:regression:update
```

Run the regression suite:

```bash
npm run test:regression
```

Compare live Tailwind canonicalization against the bundled snapshot:

```bash
npm run test:compare
```

Regenerate canonical replacement files:

```bash
npm run canonical:extract
```

Verify canonical replacement files are current:

```bash
npm run canonical:check
```

## Notes on Tailwind v4 and eslint-plugin-tailwindcss

NormWind intentionally uses `eslint-plugin-tailwindcss`'s static group data instead of invoking the plugin's `enforces-shorthand` rule directly. Under Tailwind v4, the plugin's config path can return only `separator` and `prefix`, which prevents the rule from resolving many utility families. NormWind keeps the useful upstream group data while using its own Tailwind v4-compatible matcher and Tailwind's own v4 canonicalization engine.

## Changelog

### v3.3.0 — 2026-05-08

- **Direct-theme-key resolver** — `--suggest-named-theme-vars` now collapses utilities that reference a registered `@theme` variable directly (e.g. `border-(--color-ink-400)/40`, `text-(--color-ink-700)`, `rounded-[var(--radius-sm)]`) to the named form (`border-ink-400/40`, `text-ink-700`, `rounded-sm`). Previously the resolver only handled the forwarder pattern (`--color-x: var(--md-sys-color-x)` authored with `--md-sys-color-x`); it now also handles the direct pattern where the project authors the theme key itself. The CSS rule-body equivalence check still gates every emitted suggestion, so safety is unchanged.
- **Modifier-aware** — opacity-style modifiers such as `/40` and `!` important markers now flow through the named-theme-var resolver: `border-(--color-ink-400)/40` round-trips to `border-ink-400/40` instead of being silently skipped.
- **Bracket-form audit coverage** — the audit's arbitrary-token regex now matches an optional trailing `/<modifier>` suffix, so tokens like `border-[var(--color-ink-400)]/40` reach the canonicalizer instead of being dropped on the floor. The audit also chains Tailwind's canonicalizer into the named-theme resolver, so a single finding emits the most specific safe rewrite (e.g. `border-[var(--color-ink-400)]/40` → `border-ink-400/40` in one message).
- **Theme CSS auto-engages the resolver during fix** — `--fix`/`--fixall` now apply named-theme-var rewrites whenever `--theme-css` is provided; the explicit `--suggest-named-theme-vars` flag is no longer required at fix time. The per-token CSS equivalence check is the safety gate. Audit-time still requires the explicit flag (preserves the existing public contract).
- **Order-agnostic `w`/`h` → `size` shorthand** — height-first authoring (`h-5 w-5`, `hover:h-8 hover:w-8`) now collapses to `size-5`, `hover:size-8` alongside the width-first form. Previously `mergeFixWidthHeight` only matched width-first pairs.
- **Multi-line class strings with `data-[state=...]:` variants are no longer skipped** — the operator-character heuristic that classifies a class string as "fixable" used to reject anything containing `=`, `>`, `<`, etc. That filter now ignores characters that appear inside Tailwind's `[…]` and `(…)` brackets, so attribute-style variants such as `data-[state=open]:text-(--color-ink-1000)` and `aria-[expanded=true]:rotate-180` no longer suppress fixes on their host class string.
- **New regression fixtures** — `reverse-size-shorthand` (height-first `w`/`h`), `multiline-with-data-attr` (variant brackets in multi-line class strings), and `named-theme-var-direct` (the seven direct-theme-key example tokens plus a negative case for an unknown var). The regression harness now auto-supplies `--theme-css` and `--suggest-named-theme-vars` for any fixture that ships a sibling `theme.css`, and the prepush gate counts fixtures dynamically instead of asserting a magic number.

### v3.2.0 — 2026-05-08

- **Vue dynamic bindings** — the class-attribute extractor now matches `:class="..."` and `v-bind:class="..."` in addition to plain `class="..."`, so utilities embedded in Vue ternaries and object/array bindings are audited and fixed alongside their static siblings
- **Multi-line class attributes** — the extractor regex no longer terminates at the first newline, so class lists wrapped across multiple lines (common in templates and JSX) are now picked up in full
- **Internal refactor** — class-string extraction has been split into focused helpers (`shouldExtractQuotedClassValue`, `extractNestedQuotedClassStrings`) for readability and to make future extractor changes easier to reason about; no behavior change beyond the two items above
- **Packaging hygiene** — the `package.json` `files` whitelist now lists `bin/normwind.mjs` explicitly instead of the entire `bin/` directory, and the prepush gate fails the publish if any `*.bak`, `*.orig`, `*.swp`, or `*.tmp` straggler ends up in the tarball
- **Single source of truth** — the parent/`repo-clone` wrapper layout has been collapsed into a single flat repo; `bin/normwind.mjs` is the only CLI source, and `scripts/release.py` no longer copies files at release time

### v3.1.1

- **`--suggest-named-theme-vars` flag (opt-in)** — detects classes of the form `utility-(--var-name)` and, when the project's `@theme` defines a single-step forwarder for that variable, suggests (or rewrites with `--fixall`) the equivalent named-theme class such as `utility-name`
- **`--theme-css <path>` flag** — points NormWind at the project's Tailwind entry CSS so the named-theme resolver can see project `@theme` forwarders in addition to Tailwind's own theme. The path is treated as an **entry file**: NormWind recursively inlines local `@import` directives (`./`, `../`, `/`) so a `style.css` that only re-exports `@import "./styles/core/tokens.css"` is fully resolved. Package imports such as `@import "tailwindcss"` are skipped (the design system already provides them).
- **Hash-namespaced resolver cache** — the on-disk cache key is `themevar:<sha1(resolvedCss)>:<rawToken>`, so two projects whose forwarders disagree never poison each other's cached suggestions; changing a forwarder in `tokens.css` automatically invalidates the bucket.
- **Fail-loud on missing `@theme`** — when `--theme-css` resolves to a CSS graph with no `@theme` block, NormWind prints a one-line diagnostic identifying the entry file and the number of files inspected, instead of silently producing zero suggestions
- **Runtime-equivalence gating** — suggestions are emitted only when both candidates compile to byte-equivalent CSS rule bodies after substituting the forwarder; ambiguous or non-forwarder mappings are skipped
- **Single-token paren-form support** — `.vue` files now correctly fix bare `:class="'border-(--md-sys-color-x)'"` strings inside ternaries and computed bindings
- **Zero default change** — when the flag is omitted, NormWind produces identical output to v3.1.0; existing CI pipelines are unaffected

### v3.1.0 — 2026-04-29

- **Bundled canonical snapshot** — ships `docs/reference/canonical-replacements.json` (12 086 entries) generated from Tailwind's own `designSystem.canonicalizeCandidates` engine; no cold boot required on first run
- **`--check-canonical` flag** — exits `1` when the bundled snapshot is missing or stale; suitable for CI
- **`canonical:extract` / `canonical:check` scripts** — maintainer workflow for regenerating and verifying the snapshot
- **7-fixture regression harness** — covers arbitrary-canonical, corner shorthands, family shorthands, negative cases, place-shorthands, size-shorthands, and variant-prefixed shorthands
- **Live-vs-snapshot parity test** — `test:compare` verifies the bundled snapshot matches Tailwind's live canonicalizer
- **7-check pre-push suite** — `npm run prepush` gates metadata, snapshot integrity, drift, fixtures, parity, CLI smoke, and pack dry-run before any publish
- **Tailwind v4 note** — documents why the `eslint-plugin-tailwindcss` rule is bypassed under v4 (plugin returns only `separator`/`prefix`); NormWind uses the upstream group data with its own v4-compatible matcher

### v3.0.0

Initial public release. Shorthand auditor and autofixer for Tailwind CSS utility classes.

## License

MIT
