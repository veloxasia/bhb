# Minecraft Human Builder v1.11.0 (real-server edition)

## What changed in 1.11

- **Everything is set in a GUI.** Run `gui.bat` (or `npm run gui`). It opens a panel on your own computer (127.0.0.1 only) with server address and port, the accounts, shop settings, human-behaviour timings, and Start / Pause / Resume / Stop buttons plus a live log. No player name or server is written in the code any more. `config.json` and `accounts.json` are created by the panel.
- **Accounts, three login types per account** (one bot per enabled account):
  - *Microsoft*: normal login. A one-time code is printed in the log; the login is cached per account and renews itself. Best choice for premium accounts.
  - *Session token*: paste a Minecraft access token, press **Verify** and the name that belongs to it is filled in. Tokens expire after about a day. Stored only in `accounts.json` (file mode 600), never sent back to the page.
  - *Offline*: for cracked servers, name only.
- **Materials come from `/shop`.** `/give`, `/item replace`, `/clear` and `/effect` are gone, and so is the pretend inventory the old version kept. The bot types the shop command (with a cooldown), waits for the menu, looks at it for a moment, finds the item by its icon (or by the text you give under *Per-item overrides*), clicks it **once per purchase**, waits until the items really arrive, and closes the menu. If the item is on another page it clicks "next". An item that is not sold is remembered for 10 minutes instead of reopening the shop again and again. Tools are bought only when the bot has none of that kind.
- **Block breaking fix.** Three causes were found in the old code, all fixed in `src/interaction/human-interaction.js`:
  1. It always told the server it was breaking the *top* face. It now sends the face under the crosshair, like a real client.
  2. The finish packet was sent exactly at mineflayer's estimate. Servers count ticks and refuse a finish that is a few ms early. A small random margin is added.
  3. The old inventory trick made the bot believe it held a pickaxe the server had never given it, so its dig time was far shorter than the server's. Real items only now.
  After every break the bot checks that the block is really gone. If the server puts it back three times in a row, the bot stops breaking for 90 s and logs the server's last chat message, instead of hammering (that pattern is what anti-cheat flags). If it says *protected* / *claim* / *no permission*, the area is protected: no code can fix that, ask the server staff or build elsewhere.
- **Human behaviour is enforced after the config is read**, so an old file cannot turn shortcuts back on: no ender pearls, no heal command, no flying, walking speed capped at sprint-jump speed, building speed 1, at most 2.5 placements per second per bot, randomized pauses between actions and a short pause every few dozen actions. Nothing is announced in public chat and in-game `!commands` are off unless you switch them on.

## Honest limits

- Nothing can promise "no ban". Servers ban for *rules* (many forbid automation) as well as for detection. Read the rules of the server and ask staff if bots are allowed. Use the slowest timings you can live with, and try with a spare account first.
- The new code was tested with fake bots only (shop menu, dig guard, config, GUI server). It has not been run against a live server or with the real mineflayer here. `npm install` then `npm test` on your machine runs the whole suite.
- Session-token login hands mineflayer a ready session. If your mineflayer version refuses it, use the Microsoft login.


A Mineflayer bot that builds a schematic (`.litematic`, `.schem`) the way a survival player would. It never sends a placement it could not do with a mouse and keyboard.

## Quick start

1. Install Node.js 20 or newer.
2. Edit `config.json`: server host, port, version, and `control.allowedUsers` (your Minecraft name, which is the only name allowed to command the bot).
3. Put your schematic in `schematics/`.
4. Run `start.bat` (Windows) or `npm install && npm start`.
5. In game chat, as an allowed user: `!build "McDs 64 Module Cobblestone Wall Farm.litematic" X Y Z` (the corner of the build), or stand where you want it and use `!start`.

The bot needs OP (or creative-style `/give`) if `materials.autoGive` is true. Otherwise put the materials in its inventory yourself and it will tell you what is missing (`!materials`).

## What it actually does

