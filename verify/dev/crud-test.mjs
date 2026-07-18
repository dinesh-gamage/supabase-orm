// Step 2 — CRUD smoke test using the package's own repository helper against
// the demo_projects table on the BLANK dev Supabase project.
//
// Run with: node verify/dev/crud-test.mjs

import { config as loadDotenv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { createRepository } from '../../dist/index.js';

loadDotenv({ path: '/Users/dineshgamage/personal/projects/life-grid/.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL_DEV;
const key = process.env.SUPABASE_SECRET_KEY_DEV;
if (!url || !key) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL_DEV / SUPABASE_SECRET_KEY_DEV');
}

const client = createClient(url, key);
const projects = createRepository(client, 'demo_projects');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  console.log('== insert 3 rows ==');
  const inserted = [];
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    const row = await projects.insert({ name, budget: 1000 });
    inserted.push(row);
    console.log(`  inserted ${row.name} (${row.id})`);
  }
  assert(inserted.length === 3, 'inserted 3 rows');
  assert(inserted.every((r) => r.status === 'active'), 'default status is active on all 3');

  console.log('\n== findMany (eq status=active, order name, limit 10) ==');
  const active = await projects.findMany({ eq: { status: 'active' }, order: 'name', limit: 10 });
  console.log(`  found ${active.length} active project(s): ${active.map((r) => r.name).join(', ')}`);
  assert(active.length >= 3, 'findMany returns at least the 3 inserted rows');
  const names = active.map((r) => r.name);
  const sorted = [...names].sort();
  assert(JSON.stringify(names) === JSON.stringify(sorted), 'results are ordered by name ascending');

  console.log('\n== update 1 ==');
  const target = inserted[0];
  const updated = await projects.update(target.id, { status: 'archived', budget: 2500 });
  console.log(`  updated ${updated.name} -> status=${updated.status}, budget=${updated.budget}`);
  assert(updated.status === 'archived', 'update persisted status change');
  assert(Number(updated.budget) === 2500, 'update persisted budget change');

  console.log('\n== delete 1 ==');
  const toDelete = inserted[1];
  await projects.delete(toDelete.id);
  const afterDelete = await projects.findById(toDelete.id);
  assert(afterDelete === null, 'deleted row no longer findable by id');

  console.log('\n== count remaining (of the 3 we inserted) ==');
  const remainingIds = [inserted[0].id, inserted[2].id];
  const remaining = await projects.findMany({});
  const remainingOfOurs = remaining.filter((r) => remainingIds.includes(r.id));
  console.log(`  remaining of ours: ${remainingOfOurs.length} (expected 2)`);
  assert(remainingOfOurs.length === 2, 'exactly 2 of our 3 rows remain after 1 delete');

  console.log('\nAll CRUD assertions passed.');
}

main().catch((err) => {
  console.error('CRUD TEST FAILED:', err);
  process.exitCode = 1;
});
