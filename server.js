/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var path = require('path');
var url = require('url');
var express = require('express');
var minimist = require('minimist');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');
var socketio = require('socket.io');

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

var options =
{
  key:  fs.readFileSync(path.join(__dirname,'keys/server.key')),
  cert: fs.readFileSync(path.join(__dirname, 'keys/server.crt'))
};

var app = express();

/*
 * Definition of global variables.
 */
var candidatesQueue = {};
var kurentoClient = null;
var noPresenterMessage = 'No active presenter. Try again later...';
var anotherPresenterIsActive = "Another user is currently acting as presenter. Try again later ...";

var rooms = [];


/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app);
var io = socketio(server);

server.listen(port, function() {
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});


/*
 * Rooms related methods
 */

function getRoom(socket) {
	if (rooms[socket.room] == undefined) {
		createRoom(socket.room);
	}
	return rooms[socket.room];
}

function createRoom(room) {
	rooms[room] = {
		presenter: null,
		pipeline: null,
		viewers: [],
		chat: []
	};
}

function joinRoom(socket, data) {
	// leave all other socket.id rooms
	while(socket.rooms.length) {
		socket.leave(socket.rooms[0]);
	}

	// join new socket.io room
	socket.join(data.room);
	socket.room = data.room;
	socket.username = data.username;

	socket.emit('joinedRoom');

	console.log('Join room: ' + data.room + ' with username ' + data.username);
}

function newChatMessage(socket, message){
	var message = {message: message, username: socket.username}
	io.in(socket.room).emit('chat:newMessage', message)

	var room = getRoom(socket);
	room.chat.push(message);

	if (room.chat.length > 30)
		room.chat.shift()
}

/*
 * Define possible actions which we'll send thru Websocket
 */
function acceptPeerResponse(peerType, sdpAnswer) {
	return {
		id : peerType + 'Response',
		response : 'accepted',
		sdpAnswer : sdpAnswer
	};
}

function rejectPeerResponse(peerType, reason) {
	return {
		id : peerType + 'Response',
		response : 'rejected',
		message : reason
	};
}

/*
 * Socket pipeline
 */
io.on('connection', function(socket) {
	console.log('Connection received with sessionId - ' + socket.id);

	socket.on('error', function(error) {
        console.error('Connection ' + socket.id + ' error', error);
        stop(socket);
    });

	socket.on('disconnect', function() {
        console.log('Connection ' + socket.id + ' closed');
        stop(socket);
    });

	// Handle events from clients
	socket.on('presenter', function (data) {
		startPresenter(socket, data.sdpOffer, function(error, sdpAnswer) {
			var response = (error) ? rejectPeerResponse('presenter', error) : acceptPeerResponse('presenter', sdpAnswer);
			socket.emit(response.id, response);
			if (!error) {
				console.log(socket.username + ' starting publishing to ' + socket.room + ' room');
				socket.broadcast.emit('streamStarted');
			}
		});
	});

	socket.on('viewer', function (data){
		startViewer(socket, data.sdpOffer, function(error, sdpAnswer) {
			response = (error) ? rejectPeerResponse('viewer', error) : acceptPeerResponse('viewer', sdpAnswer);
			socket.emit(response.id, response);
		});
	});

	socket.on('stop', function(){
		stop(socket);
	});

	socket.on('onIceCandidate', function (data){
		onIceCandidate(socket, data.candidate);
	});

	socket.on('subscribeToStream', function (data){
		joinRoom(socket, data);
		var room = getRoom(socket);
		if (room.presenter) {
			socket.emit('streamStarted');
		}
	});

	socket.on('joinRoom', function (data){
		joinRoom(socket, data)
	});


	// Chat methods
	socket.on('chat:newMessage', function(message) {
		newChatMessage(socket, message);
	});

	socket.on('chat:loadMessages', function() {
		var room = getRoom(socket);

		socket.emit('chat:messages', room.chat);
	});
});



