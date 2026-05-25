#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == undefined) {
      throw new Error(`Invalid arguments near ${key ?? "<end>"}`);
    }
    args.set(key.slice(2), value);
  }
  return args;
}

function parsePackageName(name) {
  const match = /^@([^/]+)\/(.+)$/u.exec(name);
  if (match == undefined) {
    return { name };
  }
  return { namespace: match[1], name: match[2] };
}

function getExtensionId(pkg) {
  const packageName = parsePackageName(pkg.name);
  const publisher = pkg.publisher ?? packageName.namespace;
  if (publisher == undefined || publisher.length === 0) {
    throw new Error("package.json is missing required publisher field");
  }
  return `${publisher.toLowerCase().replace(/\W+/gu, "")}.${packageName.name.toLowerCase()}`;
}

function rawGithubUrl(homepage, filename) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/?#]+)\/?$/u.exec(homepage);
  if (match == undefined) {
    throw new Error(`Unable to infer raw ${filename} URL from homepage: ${homepage}`);
  }
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main/${filename}`;
}

function registryEntry(pkg, foxeUrl, sha256sum) {
  return {
    id: getExtensionId(pkg),
    name: pkg.displayName ?? pkg.name,
    description: pkg.description,
    publisher: pkg.publisher,
    homepage: pkg.homepage,
    readme: rawGithubUrl(pkg.homepage, "README.md"),
    changelog: rawGithubUrl(pkg.homepage, "CHANGELOG.md"),
    license: pkg.license,
    version: pkg.version,
    sha256sum,
    foxe: foxeUrl,
    keywords: pkg.keywords ?? [],
  };
}

function updateExtensionsJson(registryDir, entry) {
  const extensionsPath = path.join(registryDir, "extensions.json");
  const extensions = readJson(extensionsPath);
  const existingIndex = extensions.findIndex((extension) => extension.id === entry.id);
  if (existingIndex === -1) {
    extensions.push(entry);
  } else {
    extensions[existingIndex] = entry;
  }
  fs.writeFileSync(extensionsPath, `${JSON.stringify(extensions, undefined, 2)}\n`);
}

function readmeBullet(entry) {
  return `- [${entry.name}](${entry.homepage}) - ${entry.description}`;
}

function bulletLabel(line) {
  return /^- \[([^\]]+)\]/u.exec(line)?.[1]?.toLocaleLowerCase() ?? line.toLocaleLowerCase();
}

function updateReadme(registryDir, entry) {
  const readmePath = path.join(registryDir, "README.md");
  const lines = fs.readFileSync(readmePath, "utf8").split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => line.trim() === "# Extensions");
  if (headingIndex === -1) {
    throw new Error("Unable to find '# Extensions' heading in registry README.md");
  }

  const nextHeadingIndex = lines.findIndex(
    (line, index) => index > headingIndex && line.startsWith("#"),
  );
  const sectionEnd = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  const before = lines.slice(0, headingIndex + 1);
  const after = nextHeadingIndex === -1 ? [] : lines.slice(nextHeadingIndex);
  const bullet = readmeBullet(entry);
  const bullets = lines
    .slice(headingIndex + 1, sectionEnd)
    .filter((line) => line.startsWith("- ["))
    .filter((line) => !line.includes(`](${entry.homepage})`) && !line.startsWith(`- [${entry.name}](`));

  bullets.push(bullet);
  bullets.sort((left, right) => bulletLabel(left).localeCompare(bulletLabel(right)));

  const nextLines = [...before, "", ...bullets];
  if (after.length > 0) {
    nextLines.push("", ...after);
  }
  fs.writeFileSync(readmePath, `${nextLines.join("\n").replace(/\n+$/u, "")}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryDir = args.get("registry-dir");
  const foxeUrl = args.get("foxe-url");
  const sha256sum = args.get("sha256");
  if (registryDir == undefined || foxeUrl == undefined || sha256sum == undefined) {
    throw new Error("Usage: update-extension-registry.js --registry-dir <path> --foxe-url <url> --sha256 <sha256>");
  }

  const pkg = readJson(path.join(process.cwd(), "package.json"));
  const entry = registryEntry(pkg, foxeUrl, sha256sum);
  updateExtensionsJson(registryDir, entry);
  updateReadme(registryDir, entry);
  console.log(`Updated registry entry ${entry.id} ${entry.version}`);
}

main();
