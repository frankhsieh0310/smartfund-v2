import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type DurableArchiveInput = {
  localPath: string;
  logicalPath: string;
  contentType: string;
  sourceDocumentId?: string | null;
  sourceUpdatedAt?: string | null;
  fetchedAt?: string | null;
};

export type DurableArchiveEntry = {
  logicalPath: string;
  objectPath: string;
  contentHash: string;
  byteLength: number;
  contentType: string;
  sourceDocumentId: string | null;
  sourceUpdatedAt: string | null;
  fetchedAt: string | null;
  parserVersion: string;
  previousContentHash: string | null;
  archivedAt: string;
};

export type DurableArchiveManifest = {
  formatVersion: 1;
  runId: string;
  sourceNamespace: string;
  parserVersion: string;
  createdAt: string;
  entries: DurableArchiveEntry[];
};

export type DurableArchiveResult = {
  root: string;
  prefix: string;
  manifestPath: string;
  manifestHash: string;
  entries: number;
  objectsCreated: number;
  objectsReused: number;
  supersededRelations: number;
};

export type DurableArchiveReplayResult = {
  status: "PASS";
  manifestPath: string;
  manifestHash: string;
  verifiedObjects: number;
  verifiedBytes: number;
  jsonDocumentsParsed: number;
};

type LogicalIndex = {
  logicalPath: string;
  currentContentHash: string;
  versions: Array<{
    contentHash: string;
    objectPath: string;
    previousContentHash: string | null;
    archivedAt: string;
    runId: string;
  }>;
};

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelative(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`DURABLE_ARCHIVE_LOGICAL_PATH_INVALID:${value}`);
  }
  return normalized;
}

function indexFilename(logicalPath: string): string {
  return `${createHash("sha256").update(logicalPath).digest("hex")}.json`;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(filePath: string, value: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeContentAddressed(filePath: string, content: Uint8Array, expectedHash: string): Promise<"CREATED" | "REUSED"> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    const handle = await open(filePath, "wx");
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    return "CREATED";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(filePath);
    const actualHash = sha256(existing);
    if (actualHash !== expectedHash) throw new Error(`DURABLE_ARCHIVE_HASH_COLLISION:${filePath}:${actualHash}:${expectedHash}`);
    return "REUSED";
  }
}