/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function startPresenter(socket, sdpOffer, callback) {
	clearCandidatesQueue(socket);

	var room = getRoom(socket);
	if (room.presenter !== null) {
		stop(socket);
		return callback(anotherPresenterIsActive);
	}

	room.presenter = {
		webRtcEndpoint : null,
		id: socket.id
	};

	getKurentoClient(function(error, kurentoClient) {
		if (error) {
			stop(socket);
			return callback(error);
		}

		if (room.presenter === null) {
			stop(socket);
			return callback(noPresenterMessage);
		}

		kurentoClient.create('MediaPipeline', function(error, pipeline) {
			if (error) {
				stop(socket);
				return callback(error);
			}

			if (room.presenter === null) {
				stop(socket);
				return callback(noPresenterMessage);
			}

			room.pipeline = pipeline;
			pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
				if (error) {
					stop(socket);
					return callback(error);
				}

				if (room.presenter === null) {
					stop(socket);
					return callback(noPresenterMessage);
				}

				room.presenter.webRtcEndpoint = webRtcEndpoint;

                if (candidatesQueue[socket.id]) {
                    while(candidatesQueue[socket.id].length) {
                        var candidate = candidatesQueue[socket.id].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                webRtcEndpoint.on('OnIceCandidate', function(event) {
                    var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                    socket.emit('iceCandidate', { candidate : candidate });
                });

				webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
					if (error) {
						stop(socket);
						return callback(error);
					}

					if (room.presenter === null) {
						stop(socket);
						return callback(noPresenterMessage);
					}

					callback(null, sdpAnswer);
				});

                webRtcEndpoint.gatherCandidates(function(error) {
                    if (error) {
                        stop(socket);
                        return callback(error);
                    }
                });
            });
        });
	});
}

function startViewer(socket, sdpOffer, callback) {
	clearCandidatesQueue(socket);

	var room = getRoom(socket);

	if (room.presenter === null) {
		stop(socket);
		return callback(noPresenterMessage);
	}

	room.pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
		if (error) {
			stop(socket);
			return callback(error);
		}
		room.viewers[socket.id] = {
			"webRtcEndpoint" : webRtcEndpoint,
			"socket" : socket
		};

		if (room.presenter === null) {
			stop(socket);
			return callback(noPresenterMessage);
		}

		if (candidatesQueue[socket.id]) {
			while(candidatesQueue[socket.id].length) {
				var candidate = candidatesQueue[socket.id].shift();
				webRtcEndpoint.addIceCandidate(candidate);
			}
		}

        webRtcEndpoint.on('OnIceCandidate', function(event) {
            var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
			socket.emit('iceCandidate', { candidate : candidate });
        });

		webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
			if (error) {
				stop(socket.id);
				return callback(error);
			}
			if (room.presenter === null) {
				stop(socket.id);
				return callback(noPresenterMessage);
			}

			room.presenter.webRtcEndpoint.connect(webRtcEndpoint, function(error) {
				if (error) {
					stop(socket.id);
					return callback(error);
				}
				if (room.presenter === null) {
					stop(socket.id);
					return callback(noPresenterMessage);
				}

				callback(null, sdpAnswer);
		        webRtcEndpoint.gatherCandidates(function(error) {
		            if (error) {
			            stop(socket.id);
			            return callback(error);
		            }
		        });
		    });
	    });
	});
}

function clearCandidatesQueue(socket) {
	if (candidatesQueue[socket.id]) {
		delete candidatesQueue[socket.id];
	}
}

function stop(socket) {
	var room = getRoom(socket);

	if (room.presenter !== null && room.presenter.id == socket.id) {
		stopPresenter(socket);
	} else if (room.viewers[socket.id]) {
		stopViewing(socket);
	}
}

function stopPresenter(socket){
	var room = getRoom(socket);
	var viewers = room.viewers;

	for (var i in viewers) {
		var viewer = viewers[i];
		if (viewer.socket) {
			clearCandidatesQueue(socket);
			viewer.webRtcEndpoint.release();
			viewer.socket.emit('stopCommunication');
		}
	}

	room.presenter.webRtcEndpoint.release();
	room.presenter = null;
	room.pipeline.release();
	room.viewers = [];
}

function stopViewing(socket){
	var room = getRoom(socket);

	clearCandidatesQueue(socket.id);
	room.viewers[socket.id].webRtcEndpoint.release();
	delete room.viewers[socket.id];
}

function onIceCandidate(socket, _candidate) {
	var room = getRoom(socket);

    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);

    if (room.presenter && room.presenter.id === socket.id && room.presenter.webRtcEndpoint) {
        console.info('Sending presenter candidate');
        room.presenter.webRtcEndpoint.addIceCandidate(candidate);
    }
    else if (room.viewers[socket.id] && room.viewers[socket.id].webRtcEndpoint) {
        console.info('Sending viewer candidate');
		room.viewers[socket.id].webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[socket.id]) {
            candidatesQueue[socket.id] = [];
        }
        candidatesQueue[socket.id].push(candidate);
    }
}

app.use(function (req, res, next) {
	// Website you wish to allow to connect
	res.setHeader('Access-Control-Allow-Origin', '*');

	next();
});

app.use(express.static(path.join(__dirname, 'static')));
