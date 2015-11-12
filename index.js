'use strict';

var MODULE_NAME = 'plugin-rest';

var _ = require('underscore');

var nodeplayerConfig = require('nodeplayer').config;
var coreConfig = nodeplayerConfig.getConfig();

var player;
var logger;

var sendResponse = function(res, msg, err) {
    if (err) {
        res.status(404).send(err);
    } else {
        res.send(msg);
    }
};

// called when nodeplayer is started to initialize the backend
// do any necessary initialization here
exports.init = function(_player, _logger, callback) {
    player = _player;
    logger = _logger;

    if (!player.plugins.express) {
        callback('module must be initialized after express module!');
    } else {
        player.app.get('/queue', function(req, res) {
            res.send(JSON.stringify(player.queue));
        });

        player.app.get('/playlist/all', function(req, res) {
            player.getPlaylists(function(playlists) {
                res.send(playlists);
            });
        });

        // queue song
        player.app.post('/queue/add', function(req, res) {
            var err = player.addToQueue(
                req.body.songs,
                parseInt(req.body.pos)
            );
            sendResponse(res, 'success', err);
        });
        player.app.post('/queue/move/:pos', function(req, res) {
            var err = player.moveInQueue(
                parseInt(req.params.pos),
                parseInt(req.body.to),
                parseInt(req.body.cnt)
            );
            sendResponse(res, 'success', err);
        });

        player.app.delete('/queue/del/:pos', function(req, res) {
            var songs = player.removeFromQueue(
                parseInt(req.params.pos),
                parseInt(req.body.cnt)
            );
            sendResponse(res, songs, null);
        });

        player.app.post('/playctl', function(req, res) {
            var action = req.body.action;
            var cnt = req.body.cnt;

            if (action === 'play') {
                player.startPlayback(parseInt(req.body.position));
            } else if (action === 'pause') {
                player.pausePlayback();
            } else if (action === 'skip') {
                player.skipSongs(parseInt(cnt));
            } else if (action === 'shuffle') {
                player.shuffleQueue();
            }

            res.send('success');
        });
        player.app.post('/volume', function(req, res) {
            player.setVolume(parseInt(req.body));
            res.send('success');
        });

        // search for song with given search terms
        player.app.post('/search', function(req, res) {
            logger.verbose('got search request: ' + req.body.terms);

            player.searchBackends(req.body, function(results) {
                res.send(JSON.stringify(results));
            });
        });

        callback();
    }
};

var pendingRequests = {};
exports.onPrepareProgress = function(song, chunk, done) {
    if (!pendingRequests[song.backendName]) {
        return;
    }

    _.each(pendingRequests[song.backendName][song.songID], function(res) {
        if (chunk) {
            res.write(chunk);
        }
        if (done) {
            res.end();
            pendingRequests[song.backendName][song.songID] = [];
        }
    });
};

exports.onBackendInitialized = function(backendName) {
    pendingRequests[backendName] = {};

    // provide API path for music data, might block while song is preparing
    player.app.get('/song/' + backendName + '/:fileName', function(req, res, next) {
        var songID = req.params.fileName.substring(0, req.params.fileName.lastIndexOf('.'));
        var songFormat = req.params.fileName.substring(req.params.fileName.lastIndexOf('.') + 1);

        var song = {
            songID: songID,
            format: songFormat
        };

        if (player.backends[backendName].isPrepared(song)) {
            // song should be available on disk
            res.sendFile('/' + backendName + '/' + songID + '.' + songFormat, {
                root: coreConfig.songCachePath
            });
        } else if (player.songsPreparing[backendName] &&
                player.songsPreparing[backendName][songID]) {
            // song is preparing
            var preparingSong = player.songsPreparing[backendName][songID];

            // try finding out length of song
            var queuedSong = player.searchQueue(backendName, songID);
            if (queuedSong) {
                res.setHeader('X-Content-Duration', queuedSong.duration / 1000);
            }

            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Content-Type', 'audio/ogg; codecs=opus');
            res.setHeader('Accept-Ranges', 'bytes');

            var range = [0];
            if (req.headers.range) {
                // partial request

                range = req.headers.range.substr(req.headers.range.indexOf('=') + 1).split('-');
                res.statusCode = 206;

                // a best guess for the header
                var end;
                var dataLen = preparingSong.songData ? preparingSong.songData.length : 0;
                if (range[1]) {
                    end = Math.min(range[1], dataLen - 1);
                } else {
                    end = dataLen - 1;
                }

                // TODO: we might be lying here if the code below sends whole song
                res.setHeader('Content-Range', 'bytes ' + range[0] + '-' + end + '/*');
            }

            // TODO: we can be smarter here: currently most corner cases lead to sending entire
            // song even if only part of it was requested. Also the range end is currently ignored

            // skip to start of requested range if we have enough data, otherwise serve whole song
            if (range[0] < preparingSong.songData.length) {
                res.write(preparingSong.songData.slice(range[0]));
            } else {
                res.write(preparingSong.songData);
            }

            pendingRequests[backendName][song.songID] =
                pendingRequests[backendName][song.songID] || [];

            pendingRequests[backendName][song.songID].push(res);
        } else {
            res.status(404).end('404 song not found');
        }
    });
};
