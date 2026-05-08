#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const NORMWINDS_VERSION = "3.1.1";
const RULE_ID = "tailwindcss/enforces-shorthand";
const DEFAULT_PATTERNS = ["**/*.{vue,js,mjs,ts,jsx,tsx}"];
const ROOT_FONT_SIZE_PX = 16;
const FILE_SCAN_CONCURRENCY = 32;
const CANONICAL_OUTPUT_JSON = path.resolve(
    process.cwd(),
    "docs/reference/canonical-replacements.json",
);
const CANONICAL_OUTPUT_MD = path.resolve(
    process.cwd(),
    "docs/reference/canonical-replacements.md",
);
const BUNDLED_CANONICAL_JSON = path.resolve(
    PACKAGE_ROOT,
    "docs/reference/canonical-replacements.json",
);
const RG_IGNORE_GLOBS = [
    "!.git",
    "!.chrome-profile/**",
    "!.chrome-profile-headless/**",
    "!.tmp/**",
    "!.saydeploy/**",
    "!dist/**",
    "!**/dist/**",
    "!infra/aws/bin/app.js",
    "!node_modules/**",
    "!**/node_modules/**",
    "!test-results/**",
    "!**/test-results/**",
    "!**/cdk.out/**",
];
const IGNORED_SEGMENTS = new Set(["cdk.out", "dist", "node_modules", "test-results"]);
const IGNORED_ROOT_PREFIXES = [
    ".chrome-profile/",
    ".chrome-profile-headless/",
    ".tmp/",
    ".saydeploy/",
    "dist/",
    "test-results/",
];
const IGNORED_EXACT_PATHS = new Set(["infra/aws/bin/app.js"]);
const require = createRequire(import.meta.url);

const CACHE_FILE = path.resolve(process.cwd(), "node_modules/.cache/normwinds/canonical-cache.json");
const CACHE_SCHEMA_VERSION = 1;

let tailwindModuleCache = null;
function loadTailwind() {
    if (!tailwindModuleCache) {
        tailwindModuleCache = {
            tailwind: require("tailwindcss"),
            tailwindPkg: require("tailwindcss/package.json"),
            tailwindGroups: require("eslint-plugin-tailwindcss/lib/config/groups").groups,
        };
    }
    return tailwindModuleCache;
}

let designSystemPromise = null;
async function loadTailwindDesignSystem() {
    if (!designSystemPromise) {
        designSystemPromise = (async () => {
            const { tailwind } = loadTailwind();
            const tailwindIndexCssPath = require.resolve("tailwindcss/index.css");
            const css = await fs.readFile(tailwindIndexCssPath, "utf8");
            const designSystem = await tailwind.__unstable__loadDesignSystem(css, {
                from: tailwindIndexCssPath,
            });
            return { designSystem, tailwindIndexCssPath };
        })();
    }
    return designSystemPromise;
}

