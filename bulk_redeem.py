#!/usr/bin/env python3
"""Redeem one or more gift codes for every player ID in kingshot_players.csv.

Codes can be supplied via repeated --code flags or by passing --codes-from-scrape
to fetch the current active list from kingshotguides.com.
"""

import argparse
import csv
import logging
import random
import sys
import time
from collections import Counter
from pathlib import Path

from playwright.sync_api import Page, TimeoutError as PWTimeout, sync_playwright

from scrape_codes import fetch_active_codes

URL = "https://ks-giftcode.centurygame.com/"
MSG_SUCCESS = "Redeemed, please claim the rewards in your mail!"
MSG_ALREADY = "Already claimed, unable to claim again."

logger = logging.getLogger("kingshot.bulk_redeem")


def classify(msg: str) -> str:
    if msg == MSG_SUCCESS:
        return "success"
    if msg == MSG_ALREADY:
        return "already_claimed"
    return "other"


def login(page: Page, player_id: str, timeout_ms: int) -> str:
    page.goto(URL, wait_until="domcontentloaded")
    page.locator(".roleId_con input").fill(player_id)
    page.locator(".login_btn").click()
    page.locator(".roleInfo .name").wait_for(state="visible", timeout=timeout_ms)
    return page.locator(".roleInfo .name").first.inner_text().strip()


def submit_code(page: Page, code: str, timeout_ms: int) -> str:
    code_input = page.locator(".code_con input")
    code_input.fill("")
    code_input.fill(code)
    page.locator(".exchange_btn").click()
    try:
        msg = page.locator(".message_modal .msg").first.inner_text(timeout=timeout_ms).strip()
    except PWTimeout:
        return "(no result popup detected)"

    # Dismiss the modal so the next code can be entered.
    try:
        page.locator(".message_modal").get_by_text("Confirm", exact=True).click(timeout=2000)
        page.locator(".message_modal").wait_for(state="detached", timeout=timeout_ms)
    except PWTimeout:
        logger.debug("modal did not dismiss cleanly; continuing")
    return msg


def jitter_sleep() -> None:
    """Sleep 3 + random(1..5) seconds to spread requests."""
    delay = 3 + random.uniform(1, 5)
    logger.debug("sleeping %.2fs", delay)
    time.sleep(delay)


def run(csv_path: Path, codes: list[str], headless: bool, timeout_ms: int) -> int:
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))

    if not rows or rows[0][:2] != ["ID", "角色名稱"]:
        logger.error("unexpected CSV header: %r", rows[0] if rows else None)
        return 1

    data_rows = [r for r in rows[1:] if r and r[0].strip()]
    logger.info("starting bulk redeem codes=%s players=%d", codes, len(data_rows))

    per_code: dict[str, Counter[str]] = {c: Counter() for c in codes}
    failures: list[tuple[str, str, str]] = []  # (player_id, code, reason)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(timeout_ms)

        try:
            for idx, row in enumerate(data_rows):
                player_id = row[0].strip()
                if idx > 0:
                    jitter_sleep()
                try:
                    name = login(page, player_id, timeout_ms)
                except PWTimeout as exc:
                    logger.warning("player_id=%s login timeout (%s)", player_id, exc)
                    for code in codes:
                        per_code[code]["login_timeout"] += 1
                        failures.append((player_id, code, f"login_timeout: {exc}"))
                    continue
                except Exception as exc:
                    logger.warning("player_id=%s login error: %s", player_id, exc)
                    for code in codes:
                        per_code[code]["login_error"] += 1
                        failures.append((player_id, code, f"login_error: {exc}"))
                    continue

                for code_idx, code in enumerate(codes):
                    if code_idx > 0:
                        jitter_sleep()
                    try:
                        msg = submit_code(page, code, timeout_ms)
                    except Exception as exc:
                        logger.warning("player_id=%s code=%s error: %s", player_id, code, exc)
                        per_code[code]["error"] += 1
                        failures.append((player_id, code, f"error: {exc}"))
                        # Re-login to recover for next code.
                        try:
                            login(page, player_id, timeout_ms)
                        except Exception:
                            break
                        continue

                    outcome = classify(msg)
                    per_code[code][outcome] += 1
                    logger.info(
                        "player_id=%s name=%r code=%s outcome=%s msg=%r",
                        player_id, name, code, outcome, msg,
                    )
                    if outcome == "other":
                        failures.append((player_id, code, msg))
        finally:
            context.close()
            browser.close()

    logger.info("=== summary ===")
    for code in codes:
        c = per_code[code]
        logger.info(
            "code=%s success=%d already=%d other=%d login_timeout=%d login_error=%d error=%d",
            code, c["success"], c["already_claimed"], c["other"],
            c["login_timeout"], c["login_error"], c["error"],
        )
    if failures:
        logger.info("=== failures / unexpected outcomes ===")
        for pid, code, reason in failures:
            logger.info("  player_id=%s code=%s reason=%r", pid, code, reason)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", default="kingshot_players.csv", help="CSV path")
    parser.add_argument("--code", action="append", default=[], help="Gift code (repeatable)")
    parser.add_argument("--codes-from-scrape", action="store_true",
                        help="Fetch active codes from kingshotguides.com")
    parser.add_argument("--latest", type=int, default=0,
                        help="With --codes-from-scrape, keep only N codes with the latest expiry")
    parser.add_argument("--headed", action="store_true", help="Show the browser (debug)")
    parser.add_argument("--timeout", type=int, default=15000, help="Per-action timeout in ms")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    codes = list(args.code)
    if args.codes_from_scrape:
        try:
            scraped = fetch_active_codes()
        except Exception:
            logger.exception("failed to scrape active codes")
            return 1
        if args.latest > 0:
            scraped = sorted(scraped, key=lambda x: x[1], reverse=True)[: args.latest]
        scraped_codes = [c for c, _ in scraped]
        logger.info("scraped %d active codes: %s", len(scraped_codes), scraped_codes)
        codes.extend(scraped_codes)

    # Deduplicate while preserving order
    seen: set[str] = set()
    codes = [c for c in codes if not (c in seen or seen.add(c))]

    if not codes:
        parser.error("no codes provided — use --code or --codes-from-scrape")

    return run(Path(args.csv), codes, headless=not args.headed, timeout_ms=args.timeout)


if __name__ == "__main__":
    sys.exit(main())
