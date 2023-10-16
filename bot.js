//MUZAK

const {
	Client,
	GatewayIntentBits,
	EmbedBuilder,
	SlashCommandBuilder,
	REST,
	Routes,
	ActivityType,
	PermissionsBitField
} = require('discord.js');
const {
	joinVoiceChannel,
	createAudioPlayer,
	createAudioResource,
	entersState,
	AudioPlayerStatus,
	VoiceConnectionStatus,
	AudioPlayerError
} = require('@discordjs/voice');
require('libsodium-wrappers');
require('dotenv').config();
const axios = require('axios');
const { Worker } = require("worker_threads");
const crypto = require('crypto');
const fs = require("fs");
const http = require('https');

const ytdl = require('ytdl-core');
global.AbortController = require("node-abort-controller").AbortController;

const SPAPI = require('./spotify-web-api');
const spotifyApi = new SPAPI({ clientId: process.env['SPOTIFY_ID'], clientSecret: process.env['SPOTIFY_SECRET'] });

function checksumFile(hashName, path) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash(hashName);
		const stream = fs.createReadStream(path);
		stream.on('error', err => reject(err));
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

let audioFormats = {
	'258': {
		container: "mp4",
		codec: "aac-lc",
		bitrate: "384",
		channels: "5.1"
	},
	'251': {
		container: "webm",
		codec: "opus",
		bitrate: "160-vbr",
		channels: "2"
	},
	'256': {
		container: "mp4",
		codec: "aac-he_v1",
		bitrate: "192",
		channels: "5.1"
	},
	'140': {
		container: "mp4",
		codec: "aac-lc",
		bitrate: "128",
		channels: "2"
	},
	'250': {
		container: "webm",
		codec: "opus",
		bitrate: "70-vbr",
		channels: "2"
	},
	'249': {
		container: "webm",
		codec: "opus",
		bitrate: "50-vbr",
		channels: "2"
	},
	'139': {
		container: "mp4",
		codec: "aac-he_v1",
		bitrate: "48",
		channels: "2"
	},
	'600': {
		container: "webm",
		codec: "opus",
		bitrate: "35-vbr",
		channels: "2"
	},
	'599': {
		container: "mp4",
		codec: "aac-he_v1",
		bitrate: "32",
		channels: "2"
	},
};

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates
	]
});

let upSince = Date.now();
let songsPlayed = 0;
let playedSongs = [];

let spApiToken = "";
const TOKEN = process.env.TOKEN;

function handleErr(err) {
	console.log("ERR " + err.toString());
	return;
}

getNewAccessToken();
function getNewAccessToken() {
	spotifyApi.clientCredentialsGrant().then(
		function (data) {
			spApiToken = data.body['access_token'];
			spotifyApi.setAccessToken(data.body['access_token']);
			setTimeout(function () {
				getNewAccessToken();
			}, (parseInt(data.body['expires_in']) - 60) * 1000);
		},
		function (err) {
			handleErr(err);
		}
	);
}

const channels = new Map();
const connections = new Map();
const players = new Map();
const queues = new Map();
const pausedQueues = new Map();

