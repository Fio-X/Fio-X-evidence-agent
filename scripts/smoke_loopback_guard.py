"""Test-only guard for the smoke scripts: refuse to start unless every model address they set is on this machine.

A smoke run must never reach a provider's public address, not even with a fake key (10-13: a fake-config run without an address sent one request to
the provider's public address and got HTTP 401). Standard library only; sends nothing.
"""
import re
import sys
from urllib.parse import urlparse

LOOPBACK = {"127.0.0.1", "localhost", "::1"}
ADDRESS_NAME = re.compile(r"(BASE_URL|LOCAL_URL)$")


def require_loopback(url: str, what: str = "address") -> None:
    parsed = urlparse(url or "")
    if parsed.scheme != "http" or parsed.hostname not in LOOPBACK:
        sys.exit(f"REFUSED: {what} is not http://127.0.0.1 or http://localhost (host: {parsed.hostname!r}); nothing was started.")


def check_env(env: dict, what: str = "child environment") -> None:
    """Every variable that names an address (…_BASE_URL, …_LOCAL_URL) must be loopback."""
    for name, value in env.items():
        if ADDRESS_NAME.search(name):
            require_loopback(value, f"{what}: {name}")


def check_env_file_text(text: str, what: str = "fake config file", need_address: bool = True) -> None:
    """Every KEY=value line that names an address must be loopback; with need_address, at least one must exist (a missing address makes the
    provider route fall back to its public address)."""
    seen = 0
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep and ADDRESS_NAME.search(key.strip()):
            seen += 1
            require_loopback(value.strip().strip("'\""), f"{what}: {key.strip()}")
    if need_address and not seen:
        sys.exit(f"REFUSED: {what} sets no model address, so the provider's public address would be used; nothing was started.")
