#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const NORMWINDS_VERSION = "3.0.2";
const RULE_ID = "tailwindcss/enforces-shorthand";
const DEFAULT_PATTERNS = ["**/*.{vue,js,mjs,ts,jsx,tsx}"];
const ROOT_FONT_SIZE_PX = 16;
const FILE_SCAN_CONCURRENCY = 32;
const CANONICAL_OUTPUT_JSON = path.resolve(
    process.cwd(),
    "docs/reference/TAILWIND_CANONICAL_REPLACEMENTS.generated.json",
);
const CANONICAL_OUTPUT_MD = path.resolve(
    process.cwd(),
    "docs/reference/TAILWIND_CANONICAL_REPLACEMENTS.generated.md",
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

    for (const arg of argv) {
        if (arg.startsWith("--")) {
            flags.add(arg);
            continue;
        }

        patterns.push(arg);
    }

    return {
        cleanupCanonicalFiles: flags.has("--cleanup-canonical-files"),
        extractCanonical: flags.has("--extract-canonical"),
        fix: flags.has("--fix") || flags.has("--fixall"),
        fixAll: flags.has("--fixall"),
        json: flags.has("--json"),
        writeCanonicalFiles: flags.has("--write-canonical-files"),
        patterns,
    };
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

async function extractCanonicalReplacements({ writeFiles }) {
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
        generatedAt: new Date().toISOString(),
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
        `- Generated at: \`${payload.generatedAt}\``,
        `- Class list scanned: \`${classList.length}\``,
        `- Canonical replacements extracted: \`${replacements.length}\``,
        "",
        "## Drift Prevention",
        "",
        "Regenerate this catalog whenever Tailwind is upgraded:",
        "",
        "```bash",
        "npm run normwinds:extract-canonical",
        "```",
        "",
        "Recommended CI gate:",
        "",
        "```bash",
        "npm run normwinds:extract-canonical && git diff --exit-code docs/reference/TAILWIND_CANONICAL_REPLACEMENTS.generated.json docs/reference/TAILWIND_CANONICAL_REPLACEMENTS.generated.md",
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
        "- `docs/reference/TAILWIND_CANONICAL_REPLACEMENTS.generated.json`",
    );

    console.log(`normwinds v${NORMWINDS_VERSION}: extracted ${replacements.length} canonical replacement(s).`);

    if (writeFiles) {
        await fs.writeFile(CANONICAL_OUTPUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        await fs.writeFile(CANONICAL_OUTPUT_MD, `${markdownLines.join("\n")}\n`, "utf8");
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

function isLikelyFixUtility(raw) {
    if (!raw) {
        return false;
    }

    if (/[=><&|?,'"`*]/.test(raw)) {
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

    for (let i = 0; i < tokens.length; i += 1) {
        const a = parseFixToken(tokens[i]);
        const aMatch = matchFixBodyValue(a.utility, "w");
        if (!aMatch || aMatch.negative) {
            continue;
        }

        for (let j = i + 1; j < tokens.length; j += 1) {
            const b = parseFixToken(tokens[j]);
            const bMatch = matchFixBodyValue(b.utility, "h");
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

            const existingTarget = tokens.some((token, index) => {
                if (index === i || index === j) {
                    return false;
                }

                const parsed = parseFixToken(token);
                return (
                    parsed.variants === a.variants &&
                    parsed.important === a.important &&
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

function hasSingleTokenTransformPotential(token) {
    return token.includes("[") || (token.startsWith("!") && !token.endsWith("!")) || /:[!]/.test(token);
}

function hasTransformableClassLikeContent(content) {
    const tokens = content.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return false;
    }

    const classLikeTokens = tokens.filter((token) => isLikelyFixUtility(token));
    if (classLikeTokens.length >= 2) {
        return true;
    }

    if (classLikeTokens.length === 1) {
        return hasSingleTokenTransformPotential(classLikeTokens[0]);
    }

    return false;
}

function looksLikeFixableClassString(content) {
    if (/[=><&|?]/.test(content)) {
        return false;
    }

    return hasTransformableClassLikeContent(content);
}

function transformFixableClassContent(content, canonicalizeCandidate) {
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

        if (!isLikelyFixUtility(tokens[i]) || !canonicalizeCandidate) {
            continue;
        }

        const canonical = canonicalizeCandidate(tokens[i]);
        if (canonical && canonical !== tokens[i]) {
            tokens[i] = canonical;
            changed = true;
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

function applyFixesToText(text, canonicalizeCandidate) {
    let changed = false;

    const transformQuotedStrings = (input, regex, quote) =>
        input.replace(regex, (full, content) => {
            if (!looksLikeFixableClassString(content)) {
                return full;
            }

            const next = transformFixableClassContent(content, canonicalizeCandidate);
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

async function applyFixes(filePaths, { fixAll = false } = {}) {
    let changedFiles = 0;

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
        const { changed, transformed } = applyFixesToText(sourceText, canonicalizeCandidate);
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

function extractClassLikeStrings(sourceText) {
    const results = [];
    const classAttrRegex = /\bclass\s*=\s*(["'])([^"']+)\1/g;
    let match;

    while ((match = classAttrRegex.exec(sourceText)) !== null) {
        const startIndex = match.index + match[0].indexOf(match[2]);
        results.push({
            value: match[2],
            index: startIndex,
        });
    }

    const quoteRegexes = [/"((?:\\.|[^"\\])*)"/g, /'((?:\\.|[^'\\])*)'/g, /`((?:\\.|[^`\\])*)`/g];
    for (const quoteRegex of quoteRegexes) {
        while ((match = quoteRegex.exec(sourceText)) !== null) {
            const value = match[1];
            if (!value.includes("-") && !value.includes("!")) {
                continue;
            }

            if (value.includes("*")) {
                continue;
            }

            if (/[=><&|?]/.test(value)) {
                continue;
            }

            if (!QUOTE_VALUE_SHAPE.test(value)) {
                continue;
            }

            if (!hasTransformableClassLikeContent(value)) {
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
async function collectStaticShorthandFindings(filePaths) {
    // Pass 1: read every file, extract class snippets, collect unique arbitrary
    // tokens across the entire set for a single batched canonicalization.
    const fileContexts = new Array(filePaths.length);
    const uniqueArbitraryRaws = new Set();
    const arbitraryTokenRegex = /(?:^|\s)((?:[a-z0-9-]+:)*!?[a-z][a-z0-9-]*-\[[^\]\s]+\]!?)(?=\s|$)/gi;

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

        const snippets = extractClassLikeStrings(sourceText);
        if (snippets.length === 0) {
            fileContexts[idx] = null;
            return;
        }

        // Collect arbitrary raw tokens (containing `[`) for global batch
        // canonicalization. Also note which snippets need the canonicalizer.
        const perSnippetArbitraryRaws = new Array(snippets.length);
        let hasAnyArbitrary = false;
        for (let i = 0; i < snippets.length; i++) {
            const snippet = snippets[i];
            if (!snippet.value.includes("[")) {
                perSnippetArbitraryRaws[i] = null;
                continue;
            }

            hasAnyArbitrary = true;
            arbitraryTokenRegex.lastIndex = 0;
            let match;
            const raws = [];
            while ((match = arbitraryTokenRegex.exec(snippet.value)) !== null) {
                const raw = match[1];
                raws.push({
                    raw,
                    snippetOffset: match.index + match[0].lastIndexOf(raw),
                });
                uniqueArbitraryRaws.add(raw);
            }
            perSnippetArbitraryRaws[i] = raws;
        }

        fileContexts[idx] = {
            filePath,
            sourceText,
            snippets,
            perSnippetArbitraryRaws,
            hasAnyArbitrary,
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

    // Pass 2: per-file scanning. Canonicalize lookups now hit the pre-warmed
    // memo, so no further design-system work happens in the hot loop.
    const perFileFindings = await runWithConcurrency(fileContexts, FILE_SCAN_CONCURRENCY, async (ctx) => {
        if (!ctx) {
            return [];
        }

        const { filePath, sourceText, snippets, perSnippetArbitraryRaws, hasAnyArbitrary } = ctx;
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

        for (let si = 0; si < snippets.length; si++) {
            const snippet = snippets[si];
            const arbitraryRaws = perSnippetArbitraryRaws[si];

            if (arbitraryRaws && arbitraryRaws.length > 0 && canonicalizeCandidate) {
                const ls = ensureLineStarts();
                for (const { raw, snippetOffset } of arbitraryRaws) {
                    const tailwindCanonical = canonicalizeCandidate(raw);
                    if (tailwindCanonical && tailwindCanonical !== raw) {
                        const { line, column } = indexToLineCol(ls, snippet.index + snippetOffset);
                        maybePushFinding(localFound, {
                            filePath: relativePath,
                            line,
                            column,
                            message: `The class '${raw}' can be written as '${tailwindCanonical}'`,
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

                // v3 optimization: only emit canonicalize findings for tokens
                // that actually contain arbitrary values. Non-arbitrary tokens
                // are always identity under Tailwind's canonicalizer.
                if (token.importantPrefix && !token.importantSuffix) {
                    const canonical = formatClass(token.variants, true, token.utility);
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
        cleanupCanonicalFiles,
        extractCanonical,
        fix,
        fixAll,
        json,
        patterns,
        writeCanonicalFiles,
    } = parseArgs(process.argv.slice(2));

    if (cleanupCanonicalFiles) {
        await cleanupCanonicalArtifacts();
        console.log(`normwinds v${NORMWINDS_VERSION}: removed canonical generated artifacts (if present).`);
        return;
    }

    if (extractCanonical) {
        await extractCanonicalReplacements({ writeFiles: writeCanonicalFiles });
        return;
    }

    const [filePaths] = await Promise.all([
        listTargetFiles(patterns),
        loadDiskCache(),
    ]);

    if (fix) {
        await applyFixes(filePaths, { fixAll });
    }

    const findings = await collectStaticShorthandFindings(filePaths);

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
