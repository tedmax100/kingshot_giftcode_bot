#!/usr/bin/env python3
"""Bulk-login each player ID in kingshot_players.csv and write back the
in-game display name to the 角色名稱 column."""

import argparse
import csv
import logging
import sys
from pathlib import Path

from playwright.sync_api import Page, TimeoutError as PWTimeout, sync_playwright

URL = "https://ks-giftcode.centurygame.com/"

logger = logging.getLogger("kingshot.update_names")


def fetch_display_name(page: Page, player_id: str, timeout_ms: int) -> str:
    page.goto(URL, wait_until="domcontentloaded")
    page.locator(".roleId_con input").fill(player_id)
    page.locator(".login_btn").click()
    page.locator(".roleInfo .name").wait_for(state="visible", timeout=timeout_ms)
    return page.locator(".roleInfo .name").first.inner_text().strip()


def run(csv_path: Path, headless: bool, timeout_ms: int) -> int:
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))

    if not rows or rows[0][:2] != ["ID", "角色名稱"]:
        logger.error("unexpected CSV header: %r", rows[0] if rows else None)
        return 1

    header, data_rows = rows[0], rows[1:]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(timeout_ms)

        try:
            for row in data_rows:
                if not row or not row[0].strip():
                    continue
                player_id = row[0].strip()
                old_name = row[1] if len(row) > 1 else ""
                try:
                    name = fetch_display_name(page, player_id, timeout_ms)
                except PWTimeout:
                    logger.warning("player_id=%s timeout — keeping old name=%r", player_id, old_name)
                    continue
                except Exception as exc:
                    logger.warning("player_id=%s failed: %s — keeping old name=%r", player_id, exc, old_name)
                    continue

                if name != old_name:
                    logger.info("player_id=%s name=%r (was %r)", player_id, name, old_name)
                else:
                    logger.info("player_id=%s name=%r (unchanged)", player_id, name)

                if len(row) < 2:
                    row.append(name)
                else:
                    row[1] = name
        finally:
            context.close()
            browser.close()

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(data_rows)

    logger.info("wrote %s", csv_path)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", default="kingshot_players.csv", help="CSV path")
    parser.add_argument("--headed", action="store_true", help="Show the browser (debug)")
    parser.add_argument("--timeout", type=int, default=15000, help="Per-action timeout in ms")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    return run(Path(args.csv), headless=not args.headed, timeout_ms=args.timeout)


if __name__ == "__main__":
    sys.exit(main())
