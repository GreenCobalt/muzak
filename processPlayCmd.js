require('dotenv').config();
const { workerData, parentPort } = require("worker_threads");
const ytdl = require('ytdl-core');
const spdl = require('spdl-core');
const youtubesearchapi = require('./youtube-search-api');
const spotifyUri = require('spotify-uri');

const http = require('https');
const { getAudioDurationInSeconds } = require('get-audio-duration');
const { Readable } = require("stream");

const SPAPI = require('./spotify-web-api');
const spotifyApi = new SPAPI({ clientId: process.env['SPOTIFY_ID'], clientSecret: process.env['SPOTIFY_SECRET'] });
spotifyApi.setAccessToken(workerData.spApiToken);

function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (err) {
        return false;
    }
}

function spotifyToYoutube(query) {
    return new Promise((_res, _rej) => {
        if (!Array.isArray(query)) query = [query];
        spotifyApi.getTracks(query).then((spotifyTracks) => {
            Promise.all(spotifyTracks.body.tracks.map((spotifyTrack) => {
                return new Promise((res, rej) => {
                    youtubesearchapi.GetListByKeyword(`${spotifyTrack.name} ${spotifyTrack.artists[0].name}`, false).then((videos) => {
                        res(videos.items[0].id);
                    }).catch((err) => {
                        rej(err);
                    });
                });
            })).then((youtubeIDs) => {
                _res(youtubeIDs);
            }).catch((err) => {
                _rej(err);
            });
        }).catch((err) => {
            _rej(err);
        });
    });
}

