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
    assert(pkg.files.includes("bin"), "published files must include bin");
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

addCheck("regression fixtures", async () => {
    const result = await run(NODE_BIN, [REGRESSION_SCRIPT]);
    assert(result.ok, `test:regression failed\n${result.stdout}\n${result.stderr}`);
    assert(result.stdout.includes("7 fixtures, 0 failures."), "regression summary did not report 7 clean fixtures");
});

addCheck("snapshot/live parity", async () => {
    const result = await run(NODE_BIN, [COMPARE_SCRIPT]);
    assert(result.ok, `test:compare failed\n${result.stdout}\n${result.stderr}`);
    assert(result.stdout.includes("7 fixtures, 0 failures."), "compare summary did not report 7 clean fixtures");
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
