FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./tsconfig.json
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
COPY LICENSE ./LICENSE
COPY THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
RUN ln -s /app/dist/cli.js /usr/local/bin/mortal-kommit \
    && mkdir -p /home/node/.local/share/mortal-kommit \
    && chown -R node:node /home/node/.local
ENV NODE_ENV=production \
    MORTAL_KOMMIT_DATA_DIR=/home/node/.local/share/mortal-kommit \
    MORTAL_KOMMIT_VIEWER_HOST=0.0.0.0 \
    MORTAL_KOMMIT_VIEWER_PORT=8787
USER node
VOLUME ["/home/node/.local/share/mortal-kommit"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.MORTAL_KOMMIT_VIEWER_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli.js", "arena", "start"]
