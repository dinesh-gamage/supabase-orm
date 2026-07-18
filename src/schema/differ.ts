// Pure diff engine — no side effects, no DB calls. Compares a desired
// (schema-as-code) definition against a live (introspected) database and
// produces a fully classified list of changes. The differ never filters or
// suppresses changes based on category — everything desired vs. live is
// reported, and it's up to the SQL generator to decide what to emit.

import type {
  ModuleSchema,
  LiveSchema,
  LiveTable,
  LiveColumn,
  SchemaDiff,
  DiffChange,
  TableDef,
  ColumnDef,
  FunctionDef,
  TriggerDef,
  PolicyDef,
  LiveFunction,
  LiveTrigger,
} from './types.js';

export function diff(
  desired: ModuleSchema,
  live: LiveSchema,
  functions: FunctionDef[] = [],
  triggers: TriggerDef[] = [],
  policies: PolicyDef[] = []
): SchemaDiff {
  const changes: DiffChange[] = [];
  const staleHints: string[] = [];

  // ─── ENUMs ──────────────────────────────────────────────────────────────────
  diffEnums(desired, live, changes);

  // ─── Tables (incl. rename detection pre-pass) ──────────────────────────────
  diffTables(desired, live, changes, staleHints);

  // ─── Functions ──────────────────────────────────────────────────────────────
  diffFunctions(functions, live.functions ?? [], changes);

  // ─── Triggers ───────────────────────────────────────────────────────────────
  diffTriggers(triggers, live.triggers ?? [], changes);

  // ─── Policies ───────────────────────────────────────────────────────────────
  diffPolicies(policies, live, changes);

  const hasEnumChanges = changes.some(
    (c) => c.kind === 'create_enum' || c.kind === 'add_enum_value'
  );
  const hasStructuralChanges = changes.some(
    (c) => c.kind !== 'create_enum' && c.kind !== 'add_enum_value' && c.kind !== 'drop_enum_value'
  );

  return { moduleId: desired.moduleId, changes, hasEnumChanges, hasStructuralChanges, staleHints };
}

// ─── Enum diffing ──────────────────────────────────────────────────────────────

function diffEnums(desired: ModuleSchema, live: LiveSchema, changes: DiffChange[]) {
  for (const desiredEnum of desired.enums) {
    const liveEnum = live.enums.find((e) => e.typeName === desiredEnum.typeName);
    if (!liveEnum) {
      changes.push({
        kind: 'create_enum',
        enumName: desiredEnum.typeName,
        detail: desiredEnum.values.join(','),
        category: 'safe',
      });
    } else {
      for (const value of desiredEnum.values) {
        if (!liveEnum.values.includes(value)) {
          changes.push({
            kind: 'add_enum_value',
            enumName: desiredEnum.typeName,
            detail: value,
            category: 'safe',
          });
        }
      }
      for (const value of liveEnum.values) {
        if (!desiredEnum.values.includes(value)) {
          changes.push({
            kind: 'drop_enum_value',
            enumName: desiredEnum.typeName,
            detail: value,
            category: 'manual',
          });
        }
      }
    }
  }
}

// ─── Table diffing (with rename pre-pass) ──────────────────────────────────────

