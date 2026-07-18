-- NO TRANSACTION
-- ENUM additions must run outside a transaction in PostgreSQL

CREATE TYPE demo_status AS ENUM ('active', 'archived');