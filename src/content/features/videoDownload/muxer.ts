/**
 * FFmpeg Muxer - Direct content script FFmpeg execution
 * Based on nico_downloader's approach: M3U8 → FFmpeg → MP4
 *
 * Key insight from DeepWiki: nico_downloader uses single M3U8 input with
 * original filenames extracted from URLs, not combined M3U8 playlists.
 */

import { ResultAsync, ok, err } from 'neverthrow';
import { DownloadResult, DownloadError } from './types';

// Global FFmpeg core instance
let ffmpegCore: any = null;

// Result storage for FFMPEG_END callback
let pendingResult: {
  outputFile: string;
  resolve: ((value: Uint8Array) => void) | null;
  reject: ((error: DownloadError) => void) | null;
} = {
  outputFile: '',
  resolve: null,
  reject: null,
};

/**
 * Wait for ffmpeg-core2.js to be loaded (injected via manifest content_scripts)
 */
function waitForFFmpegScript(): ResultAsync<void, DownloadError> {
  // Firefox: content script's `window` is the page window (XRay wrapped),
  // so `var createFFmpegCore` from ffmpeg-core2.js lands on `globalThis`, not `window`.
  // Chrome: both `window` and `globalThis` point to the isolated world's global.
  const getCreateFFmpegCore = () =>
    (globalThis as any).createFFmpegCore ?? (window as any).createFFmpegCore;

  if (getCreateFFmpegCore()) {
    return ResultAsync.fromSafePromise(Promise.resolve());
  }

  return ResultAsync.fromPromise(
    new Promise<void>((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 50;

      const check = () => {
        if (getCreateFFmpegCore()) {
          resolve();
        } else if (attempts++ < maxAttempts) {
          setTimeout(check, 100);
        } else {
          reject();
        }
      };
      check();
    }),
    (): DownloadError => ({
      type: 'FFMPEG_SCRIPT_NOT_LOADED',
      message: 'FFmpeg script not loaded.',
    }),
  );
}

/**
 * Initialize FFmpeg core with FFMPEG_END callback
 */
function initFFmpeg(): ResultAsync<any, DownloadError> {
  if (ffmpegCore) {
    return ResultAsync.fromSafePromise(Promise.resolve(ffmpegCore));
  }

  return waitForFFmpegScript().andThen(() => {
    const createFFmpegCore =
      (globalThis as any).createFFmpegCore ?? (window as any).createFFmpegCore;
    if (!createFFmpegCore) {
      return err({
        type: 'FFMPEG_NOT_LOADED',
        message: 'FFmpeg core not loaded.',
      } as DownloadError);
    }

    console.log('[FFmpeg] Initializing...');

    // Pre-fetch wasm binary to avoid CSP issues with streaming wasm instantiation
    // in content scripts (both Chrome MV3 and Firefox)
    const wasmUrl = chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm');

    return ResultAsync.fromPromise(
      fetch(wasmUrl)
        .then((resp) => {
          if (!resp.ok) throw new Error(`Failed to fetch wasm: ${resp.status}`);
          return resp.arrayBuffer();
        })
        .then((wasmBinary) => {
          console.log('[FFmpeg] WASM binary fetched, size:', wasmBinary.byteLength);
          return createFFmpegCore({
            wasmBinary,
            locateFile: (path: string) => {
              if (path.endsWith('.wasm')) {
                return wasmUrl;
              }
              return path;
            },
            print: (msg: string) => {
              console.log('[FFmpeg]', msg);

              // Read output when FFMPEG_END is detected
              if (msg.startsWith('FFMPEG_END') && pendingResult.resolve) {
                try {
                  const data = ffmpegCore.FS.readFile(pendingResult.outputFile) as Uint8Array;
                  console.log('[FFmpeg] Output read in callback, size:', data.length);
                  pendingResult.resolve(data);
                } catch (e) {
                  console.error('[FFmpeg] Failed to read output:', e);
                  if (pendingResult.reject) {
                    pendingResult.reject({
                      type: 'FFMPEG_FS_ERROR',
                      message: 'Failed to read FFmpeg output',
                      cause: e,
                    });
                  }
                }
                pendingResult.resolve = null;
                pendingResult.reject = null;
              }
            },
            printErr: (msg: string) => {
              console.warn('[FFmpeg stderr]', msg);
            },
          });
        })
        .then((core: any) => {
          ffmpegCore = core;
          console.log('[FFmpeg] Initialized');
          return core;
        }),
      (error): DownloadError => ({
        type: 'FFMPEG_ERROR',
        message: 'FFmpeg initialization failed',
        cause: error,
      }),
    );
  });
}

