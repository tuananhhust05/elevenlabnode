from flask import Flask, request, jsonify
from faster_whisper import WhisperModel
from groq import Groq
import os
import json
import requests
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()
app = Flask(__name__)

# Load models
whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

@app.route('/transcribe', methods=['POST'])
def transcribe_audio():
    try:
        data = request.get_json()
        filepath = data.get('filepath')
        
        if not filepath:
            return jsonify({'error': 'filepath is required'}), 400
        
        if not os.path.exists(filepath):
            return jsonify({'error': 'File not found'}), 404
        
        # Transcribe audio
        segments, info = whisper_model.transcribe(filepath, language="en")
        transcript = " ".join([segment.text for segment in segments])
        
        # Extract keywords
        keywords = extract_keywords(transcript)
        
        # Send to webhook
        webhook_success = send_to_webhook(transcript.strip(), keywords)
        
        return jsonify({
            'success': True,
            'transcript': transcript.strip(),
            'keywords': keywords,
            'webhook_sent': webhook_success
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def extract_keywords(transcript):
    try:
        prompt = f"""
        Extract the most important keywords from this transcript.
        Return ONLY a JSON array of strings, no other text.
        
        Transcript: "{transcript}"
        
        Return format: ["keyword1", "keyword2", "keyword3"]
        """
        
        response = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=300
        )
        
        keywords_text = response.choices[0].message.content.strip()
        
        # Clean up response
        if keywords_text.startswith("```json"):
            keywords_text = keywords_text[7:]
        if keywords_text.endswith("```"):
            keywords_text = keywords_text[:-3]
        
        keywords = json.loads(keywords_text)
        
        # Return only the array
        if isinstance(keywords, list):
            return [kw.strip() for kw in keywords if kw.strip()]
        else:
            return []
            
    except Exception as e:
        print(f"Error extracting keywords: {e}")
        return []

def send_to_webhook(transcript, keywords):
    try:
        webhook_url = "https://4skale.com/api/webhook/auto-update-latest_transcript"
        
        payload = {
            "transcript": transcript,
            "keywords": keywords
        }
        
        response = requests.put(
            webhook_url,
            headers={'Content-Type': 'application/json'},
            json=payload,
            timeout=10
        )
        
        if response.status_code == 200:
            print(f"Webhook sent successfully: {response.status_code}")
            return True
        else:
            print(f"Webhook failed: {response.status_code} - {response.text}")
            return False
            
    except Exception as e:
        print(f"Error sending webhook: {e}")
        return False

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8089)