FROM node:18-bullseye

WORKDIR /app

# deps
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# project files
COPY vite.config.ts ./
COPY tsconfig.json ./
COPY index.html ./index.html
COPY public ./public
COPY src ./src

# build
RUN npm run build

# serve
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
