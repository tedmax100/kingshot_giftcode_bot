#!/usr/bin/env python3
"""Kingshot gift code redeemer (headless Playwright)."""

import argparse
import logging
import sys

from playwright.sync_api import TimeoutError as PWTimeout, sync_playwright

URL = "https://ks-giftcode.centurygame.com/"

logger = logging.getLogger("kingshot.redeem")


def redeem(player_id: str, kingdom: str, code: str,
           headless: bool = True, timeout_ms: int = 15000) -> str:
    logger.info("player_id=%s", player_id)
    logger.info("kingdom=%s", kingdom)
    logger.info("gift_code=%s", code)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(timeout_ms)

        try:
            page.goto(URL, wait_until="domcontentloaded")

            # Single-page form: Player ID + Kingdom + code, submitted with one Confirm.
            page.locator(".roleId_con input[placeholder='Player ID']").fill(player_id)
            page.locator(".roleId_con input[placeholder='Kingdom']").fill(kingdom)
            page.locator(".code_con input").first.fill(code)

            # Confirm stays .disabled until all three fields are valid.
            page.wait_for_function(
                "() => { const b = document.querySelector('.exchange_btn');"
                " return b && !b.classList.contains('disabled'); }",
                timeout=timeout_ms,
            )
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
    parser.add_argument("--kingdom", required=True, help="In-game Kingdom number")
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
        redeem(args.player_id, args.kingdom, args.code,
               headless=not args.headed, timeout_ms=args.timeout)
    except Exception:
        logger.exception("redeem failed")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
