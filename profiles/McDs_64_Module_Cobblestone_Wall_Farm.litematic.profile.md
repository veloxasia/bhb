# Build analysis: McDs 64 Module Cobblestone Wall Farm.litematic

- Size 77 x 30 x 84, 42,426 blocks, 72 layer steps, 1522 pieces

## Time

| Setup | Planner estimate | Calibrated guess (x2.7) |
|---|---|---|
| 1 bot | 48 h 21 min | 130 h 33 min |
| 4 bots | 13 h 45 min | 37 h 8 min |

## Work split

| Worker | Blocks | Walking | Planner min | Area |
|---|---|---|---|---|
| BuilderBot1 | 10586 | 23792 | 717 | x 0..37, z 0..48 |
| BuilderBot2 | 10612 | 23524 | 717 | x 7..74, z 0..52 |
| BuilderBot3 | 10597 | 22977 | 714 | x 0..60, z 32..83 |
| BuilderBot4 | 10631 | 22731 | 715 | x 18..76, z 33..83 |

## Materials

| Item | Count | Stacks | Shulker boxes |
|---|---|---|---|
| cobblestone | 11517 | 180 | 6.7 |
| stone_bricks | 5669 | 89 | 3.3 |
| black_stained_glass | 4637 | 73 | 2.7 |
| water (waterlogging) | 3911 | 62 | 2.3 |
| oak_leaves | 3904 | 61 | 2.3 |
| black_concrete | 3126 | 49 | 1.8 |
| gray_concrete | 1654 | 26 | 1.0 |
| piston | 1344 | 21 | 0.8 |
| redstone_wire | 1186 | 19 | 0.7 |
| obsidian | 762 | 12 | 0.4 |
| smooth_stone | 704 | 11 | 0.4 |
| observer | 548 | 9 | 0.3 |
| powered_rail | 507 | 8 | 0.3 |
| hopper | 476 | 8 | 0.3 |
| lava | 385 | 7 | 0.3 |
| packed_ice | 290 | 5 | 0.2 |
| iron_bars | 172 | 3 | 0.1 |
| crafter | 168 | 3 | 0.1 |
| chest | 146 | 3 | 0.1 |
| note_block | 136 | 3 | 0.1 |
| water | 134 | 3 | 0.1 |
| tripwire_hook | 128 | 2 | 0.1 |
| sea_lantern | 94 | 2 | 0.1 |
| polished_blackstone_stairs | 84 | 2 | 0.1 |
| light_gray_concrete | 76 | 2 | 0.1 |
| redstone_torch | 73 | 2 | 0.1 |
| oak_wall_sign | 65 | 2 | 0.1 |
| tripwire | 64 | 1 | 0.0 |
| dropper | 64 | 1 | 0.0 |
| oak_fence | 64 | 1 | 0.0 |
| redstone_block | 64 | 1 | 0.0 |
| tnt | 64 | 1 | 0.0 |
| sticky_piston | 64 | 1 | 0.0 |
| polished_blackstone | 52 | 1 | 0.0 |
| iron_trapdoor | 29 | 1 | 0.0 |
| spruce_wall_sign | 29 | 1 | 0.0 |
| repeater | 7 | 1 | 0.0 |
| honey_block | 6 | 1 | 0.0 |
| soul_sand | 5 | 1 | 0.0 |
| oak_fence_gate | 5 | 1 | 0.0 |

## Special blocks

- pistons: 1408
- observers: 548
- hoppers: 476
- rails: 507
- redstone: 1335
- fluids: 519
- waterlogged: 3911
- lanterns: 94
- trapdoorsDoors: 39
- tnt: 64
- signsBanners: 94
- orientationSensitive: 3510
- powerPhase: 139

## Risks

- 64 TNT: the bots pause before the power blocks; check the build, then !resume
- 4430 water/lava placements, one bucket each (buckets do not stack)
- 3510 orientation-sensitive blocks (pistons, observers, hoppers, rails): verify with !verify
- 548 observers are placed after all structure/fluids (so they do not fire early) and before the power blocks
- 518 fluid sources touch open air outside the schematic: they may spill. Check the edges after pouring
- 512 blocks without a neighbour need scaffold blocks
- 94 lanterns: hanging ones get their support first
- 512 blocks have no neighbour block in the schematic (they will need scaffold/reference blocks)

## Layers

| y | Blocks | Main blocks |
|---|---|---|
| 0 | 103 | observer 88, note_block 8, packed_ice 6 |
| 1 | 165 | observer 84, packed_ice 65, black_stained_glass 14 |
| 2 | 318 | hopper 84, crafter 84, packed_ice 74 |
| 3 | 398 | black_stained_glass 210, hopper 84, crafter 84 |
| 4 | 608 | stone_bricks 304, hopper 168, black_stained_glass 80 |
| 5 | 1445 | stone_bricks 1122, black_stained_glass 196, iron_bars 98 |
| 6 | 1778 | stone_bricks 1760, gray_concrete 12, black_stained_glass 4 |
| 7 | 1362 | stone_bricks 1232, gray_concrete 80, black_stained_glass 46 |
| 8 | 756 | stone_bricks 448, gray_concrete 170, black_stained_glass 138 |
| 9 | 1101 | obsidian 502, black_concrete 265, gray_concrete 226 |
| 10 | 523 | black_concrete 235, black_stained_glass 153, gray_concrete 96 |
| 11 | 532 | black_concrete 220, black_stained_glass 153, gray_concrete 99 |
| 12 | 513 | black_concrete 226, chest 140, gray_concrete 104 |
| 13 | 1412 | oak_leaves 896, black_concrete 199, hopper 140 |
| 14 | 2900 | cobblestone 1280, oak_leaves 768, black_concrete 348 |
| 15 | 2963 | cobblestone 1280, oak_leaves 768, black_stained_glass 490 |
| 16 | 2367 | cobblestone 1280, oak_leaves 768, black_stained_glass 256 |
| 17 | 2375 | cobblestone 1280, oak_leaves 768, black_stained_glass 256 |
| 18 | 2375 | cobblestone 1280, oak_leaves 768, black_stained_glass 256 |
| 19 | 2375 | cobblestone 1280, oak_leaves 768, black_stained_glass 256 |
| 20 | 2376 | cobblestone 1280, oak_leaves 768, black_stained_glass 256 |
| 21 | 2371 | cobblestone 1280, oak_leaves 768, black_stained_glass 256 |
| 22 | 2751 | cobblestone 1277, oak_leaves 768, lava 383 |
| 23 | 2491 | piston 1280, smooth_stone 640, black_stained_glass 512 |
| 24 | 1519 | redstone_wire 1088, tripwire_hook 128, black_stained_glass 64 |
| 25 | 639 | black_concrete 572, redstone_torch 64, sea_lantern 2 |
| 26 | 1296 | black_concrete 604, gray_concrete 448, black_stained_glass 135 |
| 27 | 1238 | stone_bricks 726, black_stained_glass 256, smooth_stone 64 |
| 28 | 1248 | powered_rail 507, observer 248, redstone_wire 97 |
| 29 | 128 | observer 64, note_block 64 |
