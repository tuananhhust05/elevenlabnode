import WebSocket from "ws";
import Twilio from "twilio";
import fs from 'fs';
import path from 'path';
import wav from 'wav';

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
          method: 'GET',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY
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

  // Function to decode µ-law to PCM16 (similar to audioop.ulaw2lin in Python)
  function ulaw2lin(ulawBuffer) {
    const pcmBuffer = Buffer.alloc(ulawBuffer.length * 2);

    for (let i = 0; i < ulawBuffer.length; i++) {
      let ulaw = ulawBuffer[i];

      // µ-law to linear conversion
      ulaw = ~ulaw;
      const sign = ulaw & 0x80;
      const exponent = (ulaw >> 4) & 0x07;
      const mantissa = ulaw & 0x0F;

      let sample = (mantissa << (exponent + 3)) + (1 << (exponent + 2));
      if (sign) sample = -sample;

      // Clamp to 16-bit range
      sample = Math.max(-32768, Math.min(32767, sample));

      // Write as little-endian 16-bit
      pcmBuffer.writeInt16LE(sample, i * 2);
    }

    return pcmBuffer;
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
    const prompt = request.query.prompt || '';

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
      let customParameters = null;  // Add this to store parameters

      // Separate recording streams
      let twilioRecordingStream = null;
      let twilioRecordingFile = null;
      let elevenLabsRecordingStream = null;
      let elevenLabsRecordingFile = null;

      // Handle WebSocket errors
      ws.on('error', console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Send initial configuration with prompt and first message
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

            // Send the configuration to ElevenLabs
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              console.log("[ElevenLabs] Received message:", data);
              const message = JSON.parse(data);
              console.log("[ElevenLabs] Received message:", data);
              console.log("[ElevenLabs] Received message type:", message.type);
              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                    if (streamSid) {
                        // Lấy dữ liệu audio base64 từ đúng chỗ
                        const audioBase64 = message.audio?.chunk || message.audio_event?.audio_base_64;

                        if (audioBase64) {
                            // Gửi audio cho Twilio để phát
                            ws.send(JSON.stringify({
                                event: "media",
                                streamSid,
                                media: { payload: audioBase64 }
                            }));
                            
                            // Ghi âm audio từ ElevenLabs
                            if (elevenLabsRecordingStream) {
                                try {
                                    const audioBuffer = Buffer.from(audioBase64, "base64");

                                    // DEBUG: Manh mối #2 & #3 - Kiểm tra nội dung và độ dài
                                    console.log(`[ElevenLabs DEBUG] Decoded buffer size: ${audioBuffer.length} bytes`);
                                    // Kiểm tra "Magic Bytes". Nếu là file WAV, nó sẽ bắt đầu bằng "RIFF" (hex: 52 49 46 46)
                                    console.log(`[ElevenLabs DEBUG] First 16 bytes (hex):`, audioBuffer.slice(0, 16).toString('hex'));
                                    console.log(`[ElevenLabs DEBUG] First 4 bytes (ascii):`, audioBuffer.slice(0, 4).toString('ascii'));

                                    // **GIẢ THUYẾT HIỆN TẠI:** ElevenLabs gửi về µ-law 8kHz để tương thích Twilio.
                                    // Chúng ta sẽ chuyển nó thành PCM để lưu file WAV.
                                    const pcmBuffer = ulaw2lin(audioBuffer);
                                    elevenLabsRecordingStream.write(pcmBuffer);

                                } catch (error) {
                                    console.error("[Recording] Error writing ElevenLabs audio:", error);
                                }
                            }
                        }
                    }
                    break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({
                      event: "clear",
                      streamSid
                    }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id
                    }));
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

      // Set up ElevenLabs connection
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
              customParameters = msg.start.customParameters;  // Store parameters
              // Tạo thư mục recordings nếu chưa có
              const recordingsDir = path.join(process.cwd(), 'recordings');
              if (!fs.existsSync(recordingsDir)) {
                fs.mkdirSync(recordingsDir, { recursive: true });
              }

              // Tạo file ghi âm riêng cho Twilio và ElevenLabs
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

              // Twilio recording (8kHz, µ-law decoded to PCM16)
              twilioRecordingFile = path.join(recordingsDir, `${callSid}_twilio_${timestamp}.wav`);
              twilioRecordingStream = new wav.FileWriter(twilioRecordingFile, {
                channels: 1,
                sampleRate: 8000,  // Twilio native sample rate
                bitDepth: 16
              });

              // ElevenLabs recording - thử tạo WAV với header đúng
              elevenLabsRecordingFile = path.join(recordingsDir, `${callSid}_elevenlabs_${timestamp}.wav`);
              elevenLabsRecordingStream = new wav.FileWriter(elevenLabsRecordingFile, {
                channels: 1,
                sampleRate: 8000,  // Thử 24kHz
                bitDepth: 16
              });

              console.log(`[Recording] Started Twilio recording: ${twilioRecordingFile}`);
              console.log(`[Recording] Started ElevenLabs recording: ${elevenLabsRecordingFile}`);
              console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
              console.log('[Twilio] Start parameters:', customParameters);
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }

              // Ghi âm audio từ Twilio (decode µ-law thành PCM16)
              if (twilioRecordingStream) {
                try {
                  const ulawBuffer = Buffer.from(msg.media.payload, "base64");
                  const pcmBuffer = ulaw2lin(ulawBuffer);
                  twilioRecordingStream.write(pcmBuffer);
                } catch (error) {
                  console.error("[Recording] Error decoding Twilio audio:", error);
                }
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              // Kết thúc ghi âm
              if (twilioRecordingStream) {
                twilioRecordingStream.end();
                console.log(`[Recording] Twilio recording saved: ${twilioRecordingFile}`);
                twilioRecordingStream = null;
                twilioRecordingFile = null;
              }

              if (elevenLabsRecordingStream) {
                elevenLabsRecordingStream.end();
                console.log(`[Recording] ElevenLabs recording saved: ${elevenLabsRecordingFile}`);
                elevenLabsRecordingStream = null;
                elevenLabsRecordingFile = null;
              }

              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Handle WebSocket closure
      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");

        // Đảm bảo kết thúc ghi âm
        if (twilioRecordingStream) {
          twilioRecordingStream.end();
          console.log(`[Recording] Twilio recording saved: ${twilioRecordingFile}`);
          twilioRecordingStream = null;
          twilioRecordingFile = null;
        }

        if (elevenLabsRecordingStream) {
          elevenLabsRecordingStream.end();
          console.log(`[Recording] ElevenLabs recording saved: ${elevenLabsRecordingFile}`);
          elevenLabsRecordingStream = null;
          elevenLabsRecordingFile = null;
        }


        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    });
  });
}