// Match `@import "...";` (with or without trailing layer/media clauses).
// Captures the import specifier in group 2. Quotes can be " or '.
const CSS_IMPORT_REGEX = /@import\s+(["'])([^"']+)\1[^;]*;\s*/g;

// True when an @import target is a local file path (`./x`, `../x`, `/x`).
// Anything else (`tailwindcss`, `tailwindcss/preflight`, `@scope/pkg`, URLs)
// is treated as a package/runtime import and dropped — Tailwind's own CSS is
// already prepended by the caller, and other package imports cannot be
// resolved without a real bundler.
function isLocalCssImportSpecifier(spec) {
    return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

// Recursively inline local @import directives into the source CSS so
// Tailwind's design-system loader sees the project's @theme blocks even when
// they live in files imported from the entry CSS.
async function inlineLocalCssImports(sourceCss, sourcePath, visited) {
    const sourceDir = path.dirname(sourcePath);
    const parts = [];
    let lastIndex = 0;

    CSS_IMPORT_REGEX.lastIndex = 0;
    let match;
    while ((match = CSS_IMPORT_REGEX.exec(sourceCss)) !== null) {
        parts.push(sourceCss.slice(lastIndex, match.index));
        lastIndex = CSS_IMPORT_REGEX.lastIndex;

        const spec = match[2];
        if (!isLocalCssImportSpecifier(spec)) {
            // Drop package/url imports.
            continue;
        }

        const importedAbs = path.resolve(sourceDir, spec);
        if (visited.has(importedAbs)) {
            // Already inlined upstream — silently skip to avoid cycles and
            // duplicate @theme blocks.
            continue;
        }
        visited.add(importedAbs);

        let importedSource;
        try {
            importedSource = await fs.readFile(importedAbs, "utf8");
        } catch (error) {
            throw new Error(
                `normwinds: failed to read CSS import "${spec}" from ${sourcePath}: ${error.message}`,
            );
        }

        const inlined = await inlineLocalCssImports(importedSource, importedAbs, visited);
        parts.push(`/* normwinds inlined: ${importedAbs} */\n${inlined}\n`);
    }

    parts.push(sourceCss.slice(lastIndex));
    return parts.join("");
}

async function resolveThemeCssEntry(themeCssPath) {
    const absPath = path.resolve(process.cwd(), themeCssPath);
    const entrySource = await fs.readFile(absPath, "utf8");
    const visited = new Set([absPath]);
    const resolvedCss = await inlineLocalCssImports(entrySource, absPath, visited);
    return { absPath, resolvedCss, importedFiles: [...visited] };
}

// Separate cache for the user-augmented design system used by
// --suggest-named-theme-vars. Keyed by the absolute themeCssPath so multiple
// projects in the same Node process never cross-contaminate.
const augmentedDesignSystemPromises = new Map();
async function loadAugmentedDesignSystem(themeCssPath) {
    const absPath = path.resolve(process.cwd(), themeCssPath);
    let promise = augmentedDesignSystemPromises.get(absPath);
    if (!promise) {
        promise = (async () => {
            const { tailwind } = loadTailwind();
            const tailwindIndexCssPath = require.resolve("tailwindcss/index.css");
            const baseCss = await fs.readFile(tailwindIndexCssPath, "utf8");
            const { resolvedCss, importedFiles } = await resolveThemeCssEntry(themeCssPath);

            // Fail loud when the resolved CSS contains no @theme block. Without
            // a project @theme there are no forwarders to detect, so silently
            // returning zero suggestions would mask a misconfiguration. Strip
            // CSS comments first so a comment that mentions "@theme" doesn't
            // satisfy the check.
            const cssWithoutComments = resolvedCss.replace(/\/\*[\s\S]*?\*\//g, "");
            if (!/@theme\b/.test(cssWithoutComments)) {
                throw new Error(
                    `normwinds: --theme-css resolved no @theme block. Inspected ${importedFiles.length} file(s) starting at ${absPath}. Either local @import directives could not be resolved, or the wrong CSS entry was provided.`,
                );
            }

            const css = `${baseCss}\n/* normwinds: --theme-css */\n${resolvedCss}`;
            const themeCssHash = createHash("sha1").update(resolvedCss).digest("hex").slice(0, 12);

            const designSystem = await tailwind.__unstable__loadDesignSystem(css, {
                from: tailwindIndexCssPath,
            });
            return { designSystem, tailwindIndexCssPath, themeCssHash, importedFiles };
        })();
        augmentedDesignSystemPromises.set(absPath, promise);
    }
    return promise;
}

// CANONICAL_MEMO stores token -> canonical (equal to token = no change).
// Pre-populated from on-disk cache; any new entries are persisted on exit.
const CANONICAL_MEMO = new Map();
let diskCacheDirty = false;
let diskCacheTailwindVersion = null;

async function loadDiskCache() {
    try {
        const raw = await fs.readFile(CACHE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (
            parsed &&
            parsed.schema === CACHE_SCHEMA_VERSION &&
            parsed.tailwindVersion &&
            parsed.entries &&
            typeof parsed.entries === "object"
        ) {
            diskCacheTailwindVersion = parsed.tailwindVersion;
            for (const [k, v] of Object.entries(parsed.entries)) {
                CANONICAL_MEMO.set(k, v);
            }
            return true;
        }
    } catch {
        // No cache or invalid — fine.
    }
    return false;
}

async function saveDiskCache() {
    if (!diskCacheDirty) {
        return;
    }
    try {
        const { tailwindPkg } = loadTailwind();
        await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
        const entries = Object.create(null);
        for (const [k, v] of CANONICAL_MEMO.entries()) {
            entries[k] = v;
        }
        const payload = {
            schema: CACHE_SCHEMA_VERSION,
            tailwindVersion: tailwindPkg.version,
            entries,
        };
        await fs.writeFile(CACHE_FILE, JSON.stringify(payload), "utf8");
    } catch {
        // Cache persistence is best-effort — never fail the run.
    }
}

async function loadCanonicalSnapshot() {
    if (process.env.NORMWIND_DISABLE_CANONICAL_SNAPSHOT === "1") {
        return false;
    }

    const paths = [...new Set([CANONICAL_OUTPUT_JSON, BUNDLED_CANONICAL_JSON])];
    const { tailwindPkg } = loadTailwind();

    for (const snapshotPath of paths) {
        try {
            const raw = await fs.readFile(snapshotPath, "utf8");
            const parsed = JSON.parse(raw);

            if (
                !parsed ||
                parsed.source?.tailwindVersion !== tailwindPkg.version ||
                !Array.isArray(parsed.replacements)
            ) {
                continue;
            }

            for (const replacement of parsed.replacements) {
                if (
                    replacement &&
                    typeof replacement.inputClass === "string" &&
                    typeof replacement.canonicalClass === "string"
                ) {
                    CANONICAL_MEMO.set(replacement.inputClass, replacement.canonicalClass);
                }
            }

            return true;
        } catch {
            // Try the next snapshot source.
        }
    }

    return false;
}

// Invalidate the in-memory cache if the Tailwind version on disk doesn't match
// the installed one. Cache entries are only valid for the version that created
// them.
function validateCacheAgainstTailwindVersion() {
    if (!diskCacheTailwindVersion) {
        return;
    }
    const { tailwindPkg } = loadTailwind();
    if (diskCacheTailwindVersion !== tailwindPkg.version) {
        CANONICAL_MEMO.clear();
        diskCacheDirty = true;
    }
}

let canonicalizerFnPromise = null;
async function getCanonicalizeCandidate() {
    if (!canonicalizerFnPromise) {
        canonicalizerFnPromise = (async () => {
            // Loading Tailwind is the expensive bit (~1.4s to prime the
            // design system); skip it if everything is in-cache.
            validateCacheAgainstTailwindVersion();
            const { designSystem } = await loadTailwindDesignSystem();
            return (candidate) => {
                if (!candidate || typeof candidate !== "string") {
                    return candidate;
                }
                const cached = CANONICAL_MEMO.get(candidate);
                if (cached !== undefined) {
                    return cached;
                }
                const canonical = designSystem.canonicalizeCandidates([candidate], {
                    rem: ROOT_FONT_SIZE_PX,
                })?.[0];
                const result = (!canonical || /\s/.test(canonical)) ? candidate : canonical;
                CANONICAL_MEMO.set(candidate, result);
                diskCacheDirty = true;
                return result;
            };
        })();
    }
    return canonicalizerFnPromise;
}

// Returns canonical from memo only, without loading Tailwind. undefined means
// the token has never been canonicalized and needs the real engine.
function lookupCanonicalFromMemo(candidate) {
    if (!candidate || typeof candidate !== "string") {
        return candidate;
    }
    return CANONICAL_MEMO.get(candidate);
}

// ---------------------------------------------------------------------------
// Named theme-var resolver  (opt-in via --suggest-named-theme-vars)
//
// Detects classes like `border-(--md-sys-color-outline-variant)` and suggests
// `border-outline-variant` *only when* the design system has a theme variable
// (e.g. `--color-outline-variant`) whose value forwards to that root var AND
// the two classes produce byte-identical CSS. This guarantees zero behavioral
// regression for the suggested replacement at the moment of analysis.
// ---------------------------------------------------------------------------

let themeVarResolverPromise = null;
let themeVarResolverThemeCssPath = null;

// rawTokenInput -> resolved replacement string (or the same input when no safe
// replacement exists). Stored alongside CANONICAL_MEMO using a key prefix so
// disk-cache invalidation on Tailwind version change still applies.
const THEME_VAR_CACHE_PREFIX = "themevar:";

function extractParenVarName(utility) {
    // Matches the trailing `(--name)` form, with optional `!` prefix the parser
    // strips earlier and an optional `/<modifier>` suffix (e.g. `/40` opacity).
    // The modifier is preserved verbatim so the resolver can rebuild
    // `border-(--color-ink-400)/40` -> `border-ink-400/40` with byte-identical CSS.
    const m = /^(?<prefix>[a-z][a-z0-9-]*)-\(--(?<name>[a-z0-9-]+)\)(?<modifier>\/[^\s]+)?$/i.exec(utility);
    if (m) {
        return {
            utilityPrefix: m.groups.prefix,
            varName: `--${m.groups.name}`,
            modifier: m.groups.modifier ?? "",
        };
    }
    const b = /^(?<prefix>[a-z][a-z0-9-]*)-\[var\(--(?<name>[a-z0-9-]+)\)\](?<modifier>\/[^\s]+)?$/i.exec(utility);
    if (b) {
        return {
            utilityPrefix: b.groups.prefix,
            varName: `--${b.groups.name}`,
            modifier: b.groups.modifier ?? "",
        };
    }
    return null;
}

// The active resolver's theme-css hash, exposed so the pre-warm step and the
// hot-loop fallback can compute the same per-project cache namespace. Set
// when a resolver successfully loads; null when no theme CSS is in play (the
// resolver then operates against Tailwind's own design system only).
let activeThemeCssHash = null;

function buildThemeVarCacheKey(rawToken, themeCssHash) {
    if (themeCssHash) {
        return `${THEME_VAR_CACHE_PREFIX}${themeCssHash}:${rawToken}`;
    }
    return `${THEME_VAR_CACHE_PREFIX}${rawToken}`;
}

async function getThemeVarResolver({ themeCssPath = null } = {}) {
    // If the caller passes a different themeCssPath than the cached one, drop
    // the cached resolver so we rebuild against the new design system.
    if (themeVarResolverPromise && themeVarResolverThemeCssPath !== themeCssPath) {
        themeVarResolverPromise = null;
    }
    if (!themeVarResolverPromise) {
        themeVarResolverThemeCssPath = themeCssPath;
        themeVarResolverPromise = (async () => {
            validateCacheAgainstTailwindVersion();
            const augmented = themeCssPath
                ? await loadAugmentedDesignSystem(themeCssPath)
                : await loadTailwindDesignSystem();
            const { designSystem } = augmented;
            const themeCssHash = augmented.themeCssHash || null;
            activeThemeCssHash = themeCssHash;

            // Build a map: forwarded-root-var (e.g. `--md-sys-color-outline-variant`)
            // -> Tailwind theme key (e.g. `--color-outline-variant`).
            // Only single-step forwarders of the form `var(--x)` (with optional
            // whitespace) are eligible. Anything more complex is skipped to keep
            // the equivalence check trivial.
            const forwardedToThemeKey = new Map();
            for (const [key, entry] of designSystem.theme.values.entries()) {
                if (!entry || typeof entry.value !== "string") continue;
                const m = /^\s*var\(\s*(--[a-z0-9-]+)\s*\)\s*$/i.exec(entry.value);
                if (!m) continue;
                const forwarded = m[1];
                if (forwardedToThemeKey.has(forwarded)) {
                    // Multiple theme vars forward to the same root var -- ambiguous.
                    forwardedToThemeKey.set(forwarded, null);
                } else {
                    forwardedToThemeKey.set(forwarded, key);
                }
            }

            // Build a quick lookup: theme key -> the single var() it forwards
            // to (e.g. "--color-outline-variant" -> "--md-sys-color-outline-variant").
            // Only single-var forwarders are stored, matching the population logic
            // above. Used by the equivalence check to verify the candidate CSS
            // differs from the original only by substituting `var(--themeKey)`
            // for `var(--forwarded)`.
            const themeKeyToForwarded = new Map();
            for (const [forwarded, themeKey] of forwardedToThemeKey.entries()) {
                if (typeof themeKey === "string") {
                    themeKeyToForwarded.set(themeKey, forwarded);
                }
            }

            return (rawToken) => {
                if (!rawToken || typeof rawToken !== "string") return rawToken;

                const cacheKey = buildThemeVarCacheKey(rawToken, themeCssHash);
                const cached = CANONICAL_MEMO.get(cacheKey);
                if (cached !== undefined) {
                    return cached === "" ? rawToken : cached;
                }

                const recordMiss = () => {
                    CANONICAL_MEMO.set(cacheKey, "");
                    diskCacheDirty = true;
                    return rawToken;
                };

                const token = parseFixToken(rawToken);
                const parsed = extractParenVarName(token.utility);
                if (!parsed) return recordMiss();

                // Resolve `parsed.varName` to a Tailwind theme key. Two pathways:
                //   1. Forwarder pattern: user authored a root var that the design
                //      system forwards from a Tailwind-namespaced theme var
                //      (`--color-x: var(--md-sys-color-x)` -> author writes
                //      `--md-sys-color-x`, theme key is `--color-x`).
                //   2. Direct pattern: user authored the theme key itself
                //      (`--color-ink-400` is registered in @theme; author writes
                //      `border-(--color-ink-400)`, theme key is `--color-ink-400`).
                // Both reduce to "theme key whose namespace prefix is dropped to
                // form the named-utility fragment". The Tailwind-generated CSS
                // body is byte-identical for both forms when the candidate is
                // valid, and `candidatesToCss` returns undefined when the
                // candidate is not a valid utility -- so the equivalence check
                // is the safety gate for both pathways.
                let themeKey = forwardedToThemeKey.get(parsed.varName);
                if (!themeKey || typeof themeKey !== "string") {
                    const direct = designSystem.theme.values.get(parsed.varName);
                    if (direct && typeof direct.value === "string") {
                        themeKey = parsed.varName;
                    }
                }
                if (!themeKey || typeof themeKey !== "string") return recordMiss();

                // Theme keys look like `--<namespace>-<fragment>`. Drop the
                // namespace to get the fragment used in named utility classes.
                const fragmentMatch = /^--[a-z0-9]+-(.+)$/i.exec(themeKey);
                if (!fragmentMatch) return recordMiss();
                const fragment = fragmentMatch[1];
                if (!fragment) return recordMiss();

                const candidateUtility = `${parsed.utilityPrefix}-${fragment}${parsed.modifier}`;
                const candidateRaw = buildFixToken({
                    variants: token.variants,
                    utility: candidateUtility,
                    important: token.important,
                });

                let originalCss;
                let candidateCss;
                try {
                    originalCss = designSystem.candidatesToCss([token.raw])?.[0] ?? "";
                    candidateCss = designSystem.candidatesToCss([candidateRaw])?.[0] ?? "";
                } catch {
                    return recordMiss();
                }
                if (!originalCss || !candidateCss) return recordMiss();
                if (!cssRuleBodiesAreEquivalent(originalCss, candidateCss, themeKeyToForwarded)) {
                    return recordMiss();
                }

                CANONICAL_MEMO.set(cacheKey, candidateRaw);
                diskCacheDirty = true;
                return candidateRaw;
            };
        })();
    }
    return themeVarResolverPromise;
}

function normalizeCssForCompare(css) {
    return String(css).replace(/\s+/g, " ").trim();
}

// Strip the outer selector (everything up to and including the first `{`)
// and the matching closing `}`, leaving only the rule body. Tailwind's
// `candidatesToCss` output for a single class always wraps the declarations
// in exactly one top-level rule.
function extractCssRuleBody(css) {
    const text = String(css ?? "");
    const open = text.indexOf("{");
    if (open < 0) return "";
    const close = text.lastIndexOf("}");
    if (close <= open) return "";
    return normalizeCssForCompare(text.slice(open + 1, close));
}

// Compare two Tailwind-generated CSS rule strings (selectors ignored) under
// the assumption that the only allowed difference is: any `var(--themeKey)`
// reference in the candidate may be expanded to `var(--forwarded)` per the
// design system's @theme forwarder. This treats the candidate as
// runtime-equivalent because `--themeKey: var(--forwarded)` is a CSS custom-
// property forwarder that re-resolves at every use site.
function cssRuleBodiesAreEquivalent(originalCss, candidateCss, themeKeyToForwarded) {
    const a = extractCssRuleBody(originalCss);
    const b = extractCssRuleBody(candidateCss);
    if (!a || !b) return false;
    if (a === b) return true;

    const substituted = b.replace(/var\(\s*(--[a-z0-9-]+)\s*([^)]*)\)/gi, (full, name, rest) => {
        const forwarded = themeKeyToForwarded.get(name);
        if (!forwarded) return full;
        return `var(${forwarded}${rest || ""})`;
    });
    return substituted === a;
}

function lookupThemeVarReplacementFromMemo(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return undefined;
    const cached = CANONICAL_MEMO.get(buildThemeVarCacheKey(rawToken, activeThemeCssHash));
    if (cached === undefined) return undefined;
    return cached === "" ? rawToken : cached;
}

function tokenLooksLikeNamedThemeVarCandidate(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return false;
    // Accept an optional trailing `/<modifier>` (e.g. opacity) and an optional
    // trailing `!` important marker. Both forms are valid Tailwind syntax and
    // must round-trip through the resolver to keep parity between
    // `border-(--color-x)/40` and `border-x/40`.
    return (
        /-\(--[a-z0-9-]+\)(?:\/[^\s!]+)?!?$/i.test(rawToken) ||
        /-\[var\(--[a-z0-9-]+\)\](?:\/[^\s!]+)?!?$/i.test(rawToken)
    );
}

const KNOWN_CANONICAL_UTILITY_REPLACEMENTS = new Map([
    [["break", "words"].join("-"), ["wrap", "break", "word"].join("-")],
]);

function getKnownCanonicalClass(raw) {
    if (!raw || typeof raw !== "string") {
        return null;
    }

    const token = parseFixToken(raw);
    const utility = KNOWN_CANONICAL_UTILITY_REPLACEMENTS.get(token.utility);
    if (!utility) {
        return null;
    }

    return buildFixToken({
        variants: token.variants,
        utility,
        important: token.important,
    });
}

const COMPLEX_EQUIVALENCES = {
    placeContentOptions: [
        "center",
        "start",
        "end",
        "between",
        "around",
        "evenly",
        "baseline",
        "stretch",
    ],
    placeItemsOptions: ["start", "end", "center", "stretch"],
    placeSelfOptions: ["auto", "start", "end", "center", "stretch"],
};

function buildShorthandFamilies(groups) {
    const targetTypes = new Set([
        "Layout",
        "Flexbox & Grid",
        "Spacing",
        "Sizing",
        "Borders",
        "Tables",
        "Transforms",
        "Typography",
    ]);

    const families = [];

    for (const group of groups) {
        if (!targetTypes.has(group.type) || !Array.isArray(group.members)) {
            continue;
        }

        for (const parent of group.members) {
            if (!Array.isArray(parent.members)) {
                continue;
            }

            const entries = parent.members
                .filter((entry) => entry && typeof entry.body === "string" && typeof entry.shorthand === "string")
                .map((entry) => ({ body: entry.body, shorthand: entry.shorthand }));

            if (entries.length < 2) {
                continue;
            }

            const shorthandToBody = new Map();
            for (const entry of entries) {
                shorthandToBody.set(entry.shorthand, entry.body);
            }

            families.push({
                group: group.type,
                parent: parent.type,
                entries: [...entries].sort((a, b) => b.body.length - a.body.length),
                shorthandToBody,
                supportsCorners: entries.some((entry) => ["tl", "tr", "br", "bl"].includes(entry.shorthand)),
            });
        }
    }

    return families;
}

let shorthandFamiliesCache = null;
let familyBodyIndexCache = null;
function getShorthandFamilies() {
    if (!shorthandFamiliesCache) {
        const { tailwindGroups } = loadTailwind();
        shorthandFamiliesCache = buildShorthandFamilies(tailwindGroups);
        familyBodyIndexCache = buildFamilyBodyIndex(shorthandFamiliesCache);
    }
    return { families: shorthandFamiliesCache, bodyIndex: familyBodyIndexCache };
}

const UTILITY_BODY_CANDIDATES_CACHE = new Map();

function parseArgs(argv) {
    const flags = new Set();
    const patterns = [];
    const valueFlags = Object.create(null);

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg.startsWith("--")) {
            // Support `--key=value` and `--key value` for value-bearing flags.
            const eqIdx = arg.indexOf("=");
            if (eqIdx > 0) {
                const key = arg.slice(0, eqIdx);
                const value = arg.slice(eqIdx + 1);
                valueFlags[key] = value;
                flags.add(key);
                continue;
            }

            const VALUE_FLAGS = new Set(["--theme-css"]);
            if (VALUE_FLAGS.has(arg) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
                valueFlags[arg] = argv[i + 1];
                flags.add(arg);
                i += 1;
                continue;
            }

            flags.add(arg);
            continue;
        }

        patterns.push(arg);
    }

    return {
        checkCanonical: flags.has("--check-canonical"),
        cleanupCanonicalFiles: flags.has("--cleanup-canonical-files"),
        extractCanonical: flags.has("--extract-canonical"),
        fix: flags.has("--fix") || flags.has("--fixall"),
        fixAll: flags.has("--fixall"),
        help: flags.has("--help") || flags.has("-h"),
        json: flags.has("--json"),
        suggestNamedThemeVars: flags.has("--suggest-named-theme-vars"),
        themeCssPath: valueFlags["--theme-css"] || null,
        writeCanonicalFiles: flags.has("--write-canonical-files"),
        patterns,
    };
}

function printHelp() {
    console.log(`normwinds v${NORMWINDS_VERSION} - Tailwind shorthand audit + safe autofix

Usage:
  normwinds [patterns...] [flags]

Flags:
  --fix                       Auto-fix supported transforms in .vue files
  --fixall                    Auto-fix in all matched files (.vue/.js/.mjs/.ts/.jsx/.tsx)
  --json                      Emit findings as JSON
  --suggest-named-theme-vars  (opt-in, audit only) Emit findings that suggest
                              replacing \`utility-(--var)\` and
                              \`utility-[var(--var)]\` with the named-utility
                              form (e.g. \`utility-name\`) when the project's
                              @theme registers \`--var\` directly or forwards to
                              it. Requires --theme-css. During --fix/--fixall,
                              the same replacements are applied automatically
                              whenever --theme-css is set; safety is gated by
                              per-token CSS equivalence.
  --theme-css <path>          Path to the project's Tailwind entry CSS that
                              contains the @theme block. Used to detect
                              registered theme variables and forwarders.
  --extract-canonical         (maintenance) Rebuild the canonical replacement
                              reference data.
  --check-canonical           (CI) Exit non-zero if the bundled canonical
                              replacement artifacts are stale relative to the
                              installed Tailwind version.
  --write-canonical-files     Persist the extracted reference data to
                              docs/reference/canonical-replacements.{json,md}
  --cleanup-canonical-files   Remove the persisted reference data
  -h, --help                  Show this help and exit
`);
}

function buildFamilyBodyIndex(families) {
    const index = new Map();

    for (const family of families) {
        for (const entry of family.entries) {
            if (!index.has(entry.body)) {
                index.set(entry.body, []);
            }

            index.get(entry.body).push({
                family,
                shorthand: entry.shorthand,
            });
        }
    }

    return index;
}

async function safeUnlink(filePath) {
    try {
        await fs.unlink(filePath);
    } catch {
        // Ignore missing-file and permission edge cases for cleanup mode.
    }
}

async function cleanupCanonicalArtifacts() {
    await safeUnlink(CANONICAL_OUTPUT_JSON);
    await safeUnlink(CANONICAL_OUTPUT_MD);
}

function toFixedTrim(value) {
    const asString = Number(value.toFixed(6)).toString();
    return asString === "-0" ? "0" : asString;
}

function parseSingleLength(input) {
    const normalized = String(input ?? "").trim();
    const match = normalized.match(/^(-?\d*\.?\d+)(rem|px|em|%)$/i);
    if (!match) {
        return null;
    }

    return {
        number: Number(match[1]),
        unit: match[2].toLowerCase(),
    };
}

function multiplyLength(lengthValue, factor) {
    const parsed = parseSingleLength(lengthValue);
    if (!parsed || Number.isNaN(factor)) {
        return null;
    }

    const multiplied = parsed.number * factor;
    return `${toFixedTrim(multiplied)}${parsed.unit}`;
}

function remToPx(lengthValue, remPx = ROOT_FONT_SIZE_PX) {
    const parsed = parseSingleLength(lengthValue);
    if (!parsed || parsed.unit !== "rem") {
        return null;
    }

    return `${toFixedTrim(parsed.number * remPx)}px`;
}

function pxToRem(lengthValue, remPx = ROOT_FONT_SIZE_PX) {
    const parsed = parseSingleLength(lengthValue);
    if (!parsed || parsed.unit !== "px" || remPx === 0) {
        return null;
    }

    return `${toFixedTrim(parsed.number / remPx)}rem`;
}

function expandValueVariants(value) {
    const variants = new Set([value]);

    const px = remToPx(value);
    if (px) {
        variants.add(px);
    }

    const rem = pxToRem(value);
    if (rem) {
        variants.add(rem);
    }

    return [...variants];
}

function extractFractionPercent(fraction) {
    if (!fraction || !fraction.includes("/")) {
        return null;
    }

    const [leftRaw, rightRaw] = fraction.split("/");
    const left = Number(leftRaw);
    const right = Number(rightRaw);
    if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) {
        return null;
    }

    return `${toFixedTrim((left / right) * 100)}%`;
}

function collectCanonicalCandidateValues({ cssRule, parsedCandidate, themeValueMap }) {
    const values = new Set();

    if (parsedCandidate?.value?.fraction) {
        const percent = extractFractionPercent(parsedCandidate.value.fraction);
        if (percent) {
            values.add(percent);
        }
    }

    if (parsedCandidate?.value?.value?.includes("/")) {
        const percent = extractFractionPercent(parsedCandidate.value.value);
        if (percent) {
            values.add(percent);
        }
    }

    for (const match of cssRule.matchAll(/var\(--([a-z0-9-]+)\)/gi)) {
        const key = `--${match[1]}`;
        const resolved = themeValueMap.get(key);
        if (resolved) {
            values.add(String(resolved).trim());
        }
    }

    const spacingBase = themeValueMap.get("--spacing");
    if (spacingBase) {
        for (const match of cssRule.matchAll(/calc\(var\(--spacing\)\s*\*\s*(-?\d*\.?\d+)\)/gi)) {
            const factor = Number(match[1]);
            const resolved = multiplyLength(spacingBase, factor);
            if (resolved) {
                values.add(resolved);
            }
        }
    }

    for (const match of cssRule.matchAll(/\b(-?\d*\.?\d+(?:deg|rad|turn))\b/gi)) {
        values.add(match[1]);
    }

    for (const match of cssRule.matchAll(/\b(-?\d*\.?\d+%)\b/g)) {
        values.add(match[1]);
    }

    return [...values].filter(Boolean);
}

function addCanonicalReplacement(replacements, inputClass, canonicalClass, sourceClass) {
    const key = `${inputClass}=>${canonicalClass}`;
    if (!replacements.has(key)) {
        replacements.set(key, {
            inputClass,
            canonicalClass,
            sourceClass,
        });
    }
}

async function extractCanonicalReplacements({ writeFiles, checkOnly = false }) {
    const { designSystem, tailwindIndexCssPath } = await loadTailwindDesignSystem();
    const { tailwindPkg } = loadTailwind();

    const classList = designSystem.getClassList().map(([className]) => className);
    const themeValueMap = new Map();
    for (const [key, entry] of designSystem.theme.values.entries()) {
        if (entry && typeof entry.value === "string") {
            themeValueMap.set(key, entry.value);
        }
    }

    const replacementMap = new Map();

    for (const canonicalClass of classList) {
        if (canonicalClass.includes("[") || canonicalClass.includes("]") || canonicalClass.includes(":")) {
            continue;
        }

        const parsedCandidates = designSystem.parseCandidate(canonicalClass);
        if (!Array.isArray(parsedCandidates) || parsedCandidates.length !== 1) {
            continue;
        }

        const parsed = parsedCandidates[0];
        if (parsed?.kind !== "functional" || parsed?.value?.kind !== "named") {
            continue;
        }

        const cssRule = designSystem.candidatesToCss([canonicalClass])?.[0] ?? "";
        if (!cssRule) {
            continue;
        }

        const candidateValues = collectCanonicalCandidateValues({
            cssRule,
            parsedCandidate: parsed,
            themeValueMap,
        });

        if (candidateValues.length === 0) {
            continue;
        }

        for (const candidateValue of candidateValues) {
            for (const valueVariant of expandValueVariants(candidateValue)) {
                const inputClass = `${parsed.root}-[${valueVariant}]`;
                const canonicalized = designSystem.canonicalizeCandidates([inputClass], {
                    rem: ROOT_FONT_SIZE_PX,
                })?.[0] ?? inputClass;

                if (canonicalized === inputClass) {
                    continue;
                }

                addCanonicalReplacement(replacementMap, inputClass, canonicalized, canonicalClass);
            }
        }
    }

    const replacements = [...replacementMap.values()].sort(
        (a, b) =>
            a.canonicalClass.localeCompare(b.canonicalClass) ||
            a.inputClass.localeCompare(b.inputClass),
    );

    const payload = {
        toolVersion: NORMWINDS_VERSION,
        source: {
            engine: "tailwindcss.designSystem.canonicalizeCandidates",
            tailwindVersion: tailwindPkg.version,
            tailwindIndexCssPath,
            rootFontSizePx: ROOT_FONT_SIZE_PX,
        },
        totals: {
            classListCount: classList.length,
            replacementCount: replacements.length,
        },
        replacements,
    };

    const topExamples = replacements.slice(0, 25);
    const roundedExample = replacements.find(
        (entry) =>
            entry.inputClass === "rounded-[24px]" && entry.canonicalClass === "rounded-3xl",
    );

    const markdownLines = [
        "# Tailwind Canonical Replacements (Generated)",
        "",
        "This file is generated from Tailwind's canonicalization engine.",
        "",
        `- Normwinds version: \`${NORMWINDS_VERSION}\``,
        "- Source engine: `tailwindcss.designSystem.canonicalizeCandidates`",
        `- Tailwind version: \`${tailwindPkg.version}\``,
        `- Class list scanned: \`${classList.length}\``,
        `- Canonical replacements extracted: \`${replacements.length}\``,
        "",
        "## Drift Prevention",
        "",
        "Regenerate this catalog whenever Tailwind is upgraded:",
        "",
        "```bash",
        "npm run canonical:extract",
        "```",
        "",
        "Recommended CI gate:",
        "",
        "```bash",
        "npm run canonical:check",
        "```",
        "",
        "## Verified Example",
        "",
    ];

    if (roundedExample) {
        markdownLines.push(
            `- \`${roundedExample.inputClass}\` -> \`${roundedExample.canonicalClass}\``,
            "",
        );
    } else {
        markdownLines.push("- `rounded-[24px]` mapping was not found in this extraction run.", "");
    }

    markdownLines.push("## Sample Replacements", "", "| Input | Canonical |", "| --- | --- |");
    for (const example of topExamples) {
        markdownLines.push(`| \`${example.inputClass}\` | \`${example.canonicalClass}\` |`);
    }

    markdownLines.push(
        "",
        "For the full machine-readable list, see:",
        "",
        "- `docs/reference/canonical-replacements.json`",
    );

    const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
    const markdownText = `${markdownLines.join("\n")}\n`;

    if (checkOnly) {
        const [existingJson, existingMarkdown] = await Promise.all([
            fs.readFile(CANONICAL_OUTPUT_JSON, "utf8").catch(() => null),
            fs.readFile(CANONICAL_OUTPUT_MD, "utf8").catch(() => null),
        ]);

        if (existingJson !== jsonText || existingMarkdown !== markdownText) {
            console.error("normwinds: canonical replacement artifacts are out of date.");
            console.error("Run `normwind --extract-canonical --write-canonical-files` and commit the generated files.");
            process.exitCode = 1;
            return;
        }

        console.log(`normwinds v${NORMWINDS_VERSION}: canonical replacement artifacts are up to date.`);
        return;
    }

    console.log(`normwinds v${NORMWINDS_VERSION}: extracted ${replacements.length} canonical replacement(s).`);

    if (writeFiles) {
        await fs.mkdir(path.dirname(CANONICAL_OUTPUT_JSON), { recursive: true });
        await fs.writeFile(CANONICAL_OUTPUT_JSON, jsonText, "utf8");
        await fs.writeFile(CANONICAL_OUTPUT_MD, markdownText, "utf8");
        console.log(`  wrote ${path.relative(process.cwd(), CANONICAL_OUTPUT_JSON)}`);
        console.log(`  wrote ${path.relative(process.cwd(), CANONICAL_OUTPUT_MD)}`);
        return;
    }

    console.log("  files were not written (use --write-canonical-files to persist artifacts)");
}

function toRelative(filePath) {
    const relative = path.relative(process.cwd(), filePath);
    return relative || filePath;
}

function maybePushFinding(found, entry) {
    const key = `${entry.filePath}:${entry.line}:${entry.column}:${entry.message}`;
    if (!found.has(key)) {
        found.set(key, entry);
    }
}

function parseClassToken(raw, relativeOffset) {
    let utilityPart = raw;
    const importantSuffix = utilityPart.endsWith("!") && utilityPart.length > 1;
    if (importantSuffix) {
        utilityPart = utilityPart.slice(0, -1);
    }

    let importantPrefix = utilityPart.startsWith("!") && utilityPart.length > 1;
    if (importantPrefix) {
        utilityPart = utilityPart.slice(1);
    }

    const lastColon = utilityPart.lastIndexOf(":");
    const variants = lastColon >= 0 ? utilityPart.slice(0, lastColon + 1) : "";
    let utility = lastColon >= 0 ? utilityPart.slice(lastColon + 1) : utilityPart;

    if (!importantPrefix && utility.startsWith("!") && utility.length > 1) {
        importantPrefix = true;
        utility = utility.slice(1);
    }

    return {
        raw,
        relativeOffset,
        variants,
        utility,
        importantPrefix,
        importantSuffix,
        important: importantPrefix || importantSuffix,
    };
}

const TAILWIND_BAD_CHARS_RAW = /[=><&|?,'"`*]/;
const TAILWIND_BAD_CHARS_UTIL = /[=><&|?*]/;
const TAILWIND_UTIL_SHAPE = /^-?[a-z][a-z0-9-]*(?:-[^\s]+)+$/;

function isLikelyTailwindUtility(token) {
    if (!token || !token.utility) {
        return false;
    }

    if (TAILWIND_BAD_CHARS_RAW.test(token.raw) || TAILWIND_BAD_CHARS_UTIL.test(token.utility)) {
        return false;
    }

    if (!token.utility.includes("-")) {
        return token.utility === "border";
    }

    return TAILWIND_UTIL_SHAPE.test(token.utility);
}

function formatClass(variants, important, utility) {
    return `${variants}${utility}${important ? "!" : ""}`;
}

function matchUtilityToBody(utility, body) {
    if (utility === body) {
        return { negative: "", value: "" };
    }

    if (utility.startsWith(`${body}-`)) {
        return { negative: "", value: utility.slice(body.length + 1) };
    }

    if (utility.startsWith(`-${body}-`)) {
        return { negative: "-", value: utility.slice(body.length + 2) };
    }

    return null;
}

function parseFixToken(raw) {
    let token = raw;
    if (token.startsWith("!") && !token.endsWith("!")) {
        token = `${token.slice(1)}!`;
    } else if (!token.startsWith("!") && !token.endsWith("!")) {
        const colonIdx = token.lastIndexOf(":");
        if (colonIdx >= 0) {
            const afterColon = token.slice(colonIdx + 1);
            if (afterColon.startsWith("!") && afterColon.length > 1) {
                token = `${token.slice(0, colonIdx + 1)}${afterColon.slice(1)}!`;
            }
        }
    }

    const important = token.endsWith("!");
    const withoutImportant = important ? token.slice(0, -1) : token;
    const lastColon = withoutImportant.lastIndexOf(":");
    const variants = lastColon >= 0 ? withoutImportant.slice(0, lastColon + 1) : "";
    const utility = lastColon >= 0 ? withoutImportant.slice(lastColon + 1) : withoutImportant;

    return {
        raw: token,
        variants,
        utility,
        important,
    };
}

function buildFixToken({ variants, utility, important }) {
    return `${variants}${utility}${important ? "!" : ""}`;
}

// Strip the contents of every `[...]` and `(...)` segment so that operator
// characters which are valid inside Tailwind arbitrary-value or theme-var
// brackets (e.g. `data-[state=open]`, `[&>svg]`, `(--my-var)`) are not
// mistaken for JSX/JS expression syntax outside the brackets.
function stripBracketedSegments(input) {
    if (typeof input !== "string" || input.length === 0) {
        return input ?? "";
    }
    return input.replace(/\[[^\]]*\]/g, "[]").replace(/\([^)]*\)/g, "()");
}

