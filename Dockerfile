FROM node:24-alpine AS runtime

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
ENV PORT=3333
ENV HOST=localhost
ENV LOG_LEVEL=info
ENV APP_KEY=sH238982hdbe8gojcp3PdAJiGDxof54kjtTXa3g

WORKDIR /app

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
COPY . .
RUN npm -g install pnpm
RUN pnpm install

RUN pnpm run build

EXPOSE 3333

CMD ["node", "build/bin/server.js"]
