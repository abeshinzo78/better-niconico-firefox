/**
 * Picture-in-Picture (PiP) 機能
 * ニコニコ動画の動画、サポーター表示、コメントを合成してPiP表示する
 * watch ページでのみ動作します
 *
 * Firefox対応:
 * - requestPictureInPicture() は Firefox の Xray ラッパー越しに呼べないため、
 *   pip-helper.js をページのメインワールドに注入し、CustomEvent 経由で呼び出す
 */

import { Result, ok, err } from 'neverthrow';
import type { VideoError, PageError } from '../../types/errors';
import {
  videoElementNotFoundError,
  videoNotReadyError,
  videoDimensionsInvalidError,
  domElementNotFoundError,
} from '../../types/errors';

// マーカー属性
const PIP_BUTTON_MARKER = 'data-bn-pip-button';
const PIP_CANVAS_MARKER = 'data-bn-pip-canvas';

// 要素ID
const PIP_BUTTON_ID = 'bn-pip-button';
const PIP_CANVAS_ID = 'bn-pip-canvas';

// グローバル状態
let isRunningInPIP: boolean = false;
let videoFrameCallbackId: number | null = null;
let animationFrameId: number | null = null;
let pipButton: HTMLButtonElement | null = null;
let pipCanvas: HTMLCanvasElement | null = null;
let pipCanvasContext: CanvasRenderingContext2D | null = null;
let mainVideo: HTMLVideoElement | null = null;
let commentCanvas: HTMLCanvasElement | null = null;
let supporterCanvas: HTMLCanvasElement | null = null;

// pip-helper.js の注入状態
let pipHelperInjected = false;

// pip-helper.js からのイベントリスナー登録済みフラグ
let pipEventListenersAdded = false;

// requestVideoFrameCallback サポートチェック
function supportsRequestVideoFrameCallback(): boolean {
  return 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
}

/**
 * pip-helper.js をページのメインワールドにインライン注入する
 *
 * src 属性による外部スクリプト注入は Firefox の Xray 分離を抜けられない場合があるため、
 * fetch でコードを取得し textContent として注入する。インラインスクリプトはページの
 * グローバルスコープで実行されるため、requestPictureInPicture にアクセスできる。
 */