function isLikelyFixUtility(raw) {
    if (!raw) {
        return false;
    }

    // Operator characters are only disqualifying when they appear OUTSIDE of
    // arbitrary-value brackets. Tokens like `data-[state=open]:bg-red-500`,
    // `[&>svg]:size-4`, or `border-(--color-x)/40` are all legitimate
    // Tailwind utilities and must not be filtered out here.
    const stripped = stripBracketedSegments(raw);
    if (/[=><&|?,'"`*]/.test(stripped)) {
        return false;
    }

    const token = parseFixToken(raw);
    if (!token.utility.includes("-")) {
        return token.utility === "border";
    }

    return /^-?[a-z][a-z0-9-]*(?:-[^\s]+)+$/.test(token.utility);
}

function matchFixBodyValue(utility, body) {
    const positive = `${body}-`;
    const negative = `-${body}-`;

    if (utility.startsWith(positive)) {
        return { negative: "", value: utility.slice(positive.length) };
    }

    if (utility.startsWith(negative)) {
        return { negative: "-", value: utility.slice(negative.length) };
    }

    return null;
}

function mergeFixPair(tokens, firstBody, secondBody, targetBody) {
    let changed = false;

    for (let i = 0; i < tokens.length; i += 1) {
        const first = parseFixToken(tokens[i]);
        const firstMatch = matchFixBodyValue(first.utility, firstBody);
        if (!firstMatch) {
            continue;
        }

        for (let j = i + 1; j < tokens.length; j += 1) {
            const second = parseFixToken(tokens[j]);
            const secondMatch = matchFixBodyValue(second.utility, secondBody);
            if (!secondMatch) {
                continue;
            }

            if (
                first.variants !== second.variants ||
                first.important !== second.important ||
                firstMatch.value !== secondMatch.value ||
                firstMatch.negative !== secondMatch.negative
            ) {
                continue;
            }

            const targetUtility = `${firstMatch.negative}${targetBody}-${firstMatch.value}`;
            const targetRaw = buildFixToken({
                variants: first.variants,
                utility: targetUtility,
                important: first.important,
            });

            const existingTarget = tokens.some((token, index) => {
                if (index === i || index === j) {
                    return false;
                }

                const parsed = parseFixToken(token);
                return (
                    parsed.variants === first.variants &&
                    parsed.important === first.important &&
                    parsed.utility === targetUtility
                );
            });

            tokens[i] = targetRaw;
            tokens.splice(j, 1);

            if (existingTarget) {
                tokens.splice(i, 1);
            }

            changed = true;
            i = -1;
            break;
        }
    }

    return changed;
}

function mergeFixWidthHeight(tokens) {
    let changed = false;

    // Match a `w-X`/`h-X` pair regardless of authoring order. The previous
    // implementation only collapsed `w-X h-X`, silently leaving any
    // `h-X w-X` pair behind because the inner loop scanned forward from the
    // width index. We now scan every position for the first axis token and
    // pair it with any matching counterpart anywhere else in the array.
    for (let i = 0; i < tokens.length; i += 1) {
        const a = parseFixToken(tokens[i]);
        const aWidth = matchFixBodyValue(a.utility, "w");
        const aHeight = matchFixBodyValue(a.utility, "h");
        const aMatch = aWidth ?? aHeight;
        if (!aMatch || aMatch.negative) {
            continue;
        }
        const counterpartBody = aWidth ? "h" : "w";

        for (let j = 0; j < tokens.length; j += 1) {
            if (j === i) {
                continue;
            }
            const b = parseFixToken(tokens[j]);
            const bMatch = matchFixBodyValue(b.utility, counterpartBody);
            if (!bMatch || bMatch.negative) {
                continue;
            }

            if (
                a.variants !== b.variants ||
                a.important !== b.important ||
                aMatch.value !== bMatch.value
            ) {
                continue;
            }

            const targetUtility = `size-${aMatch.value}`;
            const targetRaw = buildFixToken({
                variants: a.variants,
                utility: targetUtility,
                important: a.important,
            });

            // Preserve the position of the earlier token so unrelated
            // utilities keep their relative order in the output.
            const firstIdx = Math.min(i, j);
            const secondIdx = Math.max(i, j);

            const existingTarget = tokens.some((token, index) => {
                if (index === firstIdx || index === secondIdx) {
                    return false;
                }

                const parsed = parseFixToken(token);
                return (
                    parsed.variants === a.variants &&
                    parsed.important === a.important &&
                    parsed.utility === targetUtility
                );
            });

            tokens[firstIdx] = targetRaw;
            tokens.splice(secondIdx, 1);

            if (existingTarget) {
                tokens.splice(firstIdx, 1);
            }

            changed = true;
            i = -1;
            break;
        }
    }

    return changed;
}

function looksLikeFixableClassString(content, { allowSingleTokenCanonical = false } = {}) {
    // Operator characters that hint at JSX/JS expressions are only
    // disqualifying when they appear OUTSIDE of Tailwind's arbitrary-value
    // brackets (`[...]`) or theme-var parens (`(...)`). A class string
    // containing `data-[state=open]:text-...` or `hover:text-(--color-x)`
    // is still a plain class string and must be considered fixable.
    if (/[=><&|?]/.test(stripBracketedSegments(content))) {
        return false;
    }

    const tokens = content.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return false;
    }

    const classLikeTokens = tokens.filter((token) => isLikelyFixUtility(token));
    if (classLikeTokens.length >= 2) {
        return true;
    }

    if (classLikeTokens.length === 1) {
        const token = classLikeTokens[0];
        return Boolean(
            (allowSingleTokenCanonical && (
                token.includes("[") ||
                token.includes("(--") ||
                getKnownCanonicalClass(token)
            )) ||
            (token.startsWith("!") && !token.endsWith("!")) ||
            /:[!]/.test(token),
        );
    }

    return false;
}

