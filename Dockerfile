FROM python:3.10-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    g++ \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements
COPY backend/requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY backend/ .
COPY frontend/ ../frontend/

# Expose port
EXPOSE 5000

# Run the application
CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:5000", "--max-requests", "1000", "--max-requests-jitter", "100", "--timeout", "60", "app:app"]
