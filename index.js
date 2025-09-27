import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { registerInboundRoutes } from './inbound-calls.js';
import { registerOutboundRoutes } from './outbound-calls.js';
import fastifyStatic from '@fastify/static';


// Load environment variables from .env file
dotenv.config();

// Initialize Fastify server
const fastify = Fastify({
  logger: true // Enable logging
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
// Register static file serving
fastify.register(fastifyStatic, {
  root: path.join(process.cwd(), 'recordings'),
  prefix: '/recordings/', // URL prefix
  list: true // Cho phép list files trong folder
});

const PORT = process.env.PORT || 5059;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Start the Fastify server
const start = async () => {
  try {
    // Register route handlers
    await registerInboundRoutes(fastify);
    await registerOutboundRoutes(fastify);

    // Start listening
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[Server] Listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

start();