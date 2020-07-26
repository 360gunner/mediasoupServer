#!/usr/bin/env node

process.title = 'mediasoup-demo-server';
process.env.DEBUG = process.env.DEBUG || '*INFO* *WARN* *ERROR*';

const config = require('./config');

/* eslint-disable no-console */
console.log('process.env.DEBUG:', process.env.DEBUG);
console.log('config.js:\n%s', JSON.stringify(config, null, '  '));
/* eslint-enable no-console */

const fs = require('fs');
const https = require('https');
const url = require('url');
const protoo = require('protoo-server');
const mediasoup = require('mediasoup');
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const cors = require('cors');
const { AwaitQueue } = require('awaitqueue');
const Logger = require('./lib/Logger');
const Room = require('./lib/Room');
const Building = require('./lib/Building');
const interactiveServer = require('./lib/interactiveServer');
const interactiveClient = require('./lib/interactiveClient');


const logger = new Logger();

// Async queue to manage rooms.
// @type {AwaitQueue}
const queue = new AwaitQueue();

// Map of Room instances indexed by roomId.
// @type {Map<Number, Room>}
const rooms = new Map();

// HTTPS server.
// @type {https.Server}
let httpsServer;

// Express application.
// @type {Function}
let expressApp;

// Protoo WebSocket server.
// @type {protoo.WebSocketServer}
let protooWebSocketServer;

// mediasoup Workers.
// @type {Array<mediasoup.Worker>}
const mediasoupWorkers = [];

// Index of next mediasoup Worker to use.
// @type {Number}
let nextMediasoupWorkerIdx = 0;

//database
mongoose.connect(config.database.link+config.database.name,(err) => {
	if(err)
		logger.info(err);
	else
		logger.info('Connected to '+ config.database.name);
})

run();

async function run()
{
	// Open the interactive server.
	await interactiveServer();

	// Open the interactive client.
	if (process.env.INTERACTIVE === 'true' || process.env.INTERACTIVE === '1')
		await interactiveClient();

	// Run a mediasoup Worker.
	await runMediasoupWorkers();

	// Create Express app.
	await createExpressApp();

	// Run HTTPS server.
	await runHttpsServer();

	// Run a protoo WebSocketServer.
	await runProtooWebSocketServer();

	// Log rooms status every X seconds.
	setInterval(() =>
	{
		for (const room of rooms.values())
		{
			room.logStatus();
		}
	}, 120000);
}

/**
 * Launch as many mediasoup Workers as given in the configuration file.
 */
async function runMediasoupWorkers()
{
	const { numWorkers } = config.mediasoup;

	logger.info('running %d mediasoup Workers...', numWorkers);

	for (let i = 0; i < numWorkers; ++i)
	{
		const worker = await mediasoup.createWorker(
			{
				logLevel   : config.mediasoup.workerSettings.logLevel,
				logTags    : config.mediasoup.workerSettings.logTags,
				rtcMinPort : Number(config.mediasoup.workerSettings.rtcMinPort),
				rtcMaxPort : Number(config.mediasoup.workerSettings.rtcMaxPort)
			});

		worker.on('died', () =>
		{
			logger.error(
				'mediasoup Worker died, exiting  in 2 seconds... [pid:%d]', worker.pid);

			setTimeout(() => process.exit(1), 2000);
		});

		mediasoupWorkers.push(worker);

		// Log worker resource usage every X seconds.
		setInterval(async () =>
		{
			const usage = await worker.getResourceUsage();

			logger.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
		}, 120000);
	}
}

/**
 * Create an Express based API server to manage Broadcaster requests.
 */
