/**
 * WebRTC VLM Object Detection - Client Application
 * Handles video streaming, WebRTC connection, and real-time overlays
 */

class WebRTCDetectionApp {
    constructor() {
        this.localVideo = document.getElementById('localVideo');
        this.overlayCanvas = document.getElementById('overlayCanvas');
        this.ctx = this.overlayCanvas.getContext('2d');
        this.metricsDiv = document.getElementById('metrics');
        this.connectionStatus = document.getElementById('connection-status');
        
        this.peerConnection = null;
        this.websocket = null;
        this.localStream = null;
        
        // Detection and metrics
        this.detections = new Map(); // frame_id -> detections
        this.frameQueue = [];
        this.maxQueueSize = 5;
        this.metrics = {
            frames: 0,
            detections: 0,
            latencies: [],
            startTime: Date.now()
        };
        
        // WASM inference (if in WASM mode)
        this.wasmModel = null;
        this.inferenceMode = 'wasm'; // Will be set by server
        
        this.init();
    }

    async init() {
        console.log('🚀 Initializing WebRTC Detection App');
        
        // Set up UI event handlers
        document.getElementById('startBtn').onclick = () => this.startCamera();
        document.getElementById('stopBtn').onclick = () => this.stopCamera();
        document.getElementById('benchBtn').onclick = () => this.runBenchmark();
        
        // Connect to WebSocket
        await this.connectWebSocket();
        
        // Load QR code and URL
        this.loadQRCodeAndURL();
        
        // Start metrics display update
        this.updateMetricsDisplay();
        setInterval(() => this.updateMetricsDisplay(), 1000);
        
        // Auto-start camera on mobile devices
        if (this.isMobile()) {
            this.startCamera();
        }
    }

