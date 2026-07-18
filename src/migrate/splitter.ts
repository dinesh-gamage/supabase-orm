// Splits a migration file's raw SQL text into individually-executable statements.
//
// Handles:
//   - ';' as the statement terminator
//   - '$$'-style dollar-quoted bodies (function/trigger definitions), including
//     tagged variants ($tag$ ... $tag$) — a different tag encountered while
//     inside an open dollar-quoted body is treated as literal text, never as
//     the closing delimiter (Postgres does not support nested dollar-quoting).
//   - '--' line comments — a ';' inside a comment never splits, and comment
//     text is preserved verbatim, staying attached to whichever statement
//     follows it.
//   - A final statement with no trailing ';'.
//   - Input that contains no real SQL (empty, whitespace-only, or comment-only)
//     resolves to an empty array.

// Matches a dollar-quote tag at the current scan position: `$$` or `$tag$`,
// where `tag` follows Postgres identifier rules (leading letter/underscore,
// then letters/digits/underscores). Anchored + sticky so it only matches
// starting exactly at `lastIndex` — this avoids false positives like
// `$1, $2` (positional parameters), whose interior isn't a valid tag.
const DOLLAR_TAG_RE = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';
  let i = 0;
  const len = sql.length;

  const flush = (terminatedBySemicolon: boolean): void => {
    const trimmed = current.trim();
    current = '';
    if (!trimmed) return;
    if (!hasMeaningfulSql(trimmed)) return;
    statements.push(terminatedBySemicolon ? `${trimmed};` : trimmed);
  };

  while (i < len) {
    const ch = sql[i];

    if (inDollarQuote) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        inDollarQuote = false;
        dollarTag = '';
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    // Not inside a dollar-quoted body — check for the start of one.
    if (ch === '$') {
      DOLLAR_TAG_RE.lastIndex = i;
      const match = DOLLAR_TAG_RE.exec(sql);
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        i += dollarTag.length;
        inDollarQuote = true;
        continue;
      }
    }

    // Line comment — consume through end of line verbatim; semicolons inside
    // don't split, and the comment text stays attached to the statement.
    if (ch === '-' && sql[i + 1] === '-') {
      const nlIdx = sql.indexOf('\n', i);
      const end = nlIdx === -1 ? len : nlIdx + 1;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === ';') {
      flush(true);
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // Trailing statement with no terminating ';'.
  flush(false);

  return statements;
}

// True if `text` contains SQL outside of '--' comments (i.e. it isn't purely
// comment/whitespace). Used to drop comment-only or empty segments.
function hasMeaningfulSql(text: string): boolean {
  return text
    .split('\n')
    .some((line) => stripLineComment(line).trim().length > 0);
}

function stripLineComment(line: string): string {
  const idx = line.indexOf('--');
  return idx === -1 ? line : line.slice(0, idx);
}