async function createExpressApp()
{
	logger.info('creating Express app...');

	expressApp = express();

	expressApp.use(bodyParser.json());
	expressApp.use(cors());

	/**
	 * For every API request, verify that the buildingId in the path matches and
	 * existing building.
	 */

	expressApp.param(
		'buildingId', (req, res, next, buildingId) =>
		{
			Building.findOne({ _id: buildingId}).exec((err,building) => {
				if(err){
					const error = new Error(`building with id "${buildingId}" not found`);
					error.status = 404;
					next(error);
				}
				else{
					req.building = building;
					next();
				}
			})
		});

	 /**
	 * POST API to get specific building informations and its list of rooms
	 * https://localhost:4443/buildings/5f1b59300bce0b2e8e866d6a
	 */

	expressApp.post('/buildings/:buildingId', async (req, res, next) => {


		const password = req.body.password;
		const { buildingId } = req.params;

		Building.findOne({ _id: buildingId },"-__v")
		.exec((err,build) => {
			if(err || !build){
				const error = new Error(`Building not found`);
				error.status=404;
				next(error);
			}else{
				var validpassword = build.comparePassword(password,build.password);
					if(validpassword){
						var b = new Building();
						b.name=build.name;
						b.roomIds=build.roomIds;
						b._id=build._id;
						b.created=build.created;
						res.status(200).json(b);
					}
					else{
						const error = new Error(`Wrong password`);
						error.status=401;
						next(error);	
					}
			}
		})
	 })

	/**
	 * POST API to create a Building.
	 */
	expressApp.post(
		'/buildings', async (req, res, next) =>
		{
			try{
				const name = req.body.name;

				Building.findOne({ name: name},(err,build) => {
					if(err)
					{
						const error = new Error(`There's a problem..`);
						error.status=500;
						next(error);
					}
					if(!build){
						let building = new Building();
						building.name = req.body.name;
						building.password = req.body.password;
						building.save();
						res.status(201).json("building created");}
					else{
						res.status(409).json("building exists");
					}})
			}
			catch(error){
				next(error);
			}
		});


	/**
	 * DELETE API to delete a Building.
	 */

	expressApp.delete(
		'/buildings/:buildingId', (req, res, next) =>
		{
			try{

				const password = req.body.password;
				const { buildingId } = req.params;

				//comparing password
				Building.findOne({ _id: buildingId},(err,build) => {
					if(err)
					{
						const error = new Error(`There's a problem..`);
						error.status=500;
						next(error);
					}
					if(!build){
						const error = new Error(`Building doesn't exist`);
						error.status=404;
						next(error);
					}else{
						var validpassword = build.comparePassword(password,build.password);
						if(validpassword){
							//closing all rooms for this building
							for(var key in build.roomIds){
								rooms.get(build.roomIds[key]).close();
							}
							//deleting the building
							Building.deleteOne({ _id: buildingId}, (err) => {
								if(err)
									{
										const error = new Error(`There's a problem..`);
										error.status=500;
										next(error);
									}
							});
							res.status(200).send('building deleted');
						}else{
							const error = new Error(`Wrong password`);
							error.status=401;
							next(error);
						}
					}
				})
			}
			catch(error){
				next(error);
			}
		});

	/**
	 * GET API to get the list of buildings
	 */

	 expressApp.get('/buildings', async (req, res, next) => {
		 Building.find({}, "name created", (err,builds)=>{
			 if(err) {
				const error = new Error(`There's a problem..`);
				error.status= 500;
				next(error);
			 }else{
				 res.status(200).json(builds);
			 }
		 })
	 })

	


	/**
	 * For every API request, verify that the roomId in the path matches and
	 * existing room.
	 */
	expressApp.param(
		'roomId', (req, res, next, roomId) =>
		{
			// The room must exist for all API requests.
			if (!rooms.has(roomId))
			{
				const error = new Error(`room with id "${roomId}" not found`);
				error.status=404;
				next(error);
			}

			req.room = rooms.get(roomId);

			next();
		});

	/**
	 * API GET resource that returns the mediasoup Router RTP capabilities of
	 * the room.
	 */
	expressApp.get(
		'/buildings/:buildingId/rooms/:roomId', (req, res, next) =>
		{
			try{
				const data = req.room.getRouterRtpCapabilities();

				res.status(200).json(data);
			}
			catch(error){
				next(error);
			}
		});

	/**
	 * POST API to create a Broadcaster.
	 */
	expressApp.post(
		'/buildings/:buildingId/rooms/:roomId/broadcasters', async (req, res, next) =>
		{
			const {
				id,
				displayName,
				device,
				rtpCapabilities
			} = req.body;

			try
			{
				const data = await req.room.createBroadcaster(
					{
						id,
						displayName,
						device,
						rtpCapabilities
					});

				res.status(200).json(data);
			}
			catch (error)
			{
				next(error);
			}
		});

	/**
	 * DELETE API to delete a Broadcaster.
	 */
	expressApp.delete(
		'/buildings/:buildingId/rooms/:roomId/broadcasters/:broadcasterId', (req, res, next) =>
		{
			try{
				const { broadcasterId } = req.params;

				req.room.deleteBroadcaster({ broadcasterId });

				res.status(200).send('broadcaster deleted');
			}
			catch(error){
				next(error);
			}
		});

	/**
	 * POST API to create a mediasoup Transport associated to a Broadcaster.
	 * It can be a PlainTransport or a WebRtcTransport depending on the
	 * type parameters in the body. There are also additional parameters for
	 * PlainTransport.
	 */
	expressApp.post(
		'/buildings/:buildingId/rooms/:roomId/broadcasters/:broadcasterId/transports',
		async (req, res, next) =>
		{
			const { broadcasterId } = req.params;
			const { type, rtcpMux, comedia, sctpCapabilities } = req.body;

			try
			{
				const data = await req.room.createBroadcasterTransport(
					{
						broadcasterId,
						type,
						rtcpMux,
						comedia, 
						sctpCapabilities
					});

				res.status(200).json(data);
			}
			catch (error)
			{
				next(error);
			}
		});

	/**
	 * POST API to connect a Transport belonging to a Broadcaster. Not needed
	 * for PlainTransport if it was created with comedia option set to true.
	 */
	expressApp.post(
		'/buildings/:buildingId/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/connect',
		async (req, res, next) =>
		{
			const { broadcasterId, transportId } = req.params;
			const { dtlsParameters } = req.body;

			try
			{
				const data = await req.room.connectBroadcasterTransport(
					{
						broadcasterId,
						transportId,
						dtlsParameters
					});

				res.status(200).json(data);
			}
			catch (error)
			{
				next(error);
			}
		});

	/**
	 * POST API to create a mediasoup Producer associated to a Broadcaster.
	 * The exact Transport in which the Producer must be created is signaled in
	 * the URL path. Body parameters include kind and rtpParameters of the
	 * Producer.
	 */
	expressApp.post(
		'/buildings/:buildingId/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/producers',
		async (req, res, next) =>
		{
			const { broadcasterId, transportId } = req.params;
			const { kind, rtpParameters } = req.body;

			try
			{
				const data = await req.room.createBroadcasterProducer(
					{
						broadcasterId,
						transportId,
						kind,
						rtpParameters
					});

				res.status(200).json(data);
			}
			catch (error)
			{
				next(error);
			}
		});

	/**
	 * POST API to create a mediasoup Consumer associated to a Broadcaster.
	 * The exact Transport in which the Consumer must be created is signaled in
	 * the URL path. Query parameters must include the desired producerId to
	 * consume.
	 */
	expressApp.post(
		'/buildings/:buildingId/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/consume',
		async (req, res, next) =>
		{
			const { broadcasterId, transportId } = req.params;
			const { producerId } = req.query;

			try
			{
				const data = await req.room.createBroadcasterConsumer(
					{
						broadcasterId,
						transportId,
						producerId
					});

				res.status(200).json(data);
			}
			catch (error)
			{
				next(error);
			}
		});

	/**
	 * POST API to create a mediasoup DataConsumer associated to a Broadcaster.
	 * The exact Transport in which the DataConsumer must be created is signaled in
	 * the URL path. Query body must include the desired producerId to
	 * consume.
	 */
	expressApp.post(
		'/buildings/:buildingId/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/consume/data',
		async (req, res, next) =>
		{
			const { broadcasterId, transportId } = req.params;
			const { dataProducerId } = req.body;

			try
			{
				const data = await req.room.createBroadcasterDataConsumer(
					{
						broadcasterId,
						transportId,
						dataProducerId
					});

				res.status(200).json(data);
			}
			catch (error)
			{
				next(error);
			}
		});
	
	/**
	 * POST API to create a mediasoup DataProducer associated to a Broadcaster.
	 * The exact Transport in which the DataProducer must be created is signaled in
	 */
	expressApp.post(
		'/buildings/:buildingId/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/produce/data',
		async (req, res, next) =>
		{
			const { broadcasterId, transportId } = req.params;
			const { label, protocol, sctpStreamParameters, appData } = req.body;

			try
			{
				const data = await req.room.createBroadcasterDataProducer(
					{
						broadcasterId,
						transportId,
						label,
						protocol,
						sctpStreamParameters,
						appData
					});

				res.status(200).json(data);
			}
			catch (error)
			{
				next(error);
			}
		});

	/**
	 * Error handler.
	 */
	expressApp.use(
		(error, req, res, next) =>
		{
			if (error)
			{
				logger.warn('Express app %s', String(error));

				error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

				res.statusMessage = error.message;
				res.status(error.status).send(String(error));
			}
			else
			{
				next();
			}
		});
}

