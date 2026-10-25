/**
 * 🗜 The shrink worker (tvShrink.ts): one film from this page's node made
 * smaller — re-encoded with the browser's own WebCodecs, through Mediabunny,
 * at a set number of lines on the same timeline — into a file in the
 * origin-private file system. Off the main thread, so the station keeps its
 * frames while it runs. A film with no picture, or one no taller than the
 * lines asked for, is said to be fine as it is.
 *
 * MP4 with H.264 plays in every webview the station runs in; where this
 * browser cannot encode H.264, WebM with VP9 (or VP8). The sound is kept as
 * it is when the container takes it, else made stereo; a film whose sound
 * could not be kept is not made at all.
 */
import {
  ALL_FORMATS, canEncodeAudio, Conversion, ConversionCanceledError, getFirstEncodableVideoCodec, Input, Mp4OutputFormat, Output, Quality,
  StreamTarget, UrlSource, WebMOutputFormat,
} from 'mediabunny';
import type { StreamTargetChunk } from 'mediabunny';

export type ShrinkAsk =
  | { kind: 'start'; url: string; file: string; lines: number; videoBitrate: number; audioBitrate: number }
  | { kind: 'cancel' };
export type ShrinkSay =
  | { kind: 'progress'; done: number }
  | { kind: 'done'; size: number; mime: string; lines: number }
  | { kind: 'asis'; why: string }
  | { kind: 'failed'; why: string };

/** The worker's own globals, without the WebWorker lib (the project builds against the DOM's). */
interface Scope {
  postMessage(say: ShrinkSay): void;
  onmessage: ((e: MessageEvent<ShrinkAsk>) => void) | null;
}
/** The OPFS file a worker writes in place (positioned writes, as the MP4 muxer needs). */
interface SyncAccess {
  write(data: Uint8Array, at: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

const scope = self as unknown as Scope;
let running: Conversion | null = null;
let canceled = false;

scope.onmessage = (e) => {
  const ask = e.data;
  if (ask.kind === 'cancel') {
    canceled = true;
    void running?.cancel();
    return;
  }
  void shrink(ask).then((say) => scope.postMessage(say), (err: unknown) => {
    scope.postMessage({ kind: 'failed', why: err instanceof Error ? err.message : 'the encoder stopped' });
  });
};

const failed = (why: string): ShrinkSay => ({ kind: 'failed', why });
const asis = (why: string): ShrinkSay => ({ kind: 'asis', why });

async function shrink(ask: Extract<ShrinkAsk, { kind: 'start' }>): Promise<ShrinkSay> {
  const input = new Input({
    source: new UrlSource(ask.url, { requestInit: { redirect: 'error', cache: 'no-store' }, getRetryDelay: (n) => (n < 3 ? 1 : null) }),
    formats: ALL_FORMATS,
  });
  let access: SyncAccess | null = null;
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) return asis('it has no picture');
    if (video.displayHeight <= ask.lines) return asis(`its picture is ${video.displayHeight} lines`);
    const height = ask.lines;
    const width = Math.max(2, 2 * Math.round((video.displayWidth * height) / video.displayHeight / 2));
    // A Quality made from a bare number is a quality factor, not bits a second.
    const quality = new Quality({ bitrate: ask.videoBitrate });
    const sound = new Quality({ bitrate: ask.audioBitrate });
    const avc = await getFirstEncodableVideoCodec(['avc'], { width, height, quality });
    const vpx = avc ? null : await getFirstEncodableVideoCodec(['vp9', 'vp8'], { width, height, quality });
    const codec = avc ?? vpx;
    if (!codec) return failed('this browser cannot encode video');
    const format = avc ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat();
    const audioCodec = avc && (await canEncodeAudio('aac', { numberOfChannels: 2, quality: sound })) ? 'aac' : 'opus';

    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(ask.file, { create: true });
    access = await (handle as unknown as { createSyncAccessHandle(): Promise<SyncAccess> }).createSyncAccessHandle();
    access.truncate(0);
    const sink = access;
    const writable = new WritableStream<StreamTargetChunk>({ write(chunk) { sink.write(chunk.data, { at: chunk.position }); } });
    const output = new Output({ format, target: new StreamTarget(writable, { chunked: true }) });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      showWarnings: false,
      video: { width, height, fit: 'contain', codec, quality, forceTranscode: true, keyFrameInterval: 2 },
      audio: { codec: audioCodec, numberOfChannels: 2, quality: sound },
    });
    const lost = (type: 'video' | 'audio') => conversion.discardedTracks.find((d) => d.track.type === type);
    if (!conversion.isValid || lost('video')) {
      const why = lost('video')?.reason ?? 'no_video_track';
      return failed(`${why === 'undecodable_source_codec' ? 'this browser cannot decode its picture' : 'this browser cannot re-encode its picture'} (${why})`);
    }
    if (lost('audio')) return failed('this browser could not keep its sound');
    let last = 0;
    conversion.onProgress = (done) => {
      // A few words a second, not one per frame.
      const now = performance.now();
      if (now - last < 500) return;
      last = now;
      scope.postMessage({ kind: 'progress', done });
    };
    running = conversion;
    if (canceled) await conversion.cancel();
    await conversion.execute();
    access.flush();
    const size = access.getSize();
    return { kind: 'done', size, mime: format.mimeType, lines: height };
  } catch (err) {
    if (err instanceof ConversionCanceledError) return failed('stopped');
    throw err;
  } finally {
    running = null;
    access?.close();
    input.dispose();
  }
}
