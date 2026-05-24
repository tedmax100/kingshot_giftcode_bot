#!/usr/bin/env python3
"""Scrape active Kingshot gift codes from kingshot.net.

Outputs one code per line on stdout (suitable for piping).
"""

import argparse
import logging
import re
import sys
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

URL = "https://kingshot.net/gift-codes"

logger = logging.getLogger("kingshot.scrape_codes")

# Each card renders the code as <p class="font-mono ...">CODE</p>
CODE_P_CLASS_RE = re.compile(r"\bfont-mono\b")
# Optional expiry line inside the card, e.g. "Expires: 12/31/2026"
EXPIRY_RE = re.compile(r"Expires?:\s*(\d{1,2}/\d{1,2}/\d{4})", re.IGNORECASE)
EXPIRY_FMT = "%m/%d/%Y"
# Placeholder expiry for codes that don't publish one — sorts last-forever for --latest
NO_EXPIRY = datetime.max.replace(tzinfo=timezone.utc)


def _find_active_section(soup: BeautifulSoup):
    """Return the container that holds only the Active Gift Codes cards."""
    heading = soup.find(
        lambda tag: tag.name in {"h1", "h2", "h3"}
        and "active gift codes" in tag.get_text(strip=True).lower()
    )
    if heading is None:
        raise RuntimeError("could not find 'Active Gift Codes' heading on the page")

    # The cards live in a sibling grid container after the heading's wrapper.
    # Walk up until we find a node whose next sibling contains the cards grid.
    node = heading
    while node is not None:
        sibling = node.find_next_sibling()
        if sibling is not None and sibling.find(class_=CODE_P_CLASS_RE):
            return sibling
        node = node.parent
        # Stop climbing past the document root.
        if node is soup:
            break
    raise RuntimeError("could not locate cards grid after 'Active Gift Codes'")


def fetch_active_codes(timeout: int = 15) -> list[tuple[str, datetime]]:
    resp = requests.get(URL, timeout=timeout, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    section = _find_active_section(soup)

    now = datetime.now(timezone.utc)
    codes: list[tuple[str, datetime]] = []
    for card in section.find_all(attrs={"data-slot": "card"}):
        code_el = card.find("p", class_=CODE_P_CLASS_RE)
        if code_el is None:
            continue
        code = code_el.get_text(strip=True)
        if not code:
            continue

        expiry = NO_EXPIRY
        m = EXPIRY_RE.search(card.get_text(" ", strip=True))
        if m:
            try:
                expiry = datetime.strptime(m.group(1), EXPIRY_FMT).replace(tzinfo=timezone.utc)
            except ValueError as exc:
                logger.warning("bad expiry %r for %s: %s", m.group(1), code, exc)
                expiry = NO_EXPIRY

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
