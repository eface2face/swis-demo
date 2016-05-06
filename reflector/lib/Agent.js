var debug = require('debug')('swis-reflector:Agent');
var debugerror = require('debug')('swis-reflector:ERROR:Agent');
debugerror.log = console.warn.bind(console);

var EventEmitter = require('events').EventEmitter;
var inherits = require('inherits');
var protooClient = require('protoo-client');
var rtcninja = require('rtcninja');
var swis = require('swis');
var jquery = require('jquery');

var settings = require('./settings');
var notifications = require('./notifications');

function Agent(viewContainer)
{
	debug('new() [settings:%o]', settings);

	// Inherit from EventEmitter
	EventEmitter.call(this);

	var self = this;
	var url = settings.protooUrl + '?username=' + settings.local.username + '&uuid=' + settings.local.uuid;

	// View widget
	this._viewWidget = jquery(document.body)
		.View()
		.on('view:join', function()
		{
			debug('"view:join');

			self._join();
		})
		.on('view:reject', function()
		{
			debug('"view:reject');

			self._reject();
		})
		.on('view:terminate', function()
		{
			debug('"view:terminate');

			self._terminate();
		})
		.on('view:paint', function()
		{
			debug('"view:paint');

			self._reflector.paint(true);
		})
		.on('view:clearpaint', function()
		{
			debug('"view:clearpaint');

			self._reflector.clear();
		})
		.on('view:stoppaint', function()
		{
			debug('"view:stoppaint');

			self._reflector.paint(false);
		})
		.data('swis-View');

	// Closed flag
	this._closed = false;

	// protoo client
	this._protoo = protooClient({ url : url });

	this._protoo.on('connecting', function(reattempt)
	{
		if (reattempt > 0)
			notifications.info('reconnecting to the server...');
	});

	this._protoo.on('online', function(reattempt)
	{
		notifications.success('online');

		if (reattempt === 0)
			self._viewWidget.online({ code: settings.local.username });
	});

	this._protoo.on('offline', function(reattempt)
	{
		if (reattempt === 0)
			notifications.error('server connection closed');
	});

	this._protoo.on('session', function(session, req)
	{
		notifications.success('session requested');

		self._handleSession(session);
	});

	// Ringing audio
	this._ringingAudio = new Audio();
	this._ringingAudio.src = 'resources/sounds/ringing.mp3';
	this._ringingAudio.preload = 'auto';
	this._ringingAudio.loop = true;

	// PeerConnection instance
	this._pc = null;

	// DataChannel instance
	this._datachannel = null;

	// protoo Session
	this._session = null;

	// swis Reflector
	this._reflector = null;
}

// Inherits from EventEmitter
inherits(Agent, EventEmitter);

Agent.prototype._handleSession = function(session)
{
	debug('_handleSession()');

	var self = this;

	if (this._session)
	{
		session.request.reply(486);

		return;
	}

	this._session = session;

	this._viewWidget.setState('sessionrequested');

	// Play ringing
	this._ringingAudio.pause();
	this._ringingAudio.currentTime = 0.0;
	this._ringingAudio.play();

	session.on('open', function()
	{
		debug('session established');

		self._ringingAudio.pause();
	});

	session.on('close', function()
	{
		self._ringingAudio.pause();
		self._closeSession();
	});
};

