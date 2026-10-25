/**
 * 🔗 ssfLink — an SSF film link written and read back, and what a pasted
 * one must carry: the file's hash, a size the TV takes, at least one node.
 */
import { describe, expect, it } from 'vitest';
import { formatSsfLink, isSsfFilmLink, parseSsfLink, SSF_LINK_NODES } from './ssfLink';
import { TV_MAX_BLOB, TV_MAX_TITLE } from './tvDoc';

const [HASH, A, B, C, D, E] = ['b', 'a', 'c', 'd', 'e', 'f'].map((c) => c.repeat(64)) as [string, string, string, string, string, string];

describe('🔗 an SSF link', () => {
  it('reads back what it was written from, title and type included', () => {
    const link = { hash: HASH, size: 123_456_789, title: 'Big Buck Bunny & friends: 2 + 2 = 4?', mime: 'video/mp4', nodes: [A, B] };
    const text = formatSsfLink(link);
    expect(text.startsWith(`ssf://film?h=${HASH}&s=123456789&t=`)).toBe(true);
    expect(text.endsWith(`&n=${A},${B}`)).toBe(true);
    expect(isSsfFilmLink(text)).toBe(true);
    expect(parseSsfLink(text)).toEqual(link);
    expect(parseSsfLink(`  ${text}\n`)).toEqual(link);
  });

  it('names at most four nodes, each once, and leaves out what is not a node id', () => {
    const text = formatSsfLink({ hash: HASH, size: 9, title: '', mime: '', nodes: [A, A, 'zz', B, C, D, E] });
    expect(text).toBe(`ssf://film?h=${HASH}&s=9&n=${A},${B},${C},${D}`);
    expect(parseSsfLink(text)?.nodes).toHaveLength(SSF_LINK_NODES);
    // Read: the same, from a link written by hand or by another build.
    expect(parseSsfLink(`ssf://film?h=${HASH}&s=9&n=${A.toUpperCase()},nope,${A},${B}%2C${C},${D},${E}`)?.nodes).toEqual([A, B, C, D]);
  });

  it('is not whole without its hash, a size the TV takes, or a node', () => {
    const ok = `ssf://film?h=${HASH}&s=9&n=${A}`;
    expect(parseSsfLink(ok)).toMatchObject({ hash: HASH, size: 9, title: '', mime: '', nodes: [A] });
    expect(parseSsfLink(`ssf://film?s=9&n=${A}`)).toBeNull();
    expect(parseSsfLink(`ssf://film?h=${HASH.slice(1)}&s=9&n=${A}`)).toBeNull();
    expect(parseSsfLink(`ssf://film?h=${HASH}&n=${A}`)).toBeNull();
    for (const s of ['0', '-1', '1.5', '1e3', '09', String(TV_MAX_BLOB + 1)]) expect(parseSsfLink(`ssf://film?h=${HASH}&s=${s}&n=${A}`)).toBeNull();
    expect(parseSsfLink(`ssf://film?h=${HASH}&s=9`)).toBeNull();
    expect(parseSsfLink(`ssf://film?h=${HASH}&s=9&n=zz`)).toBeNull();
    // Meant as one, so the box says what is missing rather than "not a link".
    expect(isSsfFilmLink('ssf://film')).toBe(true);
    expect(isSsfFilmLink('ssf://room?seed=x')).toBe(false);
    expect(parseSsfLink(`ssf://room?h=${HASH}&s=9&n=${A}`)).toBeNull();
  });

  it('keeps a type the TV plays and a title cut to the record\'s length, as a room record does', () => {
    const long = 'x'.repeat(TV_MAX_TITLE + 50);
    const got = parseSsfLink(`ssf://film?h=${HASH}&s=9&m=text%2Fhtml&t=${long}&n=${A}`);
    expect(got).toMatchObject({ mime: '', title: 'x'.repeat(TV_MAX_TITLE) });
    expect(parseSsfLink(`ssf://film?h=${HASH}&s=9&m=audio%2Fogg&t=%3Cb%3Ehi%3C%2Fb%3E&n=${A}`)).toMatchObject({ mime: 'audio/ogg', title: '<b>hi</b>' });
    expect(formatSsfLink({ hash: HASH, size: 9, title: long, mime: '', nodes: [A] })).toContain(`t=${'x'.repeat(TV_MAX_TITLE)}&`);
  });
});
