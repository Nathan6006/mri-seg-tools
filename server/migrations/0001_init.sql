-- Accounts, workspaces, and per-user annotation layers.
--
-- The one design decision worth reading: a case does NOT have "a mask".
-- Each member of a workspace gets their own annotation layer for every case
-- (see the `annotations` table). Two people reviewing the same cohort never
-- write to the same row, so there is no last-write-wins, no lock to take,
-- and no way for one reviewer to silently overwrite another's work.
--
-- That matters beyond mere safety. A tool whose whole claim is that
-- automated outlines reproduce a result needs to know which voxels a human
-- changed and which human changed them; a single shared mutable mask
-- destroys exactly that record. Keeping the layers separate also means two
-- people independently outlining the same scan produces an inter-rater
-- agreement measurement as a by-product of ordinary use.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,   -- stored lowercased; compared lowercased
  display_name  TEXT NOT NULL,
  email         TEXT,
  pw_hash       TEXT NOT NULL,          -- pbkdf2-sha256$<iters>$<salt_b64>$<dk_b64>
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Login sessions. The cookie holds a random token; this table holds only its
-- SHA-256, so a dump of the database does not let anyone log in as anybody.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Failed sign-in attempts, for throttling. Keyed by username AND by IP so
-- that neither guessing one account nor spraying many is cheap.
CREATE TABLE login_attempts (
  key        TEXT PRIMARY KEY,
  failures   INTEGER NOT NULL DEFAULT 0,
  first_at   INTEGER NOT NULL,
  locked_until INTEGER
);

-- A workspace is one shared study: a set of cases plus the people who may
-- see them. A user who registers gets one of their own.
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_members_user ON workspace_members(user_id);

-- One scan session. `record` is the case record the viewer already uses,
-- stored verbatim as JSON so the client's shape stays the source of truth.
CREATE TABLE cases (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  record       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL REFERENCES users(id),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, name)
);

-- Blobs live in R2; this is the index. One row per (case, kind), where kind
-- is image / t1 / mask_auto / qc. The per-user working masks are NOT here --
-- they are in `annotations`.
CREATE TABLE case_files (
  workspace_id TEXT NOT NULL,
  case_name    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, case_name, kind),
  FOREIGN KEY (workspace_id, case_name) REFERENCES cases(workspace_id, name) ON DELETE CASCADE
);

-- One reviewer's working mask for one case. See the note at the top.
CREATE TABLE annotations (
  workspace_id TEXT NOT NULL,
  case_name    TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  volume_mm3   REAL,
  voxels       INTEGER,
  edited       INTEGER NOT NULL DEFAULT 0,  -- 1 once it diverges from mask_auto
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, case_name, user_id),
  FOREIGN KEY (workspace_id, case_name) REFERENCES cases(workspace_id, name) ON DELETE CASCADE
);
CREATE INDEX idx_annotations_case ON annotations(workspace_id, case_name);

-- Review verdicts, also per user for the same reason.
CREATE TABLE reviews (
  workspace_id TEXT NOT NULL,
  case_name    TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verdict      TEXT,
  note         TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, case_name, user_id),
  FOREIGN KEY (workspace_id, case_name) REFERENCES cases(workspace_id, name) ON DELETE CASCADE
);
