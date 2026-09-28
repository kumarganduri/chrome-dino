// What the vendored modules see when they import './constants.js'.
// Chrome's own values for FPS and DEFAULT_DIMENSIONS; device flags pinned so
// every visitor (phone, retina, iOS, RTL) simulates the identical game.
// IS_HIDPI only changes which sprite coordinates are drawn, never physics
// (test/engine.test.ts proves identical hashes both ways); the display build
// sets it from the real screen for crisp sprites.
export {DEFAULT_DIMENSIONS, FPS} from '../../vendor/chromium-dino/dino_game/constants.ts';

export const IS_IOS = false;
export const IS_MOBILE = false;
export const IS_RTL = false;
export const IS_HIDPI: boolean = (globalThis as {__DINO_HIDPI__?: boolean}).__DINO_HIDPI__ === true;
