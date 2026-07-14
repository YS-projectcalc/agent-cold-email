# ColdStart email engine — runtime image.
#
# Build context is THIS directory (apps/engine). The TypeScript is compiled on
# the host first (`npm run build -w @coldstart/engine`, where the workspace can
# resolve the type-only @coldstart/shared import); the image carries only the
# emitted dist/ plus the production runtime deps (nodemailer/imapflow/mailparser/
# zod). @coldstart/shared is a type-only devDependency — erased at build, never
# needed at runtime — so `npm install --omit=dev` never tries to resolve it.
#
#   npm run build -w @coldstart/engine   # produces apps/engine/dist
#   docker build -t coldstart-engine apps/engine
#
FROM node:24-alpine

WORKDIR /app

# Runtime deps only (dev/type-only deps are omitted; see note above).
COPY package.json ./
RUN npm install --omit=dev --no-package-lock && npm cache clean --force

COPY dist ./dist

# State (engine-state.json: idempotency, thread map, IMAP high-water) persists
# here — mount a volume at /app/state so it survives container restarts.
ENV ENGINE_STATE_DIR=/app/state
RUN mkdir -p /app/state && chown -R node:node /app/state
VOLUME ["/app/state"]

USER node
EXPOSE 8080

# ENGINE_AUTH_SECRET + MAILBOX_CREDENTIALS(_FILE) are injected at `docker run`
# time (never baked into the image — CLAUDE.md rule g).
CMD ["node", "dist/index.js"]
