#!/usr/bin/env node
/**
 * Comprehensive pre-push verification for NormWind.
 *
 * This intentionally avoids external test frameworks so it works anywhere the
 * package itself works. It validates:
 *   - package metadata and published file list intent
 *   - generated canonical snapshot integrity and drift
 *   - fixture regression behavior
 *   - live Tailwind canonicalizer vs snapshot parity
 *   - CLI audit/fix smoke behavior in a clean consumer-like temp cwd
 *   - npm pack dry-run includes runtime-critical files
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const NODE_BIN = process.execPath;
const NORMWIND_BIN = path.join(REPO_ROOT, "bin", "normwind.mjs");
const REGRESSION_SCRIPT = path.join(REPO_ROOT, "scripts", "test-regression.mjs");
const COMPARE_SCRIPT = path.join(REPO_ROOT, "scripts", "test-compare.mjs");
const SNAPSHOT_JSON = path.join(REPO_ROOT, "docs", "reference", "canonical-replacements.json");
const SNAPSHOT_MD = path.join(REPO_ROOT, "docs", "reference", "canonical-replacements.md");

const checks = [];

function addCheck(name, fn) {
    checks.push({ name, fn });
}

async function run(command, args, options = {}) {
    try {
        const result = await execFileAsync(command, args, {
            cwd: REPO_ROOT,
            env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...(options.env ?? {}) },
            maxBuffer: 64 * 1024 * 1024,
            ...options,
        });
        return { ok: true, exitCode: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    } catch (err) {
        if (typeof err.code === "number") {
            return { ok: false, exitCode: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
        }
        throw err;
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function rmrf(dir) {
    await fs.rm(dir, { recursive: true, force: true });
}

function parseCliJson(stdout) {
    const trimmed = stdout.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    assert(start !== -1 && end !== -1 && end > start, "CLI did not emit JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
}

addCheck("package metadata", async () => {
    const pkg = await readJson(path.join(REPO_ROOT, "package.json"));
    assert(pkg.type === "module", "package must remain ESM");
    assert(pkg.bin?.normwind === "bin/normwind.mjs", "normwind bin mapping is missing");
    assert(pkg.bin?.normwinds === "bin/normwind.mjs", "normwinds alias mapping is missing");
    assert(pkg.dependencies?.tailwindcss, "tailwindcss dependency is missing");
    assert(pkg.dependencies?.["eslint-plugin-tailwindcss"], "eslint-plugin-tailwindcss dependency is missing");
    assert(!pkg.dependencies?.eslint, "eslint must not be a runtime dependency");
    assert(pkg.files.includes("bin/normwind.mjs"), "published files must include bin/normwind.mjs explicitly");
    assert(!pkg.files.includes("bin"), "published files must whitelist bin/normwind.mjs explicitly, not the entire bin/ directory (otherwise *.bak and other scratch files leak into the tarball)");
    assert(pkg.files.includes("docs/reference/canonical-replacements.json"), "published files must include canonical JSON snapshot");
    assert(pkg.files.includes("docs/reference/canonical-replacements.md"), "published files must include canonical MD snapshot");
    assert(pkg.scripts?.["canonical:check"], "canonical:check script is missing");
    assert(pkg.scripts?.["test:regression"], "test:regression script is missing");
    assert(pkg.scripts?.["test:compare"], "test:compare script is missing");
});

addCheck("canonical snapshot integrity", async () => {
    const snapshot = await readJson(SNAPSHOT_JSON);
    const markdown = await fs.readFile(SNAPSHOT_MD, "utf8");
    assert(snapshot.source?.engine === "tailwindcss.designSystem.canonicalizeCandidates", "snapshot source engine is wrong");
    assert(typeof snapshot.source?.tailwindVersion === "string", "snapshot Tailwind version missing");
    assert(snapshot.source?.rootFontSizePx === 16, "snapshot root font size must be 16px");
    assert(Number.isInteger(snapshot.totals?.replacementCount), "snapshot replacement count missing");
    assert(snapshot.totals.replacementCount === snapshot.replacements.length, "snapshot replacement count does not match replacements length");
    assert(snapshot.replacements.length > 1000, "snapshot unexpectedly small");
    assert(!Object.prototype.hasOwnProperty.call(snapshot, "generatedAt"), "snapshot must be deterministic; generatedAt is not allowed");
    assert(snapshot.replacements.some((r) => r.inputClass === "rounded-[24px]" && r.canonicalClass === "rounded-3xl"), "expected rounded-[24px] -> rounded-3xl mapping missing");
    assert(markdown.includes("npm run canonical:check"), "canonical markdown should document canonical:check");
});

addCheck("canonical drift check", async () => {
    const result = await run(NODE_BIN, [NORMWIND_BIN, "--check-canonical"]);
    assert(result.ok, `canonical:check failed\n${result.stdout}\n${result.stderr}`);
});

addCheck("check-canonical failure path", async () => {
    // --check-canonical compares against <cwd>/docs/reference/*, so this
    // proves the negative: a deliberately corrupted snapshot must fail the
    // check (exit non-zero), not just pass silently. Without this we'd only
    // ever exercise the "already up to date" branch above.
    const dir = path.join(os.tmpdir(), `normwind-check-canonical-corrupt-${Date.now()}`);
    const docsDir = path.join(dir, "docs", "reference");
    await fs.mkdir(docsDir, { recursive: true });
    const jsonDest = path.join(docsDir, "canonical-replacements.json");
    const mdDest = path.join(docsDir, "canonical-replacements.md");

    try {
        await fs.copyFile(SNAPSHOT_JSON, jsonDest);
        await fs.copyFile(SNAPSHOT_MD, mdDest);

        const snapshot = await readJson(jsonDest);
        assert(Array.isArray(snapshot.replacements) && snapshot.replacements.length > 0, "snapshot has no replacements to corrupt");
        snapshot.replacements[0] = {
            ...snapshot.replacements[0],
            canonicalClass: "corrupted-value-for-test",
        };
        await fs.writeFile(jsonDest, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

        const result = await run(NODE_BIN, [NORMWIND_BIN, "--check-canonical"], { cwd: dir });
        assert(!result.ok, "--check-canonical should fail against a corrupted docs/reference snapshot");
        assert(result.exitCode !== 0, `expected non-zero exit, got ${result.exitCode}`);
    } finally {
        await rmrf(dir);
    }
});

// Compute the actual fixture count once so the assertions match the on-disk
// state. Hard-coding the count would force every fixture addition to chase a
// magic number here; what we actually want is "every fixture is clean and the
// suite still runs all of them".
async function countFixtures() {
    const fixturesDir = path.join(REPO_ROOT, "test", "fixtures");
    const entries = await fs.readdir(fixturesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
}

addCheck("regression fixtures", async () => {
    const result = await run(NODE_BIN, [REGRESSION_SCRIPT]);
    assert(result.ok, `test:regression failed\n${result.stdout}\n${result.stderr}`);
    const expected = await countFixtures();
    assert(expected > 0, "no fixtures found under test/fixtures");
    assert(
        result.stdout.includes(`${expected} fixtures, 0 failures.`),
        `regression summary did not report ${expected} clean fixtures\n${result.stdout}`,
    );
});

addCheck("snapshot/live parity", async () => {
    const result = await run(NODE_BIN, [COMPARE_SCRIPT]);
    assert(result.ok, `test:compare failed\n${result.stdout}\n${result.stderr}`);
    const expected = await countFixtures();
    assert(expected > 0, "no fixtures found under test/fixtures");
    assert(
        result.stdout.includes(`${expected} fixtures, 0 failures.`),
        `compare summary did not report ${expected} clean fixtures\n${result.stdout}`,
    );
});

addCheck("CLI smoke audit/fix", async () => {
    const dir = path.join(os.tmpdir(), `normwind-smoke-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "Smoke.vue");
    const source = `<template>\n  <div class="px-4 py-4 rounded-[24px] w-[100%]">Smoke</div>\n</template>\n`;
    await fs.writeFile(filePath, source, "utf8");

    try {
        const audit = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        assert(audit.exitCode === 1, `audit should exit 1 when findings exist, got ${audit.exitCode}`);
        const payload = parseCliJson(audit.stdout);
        assert(payload.findingCount >= 3, `expected at least 3 smoke findings, got ${payload.findingCount}`);
        assert(payload.findings.some((f) => f.message.includes("px-4, py-4") && f.message.includes("p-4")), "smoke audit missing padding shorthand finding");
        assert(payload.findings.some((f) => f.message.includes("rounded-[24px]") && f.message.includes("rounded-3xl")), "smoke audit missing rounded canonical finding");
        assert(payload.findings.some((f) => f.message.includes("w-[100%]") && f.message.includes("w-full")), "smoke audit missing width canonical finding");

        const fix = await run(NODE_BIN, [NORMWIND_BIN, "--fix", "--json"], { cwd: dir });
        assert(fix.exitCode === 0, `fix should exit 0 after rewriting findings, got ${fix.exitCode}\n${fix.stdout}\n${fix.stderr}`);
        const fixed = await fs.readFile(filePath, "utf8");
        assert(fixed.includes('class="p-4 rounded-3xl w-full"'), `smoke fix output was not canonicalized: ${fixed}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("dry-run writes nothing", async () => {
    const dir = path.join(os.tmpdir(), `normwind-dry-run-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "DryRun.tsx");
    const source = `export const A = () => (\n    <div className="px-4 py-4">A</div>\n);\n`;
    await fs.writeFile(filePath, source, "utf8");

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--fixall", "--dry-run"], { cwd: dir });
        assert(result.exitCode === 1, `dry-run should still exit 1 (findings remain), got ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
        assert(result.stdout.includes("[dry-run] would rewrite"), `dry-run should announce the would-be rewrite\n${result.stdout}`);
        const untouched = await fs.readFile(filePath, "utf8");
        assert(untouched === source, `--dry-run must not modify the file on disk: ${untouched}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("fixall fault isolation: write failure", async () => {
    // NORMWIND_TEST_FORCE_WRITE_FAIL is a test-only hook (mirrors
    // NORMWIND_TEST_FORCE_TRANSFORM_THROW) that makes the atomic temp-file write
    // throw EPERM for one named file — reproducing the real-world EBUSY/EPERM/
    // ENOSPC mode (an editor or antivirus holding the file, a read-only volume)
    // deterministically on every platform. A chmod-based read-only lock is
    // silently ignored under a root CI runner, so it can't be relied on here.
    // This proves one file's write failure does not abort the batch — the other
    // file still gets fixed, a summary is printed, and the process exits with the
    // dedicated partial-failure code (2), not 0 or 1.
    const dir = path.join(os.tmpdir(), `normwind-write-fail-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const lockedPath = path.join(dir, "Locked.vue");
    const okPath = path.join(dir, "Ok.vue");
    await fs.writeFile(lockedPath, `<template>\n  <div class="px-4 py-4">Locked</div>\n</template>\n`, "utf8");
    await fs.writeFile(okPath, `<template>\n  <div class="mt-3 mb-3">Ok</div>\n</template>\n`, "utf8");

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--fixall"], {
            cwd: dir,
            env: { NORMWIND_TEST_FORCE_WRITE_FAIL: "Locked.vue" },
        });
        assert(result.exitCode === 2, `partial-failure run should exit 2, got ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
        assert(/fix summary.*1 fixed, 0 skipped, 1 failed/.test(result.stderr), `expected a fixed/skipped/failed summary in stderr, got:\n${result.stderr}`);
        assert(result.stderr.includes("Locked.vue"), `summary should name the failed file:\n${result.stderr}`);

        const lockedContent = await fs.readFile(lockedPath, "utf8");
        assert(lockedContent.includes("px-4 py-4"), `locked file must be left untouched after a write failure: ${lockedContent}`);
        const okContent = await fs.readFile(okPath, "utf8");
        assert(okContent.includes("my-3"), `sibling file must still be fixed despite the earlier write failure: ${okContent}`);

        const leftoverTmp = (await fs.readdir(dir)).filter((name) => name.includes(".normwinds-tmp-"));
        assert(leftoverTmp.length === 0, `temp file must be cleaned up after a failed rename: ${leftoverTmp.join(", ")}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("fixall fault isolation: transform throw", async () => {
    // NORMWIND_TEST_FORCE_TRANSFORM_THROW is a test-only hook (mirrors
    // NORMWIND_DISABLE_CANONICAL_SNAPSHOT) that forces a transform exception
    // for one named file, proving the same per-file isolation applies to a
    // parser/transform edge case, not just I/O errors.
    const dir = path.join(os.tmpdir(), `normwind-transform-throw-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const throwingPath = path.join(dir, "Throws.vue");
    const okPath = path.join(dir, "Ok.vue");
    await fs.writeFile(throwingPath, `<template>\n  <div class="px-4 py-4">Throws</div>\n</template>\n`, "utf8");
    await fs.writeFile(okPath, `<template>\n  <div class="mt-3 mb-3">Ok</div>\n</template>\n`, "utf8");

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--fixall"], {
            cwd: dir,
            env: { NORMWIND_TEST_FORCE_TRANSFORM_THROW: "Throws.vue" },
        });
        assert(result.exitCode === 2, `partial-failure run should exit 2, got ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
        assert(/fix summary.*1 fixed, 0 skipped, 1 failed/.test(result.stderr), `expected a fixed/skipped/failed summary in stderr, got:\n${result.stderr}`);
        assert(result.stderr.includes("Throws.vue"), `summary should name the file whose transform threw:\n${result.stderr}`);

        const throwingContent = await fs.readFile(throwingPath, "utf8");
        assert(throwingContent.includes("px-4 py-4"), `file whose transform threw must be left untouched: ${throwingContent}`);
        const okContent = await fs.readFile(okPath, "utf8");
        assert(okContent.includes("my-3"), `sibling file must still be fixed despite the earlier transform throw: ${okContent}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("max-file-size skip", async () => {
    const dir = path.join(os.tmpdir(), `normwind-max-size-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const bigPath = path.join(dir, "Big.tsx");
    const smallPath = path.join(dir, "Small.tsx");
    const line = 'export const A = () => (<div className="px-4 py-4">A</div>);\n';
    const oversized = line.repeat(Math.ceil((5 * 1024 * 1024 + 1) / line.length));
    await fs.writeFile(bigPath, oversized, "utf8");
    await fs.writeFile(smallPath, `export const B = () => (\n    <div className="mt-3 mb-3">B</div>\n);\n`, "utf8");

    try {
        const audit = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        assert(audit.exitCode === 1, `audit should exit 1 for the still-findable small file, got ${audit.exitCode}\n${audit.stderr}`);
        assert(audit.stderr.includes("Big.tsx") && audit.stderr.includes("scan limit"), `oversized file skip should be logged:\n${audit.stderr}`);
        const payload = parseCliJson(audit.stdout);
        assert(payload.findings.every((f) => !f.filePath.includes("Big.tsx")), `oversized file must not produce findings: ${JSON.stringify(payload.findings)}`);
        assert(payload.findings.some((f) => f.filePath.includes("Small.tsx")), `small sibling file should still be scanned: ${JSON.stringify(payload.findings)}`);

        const fix = await run(NODE_BIN, [NORMWIND_BIN, "--fixall"], { cwd: dir });
        assert(fix.exitCode === 0, `fixall should exit 0 (oversized file skipped, not failed), got ${fix.exitCode}\n${fix.stdout}\n${fix.stderr}`);
        const bigContent = await fs.readFile(bigPath, "utf8");
        assert(bigContent === oversized, "oversized file must be left completely untouched by --fixall");
    } finally {
        await rmrf(dir);
    }
});

addCheck("version flag", async () => {
    const pkg = await readJson(path.join(REPO_ROOT, "package.json"));

    const version = await run(NODE_BIN, [NORMWIND_BIN, "--version"]);
    assert(version.ok, `--version should exit 0\n${version.stdout}\n${version.stderr}`);
    assert(version.exitCode === 0, `expected exit 0 for --version, got ${version.exitCode}`);
    assert(
        version.stdout.trim() === pkg.version,
        `--version output "${version.stdout.trim()}" did not match package.json version "${pkg.version}"`,
    );

    const bogus = await run(NODE_BIN, [NORMWIND_BIN, "--definitely-bogus"]);
    assert(!bogus.ok, "unknown flag should cause a non-zero exit");
    assert(bogus.exitCode === 2, `expected exit 2 for an unknown flag, got ${bogus.exitCode}`);
});

addCheck("ripgrep-fallback parity", async () => {
    // The CLI prefers `rg --files` for discovery and falls back to a manual
    // directory walk when `rg` cannot be spawned (ENOENT). Both paths must
    // discover and audit the identical file set; this pins that contract by
    // running the same fixable corpus twice, once with a PATH that excludes
    // ripgrep entirely.
    const dir = path.join(os.tmpdir(), `normwind-rg-parity-${Date.now()}`);
    await fs.mkdir(path.join(dir, "nested"), { recursive: true });
    await fs.writeFile(
        path.join(dir, "One.vue"),
        `<template>\n  <div class="px-2 py-2">One</div>\n</template>\n`,
        "utf8",
    );
    await fs.writeFile(
        path.join(dir, "nested", "Two.vue"),
        `<template>\n  <div class="mt-3 mb-3">Two</div>\n</template>\n`,
        "utf8",
    );

    try {
        const normal = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        assert(normal.exitCode === 1, `normal-PATH audit should exit 1, got ${normal.exitCode}\n${normal.stderr}`);
        const normalPayload = parseCliJson(normal.stdout);

        const nodeDir = path.dirname(NODE_BIN);
        const noRg = await run(NODE_BIN, [NORMWIND_BIN, "--json"], {
            cwd: dir,
            env: { PATH: nodeDir, Path: nodeDir },
        });
        assert(noRg.exitCode === 1, `no-rg-PATH audit should exit 1, got ${noRg.exitCode}\n${noRg.stderr}`);
        const noRgPayload = parseCliJson(noRg.stdout);

        assert(noRgPayload.lintedFiles === normalPayload.lintedFiles, `lintedFiles diverged: rg=${normalPayload.lintedFiles} walk=${noRgPayload.lintedFiles}`);
        const normalizeFindings = (payload) =>
            (payload.findings ?? [])
                .map((f) => `${f.filePath}:${f.line}:${f.column}:${f.message}`)
                .sort();
        assert(
            JSON.stringify(normalizeFindings(normalPayload)) === JSON.stringify(normalizeFindings(noRgPayload)),
            `findings diverged between rg and walk fallback\nrg: ${JSON.stringify(normalPayload.findings)}\nwalk: ${JSON.stringify(noRgPayload.findings)}`,
        );
    } finally {
        await rmrf(dir);
    }
});

addCheck("fallback walker: symlink loop guard", async () => {
    // Two directories symlinked into each other (A/link -> B, B/link -> A)
    // would recurse forever without a visited-realpath guard. This forces the
    // no-rg fallback walker (ripgrep has its own loop protection and would
    // mask a regression here) and bounds the run with a hard timeout so a
    // reintroduced infinite loop fails this check instead of hanging the
    // whole suite.
    const dir = path.join(os.tmpdir(), `normwind-symlink-loop-${Date.now()}`);
    await fs.mkdir(path.join(dir, "dirA"), { recursive: true });
    await fs.mkdir(path.join(dir, "dirB"), { recursive: true });
    await fs.writeFile(
        path.join(dir, "dirA", "One.vue"),
        `<template>\n  <div class="px-2 py-2">One</div>\n</template>\n`,
        "utf8",
    );
    await fs.writeFile(
        path.join(dir, "dirB", "Two.vue"),
        `<template>\n  <div class="mt-3 mb-3">Two</div>\n</template>\n`,
        "utf8",
    );

    try {
        await fs.symlink(path.join(dir, "dirB"), path.join(dir, "dirA", "link_to_b"), "junction").catch(
            () => fs.symlink(path.join(dir, "dirB"), path.join(dir, "dirA", "link_to_b")),
        );
        await fs.symlink(path.join(dir, "dirA"), path.join(dir, "dirB", "link_to_a"), "junction").catch(
            () => fs.symlink(path.join(dir, "dirA"), path.join(dir, "dirB", "link_to_a")),
        );

        const nodeDir = path.dirname(NODE_BIN);
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--json"], {
            cwd: dir,
            env: { PATH: nodeDir, Path: nodeDir },
            timeout: 15000,
        });
        assert(result.exitCode === 1, `audit should exit 1 (both files have findings), got ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
        const payload = parseCliJson(result.stdout);
        assert(payload.lintedFiles === 2, `expected exactly 2 linted files despite the symlink loop, got ${payload.lintedFiles}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("ignored directories", async () => {
    const dir = path.join(os.tmpdir(), `normwind-ignored-dirs-${Date.now()}`);
    const rootFile = path.join(dir, "Root.vue");
    const nodeModulesFile = path.join(dir, "node_modules", "x", "Copy.vue");
    const distFile = path.join(dir, "dist", "Copy.vue");
    const source = `<template>\n  <div class="px-2 py-2">Copy</div>\n</template>\n`;

    await fs.mkdir(path.dirname(nodeModulesFile), { recursive: true });
    await fs.mkdir(path.dirname(distFile), { recursive: true });
    await fs.writeFile(rootFile, source, "utf8");
    await fs.writeFile(nodeModulesFile, source, "utf8");
    await fs.writeFile(distFile, source, "utf8");

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        assert(result.exitCode === 1, `audit should exit 1, got ${result.exitCode}\n${result.stderr}`);
        const payload = parseCliJson(result.stdout);
        assert(payload.lintedFiles === 1, `expected lintedFiles===1 (node_modules/dist excluded), got ${payload.lintedFiles}`);
        assert(
            payload.findings.every((f) => f.filePath.replace(/\\/g, "/") === "Root.vue"),
            `findings should only reference the root file, got ${JSON.stringify(payload.findings)}`,
        );
    } finally {
        await rmrf(dir);
    }
});

addCheck("npm pack dry-run", async () => {
    const result = process.platform === "win32"
        ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm pack --dry-run --json --silent"])
        : await run("npm", ["pack", "--dry-run", "--json", "--silent"]);
    assert(result.ok, `npm pack dry-run failed\n${result.stdout}\n${result.stderr}`);
    const packs = JSON.parse(result.stdout);
    const files = new Set((packs[0]?.files ?? []).map((f) => f.path));
    assert(files.has("bin/normwind.mjs"), "pack is missing bin/normwind.mjs");
    assert(files.has("docs/reference/canonical-replacements.json"), "pack is missing canonical JSON snapshot");
    assert(files.has("docs/reference/canonical-replacements.md"), "pack is missing canonical MD snapshot");
    assert(files.has("README.md"), "pack is missing README.md");
    assert(!files.has("scripts/test-regression.mjs"), "pack should not include test scripts");
    assert(!files.has("test/fixtures/family-shorthand/input.tsx"), "pack should not include test fixtures");
    const stragglers = [...files].filter((f) => /\.(bak|orig|swp|tmp)$/i.test(f));
    assert(stragglers.length === 0, `pack must not contain editor/refactor backups: ${stragglers.join(", ")}`);
});

async function main() {
    let failed = 0;
    for (const check of checks) {
        const started = Date.now();
        try {
            await check.fn();
            const ms = Date.now() - started;
            console.log(`[PASS] ${check.name} (${ms}ms)`);
        } catch (err) {
            failed += 1;
            console.log(`[FAIL] ${check.name}`);
            console.log(`  ${err.message}`);
        }
    }

    console.log("");
    console.log(`${checks.length} checks, ${failed} failures.`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
    console.error("prepush: fatal error");
    console.error(err);
    process.exitCode = 2;
});
