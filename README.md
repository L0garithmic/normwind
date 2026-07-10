<div align="center">

<a href="https://github.com/L0garithmic/normwind">
  <img src="https://raw.githubusercontent.com/L0garithmic/normwind/main/assets/normwind-share-card.png" alt="NormWind — Normalize Tailwinds" width="880">
</a>

<br/>
<br/>

[![npm version](https://img.shields.io/npm/v/@lunawerx/normwind?style=flat-square&logo=npm&logoColor=white&label=npm&color=05b0dc&labelColor=0a0e17)](https://www.npmjs.com/package/@lunawerx/normwind)
[![npm downloads](https://img.shields.io/npm/dm/@lunawerx/normwind?style=flat-square&label=downloads&color=0588bd&labelColor=0a0e17)](https://www.npmjs.com/package/@lunawerx/normwind)
[![node](https://img.shields.io/node/v/@lunawerx/normwind?style=flat-square&label=node&color=04609f&labelColor=0a0e17)](https://nodejs.org)
[![Tailwind CSS v4](https://img.shields.io/badge/Tailwind_CSS-v4-05b0dc?style=flat-square&logo=tailwindcss&logoColor=white&labelColor=0a0e17)](https://tailwindcss.com)
[![license MIT](https://img.shields.io/badge/license-MIT-05b0dc?style=flat-square&labelColor=0a0e17)](https://opensource.org/licenses/MIT)

<strong>Normalize Tailwinds.</strong><br/>
A tiny, zero-config CLI that finds bloated Tailwind utility classes and rewrites them into their short, canonical form.

</div>

---

Tailwind codebases drift. Over time — especially with a dozen hands and a few AI assistants on the keyboard — class strings pile up combinations that are perfectly valid but noisier than they need to be. `px-4 py-4` where `p-4` would do. `rounded-[24px]` where `rounded-3xl` already exists. `w-6 h-6` instead of `size-6`.

**NormWind** hunts those down. Point it at your project and it will either **tell you** what could be tightened, or **fix it for you** — safely, deterministically, and without forcing a formatter, a sort order, or any config on your repo.

```bash
npx @lunawerx/normwind           # audit
npx @lunawerx/normwind --fix      # audit, then safely rewrite
```

## ✨ At a glance

NormWind collapses two kinds of noise: **verbose utility combinations** and **non-canonical arbitrary values**.

| You wrote…                        | NormWind gives you |
| --------------------------------- | ------------------ |
| `px-4 py-4`                       | `p-4`              |
| `pl-2 pr-2`                       | `px-2`             |
| `mt-3 mb-3`                       | `my-3`             |
| `w-6 h-6`                         | `size-6`           |
| `content-center justify-center`   | `place-content-center` |
| `rounded-[24px]`                  | `rounded-3xl`      |
| `w-[100%]`                        | `w-full`           |
| `h-[1.5rem]`                      | `h-6`              |

Every rewrite is backed by Tailwind's **own** engine (more on that [below](#-why-you-can-trust-the-rewrites)) — NormWind never guesses.

## 🤔 Why you'd want it

Reach for NormWind when you want:

- 🧵 **Shorter class strings** that stay readable
- 🎯 **Consistent shorthand** across a whole team
- 🚫 **Fewer arbitrary values** when a named Tailwind token already exists
- 🛡️ **CI enforcement** so utility bloat never lands on `main` again
- 🩹 **Safe autofixes** — Vue-first by default, broader when you ask for it
- 🌱 **Zero config** — no rules file, no plugins to register, no opinions imposed

## 📦 Install

```bash
npm i -D @lunawerx/normwind
```

…or don't install it at all:

```bash
npx @lunawerx/normwind
```

Both command names are exposed, so pick whichever your fingers prefer:

```bash
normwind
normwinds
```

## 🚀 Quick start

```bash
# Audit the current project (exits 1 if there's anything to clean up)
npx @lunawerx/normwind

# Apply safe, Vue-first fixes, then re-audit
npx @lunawerx/normwind --fix

# Go wide — fix across every supported file type
npx @lunawerx/normwind --fixall

# Preview a fix run without writing anything to disk
npx @lunawerx/normwind --fixall --dry-run

# Machine-readable output for CI and custom tooling
npx @lunawerx/normwind --json

# Scope it to a folder or a glob
npx @lunawerx/normwind src
npx @lunawerx/normwind "apps/web/**/*.{tsx,ts}"
```

## 🧠 What NormWind checks

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

### Canonical arbitrary values

It also catches arbitrary values that Tailwind's own design system can express as a named utility:

| Arbitrary        | Canonical     |
| ---------------- | ------------- |
| `rounded-[24px]` | `rounded-3xl` |
| `w-[100%]`       | `w-full`      |
| `h-[1.5rem]`     | `h-6`         |
| `p-[1rem]`       | `p-4`         |
| `m-[8px]`        | `m-2`         |

### 🔒 Why you can trust the rewrites

NormWind doesn't invent mappings:

- **Shorthand groups** come straight from [`eslint-plugin-tailwindcss`](https://github.com/francoismassart/eslint-plugin-tailwindcss)'s Tailwind utility-group definitions.
- **Canonical values** come from Tailwind's own `designSystem.canonicalizeCandidates` engine.

So the "after" is always something Tailwind itself considers equivalent — never a stylistic guess.

## 🎛️ CLI reference

| Command                                                  | What it does |
| -------------------------------------------------------- | ------------ |
| `normwind`                                               | Audit supported files. Exits `1` when findings exist. |
| `normwind --json`                                        | Print machine-readable audit output. |
| `normwind --fix`                                         | Apply safe, Vue-first fixes, then re-run the audit. |
| `normwind --fixall`                                      | Apply broader fixes across Vue, JS, MJS, TS, JSX, and TSX, then re-run the audit. |
| `normwind --fix --dry-run` / `normwind --fixall --dry-run` | Show which files *would* be rewritten without writing anything to disk. |
| `normwind --extract-canonical`                           | Extract canonical replacements in memory and print a summary. |
| `normwind --extract-canonical --write-canonical-files`   | Write `docs/reference/canonical-replacements.{json,md}`. |
| `normwind --check-canonical`                             | Fail if the generated canonical files are missing or stale. |
| `normwind --cleanup-canonical-files`                     | Remove generated canonical files from `docs/reference`. |
| `normwind --suggest-named-theme-vars --theme-css <path>` | *(opt-in)* Suggest replacing `utility-(--md-sys-color-x)` with your project's named theme class. Off by default. |
| `normwind -h, --help`                                    | Print usage and exit `0`. |
| `normwind -v, --version`                                 | Print the installed normwind version and exit `0`. |

## 🧾 Output

Text output groups findings by file — readable at a glance:

```text
normwinds v3.5.0: 2 finding(s) across 1 linted file(s).

src/components/Card.vue
    42:14 Classnames 'px-4, py-4' could be replaced by the 'p-4' shorthand!
    67:10 The class 'rounded-[24px]' can be written as 'rounded-3xl'
```

JSON output is stable and CI-friendly:

```json
{
  "version": "3.5.0",
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

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | No findings, or a requested maintenance command completed successfully. |
| `1`  | Audit findings exist, or canonical drift was detected. |
| `2`  | Usage or runtime error (unknown flag, missing `--theme-css` value, unreadable `--theme-css` path, etc.), **or** `--fix`/`--fixall` finished with one or more files skipped/failed (see the fix summary printed to stderr). |

## 🔧 Fix modes

### `--fix` — the safe default

`--fix` is intentionally conservative. It targets Vue-first class-string rewrites and is the best default for application projects that just want tidy, low-risk cleanup.

### `--fixall` — the whole codebase

`--fixall` applies the broader class-string rewrite pass across **all** supported source types. Use it for explicit cleanup branches, codemods, or repos with solid review coverage.

### Per-file fault isolation

Each file's read, transform, and write are isolated: a locked file (`EBUSY`/`EPERM`, common on Windows when an editor or antivirus has it open), a full disk (`ENOSPC`), or an edge-case parser exception on one file is logged and skipped — it never aborts the rest of the batch. At the end of a run with any skips or failures, a summary is printed to stderr (`fix summary — N fixed, N skipped, N failed`) with a line per affected file, and the process exits `2` so CI can distinguish a partial run from a clean one.

### `--dry-run` — preview without writing

Add `--dry-run` to either `--fix` or `--fixall` to see which files would be rewritten — each is printed as `[dry-run] would rewrite <path>` — without touching anything on disk. Combine it with `--json` to get the same findings a real run would report, so you can review the diff a rewrite would produce before committing to it.

> **Always run NormWind's autofix from a clean working tree under version control** (git or equivalent), and review the diff before committing. `--fix`/`--fixall` write through an atomic temp-file-then-rename per file, so a crash or interrupted run can't truncate a source file — but a working-tree safety net (commit, stash, or branch) is still the only way to cheaply undo a rewrite you don't like. `--dry-run` is the no-risk way to preview first.

## 📁 File matching

By default NormWind scans:

```text
**/*.{vue,js,mjs,ts,jsx,tsx}
```

…and skips the usual generated / dependency folders:

`.git` · `.venv` · `node_modules` · `dist` · `test-results` · `cdk.out` · `.tmp` · `.saydeploy`

Target specific paths or globs any time:

```bash
npx @lunawerx/normwind src
npx @lunawerx/normwind "src/**/*.vue"
npx @lunawerx/normwind "apps/web/**/*.{tsx,ts}"
```

A pattern that matches no files prints a warning instead of failing silently.

### 🎯 What gets scanned

NormWind only audits and fixes class strings anchored to class-bearing attributes:

- `class="..."`, `className="..."`, `:class="..."`, and `v-bind:class="..."` — quoted values, JSX-brace values (`className={...}`), quoted strings nested inside those values (ternaries, object/array bindings), and static chunks of template literals.
- Object-property form — `{ class: "..." }` / `{ className: "..." }` as used by `createElement`/hyperscript/render-function calls.
- Attribute names that merely *end* in `-class` (e.g. `data-class`) are excluded — only the exact attribute names above match.
- Template-literal `${...}` interpolations no longer disqualify the whole literal; static chunks around an interpolation are still processed, and partial tokens straddling an interpolation boundary (e.g. `` h-${size} ``) are never touched.
- Class strings containing a bare `*` outside `[...]`/`(...)` brackets are conservatively skipped by both the audit and the fixer.

**Guarantee:** strings outside class-bearing attributes — SQL fragments, `title="..."` text, arbitrary object keys, etc. — are never inspected or modified. Earlier versions scanned every quoted string in a file; that behavior is gone.

<details>
<summary><strong>🎨 Named theme variables — <code>--suggest-named-theme-vars</code> / <code>--theme-css</code> (advanced)</strong></summary>

<br/>

NormWind can rewrite class tokens that reference a Tailwind v4 `@theme` variable in their long form (`border-(--color-ink-400)`, `border-[var(--color-ink-400)]/40`, `rounded-[var(--radius-sm)]`) into the equivalent named-utility form (`border-ink-400`, `border-ink-400/40`, `rounded-sm`).

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

**Audit** (opt-in via flag):

```bash
npx @lunawerx/normwind \
  --suggest-named-theme-vars \
  --theme-css src/assets/css/theme.css \
  --json
```

**Fix** (auto-engaged when `--theme-css` is provided):

```bash
npx @lunawerx/normwind \
  --fixall \
  --theme-css src/assets/css/theme.css
```

The audit suggestion flag is intentionally still opt-in to preserve the existing public audit contract. During `--fix`/`--fixall` the safety gate is the per-token equivalence check, so passing `--theme-css` alone is enough. When neither `--theme-css` nor `--suggest-named-theme-vars` is passed, NormWind's output is identical to v3.0.0 — existing CI pipelines are unaffected.

</details>

## 🗂️ The bundled canonical snapshot

NormWind ships a generated Tailwind canonical-replacement snapshot so your first run is fast and deterministic — no cold-boot compilation, and nothing generated is written into your project:

- `docs/reference/canonical-replacements.json`
- `docs/reference/canonical-replacements.md`

It's generated from Tailwind's own canonicalization engine for the exact Tailwind version this package bundles.

**Lookup order:**

1. A project-local snapshot at `docs/reference/canonical-replacements.json`, if present.
2. The package-bundled snapshot.
3. Tailwind's live design-system canonicalizer, for cache misses or a missing snapshot.

Maintainers can regenerate and verify it:

```bash
npm run canonical:extract   # regenerate
npm run canonical:check     # verify (deterministic, CI-safe)
```

## 🤖 In CI

Fail a pull request when shorthand or canonical findings exist:

```bash
npx @lunawerx/normwind --json
```

That's it — exit code `1` fails the job, and the JSON payload is stable enough to feed a custom reporter or annotation step.

## 🧰 What's in the box

The npm package intentionally publishes only runtime assets, brand assets, and reference docs:

- `bin/normwind.mjs`
- `docs/reference/canonical-replacements.json`
- `docs/reference/canonical-replacements.md`
- `assets/` — logos and the share card
- `README.md`
- `package.json`

Tests and fixtures live in the source repo but are excluded from the packed tarball.

<details>
<summary><strong>🧑‍💻 Development &amp; maintainer commands</strong></summary>

<br/>

Run the full pre-push verification suite:

```bash
npm test          # alias: npm run prepush
```

The pre-push suite verifies package metadata, canonical-snapshot integrity, canonical drift, regression fixtures, live-Tailwind-vs-snapshot parity, CLI audit/fix smoke behavior, and `npm pack --dry-run` contents.

Other useful scripts:

```bash
npm run test:regression          # run the regression fixtures
npm run test:regression:update   # update fixtures after an intentional change
npm run test:compare             # live canonicalizer vs bundled snapshot
npm run canonical:extract        # regenerate canonical replacement files
npm run canonical:check          # verify canonical replacement files are current
```

</details>

<details>
<summary><strong>📐 A note on Tailwind v4 &amp; eslint-plugin-tailwindcss</strong></summary>

<br/>

NormWind deliberately uses `eslint-plugin-tailwindcss`'s **static group data** instead of invoking the plugin's `enforces-shorthand` rule directly. Under Tailwind v4, the plugin's config path can return only `separator` and `prefix`, which prevents the rule from resolving many utility families. NormWind keeps the useful upstream group data while using its own Tailwind v4-compatible matcher and Tailwind's own v4 canonicalization engine — so you get the plugin's knowledge without its v4 blind spots.

</details>

## 📜 Changelog

<details>
<summary><strong>v3.5.0</strong> — 2026-07-09 · fault isolation, classifier parity, --dry-run, corner-family merger</summary>

<br/>

- **Fault-isolated `--fix`/`--fixall`** — a per-file try/catch means one `EBUSY`/`EPERM`/transform throw no longer aborts the whole batch; a fixed/skipped/failed summary prints, with a distinct exit code when anything failed.
- **Unified audit/fix classifiers** — `isLikelyTailwindUtility`/`isLikelyFixUtility` and `matchUtilityToBody`/`matchFixBodyValue` now share matching logic (bracket-variant and bare-body parity), closing gaps where `--fix` missed findings the audit reported.
- **`--dry-run`** — pair with `--fix`/`--fixall` to see which files would be rewritten without touching disk.
- **Scanner guards** — the fallback walker now skips oversized files and detects symlink loops instead of hanging or erroring.
- **Corner and four-sides family merger rewritten** — the fixer now uses the same family-table clustering the audit uses, so corner pairs (`rounded-tl` + `rounded-tr` → `rounded-t`), border side pairs (`border-t` + `border-b` → `border-y`), and complete four-sides sets (`rounded-t/r/b/l` → `rounded`, `border-t/r/b/l` → `border`) converge instead of persisting as unfixable findings.

</details>

<details>
<summary><strong>v3.4.2</strong> — 2026-07-06</summary>

<br/>

- **New brand** — NormWind logo, wordmarks, and share card (`assets/`), plus a redesigned README.
- **MIT LICENSE file** added (the package always declared MIT; now the text ships too).
- Brand assets live in the repo only — the npm tarball stays lean (bin, canonical snapshot, README, LICENSE).

</details>

<details>
<summary><strong>v3.4.1</strong> — 2026-07-06</summary>

<br/>

- **npm publishing moved to GitHub Actions with provenance.** Pushing a `v*` tag triggers the `Release` workflow, which re-runs the full test suite and then `npm publish --provenance` — packages now carry a verified build attestation linking them to this repo, commit, and workflow. `scripts/release.py` still drives the release locally (tests, bump, tag, GitHub release) but now waits for the Actions publish and verifies the version is live on the registry; `--publish-locally` remains as a fallback. Local releases no longer need an npm token.
- **Line-ending hardening in the shipped binary.** The `--check-canonical` drift check is tolerant of CRLF checkouts (git `autocrlf` on fresh Windows clones previously failed it), and `.gitattributes` pins the generated artifacts to LF. The v3.4.0 npm tarball already contained this fix; the tag now does too.
- **release.py pre-flight hardening** — validates GitHub credentials (with `gh` CLI token fallback) before any mutation, runs the npm dry-run at the new version, never echoes tokens, and always restores the clean git remote URL.

</details>

<details>
<summary><strong>v3.4.0</strong> — 2026-07-06</summary>

<br/>

- **Anchored class-string extraction** — audit and fix now only inspect `class=`, `className=`, `:class=`, and `v-bind:class=` attribute values (quoted or JSX-brace form, including nested quoted strings inside bindings and static template-literal chunks) plus the object-property form `{ class: "..." }` / `{ className: "..." }`. The previous behavior — scanning every quoted string in a file — is gone; it could rewrite unrelated code such as SQL strings, `title="..."` text, or `data-class` attributes. Attribute names that merely *end* in `-class` are excluded.
- **One shared extractor** — audit and fix now use the same extraction path, so "audit clean" guarantees "`--fix` is a no-op." Class strings containing a bare `*` outside `[...]`/`(...)` brackets are conservatively skipped by both.
- **Atomic writes** — `--fix`/`--fixall` now write through a temp file + rename, so a crash mid-write can no longer truncate a source file.
- **Order-independent padding merge** — `pt-4 pb-4 pl-4 pr-4` now fully merges to `p-4` regardless of declaration order (previously order-dependent).
- **Template literals** — `${...}` interpolations no longer disqualify the whole literal; static chunks are still audited/fixed, and partial tokens straddling an interpolation boundary (e.g. `` h-${size} ``) are never touched.
- **New flags** — `-v`/`--version` prints the version and exits `0`. Unknown flags now error with exit `2` instead of being silently ignored. A `--theme-css` with a missing value errors; a `--theme-css` path that can't be read now fails loud (exit `2`) instead of silently disabling the feature. Patterns that match no files print a warning.
- **`-h` now works** — previously only `--help` was recognized.
- **Documented exit codes** — `0` no findings, `1` findings, `2` usage/runtime error.
- **Version banner fixed** — the CLI now reads its version from `package.json` at runtime instead of a hardcoded string (the banner had been stuck on `v3.1.1` for two releases).
- **Portable canonical artifacts** — `docs/reference/canonical-replacements.*` no longer embed an absolute machine path or the tool version, so `npm test`/`--check-canonical` passes on any machine.
- **File discovery fixes** — ripgrep returning "no matches" is no longer misread as "ripgrep is missing"; the no-`rg` fallback now applies glob patterns properly, and its ignore list matches ripgrep's (`.venv` and `.git` added).
- **Trailer text** — the text report's trailer no longer references `npm run lint` (a project-specific script); it now suggests `--fix`/`--fixall`.

</details>

<details>
<summary><strong>v3.3.0</strong> — 2026-05-08 · direct-theme-key resolver, w/h order fix, multi-line variant brackets</summary>

<br/>

- **Direct-theme-key resolver** — `--suggest-named-theme-vars` now collapses utilities that reference a registered `@theme` variable directly (e.g. `border-(--color-ink-400)/40`, `text-(--color-ink-700)`, `rounded-[var(--radius-sm)]`) to the named form (`border-ink-400/40`, `text-ink-700`, `rounded-sm`). Previously the resolver only handled the forwarder pattern; it now also handles the direct pattern where the project authors the theme key itself. The CSS rule-body equivalence check still gates every emitted suggestion, so safety is unchanged.
- **Modifier-aware** — opacity-style modifiers such as `/40` and `!` important markers now flow through the named-theme-var resolver: `border-(--color-ink-400)/40` round-trips to `border-ink-400/40` instead of being silently skipped.
- **Bracket-form audit coverage** — the audit's arbitrary-token regex now matches an optional trailing `/<modifier>` suffix, so tokens like `border-[var(--color-ink-400)]/40` reach the canonicalizer. The audit also chains Tailwind's canonicalizer into the named-theme resolver, so a single finding emits the most specific safe rewrite.
- **Theme CSS auto-engages the resolver during fix** — `--fix`/`--fixall` now apply named-theme-var rewrites whenever `--theme-css` is provided; the explicit `--suggest-named-theme-vars` flag is no longer required at fix time.
- **Order-agnostic `w`/`h` → `size` shorthand** — height-first authoring (`h-5 w-5`, `hover:h-8 hover:w-8`) now collapses to `size-5`, `hover:size-8` alongside the width-first form.
- **Multi-line class strings with `data-[state=…]:` variants are no longer skipped** — the operator-character heuristic now ignores characters inside Tailwind's `[…]` and `(…)` brackets, so attribute-style variants such as `data-[state=open]:text-(--color-ink-1000)` and `aria-[expanded=true]:rotate-180` no longer suppress fixes.
- **New regression fixtures** — `reverse-size-shorthand`, `multiline-with-data-attr`, and `named-theme-var-direct`. The regression harness now auto-supplies `--theme-css`/`--suggest-named-theme-vars` for any fixture that ships a sibling `theme.css`, and the prepush gate counts fixtures dynamically.

</details>

<details>
<summary><strong>v3.2.0</strong> — 2026-05-08 · Vue :class extraction, multi-line class attrs, packaging hygiene</summary>

<br/>

- **Vue dynamic bindings** — the class-attribute extractor now matches `:class="…"` and `v-bind:class="…"` in addition to plain `class="…"`, so utilities embedded in Vue ternaries and object/array bindings are audited and fixed alongside their static siblings.
- **Multi-line class attributes** — the extractor no longer terminates at the first newline, so class lists wrapped across multiple lines (common in templates and JSX) are picked up in full.
- **Internal refactor** — class-string extraction was split into focused helpers for readability; no behavior change beyond the two items above.
- **Packaging hygiene** — the `files` whitelist lists `bin/normwind.mjs` explicitly, and the prepush gate fails the publish if any `*.bak`/`*.orig`/`*.swp`/`*.tmp` straggler lands in the tarball.
- **Single source of truth** — the parent/`repo-clone` wrapper layout collapsed into a single flat repo; `bin/normwind.mjs` is the only CLI source.

</details>

<details>
<summary><strong>v3.1.1</strong> · named-theme-var flag, theme-css entry inlining</summary>

<br/>

- **`--suggest-named-theme-vars` flag (opt-in)** — detects `utility-(--var-name)` classes and, when the project's `@theme` defines a single-step forwarder, suggests (or rewrites with `--fixall`) the equivalent named-theme class.
- **`--theme-css <path>` flag** — points NormWind at your Tailwind entry CSS; it recursively inlines local `@import` directives so a re-exporting `style.css` is fully resolved. Package imports like `@import "tailwindcss"` are skipped.
- **Hash-namespaced resolver cache** — the on-disk cache key is `themevar:<sha1(resolvedCss)>:<rawToken>`, so two projects with disagreeing forwarders never poison each other's cache.
- **Fail-loud on missing `@theme`** — a one-line diagnostic instead of silently producing zero suggestions.
- **Runtime-equivalence gating** — suggestions are emitted only when both candidates compile to byte-equivalent CSS rule bodies.
- **Single-token paren-form support** in `.vue` files, and **zero default change** when the flag is omitted.

</details>

<details>
<summary><strong>v3.1.0</strong> — 2026-04-29 · bundled canonical snapshot, CI drift check</summary>

<br/>

- **Bundled canonical snapshot** — ships `docs/reference/canonical-replacements.json` (12,086 entries) generated from Tailwind's own `designSystem.canonicalizeCandidates` engine; no cold boot on first run.
- **`--check-canonical` flag** — exits `1` when the bundled snapshot is missing or stale; CI-suitable.
- **`canonical:extract` / `canonical:check` scripts** — the maintainer workflow for regenerating and verifying the snapshot.
- **7-fixture regression harness**, **live-vs-snapshot parity test**, and a **7-check pre-push suite**.
- **Tailwind v4 note** — documents why the `eslint-plugin-tailwindcss` rule is bypassed under v4.

</details>

<details>
<summary><strong>v3.0.0</strong> · initial public release</summary>

<br/>

Initial public release. Shorthand auditor and autofixer for Tailwind CSS utility classes.

</details>

## 📄 License

[MIT](LICENSE) © [LunaWerx](https://github.com/L0garithmic)

<div align="center">
<br/>
<img src="https://raw.githubusercontent.com/L0garithmic/normwind/main/assets/normwind-icon.png" alt="" width="52">
<br/>
<sub><strong>NormWind</strong> — keep your Tailwind classes calm.</sub>
</div>
