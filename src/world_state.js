'use strict';

var EventEmitter = require('events').EventEmitter,
    extend = require('extend'),
    util = require('util'),
    npm_debug = require('debug'),
    log = npm_debug('3dsim:info'),
    error = npm_debug('3dsim:error'),
    debug = npm_debug('3dsim:debug'),
    C = require('spacebox-common'),
    db = require('spacebox-common-native').db,
    Q = require('q'),
    uuidGen = require('node-uuid')

var keys_to_update_on = [ "blueprint", "account", "solar_system" ]

// WorldState is a private function so it's safe
// to declare these here.
var listeners = []

var dao = {
    loadIterator: function(fn) {
        return db.
            query("select * from space_objects where tombstone = $1", [ false ]).
            then(function(data) {
                for (var row in data) {
                    fn(data[row])
                }
            })
    },
    insert: function(values) {
        return db.
            query("insert into space_objects (id, system_id, doc) values (uuid_generate_v1(), $1, $2) returning id", [ values.solar_system, values ])
    },
    update: function(key, values) {
    
        return db.query("update space_objects set doc = $2 where id = $1", [ key, values ])
    },
    tombstone: function(key) {
        return db.query("update space_objects set tombstone = $2, tombstone_at = current_timestamp where id = $1 and tombstone = false and tombstone_at is null", [ key, true ] )
    }

}

// worldStateStorage is modeled a lot like riak,
// each object has a version and has attributes and
// it's basically a key value store. this class acts
// like a pubsub sending the changes to all the
// listeners and storing a compelete snapshot of state
// for bootstrapping.
var worldStateStorage = {}

function WorldState() {}

util.inherits(WorldState, EventEmitter)

extend(WorldState.prototype, {
    whenIsReady: function() {
        return this.loadFromDBOnBoot()
    },
    loadFromDBOnBoot: function() {
        return dao.loadIterator(function(obj) {
            worldStateStorage[obj.id] = {
                key: obj.id,
                rev: 0,
                values: obj.doc
            }

            debug("loaded", obj)
        })
    },

    // TODO implement the distance limit
    scanKeysDistanceFrom: function(coords) {
        return Object.keys(worldStateStorage)
    },

    getHack: function() {
        return worldStateStorage
    },

    scanDistanceFrom: function(coords, type) {
        var list = this.scanKeysDistanceFrom(coords).map(function(k) {
            return this.get(k)
        }, this)

        return list.filter(function(v, i) {
            return (v !== undefined && v.values.tombstone !== true && (type === undefined || v.values.type === type))
        })
    },

    get: function(key) {
        if (key !== undefined) {
            return worldStateStorage[key.toString()]
        }
    },

    addObject: function(values) {
        var self = this

        self.emit('worldStatePrepareNewObject', values)

        return dao.insert(values).
            then(function(data) {
                var id = data[0].id

                debug("added object", id, values)
                self.mutateWorldState(id, 0, values)
                return id
            })
    },

    mutateWorldState: function(key, expectedRev, patch, withDebug) {
        key = key.toString()

        if (withDebug === true) {
            debug(patch)
        }

        // TODO this needs to sync tick time
        var ts = this.currentTick()
        var old = worldStateStorage[key] || {
            key: key,
            rev: 0,
            values: {}
        }

        var oldRev = old.rev
        var newRev = old.rev = oldRev + 1

        if (oldRev !== expectedRev) {
            var data = {
                type: "revisionError",
                expected: expectedRev,
                found: oldRev,
                key: key
            }

            debug(data)
            var e = new Error("revisionError expected="+expectedRev+" found="+oldRev)
            e.data = data
            throw e
        }

        if (worldStateStorage[key] === undefined) {
            worldStateStorage[key] = old
        }

        if (patch.tombstone === true && old.values.tombstone !== true) {
            dao.tombstone(key);
        }

        C.deepMerge(patch, old.values)

        // broadcast the change to all the listeners
        listeners.forEach(function(h) {
            if (h.onWorldStateChange !== undefined) {
                h.onWorldStateChange(ts, key, oldRev, newRev, patch)
            }
        })


        if (keys_to_update_on.some(function(i) { return patch.hasOwnProperty(i) })) {
            return dao.update(key, old.values)
        } else {
            return Q(null)
        }
    },

    addListener: function(l) {
        listeners.push(l)
    },
    removeListener: function(l) {
        var index = listeners.indexOf(l)
        listeners.splice(index, 1)
    },

    tickInterval: 80,
    runWorldTicker: function() {
        setInterval(this.worldTick.bind(this), this.tickInterval)
    },

    currentTick: function() {
        var ms = new Date().getTime()
        var tickNumber = ms - (ms % this.tickInterval)

        return tickNumber
    },

    worldTick: function() {
        // TODO the tickNumber should be synced with
        // worldstate mutations
        var tickNumber = this.currentTick()

        listeners.forEach(function(h) {
            if (h.worldTick !== undefined) {
                h.worldTick(tickNumber)
            }
        })
    }
})

module.exports = new WorldState()
