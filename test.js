const fs = require('fs');
const ytdl = require('ytdl-core');

let videoID = "tfSS1e3kYeo";

ytdl.getInfo(videoID).then((info) => {
	let format = ytdl.chooseFormat(info.formats, { quality: '140' });
	console.log('Format found!', format);
});

//ytdl()
