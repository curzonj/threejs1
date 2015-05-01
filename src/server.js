'use strict';

var WebSockets = require("ws"),
    http = require("http"),
    express = require("express"),
    logger = require('morgan'),
    bodyParser = require('body-parser'),
    uuidGen = require('node-uuid'),
    Q = require('q'),
    qhttp = require("q-io/http"),
    C = require('spacebox-common')

var cors = require('cors')({
    credentials: true,
    origin: function(origin, cb) {
        cb(null, true)
    }
})

var app = express()
var port = process.env.PORT || 5000

app.use(logger('dev'))
app.use(cors)
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({
    extended: false
}))

app.options("*", cors)

var auth_token

function getAuthToken() {
    return Q.fcall(function() {
        var now = new Date().getTime()

        if (auth_token !== undefined && auth_token.expires > now) {
            return auth_token.token
        } else {
            return qhttp.read({
                url: process.env.AUTH_URL + '/auth?ttl=3600',
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": 'Basic ' + new Buffer(process.env.INTERNAL_CREDS).toString('base64')
                }
            }).then(function(b) {
                auth_token = JSON.parse(b.toString())
                return auth_token.token
            })
        }
    })
}

function authorize(req, restricted) {
    var auth_header = req.headers.authorization

    if (auth_header === undefined) {
        // We do this so that the Q-promise error handling
        // will catch it
        return Q.fcall(function() {
            throw new Error("not authorized")
        })
    }

    var parts = auth_header.split(' ')

    // TODO make a way for internal apis to authorize
    // as a specific account without having to get a
    // different bearer token for each one. Perhaps
    // auth will return a certain account if the authorized
    // token has metadata appended to the end of it
    // or is fernet encoded.
    if (parts[0] != "Bearer") {
        throw new Error("not authorized")
    }

    // This will fail if it's not authorized
    return qhttp.read({
        method: "POST",
        url: process.env.AUTH_URL + '/token',
        headers: {
            "Content-Type": "application/json"
        },
        body: [JSON.stringify({
            token: parts[1],
            restricted: (restricted === true)
        })]
    }).then(function(body) {
        return JSON.parse(body.toString())
    }).fail(function(e) {
        throw new Error("not authorized")
    })
}

var server = http.createServer(app)

var WebSocketServer = WebSockets.Server,
wss = new WebSocketServer({
    server: server,
    verifyClient: function (info, callback) {
        authorize(info.req).then(function(auth) {
            info.req.authentication = auth
            callback(true)
        }, function(e) {
            info.req.authentication = {}
            callback(true)
        })
    }
})

require("./world_tickers/load_all.js")

var worldState = require('./world_state.js')

var debug = require('debug')('spodb')
app.get('/spodb', function(req, res) {
    var hash = {},
    list = worldState.scanDistanceFrom()
    list.forEach(function(item) {
        hash[item.key] = item
    })

    res.send(hash)
})

// TODO what happens to a structure's health when it's
// upgraded?
app.post('/spodb/:uuid', function(req, res) {
    var uuid = req.param('uuid')
    var blueprint_id = req.param('blueprint')

    C.getBlueprints().then(function(blueprints) {
        var blueprint = blueprints[blueprint_id]

        var obj = worldState.get(uuid)
        var new_obj = C.deepMerge(obj.values, {})
        C.deepMerge(blueprint, new_obj)

        return worldState.mutateWorldState(uuid, obj.rev, new_obj, true)
    }).then(function() {
        res.sendStatus(204)
    }).fail(C.http.errHandler(req, res, console.log)).done()
})
// TODO end spodb
//

app.get('/endpoints', function(req, res) {
    res.send({
        "3dsim": process.env.SPODB_URL,
        auth: process.env.AUTH_URL,
        build: process.env.BUILD_URL,
        inventory: process.env.INVENTORY_URL
    })
})

var Handler = require('./handler.js')

worldState.whenIsReady().then(function() {
    server.listen(port)
    wss.on('connection', function(ws) {
        var handler = new Handler(ws)
    })

    worldState.runWorldTicker()
    console.log("server ready")
})

