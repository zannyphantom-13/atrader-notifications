FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Install dependencies first for Docker caching
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY . .

# Set default port
ENV PORT=3000
EXPOSE 3000

# Start server
CMD ["node", "server.js"]

