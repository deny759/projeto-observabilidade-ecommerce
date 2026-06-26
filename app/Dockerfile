FROM node:18-alpine

# Instala dependências nativas para o SQLite3compilar se necessário
RUN apk add --no-cache python3 make g++

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]