function transformFixableClassContent(content, canonicalizeCandidate, themeVarResolver = null) {
    const leading = (content.match(/^\s+/) ?? [""])[0];
    const trailing = (content.match(/\s+$/) ?? [""])[0];
    const middle = content.trim();
    if (!middle) {
        return content;
    }

    const tokens = middle.split(/\s+/).filter(Boolean);
    if (tokens.length < 1) {
        return content;
    }

    let changed = false;

    for (let i = 0; i < tokens.length; i += 1) {
        if (isLikelyFixUtility(tokens[i]) && !tokens[i].endsWith("!")) {
            const normalized = parseFixToken(tokens[i]).raw;
            if (normalized !== tokens[i]) {
                tokens[i] = normalized;
                changed = true;
            }
        }

        const knownCanonical = getKnownCanonicalClass(tokens[i]);
        if (knownCanonical && knownCanonical !== tokens[i]) {
            tokens[i] = knownCanonical;
            changed = true;
        }

        if (!isLikelyFixUtility(tokens[i])) {
            continue;
        }

        if (canonicalizeCandidate) {
            const canonical = canonicalizeCandidate(tokens[i]);
            if (canonical && canonical !== tokens[i]) {
                tokens[i] = canonical;
                changed = true;
            }
        }

        if (themeVarResolver && tokenLooksLikeNamedThemeVarCandidate(tokens[i])) {
            const replacement = themeVarResolver(tokens[i]);
            if (replacement && replacement !== tokens[i]) {
                tokens[i] = replacement;
                changed = true;
            }
        }
    }

    let merged = true;
    while (merged) {
        merged = false;
        merged = mergeFixPair(tokens, "px", "py", "p") || merged;
        merged = mergeFixPair(tokens, "mx", "my", "m") || merged;
        merged = mergeFixPair(tokens, "pt", "pb", "py") || merged;
        merged = mergeFixPair(tokens, "pl", "pr", "px") || merged;
        merged = mergeFixPair(tokens, "mt", "mb", "my") || merged;
        merged = mergeFixPair(tokens, "ml", "mr", "mx") || merged;
        merged = mergeFixPair(tokens, "inset-x", "inset-y", "inset") || merged;
        merged = mergeFixPair(tokens, "left", "right", "inset-x") || merged;
        merged = mergeFixPair(tokens, "top", "bottom", "inset-y") || merged;
        merged = mergeFixPair(tokens, "gap-x", "gap-y", "gap") || merged;
        merged = mergeFixPair(tokens, "overflow-x", "overflow-y", "overflow") || merged;
        merged = mergeFixPair(tokens, "overscroll-x", "overscroll-y", "overscroll") || merged;
        merged = mergeFixPair(tokens, "border-spacing-x", "border-spacing-y", "border-spacing") || merged;
        merged = mergeFixPair(tokens, "scale-x", "scale-y", "scale") || merged;
        merged = mergeFixWidthHeight(tokens) || merged;
        changed = changed || merged;
    }

    if (!changed) {
        return content;
    }

    return `${leading}${tokens.join(" ")}${trailing}`;
}

