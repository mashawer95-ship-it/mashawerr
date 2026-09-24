# Real-Time Driver Tracking System

A production-grade real-time tracking service for delivery applications built with Node.js, TypeScript, and Socket.IO following Clean Architecture principles.

## Features
- Real-time location updates using Socket.IO
- Room-based broadcasting (`order:{orderId}`)
- JWT Authentication for secure socket connections
- Zod Payload Validation
- Express HTTP server with Rate Limiting, Helmet, and CORS
- Pino Logger for high-performance logging
- Clean Architecture (Domain, Application, Infrastructure, Presentation)

## Requirements
- Node.js >= 20
- Docker (optional, for containerization)

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Environment Variables:**
   Copy the example env file and set your secrets.
   ```bash
   cp .env.example .env
   ```

3. **Run Development Server:**
   ```bash
   npm run dev
   ```

4. **Build for Production:**
   ```bash
   npm run build
   npm start
   ```

## Docker

Build and run the service using Docker Compose:
```bash
docker-compose up --build -d
```

## GitHub Push Instructions

To push this project to a new GitHub repository, run the following commands in your terminal:

```bash
cd tracking-service
git init
git add .
git commit -m "feat: initial commit of tracking service"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```