function diffTables(desired: ModuleSchema, live: LiveSchema, changes: DiffChange[], staleHints: string[]) {
  const liveTableMap = new Map<string, LiveTable>(live.tables.map((t) => [t.tableName, t]));
  const consumedLiveTables = new Set<string>();

  // Ambiguity guard: two desired tables cannot claim the same rename source.
  const tableRenameSources = new Map<string, string>();
  for (const t of desired.tables) {
    const renamedFrom = t.renamedFrom ?? null;
    if (!renamedFrom) continue;
    const existing = tableRenameSources.get(renamedFrom);
    if (existing) {
      throw new Error(
        `Ambiguous rename: tables "${existing}" and "${t.tableName}" both claim renamedFrom('${renamedFrom}')`
      );
    }
    tableRenameSources.set(renamedFrom, t.tableName);
  }

  for (const desiredTable of desired.tables) {
    const liveTable = liveTableMap.get(desiredTable.tableName);
    const renamedFrom = desiredTable.renamedFrom ?? null;

    if (liveTable) {
      // New name already exists live — hint (if any) is inert.
      if (renamedFrom) {
        staleHints.push(
          `table ${desiredTable.tableName}: remove .renamedFrom('${renamedFrom}') — already applied`
        );
      }
      consumedLiveTables.add(liveTable.tableName);
      diffColumns(desiredTable, liveTable, changes, staleHints);
      diffIndexes(desiredTable, liveTable, changes);
      diffRls(desiredTable, liveTable, changes);
      diffTrigger(desiredTable, liveTable, changes);
      continue;
    }

    // New name doesn't exist live — check for a rename.
    let handledAsRename = false;
    if (renamedFrom) {
      const oldLiveTable = liveTableMap.get(renamedFrom);
      const oldNameAlsoDesired = desired.tables.some((t) => t.tableName === renamedFrom);
      if (oldLiveTable && !oldNameAlsoDesired) {
        changes.push({
          kind: 'rename_table',
          tableName: desiredTable.tableName,
          renamedFrom,
          category: 'safe',
        });
        consumedLiveTables.add(oldLiveTable.tableName);
        // Diff the desired table's columns/indexes/RLS against the OLD live
        // table so rename + column changes land in a single migration.
        diffColumns(desiredTable, oldLiveTable, changes, staleHints);
        diffIndexes(desiredTable, oldLiveTable, changes);
        diffRls(desiredTable, oldLiveTable, changes);
        diffTrigger(desiredTable, oldLiveTable, changes);
        handledAsRename = true;
      }
    }

    if (!handledAsRename) {
      changes.push({
        kind: 'create_table',
        tableName: desiredTable.tableName,
        category: 'safe',
      });
    }
  }

  for (const liveTable of live.tables) {
    if (consumedLiveTables.has(liveTable.tableName)) continue;
    const inDesired = desired.tables.some((t) => t.tableName === liveTable.tableName);
    if (!inDesired) {
      changes.push({
        kind: 'drop_table',
        tableName: liveTable.tableName,
        category: 'destructive',
      });
    }
  }
}

function diffColumns(desired: TableDef, live: LiveTable, changes: DiffChange[], staleHints: string[]) {
  const liveColMap = new Map<string, LiveColumn>(live.columns.map((c) => [c.columnName, c]));
  const consumedLiveCols = new Set<string>();

  // Ambiguity guard: two desired columns cannot claim the same rename source.
  const colRenameSources = new Map<string, string>();
  for (const [colName, desiredCol] of Object.entries(desired.columns)) {
    const renamedFrom = desiredCol.renamedFrom ?? null;
    if (!renamedFrom) continue;
    const existing = colRenameSources.get(renamedFrom);
    if (existing) {
      throw new Error(
        `Ambiguous rename: columns "${existing}" and "${colName}" in table "${desired.tableName}" both claim renamedFrom('${renamedFrom}')`
      );
    }
    colRenameSources.set(renamedFrom, colName);
  }

  for (const [colName, desiredCol] of Object.entries(desired.columns)) {
    const liveCol = liveColMap.get(colName);
    const renamedFrom = desiredCol.renamedFrom ?? null;

    if (liveCol) {
      // New name already exists live — hint (if any) is inert.
      if (renamedFrom) {
        staleHints.push(
          `table ${desired.tableName}: column ${colName}: remove .renamedFrom('${renamedFrom}') — already applied`
        );
      }
      consumedLiveCols.add(colName);
      pushTypeChangeIfNeeded(desired.tableName, colName, desiredCol, liveCol.pgType, changes);
      continue;
    }

    // New name doesn't exist live — check for a rename.
    let handledAsRename = false;
    if (renamedFrom) {
      const oldLiveCol = liveColMap.get(renamedFrom);
      const oldNameAlsoDesired = renamedFrom in desired.columns;
      if (oldLiveCol && !oldNameAlsoDesired) {
        changes.push({
          kind: 'rename_column',
          tableName: desired.tableName,
          columnName: colName,
          renamedFrom,
          category: 'safe',
        });
        consumedLiveCols.add(oldLiveCol.columnName);
        pushTypeChangeIfNeeded(desired.tableName, colName, desiredCol, oldLiveCol.pgType, changes);
        handledAsRename = true;
      }
    }

    if (!handledAsRename) {
      changes.push({
        kind: 'add_column',
        tableName: desired.tableName,
        columnName: colName,
        category: 'safe',
      });
    }
  }

  for (const liveCol of live.columns) {
    if (consumedLiveCols.has(liveCol.columnName)) continue;
    if (!(liveCol.columnName in desired.columns)) {
      changes.push({
        kind: 'drop_column',
        tableName: desired.tableName,
        columnName: liveCol.columnName,
        category: 'destructive',
      });
    }
  }
}

