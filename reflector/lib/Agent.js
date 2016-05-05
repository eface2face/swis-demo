var debug = require('debug')('swis-reflector:Agent');
var debugerror = require('debug')('swis-reflector:ERROR:Agent');
debugerror.log = console.warn.bind(console);

var EventEmitter = require('events').EventEmitter;
var inherits = require('inherits');
var protooClient = require('protoo-client');
var rtcninja = require('rtcninja');
var swis = require('swis');

var notifications = require('./notifications');

function Agent(settings)
{
	debug('new() [settings:%o]', settings);

	// Inherit from EventEmitter
	EventEmitter.call(this);

	var self = this;
	var url = settings.protooUrl + '?username=' + settings.local.username + '&uuid=' + settings.local.uuid;

	// Store settings
	this._settings = settings;

	// Closed flag
	this._closed = false;

	// protoo client
	this._protoo = protooClient({ url : url });

	this._protoo.on('connecting', function(reattempt)
	{
		if (reattempt === 0)
			notifications.info('protoo connecting...');
		else
			notifications.info('protoo reconnecting...');
	});

	this._protoo.on('online', function(reattempt)
	{
		notifications.success('protoo connected');
	});

	this._protoo.on('offline', function()
	{
		notifications.error('protoo disconnected');
	});

	this._protoo.on('session', function(session, req)
	{
		notifications.success('protoo session requested...');

		self._handleSession(session);
	});

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

	session.on('open', function()
	{
		notifications.success('protoo session established');
	});

	session.on('close', function()
	{
		self._closeSession();
	});

	this._pc = new rtcninja.RTCPeerConnection(
		{
			iceServers       : this._settings.iceServers,
			gatheringTimeout : 2000
		});

	this._pc.oniceconnectionstatechange = function(event)
	{
		if (self._pc.iceConnectionState === 'connected' ||
				self._pc.iceConnectionState === 'completed')
		{
			self._pc.oniceconnectionstatechange = null;

			notifications.success('ICE connected');
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
		notifications.info('DataChannel open');

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
							notifications.info('ICE connecting...');
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

Agent.prototype._runSwisReflector = function()
{
	debug('_runSwisReflector()');

	var mirror = document.querySelector('[data-id="swis-reflector-mirror"]');

	this._reflector = new swis.Reflector(this._datachannel,
		{
			blob : false
		});

	this._reflector.reflect(mirror.contentWindow.document);

	notifications.info('swis reflector running');
};

Agent.prototype._closeSession = function()
{
	debug('_closeSession()');

	notifications.info('protoo session closed');

	this._session = null;

	// End ongoing session
	if (this._session)
	{
		try
		{
			this._session.send('end');
		}
		catch (error) {}
	}

	// Close PeerConnection
	if (this._pc && this._pc.signalingState !== 'closed')
		this._pc.close();

	// Close swis
	if (this._reflector)
		this._reflector.stop();
};

module.exports = Agent;
