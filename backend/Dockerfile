FROM python:3.10-slim

# Install system dependencies FIRST - including CMake and build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    build-essential \
    gcc \
    g++ \
    git \
    libsm6 \
    libxext6 \
    libxrender-dev \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Verify cmake is installed and in PATH
RUN cmake --version

# Set working directory
WORKDIR /app

# Copy requirements first
COPY requirements.txt .

# Upgrade pip, setuptools, wheel BEFORE installing dependencies
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Expose port
EXPOSE 5000

# Run the application
CMD ["python", "-m", "flask", "run", "--host", "0.0.0.0"]
