'use strict'
// tuning values carried over from v1.10 (navigation, building, motion ...). Server/identity settings live in config.js.
module.exports = {
  "navigation": {
    "thinkTimeoutMs": 1200,
    "tickTimeoutMs": 20,
    "stuckTimeoutMs": 4000,
    "unstickAfterMs": 1500,
    "maxPathDistance": 128,
    "parkour": false,
    "allowBreaking": false,
    "allowPlacing": false,
    "useHumanController": true,
    "humanSeed": 1337,
    "chunkPreloadTimeoutMs": 30000,
    "chunkPreloadWarningOnly": true,
    "minLoadedChunkColumns": 9,
    "placementReach": 4.5,
    "placementThinkTimeoutMs": 6000,
    "personality": {
      "sprints": true,
      "sprintDelay": 0,
      "reaction": 0.005,
      "turnTime": 0.06,
      "jumpRate": 0,
      "glanceRate": 0,
      "deadband": 0.08
    },
    "rescueDig": true,
    "pearls": true,
    "ramps": true,
    "rampMaxRise": 14,
    "rampMaxBlocks": 110,
    "rampTimeoutMs": 240000
  },
  "building": {
    "maxRetriesPerAction": 6,
    "rescanEveryActions": 96,
    "saveEveryActions": 32,
    "allowTemporaryScaffolding": true,
    "scaffoldBlockNames": [
      "cobblestone",
      "stone",
      "dirt",
      "netherrack"
    ],
    "cleanupTemporaryBlocks": true,
    "localRescanRadius": 40,
    "maxBuildTasks": 5000000,
    "correctMismatchedBlocks": true,
    "accessRetryDelayMs": 80,
    "accessStallLogIntervalMs": 15000,
    "speed": 1,
    "maxPlacementsPerSecond": 20.0,
    "maxTowerHeight": 24,
    "betweenActionsMs": 0,
    "giveUpAfterMs": 1800000,
    "giveUpAttempts": 8,
    "taskTimeoutMs": 35000,
    "pauseBeforePower": false
  },
  "diagnostics": {
    "logProtocolVersions": true,
    "protocolPacketRingSize": 16,
    "quietStartup": true
  },
  "planning": {
    "architect": true,
    "stripeWidth": 1
  },
  "motion": {
    "enabled": true,
    "maxYawDegPerTick": 75,
    "maxPitchDegPerTick": 55,
    "minKeyHoldMs": 0,
    "maxSpeedPerTick": 0.56
  },
  "paths": {
    "schematicsDir": "./schematics",
    "stateDir": "./data"
  },
  "safety": {
    "pauseOnLowHealth": true,
    "minimumHealth": 8,
    "recoveryLogThrottleMs": 3000,
    "airborneToleranceMs": 2500,
    "safeStartWaitMs": 6000,
    "healCommand": "",
    "autoEat": true,
    "foodItem": "cooked_beef"
  }
}
