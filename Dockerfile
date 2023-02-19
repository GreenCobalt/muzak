FROM node:16-alpine

WORKDIR /usr/src/app

COPY . .

RUN apk add --update ffmpeg && rm -rf /var/cache/apk/*
RUN npm ci --omit=dev

ENV TOKEN ODg2NzYzNzY1Nzk2ODM5NDQ0.Ga2hRV.q8z9gObOftrHr9I-PflBt1G4Lt2-lk2w62qXUU
ENV SPDL_NO_UPDATE false
ENV SPOTIFY_ID 957dc52166d24cc888809570efa9dc48
ENV SPOTIFY_SECRET 75e9866f8aca44e1bd3d92e69cd570a4

CMD [ "node", "bot.js" ]