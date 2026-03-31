"""
Polymarket Relayer v2 — Gasless CTF Token Redemption

HOLD_TO_RESOLUTION pozisyonları event resolve olduktan sonra bu
modül aracılığıyla otomatik olarak USDC'ye çevrilir.

Akış:
  1. HOLD_TO_RESOLUTION pozisyonları tara
  2. Event countdown ≤ 0 → redeem_position() çağır
  3. Başarılı → pozisyonu CLOSED olarak işaretle, PnL hesapla
  4. Başarısız → loglayıp bir sonraki turda tekrar dene
"""
import asyncio
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import httpx

logger = logging.getLogger("polyflow.relayer")

RELAYER_HOST  = "https://relayer-v2.polymarket.com"
CTF_CONTRACT  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
USDC_ADDRESS  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="relayer")
_claim_attempts: dict[str, int] = {}   # trade_id → deneme sayısı


# ─── Credential Yükleme ───────────────────────────────────────────────────────

def _load_credentials() -> dict:
    """.env dosyasından relayer credentials okur."""
    env_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"
    )
    result = {}
    if not os.path.exists(env_path):
        return result
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            result[k.strip()] = v.strip()
    return result


# ─── On-Chain Calldata ────────────────────────────────────────────────────────

def _build_redeem_calldata(condition_id_hex: str, side: str) -> str:
    """
    CTF redeemPositions calldata oluşturur.
    UP  → indexSets=[1]  (outcome 0)
    DOWN → indexSets=[2] (outcome 1)
    """
    from eth_abi import encode
    from eth_utils import keccak

    fn_selector = keccak(
        text="redeemPositions(address,bytes32,bytes32,uint256[])"
    ).hex()[:8]

    index_sets = [1] if side.upper() == "UP" else [2]
    hex_str = condition_id_hex.removeprefix("0x")
    if len(hex_str) % 2 != 0:
        hex_str = "0" + hex_str
    condition_bytes = bytes.fromhex(hex_str)

    calldata_params = encode(
        ["address", "bytes32", "bytes32", "uint256[]"],
        [USDC_ADDRESS, b"\x00" * 32, condition_bytes, index_sets],
    )
    return "0x" + fn_selector + calldata_params.hex()


# ─── Senkron Redemption (Thread Pool) ────────────────────────────────────────

def _do_redeem(
    private_key: str,
    relayer_api_key: str,
    relayer_address: str,
    condition_id_hex: str,
    side: str,
) -> dict:
    """Senkron CTF redemption — thread pool'da çalışır."""
    try:
        from py_builder_relayer_client.builder.safe import build_safe_transaction_request
        from py_builder_relayer_client.builder.derive import derive
        from py_builder_relayer_client.models import (
            SafeTransaction, OperationType, SafeTransactionArgs,
        )
        from py_builder_relayer_client.config import get_contract_config
        from py_builder_relayer_client.signer import Signer as BuilderSigner

        if not private_key.startswith("0x"):
            private_key = "0x" + private_key

        signer = BuilderSigner(private_key, chain_id=137)
        config  = get_contract_config(137)

        auth_headers = {
            "RELAYER_API_KEY":         relayer_api_key,
            "RELAYER_API_KEY_ADDRESS": relayer_address,
        }

        # 1. Nonce al
        resp = httpx.get(
            f"{RELAYER_HOST}/relay-payload?address={signer.address()}&type=SAFE",
            headers=auth_headers, timeout=15,
        )
        if resp.status_code != 200:
            return {"success": False, "error": f"Nonce alınamadı: HTTP {resp.status_code}"}
        nonce = resp.json().get("nonce")
        if nonce is None:
            return {"success": False, "error": "Nonce payload boş"}

        # 2. Calldata
        calldata = _build_redeem_calldata(condition_id_hex, side)
        txn = SafeTransaction(to=CTF_CONTRACT, operation=OperationType.Call,
                              data=calldata, value="0")
        args = SafeTransactionArgs(
            from_address=signer.address(), nonce=nonce,
            chain_id=137, transactions=[txn],
        )
        txn_request = build_safe_transaction_request(
            signer=signer, args=args, config=config
        ).to_dict()

        # 3. Submit
        sub = httpx.post(
            f"{RELAYER_HOST}/submit",
            headers={**auth_headers, "Content-Type": "application/json"},
            content=json.dumps(txn_request), timeout=30,
        )
        if sub.status_code != 200:
            return {"success": False, "error": f"Submit HTTP {sub.status_code}: {sub.text[:200]}"}

        result  = sub.json()
        tx_id   = result.get("transactionID", "")
        tx_hash = result.get("transactionHash", "")
        logger.info(f"Relayer submit OK — txID: {tx_id[:12]}... | txHash: {tx_hash[:12]}...")

        # 4. Onay bekle (max 60s)
        state = _poll_tx_state(tx_id, auth_headers)
        if state in ("STATE_CONFIRMED", "STATE_MINED", "STATE_EXECUTED"):
            return {"success": True, "tx_hash": tx_hash, "tx_id": tx_id, "state": state}
        elif state == "STATE_FAILED":
            return {"success": False, "error": f"TX zincirde başarısız: {tx_hash}"}
        else:
            # Zaman aşımı — TX gönderildi, hash var
            logger.warning(f"Relayer onay zaman aşımı (son: {state}) — tx: {tx_hash[:12]}...")
            return {"success": True, "tx_hash": tx_hash, "tx_id": tx_id, "state": state or "PENDING"}

    except ImportError as e:
        return {"success": False, "error": f"py-builder-relayer-client eksik: {e}"}
    except Exception as e:
        logger.error(f"_do_redeem hatası: {type(e).__name__}: {e}")
        return {"success": False, "error": str(e)}


