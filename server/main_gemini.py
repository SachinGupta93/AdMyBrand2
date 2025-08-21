import asyncio
import json
import logging
import os
import uuid
import cv2
import numpy as np
from aiohttp import web, ClientSession
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack, RTCConfiguration, RTCIceServer
from aiortc.contrib.media import MediaPlayer
import base64
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Gemini Only Detection Engine for WASM Mode
class GeminiOnlyDetectionEngine:
    def __init__(self):
        self.detection_engine = 'gemini'
        logger.info("Initialized Gemini-only detection engine for WASM mode")

    async def process_frame(self, frame):
        """Process frame with Gemini API only"""
        try:
            # Convert frame to JPEG
            _, buffer = cv2.imencode('.jpg', frame)
            base64_image = base64.b64encode(buffer).decode()
            
            # Return the base64 encoded image for frontend processing
            return {
                'success': True,
                'image': base64_image,
                'detections': []  # Frontend will handle Gemini detection
            }
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
            return {'success': False, 'error': str(e)}

# Global instances
detection_engine = GeminiOnlyDetectionEngine()
pcs = set()

async def create_peer_connection():
    """Create a new RTCPeerConnection with ICE servers"""
    config = RTCConfiguration(
        iceServers=[
            RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
            RTCIceServer(urls=["stun:stun1.l.google.com:19302"]),
        ]
    )
    return RTCPeerConnection(configuration=config)

class DetectionVideoStreamTrack(VideoStreamTrack):
    """Custom video stream track that processes frames"""
    
    def __init__(self, track):
        super().__init__()
        self.track = track
        self.last_detection_time = 0
        self.detection_interval = int(os.getenv('DETECTION_INTERVAL_MS', '8000')) / 1000.0
        
    async def recv(self):
        frame = await self.track.recv()
        
        # Convert to numpy array
        img = frame.to_ndarray(format="rgb24")
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        
        # Process frame occasionally for detection
        current_time = asyncio.get_event_loop().time()
        if current_time - self.last_detection_time > self.detection_interval:
            self.last_detection_time = current_time
            # Process frame in background (non-blocking)
            asyncio.create_task(self.process_detection(img))
        
        return frame
    
    async def process_detection(self, img):
        """Process detection in background"""
        try:
            result = await detection_engine.process_frame(img)
            if result.get('success'):
                logger.info("Frame processed successfully")
        except Exception as e:
            logger.error(f"Detection processing error: {e}")

async def offer(request):
    """Handle WebRTC offer"""
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = await create_peer_connection()
    pcs.add(pc)

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        logger.info(f"Connection state is {pc.connectionState}")
        if pc.connectionState == "failed":
            await pc.close()
            pcs.discard(pc)

    @pc.on("track")
    def on_track(track):
        logger.info(f"Received track: {track.kind}")
        if track.kind == "video":
            # Add detection processing to video track
            detection_track = DetectionVideoStreamTrack(track)
            pc.addTrack(detection_track)

    # Set remote description
    await pc.setRemoteDescription(offer)
    
    # Create answer
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.json_response({
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type
    })

async def config(request):
    """Provide configuration to frontend"""
    config_data = {
        'detection_engine': os.getenv('DETECTION_ENGINE', 'gemini'),
        'openrouter_api_key': os.getenv('OPENROUTER_API_KEY', ''),
        'detection_interval_ms': int(os.getenv('DETECTION_INTERVAL_MS', '8000')),
        'model_name': os.getenv('MODEL_NAME', 'google/gemini-2.0-flash-exp:free')
    }
    return web.json_response(config_data)

async def detect_frame(request):
    """Handle frame detection requests from frontend"""
    try:
        data = await request.json()
        image_data = data.get('image', '')
        
        if not image_data:
            return web.json_response({'success': False, 'error': 'No image provided'})
        
        # Remove data URL prefix if present
        if image_data.startswith('data:image'):
            image_data = image_data.split(',')[1]
        
        # Decode base64 image
        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if frame is None:
            return web.json_response({'success': False, 'error': 'Invalid image data'})
        
        # Process with detection engine
        result = await detection_engine.process_frame(frame)
        return web.json_response(result)
        
    except Exception as e:
        logger.error(f"Error in detect_frame: {e}")
        return web.json_response({'success': False, 'error': str(e)})

async def on_shutdown(app):
    """Cleanup on shutdown"""
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros)
    pcs.clear()

def create_app():
    """Create the web application"""
    app = web.Application()
    
    # Add CORS middleware
    async def cors_handler(request, handler):
        response = await handler(request)
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return response

    # Handle preflight requests
    async def options_handler(request):
        return web.Response(
            headers={
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        )

    app.middlewares.append(cors_handler)
    
    # Add routes
    app.router.add_post('/offer', offer)
    app.router.add_get('/api/config', config)
    app.router.add_post('/api/detect-frame', detect_frame)
    app.router.add_route('OPTIONS', '/{path:.*}', options_handler)
    
    # Serve static files
    app.router.add_static('/', 'static/', name='static')
    app.router.add_get('/', lambda r: web.FileResponse('static/index.html'))
    
    # Cleanup on shutdown
    app.on_shutdown.append(on_shutdown)
    
    return app

def find_available_port(start_port=3000, max_attempts=10):
    """Find an available port starting from start_port"""
    import socket
    for port in range(start_port, start_port + max_attempts):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('', port))
                return port
        except OSError:
            continue
    return None

async def main():
    """Main function"""
    try:
        # Find available port
        port = find_available_port(3000)
        if port is None:
            logger.error("No available ports found!")
            return
        
        if port != 3000:
            logger.info(f"Port 3000 is busy, using port {port} instead")
        
        # Create and run app
        app = create_app()
        runner = web.AppRunner(app)
        await runner.setup()
        
        site = web.TCPSite(runner, '0.0.0.0', port)
        await site.start()
        
        logger.info(f"🚀 Gemini Detection Server running on http://0.0.0.0:{port}")
        logger.info(f"📱 Mobile access: Make sure to allow camera permissions")
        logger.info(f"🔧 WASM Mode: Using Gemini-only detection engine")
        
        # Keep running
        try:
            while True:
                await asyncio.sleep(1)
        except KeyboardInterrupt:
            logger.info("Shutting down...")
        finally:
            await runner.cleanup()
            
    except Exception as e:
        logger.error(f"Server error: {e}")
        raise

if __name__ == '__main__':
    asyncio.run(main())
