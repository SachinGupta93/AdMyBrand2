# WebRTC VLM Multi-Object Detection Demo

Real-time multi-object detection system that streams live video from a phone via WebRTC, performs inference (client-side WASM or server-side), and overlays detection results in near real-time.

## 🚀 Quick Start (One Command)

```bash
# Clone and start demo
git clone <repo-url>
cd webrtc-vlm-detection
chmod +x start.sh
./start.sh
```

Then:
1. Open http://localhost:3000 on your laptop
2. Scan QR code with your phone camera
3. Allow camera access → see live object detection!

## 📱 Phone Connection Methods

### Method 1: Local Network (Recommended)
```bash
./start.sh  # Default mode
```
- Phone and laptop must be on same WiFi network
- Open displayed URL on phone: `http://192.168.x.x:3000`

### Method 2: External Access (if local doesn't work)
```bash
./start.sh --ngrok
```
- Uses ngrok tunnel for external access
- Works from any network
- Displays public URL for phone access

## 🧠 Inference Modes

### WASM Mode (Low-Resource, Default)
```bash
./start.sh --mode wasm
```
- Client-side inference in browser
- Works on modest laptops (Intel i5, 8GB RAM)
- ~10-15 FPS processing at 320×240 resolution
- CPU usage: 15-25%

### Server Mode (Higher Performance)
```bash
./start.sh --mode server
```
- Server-side ONNX inference
- Better accuracy and performance
- Requires model download (automatic)
- CPU usage: 30-50%

## 📊 Benchmarking

```bash
# Run 30-second benchmark
./bench/run_bench.sh --duration 30 --mode wasm

# Server mode benchmark
./bench/run_bench.sh --duration 60 --mode server

# Custom output file
./bench/run_bench.sh --duration 30 --output my_results.json
```

Generates `metrics.json` with:
- Median & P95 end-to-end latency
- Processed FPS
- Uplink/downlink bandwidth
- System resource usage

## 🛠️ Installation & Setup

### Prerequisites
- Docker & Docker Compose
- Git
- Modern browser (Chrome/Safari)

### Manual Setup (if Docker unavailable)
```bash
# Backend
pip install -r requirements.txt