Agent.prototype._join = function()
{
	debug('_join()');

	var self = this;
	var session = this._session;

	this._viewWidget.setState('sessionjoined');

	this._pc = new rtcninja.RTCPeerConnection(
		{
			iceServers       : settings.iceServers,
			gatheringTimeout : 2000
		});

	this._pc.oniceconnectionstatechange = function(event)
	{
		if (self._pc.iceConnectionState === 'connected' ||
				self._pc.iceConnectionState === 'completed')
		{
			self._pc.oniceconnectionstatechange = null;

			debug('ICE connected');
		}
	};

	this._datachannel = this._pc.createDataChannel('swis',
		{
			protocol   : 'swis',
			negotiated : true,
			id         : 666
		});

	this._datachannel.binaryType = 'arraybuffer';

	this._datachannel.onopen = function()
	{
		debug('datachannel open');

		self._runSwisReflector();
	};

	this._pc.setRemoteDescription(
		new rtcninja.RTCSessionDescription(
			{
				type : 'offer',
				sdp  : session.request.data.offer
			}),
		function()
		{
			self._pc.createAnswer(
				function(desc)
				{
					self._pc.setLocalDescription(desc,
						function()
						{
							notifications.info('establishing channel...');
						},
						function(error)
						{
							notifications.error('setLocalDescription() failed: ' + error.toString());

							session.request.reply(500);
						});
				},
				function(error)
				{
					notifications.error('createAnswer() failed: ' + error.toString());

					session.request.reply(500);
				});
		},
		function(error)
		{
			notifications.error('setRemoteDescription() failed: ' + error.toString());

			self.session.request.reply(500);
		});

	this._pc.onicecandidate = function(event)
	{
		if (!event.candidate)
		{
			self._pc.onicecandidate = null;

			session.request.reply(200, 'OK',
				{
					answer : self._pc.localDescription.sdp
				});
		}
	};
};

Agent.prototype._reject = function()
{
	debug('_join()');

	this._session.request.reply(480);
};

Agent.prototype._terminate = function()
{
	debug('_terminate()');

	this._session.removeAllListeners('close');
	this._closeSession();
};

Agent.prototype._closeSession = function()
{
	debug('_closeSession()');

	notifications.info('session ended');

	this._viewWidget.setState('idle');

	// End ongoing session
	if (this._session)
	{
		try
		{
			this._session.send('end');
		}
		catch (error) {}

		this._session = null;
	}

	// Close PeerConnection
	if (this._pc && this._pc.signalingState !== 'closed')
		this._pc.close();

	// Close swis
	if (this._reflector)
		this._reflector.stop();
};

Agent.prototype._runSwisReflector = function()
{
	debug('_runSwisReflector()');

	var self = this;
	var mirror = this._viewWidget.getMirrorElem();

	this._reflector = new swis.Reflector(this._datachannel,
		{
			blob : false
		});

	this._reflector.reflect(mirror.contentWindow.document);

	var firstResize = true;

	this._reflector.on('resize', function(data)
	{
		if (firstResize)
		{
			mirror.width = data.width;
			mirror.height = data.height;
			firstResize = false;

			self._viewWidget.visible();
		}

		mirror.width = data.width + (mirror.width - mirror.contentWindow.document.documentElement.clientWidth);
		mirror.height = data.height; + (mirror.height - mirror.contentWindow.document.documentElement.clientheight);
	});

	var remoteCursor;
	var remoteDocument = mirror.contentWindow.document;

	this._reflector.on('remotecursormove', function(data)
	{
		if (!remoteCursor)
		{
			remoteCursor = remoteDocument.createElement('div');

			remoteCursor.style['pointer-events'] = 'none';
			remoteCursor.style['position'] = 'absolute';
			remoteCursor.style['width'] = '25px';
			remoteCursor.style['height'] = '25px';
			remoteCursor.style['line-height'] = '25px';
			remoteCursor.style['text-align'] = 'center';
			remoteCursor.style['border-radius'] = '100%';
			remoteCursor.style['border'] = '1px solid #fff';
			remoteCursor.style['background-color'] = 'rgba(128, 255, 0, 0.8)';
			remoteCursor.style['color'] = '#fff';
			remoteCursor.style['font-size'] = '20px';
			remoteCursor.style['font-weight'] = 'bold';
			remoteCursor.style['margin'] = '0px';
			remoteCursor.style['padding'] = '0px';
			remoteCursor.style['z-index'] = '9999';

			remoteCursor.innerHTML = '^';

			remoteDocument.documentElement.appendChild(remoteCursor);
		}

		remoteCursor.style['left'] = data.x + 'px';
		remoteCursor.style['top'] =  data.y + 'px';
	});

	notifications.success('swis running');
};

module.exports = Agent;