async function injectPiPHelper(): Promise<void> {
  if (pipHelperInjected) return;
  pipHelperInjected = true;

  try {
    const url = chrome.runtime.getURL('pip-helper.js');
    const response = await fetch(url);
    const code = await response.text();

    const script = document.createElement('script');
    script.textContent = code;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch {
    // テスト環境や取得失敗時は無視（world:MAIN の content script がある場合はそちらで動く）
  }
}

/**
 * 動画視聴ページかどうかを判定
 */
function isWatchPage(): boolean {
  return window.location.pathname.startsWith('/watch/');
}

/**
 * アスペクト比を保持しながらリサイズした寸法を計算
 */
function calcSize(
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): { width: number; height: number } {
  const wr = dstWidth / srcWidth;
  const hr = dstHeight / srcHeight;
  const rate = Math.min(wr, hr);
  return {
    width: Math.floor(srcWidth * rate),
    height: Math.floor(srcHeight * rate),
  };
}

/**
 * 広告動画かどうかを判定
 */
function isAdVideo(video: HTMLVideoElement): boolean {
  const adContainer = document.getElementById('nv_watch_VideoAdContainer');
  return adContainer?.contains(video) ?? false;
}

/**
 * 有効なコンテンツ動画かどうかを判定
 */
function isValidContentVideo(video: HTMLVideoElement): boolean {
  return video.src !== '' && video.videoWidth > 0 && video.videoHeight > 0 && !isAdVideo(video);
}

/**
 * メインコンテンツの動画要素を取得
 */
function getMainVideo(): Result<HTMLVideoElement, VideoError | PageError> {
  const playerArea = document.querySelector('.grid-area_\\[player\\]');
  if (!playerArea) {
    return err(domElementNotFoundError('Player area not found', '.grid-area_[player]'));
  }

  const videos = Array.from(playerArea.querySelectorAll('video')) as HTMLVideoElement[];

  let bestVideo: HTMLVideoElement | null = null;
  let bestReadyState = -1;

  for (const video of videos) {
    if (isValidContentVideo(video)) {
      if (video.readyState > bestReadyState) {
        bestVideo = video;
        bestReadyState = video.readyState;
      }
    }
  }

  if (!bestVideo) {
    return err(videoElementNotFoundError('Valid content video not found'));
  }

  if (bestVideo.videoWidth <= 0 || bestVideo.videoHeight <= 0) {
    return err(
      videoDimensionsInvalidError(
        'Video dimensions not ready',
        bestVideo.videoWidth,
        bestVideo.videoHeight,
      ),
    );
  }

  return ok(bestVideo);
}

/**
 * コメントキャンバス要素を取得
 */
function getCommentCanvas(): Result<HTMLCanvasElement, PageError> {
  const playerArea = document.querySelector('.grid-area_\\[player\\]');
  if (!playerArea) {
    return err(domElementNotFoundError('Player area not found', '.grid-area_[player]'));
  }

  const commentContainer = playerArea.querySelector('[data-name="comment"]');
  if (!commentContainer) {
    return err(domElementNotFoundError('Comment container not found', '[data-name="comment"]'));
  }

  const canvas = commentContainer.querySelector('canvas') as HTMLCanvasElement;
  if (!canvas) {
    return err(domElementNotFoundError('Comment canvas not found', '[data-name="comment"] canvas'));
  }

  return ok(canvas);
}

/**
 * サポーターキャンバス要素を取得（オプショナル）
 */
function getSupporterCanvas(): Result<HTMLCanvasElement | null, PageError> {
  const playerArea = document.querySelector('.grid-area_\\[player\\]');
  if (!playerArea) {
    return err(domElementNotFoundError('Player area not found', '.grid-area_[player]'));
  }

  const supporterContainer = playerArea.querySelector('[data-name="supporter-content"]');
  if (!supporterContainer) {
    return ok(null);
  }

  const canvas = supporterContainer.querySelector('canvas') as HTMLCanvasElement;
  return ok(canvas ?? null);
}

/**
 * PiPボタンを作成
 */
function createPiPButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.id = PIP_BUTTON_ID;
  button.setAttribute(PIP_BUTTON_MARKER, 'true');
  button.type = 'button';
  button.title = 'Picture-in-Picture';
  button.setAttribute('aria-label', 'Picture-in-Picture');
  button.className = 'Pressable cursor_pointer';
  button.style.color = '#FFFFFF';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('fill', 'none');

  const rect1 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect1.setAttribute('x', '3');
  rect1.setAttribute('y', '5');
  rect1.setAttribute('width', '22');
  rect1.setAttribute('height', '18');
  rect1.setAttribute('rx', '2');
  rect1.setAttribute('stroke', 'currentColor');
  rect1.setAttribute('stroke-width', '2');
  rect1.setAttribute('fill', 'none');

  const rect2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect2.setAttribute('x', '14');
  rect2.setAttribute('y', '14');
  rect2.setAttribute('width', '9');
  rect2.setAttribute('height', '7');
  rect2.setAttribute('rx', '1');
  rect2.setAttribute('fill', 'currentColor');

  svg.appendChild(rect1);
  svg.appendChild(rect2);
  button.appendChild(svg);

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePiP();
  });

  return button;
}

/**
 * pip-helper.js からのイベントを購読（1度だけ登録）
 */