/**
 * Parse FFmpeg command arguments
 */
function parseArgs(core: any, args: string[]): [number, number] {
  const argsPtr = core._malloc(args.length * 4);
  args.forEach((s, idx) => {
    const buf = core._malloc(s.length + 1);
    core.writeAsciiToMemory(s, buf);
    core.setValue(argsPtr + 4 * idx, buf, 'i32');
  });
  return [args.length, argsPtr];
}

/**
 * Mux video and audio using M3U8 playlist approach (like nico_downloader)
 * Uses original filenames from URLs and modified M3U8 playlists
 */
export function muxWithPlaylist(
  videoPlaylist: string,
  videoSegments: { name: string; data: Uint8Array }[],
  audioPlaylist: string,
  audioSegments: { name: string; data: Uint8Array }[],
  _outputFilename: string = 'output.mp4',
): ResultAsync<Uint8Array, DownloadError> {
  // Emscripten FS は非ASCII ファイル名を正しく扱えないため、内部では固定名を使う
  const internalFilename = 'output.mp4';

  return initFFmpeg().andThen((core) => {
    console.log('[FFmpeg] Writing segment files to FS...');
    console.log(
      `[FFmpeg] Video segments: ${videoSegments.length}, Audio segments: ${audioSegments.length}`,
    );

    // Write files to FS
    const writeResult = writeFilesToFS(core, videoPlaylist, videoSegments, audioPlaylist, audioSegments);
    if (writeResult.isErr()) {
      return err(writeResult.error);
    }

    console.log('[FFmpeg] Muxing with M3U8 input...');

    // Set up result promise
    const resultPromise = new Promise<Uint8Array>((resolve, reject) => {
      pendingResult.outputFile = internalFilename;
      pendingResult.resolve = resolve;
      pendingResult.reject = reject;
    });

    // Run FFmpeg: video.m3u8 と audio.m3u8 を別々の入力として指定
    // master.m3u8 の AUDIO グループ方式は Firefox の FFmpeg WASM で動作しないため
    const args = [
      'ffmpeg',
      '-nostdin',
      '-allowed_extensions',
      'ALL',
      '-i',
      'video.m3u8',
      '-allowed_extensions',
      'ALL',
      '-i',
      'audio.m3u8',
      '-c',
      'copy',
      '-y',
      internalFilename,
    ];

    console.log('[FFmpeg] Command:', args.join(' '));
    const [argc, argv] = parseArgs(core, args);

    try {
      core.ccall('main', 'number', ['number', 'number'], [argc, argv]);
    } catch (e) {
      console.log('[FFmpeg] Caught exit:', e);
    }

    // Wait for FFMPEG_END or timeout
    const timeoutPromise = new Promise<Uint8Array>((_, reject) => {
      setTimeout(() => {
        if (pendingResult.resolve) {
          // Try fallback read
          try {
            console.log('[FFmpeg] Timeout - attempting fallback read');
            const data = core.FS.readFile(outputFilename) as Uint8Array;
            console.log('[FFmpeg] Fallback read size:', data.length);
            if (data.length > 1000) {
              pendingResult.resolve(data);
              pendingResult.resolve = null;
              return;
            }
          } catch (e) {
            console.error('[FFmpeg] Fallback read failed:', e);
          }
          reject({
            type: 'FFMPEG_TIMEOUT',
            message: 'FFmpeg timeout - no valid output',
          } as DownloadError);
        }
      }, 60000); // 60秒タイムアウト（長い動画に対応）
    });

    return ResultAsync.fromPromise(
      Promise.race([resultPromise, timeoutPromise]).then((result) => {
        // Cleanup
        cleanupFS(core, videoSegments, audioSegments, internalFilename);
        console.log('[FFmpeg] Muxing complete, size:', result.length);
        return result;
      }),
      (error): DownloadError => {
        // Cleanup on error too
        cleanupFS(core, videoSegments, audioSegments, internalFilename);
        if (typeof error === 'object' && error !== null && 'type' in error) {
          return error as DownloadError;
        }
        return {
          type: 'FFMPEG_ERROR',
          message: 'FFmpeg muxing failed',
          cause: error,
        };
      },
    );
  });
}

