CREATE TABLE claim_owners (
  environment TEXT NOT NULL,
  mode TEXT NOT NULL,
  slot INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  PRIMARY KEY (environment, mode, slot)
);

CREATE INDEX incidents_environment_resolution ON incidents(environment, resolved_at);
