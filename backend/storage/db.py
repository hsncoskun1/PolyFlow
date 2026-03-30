"""
SQLite veritabani yonetimi.
Position, Order, Trade tablolari.
"""
import sqlite3
import json
import os
from pathlib import Path
from datetime import datetime

DB_PATH = Path(__file__).parent.parent.parent / "bot.db"


def get_conn() -> sqlite3.Connection:
    """SQLite baglantisi don."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Tablolari olustur (yoksa)."""
    conn = get_conn()
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
        pnl REAL DEFAULT 0,
        status TEXT DEFAULT 'OPEN',
        mode TEXT DEFAULT 'PAPER',
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
    """)
    conn.commit()
    conn.close()


# ─── Position CRUD ───────────────────────────────────────────────────────────

def save_position(pos: dict):
    conn = get_conn()
    conn.execute("""
        INSERT OR REPLACE INTO positions
        (id, asset, event_key, event_slug, side, entry_price, current_price,
         target_price, stop_loss, amount, pnl, status, mode, entry_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        pos["id"], pos.get("asset",""), pos.get("event_key",""), pos.get("event_slug",""),
        pos.get("side","UP"), pos.get("entry_price",0), pos.get("current_price",0),
        pos.get("target_price",0), pos.get("stop_loss",0), pos.get("amount",0),
        pos.get("pnl",0), pos.get("status","OPEN"), pos.get("mode","PAPER"),
        pos.get("entry_time",""),
    ))
    conn.commit()
    conn.close()


def close_position(pos_id: str, exit_price: float, reason: str):
    conn = get_conn()
    conn.execute("""
        UPDATE positions SET status='CLOSED', close_reason=?, close_time=?, current_price=?
        WHERE id=?
    """, (reason, datetime.now().isoformat(), exit_price, pos_id))
    conn.commit()
    conn.close()


def get_open_positions() -> list[dict]:
    conn = get_conn()
    rows = conn.execute("SELECT * FROM positions WHERE status='OPEN' ORDER BY created_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_positions(limit: int = 100) -> list[dict]:
    conn = get_conn()
    rows = conn.execute("SELECT * FROM positions ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ─── Trade CRUD ──────────────────────────────────────────────────────────────

def save_trade(trade: dict):
    conn = get_conn()
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
    conn.close()


def get_trades(limit: int = 100) -> list[dict]:
    conn = get_conn()
    rows = conn.execute("SELECT * FROM trades ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_daily_trade_count() -> int:
    conn = get_conn()
    today = datetime.now().strftime("%Y-%m-%d")
    row = conn.execute("SELECT COUNT(*) as cnt FROM trades WHERE date(created_at)=?", (today,)).fetchone()
    conn.close()
    return row["cnt"] if row else 0


def get_daily_pnl() -> float:
    conn = get_conn()
    today = datetime.now().strftime("%Y-%m-%d")
    row = conn.execute("SELECT COALESCE(SUM(pnl),0) as total FROM trades WHERE date(created_at)=?", (today,)).fetchone()
    conn.close()
    return row["total"] if row else 0.0


# ─── Event Log ───────────────────────────────────────────────────────────────

def log_event(event_key: str, slug: str, ptb: float):
    conn = get_conn()
    conn.execute("""
        INSERT INTO events_log (event_key, event_slug, ptb, open_time)
        VALUES (?, ?, ?, ?)
    """, (event_key, slug, ptb, datetime.now().isoformat()))
    conn.commit()
    conn.close()


# ─── Init ────────────────────────────────────────────────────────────────────
init_db()
