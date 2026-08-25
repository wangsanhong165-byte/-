"""Memory store — SQLite + FTS5 backend.

Replaces JSONL with structured storage.

Facts table: id, fact, tags (JSON), time, source, importance, created_at
Logs table:  id, role, content, intent, created_at
Both backed by FTS5 virtual tables for full-text search.

Search strategy (two-tier, same as openhanako v2):
  1. Tag exact match via json_each (OR logic, sorted by match count)
  2. FTS5 full-text fallback (with CJK bigram)
  3. LIKE fallback if FTS5 fails
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+")
_FTS_LIMIT = 20

# Memory lifecycle decay (deterministic, no LLM; Hermes curator-inspired).
STALE_DAYS = 30
ARCHIVE_DAYS = 90


def _safe_history_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    """Keep visual history metadata useful while excluding bytes and paths."""
    visual = (metadata or {}).get("visual") if isinstance(metadata, dict) else None
    if not isinstance(visual, dict):
        return {}
    allowed = {
        "hasVisionInput", "imageCount", "imageBytes", "mimeTypes", "dimensions",
        "imageHashes", "attachmentIds", "protocol", "source", "task",
    }
    result = {
        key: value for key, value in visual.items()
        if key in allowed and isinstance(value, (str, int, float, bool, list, dict, type(None)))
    }
    return {"visual": result} if result else {}


def _cjk_ngrams(text: str, sizes=(2, 3)) -> list[str]:
    """Generate CJK bigrams/trigrams for FTS5 tokenization."""
    tokens = []
    for match in _CJK_RE.finditer(text):
        chars = list(match.group(0))
        for size in sizes:
            if len(chars) < size:
                continue
            for i in range(len(chars) - size + 1):
                tokens.append("".join(chars[i:i + size]))
    return tokens


def _build_fts_query(text: str) -> str:
    """Build FTS5 query: lexical tokens + CJK trigrams joined by OR.

    The trigram tokenizer only indexes substrings of >=3 characters, so any
    shorter token is dropped here; callers fall back to LIKE for those queries.
    """
    normalized = text.strip().lower()
    if not normalized:
        return ""
    lexical = [w for w in normalized.split() if len(w) >= 3]
    grams = _cjk_ngrams(normalized, sizes=(3,))
    all_tokens = list(dict.fromkeys(lexical + grams))
    return " OR ".join(f'"{w}"' for w in all_tokens if w)


def _parse_ts(value) -> float:
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except (ValueError, TypeError):
        return 0.0


def _decay_decision(row: dict, now_ts: float) -> str | None:
    """Return 'stale' | 'archive' | None for one memory row.

    Deterministic, no LLM. Mirrors Hermes curator.apply_automatic_transitions:
      active -> stale after STALE_DAYS of no activity
      active/stale -> archived after ARCHIVE_DAYS of no activity
    Activity = last_retrieved_at, else updated_at, else created_at. Fresh rows
    (younger than STALE_DAYS) are always left alone; decay is reversible
    (upsert revives archived, search reactivates stale), never destructive.
    """
    activity = (
        _parse_ts(row.get("last_retrieved_at"))
        or _parse_ts(row.get("updated_at"))
        or _parse_ts(row.get("created_at"))
    )
    if activity <= 0:
        return None
    age_days = (now_ts - activity) / 86400.0
    if str(row.get("state", "active")) == "archived":
        return None
    if age_days > ARCHIVE_DAYS:
        return "archive"
    if age_days > STALE_DAYS:
        return "stale"
    return None


class MemoryStore:
    """SQLite+FTS5 memory store. Drop-in replacement for JSONL-based store."""

    def __init__(self, base_dir: Optional[Path] = None):
        configured_path = os.environ.get("MEMORY_DB_PATH", "").strip()
        if base_dir is not None:
            base = Path(base_dir)
            base.mkdir(parents=True, exist_ok=True)
            db_path = base / "data" / "memory" / "memory.db"
        elif configured_path:
            db_path = Path(configured_path).expanduser()
        else:
            base = Path(__file__).resolve().parents[2]
            base.mkdir(parents=True, exist_ok=True)
            db_path = base / "data" / "memory" / "memory.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db_path = str(db_path)
        self._local = threading.local()
        self._init_db()

    # ── connection management ──────────────────────────────────────────

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            conn = sqlite3.connect(self._db_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.execute("PRAGMA cache_size = -16000")
            conn.execute("PRAGMA temp_store = MEMORY")
            conn.execute("PRAGMA mmap_size = 30000000")
            # Concurrent background writers (reviewer/extractor/compiler) need a
            # bounded wait instead of an immediate SQLITE_BUSY error.
            conn.execute("PRAGMA busy_timeout = 5000")
            self._local.conn = conn
        return self._local.conn

    def _init_db(self):
        conn = self._get_conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS facts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                fact       TEXT NOT NULL,
                tags       TEXT NOT NULL DEFAULT '[]',
                time       TEXT,
                source     TEXT DEFAULT '',
                importance REAL DEFAULT 0.5,
                character_id TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_facts_time ON facts(time);
            CREATE INDEX IF NOT EXISTS idx_facts_importance ON facts(importance);

            CREATE TABLE IF NOT EXISTS logs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                role       TEXT NOT NULL,
                content    TEXT NOT NULL,
                intent     TEXT DEFAULT '',
                character_id TEXT DEFAULT '',
                turn_id    TEXT,
                write_token TEXT,
                history_uid TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
            CREATE TABLE IF NOT EXISTS turn_commits (
                character_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                write_token TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(character_id, turn_id, write_token)
            );
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS memories (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                memory_type  TEXT NOT NULL,
                subject      TEXT NOT NULL DEFAULT 'user',
                predicate    TEXT NOT NULL DEFAULT '',
                content      TEXT NOT NULL,
                character_id TEXT NOT NULL DEFAULT '',
                stable_key   TEXT NOT NULL,
                importance   REAL NOT NULL DEFAULT 0.5,
                confidence   REAL NOT NULL DEFAULT 0.6,
                active       INTEGER NOT NULL DEFAULT 1,
                access_count INTEGER NOT NULL DEFAULT 0,
                last_retrieved_at TEXT,
                state        TEXT NOT NULL DEFAULT 'active',
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL,
                UNIQUE(character_id, stable_key, content)
            );
            CREATE INDEX IF NOT EXISTS idx_memories_scope
                ON memories(character_id, memory_type, active);

            CREATE TABLE IF NOT EXISTS character_states (
                character_id TEXT PRIMARY KEY,
                state_json   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS retrieval_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                query TEXT NOT NULL,
                character_id TEXT NOT NULL DEFAULT '',
                result_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS initiative_topic_usage (
                character_id TEXT NOT NULL,
                memory_id TEXT NOT NULL,
                used_at REAL NOT NULL,
                PRIMARY KEY(character_id, memory_id)
            );
            CREATE TABLE IF NOT EXISTS usage_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                character_id TEXT NOT NULL DEFAULT '',
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                model TEXT NOT NULL DEFAULT '',
                context_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
                fact, tags,
                content=facts, content_rowid=id,
                tokenize='trigram'
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
                content,
                content=logs, content_rowid=id,
                tokenize='trigram'
            );
        """)
        fact_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(facts)").fetchall()
        }
        if "character_id" not in fact_columns:
            conn.execute(
                "ALTER TABLE facts ADD COLUMN character_id TEXT DEFAULT ''"
            )
        log_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(logs)").fetchall()
        }
        if "turn_id" not in log_columns:
            conn.execute("ALTER TABLE logs ADD COLUMN turn_id TEXT")
        if "write_token" not in log_columns:
            conn.execute("ALTER TABLE logs ADD COLUMN write_token TEXT")
        if "history_uid" not in log_columns:
            conn.execute("ALTER TABLE logs ADD COLUMN history_uid TEXT")
        if "metadata_json" not in log_columns:
            conn.execute("ALTER TABLE logs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'")
        memory_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(memories)").fetchall()
        }
        if "last_retrieved_at" not in memory_columns:
            conn.execute("ALTER TABLE memories ADD COLUMN last_retrieved_at TEXT")
        if "state" not in memory_columns:
            conn.execute(
                "ALTER TABLE memories ADD COLUMN state TEXT NOT NULL DEFAULT 'active'"
            )
        conn.execute(
            "INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (?, ?)",
            (4, datetime.now(timezone.utc).isoformat()),
        )
        # Migrate legacy unicode61 FTS tables to trigram so CJK substring
        # search works (unicode61 treats a whole CJK run as one token).
        fts_migrated = False
        for fts_name, content_name, fts_cols in (
            ("facts_fts", "facts", "fact, tags"),
            ("logs_fts", "logs", "content"),
        ):
            row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                (fts_name,),
            ).fetchone()
            if row and "unicode61" in (row["sql"] or ""):
                conn.execute(f"DROP TABLE {fts_name}")
                conn.execute(
                    "CREATE VIRTUAL TABLE " + fts_name + " USING fts5("
                    + fts_cols + ", content=" + content_name
                    + ", content_rowid=id, tokenize='trigram')"
                )
                fts_migrated = True
        conn.executescript("""
            CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
                INSERT INTO facts_fts(rowid, fact, tags) VALUES (new.id, new.fact, new.tags);
            END;
            CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
                INSERT INTO facts_fts(facts_fts, rowid, fact, tags) VALUES ('delete', old.id, old.fact, old.tags);
            END;
            CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
                INSERT INTO facts_fts(facts_fts, rowid, fact, tags) VALUES ('delete', old.id, old.fact, old.tags);
                INSERT INTO facts_fts(rowid, fact, tags) VALUES (new.id, new.fact, new.tags);
            END;
            CREATE TRIGGER IF NOT EXISTS logs_ai AFTER INSERT ON logs BEGIN
                INSERT INTO logs_fts(rowid, content) VALUES (new.id, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS logs_ad AFTER DELETE ON logs BEGIN
                INSERT INTO logs_fts(logs_fts, rowid, content) VALUES ('delete', old.id, old.content);
            END;
        """)
        if fts_migrated:
            # Re-populate the new trigram index from the content tables.
            conn.executescript("""
                INSERT INTO facts_fts(facts_fts) VALUES('rebuild');
                INSERT INTO logs_fts(logs_fts) VALUES('rebuild');
            """)
        conn.commit()

    def upsert_memory(
        self, *, memory_type: str, subject: str, predicate: str, content: str,
        character_id: str = "", importance: float = 0.5,
        confidence: float = 0.6, stable_key: str = "",
    ) -> int:
        now = datetime.now(timezone.utc).isoformat()
        key = stable_key or f"{memory_type}:{subject}:{predicate}"
        normalized_content = content.strip()
        conn = self._get_conn()
        # BEGIN IMMEDIATE makes the read-then-write atomic: two concurrent
        # writers (reviewer + extractor daemon threads) cannot both read "not
        # present" and both INSERT (which would violate the UNIQUE constraint
        # or create duplicate active rows).
        conn.execute("BEGIN IMMEDIATE")
        try:
            current = conn.execute(
                "SELECT id, content FROM memories "
                "WHERE character_id = ? AND stable_key = ? AND active = 1",
                (character_id, key),
            ).fetchone()
            if current and current["content"] == normalized_content:
                # Re-confirmation also clears the stale tag so state mirrors
                # the fresh activity clock.
                conn.execute(
                    "UPDATE memories SET state = 'active', "
                    "importance = MAX(importance, ?), "
                    "confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?",
                    (importance, confidence, now, current["id"]),
                )
                conn.commit()
                return int(current["id"])
            existing = conn.execute(
                "SELECT id FROM memories "
                "WHERE character_id = ? AND stable_key = ? AND content = ?",
                (character_id, key, normalized_content),
            ).fetchone()
            if current:
                conn.execute(
                    "UPDATE memories SET active = 0, updated_at = ? WHERE id = ?",
                    (now, current["id"]),
                )
            if existing:
                conn.execute(
                    "UPDATE memories SET active = 1, state = 'active', "
                    "memory_type = ?, subject = ?, "
                    "predicate = ?, importance = MAX(importance, ?), "
                    "confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?",
                    (
                        memory_type, subject, predicate, importance,
                        confidence, now, existing["id"],
                    ),
                )
                conn.commit()
                return int(existing["id"])
            cursor = conn.execute(
                "INSERT INTO memories(memory_type, subject, predicate, content, "
                "character_id, stable_key, importance, confidence, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (memory_type, subject, predicate, normalized_content, character_id, key,
                 importance, confidence, now, now),
            )
            conn.commit()
            return int(cursor.lastrowid)
        except Exception:
            conn.rollback()
            raise

    def list_memories(
        self, *, character_id: str = "", memory_type: str = "",
        active_only: bool = True, limit: int = 100,
    ) -> list[dict]:
        clauses, params = [], []
        if character_id:
            clauses.append("character_id = ?")
            params.append(character_id)
        if memory_type:
            clauses.append("memory_type = ?")
            params.append(memory_type)
        if active_only:
            clauses.append("active = 1")
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self._get_conn().execute(
            "SELECT * FROM memories" + where +
            " ORDER BY importance DESC, updated_at DESC LIMIT ?", (*params, limit)
        ).fetchall()
        return [dict(row) for row in rows]

    def decay_memories(
        self, character_id: str = "", now_ts: float | None = None
    ) -> dict:
        """Apply deterministic time-based decay (active -> stale -> archived).

        Pure SQL transition, no LLM. Archived rows get active=0 (hidden from
        active_only retrieval) but stay on disk for restore/upsert revival.
        Returns {'staled': [ids], 'archived': [ids]}.
        """
        now_ts = now_ts if now_ts is not None else time.time()
        conn = self._get_conn()
        clauses: list[str] = ["state != 'archived'", "active = 1"]
        params: list[Any] = []
        if character_id:
            clauses.append("character_id = ?")
            params.append(character_id)
        rows = conn.execute(
            "SELECT * FROM memories WHERE " + " AND ".join(clauses), params
        ).fetchall()
        stamp = datetime.now(timezone.utc).isoformat()
        staled: list[int] = []
        archived: list[int] = []
        for row in rows:
            decision = _decay_decision(dict(row), now_ts)
            if decision == "stale":
                # Do NOT refresh updated_at here: activity is computed from
                # last_retrieved_at/updated_at/created_at, so resetting the
                # clock would make never-retrieved rows loop stale forever and
                # never reach the archive branch.
                conn.execute(
                    "UPDATE memories SET state = 'stale' WHERE id = ?",
                    (row["id"],),
                )
                staled.append(int(row["id"]))
            elif decision == "archive":
                conn.execute(
                    "UPDATE memories SET state = 'archived', active = 0, "
                    "updated_at = ? WHERE id = ?",
                    (stamp, row["id"]),
                )
                archived.append(int(row["id"]))
        conn.commit()
        return {"staled": staled, "archived": archived}

    def update_memory(
        self, memory_id: int, *, character_id: str = "",
        content: str | None = None, importance: float | None = None,
        confidence: float | None = None,
    ) -> dict | None:
        clauses, params = ["id = ?"], [int(memory_id)]
        if character_id:
            clauses.append("character_id = ?")
            params.append(character_id)
        row = self._get_conn().execute(
            "SELECT * FROM memories WHERE " + " AND ".join(clauses), params
        ).fetchone()
        if not row:
            return None
        updates, values = [], []
        if content is not None and content.strip():
            updates.append("content = ?")
            values.append(content.strip())
        if importance is not None:
            updates.append("importance = ?")
            values.append(max(0.0, min(1.0, float(importance))))
        if confidence is not None:
            updates.append("confidence = ?")
            values.append(max(0.0, min(1.0, float(confidence))))
        if updates:
            updates.append("updated_at = ?")
            values.append(datetime.now(timezone.utc).isoformat())
            self._get_conn().execute(
                "UPDATE memories SET " + ", ".join(updates) + " WHERE id = ?",
                (*values, int(memory_id)),
            )
            self._get_conn().commit()
        refreshed = self._get_conn().execute(
            "SELECT * FROM memories WHERE id = ?", (int(memory_id),)
        ).fetchone()
        return dict(refreshed) if refreshed else None

    def forget_memory(self, memory_id: int, *, character_id: str = "") -> bool:
        clauses, params = ["id = ?"], [int(memory_id)]
        if character_id:
            clauses.append("character_id = ?")
            params.append(character_id)
        cursor = self._get_conn().execute(
            "UPDATE memories SET active = 0, updated_at = ? WHERE "
            + " AND ".join(clauses),
            (datetime.now(timezone.utc).isoformat(), *params),
        )
        self._get_conn().commit()
        return cursor.rowcount > 0

    def search_memories(
        self, query: str, *, character_id: str = "", limit: int = 10
    ) -> list[dict]:
        from app.memory.retrieval import score_memory
        candidates = self.list_memories(character_id=character_id, limit=250)
        ranked = []
        for item in candidates:
            def _ts(value):
                try:
                    return datetime.fromisoformat(str(value)).timestamp()
                except (ValueError, TypeError):
                    return 0.0
            item["created_ts"] = _ts(item.get("created_at"))
            item["updated_ts"] = _ts(item.get("updated_at"))
            score, reasons = score_memory(query, item)
            if score >= 0.24:
                item["score"] = round(score, 4)
                item["reasons"] = reasons or ["importance"]
                ranked.append(item)
        ranked.sort(key=lambda row: row["score"], reverse=True)
        results = ranked[:limit]
        now = datetime.now(timezone.utc).isoformat()
        # Surface usage: bump access_count + last_retrieved_at on structured
        # memories. Access count contributes a small familiarity signal on
        # future searches; last_retrieved_at drives lifecycle decay.
        for row in results:
            row_id = row.get("id", "")
            if str(row_id).startswith("fact:"):
                continue
            self._get_conn().execute(
                "UPDATE memories SET access_count = access_count + 1, "
                "last_retrieved_at = ?, "
                "state = CASE WHEN state = 'stale' THEN 'active' ELSE state END "
                "WHERE id = ?",
                (now, int(row_id)),
            )
        self._get_conn().commit()
        return results

    def save_character_state(self, character_id: str, state: dict) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self._get_conn().execute(
            "INSERT INTO character_states(character_id, state_json, updated_at) "
            "VALUES (?, ?, ?) ON CONFLICT(character_id) DO UPDATE SET "
            "state_json = excluded.state_json, updated_at = excluded.updated_at",
            (
                character_id,
                json.dumps(
                    {"schemaVersion": 3, **state},
                    ensure_ascii=False,
                ),
                now,
            ),
        )
        self._get_conn().commit()

    def load_character_state(self, character_id: str) -> dict:
        row = self._get_conn().execute(
            "SELECT state_json FROM character_states WHERE character_id = ?",
            (character_id,),
        ).fetchone()
        if not row:
            return {}
        try:
            state = json.loads(row["state_json"])
            if not isinstance(state, dict) or state.get("schemaVersion") != 3:
                return {}
            return {
                key: value
                for key, value in state.items()
                if key != "schemaVersion"
            }
        except (json.JSONDecodeError, TypeError):
            return {}

    def claim_legacy_scope(self, character_id: str) -> dict[str, int]:
        """Assign old empty-scope rows to one explicit character.

        Empty strings used to mean both "unknown" and "shared", which made
        every character see the same data.  Startup claims those rows for the
        then-active character once; all live reads are exact-scope afterwards.
        """
        character_id = str(character_id or "").strip()
        if not character_id:
            return {"facts": 0, "memories": 0, "logs": 0}
        conn = self._get_conn()
        counts: dict[str, int] = {}
        with conn:
            for table in ("facts", "logs", "retrieval_audit", "usage_events"):
                counts[table] = int(conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE character_id = ''"
                ).fetchone()[0])
                cursor = conn.execute(
                    f"UPDATE {table} SET character_id = ? WHERE character_id = ''",
                    (character_id,),
                )
                del cursor

            # A direct UPDATE can violate memories' composite UNIQUE key when
            # the same item was already written under the active character.
            # Merge lifecycle metadata into the explicit row and remove only
            # the redundant legacy copy in that case.
            legacy_memories = conn.execute(
                "SELECT * FROM memories WHERE character_id = '' ORDER BY id"
            ).fetchall()
            counts["memories"] = len(legacy_memories)
            for row in legacy_memories:
                target = conn.execute(
                    "SELECT * FROM memories WHERE character_id = ? "
                    "AND stable_key = ? AND content = ? LIMIT 1",
                    (character_id, row["stable_key"], row["content"]),
                ).fetchone()
                if target:
                    conn.execute(
                        "UPDATE memories SET importance = ?, confidence = ?, "
                        "active = ?, access_count = ?, last_retrieved_at = ?, "
                        "state = ?, updated_at = ? WHERE id = ?",
                        (
                            max(float(target["importance"]), float(row["importance"])),
                            max(float(target["confidence"]), float(row["confidence"])),
                            max(int(target["active"]), int(row["active"])),
                            int(target["access_count"]) + int(row["access_count"]),
                            max(
                                str(target["last_retrieved_at"] or ""),
                                str(row["last_retrieved_at"] or ""),
                            ) or None,
                            "active" if int(target["active"]) or int(row["active"])
                            else str(target["state"]),
                            max(str(target["updated_at"]), str(row["updated_at"])),
                            int(target["id"]),
                        ),
                    )
                    conn.execute("DELETE FROM memories WHERE id = ?", (row["id"],))
                else:
                    conn.execute(
                        "UPDATE memories SET character_id = ? WHERE id = ?",
                        (character_id, row["id"]),
                    )

            counts["turn_commits"] = int(conn.execute(
                "SELECT COUNT(*) FROM turn_commits WHERE character_id = ''"
            ).fetchone()[0])
            conn.execute(
                "INSERT OR IGNORE INTO turn_commits"
                "(character_id, turn_id, write_token, created_at) "
                "SELECT ?, turn_id, write_token, created_at FROM turn_commits "
                "WHERE character_id = ''",
                (character_id,),
            )
            conn.execute("DELETE FROM turn_commits WHERE character_id = ''")

            counts["character_states"] = int(conn.execute(
                "SELECT COUNT(*) FROM character_states WHERE character_id = ''"
            ).fetchone()[0])
            conn.execute(
                "INSERT OR IGNORE INTO character_states(character_id, state_json, updated_at) "
                "SELECT ?, state_json, updated_at FROM character_states "
                "WHERE character_id = ''",
                (character_id,),
            )
            conn.execute("DELETE FROM character_states WHERE character_id = ''")

            counts["initiative_topic_usage"] = int(conn.execute(
                "SELECT COUNT(*) FROM initiative_topic_usage WHERE character_id = ''"
            ).fetchone()[0])
            conn.execute(
                "INSERT INTO initiative_topic_usage(character_id, memory_id, used_at) "
                "SELECT ?, memory_id, used_at FROM initiative_topic_usage "
                "WHERE character_id = '' "
                "ON CONFLICT(character_id, memory_id) DO UPDATE SET "
                "used_at = MAX(used_at, excluded.used_at)",
                (character_id,),
            )
            conn.execute("DELETE FROM initiative_topic_usage WHERE character_id = ''")
        return counts

    def backfill_legacy_facts(self, character_id: str = "") -> int:
        """Copy legacy facts without resurrecting edited or forgotten memories."""
        from app.memory.lifecycle import normalize_candidate

        before = len(self.list_memories(
            character_id=character_id, active_only=False, limit=100000
        ))
        conn = self._get_conn()
        for fact in self.get_all_facts(character_id=character_id):
            candidate = normalize_candidate({
                "fact": fact["fact"],
                "importance": fact["importance"],
                "confidence": 0.7,
            })
            if candidate is None:
                continue

            # The legacy fact can remain after the lifecycle memory was edited
            # or forgotten. Stable key is the migration identity, so startup
            # must not recreate that memory from the old table.
            existing = conn.execute(
                "SELECT id FROM memories WHERE character_id = ? AND stable_key = ? LIMIT 1",
                (fact.get("character_id", ""), candidate["stable_key"]),
            ).fetchone()
            if existing:
                continue
            self.upsert_memory(
                character_id=fact.get("character_id", ""), **candidate
            )
        after = len(self.list_memories(
            character_id=character_id, active_only=False, limit=100000
        ))
        return max(0, after - before)

    def delete_character_data(self, character_id: str) -> dict[str, int]:
        """Delete all database rows owned by one character."""
        character_id = str(character_id or "").strip()
        if not character_id:
            raise ValueError("character_id is required")
        conn = self._get_conn()
        counts: dict[str, int] = {}
        tables = (
            "facts", "logs", "turn_commits", "memories", "character_states",
            "retrieval_audit", "initiative_topic_usage", "usage_events",
        )
        with conn:
            for table in tables:
                cursor = conn.execute(
                    f"DELETE FROM {table} WHERE character_id = ?", (character_id,)
                )
                counts[table] = int(cursor.rowcount)
        return counts

    def initiative_last_used(self, character_id: str, memory_id: object) -> float:
        row = self._get_conn().execute(
            "SELECT used_at FROM initiative_topic_usage "
            "WHERE character_id = ? AND memory_id = ?",
            (character_id, str(memory_id)),
        ).fetchone()
        return float(row["used_at"]) if row else 0.0

    def mark_initiative_used(self, character_id: str, memory_id: object) -> None:
        self._get_conn().execute(
            "INSERT INTO initiative_topic_usage(character_id, memory_id, used_at) "
            "VALUES (?, ?, ?) ON CONFLICT(character_id, memory_id) "
            "DO UPDATE SET used_at = excluded.used_at",
            (character_id, str(memory_id), __import__("time").time()),
        )
        self._get_conn().commit()

    def record_usage(
        self, character_id: str, usage: dict, context_budget: dict | None = None
    ) -> None:
        self._get_conn().execute(
            "INSERT INTO usage_events(character_id, prompt_tokens, completion_tokens, "
            "cached_tokens, estimated_cost_usd, model, context_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                character_id,
                int(usage.get("prompt_tokens", 0) or 0),
                int(usage.get("completion_tokens", 0) or 0),
                int(usage.get("cached_tokens", 0) or 0),
                float(usage.get("estimated_cost_usd", 0) or 0),
                str(usage.get("model", "")),
                json.dumps(
                    {"schemaVersion": 3, **(context_budget or {})},
                    ensure_ascii=False,
                ),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        self._get_conn().commit()

    def usage_summary(self, character_id: str = "", recent_limit: int = 30) -> dict:
        where, params = "", []
        if character_id:
            where = " WHERE character_id = ?"
            params.append(character_id)
        totals = self._get_conn().execute(
            "SELECT COUNT(*) turns, COALESCE(SUM(prompt_tokens), 0) prompt_tokens, "
            "COALESCE(SUM(completion_tokens), 0) completion_tokens, "
            "COALESCE(SUM(cached_tokens), 0) cached_tokens, "
            "COALESCE(SUM(estimated_cost_usd), 0) estimated_cost_usd "
            "FROM usage_events" + where, params,
        ).fetchone()
        rows = self._get_conn().execute(
            "SELECT prompt_tokens, completion_tokens, cached_tokens, "
            "estimated_cost_usd, model, context_json, created_at FROM usage_events"
            + where + " ORDER BY id DESC LIMIT ?",
            (*params, max(1, min(200, int(recent_limit)))),
        ).fetchall()
        return {
            "totals": dict(totals),
            "recent": [
                {
                    **{key: row[key] for key in row.keys() if key != "context_json"},
                    "context_budget": {
                        key: value
                        for key, value in json.loads(
                            row["context_json"] or "{}"
                        ).items()
                        if key != "schemaVersion"
                    },
                }
                for row in rows
            ],
        }

    # ── conversation log ───────────────────────────────────────────────

    def log_turn(
        self,
        user_text: str,
        reply: dict,
        character_id: str = "",
        *,
        turn_id: str = "",
        write_token: str = "",
        history_uid: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        """Atomically persist one turn; return False for an idempotent replay."""
        now = datetime.now(timezone.utc).isoformat()
        conn = self._get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if turn_id and write_token:
                inserted = conn.execute(
                    "INSERT OR IGNORE INTO turn_commits"
                    "(character_id, turn_id, write_token, created_at) VALUES (?, ?, ?, ?)",
                    (character_id, turn_id, write_token, now),
                )
                if inserted.rowcount == 0:
                    conn.rollback()
                    return False
            metadata_json = json.dumps(
                _safe_history_metadata(metadata), ensure_ascii=False
            )
            if user_text.strip():
                conn.execute(
                    "INSERT INTO logs(role, content, intent, character_id, turn_id, write_token, history_uid, metadata_json, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        "user", user_text[:1000], reply.get("intent", "unknown"),
                        character_id, turn_id or None, write_token or None,
                        history_uid or None, metadata_json, now,
                    ),
                )
            reply_text = reply.get("reply_text", "")[:2000]
            if reply_text.strip():
                conn.execute(
                    "INSERT INTO logs(role, content, intent, character_id, turn_id, write_token, history_uid, metadata_json, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        "assistant", reply_text, reply.get("intent", "reply"),
                        character_id, turn_id or None, write_token or None,
                        history_uid or None, metadata_json, now,
                    ),
                )
            conn.commit()
            return True
        except Exception:
            conn.rollback()
            raise

    def history_messages(
        self,
        history_uid: str,
        *,
        character_id: str = "",
    ) -> list[dict[str, Any]]:
        rows = self._get_conn().execute(
            "SELECT role, content, metadata_json FROM logs "
            "WHERE history_uid = ? AND (? = '' OR character_id = ?) ORDER BY id",
            (history_uid, character_id, character_id),
        ).fetchall()
        result = []
        for row in rows:
            message: dict[str, Any] = {"role": row["role"], "content": row["content"]}
            try:
                metadata = json.loads(row["metadata_json"] or "{}")
            except (TypeError, ValueError):
                metadata = {}
            if isinstance(metadata, dict) and metadata:
                message["metadata"] = metadata
            result.append(message)
        return result

    def delete_history(self, history_uid: str, *, character_id: str = "") -> int:
        conn = self._get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            commit_keys = conn.execute(
                "SELECT DISTINCT character_id, turn_id, write_token FROM logs "
                "WHERE history_uid = ? AND (? = '' OR character_id = ?) "
                "AND turn_id IS NOT NULL AND turn_id != '' "
                "AND write_token IS NOT NULL AND write_token != ''",
                (history_uid, character_id, character_id),
            ).fetchall()
            cur = conn.execute(
                "DELETE FROM logs WHERE history_uid = ? AND (? = '' OR character_id = ?)",
                (history_uid, character_id, character_id),
            )
            for row in commit_keys:
                key = (row["character_id"], row["turn_id"], row["write_token"])
                conn.execute(
                    "DELETE FROM turn_commits "
                    "WHERE character_id = ? AND turn_id = ? AND write_token = ? "
                    "AND NOT EXISTS ("
                    "SELECT 1 FROM logs "
                    "WHERE character_id = ? AND turn_id = ? AND write_token = ?"
                    ")",
                    key + key,
                )
            conn.commit()
            return cur.rowcount
        except Exception:
            conn.rollback()
            raise

    def recent_turns(self, n: int = 10, character_id: str = "") -> list[dict]:
        conn = self._get_conn()
        if character_id:
            rows = conn.execute(
                "SELECT id, role, content, intent, created_at FROM logs "
                "WHERE character_id = ? ORDER BY id DESC LIMIT ?",
                (character_id, n * 2),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, role, content, intent, created_at FROM logs "
                "ORDER BY id DESC LIMIT ?",
                (n * 2,),
            ).fetchall()
        turns = []
        for r in reversed(rows):
            turns.append({
                "id": int(r["id"]),
                "role": r["role"],
                "content": r["content"],
                "intent": r["intent"],
                "created_at": r["created_at"],
            })
        return turns

    def summary_window(
        self,
        character_id: str,
        *,
        after_log_id: int = 0,
        keep_recent: int = 10,
        limit: int = 100,
    ) -> list[dict]:
        """Return unsummarized rows while reserving the exact recent tail."""
        rows = self._get_conn().execute(
            "SELECT id, role, content, intent, created_at FROM logs "
            "WHERE character_id = ? AND id > ? ORDER BY id LIMIT ?",
            (character_id, int(after_log_id), max(1, int(limit))),
        ).fetchall()
        if len(rows) <= keep_recent:
            return []
        return [dict(row) for row in rows[:-keep_recent]]

    def search_logs(
        self, query: str, limit: int = 5, character_id: str = ""
    ) -> list[dict]:
        conn = self._get_conn()
        results: list[dict] = []
        seen: set = set()
        fts_query = _build_fts_query(query)
        if fts_query:
            try:
                if character_id:
                    rows = conn.execute(
                        "SELECT l.role, l.content, l.intent, l.character_id, l.created_at "
                        "FROM logs_fts f JOIN logs l ON f.rowid = l.id "
                        "WHERE logs_fts MATCH ? AND l.character_id = ? "
                        "ORDER BY rank LIMIT ?",
                        (fts_query, character_id, limit),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT l.role, l.content, l.intent, l.character_id, l.created_at "
                        "FROM logs_fts f JOIN logs l ON f.rowid = l.id "
                        "WHERE logs_fts MATCH ? ORDER BY rank LIMIT ?",
                        (fts_query, limit),
                    ).fetchall()
                for r in rows:
                    key = (r["role"], r["content"])
                    if key in seen:
                        continue
                    seen.add(key)
                    results.append(dict(r))
            except sqlite3.OperationalError:
                pass
        # LIKE fallback for sub-3-char queries the trigram index cannot serve
        # (single CJK chars, 2-char words).
        if len(results) < limit and query:
            scope = " AND l.character_id = ?" if character_id else ""
            params = (f"%{query}%", character_id) if character_id else (f"%{query}%",)
            rows = conn.execute(
                "SELECT l.role, l.content, l.intent, l.character_id, l.created_at "
                "FROM logs l WHERE l.content LIKE ?" + scope
                + " ORDER BY l.id DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
            for r in rows:
                key = (r["role"], r["content"])
                if key in seen:
                    continue
                seen.add(key)
                results.append(dict(r))
        return results[:limit]

    # ── facts ──────────────────────────────────────────────────────────

    def add_fact(
        self,
        content: str,
        tags: Optional[list[str]] = None,
        importance: float = 0.5,
        source: str = "",
        time: Optional[str] = None,
        character_id: str = "",
    ) -> bool:
        if not content or len(content.strip()) < 3:
            return False
        tags = tags or []
        now = datetime.now(timezone.utc).isoformat()
        conn = self._get_conn()
        existing = self._find_overlapping(content, tags, character_id=character_id)
        if existing:
            return False
        conn.execute(
            "INSERT INTO facts(fact, tags, time, source, importance, character_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (content.strip(), json.dumps(tags, ensure_ascii=False), time, source,
             importance, character_id, now),
        )
        conn.commit()
        return True

    def _find_overlapping(
        self, content: str, tags: list[str], *, character_id: str = ""
    ) -> bool:
        conn = self._get_conn()
        normalized = re.sub(r"\s+", "", content).lower()
        if character_id:
            rows = conn.execute(
                "SELECT fact FROM facts WHERE character_id = ?", (character_id,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT fact FROM facts WHERE character_id = ''"
            ).fetchall()
        return any(re.sub(r"\s+", "", row["fact"]).lower() == normalized for row in rows)

    def search_facts(
        self,
        query: str = "",
        tags: Optional[list[str]] = None,
        k: int = 5,
        character_id: str = "",
    ) -> list[dict]:
        results = []
        seen_ids = set()
        conn = self._get_conn()

        # Strategy 1: tag matching
        if tags:
            placeholders = ",".join(f"@t{i}" for i in range(len(tags)))
            params = {f"t{i}": t for i, t in enumerate(tags)}
            params["limit"] = _FTS_LIMIT
            scope = " AND f.character_id = @character_id" if character_id else ""
            if character_id:
                params["character_id"] = character_id
            rows = conn.execute(
                f"SELECT f.*, COUNT(DISTINCT je.value) as match_count "
                f"FROM facts f, json_each(f.tags) je "
                f"WHERE je.value IN ({placeholders})" + scope + " "
                f"GROUP BY f.id ORDER BY match_count DESC, f.importance DESC LIMIT @limit",
                params,
            ).fetchall()
            for r in rows:
                seen_ids.add(r["id"])
                results.append(self._row_to_fact(r))

        # Strategy 2: FTS5 fallback
        if len(results) < 3 and query:
            fts_query = _build_fts_query(query)
            if fts_query:
                try:
                    scope = " AND f.character_id = ?" if character_id else ""
                    rows = conn.execute(
                        "SELECT f.* FROM facts_fts fts JOIN facts f ON fts.rowid = f.id "
                        "WHERE facts_fts MATCH ?" + scope + " ORDER BY rank LIMIT ?",
                        ((fts_query, character_id, _FTS_LIMIT) if character_id
                         else (fts_query, _FTS_LIMIT)),
                    ).fetchall()
                    for r in rows:
                        if r["id"] in seen_ids:
                            continue
                        seen_ids.add(r["id"])
                        results.append(self._row_to_fact(r))
                except sqlite3.OperationalError:
                    pass

        # Strategy 3: LIKE fallback
        if len(results) < 3 and query:
            scope = " AND character_id = ?" if character_id else ""
            rows = conn.execute(
                "SELECT * FROM facts WHERE fact LIKE ?" + scope
                + " ORDER BY importance DESC LIMIT ?",
                ((f"%{query}%", character_id, _FTS_LIMIT) if character_id
                 else (f"%{query}%", _FTS_LIMIT)),
            ).fetchall()
            for r in rows:
                if r["id"] in seen_ids:
                    continue
                results.append(self._row_to_fact(r))

        return results[:k]

    def get_all_facts(self, character_id: str = "") -> list[dict]:
        conn = self._get_conn()
        if character_id:
            rows = conn.execute(
                "SELECT * FROM facts WHERE character_id = ? "
                "ORDER BY importance DESC, created_at DESC", (character_id,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM facts ORDER BY importance DESC, created_at DESC"
            ).fetchall()
        return [self._row_to_fact(r) for r in rows]

    @property
    def fact_count(self) -> int:
        conn = self._get_conn()
        return conn.execute("SELECT COUNT(*) as c FROM facts").fetchone()["c"]

    def _row_to_fact(self, r) -> dict:
        tags_raw = r["tags"]
        if isinstance(tags_raw, str):
            try:
                tags = json.loads(tags_raw)
            except (json.JSONDecodeError, TypeError):
                tags = []
        else:
            tags = tags_raw or []
        return {
            "id": r["id"],
            "fact": r["fact"],
            "tags": tags,
            "time": r["time"] if r["time"] else None,
            "source": r["source"] if r["source"] else "",
            "importance": float(r["importance"]) if r["importance"] else 0.5,
            "created_at": r["created_at"] if r["created_at"] else "",
            "character_id": r["character_id"] if "character_id" in r.keys() else "",
        }

    def rebuild_index(self):
        conn = self._get_conn()
        conn.executescript("""
            INSERT INTO facts_fts(facts_fts) VALUES ('rebuild');
            INSERT INTO logs_fts(logs_fts) VALUES ('rebuild');
        """)
        return self.fact_count

    def logs_before(
        self, cutoff: str, limit: int = 40, character_id: str = ""
    ) -> list[dict]:
        """Return the most recent log rows created before cutoff (oldest last).

        Used by extract-before-destroy: surface what is about to be deleted.
        """
        conn = self._get_conn()
        if character_id:
            rows = conn.execute(
                "SELECT role, content, character_id, created_at FROM logs "
                "WHERE created_at < ? AND character_id = ? ORDER BY id DESC LIMIT ?",
                (cutoff, character_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT role, content, character_id, created_at FROM logs "
                "WHERE created_at < ? ORDER BY id DESC LIMIT ?",
                (cutoff, limit),
            ).fetchall()
        return [dict(r) for r in reversed(rows)]

    def delete_logs_before(self, cutoff: str, character_id: str = "") -> int:
        """Delete log entries older than cutoff (ISO datetime string). Returns count."""
        conn = self._get_conn()
        if character_id:
            cur = conn.execute(
                "DELETE FROM logs WHERE created_at < ? AND character_id = ?",
                (cutoff, character_id),
            )
        else:
            cur = conn.execute("DELETE FROM logs WHERE created_at < ?", (cutoff,))
        deleted = cur.rowcount
        conn.commit()
        return deleted

    def delete_facts_before(self, cutoff: str, character_id: str = "") -> int:
        """Delete facts older than cutoff (ISO datetime string). Returns count."""
        conn = self._get_conn()
        if character_id:
            cur = conn.execute(
                "DELETE FROM facts WHERE created_at < ? AND character_id = ?",
                (cutoff, character_id),
            )
        else:
            cur = conn.execute("DELETE FROM facts WHERE created_at < ?", (cutoff,))
        deleted = cur.rowcount
        conn.commit()
        return deleted

    def delete_memories_before(
        self, cutoff: str, character_id: str = ""
    ) -> int:
        """Physically purge superseded/inactive memory rows older than cutoff.

        Only deactivated rows (active=0, left behind by upsert content changes,
        forget, or decay-archive) are ever deleted; active memories are governed
        by decay, not this sweep. Run on the daily batch so the memories table
        stops growing without bound.
        """
        conn = self._get_conn()
        clauses: list[str] = ["active = 0", "created_at < ?"]
        params: list[Any] = [cutoff]
        if character_id:
            clauses.append("character_id = ?")
            params.append(character_id)
        cur = conn.execute(
            "DELETE FROM memories WHERE " + " AND ".join(clauses), params
        )
        deleted = cur.rowcount
        conn.commit()
        return deleted

    def prune_character_history(self, character_id: str, cutoff: str) -> dict[str, int]:
        """Bound raw history after durable extraction/compilation has run."""
        character_id = str(character_id or "").strip()
        if not character_id:
            raise ValueError("character_id is required")
        conn = self._get_conn()
        counts: dict[str, int] = {}
        with conn:
            for table in ("logs", "turn_commits", "usage_events"):
                cursor = conn.execute(
                    f"DELETE FROM {table} WHERE character_id = ? AND created_at < ?",
                    (character_id, cutoff),
                )
                counts[table] = int(cursor.rowcount)
        return counts

    def start(self):
        pass

    def stop(self, wait=False):
        if hasattr(self._local, "conn") and self._local.conn:
            self._local.conn.close()
            self._local.conn = None


memory_store = MemoryStore()



