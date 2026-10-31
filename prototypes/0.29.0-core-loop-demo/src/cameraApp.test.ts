/**
 * 📷 The CAMERA app's film roll view (#319): Polaroids with their caption
 * and date line, escaped.
 */
import { describe, expect, it } from 'vitest';
import { cameraAppHtml } from './cameraApp';
import type { FilmShot } from './filmRoll';

const shot = (id: string, caption: string, roomName: string): FilmShot => ({
  id, ts: Date.UTC(2026, 9, 31, 21, 40), roomId: 'room-a', roomName, caption, width: 512, height: 288,
  jpeg: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
});

describe('📷 the film roll view', () => {
  it('prints each shot as a Polaroid, its caption and room escaped', () => {
    const html = cameraAppHtml([shot('a1', '<img src=x onerror=alert(1)>', 'Bob\'s "den"')], {
      lasting: true,
      urlOf: () => 'blob:http://x/1',
    });
    expect(html).toContain('data-camera-shoot');
    expect(html).toContain('data-shot="a1"');
    expect(html).toContain('src="blob:http://x/1"');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Bob&#39;s &quot;den&quot;');
    expect(html).toContain('1 of 20');
  });

  it('asks before throwing a shot away, and says when the roll won’t last', () => {
    const html = cameraAppHtml([shot('a1', '', 'Lobby'), shot('a2', '', 'Lobby')], {
      lasting: false,
      armed: 'a2',
      notice: 'The shot didn’t take.',
      urlOf: (s) => `blob:${s.id}`,
    });
    expect(html.match(/THROW IT AWAY\?/g)).toHaveLength(1);
    expect(html).toContain('the roll empties when the page closes');
    expect(html).toContain('The shot didn’t take.');
    expect(cameraAppHtml([], { lasting: true, urlOf: () => '' })).toContain('No photos yet');
  });
});
