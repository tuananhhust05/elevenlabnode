import dotenv from "dotenv";
import fs from 'fs';
import FormData from 'form-data';
import axios from 'axios';
dotenv.config();
const {
    ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER
} = process.env;

async function getagentdata() {
    try {
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/agents/agent_7601k5tn5fffe65a7wjsg6tfd32z`,
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
        console.log(data);
    } catch (error) {
        console.error("Error getting signed URL:", error);
        throw error;
    }
}

async function get_list_knowledge_base() {
    try {
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/knowledge-base`,
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
        console.log(data);
    } catch (error) {
        console.error("Error getting signed URL:", error);
        throw error;
    }
}

async function update_knowledge_base() {
    try {
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/knowledge-base/nhNf8Rt59BkGrDHhTFqO`,
            {
                method: 'PATCH',
                headers: {
                    'xi-api-key': ELEVENLABS_API_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    "name": "test 1"
                })
            }
        );

        if (!response.ok) {
            throw new Error(`Failed to get signed URL: ${response.statusText}`);
        }

        const data = await response.json();
        console.log(data);
    } catch (error) {
        console.error(error);
        throw error;
    }
}

async function delete_knowledge_base() {
    try {
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/knowledge-base/nhNf8Rt59BkGrDHhTFqO`,
            {
                method: 'DELETE',
                headers: {
                    'xi-api-key': ELEVENLABS_API_KEY
                }
            }
        );

        if (!response.ok) {
            throw new Error(`Failed to get signed URL: ${response.statusText}`);
        }
        console.log("deleted")
        // const data = await response.json();
        // console.log(data);
    } catch (error) {
        console.error(error);
        throw error;
    }
}

async function create_knowledge_base() {
    const filePath = "C:/data/agentvoice/evelvenlabnode/rag.docx"; // fix cứng

    try {
        const formData = new FormData();
        formData.append("file", fs.createReadStream(filePath));

        const response = await axios.post(
            "https://api.elevenlabs.io/v1/convai/knowledge-base/file",
            formData,
            {
                headers: {
                    "xi-api-key": ELEVENLABS_API_KEY,
                    ...formData.getHeaders(),
                },
            }
        );

        console.log("Upload thành công:", response.data);
    } catch (error) {
        console.error("Lỗi upload:", error.response?.data || error.message);
    }
}

async function updateagentdata() {
    try {
      const response = await fetch(
        "https://api.elevenlabs.io/v1/convai/agents/agent_7601k5tn5fffe65a7wjsg6tfd32z",
        {
          method: "PATCH",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            conversation_config: {
              agent: {
                prompt: {
                  knowledge_base: [
                    {
                      type: "file",
                      name: "RAG Doc",
                      id: "3UlDzSwvgNtIDi8EzxPl", // document_id bạn upload
                      usage_mode: "auto",
                    },
                  ],
                },
              },
            },
          }),
        }
      );
  
      if (!response.ok) {
        throw new Error(`Update agent failed: ${response.statusText}`);
      }
  
      const data = await response.json();
      console.log("Agent updated:", data);
    } catch (error) {
      console.error("Error updating agent:", error);
      throw error;
    }
  }
  
//   updateagentdata();
  

// updateagentdata();
create_knowledge_base();

// get_list_knowledge_base();