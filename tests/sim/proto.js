const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.1')
const World = require('prismarine-world')(registry)  // returns constructor?
console.log(typeof World)
const Chunk = require('prismarine-chunk')(registry)
const Block = require('prismarine-block')(registry)
const world = new World(null).sync
for (let cx=-2;cx<3;cx++) for (let cz=-2;cz<3;cz++) { const c = new Chunk(); world.setColumn(cx,cz,c) }
const stone = registry.blocksByName.stone
world.setBlockStateId(new Vec3(1,64,1), stone.defaultState)
const b = world.getBlock(new Vec3(1,64,1))
console.log(b.name, b.position, b.boundingBox, b.shapes)
const ob = Block.fromProperties(registry.blocksByName.observer.id, {facing:'west', powered:false}, 0)
world.setBlockStateId(new Vec3(2,64,1), ob.stateId)
console.log(world.getBlock(new Vec3(2,64,1)).getProperties())
const r = world.raycast(new Vec3(5.5,65.62,1.5), new Vec3(-1,-0.1,0).normalize(), 6)
console.log(r && r.name, r && r.position, r && r.face, r && r.intersect)
console.log('min y', world.getColumn(0,0).minY, world.getColumn(0,0).worldHeight)
