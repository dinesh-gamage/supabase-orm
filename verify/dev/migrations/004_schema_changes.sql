-- supaorm:destructive
-- This migration includes DESTRUCTIVE changes. Review carefully before applying:
--   drop_column  demo_projects.status

ALTER TABLE demo_projects DROP COLUMN status;