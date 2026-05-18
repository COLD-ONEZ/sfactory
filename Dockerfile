FROM node:20-alpine
WORKDIR /app

# Install backend deps
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# Copy backend source
COPY backend/ ./backend/

# Copy frontend (static files served by Express)
COPY frontend/public/ ./frontend/public/

WORKDIR /app/backend
EXPOSE 3000

CMD ["node", "server.js"]
