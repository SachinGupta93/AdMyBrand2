# Multi-stage build for WebRTC VLM Object Detection
FROM node:18-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --only=production

COPY frontend/ ./
RUN npm run build

FROM python:3.9-slim AS server

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server code
COPY server/ ./server/
COPY models/ ./models/

# Copy built frontend
COPY --from=frontend-builder /app/frontend/dist ./static/

# Download model if not present
RUN python -c
# "import os
# import urllib.request
# if not os.path.exists('./models/yolov5n.onnx'):
#     os.makedirs('./models', exist_ok=True)
#     print('Downloading YOLOv5n model...')
#     urllib.request.urlretrieve(
#         'https://github.com/ultralytics/yolov5/releases/download/v7.0/yolov5n.onnx',
#         './models/yolov5n.onnx'
#     )
#     print('Model downloaded successfully')
# "

EXPOSE 3000 8765

CMD ["python", "server/main.py"]