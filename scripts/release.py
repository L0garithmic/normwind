#!/usr/bin/env python3
"""
NormWind release script.

Usage:
    python scripts/release.py <new-version> [--message "optional commit message"]

Example:
    python scripts/release.py 3.0.4
    python scripts/release.py 3.1.0 --message "feat: add new canonical rules"

What it does:
    1. Bumps the version in package.json
    2. Commits, tags, and pushes to GitHub (using github_pat from .env)
    3. Creates a GitHub release via the API
    4. Publishes to npm (using NODE_AUTH_TOKEN from .env)

Single source of truth:
    bin/normwind.mjs is the only CLI implementation. There is no longer a
    parallel "editable master" in scripts/. Edit bin/normwind.mjs directly.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


# --------------------------------------------------------------------------- #
# Paths                                                                        #
# --------------------------------------------------------------------------- #

ROOT = Path(__file__).resolve().parent.parent  # repo root
PACKAGE_JSON = ROOT / "package.json"
ENV_FILE = ROOT / ".env"

GITHUB_REPO = "L0garithmic/normwind"
NPM_REGISTRY = "https://registry.npmjs.org/"


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #


def load_env(path: Path) -> dict[str, str]:
    """Parse a simple KEY=value .env file (no shell expansion)."""
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


def run(cmd: list[str], cwd: Path | None = None, env_extra: dict | None = None) -> str:
    """Run a subprocess, print command, raise on failure, return stdout."""
    print(f"  $ {' '.join(cmd)}")
    merged_env = {**os.environ, **(env_extra or {})}
    result = subprocess.run(
        cmd,
        cwd=str(cwd or ROOT),
        capture_output=True,
        text=True,
        env=merged_env,
    )
    if result.stdout.strip():
        print(result.stdout.rstrip())
    if result.returncode != 0:
        print(result.stderr.rstrip(), file=sys.stderr)
        sys.exit(f"Command failed with exit code {result.returncode}")
    return result.stdout.strip()


def step(label: str) -> None:
    print(f"\n{'='*60}\n  {label}\n{'='*60}")


def github_api(method: str, path: str, body: dict | None, token: str) -> dict:
    """Make a GitHub REST API call and return the parsed JSON response."""
    url = f"https://api.github.com{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "normwind-release-script",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        sys.exit(f"GitHub API error {exc.code}: {body_text}")


# --------------------------------------------------------------------------- #
# Release steps                                                                #
# --------------------------------------------------------------------------- #


def bump_version(new_version: str) -> str:
    step("1/4  Bump version in package.json")
    pkg = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    old_version = pkg["version"]
    if old_version == new_version:
        print(f"  Already at {new_version}, nothing to bump.")
    else:
        pkg["version"] = new_version
        PACKAGE_JSON.write_text(
            json.dumps(pkg, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"  {old_version} -> {new_version}")
    return old_version


def git_commit_tag_push(new_version: str, message: str, github_pat: str) -> None:
    step("2/4  Git commit, tag, and push")

    run(["git", "add", "-A"])
    run(["git", "commit", "-m", message])

    tag = f"v{new_version}"
    run(["git", "tag", tag])

    remote_url = f"https://x-access-token:{github_pat}@github.com/{GITHUB_REPO}.git"
    run(["git", "remote", "set-url", "origin", remote_url])
    run(["git", "push", "origin", "main", "--tags"])

    # Reset remote URL to the clean form (no PAT embedded)
    clean_url = f"https://github.com/{GITHUB_REPO}.git"
    run(["git", "remote", "set-url", "origin", clean_url])

    print(f"  Pushed main + tag {tag}")


def create_github_release(new_version: str, release_body: str, github_pat: str) -> str:
    step("3/4  Create GitHub release")
    tag = f"v{new_version}"
    resp = github_api(
        "POST",
        f"/repos/{GITHUB_REPO}/releases",
        {
            "tag_name": tag,
            "name": tag,
            "body": release_body,
            "draft": False,
            "prerelease": False,
        },
        github_pat,
    )
    url = resp.get("html_url", "(unknown)")
    print(f"  Release created: {url}")
    return url


def npm_publish(npm_token: str) -> None:
    step("4/4  Publish to npm")
    # Write a temporary .npmrc so the token never touches the project directory.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".npmrc", delete=False, encoding="utf-8") as f:
        f.write(f"//registry.npmjs.org/:_authToken={npm_token}\n")
        tmp_npmrc = f.name

    try:
        run(
            ["npm", "publish", f"--registry={NPM_REGISTRY}", "--access", "public",
             f"--userconfig={tmp_npmrc}"],
        )
    finally:
        os.unlink(tmp_npmrc)

    # Remove any .tgz artefact npm may have left in the repo directory.
    for tgz in ROOT.glob("*.tgz"):
        tgz.unlink()
        print(f"  Removed leftover tarball: {tgz.name}")


# --------------------------------------------------------------------------- #
# Entry point                                                                  #
# --------------------------------------------------------------------------- #


def main() -> None:
    parser = argparse.ArgumentParser(description="Release @lunawerx/normwind to npm and GitHub.")
    parser.add_argument("version", help="New semver version, e.g. 3.0.4")
    parser.add_argument(
        "--message",
        "-m",
        default=None,
        help="Git commit message (default: auto-generated from version)",
    )
    parser.add_argument(
        "--release-notes",
        default=None,
        help="GitHub release body text (default: auto-generated)",
    )
    args = parser.parse_args()

    new_version = args.version.lstrip("v")

    # Validate semver-ish.
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-.].+)?", new_version):
        sys.exit(f"Invalid version: {new_version!r}  (expected e.g. 3.0.4)")

    # Load credentials.
    env = load_env(ENV_FILE)
    github_pat = env.get("github_pat", "")
    npm_token = env.get("NODE_AUTH_TOKEN", "")

    if not github_pat:
        sys.exit(f"github_pat not found in {ENV_FILE}")
    if not npm_token:
        sys.exit(f"NODE_AUTH_TOKEN not found in {ENV_FILE}")

    commit_message = args.message or (f"release: publish {new_version}")

    release_notes = args.release_notes or (
        f"## What's new in {new_version}\n\nSee commit history for full details."
    )

    print(f"\nReleasing @lunawerx/normwind v{new_version}\n")

    bump_version(new_version)
    git_commit_tag_push(new_version, commit_message, github_pat)
    create_github_release(new_version, release_notes, github_pat)
    npm_publish(npm_token)

    print(f"\nDone. v{new_version} is live on npm and GitHub.\n")


if __name__ == "__main__":
    main()
