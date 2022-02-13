require('dotenv').config()
const { 
	Client, 
	Intents, 
	MessageEmbed
} = 								require('discord.js');
const { 
	joinVoiceChannel, 
	createAudioPlayer, 
	createAudioResource, 
	entersState, 
	AudioPlayerStatus, 
	VoiceConnectionStatus
} = 								require('@discordjs/voice');
const { SlashCommandBuilder } = 	require('@discordjs/builders');
const { REST } = 					require('@discordjs/rest');
const { Routes } = 					require('discord-api-types/v9');
const ytdl = 						require("ytdl-core");
const spdl = 						require("spdl-core");
const youtubesearchapi = 			require('youtube-search-api');
const SpotifyWebApi = 				require('spotify-web-api-node');
const spotifyUri = 					require('spotify-uri');
const SpotifyToYoutube = 			require('spotify-to-youtube');

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MEMBERS, Intents.FLAGS.GUILD_VOICE_STATES] });

const TOKEN = process.env['TOKEN'];
const TEST_GUILD_ID = process.env['TEST_GUILD_ID'];

const spotifyApi = new SpotifyWebApi({
	clientId: process.env['SPOTIFY_ID'],
	clientSecret: process.env['SPOTIFY_SECRET']
});
getNewAccessToken();
const spotifyToYoutube = SpotifyToYoutube(spotifyApi)

const usersearches 	= new Map();
const connections 	= new Map();
const players 		= new Map();
const queues 		= new Map();

function splitToBulks(arr, bulkSize = 20) {
    const bulks = [];
    for (let i = 0; i < Math.ceil(arr.length / bulkSize); i++) {
        bulks.push(arr.slice(i * bulkSize, (i + 1) * bulkSize));
    }
    return bulks;
}

function getNewAccessToken() {
	spotifyApi.clientCredentialsGrant().then(
		function(data) {
			console.log('SPOTIFY TOKEN EXPIRY: ' + data.body['expires_in'] + 's');
			spotifyApi.setAccessToken(data.body['access_token']);
			setTimeout(function(){getNewAccessToken()}, (parseInt(data.body['expires_in']) - 60) * 1000)
		},
		function(err) {
			console.log('Something went wrong when retrieving an access token', err.message);
		}
	);
}

async function joinVC(voiceChannel) {
	if (!(connections.has(voiceChannel.guild.id))) {
		const conn = joinVoiceChannel({
			channelId: voiceChannel.id,
			guildId: voiceChannel.guild.id,
			adapterCreator: voiceChannel.guild.voiceAdapterCreator
		});
		
		await entersState(conn, VoiceConnectionStatus.Ready, 30e3);
		
		connections.set(voiceChannel.guild.id, conn);
		
		const player = createAudioPlayer();
		player.on("error", console.error);

		/* NOW IN playSongToConnection FUNCTION
		player.on(AudioPlayerStatus.Idle, (f) => {
			if (f.status == "playing" && f.playbackDuration > f.resource.playbackDuration) {
				console.log("Song over, Advancing queue...")
				setTimeout(() => {
					advanceQueue(voiceChannel.guild.id, true, true);
				}, 250);
			}
		});
		*/

		conn.subscribe(player);
		players.set(voiceChannel.guild.id, player)
		
		return conn;
	} else {
		return connections.get(voiceChannel.guild.id);
	}
}

async function createAudio(url) {
	try {
		var res = undefined;
		if (ytdl.validateURL(url)) {
			res = await createAudioResource(await ytdl(url, { highWaterMark: 8000000, filter: 'audio', quality: 'lowestaudio' }));
		}
	} catch (e) {
		console.error(e);
	}
	return res;
}

async function playSongToConnection(connection, song, guildId) {
	try {
		if (song == undefined) {
			return;
		}

		console.log(`Playing ${song.title}`)
		const player = players.get(guildId);

		const embed = new MessageEmbed().addField(`🎵  Now Playing:`, `**Title**: ${song.title}\n**Author:** ${song.uploader}\n**Requested By:** ${song.action.user.username}#${song.action.user.discriminator}`, false).setThumbnail(song.thumb);
		await song.action.followUp({ embeds: [ embed ] });

		const result = await createAudio(song.url);
		player.play(result);

		result.playStream.on("end", (end) => {
			setTimeout(() => {
				advanceQueue(guildId, true, true);
			}, 250);
		});
	} catch (e) {
		console.error(e);
	}
}