function pushTypeChangeIfNeeded(
  tableName: string,
  columnName: string,
  desiredCol: ColumnDef,
  livePgType: string,
  changes: DiffChange[]
) {
  const desiredType = normalizeTypeForComparison(desiredCol.pgType);
  const liveType = normalizeTypeForComparison(livePgType);
  if (desiredType !== liveType) {
    changes.push({
      kind: 'alter_column_type',
      tableName,
      columnName,
      category: 'destructive',
      detail: `desired: ${desiredCol.pgType}, live: ${livePgType}`,
    });
  }
}

function diffIndexes(desired: TableDef, live: LiveTable, changes: DiffChange[]) {
  for (const idx of desired.indexes) {
    const name = idx.name ?? `idx_${desired.tableName}_${idx.columns.join('_')}`;
    const exists = live.indexes.some((li) => li.indexName === name);
    if (!exists) {
      changes.push({
        kind: 'create_index',
        tableName: desired.tableName,
        indexName: name,
        detail: idx.columns.join(',') + (idx.where ? ` WHERE ${idx.where}` : ''),
        category: 'safe',
      });
    }
  }
}

function diffRls(desired: TableDef, live: LiveTable, changes: DiffChange[]) {
  if (desired.rlsPolicy === 'none') return;

  if (!live.rlsEnabled) {
    changes.push({ kind: 'enable_rls', tableName: desired.tableName, category: 'safe' });
  }

  if (desired.rlsPolicy === 'standard') {
    const hasAuthPolicy = live.rlsPolicies.some(
      (p) => p.roles.includes('authenticated') || p.policyName.toLowerCase().includes('authenticated')
    );
    const hasSvcPolicy = live.rlsPolicies.some(
      (p) => p.roles.includes('service_role') || p.policyName.toLowerCase().includes('service_role')
    );

    if (!hasAuthPolicy) {
      changes.push({
        kind: 'add_rls_policy',
        tableName: desired.tableName,
        detail: 'authenticated',
        category: 'safe',
      });
    }
    if (!hasSvcPolicy) {
      changes.push({
        kind: 'add_rls_policy',
        tableName: desired.tableName,
        detail: 'service_role',
        category: 'safe',
      });
    }
  }
}

function diffTrigger(desired: TableDef, live: LiveTable, changes: DiffChange[]) {
  const hasUpdatedAt = 'updated_at' in desired.columns;
  if (hasUpdatedAt && !live.hasTrigger) {
    changes.push({ kind: 'add_trigger', tableName: desired.tableName, category: 'safe' });
  }
}

// ─── Function diffing ─────────────────────────────────────────────────────────

function diffFunctions(desired: FunctionDef[], live: LiveFunction[], changes: DiffChange[]) {
  const liveFnMap = new Map(live.map((f) => [f.name, f]));

  for (const fn of desired) {
    const liveFn = liveFnMap.get(fn.name);
    if (!liveFn) {
      changes.push({
        kind: 'create_function',
        functionName: fn.name,
        category: 'safe',
      });
    } else {
      const bodyMatches = normalizeBody(fn.body) === normalizeBody(liveFn.body);
      const securityMatches = fn.security === liveFn.security;
      const volatilityMatches = fn.volatility.toUpperCase() === liveFn.volatility.toUpperCase();

      if (!bodyMatches || !securityMatches || !volatilityMatches) {
        changes.push({
          kind: 'alter_function',
          functionName: fn.name,
          detail: !bodyMatches ? 'body changed' : !securityMatches ? 'security changed' : 'volatility changed',
          category: 'safe',
        });
      }
    }
  }

  // Functions live in the DB but not in desired — flagged for manual review.
  for (const liveFn of live) {
    const inDesired = desired.some((f) => f.name === liveFn.name);
    if (!inDesired) {
      changes.push({
        kind: 'drop_function',
        functionName: liveFn.name,
        category: 'destructive',
        detail: liveFn.argsSignature,
      });
    }
  }
}

// ─── Trigger diffing ──────────────────────────────────────────────────────────

