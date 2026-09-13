#!/usr/bin/env bun

import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";

type Coordinate = { group: string; module: string; version: string };

const repositories = [
  "https://dl.google.com/dl/android/maven2",
  "https://repo1.maven.org/maven2",
];
const workers = Number(process.env.AGP_SOURCE_WORKERS ?? "24");
const [version, output, cache, manifest] = process.argv.slice(2);

if (!version || !output || !cache || !manifest) {
  console.error("usage: resolve_allowed_sources.ts <agp-version> <output> <cache> <manifest>");
  process.exit(2);
}

const allowed = (group: string) =>
  group === "com.android.tools" || group.startsWith("com.android.tools.");
const key = (item: Coordinate) => `${item.group}:${item.module}:${item.version}`;
const moduleKey = (item: Coordinate) => `${item.group}:${item.module}`;
const versionOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const newer = (left: Coordinate, right: Coordinate) =>
  versionOrder.compare(left.version, right.version) >= 0 ? left : right;
const url = (repository: string, item: Coordinate, suffix: string) =>
  `${repository}/${item.group.replaceAll(".", "/")}/${item.module}/${item.version}/${item.module}-${item.version}${suffix}`;

async function fetchOptional(target: string): Promise<Response | null> {
  const response = await fetch(target);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.status} ${target}`);
  return response;
}

async function fetchArtifact(item: Coordinate, suffix: string): Promise<Response | null> {
  for (const repository of repositories) {
    const response = await fetchOptional(url(repository, item, suffix));
    if (response) return response;
  }
  return null;
}

function moduleDependencies(metadata: any): Coordinate[] {
  const variants = metadata.variants ?? [];
  const variant = variants.find((it: any) => it.name === "runtimeElements") ??
    variants.find((it: any) =>
      it.attributes?.["org.gradle.usage"] === "java-runtime" &&
      (it.attributes?.["org.gradle.category"] ?? "library") === "library");
  if (!variant) return [];
  return (variant.dependencies ?? []).flatMap((dependency: any) => {
    const group = dependency.group ?? "";
    const spec = dependency.version ?? {};
    const dependencyVersion = spec.strictly ?? spec.requires ?? spec.prefers;
    return allowed(group) && dependencyVersion
      ? [{ group, module: dependency.module, version: dependencyVersion }]
      : [];
  });
}

function pomDependencies(xml: string): Coordinate[] {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error(`invalid POM XML: ${validation.err.msg}`);
  const project = new XMLParser({ parseTagValue: false, trimValues: true }).parse(xml)?.project;
  if (!project) throw new Error("invalid POM: missing project element");
  const properties: Record<string, string> = project.properties ?? {};
  const nodes = project.dependencies?.dependency ?? [];
  const dependencyNodes = Array.isArray(nodes) ? nodes : [nodes];
  const result: Coordinate[] = [];
  for (const dependency of dependencyNodes) {
    const group = dependency.groupId ?? "";
    const module = dependency.artifactId;
    let dependencyVersion = dependency.version ?? null;
    const scope = dependency.scope ?? "compile";
    if (dependencyVersion?.startsWith("${") && dependencyVersion.endsWith("}")) {
      dependencyVersion = properties[dependencyVersion.slice(2, -1)] ?? null;
    }
    if (allowed(group) && module && dependencyVersion && scope !== "test" && scope !== "provided" &&
        dependency.optional !== "true") {
      result.push({ group, module, version: dependencyVersion });
    }
  }
  return result;
}

async function dependencies(item: Coordinate): Promise<Coordinate[]> {
  const moduleResponse = await fetchArtifact(item, ".module");
  if (moduleResponse) return moduleDependencies(await moduleResponse.json());
  const pomResponse = await fetchArtifact(item, ".pom");
  if (!pomResponse) throw new Error(`metadata not found: ${key(item)}`);
  return pomDependencies(await pomResponse.text());
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

async function resolve(): Promise<Coordinate[]> {
  const root = { group: "com.android.tools.build", module: "gradle", version };
  const dependencyCache = new Map<string, Promise<Coordinate[]>>();
  const dependenciesCached = (item: Coordinate) => {
    const coordinate = key(item);
    let pending = dependencyCache.get(coordinate);
    if (!pending) {
      pending = dependencies(item);
      dependencyCache.set(coordinate, pending);
    }
    return pending;
  };

  // Gradle resolves one version per group:module. Recompute reachability until
  // version selection stabilizes so dependencies of an evicted version vanish.
  let selected = new Map([[moduleKey(root), root]]);
  for (let iteration = 0; iteration < 32; iteration++) {
    const discovered = new Map<string, Coordinate>([[moduleKey(root), root]]);
    let frontier = [root];
    const visited = new Set<string>();
    while (frontier.length) {
      const current = frontier
        .map((item) => selected.get(moduleKey(item)) ?? discovered.get(moduleKey(item)) ?? item)
        .filter((item) => !visited.has(key(item)));
      current.forEach((item) => visited.add(key(item)));
      if (!current.length) break;
      const nested = await mapLimit(current, workers, dependenciesCached);
      frontier = [];
      for (const dependency of nested.flat()) {
        const id = moduleKey(dependency);
        const candidate = selected.has(id) ? newer(selected.get(id)!, dependency) : dependency;
        const existing = discovered.get(id);
        const winner = existing ? newer(existing, candidate) : candidate;
        if (!existing || key(existing) !== key(winner)) {
          discovered.set(id, winner);
          frontier.push(winner);
        }
      }
    }
    const before = [...selected.values()].map(key).sort().join("\n");
    const after = [...discovered.values()].map(key).sort().join("\n");
    selected = discovered;
    if (before === after) return [...selected.values()].sort((a, b) => key(a).localeCompare(key(b)));
  }
  throw new Error("dependency conflict resolution did not converge");
}

async function sourceJar(item: Coordinate): Promise<string | null> {
  const target = join(cache, item.group, item.module, item.version, `${item.module}-${item.version}-sources.jar`);
  if (!(await Bun.file(target).exists())) {
    const response = await fetchArtifact(item, "-sources.jar");
    if (!response) return null;
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, response);
  }
  return target;
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const coordinates = await resolve();
const jars = await mapLimit(coordinates, workers, sourceJar);
const present: string[] = [];
await mapLimit(coordinates, 8, async (item) => {
  const jar = jars[coordinates.indexOf(item)];
  if (!jar) return;
  present.push(key(item));
  const destination = join(output, item.group, item.module);
  await mkdir(destination, { recursive: true });
  const process = Bun.spawn(["unzip", "-oq", jar, "-d", destination], { stdout: "ignore", stderr: "pipe" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`unzip failed for ${key(item)}: ${await new Response(process.stderr).text()}`);
});

for (const pattern of ["*.RSA", "*.SF", "*.so", "*.dll", "*.dylib"]) {
  const process = Bun.spawn(["find", output, "-type", "f", "-name", pattern, "-delete"]);
  if (await process.exited !== 0) throw new Error(`failed to remove ${pattern}`);
}
await mkdir(dirname(manifest), { recursive: true });
await Bun.write(manifest, JSON.stringify({
  agp: version,
  allowlist: ["com.android.tools", "com.android.tools.*"],
  artifacts: coordinates.map((item) => ({ coordinate: key(item), sources: present.includes(key(item)) })),
}, null, 2) + "\n");
console.log(`${version}: ${coordinates.length} allowed components, ${present.length} source JARs`);