function applyFixesToText(text, canonicalizeCandidate, {
    allowSingleTokenCanonical = false,
    themeVarResolver = null,
} = {}) {
    let changed = false;

    const transformQuotedStrings = (input, regex, quote) =>
        input.replace(regex, (full, content) => {
            if (!looksLikeFixableClassString(content, { allowSingleTokenCanonical })) {
                return full;
            }

            const next = transformFixableClassContent(content, canonicalizeCandidate, themeVarResolver);
            if (next === content) {
                return full;
            }

            changed = true;
            return `${quote}${next}${quote}`;
        });

    let transformed = text;
    transformed = transformQuotedStrings(transformed, /"((?:\\.|[^"\\])*)"/g, '"');
    transformed = transformQuotedStrings(transformed, /'((?:\\.|[^'\\])*)'/g, "'");
    transformed = transformQuotedStrings(transformed, /`((?:\\.|[^`\\])*)`/g, "`");

    return { changed, transformed };
}

async function applyFixes(filePaths, { fixAll = false, suggestNamedThemeVars = false, themeCssPath = null } = {}) {
    let changedFiles = 0;

    // Resolve the theme CSS once up front so misconfiguration surfaces as a
    // single, loud error rather than a silent per-file no-op. The resolver is
    // engaged whenever the user supplied --theme-css OR explicitly opted into
    // suggestions; the safety gate during fix mode is the per-token CSS
    // equivalence check, not the flag, so we don't require the explicit
    // suggestion flag at fix time.
    let sharedThemeVarResolver = null;
    if (suggestNamedThemeVars || themeCssPath) {
        sharedThemeVarResolver = await getThemeVarResolver({ themeCssPath }).catch((error) => {
            console.error(error?.message || String(error));
            return null;
        });
    }

    for (const filePath of filePaths) {
        if (!fixAll && !filePath.endsWith(".vue")) {
            continue;
        }

        let sourceText;
        try {
            sourceText = await fs.readFile(filePath, "utf8");
        } catch {
            continue;
        }

        const canonicalizeCandidate = sourceText.includes("[")
            ? await getCanonicalizeCandidate().catch(() => null)
            : null;
        const themeVarResolver = sharedThemeVarResolver && /\(--|\[var\(--/.test(sourceText)
            ? sharedThemeVarResolver
            : null;
        const { changed, transformed } = applyFixesToText(sourceText, canonicalizeCandidate, {
            allowSingleTokenCanonical: filePath.endsWith(".vue"),
            themeVarResolver,
        });
        if (!changed) {
            continue;
        }

        await fs.writeFile(filePath, transformed, "utf8");
        changedFiles += 1;
    }

    return changedFiles;
}

function emitSuggestion(found, source, line, column, sources, target) {
    if (!sources.length) {
        return;
    }

    const classnames = sources.map((item) => item.raw).join(", ");
    maybePushFinding(found, {
        filePath: source,
        line,
        column,
        message: `Classnames '${classnames}' could be replaced by the '${target}' shorthand!`,
    });
}

function detectComplexEquivalences(groupedTokens, filePath, line, column, found) {
    for (const tokens of groupedTokens.values()) {
        const utilities = new Set(tokens.map((token) => token.utility));
        const byUtility = new Map(tokens.map((token) => [token.utility, token]));

        if (
            utilities.has("overflow-hidden") &&
            utilities.has("text-ellipsis") &&
            utilities.has("whitespace-nowrap") &&
            !utilities.has("truncate")
        ) {
            const target = formatClass(tokens[0].variants, tokens[0].important, "truncate");
            emitSuggestion(
                found,
                filePath,
                line,
                column,
                [
                    byUtility.get("overflow-hidden"),
                    byUtility.get("text-ellipsis"),
                    byUtility.get("whitespace-nowrap"),
                ].filter(Boolean),
                target,
            );
        }

        const widthToken = tokens.find((token) => token.utility.startsWith("w-"));
        const heightToken = tokens.find((token) => token.utility.startsWith("h-"));
        if (widthToken && heightToken) {
            const widthValue = widthToken.utility.slice(2);
            const heightValue = heightToken.utility.slice(2);
            const sizeUtility = `size-${widthValue}`;
            if (widthValue === heightValue && !utilities.has(sizeUtility)) {
                emitSuggestion(
                    found,
                    filePath,
                    line,
                    column,
                    [widthToken, heightToken],
                    formatClass(widthToken.variants, widthToken.important, sizeUtility),
                );
            }
        }

        for (const option of COMPLEX_EQUIVALENCES.placeContentOptions) {
            const content = byUtility.get(`content-${option}`);
            const justify = byUtility.get(`justify-${option}`);
            const targetUtility = `place-content-${option}`;
            if (content && justify && !utilities.has(targetUtility)) {
                emitSuggestion(
                    found,
                    filePath,
                    line,
                    column,
                    [content, justify],
                    formatClass(content.variants, content.important, targetUtility),
                );
            }
        }

        for (const option of COMPLEX_EQUIVALENCES.placeItemsOptions) {
            const items = byUtility.get(`items-${option}`);
            const justifyItems = byUtility.get(`justify-items-${option}`);
            const targetUtility = `place-items-${option}`;
            if (items && justifyItems && !utilities.has(targetUtility)) {
                emitSuggestion(
                    found,
                    filePath,
                    line,
                    column,
                    [items, justifyItems],
                    formatClass(items.variants, items.important, targetUtility),
                );
            }
        }

        for (const option of COMPLEX_EQUIVALENCES.placeSelfOptions) {
            const self = byUtility.get(`self-${option}`);
            const justifySelf = byUtility.get(`justify-self-${option}`);
            const targetUtility = `place-self-${option}`;
            if (self && justifySelf && !utilities.has(targetUtility)) {
                emitSuggestion(
                    found,
                    filePath,
                    line,
                    column,
                    [self, justifySelf],
                    formatClass(self.variants, self.important, targetUtility),
                );
            }
        }
    }
}

function detectFamilyShorthand(groupedTokens, filePath, line, column, found) {
    const { bodyIndex } = getShorthandFamilies();

    for (const tokens of groupedTokens.values()) {
        const familyClusters = new Map();

        for (const token of tokens) {
            for (const candidateBody of getUtilityBodyCandidates(token.utility)) {
                const matches = bodyIndex.get(candidateBody);
                if (!matches) {
                    continue;
                }

                const matched = matchUtilityToBody(token.utility, candidateBody);
                if (!matched) {
                    continue;
                }

                for (const { family, shorthand } of matches) {
                    if (!familyClusters.has(family)) {
                        familyClusters.set(family, new Map());
                    }

                    const clusters = familyClusters.get(family);
                    const clusterKey = `${matched.negative}|${matched.value}`;
                    if (!clusters.has(clusterKey)) {
                        clusters.set(clusterKey, new Map());
                    }

                    const shorthandMap = clusters.get(clusterKey);
                    if (!shorthandMap.has(shorthand)) {
                        shorthandMap.set(shorthand, []);
                    }

                    shorthandMap.get(shorthand).push(token);
                }
            }
        }

        for (const [family, clusters] of familyClusters.entries()) {
            for (const [clusterKey, shorthandMap] of clusters.entries()) {
                const [negative, value] = clusterKey.split("|");
                const get = (short) => shorthandMap.get(short)?.[0] ?? null;
                const has = (short) => Boolean(get(short));

                const buildTarget = (short) => {
                    const body = family.shorthandToBody.get(short);
                    if (!body) {
                        return null;
                    }

                    const utility = `${negative}${body}${value ? `-${value}` : ""}`;
                    return formatClass(tokens[0].variants, tokens[0].important, utility);
                };

                if (has("x") && has("y") && !has("all")) {
                    const target = buildTarget("all");
                    if (target) {
                        emitSuggestion(found, filePath, line, column, [get("x"), get("y")], target);
                    }
                }

                if (has("l") && has("r") && !has("x")) {
                    const target = buildTarget("x");
                    if (target) {
                        emitSuggestion(found, filePath, line, column, [get("l"), get("r")], target);
                    }
                }

                if (has("t") && has("b") && !has("y")) {
                    const target = buildTarget("y");
                    if (target) {
                        emitSuggestion(found, filePath, line, column, [get("t"), get("b")], target);
                    }
                }

                if (family.supportsCorners) {
                    if (has("tl") && has("tr") && !has("t")) {
                        const target = buildTarget("t");
                        if (target) {
                            emitSuggestion(found, filePath, line, column, [get("tl"), get("tr")], target);
                        }
                    }

                    if (has("tr") && has("br") && !has("r")) {
                        const target = buildTarget("r");
                        if (target) {
                            emitSuggestion(found, filePath, line, column, [get("tr"), get("br")], target);
                        }
                    }

                    if (has("bl") && has("br") && !has("b")) {
                        const target = buildTarget("b");
                        if (target) {
                            emitSuggestion(found, filePath, line, column, [get("bl"), get("br")], target);
                        }
                    }

                    if (has("tl") && has("bl") && !has("l")) {
                        const target = buildTarget("l");
                        if (target) {
                            emitSuggestion(found, filePath, line, column, [get("tl"), get("bl")], target);
                        }
                    }
                }

                if (!has("all") && has("t") && has("r") && has("b") && has("l")) {
                    const target = buildTarget("all");
                    if (target) {
                        emitSuggestion(
                            found,
                            filePath,
                            line,
                            column,
                            [get("t"), get("r"), get("b"), get("l")],
                            target,
                        );
                    }
                }
            }
        }
    }
}

function getUtilityBodyCandidates(utility) {
    if (UTILITY_BODY_CANDIDATES_CACHE.has(utility)) {
        return UTILITY_BODY_CANDIDATES_CACHE.get(utility);
    }

    const normalized = utility.startsWith("-") ? utility.slice(1) : utility;
    const candidates = [];
    const seen = new Set();

    const pushCandidate = (value) => {
        if (value && !seen.has(value)) {
            seen.add(value);
            candidates.push(value);
        }
    };

    pushCandidate(normalized);

    for (let index = normalized.indexOf("-"); index >= 0; index = normalized.indexOf("-", index + 1)) {
        pushCandidate(normalized.slice(0, index));
    }

    UTILITY_BODY_CANDIDATES_CACHE.set(utility, candidates);
    return candidates;
}

function buildLineStarts(text) {
    const starts = [0];
    let idx = text.indexOf("\n");
    while (idx !== -1) {
        starts.push(idx + 1);
        idx = text.indexOf("\n", idx + 1);
    }
    return starts;
}

function indexToLineCol(lineStarts, index) {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lineStarts[mid] <= index) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    const lineIndex = Math.max(0, high);
    return {
        line: lineIndex + 1,
        column: index - lineStarts[lineIndex] + 1,
    };
}

const QUOTE_VALUE_SHAPE = /\b(?:[a-z]+:)*!?-?[a-z][a-z0-9-]*(?:-[^\s]+)*!?\b/i;

function shouldExtractQuotedClassValue(value, { allowSingleTokenCanonical = false } = {}) {
    const singleToken = !value.includes(" ");
    if (
        singleToken &&
        !(
            (allowSingleTokenCanonical && (
                value.includes("[") ||
                value.includes("(--") ||
                getKnownCanonicalClass(value)
            )) ||
            value.startsWith("!") ||
            value.includes(":!")
        )
    ) {
        return false;
    }

    if (!value.includes("-") && !value.includes("!")) {
        return false;
    }

    if (value.includes("*")) {
        return false;
    }

    if (/[=><&|?]/.test(value)) {
        return false;
    }

    return QUOTE_VALUE_SHAPE.test(value);
}

function extractNestedQuotedClassStrings(value, baseIndex, options) {
    const results = [];
    const quoteRegexes = [/'((?:\\.|[^'\\])*)'/g, /`((?:\\.|[^`\\])*)`/g];

    for (const quoteRegex of quoteRegexes) {
        let match;
        while ((match = quoteRegex.exec(value)) !== null) {
            const quotedValue = match[1];
            if (!shouldExtractQuotedClassValue(quotedValue, options)) {
                continue;
            }

            results.push({
                value: quotedValue,
                index: baseIndex + match.index + 1,
            });
        }
    }

    return results;
}