function addPiPEventListeners(): void {
  if (pipEventListenersAdded) return;
  pipEventListenersAdded = true;

  // pip-helper.js が PiP ウィンドウを閉じたとき（leavepictureinpicture）
  document.addEventListener('bn-pip-leave', () => {
    stopPiP();
  });

  // pip-helper.js が自動PiPに失敗し、手動PiP（右下固定UI）にフォールバックしたとき
  document.addEventListener('bn-pip-fallback', (e) => {
    console.log('[Better Niconico] PiP フォールバックモード:', (e as CustomEvent).detail?.message);
    // エラーにせず、合成ループを維持する（ユーザーが手動でPiP化するのを待つ）
  });

  // pip-helper.js が requestPictureInPicture に失敗したとき
  document.addEventListener('bn-pip-error', (e) => {
    console.error('[Better Niconico] PiP エラー（pip-helper.js）:', (e as CustomEvent).detail?.message);
    stopPiP();
  });
}

/**
 * PiPボタンをDOMに追加
 */
function addPiPButton(): void {
  if (pipButton && document.contains(pipButton)) {
    return;
  }

  // pip-helper.js を事前に注入（requestPictureInPicture / exitPiP のため）
  void injectPiPHelper();
  addPiPEventListeners();

  const playerArea = document.querySelector('.grid-area_\\[player\\]');
  if (!playerArea) {
    return;
  }

  const fullscreenButton = Array.from(playerArea.querySelectorAll('button')).find(
    (btn) => btn.getAttribute('aria-label') === '全画面表示する',
  );

  if (!fullscreenButton) {
    console.warn('[Better Niconico] 全画面表示ボタンが見つかりません');
    return;
  }

  const controlBarButtonGroup = fullscreenButton.parentElement;
  if (!controlBarButtonGroup) {
    console.warn('[Better Niconico] コントロールバーのボタングループが見つかりません');
    return;
  }

  pipButton = createPiPButton();
  controlBarButtonGroup.insertBefore(pipButton, fullscreenButton);

  console.log('[Better Niconico] PiPボタンをコントロールバーに追加しました');
}

/**
 * PiPボタンを削除
 */
function removePiPButton(): void {
  if (pipButton) {
    pipButton.remove();
    pipButton = null;
    console.log('[Better Niconico] PiPボタンを削除しました');
  }
}

/**
 * 合成用のcanvasとcontextを作成
 */
function createCompositeCanvas(
  video: HTMLVideoElement,
): Result<{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }, VideoError> {
  const canvas = document.createElement('canvas');
  canvas.id = PIP_CANVAS_ID;
  canvas.setAttribute(PIP_CANVAS_MARKER, 'true');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    return err(videoNotReadyError('Failed to get 2D context from canvas', 0));
  }

  return ok({ canvas, context });
}

/**
 * フレームを合成してキャンバスに描画
 */
function renderCompositeFrame(): void {
  if (!mainVideo || !commentCanvas || !pipCanvas || !pipCanvasContext) {
    return;
  }

  pipCanvasContext.fillStyle = '#000';
  pipCanvasContext.fillRect(0, 0, pipCanvas.width, pipCanvas.height);

  // メイン映像を描画
  if (mainVideo.videoWidth > 0 && mainVideo.videoHeight > 0) {
    const videoSize = calcSize(
      mainVideo.videoWidth,
      mainVideo.videoHeight,
      pipCanvas.width,
      pipCanvas.height,
    );
    pipCanvasContext.drawImage(
      mainVideo,
      0,
      0,
      mainVideo.videoWidth,
      mainVideo.videoHeight,
      (pipCanvas.width - videoSize.width) / 2,
      (pipCanvas.height - videoSize.height) / 2,
      videoSize.width,
      videoSize.height,
    );
  }

  // サポーター表示を描画
  if (supporterCanvas) {
    const playerArea = document.querySelector('.grid-area_\\[player\\]');
    const supporterContainer = playerArea?.querySelector('[data-name="supporter-content"]');

    if (supporterContainer && getComputedStyle(supporterContainer).opacity !== '0') {
      const supporterSize = calcSize(
        supporterCanvas.width,
        supporterCanvas.height,
        pipCanvas.width,
        pipCanvas.height,
      );
      pipCanvasContext.drawImage(
        supporterCanvas,
        0,
        0,
        supporterCanvas.width,
        supporterCanvas.height,
        (pipCanvas.width - supporterSize.width) / 2,
        (pipCanvas.height - supporterSize.height) / 2,
        supporterSize.width,
        supporterSize.height,
      );
    }
  }

  // コメントキャンバスを描画
  const commentSize = calcSize(
    commentCanvas.width,
    commentCanvas.height,
    pipCanvas.width,
    pipCanvas.height,
  );
  pipCanvasContext.drawImage(
    commentCanvas,
    0,
    0,
    commentCanvas.width,
    commentCanvas.height,
    (pipCanvas.width - commentSize.width) / 2,
    (pipCanvas.height - commentSize.height) / 2,
    commentSize.width,
    commentSize.height,
  );

}