function msToMS(millis) {
	var minutes = Math.floor(millis / 60000);
	var seconds = ((millis % 60000) / 1000).toFixed(0);
	return seconds == 60
		? minutes + 1 + ':00'
		: minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

async function joinVC(voiceChannel) {
	if (!connections.has(voiceChannel.guild.id)) {
		//create connection
		console.log(`[VC   ] joining vc ${voiceChannel.id} in guild ${voiceChannel.guild.id}`);
		const conn = joinVoiceChannel({
			channelId: voiceChannel.id,
			guildId: voiceChannel.guild.id,
			adapterCreator: voiceChannel.guild.voiceAdapterCreator
		});
		conn.on('stateChange', (oldState, newState) => {
			if (oldState.status === VoiceConnectionStatus.Ready && newState.status === VoiceConnectionStatus.Connecting) {
				conn.configureNetworking();
			} 
			if (newState.status === VoiceConnectionStatus.Signalling) {
				console.log("connection is signalling");
				conn.configureNetworking();
			}
		});
		conn.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
			try {
				await Promise.race([
					entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
					entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
				]);
				conn.configureNetworking();
			} catch (error) {
				console.log(`[VC   ] kicked from vc ${voiceChannel.id} in guild ${voiceChannel.guild.id}`);
				stopPlaying(conn, voiceChannel.guild.id, true);
			}
		});
		conn.on("error", (e) => {
			handleErr(e);
		});
		await entersState(conn, VoiceConnectionStatus.Ready, 30e3);
		connections.set(voiceChannel.guild.id, conn);

		//create player for connection
		const player = createAudioPlayer();
		player.on('error', (e) => {
			handleErr(e);
		});
		player.on(AudioPlayerStatus.Buffering, () => { });
		player.on(AudioPlayerStatus.Playing, () => { });
		player.on(AudioPlayerStatus.Idle, f => { });
		players.set(voiceChannel.guild.id, player);

		//subscribe connection to player
		conn.subscribe(player);

		channels.set(voiceChannel.guild.id, voiceChannel);

		return conn;
	} else {
		return connections.get(voiceChannel.guild.id);
	}
}
function createAudio(song) {
	return new Promise((res, rej) => {
		if (song.source == "youtube") {
			if (song.url.startsWith('https') && ytdl.validateURL(song.url)) {
				ytdl.getBasicInfo(song.url).then((info) => {
					let format = ['258', '251', '256', '140', '250', '249', '139', '600', '599'].filter(value => info.formats.map((format) => { return format.itag.toString(); }).includes(value))[0];
					console.log(`[YTDL ] creating ytdl instance for ${song.url}, quality ${format} (${audioFormats[format].codec}@${audioFormats[format].bitrate.includes("vbr") ? "~" : ""}${audioFormats[format].bitrate.split("-")[0]}kbps in ${audioFormats[format].container})`);
					let ytdlInst = ytdl(song.url, { quality: format, highWaterMark: 1 << 25 }).on("error", (e) => { return false; });
					let dlProg = [0, 0];
					ytdlInst.on('response', (res) => { dlProg[0] = res.headers['content-length']; });
					ytdlInst.on('progress', (progress) => { dlProg[1] += progress; if (dlProg[1] / dlProg[0] == 1) { console.log(`[YTDL ] fully buffered from youtube (size ${Math.round(dlProg[0] / 1000 / 1000, 2)}MB)`); } });
					res(createAudioResource(ytdlInst));
				}).catch((err) => {
					handleErr(err);
				});
			}
		} else if (song.source == "web") {
			http.get(song.url, function (_res) {
				res(createAudioResource(_res));
			});
		} else {
			rej("unknown source");
		}
	});
}

async function playSongToGuild(song, guildId) {
	try {
		if (song == undefined) return;

		console.log(`[QUEUE] playing ${song.title} to server ${guildId}`);
		songsPlayed++;
		playedSongs.push(song);

		const player = players.get(guildId);
		let playingEmbed;
		try {
			playingEmbed = await song.action.channel.send({ embeds: [new EmbedBuilder().setColor(0x0000FF).addFields([{ name: `🎵  Now Playing:`, value: `**Title**: ${song.title}\n**Uploader:** ${song.uploader}\n**Requested By:** ${song.action.user.username}#${song.action.user.discriminator}` }]).setThumbnail(song.thumb)] });
		} catch (e) {
			console.log(`[SYS  ] error in sending song play message in guild ${guildId}`);
			playingEmbed = false;
		}
		createAudio(song).then((songAudio) => {
			if (!songAudio) {
				if (playingEmbed) playingEmbed.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("⛔ Song is not available!")] }).then(() => {
					advanceQueue(guildId, true, true);
					return;
				});
			}

			player.play(songAudio);
			songAudio.playStream.on('end', end => {
				setTimeout(() => {
					advanceQueue(guildId, true, true);
				}, 250);
			});
		});
	} catch (e) {
		console.error(e);
	}
}

