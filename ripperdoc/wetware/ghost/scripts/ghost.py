#!/usr/bin/env python3

import base64
import os
import sys
from pathlib import Path

PLUGIN_ROOT = Path(
    os.environ.get("CLAUDE_PLUGIN_ROOT") or os.environ.get("PLUGIN_ROOT") or str(Path(__file__).resolve().parent.parent)
)

MAPPINGS: list[tuple[str, str]] = [
    ("ENGRAM.md", "engram.dat"),
    ("FIRMWARE.md", "firmware.dat"),
    ("PULSE.md", "pulse.dat"),
]


def encode() -> None:
    for md_name, dat_name in MAPPINGS:
        md = PLUGIN_ROOT / md_name
        if not md.exists():
            continue
        dat = PLUGIN_ROOT / dat_name
        dat.write_bytes(base64.b64encode(md.read_bytes()))
        md.unlink()
        print(f"{md_name} -> {dat_name}")


def decode() -> None:
    for md_name, dat_name in MAPPINGS:
        dat = PLUGIN_ROOT / dat_name
        if not dat.exists():
            continue
        md = PLUGIN_ROOT / md_name
        md.write_bytes(base64.b64decode(dat.read_bytes()))
        print(f"{dat_name} -> {md_name}")


def flatline() -> None:
    stock_dir = PLUGIN_ROOT / "stock"
    for md_name, _ in MAPPINGS:
        src = stock_dir / md_name
        if not src.exists():
            continue
        dst = PLUGIN_ROOT / md_name
        dst.write_bytes(src.read_bytes())
    encode()
    print("persona wiped to stock")


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else None
    if cmd == "encode":
        encode()
    elif cmd == "decode":
        decode()
    elif cmd == "flatline":
        flatline()
    else:
        print("Usage: ghost.py {encode|decode|flatline}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