function extractClassLikeStrings(sourceText, { allowSingleTokenCanonical = false } = {}) {
    const results = [];
    const classAttrRegex = /(?:\bclass|(?::|\bv-bind:)class)\s*=\s*(["'])([\s\S]*?)\1/g;
    let match;

    while ((match = classAttrRegex.exec(sourceText)) !== null) {
        const startIndex = match.index + match[0].indexOf(match[2]);
        results.push({
            value: match[2],
            index: startIndex,
        });

        results.push(
            ...extractNestedQuotedClassStrings(match[2], startIndex, { allowSingleTokenCanonical }),
        );
    }

    const quoteRegexes = [/"((?:\\.|[^"\\])*)"/g, /'((?:\\.|[^'\\])*)'/g, /`((?:\\.|[^`\\])*)`/g];
    for (const quoteRegex of quoteRegexes) {
        while ((match = quoteRegex.exec(sourceText)) !== null) {
            const value = match[1];
            if (!shouldExtractQuotedClassValue(value, { allowSingleTokenCanonical })) {
                continue;
            }

            results.push({
                value,
                index: match.index + 1,
            });
        }
    }

    return results;
}

function collectArbitraryValueTokens(snippetValue, snippetIndex, lineStarts) {
    const found = [];
    const arbitraryRegex = /(?:^|\s)((?:[a-z0-9-]+:)*!?[a-z][a-z0-9-]*-\[[^\]\s]+\]!?)(?=\s|$)/gi;
    let match;

    while ((match = arbitraryRegex.exec(snippetValue)) !== null) {
        const raw = match[1];
        const rawOffset = match.index + match[0].lastIndexOf(raw);
        const position = indexToLineCol(lineStarts, snippetIndex + rawOffset);

        found.push({
            raw,
            line: position.line,
            column: position.column,
        });
    }

    return found;
}

