#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";

const metadataUrl = "https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml";
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(\d+))?$/;
const qualifierOrder: Record<string, number> = { alpha: 0, beta: 1, rc: 2, stable: 3 };

function versionKey(version: string): number[] {
  const match = version.match(versionPattern);
  if (!match) throw new Error(`Invalid AGP version: ${version}`);
  return [+match[1], +match[2], +match[3], qualifierOrder[match[4] ?? "stable"], +(match[5] ?? 0)];
}

function compareVersions(left: string, right: string) {
  const a = versionKey(left);
  const b = versionKey(right);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

let baseline = "3.0.0-alpha1";
let stateFile = ".agp-version";
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--baseline") baseline = process.argv[++i];
  else if (process.argv[i] === "--state-file") stateFile = process.argv[++i];
  else throw new Error(`Unknown argument: ${process.argv[i]}`);
}

const current = existsSync(stateFile) ? readFileSync(stateFile, "utf8").trim() : null;
const lowerBound = current ?? baseline;
const response = await fetch(metadataUrl);
if (!response.ok) throw new Error(`${response.status} ${metadataUrl}`);
const xml = await response.text();
const versions = [...new Set([...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]))]
  .filter((version) => versionPattern.test(version))
  .filter((version) => compareVersions(version, lowerBound) > 0 || (!current && compareVersions(version, lowerBound) === 0))
  .sort(compareVersions);
console.log(versions.join(" "));
