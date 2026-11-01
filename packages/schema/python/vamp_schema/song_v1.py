# DO NOT EDIT. Generated from packages/schema/schema/song.schema.json
# by packages/schema/scripts/generate-types.mjs.
# Regenerate from the repository root with: pnpm generate:types

"""Generated type declarations for Vamp SongSchemaV1.

These TypedDicts mirror the canonical JSON Schema. They describe data and do
not validate it; the TypeScript package validator remains authoritative.
"""

from __future__ import annotations

from typing import Final, Literal, TypedDict, Union

SONG_SCHEMA_VERSION: Final = "1.0.0"

EntityId = str

AssetPath = str

class _SongMetaRequired(TypedDict):
    title: str
    bpm: int
    timeSignature: TimeSignature
    key: SongKey
    seed: int
    durationHint: float

class SongMeta(_SongMetaRequired, total=False):
    mood: str
    tags: list[str]
    createdAt: str

class TimeSignature(TypedDict):
    numerator: int
    denominator: Literal[1, 2, 4, 8, 16, 32]

class SongKey(TypedDict):
    tonic: Literal["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    mode: Literal["major", "minor"]

class _TrackRequired(TypedDict):
    id: EntityId
    name: str
    kind: Literal["midi", "drums"]
    channel: int
    instrument: Instrument

class Track(_TrackRequired, total=False):
    volume: float
    pan: float
    mute: bool
    solo: bool
    notes: list[Note]
    placements: list[Placement]
    automation: Automation
    effects: list[Effect]

class BuiltinInstrument(TypedDict):
    type: Literal["builtin"]
    id: str

class _GmInstrumentRequired(TypedDict):
    type: Literal["gm"]
    program: int

class GmInstrument(_GmInstrumentRequired, total=False):
    bank: int

class _SoundfontInstrumentRequired(TypedDict):
    type: Literal["soundfont"]
    path: AssetPath
    program: int

class SoundfontInstrument(_SoundfontInstrumentRequired, total=False):
    bank: int

class SfzInstrument(TypedDict):
    type: Literal["sfz"]
    path: AssetPath

class _NoteRequired(TypedDict):
    pitch: int
    start: float
    duration: float

class Note(_NoteRequired, total=False):
    velocity: int

class _PatternRequired(TypedDict):
    id: EntityId
    notes: list[Note]

class Pattern(_PatternRequired, total=False):
    name: str
    lengthBeats: float

class _PlacementRequired(TypedDict):
    pattern: EntityId
    start: float

class Placement(_PlacementRequired, total=False):
    repeat: int

class Automation(TypedDict, total=False):
    volume: VolumeAutomation
    pan: PanAutomation
    filterCutoffHz: FilterAutomation

class VolumeAutomation(TypedDict):
    points: list[VolumePoint]

class PanAutomation(TypedDict):
    points: list[PanPoint]

class FilterAutomation(TypedDict):
    points: list[FilterPoint]

class VolumePoint(TypedDict):
    time: float
    value: float

class PanPoint(TypedDict):
    time: float
    value: float

class FilterPoint(TypedDict):
    time: float
    value: float

class _ReverbEffectRequired(TypedDict):
    type: Literal["reverb"]

class ReverbEffect(_ReverbEffectRequired, total=False):
    mix: float
    decaySeconds: float

class _DelayEffectRequired(TypedDict):
    type: Literal["delay"]

class DelayEffect(_DelayEffectRequired, total=False):
    timeMs: float
    feedback: float
    mix: float

class _EqEffectRequired(TypedDict):
    type: Literal["eq"]

class EqEffect(_EqEffectRequired, total=False):
    lowGainDb: float
    midGainDb: float
    highGainDb: float

class _LowpassEffectRequired(TypedDict):
    type: Literal["lowpass"]

class LowpassEffect(_LowpassEffectRequired, total=False):
    cutoffHz: float
    q: float

class _SongSchemaV1Required(TypedDict):
    schemaVersion: Literal["1.0.0"]
    meta: SongMeta
    tracks: list[Track]

class SongSchemaV1(_SongSchemaV1Required, total=False):
    patterns: list[Pattern]

Instrument = Union[BuiltinInstrument, GmInstrument, SoundfontInstrument, SfzInstrument]

Effect = Union[ReverbEffect, DelayEffect, EqEffect, LowpassEffect]

__all__ = [
    "SONG_SCHEMA_VERSION",
    "EntityId",
    "AssetPath",
    "SongMeta",
    "TimeSignature",
    "SongKey",
    "Track",
    "BuiltinInstrument",
    "GmInstrument",
    "SoundfontInstrument",
    "SfzInstrument",
    "Note",
    "Pattern",
    "Placement",
    "Automation",
    "VolumeAutomation",
    "PanAutomation",
    "FilterAutomation",
    "VolumePoint",
    "PanPoint",
    "FilterPoint",
    "ReverbEffect",
    "DelayEffect",
    "EqEffect",
    "LowpassEffect",
    "SongSchemaV1",
    "Instrument",
    "Effect",
]

