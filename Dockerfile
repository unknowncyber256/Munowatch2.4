FROM node:18-slim
WORKDIR /app
COPY package.json .
RUN npm install
COPY index.js .
EXPOSE 7860
CMD ["node", "index.js"]
