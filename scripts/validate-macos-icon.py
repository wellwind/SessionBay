#!/usr/bin/env python3
"""Read-only check of the ICNS representations emitted by Tauri's icon CLI.

Uses only Python's standard library. The macOS artwork occupies 412 of 512
pixels, centered with a 50-pixel inset. At each resolution, nonzero-alpha bounds
must be within one pixel of that scaled inset, with at most one pixel of
asymmetry. Every outer edge must be fully transparent. --report-only skips
padding assertions, but still rejects malformed or incomplete icon families.

Usage: python3 scripts/validate-macos-icon.py [path/to/icon.icns] [--report-only]
"""

import argparse
from pathlib import Path
import struct
import sys
import zlib


PNG_SIZES = {
    b"ic11": 32, b"ic12": 64, b"ic07": 128, b"ic08": 256,
    b"ic13": 256, b"ic09": 512, b"ic14": 512, b"ic10": 1024,
}
LEGACY_PAIRS = {b"is32": (b"s8mk", 16), b"il32": (b"l8mk", 32)}
EXPECTED_TYPES = set(PNG_SIZES) | set(LEGACY_PAIRS) | {
    mask for mask, _ in LEGACY_PAIRS.values()
}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_icns(data):
    """Require the complete, duplicate-free set generated for this project."""
    require(len(data) >= 8 and data[:4] == b"icns", "invalid ICNS header")
    require(struct.unpack_from(">I", data, 4)[0] == len(data),
            "ICNS declared length does not match file length")
    entries = {}
    offset = 8
    while offset < len(data):
        require(offset + 8 <= len(data), "truncated ICNS entry header")
        kind, length = struct.unpack_from(">4sI", data, offset)
        require(length >= 8 and offset + length <= len(data),
                f"{kind!r}: invalid or truncated ICNS entry length")
        require(kind not in entries, f"{kind!r}: duplicate ICNS entry")
        entries[kind] = data[offset + 8:offset + length]
        offset += length
    missing = EXPECTED_TYPES - entries.keys()
    extra = entries.keys() - EXPECTED_TYPES
    require(not missing, f"missing ICNS representations/masks: {sorted(missing)}")
    require(not extra, f"unsupported ICNS entries: {sorted(extra)}")
    return entries


def validate_rgb(data, size):
    """Validate Tauri's legacy planar RGB RLE, including channel boundaries."""
    offset = 0
    for _ in range(3):
        pixels = 0
        while pixels < size * size:
            require(offset < len(data), "truncated legacy RGB run")
            control = data[offset]
            offset += 1
            count = control - 125 if control >= 128 else control + 1
            payload_size = 1 if control >= 128 else count
            require(pixels + count <= size * size, "legacy RGB run exceeds channel")
            require(offset + payload_size <= len(data), "truncated legacy RGB data")
            offset += payload_size
            pixels += count
    require(offset == len(data), "trailing legacy RGB data")


def paeth(left, above, upper_left):
    estimate = left + above - upper_left
    distances = (abs(estimate - left), abs(estimate - above),
                 abs(estimate - upper_left))
    if distances[0] <= distances[1] and distances[0] <= distances[2]:
        return left
    return above if distances[1] <= distances[2] else upper_left