function processPlayCmd(url) {
    return new Promise((res, rej) => {
        if (ytdl.validateURL(url)) {
            //YOUTUBE URL
            ytdl.getInfo(url).then((songInfo) => {
                res({
                    type: "track",
                    subtype: "youtube",
                    results: [
                        {
                            title: songInfo.videoDetails.title,
                            url: songInfo.videoDetails.video_url,
                            uploader: songInfo.videoDetails.author.name,
                            thumb: songInfo.videoDetails.thumbnails[songInfo.videoDetails.thumbnails.length - 1].url,
                            length: songInfo.videoDetails.lengthSeconds * 1000,
                            source: "youtube"
                        }
                    ]
                });
            }).catch((e) => {
                res({
                    type: "track",
                    subtype: "youtube",
                    results: false,
                    err: e
                });
            });
        } else if (spdl.validateURL(url, 'track')) {
            //SPOTIFY TRACK URL
            spotifyToYoutube(spotifyUri.parse(url).id).then((ytID) => {
                ytdl.getInfo(`https://www.youtube.com/watch?v=${ytID}`).then((songInfo) => {
                    res({
                        type: "track",
                        subtype: "spotify",
                        results: [
                            {
                                title: songInfo.videoDetails.title,
                                url: songInfo.videoDetails.video_url,
                                uploader: songInfo.videoDetails.author.name,
                                thumb: songInfo.videoDetails.thumbnails[songInfo.videoDetails.thumbnails.length - 1].url,
                                length: songInfo.videoDetails.lengthSeconds * 1000,
                                source: "youtube"
                            }
                        ]
                    });
                });
            }).catch((err) => {
                console.log(err);
            });
        } else if (spdl.validateURL(url, 'playlist')) {
            //SPOTIFY PLAYLIST URL
            spotifyApi.getPlaylist(spotifyUri.parse(url).id).then((data) => {
                let spotifyTracks = data.body.tracks.items.map((spotifyTrack) => { if (spotifyTrack.track) return spotifyTrack.track.id; else return null; }).filter((spotifyId) => { return spotifyId; }).slice(0, 50);
                if (spotifyTracks == false) {
                    res({
                        type: "playlist",
                        subtype: "spotify",
                        results: false,
                        err: new Error("playlistUnavailable")
                    });
                }

                spotifyToYoutube(spotifyTracks).then(youtubeTracks => {
                    Promise.all(youtubeTracks.map(ytID => ytdl.getInfo(ytID))).then((youtubeTrackInfo) => {
                        res({
                            type: "playlist",
                            subtype: "spotify",
                            results: youtubeTrackInfo.map((track) => {
                                return {
                                    title: track.videoDetails.title,
                                    url: track.videoDetails.video_url,
                                    uploader: track.videoDetails.author.name,
                                    thumb: track.videoDetails.thumbnails[track.videoDetails.thumbnails.length - 1].url,
                                    length: track.videoDetails.lengthSeconds * 1000,
                                    source: "youtube"
                                };
                            })
                        });
                    });
                }).catch(err => console.log);
            }).catch((error) => {
                //console.log("error fetching playlist " + error);
                res({
                    type: "playlist",
                    subtype: "spotify",
                    results: false,
                    err: error
                });
            });
        } else if (isValidUrl(url)) {
            http.get(url, function (_res) {
                if (_res.statusCode == 200) {
                    let headers = _res.headers;
                    getAudioDurationInSeconds(Readable.from(_res)).then((duration) => {
                        res({
                            type: "track",
                            subtype: "url",
                            results: [
                                {
                                    title: (headers["content-disposition"] ? (headers["content-disposition"].includes("filename=") ? headers["content-disposition"].split("filename=\"")[1].split("\"")[0] : "Web Audio") : "Web Audio"),
                                    url: url,
                                    uploader: url.split("//")[1].split("/")[0],
                                    thumb: "https://files.greencobalt.dev/selif/oqjqgz8p.png",
                                    length: duration * 1000,
                                    source: "web"
                                }
                            ]
                        });
                    }).catch((e) => {
                        res({
                            type: "track",
                            subtype: "url",
                            results: [
                                {
                                    title: (headers["content-disposition"] ? (headers["content-disposition"].includes("filename=") ? headers["content-disposition"].split("filename=\"")[1].split("\"")[0] : "Web Audio") : "Web Audio"),
                                    url: url,
                                    uploader: url.split("//")[1].split("/")[0],
                                    thumb: "https://files.greencobalt.dev/selif/oqjqgz8p.png",
                                    length: 0,
                                    source: "web"
                                }
                            ]
                        });
                    });
                }
            });
            /*
            request.get(url, {}, function (_err, _res, _body) {
                if (_err) { }
                if (_res.statusCode === 200) {
                    console.log(_res.statusCode);
                    getAudioDurationInSeconds(Readable.from(_body)).then((duration) => {
                        res({
                            type: "track",
                            subtype: "url",
                            results: [
                                {
                                    title: "Web Audio",
                                    url: url,
                                    uploader: url.split("//")[1].split("/")[0],
                                    thumb: "https://files.greencobalt.dev/selif/oqjqgz8p.png",
                                    length: duration * 1000,
                                    source: "web"
                                }
                            ]
                        });
                    });
                }
            });
            */
        } else {
            //UNKNOWN, SEARCH YOUTUBE
            //interaction.editReply({ content: `Searching YouTube for ${url}...` });
            youtubesearchapi.GetListByKeyword(url, false, 0 , [{ type: "video" }]).then((videos) => {
                ytdl.getInfo(`https://www.youtube.com/watch?v=${videos.items[0].id}`).then((songInfo) => {
                    res({
                        type: "track",
                        subtype: "search",
                        results: [
                            {
                                title: songInfo.videoDetails.title,
                                url: songInfo.videoDetails.video_url,
                                uploader: songInfo.videoDetails.author.name,
                                thumb: songInfo.videoDetails.thumbnails[songInfo.videoDetails.thumbnails.length - 1].url,
                                length: songInfo.videoDetails.lengthSeconds * 1000,
                                source: "youtube"
                            }
                        ]
                    });
                });
            });
        }
    });
}

processPlayCmd(workerData.url).then((result) => {
    parentPort.postMessage({ result });
});
