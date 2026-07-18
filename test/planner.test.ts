import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  getNextMigrationNumber,
  listMigrationFiles,
  hasDestructiveMarker,
  isEnumMigration,
  migrationFileName,
} from '../src/migrate/planner.js';

describe('planner', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'supaorm-planner-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content = '-- noop') => writeFileSync(path.join(dir, name), content);

  describe('getNextMigrationNumber', () => {
    it('returns 001 for an empty directory', () => {
      expect(getNextMigrationNumber(dir)).toBe('001');
    });

    it('returns 001 for a directory that does not exist', () => {
      expect(getNextMigrationNumber(path.join(dir, 'nope'))).toBe('001');
    });

    it('returns max + 1, zero-padded', () => {
      write('001_init.sql');
      write('002_add_col.sql');
      expect(getNextMigrationNumber(dir)).toBe('003');
    });

    it('handles gaps in numbering by taking the max, not the count', () => {
      write('001_init.sql');
      write('005_skip_ahead.sql');
      expect(getNextMigrationNumber(dir)).toBe('006');
    });

    it('rolls from 2-digit to 3-digit representation without truncation', () => {
      write('099_last_two_digit.sql');
      expect(getNextMigrationNumber(dir)).toBe('100');
    });

    it('ignores non-.sql and non-numbered files', () => {
      write('001_init.sql');
      write('README.md');
      write('notes.txt');
      expect(getNextMigrationNumber(dir)).toBe('002');
    });
  });

  describe('listMigrationFiles', () => {
    it('returns [] for a missing directory', () => {
      expect(listMigrationFiles(path.join(dir, 'nope'))).toEqual([]);
    });

    it('returns .sql files sorted by filename', () => {
      write('002_second.sql');
      write('001_first.sql');
      write('010_tenth.sql');
      expect(listMigrationFiles(dir)).toEqual(['001_first.sql', '002_second.sql', '010_tenth.sql']);
    });

    it('excludes non-.sql files', () => {
      write('001_first.sql');
      write('readme.md');
      expect(listMigrationFiles(dir)).toEqual(['001_first.sql']);
    });

    it('throws a descriptive error on duplicate numeric prefixes', () => {
      write('001_first.sql');
      write('001_duplicate.sql');
      expect(() => listMigrationFiles(dir)).toThrow(/duplicate migration number "001"/i);
      expect(() => listMigrationFiles(dir)).toThrow(/001_first\.sql/);
      expect(() => listMigrationFiles(dir)).toThrow(/001_duplicate\.sql/);
    });
  });

  describe('hasDestructiveMarker', () => {
    it('is true when the first non-empty line is the marker', () => {
      expect(hasDestructiveMarker('-- supaorm:destructive\nDROP TABLE foo;')).toBe(true);
    });

    it('tolerates leading blank lines', () => {
      expect(hasDestructiveMarker('\n\n-- supaorm:destructive\nDROP TABLE foo;')).toBe(true);
    });

    it('is false when the marker is not the first line', () => {
      expect(hasDestructiveMarker('DROP TABLE foo;\n-- supaorm:destructive')).toBe(false);
    });

    it('is false for unrelated content', () => {
      expect(hasDestructiveMarker('CREATE TABLE foo (id INT);')).toBe(false);
    });

    it('is false for empty content', () => {
      expect(hasDestructiveMarker('')).toBe(false);
    });
  });

  describe('isEnumMigration', () => {
    it('is true when the first non-empty line is the NO TRANSACTION header', () => {
      expect(isEnumMigration('-- NO TRANSACTION\nALTER TYPE foo ADD VALUE \'bar\';')).toBe(true);
    });

    it('is false without the header', () => {
      expect(isEnumMigration('ALTER TYPE foo ADD VALUE \'bar\';')).toBe(false);
    });

    it('is false when the header is not the first line', () => {
      expect(isEnumMigration('-- some other comment\n-- NO TRANSACTION\nSELECT 1;')).toBe(false);
    });
  });

  describe('migrationFileName', () => {
    it('slugifies a label', () => {
      expect(migrationFileName('003', 'Add Email Column')).toBe('003_add_email_column.sql');
    });

    it('collapses non-alphanumeric runs into single underscores', () => {
      expect(migrationFileName('001', "  weird---label!! with   spaces ")).toBe(
        '001_weird_label_with_spaces.sql'
      );
    });

    it('falls back to "migration" for a label with no usable characters', () => {
      expect(migrationFileName('001', '###')).toBe('001_migration.sql');
    });
  });
});
