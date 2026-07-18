// Pure file-planning helpers for the migration system: numbering, listing,
// header-marker detection, and filename generation. No DB access.

import { existsSync, readdirSync } from 'node:fs';

const NUMBERED_FILE_RE = /^(\d+)_/;
const DESTRUCTIVE_MARKER = '-- supaorm:destructive';
const NO_TRANSACTION_MARKER = '-- NO TRANSACTION';

/**
 * Computes the next 3-digit (minimum-width) zero-padded migration number for
 * a migrations directory, based on the highest existing `NNN_*.sql` prefix.
 * Returns '001' if the directory is missing or has no numbered files.
 */
export function getNextMigrationNumber(migrationsDir: string): string {
  if (!existsSync(migrationsDir)) return '001';

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  let max = 0;
  for (const file of files) {
    const match = NUMBERED_FILE_RE.exec(file);
    if (!match) continue;
    const num = parseInt(match[1], 10);
    if (num > max) max = num;
  }

  return String(max + 1).padStart(3, '0');
}

/**
 * Lists `.sql` migration files in a directory, sorted by filename (which
 * sorts numerically since numbers are zero-padded). Returns [] if the
 * directory doesn't exist.
 *
 * Throws a descriptive error if two files share the same numeric prefix —
 * that's an ambiguous ordering that must be fixed before migrations can run.
 */
export function listMigrationFiles(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) return [];

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const seenByNumber = new Map<string, string>();
  for (const file of files) {
    const match = NUMBERED_FILE_RE.exec(file);
    if (!match) continue;
    const number = match[1];
    const existing = seenByNumber.get(number);
    if (existing) {
      throw new Error(
        `Duplicate migration number "${number}" in ${migrationsDir}: ` +
          `"${existing}" and "${file}". Renumber one of them before running migrations.`
      );
    }
    seenByNumber.set(number, file);
  }

  return files;
}

/**
 * True if the file's first non-empty line is the destructive marker
 * (`-- supaorm:destructive`). Destructive migrations are skipped by the
 * runner unless explicitly forced.
 */
export function hasDestructiveMarker(fileContent: string): boolean {
  return firstNonEmptyLine(fileContent) === DESTRUCTIVE_MARKER;
}

/**
 * True if the file's first non-empty line is the `-- NO TRANSACTION` header,
 * the convention used to mark enum-altering migrations, which Postgres
 * requires to run outside a transaction — and therefore statement-by-statement
 * rather than as one atomic exec call.
 */
export function isEnumMigration(fileContent: string): boolean {
  return firstNonEmptyLine(fileContent) === NO_TRANSACTION_MARKER;
}

/** Builds a migration filename: `{number}_{slugified label}.sql`. */
export function migrationFileName(number: string, label: string): string {
  return `${number}_${slugify(label)}.sql`;
}

function firstNonEmptyLine(content: string): string | null {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length > 0) return line;
  }
  return null;
}

function slugify(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'migration';
}
