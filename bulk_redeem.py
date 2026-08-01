#!/usr/bin/env python3
"""Redeem one or more gift codes for every player ID in kingshot_players.csv.

Codes can be supplied via repeated --code flags or by passing --codes-from-scrape
to fetch the current active list from kingshotguides.com.

The site requires a Kingdom alongside the Player ID. Each player's kingdom is
cached in the CSV's Kingdom column; players without one are probed against the
--kingdom candidates in order and the accepted value is written back.
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
MSG_SUCCESS = "Redeemed successfully. Please check your mail for rewards!"
MSG_ALREADY = "Gift has already been claimed!"
MSG_BAD_CHARACTER = "Character info is incorrect. Please confirm and try again."

KINGDOM_COL = "Kingdom"
DEFAULT_KINGDOMS = ["1034", "1000"]

logger = logging.getLogger("kingshot.bulk_redeem")


def classify(msg: str) -> str:
    if msg == MSG_SUCCESS:
        return "success"
    if msg == MSG_ALREADY:
        return "already_claimed"
    if msg == MSG_BAD_CHARACTER:
        return "bad_character"
    return "other"


def submit_code(page: Page, player_id: str, kingdom: str, code: str, timeout_ms: int) -> str:
    """Fill the single-page form (Player ID + Kingdom + code) and read the result modal.

    The site has no separate login step: everything is submitted with one Confirm.
    """
    page.goto(URL, wait_until="domcontentloaded")
    page.locator(".roleId_con input[placeholder='Player ID']").fill(player_id)
    page.locator(".roleId_con input[placeholder='Kingdom']").fill(kingdom)
    code_input = page.locator(".code_con input").first
    code_input.fill("")
    code_input.fill(code)

    # Confirm stays .disabled until all three fields are valid.
    exchange = page.locator(".exchange_btn")
    page.wait_for_function(
        "() => { const b = document.querySelector('.exchange_btn');"
        " return b && !b.classList.contains('disabled'); }",
        timeout=timeout_ms,
    )
    exchange.click()
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


def resolve_kingdom(page: Page, player_id: str, kingdoms: list[str], code: str,
                    timeout_ms: int) -> tuple[str | None, str]:
    """Try each candidate kingdom until one is accepted for this player.

    The site gives no way to look a player's kingdom up, so the redeem itself is
    the probe: a wrong kingdom comes back as MSG_BAD_CHARACTER. Returns the
    kingdom that worked (or None if none did) plus that attempt's message, so
    the caller can count the redeem instead of repeating it.
    """
    msg = ""
    for i, kingdom in enumerate(kingdoms):
        if i > 0:
            jitter_sleep()
        msg = submit_code(page, player_id, kingdom, code, timeout_ms)
        if classify(msg) != "bad_character":
            return kingdom, msg
        logger.debug("player_id=%s kingdom=%s rejected", player_id, kingdom)
    return None, msg


def run(csv_path: Path, codes: list[str], kingdoms: list[str],
        headless: bool, timeout_ms: int) -> int:
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))

    if not rows or rows[0][:2] != ["ID", "角色名稱"]:
        logger.error("unexpected CSV header: %r", rows[0] if rows else None)
        return 1

    # The Kingdom column caches each player's resolved kingdom across runs.
    header = rows[0]
    if KINGDOM_COL not in header:
        header.append(KINGDOM_COL)
    kingdom_col = header.index(KINGDOM_COL)

    data_rows = [r for r in rows[1:] if r and r[0].strip()]
    for row in data_rows:
        while len(row) <= kingdom_col:
            row.append("")

    logger.info("starting bulk redeem codes=%s players=%d kingdoms=%s",
                codes, len(data_rows), kingdoms)

    per_code: dict[str, Counter[str]] = {c: Counter() for c in codes}
    failures: list[tuple[str, str, str]] = []  # (player_id, code, reason)
    csv_changed = False

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(timeout_ms)

        try:
            for idx, row in enumerate(data_rows):
                player_id = row[0].strip()
                name = row[1] if len(row) > 1 else ""
                known = row[kingdom_col].strip()
                # A cached kingdom is used as-is; otherwise probe the candidates
                # in order and remember whichever one the site accepts.
                kingdom: str | None = known or None

                for code_idx, code in enumerate(codes):
                    if idx > 0 or code_idx > 0:
                        jitter_sleep()
                    try:
                        if kingdom is None:
                            kingdom, msg = resolve_kingdom(
                                page, player_id, kingdoms, code, timeout_ms)
                            if kingdom is None:
                                logger.warning(
                                    "player_id=%s no kingdom matched %s", player_id, kingdoms)
                            else:
                                logger.info("player_id=%s resolved kingdom=%s",
                                            player_id, kingdom)
                                row[kingdom_col] = kingdom
                                csv_changed = True
                        else:
                            msg = submit_code(page, player_id, kingdom, code, timeout_ms)
                    except Exception as exc:
                        logger.warning("player_id=%s code=%s error: %s", player_id, code, exc)
                        per_code[code]["error"] += 1
                        failures.append((player_id, code, f"error: {exc}"))
                        continue

                    outcome = classify(msg)
                    per_code[code][outcome] += 1
                    logger.info(
                        "player_id=%s name=%r code=%s outcome=%s msg=%r",
                        player_id, name, code, outcome, msg,
                    )
                    if outcome in ("other", "bad_character"):
                        failures.append((player_id, code, msg))

                    if kingdom is None:
                        # No candidate was accepted — the remaining codes would
                        # fail identically, so don't re-probe for each one.
                        for skipped in codes[code_idx + 1:]:
                            per_code[skipped]["bad_character"] += 1
                            failures.append((player_id, skipped, msg))
                        break
        finally:
            context.close()
            browser.close()

    if csv_changed:
        with csv_path.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f, lineterminator="\n").writerows([header] + data_rows)
        logger.info("wrote resolved kingdoms back to %s", csv_path)

    logger.info("=== summary ===")
    for code in codes:
        c = per_code[code]
        logger.info(
            "code=%s success=%d already=%d bad_character=%d other=%d error=%d",
            code, c["success"], c["already_claimed"], c["bad_character"],
            c["other"], c["error"],
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
    parser.add_argument("--kingdom", action="append", default=[],
                        help="Candidate kingdom, tried in order for players with no cached "
                             f"Kingdom in the CSV (repeatable; default {DEFAULT_KINGDOMS})")
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

    return run(Path(args.csv), codes, args.kingdom or DEFAULT_KINGDOMS,
               headless=not args.headed, timeout_ms=args.timeout)


if __name__ == "__main__":
    sys.exit(main())
