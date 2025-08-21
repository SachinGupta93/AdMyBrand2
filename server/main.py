#!/usr/bin/env python3
"""
WebRTC VLM Object Detection Server
Real-time multi-object detection with WebRTC streaming
"""

import sys
from pathlib import Path
import asyncio
import json
import logging
import os
import time
from io import BytesIO
import base64
import socket

import aiohttp
from aiohttp import web, WSMsgType
import qrcode

# Add server directory to path to allow relative imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from webrtc_handler import WebRTCHandler
from inferencr_engine import InferenceEngine
from metrics_collector import MetricsCollector

# Configure logging
logging.basicConfig(
    level=logging.DEBUG if os.getenv('DEBUG', 'false').lower() == 'true' else logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class DetectionServer:
    def __init__(self):
        self.mode = os.getenv('MODE', 'wasm').lower()
        self.host = '0.0.0.0'
        self.port = 3000
        self.ws_port = 8765
        
        # Initialize components
        self.webrtc_handler = WebRTCHandler()
        self.inference_engine = InferenceEngine(mode=self.mode)
        self.metrics_collector = MetricsCollector()
        
        # Active connections
        self.websockets = set()
        
        logger.info(f"🚀 Initializing DetectionServer in {self.mode.upper()} mode")

    def get_local_ip(self):
        """Get local IP address"""
        try:
            # Connect to a remote server to determine local IP
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except Exception:
            return "127.0.0.1"

    def generate_qr_code(self, url):
        """Generate QR code for phone access"""
        qr = qrcode.QRCode(version=1, box_size=10, border=5)
        qr.add_data(url)
        qr.make(fit=True)
        
        img = qr.make_image(fill_color="black", back_color="white")
        buffer = BytesIO()
        img.save(buffer, format='PNG')
        buffer.seek(0)
        
        return base64.b64encode(buffer.getvalue()).decode()

    async def websocket_handler(self, request):
        """Handle WebSocket connections for signaling and data"""
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        
        self.websockets.add(ws)
        logger.info(f"📱 New WebSocket connection. Total: {len(self.websockets)}")
        
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        await self.handle_websocket_message(ws, data)
                    except json.JSONDecodeError as e:
                        logger.error(f"Invalid JSON: {e}")
                elif msg.type == WSMsgType.ERROR:
                    logger.error(f"WebSocket error: {ws.exception()}")
        except Exception as e:
            logger.error(f"WebSocket handler error: {e}")
        finally:
            self.websockets.discard(ws)
            logger.info(f"📱 WebSocket disconnected. Total: {len(self.websockets)}")
        
        return ws

    async def handle_websocket_message(self, ws, data):
        """Process WebSocket messages"""
        msg_type = data.get('type')
        
        if msg_type == 'offer':
            # Handle WebRTC offer
            answer = await self.webrtc_handler.handle_offer(data['sdp'])
            await ws.send_str(json.dumps({
                'type': 'answer',
                'sdp': answer
            }))
            
        elif msg_type == 'ice-candidate':
            # Handle ICE candidate
            await self.webrtc_handler.add_ice_candidate(data['candidate'])
            
        elif msg_type == 'frame':
            # Handle video frame for inference
            if self.mode == 'server':
                await self.process_frame_server_mode(ws, data)
            # In WASM mode, inference happens client-side
            
        elif msg_type == 'metrics-request':
            # Send current metrics
            metrics = self.metrics_collector.get_current_metrics()
            await ws.send_str(json.dumps({
                'type': 'metrics',
                'data': metrics
            }))

    async def process_frame_server_mode(self, ws, frame_data):
        """Process frame in server mode with inference"""
        try:
            frame_id = frame_data.get('frame_id')
            capture_ts = frame_data.get('capture_ts')
            image_data = frame_data.get('image_data')  # Base64 encoded
            
            recv_ts = int(time.time() * 1000)
            
            # Run inference
            detections = await self.inference_engine.detect_objects(image_data)
            inference_ts = int(time.time() * 1000)
            
            # Prepare response
            response = {
                'type': 'detections',
                'frame_id': frame_id,
                'capture_ts': capture_ts,
                'recv_ts': recv_ts,
                'inference_ts': inference_ts,
                'detections': detections
            }
            
            # Send back to client
            await ws.send_str(json.dumps(response))
            
            # Record metrics
            self.metrics_collector.record_frame(
                capture_ts, recv_ts, inference_ts, len(detections)
            )
            
        except Exception as e:
            logger.error(f"Frame processing error: {e}")

    async def index_handler(self, request):
        """Serve the main page"""
        # Generate QR code for current URL - use dynamic local IP
        local_ip = self.get_local_ip()
        current_url = f"http://{local_ip}:3000/"
        qr_code = self.generate_qr_code(current_url)
        
        html_content = f"""
<!DOCTYPE html>
<html>
<head>
    <title>WebRTC VLM Object Detection</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {{ 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            margin: 0; padding: 20px; background: #f5f5f5;
        }}
        .container {{ max-width: 1200px; margin: 0 auto; }}
        .header {{ text-align: center; margin-bottom: 30px; }}
        .mode-badge {{ 
            background: {'#4CAF50' if self.mode == 'wasm' else '#2196F3'}; 
            color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px;
        }}
        .demo-section {{ background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
        .video-container {{ position: relative; margin: 20px 0; }}
        #localVideo, #remoteVideo {{ width: 100%; max-width: 640px; border-radius: 8px; background: #000; }}
        .overlay-canvas {{ position: absolute; top: 0; left: 0; pointer-events: none; }}
        .qr-section {{ text-align: center; }}
        .qr-code {{ max-width: 200px; margin: 10px; }}
        .metrics {{ background: #263238; color: #fff; padding: 15px; border-radius: 8px; font-family: monospace; font-size: 14px; }}
        .controls {{ text-align: center; margin: 20px 0; }}
        .btn {{ 
            background: #1976D2; color: white; border: none; padding: 12px 24px; 
            border-radius: 6px; cursor: pointer; margin: 5px; font-size: 14px;
        }}
        .btn:hover {{ background: #1565C0; }}
        .btn.danger {{ background: #D32F2F; }}
        .btn.danger:hover {{ background: #C62828; }}
        .status {{ padding: 10px; border-radius: 4px; margin: 10px 0; }}
        .status.connected {{ background: #E8F5E8; color: #2E7D32; }}
        .status.connecting {{ background: #FFF3E0; color: #F57C00; }}
        .status.disconnected {{ background: #FFEBEE; color: #C62828; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📱 WebRTC VLM Object Detection</h1>
            <span class="mode-badge">{self.mode.upper()} MODE</span>
            <div id="connection-status" class="status disconnected">🔴 Disconnected</div>
        </div>
        
        <div class="demo-section">
            <h2>🎥 Live Demo</h2>
            <div class="video-container">
                <video id="localVideo" autoplay muted playsinline></video>
                <canvas id="overlayCanvas" class="overlay-canvas"></canvas>
            </div>
            <div class="controls">
                <button id="startBtn" class="btn">📹 Start Camera</button>
                <button id="stopBtn" class="btn danger" disabled>⏹️ Stop</button>
                <button id="benchBtn" class="btn">📊 Run Benchmark</button>
            </div>
        </div>
        
        <div class="demo-section qr-section">
            <h2>📱 Connect Your Phone</h2>
            <p>Scan this QR code with your phone camera:</p>
            <img src="data:image/png;base64,{qr_code}" alt="QR Code" class="qr-code">
            <p><strong>URL:</strong> <code>{current_url}</code></p>
            <p><small>Make sure your phone and laptop are on the same network</small></p>
        </div>
        
        <div class="demo-section">
            <h2>📊 Real-time Metrics</h2>
            <div id="metrics" class="metrics">
                Connecting to metrics stream...
            </div>
        </div>
    </div>

    <script src="/static/app.js"></script>
</body>
</html>
"""
        return web.Response(text=html_content, content_type='text/html')

    async def static_handler(self, request):
        """Serve static files"""
        filename = request.match_info['filename']
        static_dir = Path(__file__).parent.parent / 'static'
        file_path = static_dir / filename
        
        if file_path.exists():
            return web.FileResponse(file_path)
        else:
            return web.Response(status=404, text="File not found")

    async def metrics_handler(self, request):
        """API endpoint for metrics"""
        metrics = self.metrics_collector.get_current_metrics()
        return web.json_response(metrics)

    def create_app(self):
        """Create the web application"""
        app = web.Application()
        
        # Routes
        app.router.add_get('/', self.index_handler)
        app.router.add_get('/ws', self.websocket_handler)
        app.router.add_get('/api/metrics', self.metrics_handler)
        app.router.add_get('/static/{filename}', self.static_handler)
        app.router.add_get('/test', self.mobile_test_handler)  # Mobile test page
        
        return app

    async def mobile_test_handler(self, request):
        """Serve mobile camera test page"""
        static_dir = Path(__file__).parent.parent / 'static'
        test_file = static_dir / 'mobile-camera-test.html'
        
        if test_file.exists():
            return web.FileResponse(test_file)
        else:
            return web.Response(status=404, text="Test page not found")

    async def run(self):
        """Start the server"""
        app = self.create_app()
        
        runner = web.AppRunner(app)
        await runner.setup()
        
        site = web.TCPSite(runner, self.host, self.port)
        await site.start()
        
        logger.info(f"🌐 Server running on http://{self.host}:{self.port}")
        logger.info(f"📱 Mode: {self.mode.upper()}")
        logger.info(f"🔗 Phone URL: http://{self.host}:{self.port}")
        
        # Keep server running
        try:
            await asyncio.Future()  # Run forever
        except KeyboardInterrupt:
            logger.info("🛑 Shutting down server...")
            await runner.cleanup()

if __name__ == "__main__":
    server = DetectionServer()
    
    # Check if models exist for server mode
    if server.mode == 'server':
        model_path = Path("models/yolov5n.onnx")
        if not model_path.exists():
            logger.error("❌ Model file not found. Please ensure yolov5n.onnx is in ./models/")
            logger.info("💡 Run: wget https://github.com/ultralytics/yolov5/releases/download/v7.0/yolov5n.onnx -O models/yolov5n.onnx")
            exit(1)
    
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        logger.info("👋 Goodbye!")