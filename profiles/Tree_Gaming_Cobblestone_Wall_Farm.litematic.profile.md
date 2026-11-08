# Build analysis: Tree Gaming Cobblestone Wall Farm.litematic

- Size 41 x 26 x 35, 5,988 blocks, 43 layer steps, 237 pieces

## Time

| Setup | Planner estimate | Calibrated guess (x2.7) |
|---|---|---|
| 1 bot | 6 h 32 min | 17 h 38 min |
| 4 bots | 1 h 55 min | 5 h 11 min |

## Work split

| Worker | Blocks | Walking | Planner min | Area |
|---|---|---|---|---|
| BuilderBot1 | 1487 | 2655 | 98 | x 0..26, z 0..17 |
| BuilderBot2 | 1500 | 2779 | 99 | x 0..33, z 0..34 |
| BuilderBot3 | 1491 | 2698 | 98 | x 1..40, z 0..33 |
| BuilderBot4 | 1510 | 2861 | 100 | x 1..40, z 2..34 |

## Materials

| Item | Count | Stacks | Shulker boxes |
|---|---|---|---|
| cobblestone | 1620 | 26 | 1.0 |
| packed_ice | 1191 | 19 | 0.7 |
| water (waterlogging) | 550 | 9 | 0.3 |
| oak_leaves | 549 | 9 | 0.3 |
| white_stained_glass | 413 | 7 | 0.3 |
| glass | 398 | 7 | 0.3 |
| redstone_wire | 295 | 5 | 0.2 |
| smooth_stone | 241 | 4 | 0.1 |
| water | 208 | 4 | 0.1 |
| piston | 198 | 4 | 0.1 |
| chest | 58 | 1 | 0.0 |
| lava | 54 | 1 | 0.0 |
| crafter | 29 | 1 | 0.0 |
| hopper | 29 | 1 | 0.0 |
| observer | 28 | 1 | 0.0 |
| spruce_fence_gate | 23 | 1 | 0.0 |
| tripwire_hook | 18 | 1 | 0.0 |
| spruce_wall_sign | 16 | 1 | 0.0 |
| redstone_torch | 10 | 1 | 0.0 |
| repeater | 9 | 1 | 0.0 |
| tripwire | 9 | 1 | 0.0 |
| dropper | 9 | 1 | 0.0 |
| oak_fence | 9 | 1 | 0.0 |
| oak_wall_sign | 9 | 1 | 0.0 |
| tnt | 9 | 1 | 0.0 |
| lever | 2 | 1 | 0.0 |
| soul_sand | 1 | 1 | 0.0 |
| iron_trapdoor | 1 | 1 | 0.0 |
| redstone_lamp | 1 | 1 | 0.0 |
| comparator | 1 | 1 | 0.0 |

## Special blocks

- pistons: 198
- observers: 28
- hoppers: 29
- rails: 0
- redstone: 318
- fluids: 262
- waterlogged: 550
- lanterns: 0
- trapdoorsDoors: 25
- tnt: 9
- signsBanners: 25
- orientationSensitive: 402
- powerPhase: 12

## Risks

- 9 TNT: the bots pause before the power blocks; check the build, then !resume
- 812 water/lava placements, one bucket each (buckets do not stack)
- 28 observers are placed after all structure/fluids (so they do not fire early) and before the power blocks
- 262 fluid sources touch open air outside the schematic: they may spill. Check the edges after pouring
- 73 blocks without a neighbour need scaffold blocks
- 73 blocks have no neighbour block in the schematic (they will need scaffold/reference blocks)

## Layers

| y | Blocks | Main blocks |
|---|---|---|
| 0 | 35 | packed_ice 34, soul_sand 1 |
| 1 | 80 | glass 72, spruce_fence_gate 4, water 4 |
| 2 | 358 | packed_ice 354, glass 4 |
| 3 | 978 | packed_ice 800, glass 106, water 56 |
| 4 | 324 | glass 172, water 136, spruce_wall_sign 16 |
| 5 | 122 | chest 58, crafter 29, hopper 29 |
| 6 | 79 | glass 41, smooth_stone 29, spruce_fence_gate 3 |
| 7 | 39 | redstone_wire 35, repeater 3, observer 1 |
| 8 | 126 | oak_leaves 126 |
| 9 | 324 | cobblestone 180, oak_leaves 108, white_stained_glass 36 |
| 10 | 324 | cobblestone 180, oak_leaves 108, white_stained_glass 36 |
| 11 | 324 | cobblestone 180, oak_leaves 108, white_stained_glass 36 |
| 12 | 324 | cobblestone 180, oak_leaves 108, white_stained_glass 36 |
| 13 | 324 | cobblestone 180, oak_leaves 108, white_stained_glass 36 |
| 14 | 324 | cobblestone 180, oak_leaves 108, white_stained_glass 36 |
| 15 | 324 | cobblestone 180, oak_leaves 108, white_stained_glass 36 |
| 16 | 324 | cobblestone 180, oak_leaves 108, white_stained_glass 36 |
| 17 | 378 | cobblestone 180, oak_leaves 108, lava 54 |
| 18 | 261 | piston 180, smooth_stone 81 |
| 19 | 207 | redstone_wire 153, tripwire_hook 18, white_stained_glass 9 |
| 20 | 9 | redstone_torch 9 |
| 21 | 27 | white_stained_glass 18, smooth_stone 9 |
| 22 | 146 | smooth_stone 74, white_stained_glass 44, water 9 |
| 23 | 146 | redstone_wire 62, smooth_stone 21, piston 18 |
| 24 | 45 | smooth_stone 27, redstone_wire 9, white_stained_glass 9 |
| 25 | 36 | redstone_wire 36 |
