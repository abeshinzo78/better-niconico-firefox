/**
 * Tests for src/content/features/pictureInPicture.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apply } from './pictureInPicture';

const PIP_BUTTON_ID = 'bn-pip-button';
const PIP_CANVAS_ID = 'bn-pip-canvas';
const PIP_VIDEO_ID = 'bn-pip-video';

const mockContext2d = {
  fillStyle: '',
  fillRect: vi.fn(),
  drawImage: vi.fn(),
};

function setupWatchPageDOM() {
  document.body.innerHTML = `
    <div class="grid-area_[player]">
      <div class="player">
        <video src="blob:fake" style="width:1280px;height:720px;"></video>
        <div data-name="comment">
          <canvas width="1280" height="720"></canvas>
        </div>
        <button aria-label="全画面表示する">Fullscreen</button>
      </div>
    </div>
  `;

  // happy-dom では canvas.getContext('2d') が null を返すためモックが必要
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: vi.fn().mockReturnValue(mockContext2d),
    configurable: true,
    writable: true,
  });

  // happy-dom では video.srcObject に MediaStream 以外を代入できないためモックが必要
  Object.defineProperty(HTMLVideoElement.prototype, 'srcObject', {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    configurable: true,
  });

  const video = document.querySelector('video') as HTMLVideoElement;
  Object.defineProperty(video, 'src', { get: () => 'blob:fake', configurable: true });
  Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  return video;
}

describe('pictureInPicture', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetAllMocks();
    vi.stubGlobal('location', {
      pathname: '/watch/sm12345',
      href: 'https://www.nicovideo.jp/watch/sm12345',
    });
  });

  afterEach(() => {
    apply(false);
  });

  describe('apply(true)', () => {
    it('should add PiP button on watch page', () => {
      setupWatchPageDOM();
      apply(true);
      expect(document.getElementById(PIP_BUTTON_ID)).not.toBeNull();
    });

    it('should not add PiP button on non-watch page', () => {
      vi.stubGlobal('location', { pathname: '/video_top' });
      setupWatchPageDOM();
      apply(true);
      expect(document.getElementById(PIP_BUTTON_ID)).toBeNull();
    });

    it('should not throw when player area is missing', () => {
      document.body.innerHTML = '<div>No player</div>';
      expect(() => apply(true)).not.toThrow();
    });

    it('should not add duplicate button when called twice', () => {
      setupWatchPageDOM();
      apply(true);
      apply(true);
      expect(document.querySelectorAll(`#${PIP_BUTTON_ID}`).length).toBe(1);
    });
  });

  describe('apply(false)', () => {
    it('should remove PiP button', () => {
      setupWatchPageDOM();
      apply(true);
      apply(false);
      expect(document.getElementById(PIP_BUTTON_ID)).toBeNull();
    });

    it('should not throw when button does not exist', () => {
      document.body.innerHTML = '<div>No button</div>';
      expect(() => apply(false)).not.toThrow();
    });
  });

  describe('PiP start: bn-pip-request dispatch', () => {
    it('should dispatch bn-pip-request event when button clicked', async () => {
      setupWatchPageDOM();

      const requestListener = vi.fn();
      document.addEventListener('bn-pip-request', requestListener);

      apply(true);
      document.getElementById(PIP_BUTTON_ID)!.click();
      await new Promise((r) => setTimeout(r, 50));

      expect(requestListener).toHaveBeenCalledTimes(1);
      document.removeEventListener('bn-pip-request', requestListener);
    });

    it('should append pipCanvas to DOM when PiP starts', async () => {
      setupWatchPageDOM();

      apply(true);
      document.getElementById(PIP_BUTTON_ID)!.click();
      await new Promise((r) => setTimeout(r, 50));

      expect(document.getElementById(PIP_CANVAS_ID)).not.toBeNull();
    });

    it('should mark mainVideo with data-bn-main-video when PiP starts', async () => {
      const video = setupWatchPageDOM();

      apply(true);
      document.getElementById(PIP_BUTTON_ID)!.click();
      await new Promise((r) => setTimeout(r, 50));

      expect(video.getAttribute('data-bn-main-video')).toBe('true');
    });

    it('should remove data-bn-main-video from mainVideo when stopPiP is called', async () => {
      const video = setupWatchPageDOM();

      apply(true);
      document.getElementById(PIP_BUTTON_ID)!.click();
      await new Promise((r) => setTimeout(r, 50));

      document.dispatchEvent(new CustomEvent('bn-pip-leave'));
      await new Promise((r) => setTimeout(r, 50));

      expect(video.getAttribute('data-bn-main-video')).toBeNull();
    });

    it('should remove pipCanvas from DOM when bn-pip-error is received', async () => {
      setupWatchPageDOM();

      apply(true);
      document.getElementById(PIP_BUTTON_ID)!.click();
      await new Promise((r) => setTimeout(r, 50));

      // pip-helper.js からのエラーをシミュレート
      document.dispatchEvent(new CustomEvent('bn-pip-error', { detail: { message: 'test error' } }));
      await new Promise((r) => setTimeout(r, 50));

      expect(document.getElementById(PIP_CANVAS_ID)).toBeNull();
    });

    it('should remove pipCanvas from DOM when bn-pip-leave is received', async () => {
      setupWatchPageDOM();

      apply(true);
      document.getElementById(PIP_BUTTON_ID)!.click();
      await new Promise((r) => setTimeout(r, 50));

      // pip-helper.js からの leavepictureinpicture をシミュレート
      document.dispatchEvent(new CustomEvent('bn-pip-leave'));
      await new Promise((r) => setTimeout(r, 50));

      expect(document.getElementById(PIP_CANVAS_ID)).toBeNull();
    });
  });
});
