FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git \
  && curl -L https://fly.io/install.sh | sh \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.fly/bin:${PATH}"
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