/**
 * requestVideoFrameCallback を使用した合成ループ
 */
function compositeLoopWithVideoFrameCallback(): void {
  if (!isRunningInPIP || !mainVideo || !commentCanvas || !pipCanvas || !pipCanvasContext) {
    return;
  }

  if (!commentCanvas.parentElement || commentCanvas.width === 0 || commentCanvas.height === 0) {
    console.log('[Better Niconico] コメントレイヤーの破棄を検知しました。PiPを再初期化します');
    void reinitializePiP();
    return;
  }

  renderCompositeFrame();

  videoFrameCallbackId = mainVideo.requestVideoFrameCallback(() => {
    compositeLoopWithVideoFrameCallback();
  });
}

/**
 * requestAnimationFrame を使用した合成ループ（フォールバック）
 */
function compositeLoopWithAnimationFrame(): void {
  if (!isRunningInPIP || !mainVideo || !commentCanvas || !pipCanvas || !pipCanvasContext) {
    return;
  }

  if (!commentCanvas.parentElement || commentCanvas.width === 0 || commentCanvas.height === 0) {
    console.log('[Better Niconico] コメントレイヤーの破棄を検知しました。PiPを再初期化します');
    void reinitializePiP();
    return;
  }

  renderCompositeFrame();
  animationFrameId = requestAnimationFrame(compositeLoopWithAnimationFrame);
}

/**
 * 合成ループを開始
 */
function startCompositeLoop(): void {
  if (supportsRequestVideoFrameCallback() && mainVideo) {
    console.log('[Better Niconico] requestVideoFrameCallback を使用（フレーム同期モード）');
    compositeLoopWithVideoFrameCallback();
  } else {
    console.log('[Better Niconico] requestAnimationFrame を使用（フォールバックモード）');
    compositeLoopWithAnimationFrame();
  }
}

/**
 * 合成ループを停止
 */
