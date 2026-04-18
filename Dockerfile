FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

RUN mkdir -p /app/uploads

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "run", "start"]
