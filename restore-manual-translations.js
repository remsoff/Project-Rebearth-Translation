#!/usr/bin/env node

/**
 * restore-manual-translations.js
 *
 * Restores manually curated (community-contributed) translations that were
 * overwritten by automated translation tools.
 *
 * Strategy:
 *   Uses the community translations repository (Project-Rebearth-Translation)
 *   as the source of truth. For each non-English locale file:
 *
 *   1. Walk git history in the translations repo and find all commits by
 *      NON-SAM authors (community contributors). Any commit by "program-sam"
 *      or "vanemelensam" or "samvanemelen" is considered automated.
 *
 *   2. For each community commit, diff it against its parent to find which
 *      keys were ACTUALLY CHANGED by that contributor. Build a map of
 *      key → { value, author, commit } for all manually curated translations.
 *      Later community commits override earlier ones for the same key.
 *
 *   3. In the working tree, for any key that has a manually curated value:
 *      - If the English source for that key changed → keep the automated
 *        translation (source text changed, re-translation is warranted)
 *      - If the English source did NOT change → RESTORE the community value
 *
 *   4. New keys (only in working tree) are always kept.
 *
 * Prerequisites:
 *   The translations remote must be configured. The script will auto-add it:
 *     git remote add translations https://github.com/program-sam/Project-Rebearth-Translation.git
 *
 * Usage:
 *   node restore-manual-translations.js            # dry-run (default)
 *   node restore-manual-translations.js --apply     # actually write files
 *   node restore-manual-translations.js --verbose   # show every decision
 *
 * Run this script from anywhere in the project.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── CLI flags ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const VERBOSE = args.includes("--verbose");
const DRY_RUN = !APPLY;

// ── Configuration ──────────────────────────────────────────────────────

const TRANSLATIONS_REMOTE = "translations";
const TRANSLATIONS_REPO_URL =
  "https://github.com/program-sam/Project-Rebearth-Translation.git";
const TRANSLATIONS_BRANCH = `${TRANSLATIONS_REMOTE}/main`;

// Author patterns considered "automated" (Sam's accounts)
const AUTOMATED_AUTHOR_PATTERNS = [
  "vanemelensam",
  "program-sam",
  "samvanemelen",
];

// ── Resolve paths ──────────────────────────────────────────────────────

const repoRoot = execSync("git rev-parse --show-toplevel", {
  encoding: "utf8",
}).trim();
const localesDir = path.join(repoRoot, "src", "i18n", "locales");

// ── Helpers ────────────────────────────────────────────────────────────

function loadJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadJsonFromGit(ref, relPath) {
  try {
    const content = execSync(`git show ${ref}:${relPath}`, {
      encoding: "utf8",
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function flattenObject(obj, prefix = "") {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

function setNestedValue(obj, keyPath, value) {
  const keys = keyPath.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (
      !(keys[i] in current) ||
      typeof current[keys[i]] !== "object" ||
      current[keys[i]] === null
    ) {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isAutomatedAuthor(email) {
  const lower = email.toLowerCase();
  return AUTOMATED_AUTHOR_PATTERNS.some((p) => lower.includes(p));
}

// ── Translations remote setup ──────────────────────────────────────────

function ensureTranslationsRemote() {
  try {
    const remotes = execSync("git remote", {
      encoding: "utf8",
      cwd: repoRoot,
    });
    if (!remotes.split("\n").includes(TRANSLATIONS_REMOTE)) {
      console.log(`   Adding remote '${TRANSLATIONS_REMOTE}'...`);
      execSync(
        `git remote add ${TRANSLATIONS_REMOTE} ${TRANSLATIONS_REPO_URL}`,
        { cwd: repoRoot }
      );
    }
    console.log(`   Fetching '${TRANSLATIONS_REMOTE}'...`);
    execSync(`git fetch ${TRANSLATIONS_REMOTE}`, {
      cwd: repoRoot,
      stdio: "pipe",
    });
    // Also fetch PRs so we see community commits that haven't been merged
    try {
      execSync(
        `git fetch ${TRANSLATIONS_REMOTE} 'refs/pull/*/head:refs/remotes/${TRANSLATIONS_REMOTE}/pr/*'`,
        { cwd: repoRoot, stdio: "pipe" }
      );
    } catch {
      // Non-fatal — PRs might not exist or may already be merged
    }
  } catch (e) {
    console.error(`❌ Failed to set up translations remote: ${e.message}`);
    process.exit(1);
  }
}

// ── Build community translation map ────────────────────────────────────

/**
 * For a given locale file (e.g. "ru.json"), walk the translations repo
 * history and find all keys that were changed by community (non-Sam) authors.
 *
 * Checks both the main branch and all PR branches.
 *
 * Returns: Map<keyPath, { value, author, commit, message }>
 */
