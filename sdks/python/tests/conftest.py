"""Shared fixtures: load the golden vectors via a relative path to test/vectors.

The golden vectors are the parity oracle. They live in the repo at
``<repo>/test/vectors/{online_assertion,config_attestation}/`` — four levels up
from this file (``sdks/python/tests`` -> repo root).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

# tests/ -> python/ -> sdks/ -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[3]
_VECTORS = _REPO_ROOT / "test" / "vectors"
ONLINE_DIR = _VECTORS / "online_assertion"
CONFIG_DIR = _VECTORS / "config_attestation"


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


@dataclass(frozen=True)
class OnlineGolden:
    token: str
    payload: str  # exact canonical payload bytes (as text)
    key_id: str
    public_key_der: bytes


@dataclass(frozen=True)
class ConfigGolden:
    token: str
    key_id: str
    config_bytes: bytes
    public_key_der: bytes


@pytest.fixture(scope="session")
def vectors_dir() -> Path:
    assert _VECTORS.is_dir(), f"golden vectors not found at {_VECTORS}"
    return _VECTORS


@pytest.fixture(scope="session")
def online_golden() -> OnlineGolden:
    return OnlineGolden(
        token=_read_text(ONLINE_DIR / "golden.assertion").strip(),
        payload=_read_text(ONLINE_DIR / "golden.payload"),
        key_id=_read_text(ONLINE_DIR / "golden.key_id").strip(),
        public_key_der=bytes.fromhex(
            _read_text(ONLINE_DIR / "golden.public_key.pkcs1.der.hex").strip()
        ),
    )


@pytest.fixture(scope="session")
def config_golden() -> ConfigGolden:
    return ConfigGolden(
        token=_read_text(CONFIG_DIR / "golden.token").strip(),
        key_id=_read_text(CONFIG_DIR / "golden.key_id").strip(),
        config_bytes=(CONFIG_DIR / "golden.config").read_bytes(),
        public_key_der=bytes.fromhex(
            _read_text(CONFIG_DIR / "golden.public_key.pkcs1.der.hex").strip()
        ),
    )


@pytest.fixture(scope="session")
def embedded_config_golden() -> ConfigGolden:
    # The embedded golden uses the build-time embedded key ring; its PKCS#1 DER
    # is recorded in the cmake record file as a comma-separated byte list.
    record = _read_text(CONFIG_DIR / "embedded_golden_public_key_record.cmake.txt")
    inner = record[record.index("std::vector<uint8_t>{") + len("std::vector<uint8_t>{") :]
    inner = inner[: inner.index("}")]
    der = bytes(int(x) for x in inner.split(","))
    return ConfigGolden(
        token=_read_text(CONFIG_DIR / "embedded_golden.token").strip(),
        key_id=_read_text(CONFIG_DIR / "embedded_golden.key_id").strip(),
        config_bytes=(CONFIG_DIR / "embedded_golden.config").read_bytes(),
        public_key_der=der,
    )
