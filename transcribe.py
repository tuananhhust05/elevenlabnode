from flask import Flask, request, jsonify
from faster_whisper import WhisperModel
import os
import tempfile

app = Flask(__name__)
model = WhisperModel("tiny", device="cpu", compute_type="int8")

@app.route('/transcribe', methods=['POST'])
def transcribe_audio():
    try:
        data = request.get_json()
        filepath = data.get('filepath')
        
        if not filepath:
            return jsonify({'error': 'filepath is required'}), 400
        
        if not os.path.exists(filepath):
            return jsonify({'error': 'File not found'}), 404
        
        # Transcribe
        segments, info = model.transcribe(filepath, language="en")
        
        # Gộp text
        transcript = " ".join([segment.text for segment in segments])
        
        return jsonify({
            'success': True,
            'transcript': transcript.strip(),
            'language': info.language,
            'duration': round(info.duration, 2)
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8089)