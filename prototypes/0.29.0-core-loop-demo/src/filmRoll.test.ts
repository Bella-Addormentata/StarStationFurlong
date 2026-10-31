/**
 * 🎞️ The CAMERA app's film roll (#319): the last 20 shots, newest first,
 * each with its date, room and caption.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PHOTO_CAPTION } from './boardDoc';
import {
  addShot, cleanCaption, cleanLine, listShots, MAX_CAPTION, memoryRollStore, onRollChange, removeShot, ROLL_MAX, rollIsLasting, setCaption,
  setRollStoreForTest, shotLabel,
} from './filmRoll';

const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' });
const take = (ts: number, roomName = 'Lobby') => addShot({ jpeg: jpeg(), width: 512, height: 288, roomId: 'room-a', roomName }, ts);

beforeEach(() => setRollStoreForTest(memoryRollStore()));
afterEach(() => setRollStoreForTest(null));

describe('🎞️ the film roll', () => {
  it('keeps the newest 20, newest first', async () => {
    for (let i = 0; i < ROLL_MAX + 2; i++) await take(1_000 + i);
    const shots = await listShots();
    expect(shots).toHaveLength(ROLL_MAX);
    expect(shots[0].ts).toBe(1_000 + ROLL_MAX + 1);
    expect(shots.at(-1)!.ts).toBe(1_002);
  });

  it('writes a caption as one clean line, as a board note’s photo carries it', async () => {
    expect(MAX_CAPTION).toBe(MAX_PHOTO_CAPTION);
    const shot = await take(5_000);
    expect(shot.caption).toBe('');
    expect(await setCaption(shot.id, '  movie\nnight \u0007 on the sofa  ')).toBe(true);
    expect((await listShots())[0].caption).toBe('movie night on the sofa');
    await setCaption(shot.id, 'x'.repeat(200));
    expect((await listShots())[0].caption).toHaveLength(MAX_CAPTION);
    expect(cleanCaption('a'.repeat(MAX_CAPTION - 1) + '😀')).toBe('a'.repeat(MAX_CAPTION - 1)); // never half an emoji
    expect(await setCaption('gone', 'x')).toBe(false);
  });

  it('throws a shot away, and says when the roll changes', async () => {
    let changes = 0;
    const off = onRollChange(() => changes++);
    const a = await take(1);
    await take(2);
    await removeShot(a.id);
    expect((await listShots()).map((s) => s.ts)).toEqual([2]);
    expect(changes).toBe(3);
    off();
    await take(3);
    expect(changes).toBe(3);
  });

  it('labels a shot with its day, time and room, and keeps a room name short and clean', async () => {
    const shot = await take(Date.UTC(2026, 9, 31, 21, 40), 'The\tBlue  Lounge');
    expect(shot.roomName).toBe('The Blue Lounge');
    const label = shotLabel(shot, 'en-US');
    expect(label).toMatch(/Oct 31/);
    expect(label.endsWith(' · The Blue Lounge')).toBe(true);
    expect(shotLabel({ ...shot, roomName: '' }, 'en-US')).not.toMatch(/·\s*$/);
    expect(cleanLine(42, 10)).toBe('');
  });

  it('says when it lives only in memory', () => {
    expect(rollIsLasting()).toBe(false);
  });
});