function stopCompositeLoop(): void {
  if (videoFrameCallbackId !== null && mainVideo) {
    mainVideo.cancelVideoFrameCallback(videoFrameCallbackId);
    videoFrameCallbackId = null;
  }

  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

/**
 * PiPを開始
 * Firefox Xray Vision の制限により requestPictureInPicture() はコンテンツスクリプトから
 * 直接呼べないため、canvas を DOM に追加し pip-helper.js (メインワールド) に処理を委譲する
 */
function startPiP(): void {
  if (isRunningInPIP) {
    console.log('[Better Niconico] PiPは既に実行中です');
    return;
  }

  console.log('[Better Niconico] PiPを開始します...');

  const videoResult = getMainVideo();
  if (videoResult.isErr()) {
    console.error('[Better Niconico] メインビデオが見つかりません:', videoResult.error);
    return;
  }
  mainVideo = videoResult.value;

  const canvasResult = getCommentCanvas();
  if (canvasResult.isErr()) {
    console.error('[Better Niconico] コメントキャンバスが見つかりません:', canvasResult.error);
    return;
  }
  commentCanvas = canvasResult.value;

  const supporterResult = getSupporterCanvas();
  if (supporterResult.isErr()) {
    console.error('[Better Niconico] サポーターキャンバスの取得に失敗:', supporterResult.error);
    return;
  }
  supporterCanvas = supporterResult.value;
  if (supporterCanvas) {
    console.log('[Better Niconico] サポーター表示を検出しました');
  }

  const compositeResult = createCompositeCanvas(mainVideo);
  if (compositeResult.isErr()) {
    console.error('[Better Niconico] 合成キャンバスの作成に失敗:', compositeResult.error);
    return;
  }
  pipCanvas = compositeResult.value.canvas;
  pipCanvasContext = compositeResult.value.context;

  // canvas を DOM に追加してメインワールド（pip-helper.js）からアクセスできるようにする
  pipCanvas.style.cssText =
    'position:fixed;top:0;left:0;opacity:0;pointer-events:none;width:1px;height:1px;';
  document.body.appendChild(pipCanvas);

  // pip-helper.js のフォールバック用に mainVideo を識別できるようマーク
  mainVideo.setAttribute('data-bn-main-video', 'true');

  mainVideo.style.visibility = 'hidden';
  commentCanvas.style.visibility = 'hidden';

  isRunningInPIP = true;
  startCompositeLoop();

  // pip-helper.js (メインワールド) に PiP 開始を依頼
  // pip-helper.js が canvas を見つけ captureStream → video → requestPictureInPicture を実行する
  document.dispatchEvent(new CustomEvent('bn-pip-request'));
  console.log('[Better Niconico] bn-pip-request を dispatch しました');
}

/**
 * PiPを停止
 */
function stopPiP(): void {
  if (!isRunningInPIP) {
    return;
  }

  console.log('[Better Niconico] PiPを停止します...');

  stopCompositeLoop();

  if (pipCanvas && document.contains(pipCanvas)) {
    pipCanvas.remove();
  }
  pipCanvas = null;
  pipCanvasContext = null;

  if (mainVideo) {
    mainVideo.removeAttribute('data-bn-main-video');
    mainVideo.style.visibility = '';
  }

  if (commentCanvas) {
    commentCanvas.style.visibility = '';
  }

  mainVideo = null;
  commentCanvas = null;
  supporterCanvas = null;

  isRunningInPIP = false;

  console.log('[Better Niconico] PiPを停止しました');
}

/**
 * PiPを再初期化
 */
async function reinitializePiP(): Promise<void> {
  console.log('[Better Niconico] PiPを再初期化します...');

  const wasPiPActive = isRunningInPIP;

  stopCompositeLoop();

  mainVideo = null;
  commentCanvas = null;
  supporterCanvas = null;
  isRunningInPIP = false;

  await new Promise((resolve) => setTimeout(resolve, 100));

  if (wasPiPActive) {
    startPiP();
  }
}

/**
 * PiPのトグル
 */
function togglePiP(): void {
  if (isRunningInPIP) {
    // pip-helper.js 経由で exitPictureInPicture を呼ぶ（Firefox Xray対策）
    // bn-pip-leave イベントで stopPiP が呼ばれる
    document.dispatchEvent(new CustomEvent('bn-pip-exit'));
    stopPiP();
  } else {
    startPiP();
  }
}

/**
 * 機能を有効化
 */
function enableFeature(): void {
  if (!isWatchPage()) {
    return;
  }
  addPiPButton();
}

/**
 * 機能を無効化
 */
function disableFeature(): void {
  if (isRunningInPIP) {
    stopPiP();
  }
  removePiPButton();
}

/**
 * 設定を適用する（冪等性を保証）
 */
export function apply(enabled: boolean): void {
  if (enabled) {
    enableFeature();
  } else {
    disableFeature();
  }
}