/**
 * Write binary data to Emscripten FS via the Emscripten heap.
 *
 * Firefox Xray vision blocks `.constructor` access on Uint8Arrays that originate
 * from fetch responses (different compartment from Emscripten's classic-script realm).
 * Emscripten's FS.writeFile internally checks `data.constructor` which triggers the error.
 *
 * Fix: copy data into the Emscripten heap (HEAPU8, which lives in the same realm as
 * the Emscripten code), then pass a subarray of HEAPU8 to FS.writeFile so that the
 * constructor check sees an object in the correct compartment.
 */
function writeBinaryToFS(core: any, name: string, data: Uint8Array): void {
  const len = data.byteLength;
  const ptr = core._malloc(len);
  if (!ptr) throw new Error(`Failed to allocate ${len} bytes for ${name}`);

  try {
    // Try fast bulk copy first. HEAPU8.set() uses indexed element access which
    // is safe across Firefox compartment boundaries.
    core.HEAPU8.set(data, ptr);
  } catch {
    // Fallback: byte-by-byte indexed access (always Xray-safe)
    for (let i = 0; i < len; i++) {
      core.HEAPU8[ptr + i] = data[i];
    }
  }

  // subarray() returns a view into HEAPU8 — same realm as Emscripten, no Xray issue
  core.FS.writeFile(name, core.HEAPU8.subarray(ptr, ptr + len));
  core._free(ptr);
}

/**
 * Write segment files and playlists to FFmpeg FS
 */
function writeFilesToFS(
  core: any,
  videoPlaylist: string,
  videoSegments: { name: string; data: Uint8Array }[],
  audioPlaylist: string,
  audioSegments: { name: string; data: Uint8Array }[],
): DownloadResult<void> {
  try {
    // Write video segments with original filenames
    for (let i = 0; i < videoSegments.length; i++) {
      const seg = videoSegments[i];
      console.log(`[FFmpeg] Writing: ${seg.name} (${seg.data.length} bytes)`);
      writeBinaryToFS(core, seg.name, seg.data);
    }

    // Write audio segments with original filenames
    for (let i = 0; i < audioSegments.length; i++) {
      const seg = audioSegments[i];
      console.log(`[FFmpeg] Writing: ${seg.name} (${seg.data.length} bytes)`);
      writeBinaryToFS(core, seg.name, seg.data);
    }

    // Write modified video playlist (with local filenames)
    console.log('[FFmpeg] Writing video.m3u8');
    core.FS.writeFile('video.m3u8', new TextEncoder().encode(videoPlaylist));

    // Write modified audio playlist (with local filenames)
    console.log('[FFmpeg] Writing audio.m3u8');
    core.FS.writeFile('audio.m3u8', new TextEncoder().encode(audioPlaylist));

    return ok(undefined);
  } catch (fsError) {
    console.error('[FFmpeg] FS write error:', fsError);
    return err({
      type: 'FFMPEG_FS_ERROR',
      message: `FS error: ${fsError instanceof Error ? fsError.message : String(fsError)}`,
      cause: fsError,
    });
  }
}

/**
 * Cleanup filesystem after muxing
 */
function cleanupFS(
  core: any,
  videoSegments: { name: string; data: Uint8Array }[],
  audioSegments: { name: string; data: Uint8Array }[],
  outputFilename: string,
): void {
  try {
    for (const seg of videoSegments) core.FS.unlink(seg.name);
    for (const seg of audioSegments) core.FS.unlink(seg.name);
    core.FS.unlink('video.m3u8');
    core.FS.unlink('audio.m3u8');
    core.FS.unlink(outputFilename);
  } catch {
    /* ignore cleanup errors */
  }
}

/**
 * Legacy function for backwards compatibility
 */
export function muxToMp4(
  videoData: Uint8Array,
  audioData: Uint8Array,
  outputFilename: string = 'output.mp4',
): ResultAsync<Uint8Array, DownloadError> {
  console.warn('[FFmpeg] muxToMp4 called - use muxWithPlaylist for M3U8-based muxing');

  // Create simple wrapper
  return muxWithPlaylist(
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:0,\nvideo.ts',
    [{ name: 'video.ts', data: videoData }],
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:0,\naudio.ts',
    [{ name: 'audio.ts', data: audioData }],
    outputFilename,
  );
}
