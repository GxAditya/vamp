#!/usr/bin/env python3
"""Import and check generated Vamp Python schema types using only the stdlib.

The generated TypedDicts are data declarations, not a validator. This script
ensures the module imports, forward references resolve, required and optional
keys match the schema, and generated unions are present. It intentionally does
not require a Python SDK or third-party packages.
"""

from __future__ import annotations

import sys
import typing
from pathlib import Path

PACKAGE_PYTHON_ROOT = Path(__file__).resolve().parent.parent / "python"
sys.path.insert(0, str(PACKAGE_PYTHON_ROOT))

# Keep the check side-effect free: importing the generated package must not
# leave __pycache__ directories in checked-in sources.
sys.dont_write_bytecode = True

from vamp_schema import (  # noqa: E402
    SONG_SCHEMA_VERSION,
    Effect,
    Instrument,
    Note,
    SongSchemaV1,
    Track,
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"Python schema type check failed: {message}")


require(SONG_SCHEMA_VERSION == "1.0.0", "unexpected generated schema version")
require(
    SongSchemaV1.__required_keys__ == frozenset({"schemaVersion", "meta", "tracks"}),
    f"unexpected SongSchemaV1 required keys: {sorted(SongSchemaV1.__required_keys__)}",
)
require(
    SongSchemaV1.__optional_keys__ == frozenset({"patterns"}),
    f"unexpected SongSchemaV1 optional keys: {sorted(SongSchemaV1.__optional_keys__)}",
)
require(
    Note.__required_keys__ == frozenset({"pitch", "start", "duration"}),
    "Note required keys do not match the schema",
)
require(
    Note.__optional_keys__ == frozenset({"velocity"}),
    "Note optional keys do not match the schema",
)

track_hints = typing.get_type_hints(Track)
require("instrument" in track_hints, "Track.instrument did not resolve")
song_hints = typing.get_type_hints(SongSchemaV1)
require("meta" in song_hints and "tracks" in song_hints, "SongSchemaV1 hints did not resolve")

instrument_members = typing.get_args(Instrument)
require(len(instrument_members) == 4, "Instrument union must contain four variants")
require(
    [member.__name__ for member in instrument_members]
    == ["BuiltinInstrument", "GmInstrument", "SoundfontInstrument", "SfzInstrument"],
    "Instrument union variants do not match the schema",
)
effect_members = typing.get_args(Effect)
require(
    [member.__name__ for member in effect_members]
    == ["ReverbEffect", "DelayEffect", "EqEffect", "LowpassEffect"],
    "Effect union variants do not match the schema",
)

print(
    "Python schema types import check passed: "
    f"SongSchemaV1, Track, Instrument ({len(instrument_members)} variants), "
    f"Effect ({len(effect_members)} variants), Note."
)
