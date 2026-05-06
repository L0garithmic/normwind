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

### `--suggest-named-theme-vars` (opt-in)

When a Tailwind v4 `@theme` block defines a forwarder such as:

```css
@theme {
  --color-outline-variant: var(--md-sys-color-outline-variant);
}
```

Tailwind exposes both forms at runtime:

- the long form: `border-(--md-sys-color-outline-variant)`
- the named form: `border-outline-variant`

Both compile to runtime-equivalent CSS, but the named form is shorter and stays in sync with the design system. NormWind can suggest the named form instead of the raw CSS-variable form — but only when:

1. you pass `--suggest-named-theme-vars` (off by default), and
2. you pass `--theme-css <path>` pointing to the project's Tailwind entry CSS that contains the `@theme` block, and
3. the produced CSS rule body for both candidates is byte-equivalent after substituting the forwarder. Ambiguous forwarders (multiple named tokens forwarding to the same source variable) are skipped.

Example:

```bash
npx @lunawerx/normwind \
  --suggest-named-theme-vars \
  --theme-css src/assets/css/theme.css \
  --json
```

Combine with `--fixall` to rewrite in place:

```bash
npx @lunawerx/normwind \
  --fixall \
  --suggest-named-theme-vars \
  --theme-css src/assets/css/theme.css
```

When the flag is omitted, NormWind never suggests or rewrites these tokens. There is zero behavioural change for existing pipelines.

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
