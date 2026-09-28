# Vendored: Chromium T-Rex runner

Source: https://github.com/chromium/chromium (mirror of chromium.googlesource.com/chromium/src)
Commit: 644979367abdf38df19730eac6754da5871f867d (last change to dino_game, 2026-03-10)
Paths:
- components/neterror/resources/dino_game/*.ts  → dino_game/
- components/neterror/resources/constants.ts     → neterror_constants.ts (imported as ../constants.js)
- components/neterror/resources/neterror.html    → neterror.html (reference for the host page)
- components/neterror/resources/images/default_{100,200}_percent/offline/{100,200}-offline-sprite.png → images/
- LICENSE (BSD-3-Clause, The Chromium Authors)

These files are **unedited**. `build.mjs` resolves the two `chrome://resources/js/*` imports to
`src/hook/stubs/` at bundle time. `test/vendor.test.ts` fails if any file below changes.

## SHA-256
    368cca1106be99d39ecd32a38d8305585d802a475effb66380b91ffc9bcf709b  ./LICENSE
    aa0a1f3fc55bd9c98cf395b09ed56633ac76c890854529abccafa4216471b6b2  ./dino_game/background_el.ts
    80db07c33522c86a8d8cbe7bb132cb1633d182aa74e54fb443da952818edb443  ./dino_game/cloud.ts
    2c6b09f9a6cad4f781ad81b1da9cc7036594d607c67d756bdfc2b66a076768a2  ./dino_game/constants.ts
    c6187ac40dea448515e594a3312fda872704f9f7055dccc38f5e6ca9c6615abe  ./dino_game/dimensions.ts
    f23707226c7300a439c29bb16de98510c3a981bd3fc144b14a79ef90c3751bc8  ./dino_game/distance_meter.ts
    f9a1b31165f04f22240d56440b5e2e4a0c326e1bcaeeca5e5c5079e8fd7d3534  ./dino_game/game_config.ts
    2aa61dd76588b2a0b0c8c393aa68247736c542006bc29869eb1c0f5f12a19747  ./dino_game/game_over_panel.ts
    54232d9ba0d64068453c2eec01c3e540ddfdf05fb17e6721dc8e23841acabacf  ./dino_game/game_state_provider.ts
    2462115ad165255a2eefb467315eee99b2b1bd087bd75e0c6e332bc8062555a2  ./dino_game/generated_sound_fx.ts
    a5dcd3e56145c6fd39bd2c2626ae433c7be768d941b5c44e1b8dd00edfa99d22  ./dino_game/horizon.ts
    6c58d26133698c988b6bc1037c9e6830152fa3f817e91d1f51dbfb066c046366  ./dino_game/horizon_line.ts
    b366a15eacd6d77781a7c83d6440b22306a60977fbadb58be6e48245f54d661e  ./dino_game/image_sprite_provider.ts
    e1a00e8b3be455b7e24b91a72349042619f1bb100324db137bf39955e4e65626  ./dino_game/night_mode.ts
    18215a0292cbb56a293775440687ffb83a3bbb7ce4da69b41a0d20c05ac9e350  ./dino_game/obstacle.ts
    3d6e251e07c7ff8a5d981c2cc736a2a2fa3dd3c4bf1b7e58546f83255e4af2ad  ./dino_game/offline.ts
    d17f339d17bfbdffb1130529bbbe48ab1024ec6344a5d21f41a93351502a3f48  ./dino_game/offline_sprite_definitions.ts
    780e68b8bee6dd0b23d404975c5ea63f2a887fb861a9a9fa6d65c292cbce68ab  ./dino_game/sprite_position.ts
    bc40b980ebc151ac0c6c88a0aae45a9e459af4e212c6cb15d91a1e87cd86417d  ./dino_game/trex.ts
    281b92309b765537564c135e29519d04cfef750c2b40c4517ec294bb808b9bd3  ./dino_game/utils.ts
    04d05978fdb111358073ab0524e5c1fafc0826615c206987618416b8bd8a4747  ./images/100-offline-sprite.png
    e4222715b556e7d99622c83e620d2f8e090047e56adb07923047f95828d561f2  ./images/200-offline-sprite.png
    30149ace9c9a5ca429f8a1398221684142f1bf22ddcfe02652e87cfc2123fc0c  ./neterror.html
    d76d69c9c375f22761dd4229599041b93f6b81f60a0433f924493287c77fad59  ./neterror_constants.ts