- **Aims for real.** For each block it works out a standing spot, an eye position and a face to click. It turns the camera there (min-jerk motion, human timing), then checks the real crosshair ray before it sends the placement. The cursor it sends is where the crosshair really is.
- **Respects reach and line of sight.** Reach is capped at 4.5 minus a margin. Every candidate click is ray-cast, including small perturbations, so a corner clip never decides it.
- **Orientation comes from the player's pose, as in vanilla.** Stairs, pistons, observers, droppers, hoppers, repeaters, comparators, chests, trapdoors, doors, signs, torches, levers and others are placed from the right side, looking in the right direction, sneaking when needed. If the server turns out to use a different rule, the first wrong block is broken, and the alternative rule is tried and remembered in `data/learned.json`.
- **Decides the order itself.** Layer by layer. Fragile blocks, power sources, waterlogged blocks and fluids come later. A block is only attempted when a legal reference face exists for it.
- **Floating blocks.** The bot pillar-jumps a temporary tower next to the spot, bridges a temporary reference block from the tower top (sneak-edge stance), places the real block and climbs down by digging the tower top-down. Temporary blocks are tracked and removed.
- **Finishing touches done by hand.** Sign text, note-block tuning, repeater delay and comparator mode are set by right-clicking after placement.
- **Fluids.** Buckets are used on the aimed face. Empty buckets are cleared afterwards.
- **Safety.** Pauses on lava or fire, void, low health, unloaded chunks or a real fall, and resumes by itself. After death it respawns and continues. If the process is restarted it resumes the saved job (`server.resumeOnStart`, off by default).
- **Verification.** At the end it rescans the whole build, fixes damage, removes scaffolding and writes `data/<job>.report.json`.

## Chat commands

`!start`, `!build <file> x y z [rotation]`, `!pause`, `!resume`, `!stop`, `!status`, `!materials`, `!verify`, `!cleanup`, `!diag`, and the diagnostics:

- `!ground`: what the bot thinks is under its feet (use this if it ever pauses as "airborne").
- `!plan`: planner statistics. `!tasks`: the next tasks and why others wait.
- `!learned`: orientation rules learned on this server.

## Offline tools

- `npm run plan -- <schematic>` is a dry run: task count, materials, look-up placements, unsupported blocks, signs.
- `npm run check` runs validation and the tests (the offline world simulation uses an independent implementation of vanilla placement rules).
- `node tests/sim/fullbuild.js <schematic> <seconds>` runs the real engine on a whole schematic inside the simulation.

## Settings worth knowing

| Setting | Meaning |
| --- | --- |
| `building.speed` | 1 = human pace. Higher divides all pauses (only raise it if the server has no anti-cheat). |
| `building.betweenActionsMs` | Extra delay between actions. |
| `building.maxTowerHeight` | Tallest temporary tower. |
| `building.giveUpAfterMs` | How long one block may keep failing before it is deferred and retried later. |
| `building.scaffoldBlockNames` | Blocks used for temporary towers. |
| `safety.airborneToleranceMs` | How long a not-grounded state is tolerated before an automatic pause. |
| `materials.giveTarget` | `self` gives items to the bot's own name; or a selector such as `@a`. |

## Server notes

- Aternos 1.21.1 works with Mineflayer 4.39. The sample schematic was made on a newer data version; blocks unknown to 1.21.1 are listed by `npm run plan` and skipped with a warning.
- A large build takes hours at human pace (47,566 blocks). Keep the chunks loaded: stay online, or keep the area loaded with the server's own settings.
- Water and lava need buckets (given automatically with `/give`).
- Please read `docs/VALIDATION.md` for what has and has not been tested.

## Known limits (read before a big build)

- **Not yet run on a live server.** All testing was in an offline simulation (see `docs/VALIDATION.md`). Expect to tune the first real run; send the log plus `!ground`, `!plan`, `!tasks` output if anything stops.
- **Simulation result on the included schematic:** layers 0-11 (about 9,000 blocks) built completely in the simulation. Layers 12-29 were only partly exercised: they build, but some floating strips (for example black concrete over a two-wide gap) were still failing to find a standing spot when testing stopped. Blocks the bot cannot reach are retried later and listed in `data/<job>.report.json` instead of being silently skipped.
- The schematic has about 4,000 floating oak leaves; each one needs a temporary tower, so the build takes many hours.
- Waterlogged blocks, fluids and power sources are placed on purpose: water and lava right after their own layer, redstone power sources last.