async function stopPlaying(connection, guildId, force = false) {
	const player = players.get(guildId);
	if (player) {
		player.stop(force);
	}

	if (connection) {
		connection.destroy();
	}

	players.delete(guildId);
	connections.delete(guildId);
	channels.delete(guildId);
	queues.delete(guildId);
	pausedQueues.delete(guildId);

	return true;
}

async function pauseQueue(interaction, guildId) {
	const player = players.get(guildId);
	if (player) player.pause();
	pausedQueues.set(guildId, {
		timePaused: Date.now(),
		interaction: interaction
	});
}

async function pauseCmd(interaction, guildId) {
	await pauseQueue(interaction, guildId);
	await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('⏸️ Paused!').setDescription("Queues can be paused for 3 hours before being removed to save bandwidth.")] });
}

async function unpauseCmd(interaction, guildId) {
	const player = players.get(guildId);
	if (player) player.unpause();
	pausedQueues.delete(guildId);
	await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x0000FF).setTitle('▶️ Playing!')] });
}

async function queueCmd(interaction, guildId) {
	var serverQueue = queues.get(guildId);
	if (!serverQueue || serverQueue.length == 0) {
		await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x0000FF).setTitle('🔇 Queue is empty!')] });
	} else {
		let queueEmbed = new EmbedBuilder().setColor(0x0000FF).setTitle('Current Queue');
		serverQueue.some((song, index) => {
			let playerResource = players.get(guildId)._state.resource;
			queueEmbed.addFields({ name: `${index + 1}: **${song.title}**`, value: `    ${song.uploader} - ` + (index == 0 ? `*Now Playing: * \`${(playerResource ? msToMS(playerResource.playbackDuration) : "0:00")}\` / ` : ``) + `\`${msToMS(song.length)}\``, inline: false });
			if (index > 8) { queueEmbed.addFields({ name: `\u200B`, value: `${serverQueue.length - index - 1} songs not shown`, inline: false }); return true; }
			return false;
		});
		await interaction.editReply({ embeds: [queueEmbed] });
	}
}

async function skipCmd(interaction, guildId) {
	var serverQueue = queues.get(guildId);
	if (!serverQueue || serverQueue.length < 2) {
		await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🔇 There are no more songs in the queue!')] });
		console.log("[VC   ] skip command invoked with no more songs in queue, leaving vc in " + guildId);
		stopPlaying(connections.get(guildId), guildId);
		return;
	}
	await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle(`⏭️ Skipped song!`)] });
	advanceQueue(guildId, true, true);
}

async function stopCmd(interaction, guildId) {
	console.log("[VC   ] stop command invoked, leaving vc");
	await stopPlaying(connections.get(guildId), guildId);
	await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🔇 Stopped playing!')] });
}

async function clearqueueCmd(interaction, guildId) {
	if (queues.get(guildId) && queues.get(guildId).length > 0) queues.set(guildId, [queues.get(guildId)[0]]);
	else queues.set(guildId, []);
	await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🧹 Queue cleared!')] });
}

async function advanceQueue(guildId, force, shiftQ) {
	var serverQueue = queues.get(guildId);
	var connection = connections.get(guildId);
	var player = players.get(guildId);

	if (shiftQ) {
		serverQueue.shift();
	}

	if (serverQueue.length < 1) {
		console.log("[VC   ] queue empty, leaving vc in " + guildId);
		stopPlaying(connection, guildId);
	}

	if (player._state.status == 'idle' || force) {
		playSongToGuild(serverQueue[0], guildId);
	}
}

function processPlayCmd(url, spApiToken) {
	return new Promise((resolve, reject) => {
		const worker = new Worker("./processPlayCmd.js", { workerData: { url, spApiToken } });
		worker.on("message", resolve);
		worker.on("error", reject);
		worker.on("exit", (code) => { if (code !== 0) { reject(new Error(`stopped with exit code ${code}`)); } });
	});
}

