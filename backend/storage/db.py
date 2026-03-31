"""
SQLite veritabani yonetimi.
Position, Order, Trade tablolari.
"""
import sqlite3
import json
import logging
import os
from pathlib import Path
from datetime import datetime

logger = logging.getLogger("polyflow.db")

DB_PATH = Path(__file__).parent.parent.parent / "bot.db"


def get_conn() -> sqlite3.Connection:
    """SQLite baglantisi don."""
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Tablolari olustur (yoksa)."""
    conn = get_conn()
    try:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS positions (
            id TEXT PRIMARY KEY,
            asset TEXT NOT NULL,
            event_key TEXT,
            event_slug TEXT,
            side TEXT DEFAULT 'UP',
            entry_price REAL DEFAULT 0,
            current_price REAL DEFAULT 0,
            target_price REAL DEFAULT 0,
            stop_loss REAL DEFAULT 0,
            amount REAL DEFAULT 0,
            shares REAL DEFAULT 0,
            pnl REAL DEFAULT 0,
            status TEXT DEFAULT 'OPEN',
            mode TEXT DEFAULT 'PAPER',
            order_id TEXT DEFAULT '',
            fill_confirmed INTEGER DEFAULT 0,
            condition_id TEXT DEFAULT '',
            entry_time TEXT,
            close_time TEXT,
            close_reason TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS trades (
            id TEXT PRIMARY KEY,
            asset TEXT NOT NULL,
            event_key TEXT,
            event_slug TEXT,
            side TEXT DEFAULT 'UP',
            entry_price REAL DEFAULT 0,
            exit_price REAL DEFAULT 0,
            amount REAL DEFAULT 0,
            pnl REAL DEFAULT 0,
            status TEXT,
            mode TEXT DEFAULT 'PAPER',
            date TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS events_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_key TEXT,
            event_slug TEXT,
            ptb REAL,
            open_time TEXT,
            close_time TEXT,
            outcome TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            settings_json TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS event_settings (
            key TEXT PRIMARY KEY,
            settings_json TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_key TEXT NOT NULL,
            decision TEXT NOT NULL,
            reason TEXT,
            side TEXT DEFAULT '',
            entry_price REAL DEFAULT 0,
            exit_price REAL DEFAULT 0,
            pnl REAL DEFAULT 0,
            amount REAL DEFAULT 0,
            rules_snapshot TEXT DEFAULT '{}',
            trade_id TEXT DEFAULT '',
            timestamp TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_audit_event_key ON audit_log(event_key);
        CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_log(decision);
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);

        CREATE TABLE IF NOT EXISTS bot_state (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at REAL DEFAULT (strftime('%s','now'))
        );
        """)
        conn.commit()
    finally:
        conn.close()
    # Mevcut tabloya eksik kolonları ekle (migration — varsa IGNORE)
    _migrate_positions_table()


def _migrate_positions_table():
    """positions tablosuna yeni kolonlar ekle (tablo zaten mevcutsa ALTER TABLE)."""
    migrations = [
        "ALTER TABLE positions ADD COLUMN shares REAL DEFAULT 0",
        "ALTER TABLE positions ADD COLUMN order_id TEXT DEFAULT ''",
        "ALTER TABLE positions ADD COLUMN fill_confirmed INTEGER DEFAULT 0",
        "ALTER TABLE positions ADD COLUMN condition_id TEXT DEFAULT ''",
    ]
    conn = get_conn()
    try:
        for sql in migrations:
            try:
                conn.execute(sql)
            except Exception:
                pass  # Kolon zaten var → ignore
        conn.commit()
    finally:
        conn.close()


# ─── Position CRUD ───────────────────────────────────────────────────────────

