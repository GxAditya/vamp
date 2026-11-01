# Validation, normalization, and generated types

Issue-code catalogue and the semantic checks behind it for SongSchemaV1
(`"1.0.0"`). The semantic rules in
[`schema-guide.md`](./schema-guide.md) remain authoritative.

Machine-readable API reference: the package exports `ISSUE_CODE_REFERENCE`
(every code with severity and description) and `ISSUE_CODES` (the code list).

> The validator entry points, result shapes, and the issue shape are documented in [Vamp API reference](./api.md).

## Issue codes

### Version and document

| Code                         | Severity | Meaning                                    |
| ---------------------------- | -------- | ------------------------------------------ |
| `schema.document.invalid`    | error    | Input is not a JSON object.                |
| `schema.version.missing`     | error    | `schemaVersion` is absent or undefined.    |
| `schema.version.unsupported` | error    | Version is not a supported string.         |
| `value.non_finite`           | error    | A programmatic value is `NaN` or Infinity. |

### Structural

| Code                                           | Severity | Meaning                                                  |
| ---------------------------------------------- | -------- | -------------------------------------------------------- |
| `schema.structure.type`                        | error    | Wrong JSON type.                                         |
| `schema.structure.required`                    | error    | Required property missing.                               |
| `schema.structure.unknown_property`            | error    | Property rejected by `additionalProperties: false`.      |
| `schema.structure.value_not_allowed`           | error    | Value outside a `const` or `enum` allowlist.             |
| `schema.structure.pattern_mismatch`            | error    | String does not match a schema pattern.                  |
| `schema.structure.format_invalid`              | error    | String does not match a schema format such as date-time. |
| `schema.structure.out_of_range`                | error    | Number below, above, or equal to an exclusive bound.     |
| `schema.structure.length_out_of_range`         | error    | String length outside bounds.                            |
| `schema.structure.item_count_out_of_range`     | error    | Array item count outside bounds.                         |
| `schema.structure.duplicate_items`             | error    | Unique-items array contains duplicates.                  |
| `schema.structure.property_count_out_of_range` | error    | Object property count outside bounds.                    |
| `schema.structure.variant_invalid`             | error    | Value matches no allowed structural variant.             |
| `schema.structure.constraint_failed`           | error    | Conditional or contains constraint failed.               |
| `schema.structure.invalid`                     | error    | Unclassified structural failure.                         |

### Semantic song rules

| Code                                     | Severity | Meaning                                                    |
| ---------------------------------------- | -------- | ---------------------------------------------------------- |
| `song.track.duplicate_id`                | error    | Two tracks share an id.                                    |
| `song.track.multiple_drums`              | error    | More than one drums track.                                 |
| `song.pattern.duplicate_id`              | error    | Two patterns share an id.                                  |
| `song.pattern.unresolved`                | error    | Placement points at an unknown pattern.                    |
| `song.pattern.note_exceeds_length`       | error    | Pattern note ends after explicit `lengthBeats`.            |
| `song.channel.duplicate`                 | error    | Melodic tracks share a MIDI channel.                       |
| `song.channel.reserved`                  | error    | A melodic track uses channel 9.                            |
| `song.channel.drums_invalid`             | error    | Drums track is not on channel 9.                           |
| `song.note.end_exceeds_limit`            | error    | `start + duration` exceeds 12000 beats.                    |
| `song.placement.end_exceeds_limit`       | error    | Expanded placement ends after 12000 beats.                 |
| `song.placement.expansion_exceeds_limit` | error    | One placement expands past 20000 note events.              |
| `song.drums.pitch_out_of_range`          | error    | Drum pitch outside GM range 35 to 81.                      |
| `song.automation.time_order`             | error    | Automation times are not strictly increasing.              |
| `song.automation.filter_target`          | error    | Filter automation does not target one static-free lowpass. |
| `song.limit.authored_notes`              | error    | More than 10000 authored notes.                            |
| `song.limit.expanded_notes`              | error    | More than 20000 expanded note events.                      |
| `song.limit.automation_points`           | error    | More than 1536 automation points on one track.             |
| `song.duration.exceeds_limit`            | error    | Computed rendered duration exceeds 600 seconds.            |
| `song.instrument.unknown_builtin`        | error    | Builtin id is not in the active allowlist.                 |
| `song.capability.instrument_unsupported` | error    | Declared backend does not support a variant or builtin id. |
| `song.capability.asset_unsupported`      | error    | Declared backend rejects a SoundFont or SFZ asset.         |
| `song.capability.effect_unsupported`     | error    | Declared backend does not support a used effect type.      |
| `song.warning.unused_pattern`            | warning  | Pattern is defined but never placed.                       |
| `song.warning.automation_after_content`  | warning  | First keyframe after the track's last note end.            |
| `song.warning.hint_exceeds_content`      | warning  | Hint leaves more than 8 seconds of trailing silence.       |

## Semantic checks and paths

| Guide rule                     | Implementation                                             | Typical path                         |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------ |
| 1 unique track ids             | `song.track.duplicate_id`                                  | `/tracks/{i}/id`                     |
| 2 unique pattern ids           | `song.pattern.duplicate_id`                                | `/patterns/{i}/id`                   |
| 3 melodic channels and drums   | duplicate, reserved, drums-invalid, multiple-drums         | `/tracks/{i}/channel`                |
| 4 resolved patterns            | `song.pattern.unresolved`                                  | `/tracks/{i}/placements/{j}/pattern` |
| 5 pattern note bounds          | `song.pattern.note_exceeds_length`                         | `/patterns/{i}/notes/{j}`            |
| 6 note end bound               | `song.note.end_exceeds_limit`                              | note object path                     |
| 7 expanded placement end       | `song.placement.end_exceeds_limit`                         | placement object path                |
| 8 GM drum pitches              | `song.drums.pitch_out_of_range`                            | note `pitch` path                    |
| 9 automation ordering          | `song.automation.time_order`                               | `points/{j}/time`                    |
| 10 filter automation target    | `song.automation.filter_target`                            | automation or effect path            |
| 11 authored note count         | `song.limit.authored_notes`                                | document root                        |
| 12 expanded note count         | `song.limit.expanded_notes`                                | document root                        |
| 13 rendered duration           | `song.duration.exceeds_limit`                              | document root                        |
| 14 builtin ids                 | `song.instrument.unknown_builtin`                          | `/tracks/{i}/instrument/id`          |
| 15 backend capability          | capability function, see [architecture](./architecture.md) | instrument or asset path             |
| 16 non-finite numbers          | `value.non_finite`                                         | numeric value path                   |
| 17 expansion and repeat bounds | placement expansion plus schema repeat bounds              | placement object path                |

Placement end uses the documented tiling formula:
`start + repeat * effectiveLengthBeats`, where the effective length is explicit
`lengthBeats` or the maximum note end. Note end checks use a tiny `1e-9` beat
tolerance for floating-point arithmetic. Automation ordering requires strictly
increasing times with no tolerance. The 600 second check allows exactly 600
seconds within a `1e-9` second floating-point tolerance.

### Warnings

Warnings never make validation fail:

- `song.warning.unused_pattern` at `/patterns/{i}`. A pattern counts as used when
  any placement references its id.
- `song.warning.automation_after_content` at the first point whose time is
  strictly after the track's last notated note end. Placement expansions are
  included. Tracks with unresolved patterns are skipped for this warning.
- `song.warning.hint_exceeds_content` at `/meta/durationHint` when
  `hintSeconds - lastSoundSeconds > 8`. `lastSoundSeconds` includes audible
  effect tails.

## Verification

```sh
pnpm check:generated
pnpm check:python-types
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```
