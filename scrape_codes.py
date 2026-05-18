#!/usr/bin/env python3
"""Scrape active Kingshot gift codes from kingshotguides.com.

Outputs one code per line on stdout (suitable for piping).
"""

import argparse
import logging
import re
import sys
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

URL = "https://kingshotguides.com/guide/active-giftcodes-and-how-to-redeem/"

logger = logging.getLogger("kingshot.scrape_codes")

# Lines look like: "KS0518 - Expires: May 21, 2026 00:00 UTC"
LINE_RE = re.compile(r"^\s*(\S+)\s*-\s*Expires:\s*(.+?)\s*UTC\s*$")
EXPIRY_FMT = "%b %d, %Y %H:%M"


def fetch_active_codes(timeout: int = 15) -> list[tuple[str, datetime]]:
    resp = requests.get(URL, timeout=timeout, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    ul = soup.select_one("ul.kgc-active-list")
    if ul is None:
        raise RuntimeError("could not find ul.kgc-active-list on the page")

    now = datetime.now(timezone.utc)
    codes: list[tuple[str, datetime]] = []
    for li in ul.find_all("li"):
        text = li.get_text(" ", strip=True)
        m = LINE_RE.match(text)
        if not m:
            logger.warning("unparseable line: %r", text)
            continue
        code, expiry_str = m.group(1), m.group(2)
        try:
            expiry = datetime.strptime(expiry_str, EXPIRY_FMT).replace(tzinfo=timezone.utc)
        except ValueError as exc:
            logger.warning("bad expiry %r for %s: %s", expiry_str, code, exc)
            continue
        if expiry <= now:
            logger.info("skipping expired code=%s expiry=%s", code, expiry.isoformat())
            continue
        codes.append((code, expiry))
    return codes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--latest", type=int, default=0,
                        help="Keep only N codes with the latest expiry (0 = all)")
    parser.add_argument("--log-level", default="WARNING")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.WARNING),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    try:
        codes = fetch_active_codes()
    except Exception:
        logger.exception("failed to fetch codes")
        return 1

    if args.latest > 0:
        codes = sorted(codes, key=lambda x: x[1], reverse=True)[: args.latest]

    for code, _expiry in codes:
        print(code)
    logger.info("found %d active codes", len(codes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