def _poll_tx_state(tx_id: str, auth_headers: dict,
                   max_polls: int = 20, poll_interval: int = 3) -> Optional[str]:
    terminal = {"STATE_CONFIRMED", "STATE_MINED", "STATE_EXECUTED", "STATE_FAILED", "STATE_INVALID"}
    for _ in range(max_polls):
        try:
            r = httpx.get(f"{RELAYER_HOST}/transaction?id={tx_id}",
                          headers=auth_headers, timeout=10)
            if r.status_code == 200:
                data = r.json()
                items = data if isinstance(data, list) else [data]
                state = (items[0] if items else {}).get("state", "")
                if state in terminal:
                    return state
        except Exception:
            pass
        time.sleep(poll_interval)
    return None


# ─── Async Public API ─────────────────────────────────────────────────────────

async def redeem_position(condition_id: str, side: str) -> dict:
    """CTF pozisyonunu gasless olarak redeem eder. LIVE mod için."""
    creds = _load_credentials()
    pk             = creds.get("POLYMARKET_PRIVATE_KEY", "")
    relayer_key    = creds.get("POLYMARKET_RELAYER_API_KEY", "")
    relayer_addr   = creds.get("POLYMARKET_RELAYER_ADDRESS", "")

    if not pk or not relayer_key or not relayer_addr:
        return {"success": False, "error": "Relayer credentials eksik (.env)"}
    if not condition_id:
        return {"success": False, "error": "condition_id gerekli"}

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _executor,
        lambda: _do_redeem(pk, relayer_key, relayer_addr, condition_id, side),
    )


# ─── Auto-Claim Loop ──────────────────────────────────────────────────────────

async def auto_claim_loop(
    pos_tracker,
    countdown_getter,   # (event_key) → int saniye
    close_callback,     # (trade_id, exit_price, pnl, reason) → None
    mode_getter,        # () → "LIVE" | "PAPER"
) -> None:
    """Her 5sn HOLD_TO_RESOLUTION pozisyonlarını tarar, event bitince claim eder."""
    from backend.execution.models import TradeStatus

    while True:
        await asyncio.sleep(5)
        try:
            if mode_getter() != "LIVE":
                continue

            holds = [
                p for p in pos_tracker.get_all_positions()
                if p.trade_status == TradeStatus.HOLD_TO_RESOLUTION
            ]
            if not holds:
                continue

            for pos in holds:
                remaining = countdown_getter(pos.event_key)
                if remaining > 0:
                    continue  # Event henüz bitmedi

                trade_id    = pos.trade_id
                condition_id = pos.condition_id
                if not condition_id:
                    logger.warning(f"Auto-claim: condition_id yok — {trade_id}")
                    continue

                _claim_attempts[trade_id] = _claim_attempts.get(trade_id, 0) + 1
                attempt = _claim_attempts[trade_id]

                if attempt == 1 or attempt % 12 == 0:
                    logger.info(
                        f"Auto-claim {'başlatılıyor' if attempt == 1 else f'{attempt}. deneme'} "
                        f"— {trade_id} | {pos.side} | ${pos.amount:.2f}"
                    )

                result = await redeem_position(condition_id, pos.side)

                if result.get("success"):
                    _claim_attempts.pop(trade_id, None)
                    exit_price = 1.0
                    shares = pos.amount / pos.entry_actual if pos.entry_actual > 0 else 0
                    pnl = round(shares * exit_price - pos.amount, 4)
                    close_callback(trade_id, exit_price, pnl, "CLAIM")
                    logger.info(f"Auto-claim OK — {trade_id} | pnl: {pnl:+.4f} | tx: {result.get('tx_hash','')[:12]}...")
                else:
                    if attempt == 1 or attempt % 12 == 0:
                        logger.warning(
                            f"Auto-claim başarısız — {trade_id}: {result.get('error','?')} "
                            f"({attempt}. deneme)"
                        )
        except Exception as e:
            logger.error(f"auto_claim_loop hata: {e}")
