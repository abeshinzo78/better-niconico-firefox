/**
 * Post-build script to inject ffmpeg-core2.js into manifest content_scripts
 * This is needed because crxjs doesn't handle static JS files in content_scripts
 */

import fs from 'fs';
import path from 'path';

const distDir = './dist';
const manifestPath = path.join(distDir, 'manifest.json');

// Read manifest
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

// Find the nicovideo content script entry
const contentScript = manifest.content_scripts?.find((cs) =>
  cs.matches?.some((m) => m.includes('nicovideo.jp')),
);

if (contentScript) {
  // Prepend ffmpeg-core2.js to the js array
  if (!contentScript.js.includes('ffmpeg/ffmpeg-core2.js')) {
    contentScript.js.unshift('ffmpeg/ffmpeg-core2.js');
    console.log('[post-build] Added ffmpeg-core2.js to content_scripts');
  }
}

// Add pip-helper.js as a MAIN world content script
// Firefox 128+ supports world: "MAIN" which ensures the script runs in the page's
// global scope where requestPictureInPicture() is accessible without Xray filtering.
const pipHelperEntry = manifest.content_scripts?.find((cs) => cs.js?.includes('pip-helper.js'));
if (!pipHelperEntry) {
  if (!manifest.content_scripts) manifest.content_scripts = [];
  manifest.content_scripts.push({
    matches: ['*://*.nicovideo.jp/*'],
    js: ['pip-helper.js'],
    world: 'MAIN',
    run_at: 'document_start',
  });
  console.log('[post-build] Added pip-helper.js as MAIN world content script');
}

// Remove scripting permission if present (not needed with direct content script)
if (manifest.permissions?.includes('scripting')) {
  manifest.permissions = manifest.permissions.filter((p) => p !== 'scripting');
  console.log('[post-build] Removed scripting permission');
}

// Ensure browser_specific_settings is present for Firefox
if (!manifest.browser_specific_settings) {
  manifest.browser_specific_settings = {
    gecko: {
      id: 'better-niconico@example.com',
      strict_min_version: '109.0',
    },
  };
  console.log('[post-build] Added browser_specific_settings for Firefox');
}

// Ensure content_security_policy allows wasm
if (!manifest.content_security_policy) {
  manifest.content_security_policy = {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  };
  console.log('[post-build] Added content_security_policy for wasm');
}

// Firefox MV3: Ensure background uses scripts array, not service_worker
if (manifest.background?.service_worker && !manifest.background?.scripts) {
  const sw = manifest.background.service_worker;
  manifest.background = {
    scripts: [sw],
    type: 'module',
  };
  console.log('[post-build] Converted service_worker to background.scripts for Firefox');
}

// Write updated manifest
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log('[post-build] Manifest updated successfully');