def save_position(pos: dict):
    conn = get_conn()
    try:
        conn.execute("""
            INSERT OR REPLACE INTO positions
            (id, asset, event_key, event_slug, side, entry_price, current_price,
             target_price, stop_loss, amount, shares, pnl, status, mode,
             order_id, fill_confirmed, condition_id, entry_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            pos["id"], pos.get("asset",""), pos.get("event_key",""), pos.get("event_slug",""),
            pos.get("side","UP"), pos.get("entry_price",0), pos.get("current_price",0),
            pos.get("target_price",0), pos.get("stop_loss",0), pos.get("amount",0),
            pos.get("shares",0), pos.get("pnl",0), pos.get("status","OPEN"), pos.get("mode","LIVE"),
            pos.get("order_id",""), 1 if pos.get("fill_confirmed") else 0,
            pos.get("condition_id",""), pos.get("entry_time",""),
        ))
        conn.commit()
    finally:
        conn.close()


def update_position_fill(pos_id: str, order_id: str, fill_confirmed: bool, shares: float):
    """
    Fill confirmation sonrası order_id, fill_confirmed ve shares'i güncelle.
    entry_service.py, open_position()'dan sonra fill detayları alınca çağırır.
    """
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE positions SET order_id=?, fill_confirmed=?, shares=? WHERE id=?",
            (order_id, 1 if fill_confirmed else 0, shares, pos_id),
        )
        conn.commit()
    except Exception as e:
        logger.error(f"update_position_fill hata [{pos_id}]: {e}")
    finally:
        conn.close()


def close_position(pos_id: str, exit_price: float, reason: str):
    conn = get_conn()
    try:
        conn.execute("""
            UPDATE positions SET status='CLOSED', close_reason=?, close_time=?, current_price=?
            WHERE id=?
        """, (reason, datetime.now().isoformat(), exit_price, pos_id))
        conn.commit()
    finally:
        conn.close()


def get_open_positions() -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute("SELECT * FROM positions WHERE status='OPEN' ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_all_positions(limit: int = 100) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute("SELECT * FROM positions ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ─── Trade CRUD ──────────────────────────────────────────────────────────────

def save_trade(trade: dict):
    conn = get_conn()
    try:
        conn.execute("""
            INSERT OR REPLACE INTO trades
            (id, asset, event_key, event_slug, side, entry_price, exit_price,
             amount, pnl, status, mode, date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            trade["id"], trade.get("asset",""), trade.get("event_key",""), trade.get("event_slug",""),
            trade.get("side","UP"), trade.get("entry_price",0), trade.get("exit_price",0),
            trade.get("amount",0), trade.get("pnl",0), trade.get("status",""),
            trade.get("mode","PAPER"), trade.get("date",""),
        ))
        conn.commit()
    finally:
        conn.close()