    loadQRCodeAndURL() {
        // Get local IP and display URL
        const protocol = window.location.protocol;
        const host = window.location.hostname;
        const port = window.location.port;
        const phoneUrl = `${protocol}//${host}${port ? ':' + port : ''}`;
        
        // Update URL display
        const phoneUrlElement = document.getElementById('phone-url');
        if (phoneUrlElement) {
            phoneUrlElement.innerHTML = `<strong>URL:</strong> <code>${phoneUrl}</code>`;
        }
        
        // Generate QR code using a QR service
        const qrCodeElement = document.getElementById('qr-code');
        if (qrCodeElement) {
            // Use QR Server API
            const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(phoneUrl)}`;
            qrCodeElement.innerHTML = `<img src="${qrCodeUrl}" alt="QR Code" style="max-width: 200px; border-radius: 8px;">`;
        }
    }

    isMobile() {
        return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }

    async connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        
        console.log('🔌 Connecting to WebSocket:', wsUrl);
        
        this.websocket = new WebSocket(wsUrl);
        
        this.websocket.onopen = () => {
            console.log('✅ WebSocket connected');
            this.updateConnectionStatus('connected', '🟢 Connected');
        };
        
        this.websocket.onmessage = (event) => {
            this.handleWebSocketMessage(JSON.parse(event.data));
        };
        
        this.websocket.onclose = () => {
            console.log('❌ WebSocket disconnected');
            this.updateConnectionStatus('disconnected', '🔴 Disconnected');
            
            // Attempt to reconnect after 3 seconds
            setTimeout(() => this.connectWebSocket(), 3000);
        };
        
        this.websocket.onerror = (error) => {
            console.error('❌ WebSocket error:', error);
            this.updateConnectionStatus('disconnected', '🔴 Connection Error');
        };
    }

    updateConnectionStatus(status, text) {
        this.connectionStatus.className = `status ${status}`;
        this.connectionStatus.textContent = text;
    }

    async handleWebSocketMessage(data) {
        switch (data.type) {
            case 'answer':
                if (this.peerConnection) {
                    await this.peerConnection.setRemoteDescription({
                        type: 'answer',
                        sdp: data.sdp
                    });
                }
                break;
                
            case 'detections':
                this.handleDetections(data);
                break;
                
            case 'metrics':
                this.displayMetrics(data.data);
                break;
                
            case 'config':
                this.inferenceMode = data.mode || 'wasm';
                console.log(`🧠 Inference mode: ${this.inferenceMode}`);
                if (this.inferenceMode === 'wasm') {
                    await this.initWasmInference();
                }
                break;
        }
    }

    async startCamera() {
        try {
            console.log('📹 Starting camera...');
            this.updateConnectionStatus('connecting', '🟡 Starting Camera...');
            
            // Check protocol and warn mobile users about HTTPS requirement
            if (location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
                if (this.isMobile()) {
                    const warningMsg = '⚠️ HTTPS Required for Mobile Camera\n\nMobile browsers require HTTPS for camera access. You can:\n1. Try on desktop first\n2. Use localhost if possible\n3. Set up HTTPS';
                    alert(warningMsg);
                }
            }
            
            // Try multiple constraint configurations for better compatibility
            const constraintOptions = [
                // Option 1: Mobile optimized with rear camera
                {
                    video: {
                        width: { ideal: 640, max: 1280 },
                        height: { ideal: 480, max: 720 },
                        facingMode: this.isMobile() ? 'environment' : 'user',
                        frameRate: { ideal: 15, max: 30 }
                    },
                    audio: false
                },
                // Option 2: Basic mobile constraints
                {
                    video: {
                        facingMode: this.isMobile() ? 'environment' : 'user',
                        width: { ideal: 320 },
                        height: { ideal: 240 }
                    },
                    audio: false
                },
                // Option 3: Simple video only
                {
                    video: {
                        width: { ideal: 640 },
                        height: { ideal: 480 },
                        frameRate: { ideal: 15, max: 30 }
                    },
                    audio: false
                },
                // Option 4: Fallback - any video
                {
                    video: true,
                    audio: false
                }
            ];
            
            let stream = null;
            let usedConstraints = null;
            
            for (const [index, constraints] of constraintOptions.entries()) {
                try {
                    console.log(`🔍 Trying camera option ${index + 1}:`, constraints);
                    stream = await navigator.mediaDevices.getUserMedia(constraints);
                    usedConstraints = constraints;
                    console.log(`✅ Camera access granted with option ${index + 1}`);
                    break;
                } catch (err) {
                    console.warn(`⚠️ Camera option ${index + 1} failed:`, err.message);
                    if (index === constraintOptions.length - 1) {
                        throw err; // Re-throw the last error
                    }
                }
            }
            
            if (!stream) {
                throw new Error('Unable to access camera with any configuration');
            }
            
            this.localStream = stream;
            this.localVideo.srcObject = this.localStream;
            
            // Log successful camera details
            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack) {
                const settings = videoTrack.getSettings();
                console.log('📹 Camera details:', {
                    width: settings.width,
                    height: settings.height,
                    frameRate: settings.frameRate,
                    facingMode: settings.facingMode
                });
            }
            
            // Set up canvas overlay
            this.setupCanvasOverlay();
            
            // Create WebRTC connection
            await this.createPeerConnection();
            
            // Start video processing
            this.startVideoProcessing();
            
            // Update UI
            document.getElementById('startBtn').disabled = true;
            document.getElementById('stopBtn').disabled = false;
            
            console.log('✅ Camera started successfully');
            this.updateConnectionStatus('connected', '🟢 Camera Active');
            
        } catch (error) {
            console.error('❌ Error starting camera:', error);
            
            let errorMessage = 'Camera access failed';
            let helpText = 'Please check camera permissions and try again.';
            
            if (error.name === 'NotAllowedError') {
                errorMessage = '🔒 Camera Permission Denied';
                helpText = this.isMobile() 
                    ? 'Mobile browsers need HTTPS for camera access. Try on desktop first or enable camera permissions.' 
                    : 'Please allow camera access and refresh the page.';
            } else if (error.name === 'NotFoundError') {
                errorMessage = '📹 No Camera Found';
                helpText = 'Make sure your device has a working camera.';
            } else if (error.name === 'NotReadableError') {
                errorMessage = '📹 Camera In Use';
                helpText = 'Close other apps using the camera and try again.';
            } else if (error.name === 'OverconstrainedError') {
                errorMessage = '⚙️ Camera Settings Not Supported';
                helpText = 'Your camera doesn\'t support the required settings. Try a different device.';
            } else if (location.protocol === 'http:' && this.isMobile()) {
                errorMessage = '🔒 HTTPS Required';
                helpText = 'Mobile browsers require HTTPS for camera access. Try on desktop or use HTTPS.';
            }
            
            this.updateConnectionStatus('disconnected', '🔴 ' + errorMessage);
            
            // Show detailed error
            alert(`${errorMessage}\n\n${helpText}\n\nTechnical: ${error.message}`);
            
            // Add troubleshooting to page
            this.showCameraTroubleshooting(errorMessage, helpText, error);
        }
    }

    showCameraTroubleshooting(errorMessage, helpText, error) {
        // Remove existing troubleshooting if present
        const existing = document.querySelector('.camera-troubleshooting');
        if (existing) existing.remove();
        
        const troubleshootingDiv = document.createElement('div');
        troubleshootingDiv.className = 'camera-troubleshooting demo-section';
        troubleshootingDiv.innerHTML = `
            <h2>📋 Camera Troubleshooting</h2>
            <div style="background: #fff3e0; border-left: 4px solid #f57c00; padding: 15px; border-radius: 4px;">
                <p><strong>🚫 ${errorMessage}</strong></p>
                <p>${helpText}</p>
            </div>
            <div style="margin-top: 15px;">
                <h3>💡 Quick Fixes:</h3>
                <ul>
                    <li><strong>Refresh the page</strong> and allow camera when prompted</li>
                    <li><strong>Check browser settings</strong> - look for camera/microphone permissions</li>
                    <li><strong>Close other camera apps</strong> (Zoom, Teams, etc.)</li>
                    <li><strong>Try desktop browser first</strong> if on mobile</li>
                    ${location.protocol === 'http:' ? '<li><strong>Use HTTPS</strong> for mobile camera access</li>' : ''}
                </ul>
                <h3>🔧 System Info:</h3>
                <ul>
                    <li>Protocol: ${location.protocol} ${location.protocol === 'http:' && this.isMobile() ? '⚠️' : '✅'}</li>
                    <li>Device: ${this.isMobile() ? 'Mobile' : 'Desktop'}</li>
                    <li>Browser: ${navigator.userAgent.includes('Chrome') ? 'Chrome' : navigator.userAgent.includes('Safari') ? 'Safari' : 'Other'}</li>
                </ul>
                <button onclick="this.parentElement.parentElement.remove()" class="btn" style="margin-top: 10px;">
                    ❌ Dismiss
                </button>
            </div>
        `;
        
        // Insert after the video demo section
        const demoSection = document.querySelector('.demo-section');
        demoSection.parentNode.insertBefore(troubleshootingDiv, demoSection.nextSibling);
    }

    setupCanvasOverlay() {
        // Match canvas size to video
        this.localVideo.onloadedmetadata = () => {
            this.overlayCanvas.width = this.localVideo.videoWidth;
            this.overlayCanvas.height = this.localVideo.videoHeight;
            this.overlayCanvas.style.width = this.localVideo.offsetWidth + 'px';
            this.overlayCanvas.style.height = this.localVideo.offsetHeight + 'px';
        };
        
        // Handle window resize
        window.addEventListener('resize', () => {
            if (this.localVideo.videoWidth) {
                this.overlayCanvas.style.width = this.localVideo.offsetWidth + 'px';
                this.overlayCanvas.style.height = this.localVideo.offsetHeight + 'px';
            }
        });
    }

    async createPeerConnection() {
        const config = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };
        
        this.peerConnection = new RTCPeerConnection(config);
        
        // Add local stream
        this.localStream.getTracks().forEach(track => {
            this.peerConnection.addTrack(track, this.localStream);
        });
        
        // Handle ICE candidates
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.websocket.readyState === WebSocket.OPEN) {
                this.websocket.send(JSON.stringify({
                    type: 'ice-candidate',
                    candidate: event.candidate
                }));
            }
        };
        
        // Create and send offer
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        
        this.websocket.send(JSON.stringify({
            type: 'offer',
            sdp: offer.sdp
        }));
    }

    async initWasmInference() {
        try {
            console.log('🧠 Initializing WASM inference...');
            
            // For this demo, we'll use a simple mock inference
            // In a real implementation, you would load ONNX.js or TensorFlow.js
            this.wasmModel = {
                detect: async (imageData) => {
                    // Mock detection - returns random bounding boxes
                    const detections = [];
                    const numObjects = Math.floor(Math.random() * 3);
                    
                    const classes = ['person', 'car', 'bicycle', 'dog', 'cat'];
                    
                    for (let i = 0; i < numObjects; i++) {
                        const xmin = Math.random() * 0.6;
                        const ymin = Math.random() * 0.6;
                        const width = 0.1 + Math.random() * 0.3;
                        const height = 0.1 + Math.random() * 0.3;
                        
                        detections.push({
                            label: classes[Math.floor(Math.random() * classes.length)],
                            score: 0.5 + Math.random() * 0.4,
                            xmin: xmin,
                            ymin: ymin,
                            xmax: Math.min(1.0, xmin + width),
                            ymax: Math.min(1.0, ymin + height)
                        });
                    }
                    
                    return detections;
                }
            };
            
            console.log('✅ WASM inference initialized');
        } catch (error) {
            console.error('❌ WASM inference initialization failed:', error);
        }
    }

    startVideoProcessing() {
        let frameId = 0;
        
        const processFrame = async () => {
            if (!this.localVideo.videoWidth || !this.localStream) {
                requestAnimationFrame(processFrame);
                return;
            }
            
            try {
                const captureTs = Date.now();
                const currentFrameId = `frame_${frameId++}`;
                
                // Capture frame from video
                const canvas = document.createElement('canvas');
                canvas.width = 320; // Low resolution for processing
                canvas.height = 240;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(this.localVideo, 0, 0, canvas.width, canvas.height);
                
                if (this.inferenceMode === 'wasm' && this.wasmModel) {
                    // Client-side inference
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const detections = await this.wasmModel.detect(imageData);
                    
                    const inferenceTs = Date.now();
                    
                    this.handleDetections({
                        frame_id: currentFrameId,
                        capture_ts: captureTs,
                        recv_ts: captureTs,
                        inference_ts: inferenceTs,
                        detections: detections
                    });
                    
                } else if (this.inferenceMode === 'server') {
                    // Server-side inference
                    const imageDataUrl = canvas.toDataURL('image/jpeg', 0.8);
                    
                    // Send frame to server
                    if (this.websocket.readyState === WebSocket.OPEN) {
                        this.websocket.send(JSON.stringify({
                            type: 'frame',
                            frame_id: currentFrameId,
                            capture_ts: captureTs,
                            image_data: imageDataUrl
                        }));
                    }
                }
                
                // Limit processing rate
                setTimeout(() => requestAnimationFrame(processFrame), 1000 / 15); // 15 FPS
                
            } catch (error) {
                console.error('❌ Frame processing error:', error);
                requestAnimationFrame(processFrame);
            }
        };
        
        processFrame();
    }

    handleDetections(data) {
        const displayTs = Date.now();
        
        // Store detections
        this.detections.set(data.frame_id, {
            ...data,
            display_ts: displayTs
        });
        
        // Update metrics
        this.updateMetrics(data, displayTs);
        
        // Draw overlays
        this.drawOverlays(data.detections);
        
        // Clean up old detections
        if (this.detections.size > 100) {
            const oldestKey = this.detections.keys().next().value;
            this.detections.delete(oldestKey);
        }
    }

    updateMetrics(data, displayTs) {
        this.metrics.frames++;
        this.metrics.detections += data.detections.length;
        
        const e2eLatency = displayTs - data.capture_ts;
        this.metrics.latencies.push(e2eLatency);
        
        // Keep only recent latencies
        if (this.metrics.latencies.length > 100) {
            this.metrics.latencies = this.metrics.latencies.slice(-100);
        }
    }

    drawOverlays(detections) {
        if (!this.overlayCanvas || !detections) return;
        
        const canvas = this.overlayCanvas;
        const ctx = this.ctx;
        
        // Clear previous overlays
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Draw bounding boxes
        detections.forEach(detection => {
            const x = detection.xmin * canvas.width;
            const y = detection.ymin * canvas.height;
            const width = (detection.xmax - detection.xmin) * canvas.width;
            const height = (detection.ymax - detection.ymin) * canvas.height;
            
            // Box
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, width, height);
            
            // Label background
            const label = `${detection.label} (${(detection.score * 100).toFixed(0)}%)`;
            ctx.font = '14px Arial';
            const textWidth = ctx.measureText(label).width;
            
            ctx.fillStyle = 'rgba(0, 255, 0, 0.8)';
            ctx.fillRect(x, y - 20, textWidth + 8, 20);
            
            // Label text
            ctx.fillStyle = '#000';
            ctx.fillText(label, x + 4, y - 6);
        });
    }

    updateMetricsDisplay() {
        if (!this.metricsDiv) return;
        
        const runtime = (Date.now() - this.metrics.startTime) / 1000;
        const fps = this.metrics.frames / runtime;
        const avgDetections = this.metrics.detections / (this.metrics.frames || 1);
        
        let latencyStats = { median: 0, p95: 0, mean: 0 };
        if (this.metrics.latencies.length > 0) {
            const sorted = [...this.metrics.latencies].sort((a, b) => a - b);
            latencyStats.median = sorted[Math.floor(sorted.length * 0.5)];
            latencyStats.p95 = sorted[Math.floor(sorted.length * 0.95)];
            latencyStats.mean = this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length;
        }
        
        const metricsText = `
📊 LIVE METRICS (${runtime.toFixed(1)}s)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📹 Frames Processed: ${this.metrics.frames}
🎯 Total Detections: ${this.metrics.detections}
⚡ Processing FPS: ${fps.toFixed(1)}
🔍 Avg Objects/Frame: ${avgDetections.toFixed(1)}

⏱️  LATENCY (End-to-End)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Median: ${latencyStats.median.toFixed(0)}ms
📈 P95: ${latencyStats.p95.toFixed(0)}ms
📉 Mean: ${latencyStats.mean.toFixed(0)}ms

🧠 Mode: ${this.inferenceMode.toUpperCase()}
📱 Device: ${this.isMobile() ? 'Mobile' : 'Desktop'}
        `.trim();
        
        this.metricsDiv.textContent = metricsText;
    }

    async runBenchmark() {
        try {
            document.getElementById('benchBtn').disabled = true;
            document.getElementById('benchBtn').textContent = '⏳ Running...';
            
            console.log('📊 Starting 30-second benchmark...');
            
            // Reset metrics
            this.metrics = {
                frames: 0,
                detections: 0,
                latencies: [],
                startTime: Date.now()
            };
            
            // Run for 30 seconds
            await new Promise(resolve => setTimeout(resolve, 30000));
            
            // Calculate final metrics
            const summary = this.getBenchmarkSummary();
            
            // Export metrics
            const blob = new Blob([JSON.stringify(summary, null, 2)], 
                                 { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'metrics.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            console.log('✅ Benchmark completed and metrics exported');
            alert(`Benchmark completed!\nMedian E2E Latency: ${summary.median_e2e_latency_ms}ms\nP95 Latency: ${summary.p95_e2e_latency_ms}ms\nFPS: ${summary.processed_fps.toFixed(1)}`);
            
        } catch (error) {
            console.error('❌ Benchmark error:', error);
        } finally {
            document.getElementById('benchBtn').disabled = false;
            document.getElementById('benchBtn').textContent = '📊 Run Benchmark';
        }
    }

    getBenchmarkSummary() {
        const runtime = (Date.now() - this.metrics.startTime) / 1000;
        const sorted = [...this.metrics.latencies].sort((a, b) => a - b);
        
        return {
            duration_seconds: 30,
            frames_processed: this.metrics.frames,
            processed_fps: this.metrics.frames / runtime,
            total_detections: this.metrics.detections,
            median_e2e_latency_ms: sorted[Math.floor(sorted.length * 0.5)] || 0,
            p95_e2e_latency_ms: sorted[Math.floor(sorted.length * 0.95)] || 0,
            mean_e2e_latency_ms: this.metrics.latencies.length > 0 ? 
                this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length : 0,
            uplink_kbps: 0, // Would be calculated from WebRTC stats
            downlink_kbps: 0,
            mode: this.inferenceMode,
            timestamp: new Date().toISOString()
        };
    }

    stopCamera() {
        console.log('⏹️ Stopping camera...');
        
        // Stop video stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        
        // Close peer connection
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
        
        // Clear video and canvas
        this.localVideo.srcObject = null;
        if (this.ctx) {
            this.ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        }
        
        // Update UI
        document.getElementById('startBtn').disabled = false;
        document.getElementById('stopBtn').disabled = true;
        this.updateConnectionStatus('disconnected', '🔴 Camera Stopped');
        
        console.log('✅ Camera stopped');
    }
}

// Initialize app when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.app = new WebRTCDetectionApp();
});