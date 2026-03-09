import { LibSQLStore } from '@mastra/libsql';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve relative to this file (src/mastra/storage.ts) so the DB always lands
// at the project root — stable regardless of what process.cwd() is at runtime.
const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DB_URL = process.env.DATABASE_URL ?? `file:${resolve(PROJECT_ROOT, 'mastra.db')}`;

export const storage = new LibSQLStore({
  id: 'mastra-storage',
  url: DB_URL,
});
