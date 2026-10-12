-- Ticker: a URL shortener with analytics.
--
-- The redirect path is the hot path: it reads one link (usually from an
-- in-memory cache) and returns. Clicks are buffered in memory and written in
-- batches, so a burst of traffic becomes a few multi-row INSERTs, not one
-- write per click. Links with a click limit are the exception: they are
-- counted synchronously, because "only 5 people may open this" has to hold
-- exactly, even when 50 people click at once.

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE links (
  id          BIGSERIAL PRIMARY KEY,
  owner_id    BIGINT      NOT NULL REFERENCES users(id),
  -- Generated codes are 7 base62 characters; custom aliases may also use - and _.
  -- Codes are case-sensitive, like every other shortener's.
  code        TEXT        NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{3,32}$'),
  custom      BOOLEAN     NOT NULL DEFAULT false,
  target_url  TEXT        NOT NULL CHECK (length(target_url) BETWEEN 8 AND 2048),
  title       TEXT        NOT NULL DEFAULT '' CHECK (length(title) <= 120),
  expires_at  TIMESTAMPTZ,
  max_clicks  INT         CHECK (max_clicks > 0),
  -- Human clicks, all time. Exact at once for capped links; for the rest it
  -- catches up when the click buffer flushes (about once a second).
  click_count BIGINT      NOT NULL DEFAULT 0,
  -- A capped link can never be counted past its cap.
  CHECK (max_clicks IS NULL OR click_count <= max_clicks),
  disabled_at TIMESTAMPTZ,
  -- Soft delete: the row stays so the code is never handed out again. A
  -- printed or shared short link must never start pointing somewhere new.
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX links_owner_idx ON links (owner_id, id DESC) WHERE deleted_at IS NULL;

-- One row per click (bots included, flagged, so they can be excluded).
-- No IP address is stored: `visitor` is a hash of IP + user agent + a salt
-- that changes every day and is then thrown away.
CREATE TABLE clicks (
  id            BIGSERIAL PRIMARY KEY,
  link_id       BIGINT      NOT NULL REFERENCES links(id),
  at            TIMESTAMPTZ NOT NULL,
  visitor       TEXT        NOT NULL,
  referrer_host TEXT,
  device        TEXT        NOT NULL CHECK (device IN ('desktop', 'mobile', 'tablet', 'bot')),
  browser       TEXT        NOT NULL
);
CREATE INDEX clicks_link_at_idx ON clicks (link_id, at);

-- Daily rollup (UTC days, humans only), kept up to date by the same batch
-- that inserts the clicks. Dashboards that span many links read this
-- instead of scanning raw clicks.
CREATE TABLE link_daily (
  link_id BIGINT NOT NULL REFERENCES links(id),
  day     DATE   NOT NULL,
  clicks  INT    NOT NULL CHECK (clicks >= 0),
  PRIMARY KEY (link_id, day)
);

-- One random salt per UTC day for visitor hashes. Salts older than
-- yesterday are deleted, after which nobody (us included) can link a
-- visitor hash back to an IP address.
CREATE TABLE visitor_salts (
  day  DATE  PRIMARY KEY,
  salt BYTEA NOT NULL
);

-- Token buckets for rate limiting, shared by every server instance.
CREATE TABLE rate_buckets (
  key        TEXT             PRIMARY KEY,
  tokens     DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ      NOT NULL
);

CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Click counting must not bump updated_at, so the trigger watches only
-- the columns a person edits.
CREATE TRIGGER links_touch BEFORE UPDATE OF target_url, title, expires_at, max_clicks, disabled_at, deleted_at
  ON links FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
