import WebSocket from "ws";
import Twilio from "twilio";
import fs from "fs";
import wav from "wav";
import path from "path";

export function registerOutboundRoutes(fastify) {
  // Check for required environment variables
  const {
    ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER
  } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error("Missing required environment variables");
    throw new Error("Missing required environment variables");
  }

  // Initialize Twilio client
  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  // Helper function to get signed URL for authenticated conversations
  async function getSignedUrl() {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          method: "GET",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get signed URL: ${response.statusText}`);
      }

      const data = await response.json();
      return data.signed_url;
    } catch (error) {
      console.error("Error getting signed URL:", error);
      throw error;
    }
  }

  // Route to initiate outbound calls
  fastify.post("/outbound-call", async (request, reply) => {
    const { number, prompt } = request.body;

    if (!number) {
      return reply.code(400).send({ error: "Phone number is required" });
    }

    try {
      const call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: number,
        url: `https://4skale.com/outbound-call-twiml?prompt=${encodeURIComponent(prompt)}`
      });

      reply.send({
        success: true,
        message: "Call initiated",
        callSid: call.sid
      });
    } catch (error) {
      console.error("Error initiating outbound call:", error);
      reply.code(500).send({
        success: false,
        error: "Failed to initiate call"
      });
    }
  });

  // TwiML route for outbound calls
  fastify.all("/outbound-call-twiml", async (request, reply) => {
    const prompt = request.query.prompt || "";

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://4skale.com/media-stream">
            <Parameter name="prompt" value="${prompt}" />
          </Stream>
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket route for handling media streams
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;

      // File write streams
      let twilioWriteStream = null;
      let elevenLabsWriteStream = null;

      // Handle WebSocket errors
      ws.on("error", console.error);

      // Setup ElevenLabs
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: { prompt: customParameters?.prompt || "you are a gary from the phone store" },
                  first_message: "hey there! how can I help you today?",
                },
              }
            };

            console.log("[ElevenLabs] Sending initial config with prompt:", initialConfig.conversation_config_override.agent.prompt.prompt);
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  if (streamSid) {
                    let audioChunk = null;

                    if (message.audio?.chunk) {
                      audioChunk = message.audio.chunk;
                    } else if (message.audio_event?.audio_base_64) {
                      audioChunk = message.audio_event.audio_base_64;
                    }

                    if (audioChunk) {
                      // Forward to Twilio
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: { payload: audioChunk }
                      };
                      ws.send(JSON.stringify(audioData));

                      // Save to ElevenLabs file
                      if (elevenLabsWriteStream) {
                        const buffer = Buffer.from(audioChunk, "base64");
                        elevenLabsWriteStream.write(buffer);
                      }
                    }
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({ event: "clear", streamSid }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(JSON.stringify({ type: "pong", event_id: message.ping_event.event_id }));
                  }
                  break;

                default:
                  console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
          });

        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      setupElevenLabs();

      // Handle messages from Twilio
      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          console.log(`[Twilio] Received event: ${msg.event}`);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
              console.log("[Twilio] Start parameters:", customParameters);

              // Init file writers
              const baseDir = path.join(process.cwd(), "recordings");
              if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir);

              const twilioFile = path.join(baseDir, `${callSid}_twilio.wav`);
              const elevenLabsFile = path.join(baseDir, `${callSid}_elevenlabs.wav`);

              // Create file descriptors immediately
              twilioWriteStream = fs.createWriteStream(twilioFile, { flags: "w" });
              elevenLabsWriteStream = fs.createWriteStream(elevenLabsFile, { flags: "w" });

              console.log(`[File] Recording files created: ${twilioFile}, ${elevenLabsFile}`);
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }

              if (twilioWriteStream) {
                const buffer = Buffer.from(msg.media.payload, "base64");
                twilioWriteStream.write(buffer);
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();

              if (twilioWriteStream) twilioWriteStream.end();
              if (elevenLabsWriteStream) elevenLabsWriteStream.end();
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
        if (twilioWriteStream) twilioWriteStream.end();
        if (elevenLabsWriteStream) elevenLabsWriteStream.end();
      });
    });
  });
}