function buildCommunityTranslations(localeFile) {
  const communityKeys = new Map();

  // Collect all branch refs to scan: main + all PR branches
  const branchRefs = [TRANSLATIONS_BRANCH];
  try {
    const prBranches = execSync(
      `git branch -r --list '${TRANSLATIONS_REMOTE}/pr/*'`,
      { encoding: "utf8", cwd: repoRoot }
    )
      .trim()
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
    branchRefs.push(...prBranches);
  } catch {
    // No PR branches found
  }

  // Deduplicate commits across branches
  const processedCommits = new Set();

  for (const branchRef of branchRefs) {
    // Get all commits that touched this file, oldest first
    let logOutput;
    try {
      logOutput = execSync(
        `git log ${branchRef} --reverse --format="%H|%ae|%s" -- ${localeFile}`,
        { encoding: "utf8", cwd: repoRoot }
      ).trim();
    } catch {
      continue;
    }

    if (!logOutput) continue;

    const commits = logOutput.split("\n").map((line) => {
      const [hash, email, ...msgParts] = line.split("|");
      return { hash, email, message: msgParts.join("|") };
    });

    for (const commit of commits) {
      // Skip automated (Sam's) commits
      if (isAutomatedAuthor(commit.email)) continue;

      // Skip already-processed commits (same commit seen via different branch)
      if (processedCommits.has(commit.hash)) continue;
      processedCommits.add(commit.hash);

      // Load this file at this commit and its parent
      const current = loadJsonFromGit(commit.hash, localeFile);
      if (!current) continue;

      const parent = loadJsonFromGit(`${commit.hash}^`, localeFile);
      const currentFlat = flattenObject(current);

      if (!parent) {
        // First time the file appears — all keys are community-authored
        for (const [key, value] of Object.entries(currentFlat)) {
          communityKeys.set(key, {
            value,
            author: commit.email,
            commit: commit.hash.substring(0, 7),
            message: commit.message,
          });
        }
      } else {
        // Diff against parent to find keys changed in this commit
        const parentFlat = flattenObject(parent);
        for (const [key, value] of Object.entries(currentFlat)) {
          if (!(key in parentFlat) || !deepEqual(parentFlat[key], value)) {
            communityKeys.set(key, {
              value,
              author: commit.email,
              commit: commit.hash.substring(0, 7),
              message: commit.message,
            });
          }
        }
      }
    }
  }

  return communityKeys;
}

// ── Main logic ─────────────────────────────────────────────────────────

