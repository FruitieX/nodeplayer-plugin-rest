'use strict';

var MODULE_NAME = 'plugin-rest';

var path = require('path');
var fs = require('fs');
var _ = require('underscore');
var meter = require('stream-meter');
var bodyParser = require('body-parser');

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

        // queue song
        player.app.post('/queue/add', bodyParser.json({limit: '100mb'}), function(req, res) {
            var err = player.addToQueue(
                req.body.songs,
                parseInt(req.body.pos)
            );
            sendResponse(res, 'success', err);
        });
        player.app.post('/queue/move/:pos', bodyParser.json({limit: '100mb'}), function(req, res) {
            var err = player.moveInQueue(
                parseInt(req.params.pos),
                parseInt(req.body.to),
                parseInt(req.body.cnt)
            );
            sendResponse(res, 'success', err);
        });

        player.app.delete('/queue/del/:pos', bodyParser.json({limit: '100mb'}), function(req, res) {
            var songs = player.removeFromQueue(
                parseInt(req.params.pos),
                parseInt(req.body.cnt)
            );
            sendResponse(res, songs, null);
        });

        player.app.post('/playctl', bodyParser.json({limit: '100mb'}), function(req, res) {
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
        player.app.post('/volume', bodyParser.json({limit: '100mb'}), function(req, res) {
            player.setVolume(parseInt(req.body));
            res.send('success');
        });

        // search for song with given search terms
        player.app.post('/search', bodyParser.json({limit: '100mb'}), function(req, res) {
            logger.verbose('got search request: ' + req.body.terms);

            player.searchBackends(req.body, function(results) {
                res.send(JSON.stringify(results));
            });
        });

        callback();
    }
};

var pendingReqHandlers = [];
exports.onPrepareProgress = function(song, dataSize, done) {
    for (var i = pendingReqHandlers.length - 1; i >= 0; i--) {
        pendingReqHandlers.pop()();
    }
};

var getFilesizeInBytes = function(filename) {
    if (fs.existsSync(filename)) {
        var stats = fs.statSync(filename);
        var fileSizeInBytes = stats.size;
        return fileSizeInBytes;
    } else {
        return -1;
    }
};

var getPath = function(player, songID, backendName, songFormat) {
    if (player.songsPreparing[backendName] &&
            player.songsPreparing[backendName][songID]) {
        return coreConfig.songCachePath + '/' + backendName +
            '/incomplete/' + songID + '.' + songFormat;
    } else {
        return coreConfig.songCachePath + '/' + backendName +
            '/' + songID + '.' + songFormat;
    }
};

exports.onBackendInitialized = function(backendName) {
    // expressjs middleware for requesting music data
    // must support ranges in the req, and send the data to res
    player.app.get('/song/' + backendName + '/:fileName', function(req, res, next) {
        var songID = req.params.fileName.substring(0, req.params.fileName.lastIndexOf('.'));
        var songFormat = req.params.fileName.substring(req.params.fileName.lastIndexOf('.') + 1);

        // try finding out length of song
        var song = player.searchQueue(backendName, songID);
        if (song) {
            res.setHeader('X-Content-Duration', song.duration / 1000);
        }

        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Content-Type', 'audio/ogg; codecs=opus');
        //res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Accept-Ranges', 'bytes');
        //res.setHeader('Connection', 'keep-alive');

        var range = [0];
        if (req.headers.range) {
            range = req.headers.range.substr(req.headers.range.indexOf('=') + 1).split('-');
            // TODO: only 206 used right now
            //if (range[0] != 0 || range[1]) {
            // try guessing at least some length for the song to keep chromium happy
            res.statusCode = 206;
            var path = getPath(player, songID, backendName, songFormat);
            var fileSize = getFilesizeInBytes(path);

            // a best guess for the header
            var end;
            if (range[1]) {
                end = Math.min(range[1], fileSize - 1);
            } else {
                end = fileSize - 1;
            }

            // total file size, if known
            var outOf = '*';
            if (!player.songsPreparing[backendName] ||
                    !player.songsPreparing[backendName][songID]) {
                outOf = fileSize;
            }
            res.setHeader('Content-Range', 'bytes ' + range[0] + '-' + end + '/' + outOf);
            //}
        }

        logger.debug('got streaming request for song: ' + songID + ', range: ' + range);

        var doSend = function(offset) {
            var m = meter();

            // TODO: this may have race condition issues causing the end of a song to be cut out
            var path = getPath(player, songID, backendName, songFormat);

            if (fs.existsSync(path)) {
                var end;
                if (range[1]) {
                    end = Math.min(range[1], getFilesizeInBytes(path) - 1);
                } else {
                    end = getFilesizeInBytes(path) - 1;
                }

                if (offset > end) {
                    if (range[1] && range[1] <= offset) {
                        // range request was fullfilled
                        res.end();
                    } else if (player.songsPreparing[backendName] &&
                            player.songsPreparing[backendName][songID]) {
                        // song is still preparing, there is more data to come
                        logger.debug('enough data not yet available at: ' + path);
                        pendingReqHandlers.push(function() {
                            doSend(offset);
                        });
                    } else if ((getFilesizeInBytes(path) - 1) <= offset) {
                        // song fully prepared and sent
                        res.end();
                    } else {
                        // bad range
                        res.status(416).end();
                    }
                } else {
                    // data is available, let's send as much as we can
                    // TODO: would it maybe be better to open the file once per
                    // request and then seek...
                    var sendStream = fs.createReadStream(path, {
                        start: offset,
                        end: end
                    });
                    sendStream.pipe(m).pipe(res, {end: false});

                    var closeStream = function() {
                        logger.silly('client closed connection, closing sendStream');
                        sendStream.close();
                    };
                    var finishStream = function() {
                        logger.silly('response finished, closing sendStream');
                        sendStream.close();
                    };

                    m.on('end', function() {
                        logger.silly('eof hit, running doSend again with new offset');

                        // close old pipes
                        sendStream.unpipe();
                        m.unpipe();

                        sendStream.close();

                        // res will be reused in doSend, avoid event listener leak
                        res.removeListener('close', closeStream);
                        res.removeListener('finish', finishStream);

                        doSend(m.bytes + offset);
                    });

                    res.on('close', closeStream);
                    res.on('finish', finishStream);
                }
            } else {
                logger.verbose('file not found: ' + path);
                res.status(404).end();
            }
        };

        doSend(parseInt(range[0]));
    });
};
