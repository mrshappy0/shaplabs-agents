/**
 * Pending review-first container state for Discord approval buttons.
 *
 * Stored as a JSON file alongside mastra.db — no extra DB driver needed.
 * Entries expire after 24 hours via pruneExpired().
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve relative to this file (src/mastra/tools/) → 3 levels up = project root.
// This is stable regardless of what process.cwd() is at runtime (mastra dev changes it).
const PROJECT_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const STORE_PATH = process.env.DISCORD_PENDING_PATH ?? resolve(PROJECT_ROOT, 'discord-pending.json');

export interface PendingContainer {
  containerName: string;
  currentVersion: string;
  latestVersion: string;
  warnings: string[];
}

interface PendingEntry {
  channelId: string;
  containers: PendingContainer[];
  createdAt: number;
}

type Store = Record<string, PendingEntry>;

function readStore(): Store {
  if (!existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8')) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/** Save review-first containers awaiting Discord approval. */
export function savePending(
  runId: string,
  channelId: string,
  containers: PendingContainer[],
): void {
  const store = readStore();
  store[runId] = { channelId, containers, createdAt: Date.now() };
  writeStore(store);
}

/** Retrieve pending containers for a runId. Returns null if not found. */
export function getPending(
  runId: string,
): { channelId: string; containers: PendingContainer[] } | null {
  const store = readStore();
  const entry = store[runId];
  if (!entry) return null;
  return { channelId: entry.channelId, containers: entry.containers };
}

/** Delete pending state after it has been consumed. */
export function deletePending(runId: string): void {
  const store = readStore();
  delete store[runId];
  writeStore(store);
}

/** Remove entries older than 24 hours. */
export function pruneExpired(): void {
  const store = readStore();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [runId, entry] of Object.entries(store)) {
    if (entry.createdAt < cutoff) {
      delete store[runId];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

/**
 * Remove one container from a pending run after it has been applied via a
 * single-container button click. Deletes the entire entry when no containers
 * remain so that a subsequent "Apply All" click sees an empty/missing run.
 */
export function removeContainerFromPending(runId: string, containerName: string): void {
  const store = readStore();
  const entry = store[runId];
  if (!entry) return;
  entry.containers = entry.containers.filter(c => c.containerName !== containerName);
  if (entry.containers.length === 0) {
    delete store[runId];
  }
  writeStore(store);
}
