FROM node:16-alpine

WORKDIR /usr/src/app

COPY package*.json ./
COPY . .

ENV TOKEN ODg2NzYzNzY1Nzk2ODM5NDQ0.YT6VHQ.4dLElN90GYXhhtbpYiaAX-N3JW4
ENV SPOTIFY_ID 957dc52166d24cc888809570efa9dc48
ENV SPOTIFY_SECRET 75e9866f8aca44e1bd3d92e69cd570a4
ENV SPDL_NO_UPDATE false

RUN apk --update add ffmpeg
RUN npm ci --omit=dev

CMD [ "node", "bot.js" ]