/**
 * 🎶 partyAudio — the score is data; these pin it so an edit to a note
 * cannot silently break the timing the synth and the loop rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  BEATS_PER_BAR,
  HAPPY_BIRTHDAY,
  HAPPY_BIRTHDAY_CHORDS,
  TEMPO_BPM,
  TRACKS,
  nextTrackId,
  trackById,
  accompanimentEvents,
  melodyEvents,
  midiToHz,
  tuneBeats,
  tuneSeconds,
} from './partyAudio';

describe('the score', () => {
  it('is a one-beat pickup plus eight bars of 3/4', () => {
    expect(tuneBeats()).toBe(1 + 8 * BEATS_PER_BAR);
  });

  it('is "Happy Birthday" in F — starts on the two pickup Cs, ends on a held F', () => {
    expect(HAPPY_BIRTHDAY[0]).toEqual({ midi: 60, beats: 0.75 });
    expect(HAPPY_BIRTHDAY[1]).toEqual({ midi: 60, beats: 0.25 });
    const last = HAPPY_BIRTHDAY[HAPPY_BIRTHDAY.length - 1];
    expect(last).toEqual({ midi: 65, beats: 3 });
    // The high point is the octave C on "birth-day DEAR".
    expect(Math.max(...HAPPY_BIRTHDAY.map((n) => n.midi ?? 0))).toBe(72);
    for (const n of HAPPY_BIRTHDAY) {
      if (n.midi !== null) expect([60, 62, 64, 65, 67, 69, 70, 72]).toContain(n.midi); // F major
      expect(n.beats).toBeGreaterThan(0);
    }
  });

  it('lays the melody out end to end with no overlaps or gaps', () => {
    const ev = melodyEvents();
    for (let k = 1; k < ev.length; k++) {
      expect(ev[k].at).toBeCloseTo(ev[k - 1].at + ev[k - 1].beats, 9);
    }
    expect(ev[ev.length - 1].at + ev[ev.length - 1].beats).toBeCloseTo(tuneBeats(), 9);
  });

  it('accompanies every bar after the pickup, under the melody', () => {
    expect(HAPPY_BIRTHDAY_CHORDS.map((c) => c.bar)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const ev = accompanimentEvents();
    const beatsCovered = new Set(ev.filter((e) => !e.bass).map((e) => e.at));
    for (let b = 1; b < tuneBeats(); b++) expect(beatsCovered.has(b)).toBe(true);
    for (const e of ev) expect(e.midi).toBeLessThanOrEqual(63); // never above the melody's low C
    expect(ev.filter((e) => e.bass)).toHaveLength(8);
  });

  it('runs about sixteen seconds at 92 bpm', () => {
    expect(TEMPO_BPM).toBe(92);
    expect(tuneSeconds()).toBeCloseTo((25 * 60) / 92, 6);
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(60)).toBeCloseTo(261.63, 1);
  });
});

describe('the recordings', () => {
  it('bundles three free-licensed recordings plus the music box, sung first', () => {
    expect(TRACKS.map((t) => t.id)).toEqual(['sung', 'choir', 'jazz', 'music-box']);
    expect(TRACKS[0].file).toBe('/audio/happy-birthday-sung.ogg');
    expect(TRACKS[3].file).toBeNull();
    // Every recording names its performer and licence (public/audio/LICENSES.md).
    for (const t of TRACKS.filter((t) => t.file)) expect(t.credit).toMatch(/CC BY-SA|CC0/);
  });

  it('cycles tracks and falls back to the first for an unknown id', () => {
    expect(nextTrackId('sung')).toBe('choir');
    expect(nextTrackId('music-box')).toBe('sung');
    expect(trackById('nope').id).toBe('sung');
  });
});
