#!/usr/bin/env python3
"""Retired: the gift code site no longer exposes in-game display names.

ks-giftcode.centurygame.com was redesigned into a single-step form (Player ID +
Kingdom + code, one Confirm button). There is no login step and no .roleInfo
panel, so there is nothing to scrape names from. The 角色名稱 column in
kingshot_players.csv must now be maintained by hand.
"""

import sys

if __name__ == "__main__":
    sys.exit(__doc__)