function diffTriggers(desired: TriggerDef[], live: LiveTrigger[], changes: DiffChange[]) {
  const liveTrigMap = new Map(live.map((t) => [`${t.name}::${t.table}`, t]));

  for (const trig of desired) {
    const key = `${trig.name}::${trig.table}`;
    const liveTrig = liveTrigMap.get(key);

    if (!liveTrig) {
      changes.push({
        kind: 'create_trigger',
        triggerName: trig.name,
        tableName: trig.table,
        category: 'safe',
      });
    } else {
      const eventsMatch = [...trig.events].sort().join(',') === [...liveTrig.events].sort().join(',');
      const timingMatch = trig.timing === liveTrig.timing;
      const fnMatch = trig.function === liveTrig.functionName;
      const forEachMatch = trig.forEach === liveTrig.forEach;

      if (!eventsMatch || !timingMatch || !fnMatch || !forEachMatch) {
        changes.push({
          kind: 'alter_trigger',
          triggerName: trig.name,
          tableName: trig.table,
          detail: !fnMatch ? 'function changed' : !timingMatch ? 'timing changed' : 'events changed',
          category: 'safe',
        });
      }
    }
  }

  for (const liveTrig of live) {
    const inDesired = desired.some((t) => t.name === liveTrig.name && t.table === liveTrig.table);
    if (!inDesired) {
      changes.push({
        kind: 'drop_trigger',
        triggerName: liveTrig.name,
        tableName: liveTrig.table,
        category: 'destructive',
      });
    }
  }
}

// ─── Policy diffing ───────────────────────────────────────────────────────────

function diffPolicies(desired: PolicyDef[], live: LiveSchema, changes: DiffChange[]) {
  const livePolicyMap = new Map<
    string,
    { policyName: string; roles: string[]; cmd: string; qual: string | null; withCheck: string | null }
  >();
  for (const t of live.tables) {
    for (const p of t.rlsPolicies) {
      livePolicyMap.set(`${t.tableName}::${p.policyName}`, {
        policyName: p.policyName,
        roles: p.roles,
        cmd: p.cmd,
        qual: p.qual,
        withCheck: p.withCheck,
      });
    }
  }

  const desiredKeys = new Set<string>();

  for (const pol of desired) {
    const key = `${pol.table}::${pol.name}`;
    desiredKeys.add(key);
    const livePol = livePolicyMap.get(key);

    if (!livePol) {
      changes.push({
        kind: 'create_policy',
        policyName: pol.name,
        tableName: pol.table,
        category: 'safe',
      });
    } else {
      const roles = Array.isArray(pol.to) ? pol.to : [pol.to];
      const rolesMatch = [...roles].sort().join(',') === [...livePol.roles].sort().join(',');
      const cmdMatch = pol.for.toUpperCase() === livePol.cmd.toUpperCase();
      const usingMatch = normPolicyExpr(pol.using ?? null) === normPolicyExpr(livePol.qual ?? null);
      const checkMatch = normPolicyExpr(pol.withCheck ?? null) === normPolicyExpr(livePol.withCheck ?? null);

      if (!rolesMatch || !cmdMatch || !usingMatch || !checkMatch) {
        changes.push({
          kind: 'alter_policy',
          policyName: pol.name,
          tableName: pol.table,
          detail: !rolesMatch ? 'roles changed' : !cmdMatch ? 'cmd changed' : 'expression changed',
          category: 'destructive', // DROP+CREATE is lossy for concurrent access
        });
      }
    }
  }

  for (const t of live.tables) {
    for (const p of t.rlsPolicies) {
      // Skip standard auto-generated policies (managed by the schema rls() setting).
      if (p.policyName.startsWith('allow_authenticated_') || p.policyName.startsWith('allow_service_role_')) {
        continue;
      }

      const key = `${t.tableName}::${p.policyName}`;
      if (!desiredKeys.has(key)) {
        changes.push({
          kind: 'drop_policy',
          policyName: p.policyName,
          tableName: t.tableName,
          category: 'destructive',
        });
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeTypeForComparison(t: string): string {
  return t.toUpperCase().replace('TIMESTAMP WITH TIME ZONE', 'TIMESTAMPTZ').trim();
}

/**
 * Normalize a function body for comparison. PostgreSQL preserves the body
 * verbatim, but authors may reformat whitespace between generations.
 */
function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a policy USING / WITH CHECK expression for comparison.
 * PostgreSQL decompiles its internal parse tree back to a string, which may
 * differ from the original in these ways:
 *   - Adds surrounding parentheses
 *   - Rewrites `col = true` → `col` for boolean columns
 *   - Collapses extra whitespace
 *
 * We strip outer parens and collapse whitespace so that minor cosmetic
 * differences don't show up as expression changes.
 */
function normPolicyExpr(expr: string | null): string | null {
  if (expr === null) return null;
  let s = expr.replace(/\s+/g, ' ').trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let balanced = false;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0 && i === s.length - 1) balanced = true;
      }
    }
    if (!balanced) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}
