FROM python:3.11-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Install system dependencies including those needed for ONNX Runtime
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gcc \
    g++ \
    libgomp1 \
    libgfortran5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies with specific ONNX Runtime version
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p models static logs metrics

# Download YOLOv5 model if not present
RUN python -c "import os, urllib.request; \
    os.makedirs('./models', exist_ok=True) if not os.path.exists('./models/yolov5n.onnx') else None; \
    urllib.request.urlretrieve('https://github.com/ultralytics/yolov5/releases/download/v7.0/yolov5n.onnx', './models/yolov5n.onnx') if not os.path.exists('./models/yolov5n.onnx') else print('Model already exists')"

EXPOSE 3000 3443

CMD ["python", "server/main.py"]