async function playCmd(interaction, guildId) {
	const voiceChannel = interaction.member.voice.channel;
	if (!voiceChannel) { await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🔇 You need to be in a voice channel to play music!')] }); return; }
	const permissions = voiceChannel.permissionsFor(interaction.client.user);
	if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) { await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("🔇 I don't have permission to join and speak in the voice channel you're in!")] }); return; }

	let url = interaction.options.get('url-search').value;

	const maxQueueLen = 30;
	let serverQueue = queues.get(guildId);
	if (!serverQueue) serverQueue = [];
	if (serverQueue.length > maxQueueLen - 1) {
		interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("⛔ Cannot add more songs").setDescription(`Max queue length is ${maxQueueLen}, please wait until some songs have played`)] });
		return;
	}

	console.log(`[QUEUE] processing input ${url} for server ${guildId}`);
	processPlayCmd(url, spApiToken).then((result) => {
		let tracks = result.result;
		if (tracks.results == false) {
			interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).addFields([{ name: `⛔ Could not import songs.`, value: (tracks.type == "playlist" ? `Is the playlist private?` : `Please make sure the video is available on youtube and try again later or report the bug in the support server.`) }])] });
			return;
		}

		tracks.results = tracks.results.map((track) => { track.action = interaction; return track; });
		serverQueue.push(...tracks.results);

		//console.log(serverQueue);

		if (tracks.type == "playlist") {
			interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00FF00).addFields([{ name: `🎶  Added playlist to queue!`, value: `Done${(serverQueue.length > maxQueueLen ? ` - Queue length was limited to ${maxQueueLen} songs` : "")}` }])] });
			console.log(`[QUEUE] added ${tracks.results.length} songs to queue for server ${guildId}`);
		} else {
			interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00FF00).addFields([{ name: `🎶  Added song to queue!`, value: `**Title**: ${tracks.results[0].title}\n**Uploader:** ${tracks.results[0].uploader}\n**Requested By:** ${tracks.results[0].action.user.username}#${tracks.results[0].action.user.discriminator}` }]).setThumbnail(tracks.results[0].thumb)] });
			console.log(`[QUEUE] added ${tracks.results[0].title} to the queue for server ${guildId}`);
		}

		if (serverQueue.length > maxQueueLen - 1) serverQueue.length = maxQueueLen;
		queues.set(guildId, serverQueue);

		joinVC(voiceChannel).then(() => {
			advanceQueue(guildId, false, false);
		});
	}).catch((err) => {
		console.log(err);
	});
}

const commands = [
	new SlashCommandBuilder().setName('help').setDescription('Displays the help message'),
	new SlashCommandBuilder()
		.setName('play')
		.setDescription('Plays a song')
		.addStringOption(option =>
			option
				.setName('url-search')
				.setDescription('Song URL / Search Query')
				.setRequired(true)
		),
	new SlashCommandBuilder()
		.setName('skip')
		.setDescription('Skip the current song'),
	new SlashCommandBuilder().setName('stop').setDescription('Stop all songs'),
	new SlashCommandBuilder().setName('queue').setDescription('List the queue'),
	new SlashCommandBuilder()
		.setName('clearqueue')
		.setDescription('Clear the queue, but finish the current song'),
	new SlashCommandBuilder().setName('np').setDescription('Alias of /queue'),
	new SlashCommandBuilder().setName('pause').setDescription('Pause the currently playing music'),
	new SlashCommandBuilder().setName('unpause').setDescription('Unpause music, if paused')
];
const test_commands = [
	new SlashCommandBuilder().setName("sp").setDescription("get list of songs played"),
	new SlashCommandBuilder().setName("npa").setDescription("get list of queues currently being played"),
	new SlashCommandBuilder().setName("servers").setDescription("get list of servers joined to")
];