## v1.0.2 - Aternos speed profile, self-learning, anti-stall
- `building.speed: 3` with `maxPlacementsPerSecond: 4` (jittered) - faster, still within what a real player can click. Set `speed: 1` and `maxPlacementsPerSecond: 2` for strict public servers.
- Stall watchdog: if the bot does not move while walking for `navigation.unstickAfterMs`, it wiggles (jump / strafe / back) like a stuck player, then retries.
- Experience file `data/experience.json`: per rule/face/sneak success rates bias future aim choices, and clicks from far away are penalised if they keep failing. `!learned` shows it.
- Plants without suitable soil are reported as UNSUPPORTED instead of retrying forever.

## v1.0.3 - navigation
- Closed wooden doors and fence gates are walked through: the bot looks at them and right-clicks them open.
- Normal walking never places blocks any more (that made it poke trapdoors and freeze while holding cobblestone).
- When no walking route exists it builds its own: bridging and pillaring with scaffold blocks (`navigation.rescue`, default on), then falls back to the usual retry logic.
- Wedged in a frame/edge ("falling" / not grounded): it wiggles free before giving up on a stand position.

## v1.0.4 - error logs, doors, speed
- `data/errors.log` gets every warning/error; `data/incidents.jsonl` gets a full snapshot of each serious failure (position, held item, blocks around the bot, task, path status, stack). Send me those two files and I can fix the exact cause.
- Doors/gates opened and closed behind you; blocking open trapdoors closed; schematic blocks still being built are never touched.
- Faster walking profile in `navigation.personality` (quicker reaction/turning, no random hops).

## v1.0.5 - no more silent hangs
- Every task has a hard limit (`building.taskTimeoutMs`, 75 s). On timeout the keys are released, the task is abandoned and `incidents.jsonl` records which step it was stuck in (walking, tower, aiming, getting the item into the hand ...).
- Item equips time out after 4 s instead of waiting forever for a server answer.
- short_grass / ferns that were placed correctly are now recognised (they were wrongly reported as REFUSED).
- Low-health pause resumes at the minimum health (no longer needs +4) and heals with `safety.healCommand` if natural regeneration is off.

## v1.0.6 - Architect (plans the whole build first)
- `node scripts/architect.js schematics/yourfile.schem 0 64 0 0` plans offline: layers, pieces, walking distance, time estimate, materials, scaffold-need and plant/soil warnings. Writes `data/<name>.plan.json`.
- In game `!architect` re-plans the loaded build and prints the summary to chat; the plan is also made automatically on `!build` (turn off with `planning.architect: false`).
- The plan decides ORDER only (layer by layer, room by room, 4-wide sweep stripes). The bot still uses its own pathfinder, aim solver and scaffolding, and takes the next planned block if one cannot be placed yet.

## v1.0.7 - stall killer
- `data/session.log` now holds the full timeline (info, debug, warnings) - send it together with errors.log and incidents.jsonl.
- Idle watchdog: if the bot does not move or change step for 15 s it wiggles free and logs an `idle-stall` incident; after 30 s the task is abandoned.
- An abandoned task now really stops (towers, slides and walks check for it) instead of fighting the next task for the controls; physics-tick waits can no longer hang.

## v1.0.8 - time savers (from the shouse live log)
- A task that fails keeps stepping aside (10 s, 20 s, 40 s ...) while the rest is built, and is given up after 10 attempts (listed in the report) instead of 20+ retries of one lantern.
- Task limit 35 s, idle watchdog wiggles after 7 s and abandons after 14 s; the same aim miss twice in a row switches to another stand immediately.
- After walking to a stand the bot shuffles to its exact centre (no more "pose lost" stand hopping).
- Incidents now carry aim numbers (eye, yaw/pitch wanted vs real, distance) and tower failures say why (height, ground, block above).