async function retry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export class DurableFileArchive {
  readonly root: string;
  readonly prefix: string;

  constructor(options: { root: string; prefix: string }) {
    if (!options.root.trim()) throw new Error("DURABLE_ARCHIVE_ROOT_REQUIRED");
    this.root = path.resolve(options.root);
    this.prefix = safeRelative(options.prefix);
  }

  private absolute(relativePath: string): string {
    const resolved = path.resolve(this.root, this.prefix, safeRelative(relativePath));
    const boundary = `${path.resolve(this.root, this.prefix)}${path.sep}`;
    if (!resolved.startsWith(boundary)) throw new Error(`DURABLE_ARCHIVE_PATH_ESCAPE:${relativePath}`);
    return resolved;
  }

  async archiveRun(input: {
    runId: string;
    sourceNamespace: string;
    parserVersion: string;
    files: DurableArchiveInput[];
  }): Promise<DurableArchiveResult> {
    if (!input.runId.trim()) throw new Error("DURABLE_ARCHIVE_RUN_ID_REQUIRED");
    if (!input.files.length) throw new Error("DURABLE_ARCHIVE_FILES_REQUIRED");
    const archivedAt = new Date().toISOString();
    const entries: DurableArchiveEntry[] = [];
    let objectsCreated = 0;
    let objectsReused = 0;
    let supersededRelations = 0;

    for (const file of input.files) {
      const logicalPath = safeRelative(file.logicalPath);
      const content = await readFile(file.localPath);
      const contentHash = sha256(content);
      const objectRelative = `objects/sha256/${contentHash.slice(0, 2)}/${contentHash}.bin`;
      const outcome = await retry(() => writeContentAddressed(this.absolute(objectRelative), content, contentHash));
      if (outcome === "CREATED") objectsCreated += 1;
      else objectsReused += 1;

      const indexRelative = `indexes/${indexFilename(logicalPath)}`;
      const indexPath = this.absolute(indexRelative);
      const prior = await readJson<LogicalIndex>(indexPath);
      const previousContentHash = prior?.currentContentHash && prior.currentContentHash !== contentHash
        ? prior.currentContentHash
        : null;
      if (previousContentHash) supersededRelations += 1;
      const version = {
        contentHash,
        objectPath: objectRelative,
        previousContentHash,
        archivedAt,
        runId: input.runId,
      };
      const versions = prior?.versions ?? [];
      const nextIndex: LogicalIndex = {
        logicalPath,
        currentContentHash: contentHash,
        versions: versions.some((item) => item.contentHash === contentHash) ? versions : [...versions, version],
      };
      await retry(() => atomicWrite(indexPath, Buffer.from(`${JSON.stringify(nextIndex, null, 2)}\n`, "utf8")));
      entries.push({
        logicalPath,
        objectPath: objectRelative,
        contentHash,
        byteLength: content.byteLength,
        contentType: file.contentType,
        sourceDocumentId: file.sourceDocumentId ?? null,
        sourceUpdatedAt: file.sourceUpdatedAt ?? null,
        fetchedAt: file.fetchedAt ?? null,
        parserVersion: input.parserVersion,
        previousContentHash,
        archivedAt,
      });
    }

    const manifest: DurableArchiveManifest = {
      formatVersion: 1,
      runId: input.runId,
      sourceNamespace: input.sourceNamespace,
      parserVersion: input.parserVersion,
      createdAt: archivedAt,
      entries,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const manifestHash = sha256(manifestBytes);
    const manifestRelative = `manifests/${input.runId}.json`;
    await retry(() => atomicWrite(this.absolute(manifestRelative), manifestBytes));
    await retry(() => atomicWrite(this.absolute(`${manifestRelative}.sha256`), Buffer.from(`${manifestHash}\n`, "utf8")));
    return {
      root: this.root,
      prefix: this.prefix,
      manifestPath: manifestRelative,
      manifestHash,
      entries: entries.length,
      objectsCreated,
      objectsReused,
      supersededRelations,
    };
  }

  async restoreAndReplay(manifestRelativePath: string): Promise<DurableArchiveReplayResult> {
    const manifestPath = this.absolute(manifestRelativePath);
    const bytes = await readFile(manifestPath);
    const expectedManifestHash = (await readFile(`${manifestPath}.sha256`, "utf8")).trim();
    const manifestHash = sha256(bytes);
    if (manifestHash !== expectedManifestHash) {
      throw new Error(`DURABLE_ARCHIVE_MANIFEST_CHECKSUM_MISMATCH:${manifestHash}:${expectedManifestHash}`);
    }
    const manifest = JSON.parse(bytes.toString("utf8")) as DurableArchiveManifest;
    let verifiedBytes = 0;
    let jsonDocumentsParsed = 0;
    for (const entry of manifest.entries) {
      const object = await readFile(this.absolute(entry.objectPath));
      const actualHash = sha256(object);
      if (actualHash !== entry.contentHash) {
        throw new Error(`DURABLE_ARCHIVE_OBJECT_CHECKSUM_MISMATCH:${entry.objectPath}:${actualHash}:${entry.contentHash}`);
      }
      if (object.byteLength !== entry.byteLength) {
        throw new Error(`DURABLE_ARCHIVE_OBJECT_LENGTH_MISMATCH:${entry.objectPath}:${object.byteLength}:${entry.byteLength}`);
      }
      if (entry.contentType.includes("json")) {
        JSON.parse(object.toString("utf8"));
        jsonDocumentsParsed += 1;
      }
      verifiedBytes += object.byteLength;
    }
    return {
      status: "PASS",
      manifestPath: manifestRelativePath,
      manifestHash,
      verifiedObjects: manifest.entries.length,
      verifiedBytes,
      jsonDocumentsParsed,
    };
  }
}