function main() {
  console.log(`\n🔧 Restore Manual Translations`);
  console.log(
    `   Mode: ${DRY_RUN ? "DRY RUN (use --apply to write)" : "APPLY"}\n`
  );

  // 1. Ensure translations remote is available
  ensureTranslationsRemote();
  console.log();

  // 2. Load en.json: compare translations repo version vs working tree
  //    to detect English source changes
  const enTranslations = loadJsonFromGit(TRANSLATIONS_BRANCH, "en.json");
  const enWork = loadJsonFile(path.join(localesDir, "en.json"));

  if (!enTranslations || !enWork) {
    console.error("❌ Could not load en.json.");
    process.exit(1);
  }

  const enTransFlat = flattenObject(enTranslations);
  const enWorkFlat = flattenObject(enWork);

  // Build set of English keys that changed between translations repo and
  // working tree
  const enChangedKeys = new Set();
  const allEnKeys = new Set([
    ...Object.keys(enTransFlat),
    ...Object.keys(enWorkFlat),
  ]);
  for (const key of allEnKeys) {
    if (key in enTransFlat && key in enWorkFlat) {
      if (!deepEqual(enTransFlat[key], enWorkFlat[key])) {
        enChangedKeys.add(key);
      }
    }
    if (!(key in enTransFlat) || !(key in enWorkFlat)) {
      enChangedKeys.add(key);
    }
  }

  if (VERBOSE) {
    console.log(
      `   English keys changed (translations repo → working tree): ${enChangedKeys.size}`
    );
    for (const k of enChangedKeys) console.log(`     ▸ ${k}`);
    console.log();
  }

  // 3. Get all locale JSON files in the working tree
  const localeFiles = fs
    .readdirSync(localesDir)
    .filter((f) => f.endsWith(".json") && f !== "en.json");

  let totalRestored = 0;
  let totalKeptNew = 0;
  let totalSkippedEnChanged = 0;
  let totalFilesChanged = 0;

  for (const fileName of localeFiles) {
    const locale = path.basename(fileName, ".json");
    const fullPath = path.join(localesDir, fileName);

    // 4. Build the community translation map from the translations repo
    const communityKeys = buildCommunityTranslations(fileName);

    if (communityKeys.size === 0) {
      if (VERBOSE) console.log(`   ⏩ ${locale}: no community translations found.`);
      continue;
    }

    // 5. Load the current working tree version
    const workObj = loadJsonFile(fullPath);
    const workFlat = flattenObject(workObj);

    const result = deepClone(workObj);
    let restored = 0;
    let skippedEnChanged = 0;

    // 6. For each community-authored key, check if it needs restoring
    for (const [key, info] of communityKeys) {
      if (!(key in workFlat)) {
        // Key doesn't exist in working tree (removed) — skip
        continue;
      }

      const workVal = workFlat[key];

      if (deepEqual(workVal, info.value)) {
        // Already has the community value — nothing to do
        continue;
      }

      // Community value differs from working tree. Should we restore?
      if (enChangedKeys.has(key)) {
        // English source changed — keep the new automated translation
        skippedEnChanged++;
        if (VERBOSE) {
          console.log(`   ✅ ${locale} | KEEP (en changed): ${key}`);
          console.log(
            `      community: ${JSON.stringify(info.value)} (by ${info.author})`
          );
          console.log(`      current:   ${JSON.stringify(workVal)}`);
        }
      } else {
        // English source unchanged — restore community translation
        setNestedValue(result, key, info.value);
        restored++;
        if (VERBOSE) {
          console.log(`   🔄 ${locale} | RESTORE: ${key}`);
          console.log(`      community: ${JSON.stringify(info.value)}`);
          console.log(`      current:   ${JSON.stringify(workVal)}`);
          console.log(
            `      author:    ${info.author} (${info.commit}: ${info.message})`
          );
        }
      }
    }

    if (restored > 0 || VERBOSE) {
      console.log(
        `   📄 ${locale}.json: ${restored} restored, ${skippedEnChanged} kept (en changed), ${communityKeys.size} community keys tracked`
      );
    }

    totalRestored += restored;
    totalSkippedEnChanged += skippedEnChanged;
    if (restored > 0) totalFilesChanged++;

    if (APPLY && restored > 0) {
      fs.writeFileSync(
        fullPath,
        JSON.stringify(result, null, 4) + "\n",
        "utf8"
      );
    }
  }

  console.log(`\n   ════════════════════════════════════════════════════`);
  console.log(
    `   Total: ${totalRestored} restored across ${totalFilesChanged} file(s), ${totalSkippedEnChanged} kept (en changed)`
  );
  if (DRY_RUN) {
    console.log(`\n   This was a dry run. Use --apply to write changes.\n`);
  } else {
    console.log(`\n   ✅ All files updated.\n`);
  }
}

main();
