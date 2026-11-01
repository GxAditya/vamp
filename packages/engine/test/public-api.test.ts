import { describe, expect, it } from 'vitest';

import * as engine from '../src/index.js';

describe('@gxaditya/vamp-engine public surface', () => {
  it('exports the timeline compiler, MIDI exporter, audio renderer, and timing helpers', () => {
    expect(typeof engine.compileSong).toBe('function');
    expect(typeof engine.compileValidatedSong).toBe('function');
    expect(typeof engine.getTimelineBoundaries).toBe('function');
    expect(typeof engine.compareTimelineEvents).toBe('function');
    expect(typeof engine.beatsToSeconds).toBe('function');
    expect(typeof engine.beatsToSamples).toBe('function');
    expect(engine.TIMELINE_FORMAT).toBe('vamp.timeline');
    expect(engine.TIMELINE_FORMAT_VERSION).toBe(1);
    expect(engine.SUPPORTED_SAMPLE_RATES).toEqual([44100, 48000]);
    expect(engine.COMPILE_LIMITS).toEqual({
      maxAuthoredNotes: 10000,
      maxExpandedNotes: 20000,
      maxRenderedSeconds: 600,
    });
    expect(engine.COMPILE_ISSUE_CODES).toContain('compile.limit.expanded_notes');
    expect(typeof engine.exportMidi).toBe('function');
    expect(engine.MIDI_FILE_FORMAT).toBe(1);
    expect(engine.MIDI_PPQ).toBe(960);
    expect(engine.MIDI_ISSUE_CODES).toContain('midi.channel.collision');
    expect(engine.MIDI_LIMITATION_CODES).toContain('program.not_encoded');

    expect(typeof engine.renderTimelineAudio).toBe('function');
    expect(typeof engine.renderSongAudio).toBe('function');
    expect(typeof engine.renderSongToWav).toBe('function');
    expect(typeof engine.encodeWav).toBe('function');
    expect(typeof engine.createBuiltinSynthBackend).toBe('function');
    expect(engine.BUILTIN_SYNTH_BACKEND_ID).toBe('builtin-synth-v1');
    expect(engine.DEFAULT_MAX_VOICES_PER_TRACK).toBe(32);
    expect(engine.MAX_VOICES_PER_TRACK).toBe(128);
    expect(engine.AUDIO_VOICE_POLICY).toBe('drop-newest');
    expect(engine.PCM_BUFFER_FORMAT).toBe('vamp.pcm');
    expect(engine.WAV_BIT_DEPTH).toBe(16);
    expect(engine.WAV_CHANNELS).toBe(2);
    expect(engine.BUILTIN_DRUM_MAP).toHaveLength(47);
    expect(engine.AUDIO_ISSUE_CODES).toContain('audio.instrument.unsupported_variant');
    expect(engine.AUDIO_ISSUE_CODES).toContain('audio.effects.invalid');
    expect(engine.AUDIO_ISSUE_CODES).toContain('audio.automation.invalid');
    expect(engine.BUILTIN_SYNTH_BACKEND_CAPABILITIES.builtinIds).toEqual([
      'bass.sub',
      'drums.kit',
      'guitar.clean',
      'keys.soft',
      'pad.warm',
      'piano.soft',
    ]);

    expect(typeof engine.processEffectChain).toBe('function');
    expect(engine.EFFECT_TYPES).toEqual(['reverb', 'delay', 'eq', 'lowpass']);
    expect(engine.MAX_EFFECTS_PER_TRACK).toBe(8);
    expect(engine.MAX_LOWPASS_PER_TRACK).toBe(1);
    expect(typeof engine.isTransparentEffect).toBe('function');
    expect(typeof engine.createAutomationCurve).toBe('function');
    expect(typeof engine.AutomationCurve).toBe('function');
    expect(engine.AUTOMATION_TARGETS).toEqual(['volume', 'pan', 'filterCutoffHz']);
    expect(engine.AUTOMATION_RANGES.filterCutoffHz).toEqual({ minimum: 20, maximum: 20000 });

    expect(typeof engine.renderSongArtifacts).toBe('function');
    expect(engine.RENDER_REPORT_FORMAT).toBe('vamp.render-report');
    expect(engine.RENDER_REPORT_FORMAT_VERSION).toBe(1);
    expect(engine.MASTER_AUDIO_FILENAME).toBe('master.wav');
    expect(engine.MIDI_ARTIFACT_FILENAME).toBe('song.mid');
    expect(engine.REPORT_ARTIFACT_FILENAME).toBe('report.json');
    expect(engine.MAX_STEM_COUNT).toBe(16);
    expect(engine.MAX_ARTIFACT_COUNT).toBe(19);
    expect(engine.DEFAULT_RENDER_ARTIFACTS).toEqual({ stems: true, midi: true, report: true });
    expect(engine.stemReconstructionToleranceLsb(5)).toBe(3);
    expect(typeof engine.sanitizeTrackSlug).toBe('function');
    expect(typeof engine.stemFileName).toBe('function');
    expect(typeof engine.isSafeArtifactFileName).toBe('function');
    expect(engine.LOUDNESS_METHOD).toBe('vamp-kweighted-gated-v1');
    expect(engine.LOUDNESS_ABSOLUTE_GATE_LUFS).toBe(-70);
    expect(typeof engine.measureIntegratedLoudness).toBe('function');
    expect(typeof engine.probeFluidSynthVersion).toBe('function');
    expect(engine.AUDIO_ISSUE_CODES).toContain('audio.artifacts.exists');
    expect(engine.AUDIO_ISSUE_CODES).toContain('audio.cancelled');
    expect(engine.AUDIO_WARNING_CODES).toContain('audio.artifacts.cleanup_failed');
  });
});
