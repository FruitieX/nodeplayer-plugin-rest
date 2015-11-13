'use strict';

var MODULE_NAME = 'plugin-rest';

var _ = require('underscore');

var nodeplayerConfig = require('nodeplayer').config;
var coreConfig = nodeplayerConfig.getConfig();

var player;
var logger;

// called when nodeplayer is started to initialize the backend
// do any necessary initialization here
exports.init = function(_player, _logger, callback) {
    player = _player;
    logger = _logger;

    if (!player.plugins.express) {
        callback('module must be initialized after express module!');
    } else {
        player.app.use(function(req, res, next) {
            res.sendRes = function(err, data) {
                if (err) {
                    res.status(404).send(err);
                } else {
                    res.send(data || 'ok');
                }
            };
            next();
        });

        player.app.get('/playlist', function(req, res) {
            res.json({
                playlist: player.playlist,
                curPlaylistPos: player.curPlaylistPos,
                curSongPos: player.playbackStart ?
                    (new Date().getTime() - player.playbackStart) : null
            });
        });

        player.app.post('/playlist/song', function(req, res) {
            player.insertSongs(-1, req.body, res.sendRes);
        });
        player.app.post('/playlist/song/:at', function(req, res) {
            player.insertSongs(req.params.at, req.body, res.sendRes);
        });

        /*
        player.app.post('/queue/move/:pos', function(req, res) {
            var err = player.moveInQueue(
                parseInt(req.params.pos),
                parseInt(req.body.to),
                parseInt(req.body.cnt)
            );
            sendResponse(res, 'success', err);
        });
        */

        player.app.delete('/playlist/song/:at', function(req, res) {
            player.removeSongs(req.params.at, parseInt(req.body.cnt) || 1, res.sendRes);
        });

        player.app.post('/playctl/:play', function(req, res) {
            player.startPlayback(parseInt(req.body.position) || 0);
            res.sendRes(null, 'ok');
        });

        player.app.post('/playctl/:pause', function(req, res) {
            player.pausePlayback();
            res.sendRes(null, 'ok');
        });

        player.app.post('/playctl/:skip', function(req, res) {
            player.skipSongs(parseInt(req.body.cnt));
            res.sendRes(null, 'ok');
        });

        player.app.post('/playctl/:shuffle', function(req, res) {
            player.shuffleQueue();
            res.sendRes(null, 'ok');
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