## v1.0.9 - camera fixes (found in the v1.0.7 incident log)
- The walking controller leaves pitch noise (and a little yaw bias) on the camera after a walk: at 4 blocks that is a block off the target. After every look the bot now makes a short corrective flick onto the exact angle.
- `lookAt` can no longer hang (1.5 s limit, then the bot's own smooth sweep); looking straight down for pillar jumps no longer goes through the walking controller.

## v1.0.10
- Hanging lanterns are built AFTER the block above them and are clicked on its underside (they used to be set on top of a block -> "WRONG lantern" loops).
- Doors/gates: no more open/close ping-pong (closed only after the bot really walked through); when stuck the bot first opens a door/gate in front instead of jumping at it, and never "jumps" at fences/walls.
- Placement clicks no longer wait mineflayer's 5 s block-update timeout when the server refuses.
- Fast profile for your own server: speed 6, up to 10 placements/s, shorter pauses (`building.speed`, `maxPlacementsPerSecond`, `navigation.personality`). Lower them again for public servers.

### v1.0.11
- Trapdoors/doors: after each toggle click the bot waits for the server state change, so a laggy second click no longer undoes the first.
- Stand settle no longer turns toward the spot ("sneak ahead, turn back, place"); it only creeps with key taps when the pose was lost.

### v1.1.0 (fleet)
- Several bots build one schematic together (`fleet.workers` in config.json). See docs/FARM_PLAN.md.
- `node scripts/analyze.js <schematic> [workers]` writes a full analysis.
- `building.pauseBeforePower` pauses before the power blocks; `!resume` continues.
- Commands: `!fleet`; the rest apply to every worker.

### v1.1.1
- Walled-in escape: after 2 failures in a row (or an idle stall) a bot that is boxed in by walls/ceiling digs the cheapest wall (temporary blocks first, finished build blocks last) and walks out. Logged as `walled-in` in incidents.jsonl.

### v1.1.2 (fleet stability)
- Cause of the connect/disconnect loop: all bots share one process; a blocking path search (up to 12 s) froze every bot, keep-alives were missed and connections dropped. Blocking searches are now capped (`fleet.maxBlockingSearchMs`, 1200 ms).
- Logins (also reconnects) go through one gate, `fleet.joinDelayMs` apart, so the server no longer answers "Connection throttled".
- A disconnected bot ends its build loop (the saved job resumes on the next login) instead of running on as a ghost and corrupting the others.
- Frozen time is no longer counted as "no progress"; every freeze is logged as `event-loop-blocked` in incidents.jsonl.

### v1.1.2 (fleet stability)
- Cause of the connect/disconnect loop: all bots share one process; a blocking path search (up to 12 s) froze every bot, keep-alives were missed and connections dropped. Blocking searches are now capped (`fleet.maxBlockingSearchMs`, 1200 ms).
- Logins (also reconnects) go through one gate, `fleet.joinDelayMs` apart ("Connection throttled" before).
- A disconnected bot ends its build loop (saved job resumes on the next login) instead of running on as a ghost.
- Frozen time is not counted as "no progress"; freezes are logged as `event-loop-blocked`.
- When no walking route exists the rescue route now also digs (pickaxe from the tool kit) through terrain and temporary blocks, never through finished schematic blocks or containers (`navigation.rescueDig`).

### v1.2.0
- Fixed: tools (pickaxe/axe/shovel) never reached the bot: `bot.heldItem` is a getter in mineflayer 4.x and the material mirror tried to assign it.
- Fleet network load: view distance 4 (`fleet.viewDistance`), per-bot placements/s and command delay lowered (`fleet.perBotPlacementsPerSecond`, `fleet.commandDelayMs`), connection length logged on every drop, `HEALTH:` line (cpu, memory, bots online) every 30 s.
- `!analyze` writes the full plan (time, split over workers, materials, risks) to data/<job>.analysis.md; `node scripts/analyze.js <file> [workers]` does it offline.
- A bot whose connection ended no longer keeps its idle watchdog / task running.

### v1.3.0 (every bot in its own process)
- `fleet.mode: "processes"` (default): each bot is its own Node process (own CPU core). A hub in the main window relays claims/finished blocks/commands, remembers the job (`data/fleet-job.json`) and restarts any process that dies or goes silent. `"inprocess"` keeps the old shared-process mode.
- Resume that cannot be forgotten: after any disconnect or restart the hub hands the job to the bot again (it also resumes by itself after closing and reopening the program). Starting a job retries until the bot stands on safe ground.
- Tools: pickaxe/axe/shovel go to hotbar slots 0/1/2 (they used to be overwritten by block stacks), and only real tools count as dig tools (a block in hand digs like a bare hand).
- Stuck walking is abandoned after 1.5 s without movement (was 3 s x 2) and re-planned.
- Per-worker experience/learning files (`experience.<name>.json`).

## 1.12.0 (multiplayer hardening)
- Block breaking now follows the vanilla client: start packet, arm swing every 6 ticks, finish counted in game ticks (+1..3 tick margin), rising sequence numbers on every dig/place/use packet, crosshair check before breaking, refusal detection with a pause instead of hammering.
- Camera moves in whole mouse steps (per-account sensitivity), physics catch-up after a stall limited to one tick, reach capped at 4.2.
- Offline (cracked) accounts can store a password; the bot answers /register and /login prompts.
- Speed warnings now log floor, effects and keys so a non-human speed can be traced.
- Walk-before-A*: the reachability brain runs before long path searches and caches "unknown" answers.

## 1.12.1
- `tick_end` is sent after every client tick on 1.21.2+ servers (what made breaks work in the test script); mod-channel and sign-editor noise ignored; arm swing every 3 ticks while breaking; session-token login now sets the UUID.

## 1.13.0
- Teleport helper (`teleport` in the settings): /sethome 1-3, /home N, /delhome N and /tpa to a teammate bot, whose bot answers /tpaccept (teammates only). Used only after repeated real failures to reach the same place (3 failures over 45 s, after pillars and pearls), and to return to the site after a death or a far join.
- Homes are set on solid ground at work sites that are far from the existing homes; a full set is replaced with /delhome then /sethome.
- Inventory clicks (equip from the inventory, shop clicks, moves) first release the movement keys and wait for standstill.
- Ender pearls are allowed again (switch: human.allowPearls).
- A block that cannot be reached defers its neighbours too, so the bot works elsewhere instead of repeating the same failed search.

## 1.13.1
- Bedrock (and barrier, light, command blocks, portals ...) in a schematic is ignored: `building.ignoreBlocks`.
- A block the shop does not sell is swapped along a chain, e.g. grass block -> dirt -> cobblestone (`building.substitutes`); an already placed original still counts as correct.

## 1.13.2 (audit)
- Fixed: motion guard referenced an unimported `Vec3` (ice allowance and speed diagnostics silently never worked).
- A failed human walk ("no path") no longer triggers a second full pathfinder search before rescue (saved up to 12 s per failure).
- Status messages from the bots are not typed into public chat unless `control.announceInChat` is on.
- Logins of the fleet use a jittered gap instead of a fixed rhythm.
- The offline full-build simulator runs again (`node tests/sim/fullbuild.js`).

## 1.14.0 – auto-add to Quick Buy
If an item is not in `/shop` (Quick Buy), the bot clicks the empty grey pane, clicks the Search sign, types the item name, picks the item, types the stack size (e.g. 16 for pearls) and presses Done, then buys it. Config: `shop.autoAdd` (default true), `shop.addAmount`, per-item `shop.items.<item>.search / amount / match`. Sign editors are answered through `update_sign`; mineflayer's own sign handler stays disabled (`wire.ignoreSignEditor`) and emits `mhbSign`. Untested on a live server: send a log with the `shop:` lines if it misbehaves.

## 1.15.0 – simpler GUI, two modes
The GUI now has a mode switch. **Test server** (Aternos / own server): the bots use plain `/give` (they must be operators), cracked login works, no shop, no teleport commands. **DonutSMP**: shop only, auto-add to Quick Buy, strict human rules, `/home` and `/tpa` as a last resort. Each mode remembers its own server address. Rarely used tuning fields moved out of the GUI (the defaults stay in config.json).

## 1.15.1
Bots no longer resume a saved build by themselves when started: they wait for "Start build". A stand far from the bot is now logged (`placer: walking N blocks ...`).

## 1.16.0 – Continue or start fresh
The GUI shows two buttons: **Continue last session** (resumes the saved build, shown under the Build section) and **Start fresh session** (asks first, then forgets the saved job and progress). Running `start.bat` directly never resumes by itself unless `server.resumeOnStart` is true.

## 1.16.1
Advanced has "Your in-game name": type !start / !pause / !resume / !stop in game. A start that cannot happen yet now logs the reason on every attempt.

## 1.16.2
Pressing Start build (or !start) while a build is already running now stops it and starts the new one (before, it was ignored silently). Workers log "command received". Copy log button in the GUI.

## 1.17.0 – work speed
`human.pace` (GUI: Advanced > Work speed): careful / fast (default) / max. Only idle time shrinks: placements 3.3-4.5 per second per bot (vanilla allows 5), shorter aim and reaction pauses, rarer micro-pauses. Walking speed is untouched.

## 1.18.0 – flow placing
While the bot stays on the same spot it now places block after block like a player holding the click: no reaction time, almost no pause between blocks, faster aiming (still at most 4.5 placements per second). It stocks up for a long stretch of the build per shop visit / give instead of many small trips, remaining waits scale with the work speed, and it warns when the build site is far from the bot.

## 1.19.0
- Blocked blocks are never final: when the queue runs dry, blocked/deferred blocks go back into the queue (up to 6 retry rounds), and the build only reports after all rounds fail. Any progress resets the rounds.
- Scaffold loop guard: a tower column built 3 times or failing twice is dropped and another column is planned.
- Local testbed (`tests/testbed`) now applies inventory window clicks like a real server.
- Verified on the offline testbed only (816/822 after 9 min with 2 bots, remaining 6 in retry round); not verified on a live server.

## 1.19.1
- Fixes the "bots idle although blocks remain" stop: when the normal rules find nothing (owner idle, other bot nearby, reference waiting), the nearest unfinished block is taken anyway, whoever owns it. Fires continuously while needed, and logs the status counts.
- Preflight: every block gets a planned standing cell (and a NEEDS_SCAFFOLD flag) before the first block; far bots walk straight to it.
- Turn limit: blocks behind the bot's back are not placed from the spot (no more look-behind / 360 spins); stand choice penalises big turns.
- Scaffold ledger: short pillars with unfinished blocks next to them are not torn down; a batch cleanup removes finished ones.

## 1.19.2
- A worker whose login dies (ECONNRESET) or never reaches the world within 90 s reconnects instead of staying dead (your log showed Builddd never joined).
- Single chests are placed while sneaking (no merging with the neighbouring chest, correct facing).
- Default work speed is now Maximum.

## 1.19.3
- Wrong-state blocks now log wanted vs actual properties and the rule used (to root-cause the chest place/break loop).

## 1.19.4
- Double chests (type left/right, from your WRONG STATE log): placed WITHOUT sneaking and against a non-chest block, so they merge with the neighbour instead of coming out single and facing south. Single chests still sneak.
- Speed (offline testbed, 2 bots, 4 min: 435 -> 602 blocks): hops stop within 0.22 blocks instead of parking on the exact centre; small camera corrections are one tick; the planner looks 40 blocks ahead for something it can place from the current spot.
- Stand choice prefers stands the bot can walk to (cut-off stands cost a bridge/pillar/pearl each time).
- TIME log has finer phases (walk: hop / pathing / settle).

## 1.20.0
- Scaffold: pillars stay while unfinished blocks near them depend on them (the bot only comes down to a 3-block stump); no periodic clean-ups. Clean-up happens once, at the very end, and never builds new scaffolds to reach old ones (that was the build-break-build loop at the end). Unreachable leftovers are reported, not chased.
- Full inventory: junk (and scaffold beyond two stacks) is cleared (`/clear` in test mode, tossed on a real server) before buying/giving; a `/give` that fell on the floor is recovered.
- Low health that never recovers no longer stalls the build: the bot eats from the paused state, heals with a golden apple after 40 s, and carries on carefully after 3 min (health >= 4).
- Lava / water: poured from at least 3.2 / 2.2 blocks away, then the bot steps 5 / 3 blocks away.
- TNT is placed last of everything and never next to live power, fire or lava (reported as blocked with the reason). `pauseBeforePower` is off by default (no more stopping for a manual !resume).
- Pearls: the turn is smooth and the bot waits 4 ticks for the server to take the rotation before throwing; throws are chosen so the landing survives small aiming errors.
- Double chests (left/right) are placed without sneaking against a non-chest block. The testbed server now simulates vanilla chest facing/merging, with a `chests` test schematic.
- GUI: "Rotation" is now "Turn build (degrees)" with a hint (it rotates the whole schematic; leave at 0).

## 1.20.1
- Fall guard (`src/recovery/fall-guard.js`): stops the walk before an unplanned drop (4+ blocks), remembers holes, and after a fall of 2+ blocks walks back to the last safe spot. Held off during scaffold towers, escapes, pearls and rescue walks.
- `nextAny` per-task backoff, adaptive probe scan, hint-walk guards, cached stand reachability (less CPU in the upper phases).
- Inventory: surplus/junk logic with counted `/clear` (test server) or drop (real server).
- `escapeLava`: swim/jump out of lava toward the nearest dry cell.

## 1.20.2
- Fluids: every pour is simulated first (`BuildPlanner.fluidCheck`: water spreads 7, lava 3, both fall). A pour that would flood a still-unbuilt block cell, or touch a lava source (obsidian) / water (lava), waits. After 4 failed tries it is poured anyway. Fluids are poured right after their own layer again, so a layer's water is never left for later.
- Bucket click target: slabs, stairs, trapdoors, fences, leaves etc. are never used as the clicked block (a bucket waterlogs THAT block instead of filling the wanted cell).
- Water/lava cells of the design (sources and flowing) are never plugged with scaffold, bridge or pillar blocks.
- Temporary blocks are broken like a player: standing on a REAL block, looking back at the bridge, in reach, after each task (`sweepTemporary`) and at the end (`cleanupAll`: walks to solid ground next to what is left, or climbs a column and takes it down top-down).
- Bots keep out of each other's cells (stand search skips cells within 1.4 blocks of another worker and penalises 2.6).
- Logs: `OK` per placed block, `STATUS` every 30 s (per-layer progress, first open layer's pending blocks, scaffold count, free slots, distance to the other bots), `FLUID` per pour, `FLUID EVENT` for lava->obsidian and stray water/lava, `TIDY` for the cleanup.
- Fall guard (1.20.1) kept.

## 1.20.3
- Pit / walled hall: when the brain finds neither a throwable pearl nor a pillar site, the bot now digs out (forced `escapeEnclosure`, up to 5 columns, first through unfinished blocks, then through finished ones which the planner re-places).
- Pearls: up to 4 throws per connection; after a miss the next throw is solved again from the bot's real position. Flat, short, robust arcs are preferred over 80-degree lobs.
- Bucket: the re-aim path also refuses waterloggable click targets, and a pour onto one is rejected before the click.
- Fall guard: water no longer counts as support (a drop into a walled pool is a trap, not a landing).
- `No normal route ... building a way`: the same target is not retried for 25 s after a failure and the log line is limited to one per 4 s (it was dozens per second).
- Testbed: `BED_WAIT_COMPLETE=1` waits for the end-of-build cleanup.
- Measured on the 64-module schematic (45,496 blocks, 89 layers): the bot process is ~89% idle, so the time goes into human pacing and walking, not CPU. Real rate seen in logs is about 20 blocks/min per bot: use many workers.

## 1.21.0 - one exit planner instead of patches
- `src/recovery/exit-planner.js`: a single cost-based search (Dijkstra) over everything a player can do: walk, swim (downstream is cheaper, upstream dearer, so the bot rides the flow to its shallow end), climb ladders, step up, short drops, dig, pillar, bridge, stair-up, ender pearl. Digging rules: never next to lava, never under sand/gravel, water next to the block costs extra, chests/redstone/doors/fluids are never opened, plain finished blocks cost a lot, terrain and temporary blocks are cheap.
- `src/recovery/exit.js`: carries the plan out step by step, checks where the bot really is after each step, and when a move fails in reality it is banned/made dearer and the planner picks the next method (swim, dig, pillar, bridge, pearl ... in cost order). Every step is logged as `EXIT: ...`. Afterwards the bot breaks the bridge/pillar blocks it placed from real ground and hands every finished block it had to open back to the planner (it places them again). Used by: the brain (pit / walled hall), the "stuck" watchdog, the swimming-and-not-getting-out case.
- End of build: a temporary block sealed inside the build is reached through the least sensitive wall, broken, the bot walks out, and the opened wall blocks are placed again (finish waits for that).
- Pearls: water drag (0.8) and the thrower's own motion are now simulated; no throw from inside water; the bot stands still first; the REAL camera angle is simulated again right before the throw and re-aimed if it would miss; the log says where the pearl was last seen. Other bots in the line are blockers.
- Hazard guard (physics tick): stops before lava/fire ahead and before a drop of 2+ blocks into a place it could not climb out of; those columns cost a lot in path search for 45 s. Rescue walks no longer allow 7-block drops (max 5, 4 when hurt).
- Ladders / vines in the walker: the bot centres in the ladder cell, faces the wall, holds forward (+jump going up, sneak going down). Wooden doors and gates are no longer treated as walls by the walker's own checks.
- Leaves / slabs / stairs with water in the schematic: the water task is in the same group as the block and follows it directly.
- Testbed: `node tests/testbed/exit-run.js open|room|obsidian|ladder|seal` (pit escape, ladder climb, sealed temporary block). New tests: `exit-planner`, `hazard`, extended `survival`.

## 1.21.1

- Lava/water pours: a scaffold block no longer counts as a wall, and a channel that is open to a cell the design keeps empty is refused (no more stray lava).
- Temporary blocks are never broken next to lava (or next to water while building).
- Exit bridges/pillars are broken from solid ground right after leaving (reserved cells included); blocks no ground reaches are removed by going in through the least sensitive way.
- A failed exit step is banned after two failures; pit guard uses the exit flood (ladders/steps count) and a softer detour cost.
- Spreading lava near a bot makes it walk away first (`lava is spreading near me`).

## 1.21.2

- Fluid pours: inside the design's box, a solid block the design does not contain (the other bot's scaffold included) never counts as a wall, so a pour next to one is refused until the channel is really closed.
- Waterlogging refuses when the block that should hold the water is missing, and a loose water source it leaves behind is picked up again with the empty bucket.

## 1.21.3

- A look-direction block (observer, piston, dropper...) that comes out wrong once is placed again with the same rule before the rule is doubted, so one bad click can no longer flip the learned rule.
- `/give` that the server confirmed for this bot but whose inventory update is late now waits up to 7 s more before failing (the repeated NO_DELIVERY retries).

## 1.21.4

- Stray lava / water outside the design: after stepping away, the bot covers the source (and nearest flow) cells within arm's reach with a block (`FLUID: covered stray fluid at ...`).

## 1.22.0 — flight recorder + intelligence engine

**Logs (all in `data/`)**
- `events.<bot>.jsonl` — every task start/ok/fail, dig, pour (with what the safety check saw), damage (with cause), near-lava, 5-second heartbeat (position, phase, hp), engine decisions.
- `postmortems/*.json` — one file per serious incident (death, damage >= 4, leak, stuck, loop, rubber-banding, repeated task failures): cause, reasons, evidence, fix, last 20 s of frames, last 60 log lines, the blocks around the bot, and for leaks the pour + the block history (who placed / removed which wall block and when).
- `diagnosis.<bot>.md` — rolling summary, rewritten every minute.
- `node scripts/diagnose.js [dir|files]` — one combined report from any logs (also older versions): verdict, every failure category with reason + fix, per-worker counts, deaths, leaks with the nearest earlier pour, postmortems, engine decisions.
- Send `data/` (session.log, errors.log, incidents.jsonl, events.*, postmortems/, diagnosis.*) when something fails.

**Engine (`src/intel`)**
- `preflight(task)`: before every task checks leak mode, health, other players near a pour, lava beside the target; says go / hold with reasons (`BRAIN: holding ...`). Soft holds never block forever.
- Leak mode: after a stray fluid is explained, fluid tasks and nearby work are held until it is covered.
- Strategy book: stuck / loop / leak / lava-near ladders re-ranked by what actually worked (`data/intel.<bot>.json`).
- Lava is never poured against a blocked fluid check; water only after 8 tries and never if it would touch lava.

## 1.22.1
- dirt, grass_block, podzol, mycelium, coarse_dirt and rooted_dirt now count as the same block (grass spreading no longer causes clear/re-place loops).
- Exit planner: digging finished schematic blocks costs much more, so ender pearls are chosen first.
- Water/lava spread check reach fixed (off by one).