/**
 * Create a Node.js HTTPS server. It listens in the IP and port given in the
 * configuration file and reuses the Express application as request listener.
 */
async function runHttpsServer()
{
	logger.info('running an HTTPS server...');

	// HTTPS server for the protoo WebSocket server.
	const tls =
	{
		cert : fs.readFileSync(config.https.tls.cert),
		key  : fs.readFileSync(config.https.tls.key)
	};

	httpsServer = https.createServer(tls, expressApp);

	await new Promise((resolve) =>
	{
		httpsServer.listen(
			Number(config.https.listenPort), config.https.listenIp, resolve);
	});
}

/**
 * Create a protoo WebSocketServer to allow WebSocket connections from browsers.
 */
async function runProtooWebSocketServer()
{
	logger.info('running protoo WebSocketServer...');

	// Create the protoo WebSocket server.
	protooWebSocketServer = new protoo.WebSocketServer(httpsServer,
		{
			maxReceivedFrameSize     : 960000, // 960 KBytes.
			maxReceivedMessageSize   : 960000,
			fragmentOutgoingMessages : true,
			fragmentationThreshold   : 960000
		});

	// Handle connections from clients.
	protooWebSocketServer.on('connectionrequest', (info, accept, reject) =>
	{
		// The client indicates the buildingId, roomId and peerId in the URL query.
		const u = url.parse(info.request.url, true);
		const buildingId = u.query['buildingId'];
		const roomId = u.query['roomId'];
		const peerId = u.query['peerId'];

		if (!buildingId || !roomId || !peerId)
		{
			reject(400, 'Connection request without buildingId and/or roomId and/or peerId');

			return;
		}

		logger.info(
			'protoo connection request [buildingId:%s, roomId:%s, peerId:%s, address:%s, origin:%s]',
			buildingId, roomId, peerId, info.socket.remoteAddress, info.origin);

		// Serialize this code into the queue to avoid that two peers connecting at
		// the same time with the same roomId create two separate rooms with same
		// roomId.
		queue.push(async () =>
		{
			Building.findOne({ _id: buildingId },(err,build) => {
				if(err){
					const error = new Error(`building with id "${buildingId}" not found`);
					error.status = 404;
					throw error;
				}else{
					if(build.roomIds.indexOf(roomId) == -1){
						build.roomIds.push(roomId);
						build.save();
					}
				}
			})

			const room = await getOrCreateRoom({ roomId });

			// Accept the protoo WebSocket connection.
			const protooWebSocketTransport = accept();

			room.handleProtooConnection({ peerId, protooWebSocketTransport });
		})
			.catch((error) =>
			{
				logger.error('room creation or room joining failed:%o', error);

				reject(error);
			});
	});
}

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker()
{
	const worker = mediasoupWorkers[nextMediasoupWorkerIdx];

	if (++nextMediasoupWorkerIdx === mediasoupWorkers.length)
		nextMediasoupWorkerIdx = 0;

	return worker;
}

/**
 * Get a Room instance (or create one if it does not exist).
 */
async function getOrCreateRoom({ roomId })
{
	let room = rooms.get(roomId);

	// If the Room does not exist create a new one.
	if (!room)
	{
		logger.info('creating a new Room [roomId:%s]', roomId);

		const mediasoupWorker = getMediasoupWorker();

		room = await Room.create({ mediasoupWorker, roomId });

		rooms.set(roomId, room);
		room.on('close', () => {
			rooms.delete(roomId);
		});
	}

	return room;
}


/**
 * create room schema {
 * building id,
 * list of users ( maybe i do this in building schema too)
 * }
 * ++
 * add in the close function line 728 room deletion in the list of rooms in the building
 */