def get_trades(limit: int = 100) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute("SELECT * FROM trades ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_daily_trade_count() -> int:
    conn = get_conn()
    try:
        today = datetime.now().strftime("%Y-%m-%d")
        row = conn.execute("SELECT COUNT(*) as cnt FROM trades WHERE date(created_at)=?", (today,)).fetchone()
        return row["cnt"] if row else 0
    finally:
        conn.close()


def get_daily_pnl() -> float:
    conn = get_conn()
    try:
        today = datetime.now().strftime("%Y-%m-%d")
        row = conn.execute("SELECT COALESCE(SUM(pnl),0) as total FROM trades WHERE date(created_at)=?", (today,)).fetchone()
        return row["total"] if row else 0.0
    finally:
        conn.close()


# ─── Event Log ───────────────────────────────────────────────────────────────

def log_event(event_key: str, slug: str, ptb: float):
    conn = get_conn()
    try:
        conn.execute("""
            INSERT INTO events_log (event_key, event_slug, ptb, open_time)
            VALUES (?, ?, ?, ?)
        """, (event_key, slug, ptb, datetime.now().isoformat()))
        conn.commit()
    finally:
        conn.close()


# ─── Event Settings CRUD ─────────────────────────────────────────────────────

def get_event_settings(key: str) -> dict | None:
    """Event'e özel ayarları döndür. Kayıt yoksa None."""
    conn = get_conn()
    try:
        row = conn.execute("SELECT settings_json FROM event_settings WHERE key=?", (key,)).fetchone()
        if row:
            try:
                return json.loads(row["settings_json"])
            except Exception:
                return None
        return None
    finally:
        conn.close()


def save_event_settings(key: str, settings: dict) -> dict | None:
    """Event ayarlarını kaydet. Başarılıysa DB'den doğrulayıp geri döndür, değilse None."""
    conn = get_conn()
    try:
        payload = json.dumps(settings)
        conn.execute("""
            INSERT INTO event_settings (key, settings_json, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET settings_json=excluded.settings_json,
                                           updated_at=datetime('now')
        """, (key, payload))
        conn.commit()
        # Doğrulama: kaydedileni geri oku
        row = conn.execute("SELECT settings_json FROM event_settings WHERE key=?", (key,)).fetchone()
        if row:
            return json.loads(row["settings_json"])
        return None
    except Exception as e:
        logger.error(f"save_event_settings hata ({key}): {e}")
        return None
    finally:
        conn.close()


def delete_event_settings(key: str) -> bool:
    """Event ayarlarını sil. Başarılıysa True."""
    conn = get_conn()
    try:
        conn.execute("DELETE FROM event_settings WHERE key=?", (key,))
        conn.commit()
        # Doğrulama: gerçekten silindi mi?
        row = conn.execute("SELECT key FROM event_settings WHERE key=?", (key,)).fetchone()
        return row is None
    except Exception as e:
        logger.error(f"delete_event_settings hata ({key}): {e}")
        return False
    finally:
        conn.close()


def get_all_event_settings() -> dict:
    """Tüm event ayarlarını {key: settings_dict} formatında döndür."""
    conn = get_conn()
    try:
        rows = conn.execute("SELECT key, settings_json FROM event_settings").fetchall()
        result = {}
        for row in rows:
            try:
                result[row["key"]] = json.loads(row["settings_json"])
            except Exception:
                pass
        return result
    finally:
        conn.close()


# ─── Audit Log ───────────────────────────────────────────────────────────────

def save_audit_log(entry: dict):
    """Karar günlüğüne bir kayıt ekle."""
    conn = get_conn()
    try:
        conn.execute("""
            INSERT INTO audit_log
            (event_key, decision, reason, side, entry_price, exit_price,
             pnl, amount, rules_snapshot, trade_id, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            entry.get("event_key", ""),
            entry.get("decision", ""),
            entry.get("reason", ""),
            entry.get("side", ""),
            entry.get("entry_price", 0),
            entry.get("exit_price", 0),
            entry.get("pnl", 0),
            entry.get("amount", 0),
            entry.get("rules_snapshot", "{}"),
            entry.get("trade_id", ""),
            entry.get("timestamp", datetime.now().isoformat()),
        ))
        conn.commit()
    except Exception as e:
        logger.error(f"save_audit_log hata: {e}")
    finally:
        conn.close()


def get_audit_log(event_key: str = "", limit: int = 100) -> list[dict]:
    """Karar günlüğünü çek. event_key verilmezse tüm kayıtlar."""
    conn = get_conn()
    try:
        if event_key:
            rows = conn.execute(
                "SELECT * FROM audit_log WHERE event_key=? ORDER BY id DESC LIMIT ?",
                (event_key, limit)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?",
                (limit,)
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_audit_stats() -> dict:
    """Karar istatistikleri (toplam entry/skip/exit sayıları)."""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT decision, COUNT(*) as cnt FROM audit_log GROUP BY decision"
        ).fetchall()
        return {r["decision"]: r["cnt"] for r in rows}
    finally:
        conn.close()


# ─── Bot State ────────────────────────────────────────────────────────────────

def get_bot_state(key: str, default=None):
    """Kalıcı bot state değeri oku."""
    conn = get_conn()
    try:
        row = conn.execute("SELECT value FROM bot_state WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def set_bot_state(key: str, value: str):
    """Kalıcı bot state değeri yaz."""
    conn = get_conn()
    try:
        conn.execute("""
            INSERT INTO bot_state (key, value, updated_at)
            VALUES (?, ?, strftime('%s','now'))
            ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                                           updated_at=strftime('%s','now')
        """, (key, value))
        conn.commit()
    finally:
        conn.close()


# ─── Init ────────────────────────────────────────────────────────────────────
init_db()
