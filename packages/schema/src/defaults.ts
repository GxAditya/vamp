/**
 * Documented SongSchemaV1 normalization defaults.
 *
 * These values exist only as JSON Schema annotations. Validation never applies
 * them. `normalizeSong` builds a copy with these values resolved.
 */
export const NORMALIZATION_DEFAULTS = Object.freeze({
  trackVolume: 1,
  trackPan: 0,
  trackMute: false,
  trackSolo: false,
  noteVelocity: 100,
  placementRepeat: 1,
  instrumentBank: 0,
  reverbMix: 0.25,
  reverbDecaySeconds: 1.8,
  delayTimeMs: 375,
  delayFeedback: 0.35,
  delayMix: 0.25,
  eqGainDb: 0,
  lowpassCutoffHz: 20000,
  lowpassQ: 1,
});