function hasGlobSyntax(value) {
    return /[*?[\]{}]/.test(value);
}

function hasAllowedExtension(filePath) {
    return /\.(?:vue|js|mjs|ts|jsx|tsx)$/i.test(filePath);
}

function normalizeRelativePath(filePath) {
    return path.relative(process.cwd(), path.resolve(process.cwd(), filePath)).replace(/\\/g, "/");
}

function isIgnoredRelativePath(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("../")) {
        return true;
    }

    if (IGNORED_EXACT_PATHS.has(normalized)) {
        return true;
    }

    if (IGNORED_ROOT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        return true;
    }

    const segments = normalized.split("/");
    return segments.some((segment) => IGNORED_SEGMENTS.has(segment));
}

async function listFilesWithRipgrep(patterns) {
    const args = ["--files", "--hidden"];
    for (const glob of RG_IGNORE_GLOBS) {
        args.push("-g", glob);
    }
    for (const pattern of patterns) {
        args.push("-g", pattern);
    }
    args.push(".");

    const { stdout } = await execFileAsync("rg", args, {
        cwd: process.cwd(),
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
    });

    return stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((filePath) => path.resolve(process.cwd(), filePath));
}

async function walkDirectory(directoryPath, results) {
    let entries;
    try {
        entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry.name);
        const relativePath = normalizeRelativePath(fullPath);
        if (isIgnoredRelativePath(relativePath)) {
            continue;
        }

        if (entry.isDirectory()) {
            await walkDirectory(fullPath, results);
            continue;
        }

        if (entry.isFile() && hasAllowedExtension(relativePath)) {
            results.push(path.resolve(fullPath));
        }
    }
}

async function listTargetFiles(patterns) {
    const explicitFiles = new Set();
    const directoryTargets = [];
    const globPatterns = [];

    const targetPatterns = patterns.length > 0 ? patterns : DEFAULT_PATTERNS;

    for (const pattern of targetPatterns) {
        if (hasGlobSyntax(pattern)) {
            globPatterns.push(pattern);
            continue;
        }

        const resolved = path.resolve(process.cwd(), pattern);
        let stats = null;
        try {
            stats = await fs.stat(resolved);
        } catch {
            globPatterns.push(pattern);
            continue;
        }

        if (stats.isDirectory()) {
            directoryTargets.push(resolved);
            continue;
        }

        if (stats.isFile()) {
            const relativePath = normalizeRelativePath(resolved);
            if (!isIgnoredRelativePath(relativePath) && hasAllowedExtension(relativePath)) {
                explicitFiles.add(path.resolve(resolved));
            }
        }
    }

    const discoveredFiles = new Set(explicitFiles);

    if (globPatterns.length > 0) {
        try {
            const files = await listFilesWithRipgrep(globPatterns);
            for (const filePath of files) {
                const relativePath = normalizeRelativePath(filePath);
                if (!isIgnoredRelativePath(relativePath) && hasAllowedExtension(relativePath)) {
                    discoveredFiles.add(path.resolve(filePath));
                }
            }
        } catch {
            const roots = directoryTargets.length > 0 ? directoryTargets : [process.cwd()];
            for (const root of roots) {
                const walkedFiles = [];
                await walkDirectory(root, walkedFiles);
                for (const filePath of walkedFiles) {
                    discoveredFiles.add(path.resolve(filePath));
                }
            }
        }
    }

    if (globPatterns.length === 0 && directoryTargets.length > 0) {
        for (const directoryPath of directoryTargets) {
            const files = [];
            await walkDirectory(directoryPath, files);
            for (const filePath of files) {
                discoveredFiles.add(path.resolve(filePath));
            }
        }
    }

    if (globPatterns.length === 0 && directoryTargets.length === 0 && explicitFiles.size === 0) {
        const files = await listFilesWithRipgrep(DEFAULT_PATTERNS).catch(async () => {
            const walkedFiles = [];
            await walkDirectory(process.cwd(), walkedFiles);
            return walkedFiles;
        });

        for (const filePath of files) {
            const relativePath = normalizeRelativePath(filePath);
            if (!isIgnoredRelativePath(relativePath) && hasAllowedExtension(relativePath)) {
                discoveredFiles.add(path.resolve(filePath));
            }
        }
    }

    return [...discoveredFiles].sort((a, b) => a.localeCompare(b));
}

async function runWithConcurrency(items, concurrency, worker) {
    if (items.length === 0) {
        return [];
    }

    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, items.length);

    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (true) {
                const currentIndex = nextIndex;
                nextIndex += 1;
                if (currentIndex >= items.length) {
                    return;
                }

                results[currentIndex] = await worker(items[currentIndex], currentIndex);
            }
        }),
    );

    return results;
}

