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

//var ws = new WebSocket('wss://' + location.host + '/one2many');
var video;
var webRtcPeer;
var socket = io();
var autoView = true;
var room;

$(function() {
	console = new Console();
	video = $('#video')[0];
	room = $('#roomName');

	$('#call').on('click', function(e) { presenter(); e.preventDefault(); } );
	$('#viewer').on('click', function(e) { viewer(); e.preventDefault(); } );
	$('#terminate').on('click', function(e) { stop(); e.preventDefault();} );
});

socket.on('connect', function(){
	console.log('Connected to socket');

	socket.emit('subscribeToStream', currentRoom());
});

socket.on('disconnect', function(){
	console.log('Disconnected from socket');
	dispose();
});

socket.on('presenterResponse', function(data) {
	presenterResponse(data);
});

socket.on('viewerResponse', function(data) {
	viewerResponse(data);
});

socket.on('stopCommunication', function(data) {
	console.log('stopCommunication');
	dispose();
});

socket.on('iceCandidate', function(data) {
	webRtcPeer.addIceCandidate(data.candidate)
});

socket.on('streamStarted', function(data) {
	if (autoView) {
		viewer();
	}
});


function presenterResponse(message) {
	if (message.response != 'accepted') {
		var errorMsg = message.message ? message.message : 'Unknown error';
		console.warn('Call not accepted for the following reason: ' + errorMsg);
		dispose();
	} else {
		webRtcPeer.processAnswer(message.sdpAnswer);
	}
}

function viewerResponse(message) {
	if (message.response != 'accepted') {
		var errorMsg = message.message ? message.message : 'Unknown error';
		console.warn('Call not accepted for the following reason: ' + errorMsg);
		dispose();
	} else {
		webRtcPeer.processAnswer(message.sdpAnswer);
	}
}

function presenter() {
	if (!webRtcPeer) {
		showSpinner(video);

		var options = {
			localVideo: video,
			onicecandidate : onIceCandidate
	    };

		webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options, function(error) {
			if(error) return onError(error);

			this.generateOffer(onOfferPresenter);
		});
	}
}

function onOfferPresenter(error, offerSdp) {
    if (error) return onError(error);

	var message = {
		sdpOffer : offerSdp,
		room: currentRoom()
	};

	socket.emit('presenter', message);
}

function viewer() {
	autoView = true;
	if (!webRtcPeer) {
		showSpinner(video);

		var options = {
			remoteVideo: video,
			onicecandidate : onIceCandidate
		};

		webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options, function(error) {
			if(error) return onError(error);

			this.generateOffer(onOfferViewer);
		});
	}
}

function onOfferViewer(error, offerSdp) {
	if (error) return onError(error);

	var message = {
		sdpOffer : offerSdp,
		room: currentRoom()
	};
	socket.emit('viewer', message);
}

function onIceCandidate(candidate) {
	   //console.log('Local candidate' + JSON.stringify(candidate));
	   socket.emit('onIceCandidate', {candidate : candidate});
}

function stop() {
	autoView = false;
	if (webRtcPeer) {
		socket.emit('stop');
		dispose();
	}
}

function dispose() {
	if (webRtcPeer) {
		webRtcPeer.dispose();
		webRtcPeer = null;
	}
	hideSpinner(video);
}

function sendMessage(payload) {
	var event = payload.id,
		message = payload;
	console.log('Sending message - ' + event + ': ', message);

	socket.emit(event, payload);
}

function showSpinner() {
	for (var i = 0; i < arguments.length; i++) {
		arguments[i].poster = './img/transparent-1px.png';
		arguments[i].style.background = 'center transparent url("./img/spinner.gif") no-repeat';
	}
}

function hideSpinner() {
	for (var i = 0; i < arguments.length; i++) {
		arguments[i].src = '';
		arguments[i].poster = './img/webrtc.png';
		arguments[i].style.background = '';
	}
}

function currentRoom() {
	return $('#roomName').val();
}

/**
 * Lightbox utility (to display media pipeline image in a modal dialog)
 */
$(document).delegate('*[data-toggle="lightbox"]', 'click', function(event) {
	event.preventDefault();
	$(this).ekkoLightbox();
});
