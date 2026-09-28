// What the vendored modules see when they import './constants.js'.
// Chrome's own values for FPS and DEFAULT_DIMENSIONS; device flags pinned so
// every visitor (phone, retina, iOS, RTL) simulates the identical game. The
// page draws the 1x sprite sheet and scales the canvas with CSS
// (image-rendering: pixelated) for crisp pixels on any screen.
export {DEFAULT_DIMENSIONS, FPS} from '../../vendor/chromium-dino/dino_game/constants.ts';

export const IS_IOS = false;
export const IS_MOBILE = false;
export const IS_RTL = false;
export const IS_HIDPI = false;
