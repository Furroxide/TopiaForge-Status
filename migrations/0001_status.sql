CREATE TABLE observations (
  environment TEXT NOT NULL, component TEXT NOT NULL, slot INTEGER NOT NULL,
  observed_at INTEGER NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('pass','fail','blocked')),
  latency_ms REAL, reason TEXT NOT NULL, run_id TEXT NOT NULL,
  PRIMARY KEY (environment, component, slot)
);
CREATE TABLE claims (environment TEXT NOT NULL, mode TEXT NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY(environment,mode,slot));
CREATE INDEX observation_time ON observations(observed_at);
CREATE TABLE monitor_start (
  environment TEXT NOT NULL, component TEXT NOT NULL, started_at INTEGER NOT NULL,
  PRIMARY KEY(environment, component)
);
CREATE TABLE incidents (
  id TEXT PRIMARY KEY, environment TEXT NOT NULL, component TEXT NOT NULL,
  started_at INTEGER NOT NULL, confirmed_at INTEGER NOT NULL, resolved_at INTEGER
);
CREATE UNIQUE INDEX one_open_incident ON incidents(environment, component) WHERE resolved_at IS NULL;
CREATE TABLE daily (
  environment TEXT NOT NULL, component TEXT NOT NULL, day INTEGER NOT NULL,
  passed INTEGER NOT NULL, failed INTEGER NOT NULL, blocked INTEGER NOT NULL,
  PRIMARY KEY(environment, component, day)
);
CREATE TABLE activity (
  environment TEXT NOT NULL, sampled_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('available','suppressed','unavailable')),
  sessions INTEGER, players INTEGER,
  CHECK ((state = 'available' AND sessions >= 5 AND players >= 10) OR (state != 'available' AND sessions IS NULL AND players IS NULL)),
  PRIMARY KEY(environment, sampled_at)
);