// v3 core change: precompute file sources and gather all arbitrary-value tokens
// up front, then batch-canonicalize the unique set once. Non-arbitrary tokens
// are never canonicalized because Tailwind's canonicalizer is a no-op for them
// (verified empirically: 0/27,060 non-arbitrary tokens changed in this
// codebase). This removes the majority of Tailwind design-system calls.
async function collectStaticShorthandFindings(filePaths, { suggestNamedThemeVars = false, themeCssPath = null } = {}) {
    // Pass 1: read every file, extract class snippets, collect unique arbitrary
    // tokens across the entire set for a single batched canonicalization.
    const fileContexts = new Array(filePaths.length);
    const uniqueArbitraryRaws = new Set();
    const uniqueThemeVarRaws = new Set();
    // Matches:
    //   - bracket arbitrary form:    `[a-z][a-z0-9-]*-[ ... ]`
    //   - paren CSS-var form:        `[a-z][a-z0-9-]*-(--name)`
    //   - bracket-var form:          `[a-z][a-z0-9-]*-[var(--name)]`  (already covered by the bracket arm)
    // An optional trailing `/<modifier>` (e.g. opacity `/40`) is captured so
    // tokens like `border-[var(--color-ink-400)]/40` reach the canonicalizer
    // and named-theme-var resolver intact.
    const arbitraryTokenRegex = /(?:^|\s)((?:[a-z0-9-]+:)*!?[a-z][a-z0-9-]*-(?:\[[^\]\s]+\]|\(--[a-z0-9-]+\))(?:\/[^\s]+)?!?)(?=\s|$)/gi;

    await runWithConcurrency(filePaths, FILE_SCAN_CONCURRENCY, async (filePath, idx) => {
        let sourceText;
        try {
            sourceText = await fs.readFile(filePath, "utf8");
        } catch {
            fileContexts[idx] = null;
            return;
        }

        if (!sourceText.includes("-") && !sourceText.includes("!")) {
            fileContexts[idx] = null;
            return;
        }

        const snippets = extractClassLikeStrings(sourceText, {
            allowSingleTokenCanonical: filePath.endsWith(".vue"),
        });
        if (snippets.length === 0) {
            fileContexts[idx] = null;
            return;
        }

        // Collect arbitrary raw tokens (containing `[` or `(--`) for global
        // batch canonicalization. Also note which snippets need the
        // canonicalizer / theme-var resolver.
        const perSnippetArbitraryRaws = new Array(snippets.length);
        let hasAnyArbitrary = false;
        for (let i = 0; i < snippets.length; i++) {
            const snippet = snippets[i];
            const hasBracket = snippet.value.includes("[");
            const hasParenVar = suggestNamedThemeVars && snippet.value.includes("(--");
            if (!hasBracket && !hasParenVar) {
                perSnippetArbitraryRaws[i] = null;
                continue;
            }

            if (hasBracket) {
                hasAnyArbitrary = true;
            }
            arbitraryTokenRegex.lastIndex = 0;
            let match;
            const raws = [];
            while ((match = arbitraryTokenRegex.exec(snippet.value)) !== null) {
                const raw = match[1];
                raws.push({
                    raw,
                    snippetOffset: match.index + match[0].lastIndexOf(raw),
                });
                if (raw.includes("[")) {
                    uniqueArbitraryRaws.add(raw);
                }
                if (suggestNamedThemeVars && tokenLooksLikeNamedThemeVarCandidate(raw)) {
                    uniqueThemeVarRaws.add(raw);
                }
            }
            perSnippetArbitraryRaws[i] = raws;
        }

        fileContexts[idx] = {
            filePath,
            sourceText,
            snippets,
            perSnippetArbitraryRaws,
            hasAnyArbitrary,
            hasAnyThemeVarCandidate: suggestNamedThemeVars && sourceText.includes("(--"),
        };
    });

    // Determine which arbitrary tokens are NOT already cached. Only load
    // Tailwind if there are misses — a warm cache bypasses the ~1.4s
    // design-system initialization entirely.
    const cacheMisses = [];
    for (const raw of uniqueArbitraryRaws) {
        if (!CANONICAL_MEMO.has(raw)) {
            cacheMisses.push(raw);
        }
    }

    if (cacheMisses.length > 0) {
        const canonicalizeCandidate = await getCanonicalizeCandidate().catch(() => null);
        if (canonicalizeCandidate) {
            for (const raw of cacheMisses) {
                canonicalizeCandidate(raw);
            }
        }
    }

    // Pre-warm theme-var replacements (opt-in). Only when at least one
    // candidate token exists, to avoid loading the design system needlessly.
    // The resolver is loaded first so we know the active themeCssHash before
    // probing the on-disk cache; otherwise stale misses recorded under a
    // different theme CSS could be silently reused.
    if (suggestNamedThemeVars && uniqueThemeVarRaws.size > 0) {
        const themeVarResolver = await getThemeVarResolver({ themeCssPath }).catch((error) => {
            console.error(error?.message || String(error));
            return null;
        });
        if (themeVarResolver) {
            for (const raw of uniqueThemeVarRaws) {
                if (!CANONICAL_MEMO.has(buildThemeVarCacheKey(raw, activeThemeCssHash))) {
                    themeVarResolver(raw);
                }
            }
        }
    }

    // Pass 2: per-file scanning. Canonicalize lookups now hit the pre-warmed
    // memo, so no further design-system work happens in the hot loop.
    const perFileFindings = await runWithConcurrency(fileContexts, FILE_SCAN_CONCURRENCY, async (ctx) => {
        if (!ctx) {
            return [];
        }

        const { filePath, sourceText, snippets, perSnippetArbitraryRaws, hasAnyArbitrary, hasAnyThemeVarCandidate } = ctx;
        const relativePath = toRelative(filePath);
        const localFound = new Map();

        // Only build line-start index if we actually need per-token line/col.
        let lineStarts = null;
        const ensureLineStarts = () => {
            if (!lineStarts) {
                lineStarts = buildLineStarts(sourceText);
            }
            return lineStarts;
        };

        // If every arbitrary token is cached, we never loaded Tailwind.
        // Use the cache-only lookup; otherwise fall through to the full
        // canonicalizer (already warmed above).
        let canonicalizeCandidate = null;
        if (hasAnyArbitrary) {
            if (canonicalizerFnPromise) {
                canonicalizeCandidate = await canonicalizerFnPromise.catch(() => null);
            } else {
                canonicalizeCandidate = lookupCanonicalFromMemo;
            }
        }

        let themeVarLookup = null;
        if (suggestNamedThemeVars && hasAnyThemeVarCandidate) {
            if (themeVarResolverPromise) {
                themeVarLookup = await themeVarResolverPromise.catch(() => null);
            } else {
                themeVarLookup = lookupThemeVarReplacementFromMemo;
            }
        }

        for (let si = 0; si < snippets.length; si++) {
            const snippet = snippets[si];
            const arbitraryRaws = perSnippetArbitraryRaws[si];

            if (arbitraryRaws && arbitraryRaws.length > 0) {
                const ls = ensureLineStarts();
                for (const { raw, snippetOffset } of arbitraryRaws) {
                    let suggestion = null;

                    if (canonicalizeCandidate && raw.includes("[")) {
                        const tailwindCanonical = canonicalizeCandidate(raw);
                        if (tailwindCanonical && tailwindCanonical !== raw) {
                            suggestion = tailwindCanonical;
                        }
                    }

                    // Chain canonicalize -> named-theme-var. When Tailwind
                    // canonicalizes `border-[var(--x)]/40` to `border-(--x)/40`,
                    // the resolver should still get a chance to collapse the
                    // var ref to the named utility (`border-x/40`). Operate on
                    // the post-canonical string so the final emitted suggestion
                    // is the most specific one we can prove safe.
                    const themeInput = suggestion ?? raw;
                    if (themeVarLookup && tokenLooksLikeNamedThemeVarCandidate(themeInput)) {
                        const themeReplacement = themeVarLookup(themeInput);
                        if (themeReplacement && themeReplacement !== themeInput) {
                            suggestion = themeReplacement;
                        }
                    }

                    if (suggestion) {
                        const { line, column } = indexToLineCol(ls, snippet.index + snippetOffset);
                        maybePushFinding(localFound, {
                            filePath: relativePath,
                            line,
                            column,
                            message: `The class '${raw}' can be written as '${suggestion}'`,
                        });
                    }
                }
            }

            const tokenRegex = /\S+/g;
            let tokenMatch;
            const parsedTokens = [];

            while ((tokenMatch = tokenRegex.exec(snippet.value)) !== null) {
                const token = parseClassToken(tokenMatch[0], tokenMatch.index);
                if (!isLikelyTailwindUtility(token)) {
                    continue;
                }

                parsedTokens.push(token);

                // v3 optimization: avoid the Tailwind canonicalizer for general
                // non-arbitrary tokens, but still report explicit known aliases.
                const knownCanonical = getKnownCanonicalClass(token.raw);
                if (knownCanonical || (token.importantPrefix && !token.importantSuffix)) {
                    const canonical = knownCanonical ?? formatClass(token.variants, true, token.utility);
                    const ls = ensureLineStarts();
                    const { line, column } = indexToLineCol(ls, snippet.index + tokenMatch.index);
                    maybePushFinding(localFound, {
                        filePath: relativePath,
                        line,
                        column,
                        message: `The class '${token.raw}' can be written as '${canonical}'`,
                    });
                }
            }

            if (parsedTokens.length > 1) {
                const grouped = new Map();
                for (const token of parsedTokens) {
                    const key = `${token.variants}|${token.important ? "1" : "0"}`;
                    if (!grouped.has(key)) {
                        grouped.set(key, []);
                    }

                    grouped.get(key).push(token);
                }

                const ls = ensureLineStarts();
                const snippetAnchor = indexToLineCol(ls, snippet.index);
                detectFamilyShorthand(grouped, relativePath, snippetAnchor.line, snippetAnchor.column, localFound);
                detectComplexEquivalences(grouped, relativePath, snippetAnchor.line, snippetAnchor.column, localFound);
            }
        }

        return [...localFound.values()];
    });

    return perFileFindings.flat().sort(
        (a, b) =>
            a.filePath.localeCompare(b.filePath) ||
            a.line - b.line ||
            a.column - b.column ||
            a.message.localeCompare(b.message),
    );
}

function printTextReport(findings, lintedFiles) {
    if (findings.length === 0) {
        console.log(`normwinds v${NORMWINDS_VERSION}: no shorthand/canonical findings in ${lintedFiles} files.`);
        return;
    }

    console.log(`normwinds v${NORMWINDS_VERSION}: ${findings.length} finding(s) across ${lintedFiles} linted file(s).`);

    let currentFile = "";
    for (const finding of findings) {
        if (finding.filePath !== currentFile) {
            currentFile = finding.filePath;
            console.log(`\n${currentFile}`);
        }

        console.log(
            `  ${String(finding.line).padStart(4)}:${String(finding.column).padEnd(3)} ${finding.message}`,
        );
    }

    console.log("\nRun `npm run lint` for the full lint profile.");
}

async function main() {
    const {
        checkCanonical,
        cleanupCanonicalFiles,
        extractCanonical,
        fix,
        fixAll,
        help,
        json,
        patterns,
        suggestNamedThemeVars,
        themeCssPath,
        writeCanonicalFiles,
    } = parseArgs(process.argv.slice(2));

    if (help) {
        printHelp();
        return;
    }

    if (suggestNamedThemeVars && !themeCssPath) {
        console.error(
            "normwinds: --suggest-named-theme-vars requires --theme-css <path-to-project-tailwind.css>.",
        );
        process.exitCode = 2;
        return;
    }

    if (cleanupCanonicalFiles) {
        await cleanupCanonicalArtifacts();
        console.log(`normwinds v${NORMWINDS_VERSION}: removed canonical generated artifacts (if present).`);
        return;
    }

    if (checkCanonical) {
        await extractCanonicalReplacements({ writeFiles: false, checkOnly: true });
        return;
    }

    if (extractCanonical) {
        await extractCanonicalReplacements({ writeFiles: writeCanonicalFiles });
        return;
    }

    const [filePaths] = await Promise.all([
        listTargetFiles(patterns),
        (async () => {
            await loadDiskCache();
            await loadCanonicalSnapshot();
        })(),
    ]);

    if (fix) {
        await applyFixes(filePaths, { fixAll, suggestNamedThemeVars, themeCssPath });
    }

    const findings = await collectStaticShorthandFindings(filePaths, { suggestNamedThemeVars, themeCssPath });

    await saveDiskCache();

    if (json) {
        console.log(
            JSON.stringify(
                {
                    version: NORMWINDS_VERSION,
                    ruleId: RULE_ID,
                    lintedFiles: filePaths.length,
                    findingCount: findings.length,
                    findings,
                },
                null,
                2,
            ),
        );
    } else {
        printTextReport(findings, filePaths.length);
    }

    process.exitCode = findings.length > 0 ? 1 : 0;
}

main().catch((error) => {
    console.error("normwinds: failed to run shorthand audit.");
    console.error(error);
    process.exitCode = 2;
});
