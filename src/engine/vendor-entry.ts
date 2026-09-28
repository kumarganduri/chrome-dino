// Re-exports the unedited Chromium dino modules as one bundle. Nothing here
// changes behaviour; it only makes the classes reachable from our code.
export {Runner} from '../../vendor/chromium-dino/dino_game/offline.ts';
export {Trex, Status as TrexStatus} from '../../vendor/chromium-dino/dino_game/trex.ts';
export {Horizon} from '../../vendor/chromium-dino/dino_game/horizon.ts';
export {Obstacle} from '../../vendor/chromium-dino/dino_game/obstacle.ts';
export {Cloud} from '../../vendor/chromium-dino/dino_game/cloud.ts';
export {NightMode} from '../../vendor/chromium-dino/dino_game/night_mode.ts';
export {HorizonLine} from '../../vendor/chromium-dino/dino_game/horizon_line.ts';
export {BackgroundEl, getGlobalConfig as getBackgroundElConfig} from '../../vendor/chromium-dino/dino_game/background_el.ts';
export {DistanceMeter} from '../../vendor/chromium-dino/dino_game/distance_meter.ts';
export {GameOverPanel} from '../../vendor/chromium-dino/dino_game/game_over_panel.ts';
export {CollisionBox, spriteDefinitionByType} from '../../vendor/chromium-dino/dino_game/offline_sprite_definitions.ts';
export {DEFAULT_DIMENSIONS, FPS, IS_HIDPI, IS_IOS, IS_MOBILE} from '../../vendor/chromium-dino/dino_game/constants.ts';
