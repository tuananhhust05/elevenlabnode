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
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`, {
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
  
  function getWavDuration(filePath) {
    try {
      const buffer = fs.readFileSync(filePath);
      
      // Đọc WAV header
      const sampleRate = buffer.readUInt32LE(24);  // Byte 24-27: Sample Rate
      const channels = buffer.readUInt16LE(22);    // Byte 22-23: Channels  
      const bitDepth = buffer.readUInt16LE(34);    // Byte 34-35: Bits per Sample
      const dataSize = buffer.readUInt32LE(40);    // Byte 40-43: Data Size
      
      // Tính thời lượng
      const bytesPerSample = bitDepth / 8;
      const bytesPerSecond = sampleRate * channels * bytesPerSample;
      const duration = dataSize / bytesPerSecond;
      
      return Math.round(duration * 100) / 100; // Làm tròn 2 chữ số
    } catch (error) {
      console.error('Error reading WAV duration:', error);
      return 0;
    }
  }

  // Function to decode µ-law to PCM16
  function ulaw2lin(ulawBuffer) {
    const pcmBuffer = Buffer.alloc(ulawBuffer.length * 2);
    for (let i = 0; i < ulawBuffer.length; i++) {
      let ulaw = ~ulawBuffer[i];
      const sign = (ulaw & 0x80);
      const exponent = (ulaw >> 4) & 0x07;
      const mantissa = ulaw & 0x0F;
      let sample = (mantissa << (exponent + 3)) + (1 << (exponent + 2));
      if (sign) sample = -sample;
      sample = Math.max(-32768, Math.min(32767, sample));
      pcmBuffer.writeInt16LE(sample, i * 2);
    }
    return pcmBuffer;
  }

  // THAY ĐỔI 1: Hàm trợ giúp để chuyển đổi Mono PCM thành Stereo PCM
  // channel: 0 for left, 1 for right
  function interleaveMonoToStereo(monoBuffer, channel = 0) {
    const sampleCount = monoBuffer.length / 2;
    const stereoBuffer = Buffer.alloc(sampleCount * 4); // 2 channels * 2 bytes/sample

    for (let i = 0; i < sampleCount; i++) {
      const sample = monoBuffer.readInt16LE(i * 2);
      if (channel === 0) { // Left channel
        stereoBuffer.writeInt16LE(sample, i * 4);
        stereoBuffer.writeInt16LE(0, i * 4 + 2); // Right channel silent
      } else { // Right channel
        stereoBuffer.writeInt16LE(0, i * 4); // Left channel silent
        stereoBuffer.writeInt16LE(sample, i * 4 + 2);
      }
    }
    return stereoBuffer;
  }

  // Function to call transcribe API
  async function callTranscribeAPI(filePath) {
    try {
      console.log('[Transcribe] Calling transcribe API for:', filePath);
      
      const response = await fetch('http://13.210.192.27:8089/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filepath: filePath }),
        timeout: 30000 // 30 seconds timeout
      });

      if (!response.ok) {
        throw new Error(`Transcribe API failed: ${response.status}`);
      }

      const result = await response.json();
      console.log('[Transcribe] API response:', result);
      
      if (result.success) {
        return {
          transcript: result.transcript,
          keywords: result.keywords
        };
      } else {
        throw new Error(result.error || 'Transcribe failed');
      }
    } catch (error) {
      console.error('[Transcribe] Error:', error);
      throw error;
    }
  }

  // Function to send initial webhook (without transcript)
  async function sendInitialWebhook(file, recordingUrl, duration) {
    try {
      const payload = {
        duration: Math.round(duration),
        recording_url: recordingUrl,
        transcript: "Processing...",
        sentiment: "positive",
        sentiment_score: 0.85,
        status: "completed"
      };

      console.log('[Webhook] Sending initial webhook for:', payload);

      const response = await fetch("https://4skale.com/api/webhook/auto-update-latest", {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Initial webhook failed: ${response.status}`);
      }

      console.log('[Webhook] Initial webhook sent successfully');
      return true;
    } catch (error) {
      console.error('[Webhook] Initial webhook error:', error);
      throw error;
    }
  }

  // Route to initiate outbound calls
  fastify.post("/outbound-call", async (request, reply) => {
    const {
      number,
      prompt
    } = request.body;

    if (!number) {
      return reply.code(400).send({
        error: "Phone number is required"
      });
    }

    try {
      const call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: number,
        url: `https://4skale.com/outbound-call-twiml?prompt=${encodeURIComponent(prompt)}`,
        statusCallback: "https://4skale.com/status-callback",
        statusCallbackEvent: ["completed"],
        statusCallbackMethod: "POST" 
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

  fastify.post("/status-callback", async (request, reply) => {
    try {
      const recordingsDir = path.join(process.cwd(), 'recordings');

      // Kiểm tra thư mục tồn tại
      if (!fs.existsSync(recordingsDir)) {
        return reply.code(404).send({ error: "Recordings directory not found" });
      }

      // Tìm file WAV mới nhất theo thời gian tạo
      const files = fs.readdirSync(recordingsDir)
        .filter(file => file.endsWith('.wav'))
        .map(file => {
          const filePath = path.join(recordingsDir, file);
          const stats = fs.statSync(filePath);
          return {
            name: file,
            path: filePath,
            created: stats.birthtime
          };
        })
        .sort((a, b) => b.created - a.created); // Sắp xếp mới nhất trước

      if (files.length === 0) {
        return reply.code(404).send({ error: "No WAV files found" });
      }

      const latestFile = files[0];
      const recordingUrl = `https://4skale.com/recordings/${latestFile.name}`;
      const fileDurationInSeconds = getWavDuration(latestFile.path);
      
      console.log('[StatusCallback] Latest file:', latestFile.name);
      
      // Gọi transcribe API song song với webhook
      const transcribePromise = callTranscribeAPI(latestFile.path);
      const webhookPromise = sendInitialWebhook(latestFile, recordingUrl, fileDurationInSeconds);
      
      // Chờ cả hai hoàn thành
      const [transcribeResult, webhookResult] = await Promise.allSettled([transcribePromise, webhookPromise]);
      
      // Xử lý kết quả transcribe
      let finalPayload = {
        duration: Math.round(fileDurationInSeconds),
        recording_url: recordingUrl,
        transcript: "Transcripting.",
        sentiment: "positive",
        sentiment_score: 0.85,
        status: "completed",
        local_file: latestFile.path,
        received_at: new Date().toISOString()
      };
      
      if (transcribeResult.status === 'fulfilled' && transcribeResult.value) {
        finalPayload.transcript = transcribeResult.value.transcript;
        finalPayload.keywords = transcribeResult.value.keywords;
        console.log('[StatusCallback] Transcribe completed:', transcribeResult.value);
      } else {
        console.error('[StatusCallback] Transcribe failed:', transcribeResult.reason);
      }
      
      // Gửi payload cuối cùng với transcript
      const finalResponse = await fetch("https://4skale.com/api/webhook/auto-update-latest", {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalPayload),
      });

      if (!finalResponse.ok) {
        throw new Error(`Final webhook failed: ${finalResponse.status}`);
      }

      reply.send({
        message: "Processing completed",
        file: latestFile.name,
        transcribe_success: transcribeResult.status === 'fulfilled',
        webhook_success: webhookResult.status === 'fulfilled',
        final_payload: finalPayload
      });

    } catch (error) {
      console.error('[StatusCallback] Error:', error);
      reply.code(500).send({
        error: "Failed to process callback",
        message: error.message
      });
    }
  });

  // WebSocket route for handling media streams
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", {
      websocket: true
    }, (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;

      // THAY ĐỔI 2: Chỉ sử dụng một stream và một file để ghi âm
      let conversationRecordingStream = null;
      let conversationRecordingFile = null;

      ws.on('error', console.error);

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
                  prompt: {
                    prompt: customParameters?.prompt || "you are a gary from the phone store"
                  },
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
                case "audio":
                  if (streamSid) {
                    const audioBase64 = message.audio?.chunk || message.audio_event?.audio_base_64;
                    if (audioBase64) {
                      ws.send(JSON.stringify({
                        event: "media",
                        streamSid,
                        media: {
                          payload: audioBase64
                        }
                      }));

                      // THAY ĐỔI 3: Ghi âm thanh từ ElevenLabs vào kênh PHẢI (right channel)
                      if (conversationRecordingStream) {
                        try {
                          const ulawBuffer = Buffer.from(audioBase64, "base64");
                          const pcmBuffer = ulaw2lin(ulawBuffer);
                          const stereoPcmBuffer = interleaveMonoToStereo(pcmBuffer, 1); // 1 for right channel
                          conversationRecordingStream.write(stereoPcmBuffer);
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
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => console.error("[ElevenLabs] WebSocket error:", error));
          elevenLabsWs.on("close", () => console.log("[ElevenLabs] Disconnected"));

        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      setupElevenLabs();

      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;

              const recordingsDir = path.join(process.cwd(), 'recordings');
              if (!fs.existsSync(recordingsDir)) {
                fs.mkdirSync(recordingsDir, {
                  recursive: true
                });
              }

              // THAY ĐỔI 4: Thiết lập một file ghi âm STEREO
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              conversationRecordingFile = path.join(recordingsDir, `${callSid}_conversation_${timestamp}.wav`);
              conversationRecordingStream = new wav.FileWriter(conversationRecordingFile, {
                channels: 2, // STEREO
                sampleRate: 8000,
                bitDepth: 16
              });

              console.log(`[Recording] Started conversation recording: ${conversationRecordingFile}`);
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.send(JSON.stringify({
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                }));
              }

              // THAY ĐỔI 5: Ghi âm thanh từ Twilio vào kênh TRÁI (left channel)
              if (conversationRecordingStream) {
                try {
                  const ulawBuffer = Buffer.from(msg.media.payload, "base64");
                  const pcmBuffer = ulaw2lin(ulawBuffer);
                  const stereoPcmBuffer = interleaveMonoToStereo(pcmBuffer, 0); // 0 for left channel
                  conversationRecordingStream.write(stereoPcmBuffer);
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

              // THAY ĐỔI 6: Kết thúc file ghi âm duy nhất
              if (conversationRecordingStream) {
                conversationRecordingStream.end();
                console.log(`[Recording] Conversation recording saved: ${conversationRecordingFile}`);
                conversationRecordingStream = null;
                conversationRecordingFile = null;
              }
              break;
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");

        // Đảm bảo kết thúc ghi âm khi kết nối bị đóng đột ngột
        if (conversationRecordingStream) {
          conversationRecordingStream.end();
          console.log(`[Recording] Conversation recording saved: ${conversationRecordingFile}`);
          conversationRecordingStream = null;
          conversationRecordingFile = null;
        }

        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    });
  });
}