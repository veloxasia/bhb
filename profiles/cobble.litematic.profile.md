# Build analysis: cobble.litematic

- Size 17 x 14 x 14, 897 blocks, 32 layer steps, 45 pieces

## Time

| Setup | Planner estimate | Calibrated guess (x2.7) |
|---|---|---|
| 1 bot | 0 h 59 min | 2 h 39 min |
| 4 bots | 0 h 18 min | 0 h 49 min |

## Work split

| Worker | Blocks | Walking | Planner min | Area |
|---|---|---|---|---|
| BuilderBot1 | 215 | 392 | 14 | x 0..8, z 0..8 |
| BuilderBot2 | 223 | 386 | 15 | x 0..15, z 0..13 |
| BuilderBot3 | 217 | 343 | 14 | x 4..16, z 0..9 |
| BuilderBot4 | 242 | 431 | 16 | x 4..16, z 3..13 |

## Materials

| Item | Count | Stacks | Shulker boxes |
|---|---|---|---|
| dirt | 449 | 8 | 0.3 |
| grass_block | 163 | 3 | 0.1 |
| cobblestone | 76 | 2 | 0.1 |
| oak_leaves | 60 | 1 | 0.0 |
| water (waterlogging) | 55 | 1 | 0.0 |
| chest | 20 | 1 | 0.0 |
| smooth_stone_slab | 13 | 1 | 0.0 |
| hopper | 10 | 1 | 0.0 |
| smooth_stone | 8 | 1 | 0.0 |
| observer | 8 | 1 | 0.0 |
| lava | 6 | 1 | 0.0 |
| oak_trapdoor | 4 | 1 | 0.0 |
| ladder | 4 | 1 | 0.0 |
| repeater | 4 | 1 | 0.0 |
| note_block | 3 | 1 | 0.0 |
| redstone_wire | 3 | 1 | 0.0 |
| piston | 3 | 1 | 0.0 |
| water | 2 | 1 | 0.0 |
| barrel | 1 | 1 | 0.0 |
| obsidian | 1 | 1 | 0.0 |
| tnt | 1 | 1 | 0.0 |
| lever | 1 | 1 | 0.0 |
| stone_button | 1 | 1 | 0.0 |
| sand | 1 | 1 | 0.0 |

## Special blocks

- pistons: 3
- observers: 8
- hoppers: 10
- rails: 0
- redstone: 9
- fluids: 8
- waterlogged: 55
- lanterns: 0
- trapdoorsDoors: 6
- tnt: 1
- signsBanners: 0
- orientationSensitive: 58
- powerPhase: 2

## Risks

- 1 TNT: the bots pause before the power blocks; check the build, then !resume
- 8 observers are placed after all structure/fluids (so they do not fire early) and before the power blocks
- 8 fluid sources touch open air outside the schematic: they may spill. Check the edges after pouring
- 2 blocks without a neighbour need scaffold blocks
- 2 blocks have no neighbour block in the schematic (they will need scaffold/reference blocks)

## Layers

| y | Blocks | Main blocks |
|---|---|---|
| 0 | 2 | dirt 1, grass_block 1 |
| 1 | 237 | dirt 207, chest 20, hopper 10 |
| 2 | 218 | dirt 200, oak_leaves 10, grass_block 7 |
| 3 | 198 | grass_block 155, dirt 31, smooth_stone_slab 8 |
| 4 | 48 | cobblestone 24, oak_leaves 22, dirt 1 |
| 5 | 46 | cobblestone 24, oak_leaves 20, dirt 1 |
| 6 | 26 | oak_leaves 20, cobblestone 4, dirt 1 |
| 7 | 52 | cobblestone 24, oak_leaves 20, lava 6 |
| 8 | 20 | oak_leaves 16, oak_trapdoor 2, dirt 1 |
| 9 | 11 | smooth_stone 3, observer 3, oak_trapdoor 2 |
| 10 | 12 | smooth_stone_slab 3, smooth_stone 2, redstone_wire 2 |
| 11 | 14 | observer 4, smooth_stone_slab 4, dirt 1 |
| 12 | 11 | repeater 4, smooth_stone 3, dirt 1 |
| 13 | 2 | dirt 1, sand 1 |
