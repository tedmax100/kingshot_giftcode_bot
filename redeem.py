#!/usr/bin/env python3
"""Kingshot gift code redeemer (headless Playwright)."""

import argparse
import logging
import sys

from playwright.sync_api import TimeoutError as PWTimeout, sync_playwright

URL = "https://ks-giftcode.centurygame.com/"

logger = logging.getLogger("kingshot.redeem")


def redeem(player_id: str, code: str, headless: bool = True, timeout_ms: int = 15000) -> str:
    logger.info("player_id=%s", player_id)
    logger.info("gift_code=%s", code)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(timeout_ms)

        try:
            page.goto(URL, wait_until="domcontentloaded")

            page.locator(".roleId_con input").fill(player_id)
            page.locator(".login_btn").click()

            # Login resolved when the "Retreat" button (post-login) is rendered.
            page.get_by_text("Retreat", exact=True).wait_for(state="visible")

            page.locator(".code_con input").fill(code)
            page.locator(".exchange_btn").click()

            # Any popup text in the result modal counts as done.
            try:
                msg = page.locator(".message_modal .msg").first.inner_text(timeout=timeout_ms)
            except PWTimeout:
                msg = "(no result popup detected)"
            msg = msg.strip()
            logger.info("result=%s", msg)
            return msg
        finally:
            context.close()
            browser.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Redeem a Kingshot gift code.")
    parser.add_argument("--player-id", required=True, help="In-game Player ID")
    parser.add_argument("--code", required=True, help="Gift code to redeem")
    parser.add_argument("--headed", action="store_true", help="Show the browser (debug)")
    parser.add_argument("--timeout", type=int, default=15000, help="Per-action timeout in ms")
    parser.add_argument("--log-level", default="INFO", help="Logging level (DEBUG/INFO/WARNING/...)")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    try:
        redeem(args.player_id, args.code, headless=not args.headed, timeout_ms=args.timeout)
    except Exception:
        logger.exception("redeem failed")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
