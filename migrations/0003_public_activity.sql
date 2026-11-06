-- Unqualified history may contain invite-only counts. Never migrate it as public.
DELETE FROM activity;
-- Retired monitor/worker versions must not refill or expose the old table.
CREATE TRIGGER reject_legacy_activity_insert BEFORE INSERT ON activity BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER reject_legacy_activity_update BEFORE UPDATE ON activity BEGIN SELECT RAISE(IGNORE); END;
CREATE TABLE public_activity_v2 (
  environment TEXT NOT NULL, sampled_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('available','suppressed','unavailable')),
  sessions INTEGER, players INTEGER,
  CHECK ((state = 'available' AND sessions >= 5 AND sessions % 5 = 0 AND players >= 10 AND players % 10 = 0)
    OR (state != 'available' AND sessions IS NULL AND players IS NULL)),
  PRIMARY KEY(environment, sampled_at)
);