async function stopPlaying(connection, guildId) {
	const player = players.get(guildId);
	if (player) {
		player.stop();
	}
	players.delete(guildId)
	
	if (connection) {
		connection.destroy();
	}
	connections.delete(guildId)

	await clearQueue(guildId);
	return true;
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function clearQueue(guildId) {
	var serverQueue = queues.get(guildId);
	serverQueue.length = 0;
	return true;
}

async function clearqueueCmd(interaction, guildId) {
	const connection = connections.get(guildId);
	await stopPlaying(connection, guildId);
	await interaction.editReply({ content: "Queue cleared!" });
}

async function queueCmd(interaction, guildId) {
	var serverQueue = queues.get(guildId);
	var queueMsg = "";

	if (!serverQueue || serverQueue.length == 0) {
		queueMsg += "\nQueue Empty!";
	} else {
		queueMsg = "Current Queue:";
	}

	for (s in serverQueue) {
		queueMsg += `\n${parseInt(s)+1}: \`${serverQueue[s].title}\` by \`${serverQueue[s].uploader}\``
		if (s == 0) {
			queueMsg += " <-- Now Playing";
		}
		if (s > 10) {
			queueMsg += `\nPlus ${serverQueue.length - s} more...`;
			break;
		}
	}

	await interaction.editReply({ content: queueMsg });
}

async function skipCmd(interaction, guildId) {
	var serverQueue = queues.get(guildId);
	if (!serverQueue || serverQueue.length < 2) {
		const embed = new MessageEmbed().setTitle('🔇 There are no more songs in the queue!');
		const messageId = await interaction.editReply({ embeds: [ embed ] });

		stopPlaying(connections.get(guildId), guildId)
		return;
	}

	const embed = new MessageEmbed().setTitle(`⏭️ Skipped song!`);
	await interaction.editReply({ embeds: [ embed ] });

	advanceQueue(guildId, true, true);
}

async function stopCmd(interaction, guildId) {
	const conn = connections.get(guildId)
	await stopPlaying(conn, guildId)

	const embed = new MessageEmbed().setTitle('🔇 Stopped playing!');
	const messageId = await interaction.editReply({ embeds: [ embed ] });
}

async function advanceQueue(guildId, force, shiftQ) {
	var serverQueue = queues.get(guildId);
	var connection = connections.get(guildId);
	var player = players.get(guildId);

	if (shiftQ) {
		serverQueue.shift();
	}

	if (serverQueue.length < 1) {
		stopPlaying(connection, guildId)
	}

	if (player._state.status == "idle" || force) {
		playSongToConnection(connection, serverQueue[0], guildId);
	}
}

/*
async function playsearchCmd(interaction, guildId) {		
	const voiceChannel = interaction.member.voice.channel;		
	if (!voiceChannel) {
		const embed = new MessageEmbed().setTitle('🔇 You need to be in a voice channel to play music!');
		const messageId = await interaction.editReply({ embeds: [ embed ] });
		return;
	}

	const search = usersearches.get(interaction.userId)
	if (search == undefined) {
		const embed = new MessageEmbed().setTitle('🔇 Please search something before using this command!');
		const messageId = await interaction.editReply({ embeds: [ embed ] });
		return;
	}
	var serverQueue = queues.get(guildId);

	const num = parseInt(interaction.options.get("number").value) - 1;
	var vid = search[num]

	songInfo = await ytdl.getInfo(`https://www.youtube.com/watch?v=${vid.id}`);
	song = {
		title: songInfo.videoDetails.title,
		url: songInfo.videoDetails.video_url,
		uploader: songInfo.videoDetails.author.name,
		action: interaction,
		thumb: songInfo.videoDetails.thumbnails[songInfo.videoDetails.thumbnails.length - 1].url
	};

	if (!serverQueue) {
		serverQueue = []
	}
	serverQueue.push(song);
	queues.set(guildId, serverQueue)
	
	const embed = new MessageEmbed().addField(`🎶  Added song to queue!`, `**Title**: ${song.title}\n**Author:** ${song.uploader}\n**Requested By:** ${song.action.user.username}#${song.action.user.discriminator}`, false).setThumbnail(song.thumb);
	await interaction.editReply({ embeds: [ embed ] });
	
	const conn = await joinVC(voiceChannel);
	await advanceQueue(guildId, false, false)
	
	delete usersearches[interaction.userId];
}
*/

async function playCmd(interaction, guildId) {
	var url = interaction.options.get("url-search").value;
	var serverQueue = queues.get(guildId);
	const voiceChannel = interaction.member.voice.channel;		
	if (!voiceChannel) {
		const embed = new MessageEmbed().setTitle('🔇 You need to be in a voice channel to play music!');
		const messageId = await interaction.editReply({ embeds: [ embed ] });
		return;
	}
	
	const permissions = voiceChannel.permissionsFor(interaction.client.user);
	if (!permissions.has("CONNECT") || !permissions.has("SPEAK")) {
		const embed = new MessageEmbed().setTitle('🔇 I need the permissions to join and speak in the voice channel you\'re in!');
		const messageId = await interaction.editReply({ embeds: [ embed ] });
		return;
	}

	var songInfo = undefined;
	var song = undefined;

	var spotifyPlaylist = true;

	if (!serverQueue) {
		serverQueue = []
	}

	try {
		if (ytdl.validateURL(url)) {
			spotifyPlaylist = false;
			songInfo = await ytdl.getInfo(url);
			song = {
				title: songInfo.videoDetails.title,
				url: songInfo.videoDetails.video_url,
				uploader: songInfo.videoDetails.author.name,
				action: interaction,
				thumb: songInfo.videoDetails.thumbnails[songInfo.videoDetails.thumbnails.length - 1].url
			};
		} else if (spdl.validateURL(url, 'track')) {
			spotifyPlaylist = false;		
			
			var parsed = spotifyUri.parse(url);
			const id = await spotifyToYoutube(parsed.id);
	
			songInfo = await ytdl.getInfo(`https://www.youtube.com/watch?v=${id}`);
			newSong = {
				title: songInfo.videoDetails.title,
				url: songInfo.videoDetails.video_url,
				uploader: songInfo.videoDetails.author.name,
				action: interaction,
				thumb: songInfo.videoDetails.thumbnails[songInfo.videoDetails.thumbnails.length - 1].url
			};
	
			song = newSong;
		} else if (spdl.validateURL(url, 'playlist')) {
			embed = new MessageEmbed().addField(`Importing songs from playlist`, `This might take a while...`, false);
			interaction.editReply({ embeds: [ embed ] })

			var parsed = spotifyUri.parse(url);

			try {
				var data = await spotifyApi.getPlaylist(parsed.id);
			} catch (WebapiRegularError) {
				embed = new MessageEmbed().addField(`Could not import playlist.`, `**Is the playlist private?**`, false);
				interaction.editReply({ embeds: [ embed ] })
			}

			var sArr = [];
			var songArr = [];
			data.body.tracks.items.forEach((data) => sArr.push(data.track.id));

			var arrs = splitToBulks(sArr, 50);
			sArr = arrs[0];
	
			spotifyToYoutube(sArr).then(data => {
				for(var d in data) {
					ytdl.getInfo(`https://www.youtube.com/watch?v=${data[d]}`).then(songInfo => {
						newSong = {
							title: songInfo.videoDetails.title,
							url: songInfo.videoDetails.video_url,
							uploader: songInfo.videoDetails.author.name,
							action: interaction,
							thumb: songInfo.videoDetails.thumbnails[songInfo.videoDetails.thumbnails.length - 1].url
						};
						songArr.push(newSong);
					})
				}
				const interval = setInterval(function() {
					if (sArr.length != songArr.length) {} else {
						clearInterval(interval);
						ret = {
							playlist: true,
							song: songArr
						}

						embed = new MessageEmbed().addField(`🎶  Added playlist to queue!`, `Done`, false);
						
						songArr.forEach(s => {
							serverQueue.push(s);
						})
						queues.set(guildId, serverQueue)
						
						interaction.editReply({ embeds: [ embed ] }).then(function() {
							joinVC(voiceChannel).then(function() {
								advanceQueue(guildId, false, false);
							});
						});
					}
				}, 500);
			});
		} else {
			await interaction.editReply({ content: `Searching YouTube for ${url}...` });
			
			var videos = await youtubesearchapi.GetListByKeyword(url, false);
			videos = videos.items.slice(0, 7)

			//usersearches.set(interaction.userId, videos)

			//var vidstr = "";
			//for (v in videos) {
			//	vidstr += `\n${parseInt(v)+1}: ${videos[v].title}`;
			//}

			//await interaction.editReply({ content: `${vidstr}\n**Please use /playsearch <number> to play a video in this list.**` });
			//return;
			spotifyPlaylist = false;
			songInfo = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videos[0].id}`);
			song = {
				title: songInfo.videoDetails.title,
				url: songInfo.videoDetails.video_url,
				uploader: songInfo.videoDetails.author.name,
				action: interaction,
				thumb: songInfo.videoDetails.thumbnails[songInfo.videoDetails.thumbnails.length - 1].url
			};
		}
	} catch (e) {
		const embed = new MessageEmbed().setTitle('🔇 Error locating song!');
		const messageId = await interaction.editReply({ embeds: [ embed ] });
		console.log(e)
		return;
	}
	
	var embed;
	if (spotifyPlaylist) {} else {
		embed = new MessageEmbed().addField(`🎶  Added song to queue!`, `**Title**: ${song.title}\n**Author:** ${song.uploader}\n**Requested By:** ${song.action.user.username}#${song.action.user.discriminator}`, false).setThumbnail(song.thumb);
	
		serverQueue.push(song);
		queues.set(guildId, serverQueue)
		
		await interaction.editReply({ embeds: [ embed ] });

		await joinVC(voiceChannel);
		await advanceQueue(guildId, false, false)
	}
}

const commands = [
	new SlashCommandBuilder().setName('play').setDescription('Plays a song')
		.addStringOption(option => option.setName('url-search').setDescription('Song URL / Search Query').setRequired(true)),
	//new SlashCommandBuilder().setName('playsearch').setDescription('Plays a song from search results')
	//	.addStringOption(option => option.setName('number').setDescription('Song number (in search list)').setRequired(true)),
	new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
	new SlashCommandBuilder().setName('stop').setDescription('Stop all songs'),
	new SlashCommandBuilder().setName('queue').setDescription('List the queue'),
	new SlashCommandBuilder().setName('clearqueue').setDescription('Clear the queue')
];

setInterval(() => {
	var stats = [0, 0];

	client.guilds.cache.forEach(guild => {
		stats[0] += guild.memberCount;
		stats[1]++;
	})

	console.log(`In ${stats[1]} servers with a total of ${stats[0]} members.`)
	client.user.setActivity(`${stats[1]} servers | ${stats[0]} members`, {"type": "WATCHING"});
}, 5000);

client.once('ready', () => {
    console.log('Ready!');
    const CLIENT_ID = client.user.id;
    const rest = new REST({ version: '9'}).setToken(TOKEN);
    (async () => {
        try {
            if (!TEST_GUILD_ID) {
                await rest.put(
                    Routes.applicationCommands(CLIENT_ID), {
                        body: commands
                    },
                );
                console.log('Successfully registered application commands globally');
            } else {
                await rest.put(
                    Routes.applicationGuildCommands(CLIENT_ID, TEST_GUILD_ID), {
                        body: commands
                    },
                );
                console.log('Successfully registered application commands for development guild');
            }
        } catch (error) {
            if (error) console.error(error);
        }
    })();
});

process.on('SIGINT', function() {
    console.log("Caught interrupt signal, cleaning up");

	players.forEach((player, guildId, map) => {
		if (player) {
			player.stop();
		}
		players.delete(guildId)
		
		var connection = connections.get(guildId);
		if (connection) {
			connection.destroy();
		}
		connections.delete(guildId)

		clearQueue(guildId);
	})

	console.log("Left all VCs, shutting down.");
    process.exit();
});

client.on('interactionCreate', async interaction => {
	await interaction.deferReply();

    if (!interaction.isCommand()) return;
    const command = interaction.commandName;
    if (!command) return;
	
    try {
		if (command == 'play') {
			await playCmd(interaction, interaction.guildId);
		}
		if (command == 'stop') {
			await stopCmd(interaction, interaction.guildId);
		}
		if (command == 'skip') {
			await skipCmd(interaction, interaction.guildId);
		}
		if (command == 'queue') {
			await queueCmd(interaction, interaction.guildId);
		}
		if (command == 'clearqueue') {
			await clearqueueCmd(interaction, interaction.guildId);
		}
		//if (command == 'playsearch') {
		//	await playsearchCmd(interaction, interaction.guildId);
		//}
    } catch (error) {
        if (error) console.error(error);
    }
});

client.login(TOKEN);
