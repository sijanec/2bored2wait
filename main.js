
// imports
const mc = require('minecraft-protocol'); // to handle minecraft login session
const webserver = require('./webserver.js'); // to serve the webserver
const opn = require('opn'); //to open a browser window
const secrets = require('./secrets.json'); // read the creds
const config = require('./config.json'); // read the config

webserver.createServer(config.ports.web); // create the webserver
webserver.password = config.password
webserver.onstart(() => { // set up actions for the webserver
	startQueuing();
});
webserver.onstop(() => {
	stop();
});

if (config.openBrowserOnStart) {
    opn('http://localhost:' + config.ports.web); //open a browser window
}


// lets
let proxyClient; // a reference to the client that is the actual minecraft game
let client; // the client to connect to 2b2t
let server; // the minecraft server to pass packets
let antiafkIntervalObj; // self explanatory
var chunk = [];
// function to disconnect from the server
function stop(){
	webserver.isInQueue = false;
	webserver.queuePlace = "None";
	webserver.ETA = "None";
	client.end(); // disconnect
	if (proxyClient) {
		proxyClient.end("Stopped the proxy."); // boot the player from the server
	}
	server.close(); // close the server
}

function sendAntiafkMessage(client) {
	filterPacketAndSend({ message: "{\"text\":\">\"}", position: 1 }, { name: "chat" }, client);
}

// function to start the whole thing
function startQueuing() {
	webserver.isInQueue = true;
	client = mc.createClient({ // connect to 2b2t
		host: config.debug.serverip,
		port: config.debug.serverport,
		username: secrets.username,
		password: secrets.password,
		version: config.MCversion
	});
	let finishedQueue = false;
	client.on("packet", (data, meta) => { // each time 2b2t sends a packet
		if (!finishedQueue && meta.name === "playerlist_header") { // if the packet contains the player list, we can use it to see our place in the queue
			let headermessage = JSON.parse(data.header);
			let positioninqueue = headermessage.text.split("\n")[5].substring(25);
			let ETA = headermessage.text.split("\n")[6].substring(27);
			webserver.queuePlace = positioninqueue; // update info on the web page
			webserver.ETA = ETA;
			server.motd = `Place in queue: ${positioninqueue}`; // set the MOTD because why not
		}
		if (meta.name === "map_chunk") {
			chunk.push([data, meta]);
		}
		if (finishedQueue === false && meta.name === "chat") { // we can know if we're about to finish the queue by reading the chat message
			// we need to know if we finished the queue otherwise we crash when we're done, because the queue info is no longer in packets the server sends us.
			let chatMessage = JSON.parse(data.message);
			if (chatMessage.text && chatMessage.text === "Connecting to the server...") {
                if (webserver.restartQueue && proxyClient == null) { // ifwe should restart
                    stop();
                    setTimeout(startQueuing, 100); // reconnect after 100 ms
                } else {
                    finishedQueue = true;
                    webserver.queuePlace = "FINISHED";
                    webserver.ETA = "NOW";  
                }
			}
		}

		if (proxyClient) { // if we are connected to the proxy, forward the packet we recieved to our game.
			filterPacketAndSend(data, meta, proxyClient);
			if(antiafkIntervalObj != null) {
				clearInterval(antiafkIntervalObj);
				antiafkIntervalObj = null;
			}
		}
		
		if (!proxyClient) {
			if(antiafkIntervalObj == null) {
			    antiafkIntervalObj = setInterval(sendAntiafkMessage, 50000, client);
			} // else timer already exists / is running. to prevent infinite timers being started...
		}
	});
	
	// set up actions in case we get disconnected.
	client.on('end', () => {
		if (proxyClient) {
            proxyClient.end("Connection reset by 2b2t server.\nReconnecting...");
            proxyClient = null
		}
		stop();
		setTimeout(startQueuing, 100); // reconnect after 100 ms
	});

	client.on('error', (err) => {
		if (proxyClient) {
            proxyClient.end(`Connection error by 2b2t server.\n Error message: ${err}\nReconnecting...`);
            proxyClient = null
		}
		console.log('err', err);
		stop();
		setTimeout(startQueuing, 100); // reconnect after 100 ms
	});

	server = mc.createServer({ // create a server for us to connect to
		'online-mode': false,
		encryption: true,
		host: config.debug.bindip,
		port: config.ports.minecraft,
		version: config.MCversion,
		'max-players': maxPlayers = 1
	});

	server.on('login', (newProxyClient) => { // handle login
		newProxyClient.write('login', {
			entityId: newProxyClient.id,
			levelType: 'default',
			gameMode: 0,
			dimension: 0,
			difficulty: 2,
			maxPlayers: server.maxPlayers,
			reducedDebugInfo: false
		});
		
		newProxyClient.write('position', {
			x: 0,
			y: 1.62,
			z: 0,
			yaw: 0,
			pitch: 0,
			flags: 0x00
		});
		
		
		newProxyClient.on('packet', (data, meta) => { // redirect everything we do to 2b2t (except internal commands)
			if (meta.name === "chat") {
				let chatMessage = data.message;
				if (chatMessage.startsWith("/2b2w")) {
					if (chatMessage.startsWith("/2b2w chunks")) {
						if(chunk.length >= 1) {
							chunk.forEach(function(element) {  
								filterPacketAndSend(element[0], element[1], newProxyClient);
								filterPacketAndSend({ message: "{\"text\":\"2b2w: okily-dokily\"}", position: 1 }, { name: "chat" }, proxyClient);
							});
						} else {
							filterPacketAndSend({ message: "{\"text\":\"2b2w: I have no chunks\"}", position: 1 }, { name: "chat" }, proxyClient);
						}
					} else if (chatMessage.startsWith("/2b2w forcefinishedqueue")) {
						finishedQueue = true;
						filterPacketAndSend({ message: "{\"text\":\"2b2w: done\"}", position: 1 }, { name: "chat" }, proxyClient);
					} else {
						filterPacketAndSend({ message: "{\"text\":\"2b2w commands: chunks, forcefinishedqueue\"}", position: 1 }, { name: "chat" }, proxyClient);
					}
				} else {
					filterPacketAndSend(data, meta, client);	
				}
			} else {
				filterPacketAndSend(data, meta, client);
			}
		});
		
		proxyClient = newProxyClient;
	});
}

//function to filter out some packets that would make us disconnect otherwise.
//this is where you could filter out packets with sign data to prevent chunk bans.
function filterPacketAndSend(data, meta, dest) {
	if (meta.name !="keep_alive" && meta.name !="update_time") { //keep alive packets are handled by the client we created, so if we were to forward them, the minecraft client would respond too and the server would kick us for responding twice.
		dest.write(meta.name, data);
	}
}
