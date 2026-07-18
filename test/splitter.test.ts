import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../src/migrate/splitter.js';

describe('splitSqlStatements', () => {
  it('splits on plain semicolons', () => {
    const sql = `CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);`;
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE a (id INT);',
      'CREATE TABLE b (id INT);',
    ]);
  });

  it('keeps a $$-quoted body with internal semicolons as one statement', () => {
    const sql = `
CREATE FUNCTION foo() RETURNS trigger AS $$
BEGIN
  NEW.x = 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('NEW.x = 1;');
    expect(statements[0]).toContain('RETURN NEW;');
    expect(statements[0].trim().endsWith('LANGUAGE plpgsql;')).toBe(true);
  });

  it('handles tagged dollar quotes ($mig$, $fn$) and distinguishes different tags', () => {
    const sql = `
CREATE FUNCTION a() RETURNS void AS $mig$
  -- mentions $fn$ as plain text, not a real tag here
  SELECT 1;
$mig$ LANGUAGE sql;

CREATE FUNCTION b() RETURNS void AS $fn$
  SELECT 2;
$fn$ LANGUAGE sql;
`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('$mig$');
    expect(statements[0]).toContain('$fn$ as plain text');
    expect(statements[0].trim().endsWith('$mig$ LANGUAGE sql;')).toBe(true);
    expect(statements[1]).toContain('$fn$');
    expect(statements[1].trim().endsWith('$fn$ LANGUAGE sql;')).toBe(true);
  });

  it('does not close a dollar-quoted body on an unrelated tag inside it', () => {
    const sql = `CREATE FUNCTION a() RETURNS void AS $outer$ SELECT '$inner$'; $outer$ LANGUAGE sql;`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toBe(sql);
  });

  it('does not split on a semicolon inside a line comment', () => {
    const sql = `-- this comment; has a semicolon\nCREATE TABLE a (id INT);`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('-- this comment; has a semicolon');
    expect(statements[0]).toContain('CREATE TABLE a (id INT);');
  });

  it('preserves comment-only lines attached to the statement that follows', () => {
    const sql = `-- describes the next statement\n-- second comment line\nCREATE TABLE a (id INT);`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toBe(
      '-- describes the next statement\n-- second comment line\nCREATE TABLE a (id INT);'
    );
  });

  it('does not split on a semicolon inside a comment within a multi-line statement', () => {
    const sql = `CREATE TABLE a (\n  id INT, -- primary key; not a terminator\n  name TEXT\n);`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('-- primary key; not a terminator');
    expect(statements[0].trim().endsWith(');')).toBe(true);
  });

  it('includes a trailing statement with no terminating semicolon', () => {
    const sql = `CREATE TABLE a (id INT);\nCREATE TABLE b (id INT)`;
    const statements = splitSqlStatements(sql);
    expect(statements).toEqual(['CREATE TABLE a (id INT);', 'CREATE TABLE b (id INT)']);
  });

  it('returns [] for empty input', () => {
    expect(splitSqlStatements('')).toEqual([]);
  });

  it('returns [] for whitespace-only input', () => {
    expect(splitSqlStatements('   \n\n   ')).toEqual([]);
  });

  it('returns [] for comment-only input', () => {
    const sql = `-- just a comment\n-- another comment, no SQL at all\n`;
    expect(splitSqlStatements(sql)).toEqual([]);
  });

  it('drops a trailing comment-only remainder after the last real statement', () => {
    const sql = `CREATE TABLE a (id INT);\n-- trailing comment, nothing follows\n`;
    const statements = splitSqlStatements(sql);
    expect(statements).toEqual(['CREATE TABLE a (id INT);']);
  });

  it('handles multiple statements mixing dollar quotes, comments, and plain SQL', () => {
    const sql = `
-- first table
CREATE TABLE a (id INT);

-- trigger function
CREATE OR REPLACE FUNCTION touch() RETURNS trigger AS $$
BEGIN
  -- bump updated_at; no split here
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER touch_a BEFORE UPDATE ON a FOR EACH ROW EXECUTE FUNCTION touch();
`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('CREATE TABLE a (id INT);');
    expect(statements[1]).toContain('NEW.updated_at = NOW();');
    expect(statements[1].trim().endsWith('LANGUAGE plpgsql;')).toBe(true);
    expect(statements[2]).toBe(
      'CREATE TRIGGER touch_a BEFORE UPDATE ON a FOR EACH ROW EXECUTE FUNCTION touch();'
    );
  });
});
