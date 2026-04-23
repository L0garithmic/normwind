# NormWind

Normalize Tailwinds.

NormWind is a Tailwind CSS shorthand linter + autofixer focused on one job: replace verbose utility combinations with canonical, shorter, safer class names.

If you use Tailwind in Vue, React, or TypeScript projects and want cleaner utility strings that are easier to maintain, NormWind gives you an automated path.

## Why NormWind

Tailwind codebases drift over time. Teams add classes quickly, and eventually you get repetitive patterns such as:

- `px-4 py-4` instead of `p-4`
- `w-6 h-6` instead of `size-6`
- non-canonical arbitrary values where a standard utility already exists

NormWind audits and optionally fixes these patterns so your class lists are:

- shorter
- more consistent
- easier to review
- easier for AI coding tools to understand and transform correctly

## Features

- Tailwind shorthand detection for common utility families (spacing, sizing, inset, gap, overflow, and more)
- Canonicalization checks against Tailwind's design system for arbitrary values
- Safe autofix mode for Vue-first class string rewrites
- Optional broader autofix mode for all supported file types
- Vue/component prop class strings and dynamic `:class` branches with single-token arbitrary utilities are audited and auto-fixed
- JSON output mode for CI pipelines and custom reporting
- Canonical extraction mode to generate replacement references

## Install

```bash
npm i -D @lunawerx/normwind
```

## Quick Start

Run an audit:

```bash
npx @lunawerx/normwind
```

Apply safe fixes and re-audit:

```bash
npx @lunawerx/normwind --fix
```

This also catches single-token arbitrary utilities in Vue-oriented strings such as `panel-class="z-[var(--token)]"` and `:class="open ? 'aspect-[21/7]' : ''"`.

Run the broader fixer:

```bash
npx @lunawerx/normwind --fixall
```

## CLI Commands

- `normwind` runs the shorthand/canonical audit and exits with code `1` when findings exist
- `normwind --fix` applies safe autofixes (Vue-first scope) then re-runs audit
- `normwind --fixall` applies broader autofixes across supported file types
- `normwind --json` prints machine-readable output
- `normwind --extract-canonical` performs canonical extraction in ephemeral mode
- `normwind --extract-canonical --write-canonical-files` writes canonical artifacts to docs/reference
- `normwind --cleanup-canonical-files` removes generated canonical artifacts

## File Matching

By default, NormWind scans:

- `**/*.{vue,js,mjs,ts,jsx,tsx}`

Target specific paths or globs:

```bash
npx @lunawerx/normwind src
npx @lunawerx/normwind "src/**/*.vue"
npx @lunawerx/normwind "apps/web/**/*.{tsx,ts}"
```

## Example Output

```text
src/components/Card.vue
	42:14 Classnames 'px-4, py-4' could be replaced by the 'p-4' shorthand!
	67:10 The class 'rounded-[24px]' can be written as 'rounded-3xl'
```

## CI Usage

NormWind is designed for pull request enforcement:

```bash
npx @lunawerx/normwind --json
```

Non-zero exit code means findings exist, making it easy to gate merges and keep Tailwind utility style consistent across teams.

## Best Fit

NormWind is ideal for:

- Tailwind CSS apps with many contributors
- teams standardizing utility conventions
- repositories using AI-assisted code generation where class consistency matters
- design system cleanup and drift prevention initiatives

## Package Keywords

Tailwind CSS, shorthand, canonicalization, linter, autofix, utility classes, codemod, Vue, React, TypeScript.

## License

MIT
