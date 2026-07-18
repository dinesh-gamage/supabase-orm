CREATE TABLE IF NOT EXISTS demo_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status demo_status NOT NULL DEFAULT 'active',
  budget DECIMAL(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_demo_projects_name ON demo_projects (name);
ALTER TABLE demo_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_authenticated_demo_projects" ON demo_projects
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_service_role_demo_projects" ON demo_projects
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER update_demo_projects_updated_at
  BEFORE UPDATE ON demo_projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS demo_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES demo_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE demo_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_authenticated_demo_tasks" ON demo_tasks
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_service_role_demo_tasks" ON demo_tasks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER update_demo_tasks_updated_at
  BEFORE UPDATE ON demo_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
