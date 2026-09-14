FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node dist ./dist
RUN mkdir /data && chown node:node /data
USER node
ENV ARTIFACT_HOST_HOST=0.0.0.0 ARTIFACT_HOST_PORT=8080 ARTIFACT_HOST_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/cli.js"]