def png_alpha(data, size):
    """Decode noninterlaced 8-bit RGBA PNGs, checking lengths, CRCs and filters."""
    require(data.startswith(PNG_SIGNATURE), "expected PNG image payload")
    offset = len(PNG_SIGNATURE)
    seen = []
    compressed = bytearray()
    idat_ended = False
    while offset < len(data):
        require(offset + 12 <= len(data), "truncated PNG chunk header")
        length, kind = struct.unpack_from(">I4s", data, offset)
        end = offset + length + 12
        require(end <= len(data), f"{kind!r}: truncated PNG chunk")
        payload = data[offset + 8:end - 4]
        crc = struct.unpack_from(">I", data, end - 4)[0]
        require(zlib.crc32(kind + payload) == crc, f"{kind!r}: invalid PNG CRC")
        require(all(65 <= c <= 90 or 97 <= c <= 122 for c in kind),
                "invalid PNG chunk type")
        require(not kind[2] & 32, "invalid PNG reserved chunk-type bit")
        require(seen or kind == b"IHDR", "PNG must start with IHDR")
        if kind == b"IHDR":
            require(not seen and length == 13, "invalid or repeated PNG IHDR")
            header = struct.unpack(">IIBBBBB", payload)
            require(header == (size, size, 8, 6, 0, 0, 0),
                    f"expected {size}x{size} 8-bit RGBA PNG, got {header}")
        elif kind == b"IDAT":
            require(not idat_ended, "nonconsecutive PNG IDAT chunks")
            compressed.extend(payload)
        elif kind == b"IEND":
            require(length == 0 and b"IDAT" in seen and end == len(data),
                    "invalid PNG IEND, missing image data or trailing bytes")
        elif kind == b"PLTE":
            require(kind not in seen and b"IDAT" not in seen
                    and 0 < length <= 768 and length % 3 == 0,
                    "invalid PNG palette")
        else:
            require(kind[0] & 32, f"unsupported critical PNG chunk {kind!r}")
            require(kind not in (b"tRNS", b"acTL", b"fcTL", b"fdAT"),
                    f"unsupported PNG transparency/animation chunk {kind!r}")
        if b"IDAT" in seen and kind != b"IDAT":
            idat_ended = True
        seen.append(kind)
        offset = end
    require(seen and seen[-1] == b"IEND", "missing PNG IEND")
    stride = size * 4
    expected_length = (stride + 1) * size
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, expected_length + 1)
    require(len(raw) == expected_length and decoder.eof
            and not decoder.unused_data and not decoder.unconsumed_tail,
            "invalid PNG decompressed size or compressed stream")
    alpha = bytearray()
    previous = bytearray(stride)
    for start in range(0, len(raw), stride + 1):
        mode = raw[start]
        require(mode <= 4, f"invalid PNG row filter {mode}")
        row = bytearray(raw[start + 1:start + stride + 1])
        if mode:
            for x in range(stride):
                left = row[x - 4] if x >= 4 else 0
                above = previous[x]
                upper_left = previous[x - 4] if x >= 4 else 0
                if mode == 1:
                    predictor = left
                elif mode == 2:
                    predictor = above
                elif mode == 3:
                    predictor = (left + above) // 2
                else:
                    predictor = paeth(left, above, upper_left)
                row[x] = (row[x] + predictor) & 255
        alpha.extend(row[3::4])
        previous = row
    return alpha


def alpha_bounds(alpha, size):
    """Return nonzero-alpha bounds as left, top, right, bottom (exclusive)."""
    left = top = size
    right = bottom = 0
    for y in range(size):
        row = alpha[y * size:(y + 1) * size]
        occupied = [x for x, value in enumerate(row) if value]
        if occupied:
            left = min(left, occupied[0])
            right = max(right, occupied[-1] + 1)
            top = min(top, y)
            bottom = y + 1
    require(right > left and bottom > top, "fully transparent representation")
    return left, top, right, bottom


def inspect(data, report_only=False):
    entries = read_icns(data)
    failures = []
    count = 0
    for kind, payload in entries.items():
        label = kind.decode("ascii")
        try:
            if kind in LEGACY_PAIRS:
                mask, size = LEGACY_PAIRS[kind]
                validate_rgb(payload, size)
                alpha = entries[mask]
                require(len(alpha) == size * size, "incorrect legacy alpha-mask length")
                label += "/" + mask.decode("ascii")
            elif kind in PNG_SIZES:
                size = PNG_SIZES[kind]
                alpha = png_alpha(payload, size)
            else:
                continue  # Legacy masks were checked with their RGB representation.
            bounds = alpha_bounds(alpha, size)
            left, top, right, bottom = bounds
            margins = (left, top, size - right, size - bottom)
            expected = size * 50 / 512
            print(f"{label:9} {size:4}x{size:<4} alpha_bbox={bounds} "
                  f"margins(L,T,R,B)={margins} expected={expected:g}")
            count += 1
            if not report_only:
                require(min(margins) >= 1, "outer edges must be fully transparent")
                require(all(abs(margin - expected) <= 1 for margin in margins),
                        "padding differs from the scaled 50/512 inset by more than 1 pixel")
                require(abs(margins[0] - margins[2]) <= 1
                        and abs(margins[1] - margins[3]) <= 1,
                        "nonzero-alpha bounds are not centered")
        except (ValueError, zlib.error) as error:
            failures.append(f"{label}: {error}")
    require(not failures, "\n".join(failures))
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", type=Path, default=(
        Path(__file__).resolve().parents[1] / "src-tauri/icons/icon.icns"))
    parser.add_argument("--report-only", action="store_true",
                        help="report baseline bounds without checking padding")
    args = parser.parse_args()
    try:
        count = inspect(args.path.read_bytes(), args.report_only)
    except (OSError, ValueError, zlib.error) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"{'Reported' if args.report_only else 'PASS:'} {count} representations "
          f"in {args.path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
