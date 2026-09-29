#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.equal(manifest.name, "@postman/postman-pi");
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.ok(manifest.keywords.includes("pi-package"), "keywords must include pi-package");
assert.deepEqual(manifest.pi?.skills, ["./skills"]);
assert.deepEqual(manifest.files, ["skills/"]);
assert.equal(manifest.publishConfig?.access, "public");

const skillDirectories = fs
  .readdirSync(path.join(root, "skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name)
  .sort();

assert.ok(skillDirectories.length > 0, "package must contain at least one skill");
for (const skill of skillDirectories) {
  assert.ok(
    fs.existsSync(path.join(root, "skills", skill, "SKILL.md")),
    `skills/${skill} must contain SKILL.md`,
  );
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
});

if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.exit(packed.status ?? 1);
}

const result = JSON.parse(packed.stdout)[0];
const packedFiles = new Set(result.files.map(({ path: file }) => file));

for (const skill of skillDirectories) {
  assert.ok(
    packedFiles.has(`skills/${skill}/SKILL.md`),
    `tarball is missing skills/${skill}/SKILL.md`,
  );
}

const allowedRoots = ["LICENSE", "README.md", "package.json", "skills/"];
for (const file of packedFiles) {
  assert.ok(
    allowedRoots.some((allowed) => file === allowed || file.startsWith(allowed)),
    `unexpected file in Pi package: ${file}`,
  );
}

console.log(`Pi package is ready: ${skillDirectories.length} skills, ${packedFiles.size} files.`);