function updateStats(listNames = false) {
	var stats = [0, 0];
	client.guilds.cache.forEach(guild => {
		if (listNames) console.log(guild.name);
		stats[0] += guild.memberCount;
		stats[1]++;
	});

	client.user.setPresence({
		activities: [{ name: `${stats[1]} servers`, type: ActivityType.Watching }],
		status: 'online',
	});

	axios.post('https://manager.snadol.com/api', {
		type: "botsIn",
		auth: process.env.MANAGER_TOKEN,
		bot: "muzak",
		uid: client.user.id,
		members: stats[0],
		servers: stats[1],
		upsince: upSince,
		sp: songsPlayed
	}, { headers: { 'content-type': 'application/json' } })
		.then((res) => { })
		.catch((error) => {
			console.log(`[SYS  ] Failed to send stats to mananger: ${error}`);
		});
}


let restartRequired = false;
checksumFile("md5", "./bot.js").then((codeHash) => {
	setInterval(() => {
		checksumFile("md5", "./bot.js").then((newCodeHash) => {
			if (codeHash != newCodeHash || restartRequired) {
				if (Array.from(queues.values()).map((queue) => { return queue.length; }).reduce((partialSum, a) => partialSum + a, 0) == 0) {
					console.log("[SYS  ] restarting (queues empty)");
					process.exit(0);
				} else { console.log("[SYS  ] restart needed, but queues not empty"); }
			}
		});
	}, 10000);
});
setInterval(() => {
	Array.from(pausedQueues.entries()).forEach(([guildId, paused]) => {
		if ((Date.now() - paused.timePaused) / 1000 > 10800) {
			console.log(`[VC   ] left ${guildId} due to inactivity`);
			stopPlaying(connections.get(guildId), guildId);
			pausedQueues.delete(guildId);
			paused.interaction.channel.send({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("🚶 Left due to inactivity").setDescription("This queue was paused for more than 3 hours, so I left to save bandwidth")] }).catch((e) => {
				console.log(`[SYS  ] no permission to send paused leave message in guild ${guildId}`);
			});
		}
	});
	Array.from(queues.entries()).forEach(([guildId, queue]) => {
		if (!pausedQueues.has(guildId)) {
			let channel = channels.get(guildId);
			if (channel && channel.members.size - 1 == 0) {
				console.log(`[VC   ] no one is listening in ${guildId}, left`);
				stopPlaying(connections.get(guildId), guildId);
				queue[0].action.channel.send({ embeds: [new EmbedBuilder().setTitle("🚶 Left due to inactivity").setDescription("There are no listeners in this channel, so I left to save bandwidth")] }).catch((e) => {
					console.log(`[SYS  ] no permission to send no listeners leave message in guild ${guildId}`);
				});
			}
		}
	});
}, 30000);
setInterval(updateStats, 120 * 1000);

