#!/usr/bin/env python3
"""Manual IME reproduction: run inside a SessionBay Terminal pane.

Puts the PTY in raw mode and prints every read() chunk exactly as the
terminal sent it, so duplicated IME commits are visible as bytes, e.g.
  type `echo ` then commit 中文 with the IME -> expect b'\\xe4\\xb8\\xad\\xe6\\x96\\x87' once.
Press Ctrl+Q to quit. Reads only stdin; writes nothing outside the terminal.
"""
import os
import sys
import termios
import tty

fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
tty.setraw(fd)
try:
    while True:
        chunk = os.read(fd, 256)
        os.write(1, (repr(chunk) + "\r\n").encode())
        if b"\x11" in chunk:
            break
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
