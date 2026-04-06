# Use Node.js 18 with OpenJDK
FROM node:18-alpine

# Install OpenJDK 11 (or latest LTS)
RUN apk add --no-cache openjdk11

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Expose port
EXPOSE 3001

# Start the application
CMD ["node", "server.js"]