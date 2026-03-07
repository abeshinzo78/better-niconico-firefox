/**
 * Better Niconico - PiP Helper (runs in page's main world)
 *
 * This script runs in the page's MAIN world (via content_scripts with world: "MAIN").
 * In the main world, all PiP APIs are directly accessible without Xray wrapper restrictions.
 *
 * Flow:
 *   content script: appends bn-pip-canvas to DOM, dispatches bn-pip-request
 *   pip-helper.js:  finds canvas → captureStream(30) → creates video → play() → requestPiP()
 *                   on success: dispatches bn-pip-enter
 *                   on failure: dispatches bn-pip-error
 *   video.leavepictureinpicture: removes video, dispatches bn-pip-leave
 *   content script: bn-pip-leave / bn-pip-error → stopPiP() (removes canvas, stops loop)
 */
(function () {
  'use strict';

  // 二重登録防止（content_scripts + 動的注入の両方から読まれる場合）
  if (window.__bnPipHelperLoaded) return;
  window.__bnPipHelperLoaded = true;

  var PIP_CANVAS_ID = 'bn-pip-canvas';
  var PIP_VIDEO_ID = 'bn-pip-video';

  function dispatchError(message) {
    console.error('[BN pip-helper] エラー:', message);
    document.dispatchEvent(
      new CustomEvent('bn-pip-error', { detail: { message: message } }),
    );
  }

  // Request PiP from content script
  document.addEventListener('bn-pip-request', async function () {
    console.log('[BN pip-helper] bn-pip-request 受信');
    console.log('[BN pip-helper] document.pictureInPictureEnabled:', document.pictureInPictureEnabled);

    // --- captureStream アプローチ（コメント合成あり）---
    var canvas = document.getElementById(PIP_CANVAS_ID);
    console.log('[BN pip-helper] canvas:', canvas, 'captureStream:', canvas && typeof canvas.captureStream);

    if (canvas && typeof canvas.captureStream === 'function') {
      var stream;
      try {
        stream = canvas.captureStream(30);
      } catch (e) {
        console.warn('[BN pip-helper] captureStream 失敗:', e);
        stream = null;
      }

      if (stream) {
        var capVideo = document.createElement('video');
        capVideo.id = PIP_VIDEO_ID;
        capVideo.autoplay = true;
        capVideo.muted = true;
        capVideo.srcObject = stream;
        capVideo.controls = true;
        capVideo.style.cssText =
          'position:fixed;top:0;left:0;opacity:0;pointer-events:none;width:1px;height:1px;';

        capVideo.addEventListener('leavepictureinpicture', function () {
          capVideo.pause();
          capVideo.srcObject = null;
          if (capVideo.parentNode) capVideo.parentNode.removeChild(capVideo);
          document.dispatchEvent(new CustomEvent('bn-pip-leave'));
        });

        // PiP側からの再生・停止操作をメインビデオに同期
        capVideo.addEventListener('play', function () {
          var mainVideo = document.querySelector('[data-bn-main-video]');
          if (mainVideo && mainVideo.paused) mainVideo.play().catch(function () {});
        });
        capVideo.addEventListener('pause', function () {
          var mainVideo = document.querySelector('[data-bn-main-video]');
          if (mainVideo && !mainVideo.paused) mainVideo.pause();
        });

        document.body.appendChild(capVideo);

        console.log('[BN pip-helper] capVideo.requestPictureInPicture type:', typeof capVideo.requestPictureInPicture);

        try {
          // メインワールドなので直接インスタンスメソッドを呼ぶ（Xray制限なし）
          await capVideo.play();
          
          if (typeof capVideo.requestPictureInPicture === 'function') {
            await capVideo.requestPictureInPicture();
            document.dispatchEvent(new CustomEvent('bn-pip-enter'));
            console.log('[BN pip-helper] captureStream PiP 成功');
            return;
          } else {
            // Firefoxフォールバック: プログラムからPiPが開始できないため、
            // 動画をDOM上に固定表示し、ユーザーにネイティブPiPボタンを押させる
            console.log('[BN pip-helper] requestPictureInPicture API 非対応。手動トリガー待ちモードへ');
            capVideo.style.cssText = 'position:fixed;bottom:20px;right:20px;width:320px;height:180px;z-index:999999;border:2px solid #000;box-shadow:0 0 10px rgba(0,0,0,0.5);cursor:pointer;';
            capVideo.title = 'Firefoxでは自動PiPができません。動画上のトグルボタン、または右クリックからPicture-in-Pictureを選択してください。';
            
            // PiPに入ったら非表示にする
            capVideo.addEventListener('enterpictureinpicture', () => {
              capVideo.style.opacity = '0';
              capVideo.style.pointerEvents = 'none';
              document.dispatchEvent(new CustomEvent('bn-pip-enter'));
            });

            document.dispatchEvent(new CustomEvent('bn-pip-fallback', {
              detail: { message: 'Firefoxでは自動PiPができません。右下に表示された動画から手動でPiPを開始してください。' }
            }));
            return;
          }
        } catch (pipErr) {
          console.warn('[BN pip-helper] captureStream PiP 失敗:', pipErr);
          // 失敗した場合はクリーンアップ
          capVideo.pause();
          capVideo.srcObject = null;
          if (capVideo.parentNode) capVideo.parentNode.removeChild(capVideo);
        }
      }
    }

    // --- フォールバック: 元の動画要素に直接 requestPictureInPicture ---
    // Firefox では captureStream の MediaStream を srcObject に持つ video で PiP が
    // 使えない場合があるため、content script がマークした元動画を使う
    var mainVideo = document.querySelector('[data-bn-main-video]');
    console.log('[BN pip-helper] mainVideo:', mainVideo);
    console.log('[BN pip-helper] mainVideo.requestPictureInPicture type:', mainVideo && typeof mainVideo.requestPictureInPicture);

    if (!mainVideo) {
      dispatchError('PiP: 対象動画が見つかりません');
      return;
    }

    try {
      mainVideo.addEventListener(
        'leavepictureinpicture',
        function () {
          document.dispatchEvent(new CustomEvent('bn-pip-leave'));
        },
        { once: true },
      );
      await mainVideo.requestPictureInPicture();
      document.dispatchEvent(new CustomEvent('bn-pip-enter'));
      console.log('[BN pip-helper] mainVideo PiP 成功');
    } catch (err) {
      dispatchError((err && err.message) || 'requestPictureInPicture failed');
    }
  });

  // Exit PiP from content script
  document.addEventListener('bn-pip-exit', function () {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(function () {});
    } else {
      // フォールバック状態（右下固定動画）の場合のクリーンアップ
      var capVideo = document.getElementById(PIP_VIDEO_ID);
      if (capVideo) {
        capVideo.pause();
        capVideo.srcObject = null;
        if (capVideo.parentNode) capVideo.parentNode.removeChild(capVideo);
        document.dispatchEvent(new CustomEvent('bn-pip-leave'));
      }
    }
  });
})();
