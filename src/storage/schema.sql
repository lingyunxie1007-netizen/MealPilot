CREATE TABLE IF NOT EXISTS mp_conversation (
  id uuid PRIMARY KEY, owner text NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_draft (
  id uuid PRIMARY KEY, conversation uuid NOT NULL REFERENCES mp_conversation,
  parent uuid REFERENCES mp_draft, version integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mp_revision (
  draft uuid REFERENCES mp_draft, version integer NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(draft, version)
);
CREATE TABLE IF NOT EXISTS mp_run (
  id uuid PRIMARY KEY, conversation uuid NOT NULL REFERENCES mp_conversation,
  client_id text NOT NULL, draft uuid REFERENCES mp_draft, seq integer NOT NULL DEFAULT 0,
  terminal boolean NOT NULL DEFAULT false, UNIQUE(conversation,client_id)
);
CREATE TABLE IF NOT EXISTS mp_message (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run uuid NOT NULL REFERENCES mp_run,
  role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL,
  UNIQUE(run,role)
);
CREATE TABLE IF NOT EXISTS mp_event (
  run uuid REFERENCES mp_run, seq integer NOT NULL, type text NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY(run,seq)
);
CREATE TABLE IF NOT EXISTS mp_action (
  id uuid PRIMARY KEY, conversation uuid NOT NULL REFERENCES mp_conversation,
  kind text NOT NULL, payload jsonb NOT NULL, expected_version integer NOT NULL,
  quote_id text, draft uuid REFERENCES mp_draft, status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','submitting','succeeded','failed','unknown')), result jsonb
);