client.once('ready', () => {
	console.log('[SYS  ] Ready!');
	updateStats(false);
	const CLIENT_ID = client.user.id;
	const rest = new REST({ version: '9' }).setToken(TOKEN)
		; (async () => {
			try {
				await rest.put(Routes.applicationCommands(CLIENT_ID), {
					body: commands
				});
				await rest.put(Routes.applicationGuildCommands(CLIENT_ID, "929881324167254106"), {
					body: test_commands
				});
			} catch (error) {
				if (error) console.error(error);
			}
		})();
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
	console.log('[SYS  ] Caught interrupt signal, cleaning up');
	Promise.all(Array.from(connections).map(([guildId, connection]) => {
		return stopPlaying(connection, guildId, true);
	})).then(() => {
		console.log('[SYS  ] Left all VCs, shutting down.');
		process.exit();
	});
}

async function helpCmd(interaction, guildId) {
	await interaction.editReply({
		embeds: [
			new EmbedBuilder().setColor(0x0000FF).setTitle("ℹ️ **Muzak Help**").setDescription("Muzak is a paywall and votewall free Discord music bot.").addFields(
				{ name: '/help', value: 'shows this message' },
				{ name: '/play', value: 'plays a song or playlist. supported inputs: youtube video link, spotify track/playlist link, or search text' },
				{ name: '/queue', value: 'shows the currently playing song and the next in the queue' },
				{ name: '/np', value: 'alias of /queue' },
				{ name: '/clearqueue', value: 'clears the queue of all upcoming songs' },
				{ name: '/stop', value: 'stops playing, leaves vc, and clears the queue' },
				{ name: '/skip', value: 'skips the current song' },
				{ name: '/pause', value: 'pauses the music' },
				{ name: '/unpause', value: 'unpauses the music' },
			)
		]
	});
}
async function spCmd(interaction, guildId) {
	JSON.stringify(playedSongs.map((song) => { return song.title; })).match(/.{1,2000}/g).forEach((playedSegment) => {
		interaction.followUp({ content: playedSegment });
	});
}
async function npaCmd(interaction, guildId) {
	if (Array.from(queues.keys()).length == 0) {
		interaction.editReply({ content: "Nothing playing!" });
	} else {
		Array.from(queues.keys()).forEach((guildId) => {
			if (queues.get(guildId).length > 0) {
				let player = players.get(guildId);
				let conn = connections.get(guildId);

				let songs = Array.from(queues.get(guildId)).map((song) => { return `\`${msToMS(song.length)}\` ${song.title}`; });
				songs[0] = `\`${msToMS(player._state.resource ? player._state.resource.playbackDuration : 0)}\` / ` + songs[0];
				let resp = `${guildId} - ${(pausedQueues.has(guildId) ? "⏸️" : "▶️")} (${channels.get(guildId).members.size - 1} listeners) [player status: ${player.state.status}, connection status: ${conn._state.status}]\n${songs.join("\n")}`;
				interaction.followUp({ content: (resp.length < 2000 ? resp : resp.substring(0, 1996) + " ...") });
			}
		});
	}
}
async function serversCmd(interaction, guildId) {
	let stats = [0, 0];
	[...client.guilds.cache.map((guild) => {
		stats[0]++;
		stats[1] += guild.memberCount;
		return `${guild.name} (${guild.id}): ${guild.memberCount} members`;
	}), `Total: ${stats[0]} servers, ${stats[1]} members`].join("\n").match(/(.|\n){1,2000}/g).forEach((server) => {
		interaction.followUp({ content: server });
	});
}

client.on('interactionCreate', async interaction => {
	if (!interaction || !interaction.isCommand()) return;

	try {
		await interaction.deferReply();

		const command = interaction.commandName;
		if (!command) return;

		if (command == 'play') await playCmd(interaction, interaction.guildId);
		if (command == 'stop') await stopCmd(interaction, interaction.guildId);
		if (command == 'skip') await skipCmd(interaction, interaction.guildId);
		if (command == 'queue') await queueCmd(interaction, interaction.guildId);
		if (command == 'clearqueue') await clearqueueCmd(interaction, interaction.guildId);
		if (command == 'np') await queueCmd(interaction, interaction.guildId);
		if (command == 'help') await helpCmd(interaction, interaction.guildId);
		if (command == 'pause') await pauseCmd(interaction, interaction.guildId);
		if (command == 'unpause') await unpauseCmd(interaction, interaction.guildId);

		if (command == "sp") await spCmd(interaction, interaction.guildId);
		if (command == "npa") await npaCmd(interaction, interaction.guildId);
		if (command == "servers") await serversCmd(interaction, interaction.guildId);
	} catch (error) {
		if (error) console.error(error);
	}
});

process.on("unhandledRejection", (error) => {
	console.log("UNHANDLED REJECTION", error);
});
process.on("unhandledException", (error) => {
	console.log("UNHANDLED EXCEPTION", error);
	//process.exit(1);
});

client.login(TOKEN);
